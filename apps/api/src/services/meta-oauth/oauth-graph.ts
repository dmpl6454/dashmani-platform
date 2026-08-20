/**
 * Graph fetcher for the OAuth ("Post Automation 2") app.
 *
 * ⚠️ THIS IS A DELIBERATE SIBLING OF social-insights/meta-graph.ts, NOT A REPLACEMENT.
 *
 * It exists so that exactly one app secret is reachable from exactly one fetcher.
 * meta-graph.ts reads META_APP_ID/META_APP_SECRET/META_SYSTEM_USER_TOKEN (the older
 * "Dashmani Insights" app, still powering Top Links / Link Search) and gets ZERO
 * edits from this work — the legacy path cannot be regressed by anything here.
 *
 * `isRateLimitError`, `GraphError` are IMPORTED from meta-graph.ts so the
 * rate-limit sentinel has a single source of truth and cannot drift between the
 * two fetchers. The abort/params handling is intentionally duplicated rather than
 * shared, because this fetcher needs two things graphFetch does not have:
 *   1. a caller-settable timeout (discovery needs 25s; graphFetch hardcodes 10s), and
 *   2. response HEADER exposure, to read the usage/throttle headers.
 *
 * Contract: NEVER THROWS. Callers branch authInvalid → rateLimited → !ok.
 */

import { isRateLimitError, type GraphError } from "../social-insights/meta-graph";
import { recordApiUsage } from "../api-usage.service";
import { metaGraphBase, metaOauthAppSecret, metaTuning } from "./meta-config";
import { scrubSecrets } from "../../utils/token-crypto";
import { createHmac } from "crypto";

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Graph subcodes that mean "this grant is dead, re-authorise" rather than
 * "transient failure". 458 = app not installed, 463 = token expired,
 * 467 = token invalidated (password change / user revoke).
 */
const REAUTH_SUBCODES = new Set([458, 463, 467]);

/**
 * Parsed throttle telemetry.
 * `null` means UNKNOWN — never 0. A confident-looking 0% would make the ceiling
 * check pass forever; an honest null makes it visibly unknown.
 */
export type MetaUsage = { source: "app" | "buc"; callCountPct: number } | null;

export interface OauthGraphResult<T = unknown> {
  ok: boolean;
  rateLimited: boolean;
  /** code 190 or a re-auth subcode ⇒ the connection needs NEEDS_REAUTH. */
  authInvalid: boolean;
  /** 0 means transport error / abort (indistinguishable from a network blip). */
  status: number;
  usage: MetaUsage;
  data?: T;
  /** Already passed through scrubSecrets(). */
  error?: string;
  errorCode?: number;
  errorSubcode?: number;
  /**
   * For `(#100) metric[0] must be one of the following values: A, B, C` — the
   * enumerated valid values, parsed out. This is how the capability probe learns
   * the real metric names for a Graph version without a deploy.
   */
  allowedValues?: string[];
}

/**
 * A call budget shared across one run. Every fetch increments it, and the fetcher
 * REFUSES once exhausted — so the bound cannot be bypassed by an outer caller
 * forgetting to check. That is deliberate: the removed "Refresh enrichment"
 * button once ran 59.5 minutes because its bound was advisory.
 */
export interface CallBudget {
  used: number;
  max: number;
}

export function makeBudget(max: number): CallBudget {
  return { used: 0, max };
}

/** Coarse Cost-Sheet label. The `meta-oauth:` prefix separates this app's traffic
 *  from the legacy app's on /api-costs. */
function recordCall(label: string): void {
  // Fire-and-forget and never awaited; recordApiUsage is itself fail-open.
  recordApiUsage({ provider: "meta", operation: `meta-oauth:${label}`, calls: 1, units: 1 });
}

/**
 * Parse `x-business-use-case-usage` (the BUC header returned by the edges this
 * feature polls) or fall back to `x-app-usage`.
 *
 * ⚠️ Returns null when neither is present. The exact header name/shape is
 * [MUST LIVE-PROBE] — if it is absent we report "unknown" rather than inventing
 * a number, and the ceiling short-circuit does not fire on unknown.
 */
function parseUsage(headers: Headers): MetaUsage {
  const buc = headers.get("x-business-use-case-usage");
  if (buc) {
    try {
      const parsed = JSON.parse(buc) as Record<string, Array<{ call_count?: number }>>;
      let max = 0;
      let seen = false;
      for (const arr of Object.values(parsed)) {
        for (const entry of arr ?? []) {
          if (typeof entry?.call_count === "number") {
            seen = true;
            max = Math.max(max, entry.call_count);
          }
        }
      }
      if (seen) return { source: "buc", callCountPct: max };
    } catch {
      /* fall through to app usage */
    }
  }
  const app = headers.get("x-app-usage");
  if (app) {
    try {
      const parsed = JSON.parse(app) as { call_count?: number };
      if (typeof parsed?.call_count === "number") {
        return { source: "app", callCountPct: parsed.call_count };
      }
    } catch {
      /* unknown */
    }
  }
  return null;
}

/** Pull the enumerated values out of a `(#100) … must be one of the following
 *  values: a, b, c` message. */
function parseAllowedValues(message: string | undefined): string[] | undefined {
  if (!message) return undefined;
  const m = message.match(/must be one of the following values:\s*([^.]+)/i);
  if (!m) return undefined;
  const vals = m[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return vals.length ? vals : undefined;
}

export async function oauthGraphFetch<T = unknown>(
  path: string,
  params: Record<string, string | number | undefined>,
  token: string,
  opts?: { timeoutMs?: number; label?: string; budget?: CallBudget; signal?: AbortSignal },
): Promise<OauthGraphResult<T>> {
  const label = opts?.label ?? "other";
  const budget = opts?.budget;

  if (budget) {
    if (budget.used >= budget.max) {
      return {
        ok: false,
        rateLimited: false,
        authInvalid: false,
        status: 0,
        usage: null,
        error: "call budget exhausted",
      };
    }
    budget.used++;
  }

  // Absolute paging.next cursors pass through untouched; relative paths join the
  // OAuth app's own base (never meta-graph's GRAPH_BASE).
  const isAbsolute = /^https?:\/\//i.test(path);
  let url: URL;
  try {
    url = new URL(isAbsolute ? path : `${metaGraphBase()}/${path.replace(/^\//, "")}`);
  } catch {
    return {
      ok: false, rateLimited: false, authInvalid: false, status: 0, usage: null,
      error: "invalid graph path",
    };
  }

  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  // A cursor already carries its own token; don't double-set it.
  if (!url.searchParams.has("access_token")) {
    url.searchParams.set("access_token", token);
  }
  if (metaTuning.appsecretProof()) {
    const secret = metaOauthAppSecret();
    if (secret) {
      url.searchParams.set(
        "appsecret_proof",
        createHmac("sha256", secret).update(token).digest("hex"),
      );
    }
  }

  // Record BEFORE the fetch so a throw is still counted.
  recordCall(label);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  opts?.signal?.addEventListener("abort", onAbort);

  try {
    const res = await fetch(url.toString(), { signal: controller.signal });
    const usage = parseUsage(res.headers);

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }

    const err = (body as { error?: GraphError } | undefined)?.error;

    if (!res.ok || err) {
      const code = err?.code;
      const subcode = err?.error_subcode;
      const authInvalid = code === 190 || (subcode != null && REAUTH_SUBCODES.has(subcode));
      return {
        ok: false,
        rateLimited: isRateLimitError(res.status, err),
        authInvalid,
        status: res.status,
        usage,
        error: scrubSecrets(err?.message ?? `HTTP ${res.status}`),
        errorCode: code,
        errorSubcode: subcode,
        allowedValues: parseAllowedValues(err?.message),
      };
    }

    return { ok: true, rateLimited: false, authInvalid: false, status: res.status, usage, data: body as T };
  } catch (e) {
    // Abort (timeout) and network failures land here and are INDISTINGUISHABLE —
    // status 0 says "we never got an answer", not "Meta said no".
    return {
      ok: false,
      rateLimited: false,
      authInvalid: false,
      status: 0,
      usage: null,
      error: scrubSecrets(e instanceof Error ? e.message : String(e)),
    };
  } finally {
    clearTimeout(timer);
    opts?.signal?.removeEventListener("abort", onAbort);
  }
}
