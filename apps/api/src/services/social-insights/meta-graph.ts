// Shared helper for the Meta (Instagram + Facebook) Graph API providers.
//
// Mirrors the YouTube provider's runtime-only config approach: the token lives in
// process.env (META_SYSTEM_USER_TOKEN), read fresh at call time — no rebuild, set
// in apps/api/.env exactly like YOUTUBE_API_KEY. While the token is absent,
// metaConfigured() is false, so both providers' isSupported() return false and the
// registry never polls them ("dark switch"). No db:push is required for the token.
//
// graphFetch is INJECTABLE: the default does the real fetch + JSON parse and maps
// rate-limit responses to a sentinel; tests pass a mock so they never touch the
// network and need no real token.

export const GRAPH_BASE = "https://graph.facebook.com/v21.0";

const REQUEST_TIMEOUT_MS = 10_000;

export function getMetaToken(): string | undefined {
  return process.env.META_SYSTEM_USER_TOKEN;
}

export function metaConfigured(): boolean {
  return !!process.env.META_SYSTEM_USER_TOKEN;
}

export function getMetaAppId(): string | undefined {
  return process.env.META_APP_ID;
}

export function getMetaAppSecret(): string | undefined {
  return process.env.META_APP_SECRET;
}

// Meta error codes that indicate throttling / over-limit. We short-circuit the run
// on any of these (mirrors the youTubeQuotaExceeded behavior).
//   4   — Application request limit reached
//   17  — User request limit reached (the ~200 calls/user/hour IG limit)
//   32  — Page request limit reached
//   613 — Calls to this api have exceeded the rate limit
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);

export interface GraphError {
  message?: string;
  code?: number;
  error_subcode?: number;
  type?: string;
}

// What graphFetch resolves to. `rateLimited` is the sentinel callers check before
// continuing a run; `error` carries any non-rate-limit failure; `data` is the
// parsed JSON body on success.
export interface GraphFetchResult<T = unknown> {
  ok: boolean;
  rateLimited: boolean;
  status: number;
  data?: T;
  error?: string;
}

// Detect a rate-limit signal from either the HTTP status (429) or the Graph
// error envelope ({ error: { code, message } }).
export function isRateLimitError(httpStatus: number, err?: GraphError): boolean {
  if (httpStatus === 429) return true;
  if (err) {
    if (err.code != null && RATE_LIMIT_CODES.has(err.code)) return true;
    if (typeof err.message === "string" && /rate limit/i.test(err.message)) return true;
  }
  return false;
}

export type GraphFetchFn = <T = unknown>(
  path: string,
  params?: Record<string, string | number | undefined>,
  opts?: { signal?: AbortSignal }
) => Promise<GraphFetchResult<T>>;

// Default implementation: builds the URL (path may be absolute or relative to
// GRAPH_BASE), injects access_token, fetches with a 10s AbortController, parses
// JSON, and maps Graph errors. Overridable in tests.
export const graphFetch: GraphFetchFn = async <T = unknown>(
  path: string,
  params: Record<string, string | number | undefined> = {},
  opts: { signal?: AbortSignal } = {}
): Promise<GraphFetchResult<T>> => {
  const token = getMetaToken();
  if (!token) {
    return { ok: false, rateLimited: false, status: 0, error: "META_SYSTEM_USER_TOKEN not configured" };
  }

  // Absolute URLs (e.g. a `paging.next` cursor) pass through untouched; relative
  // paths are joined to GRAPH_BASE.
  const isAbsolute = /^https?:\/\//i.test(path);
  const url = new URL(isAbsolute ? path : `${GRAPH_BASE}/${path.replace(/^\//, "")}`);

  // Only set access_token if the (absolute) URL didn't already carry one.
  if (!url.searchParams.has("access_token")) {
    url.searchParams.set("access_token", token);
  }
  for (const [k, val] of Object.entries(params)) {
    if (val != null) url.searchParams.set(k, String(val));
  }

  // Use the caller's signal if given, else a local 10s timeout.
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let signal = opts.signal;
  if (!signal) {
    controller = new AbortController();
    signal = controller.signal;
    timer = setTimeout(() => controller!.abort(), REQUEST_TIMEOUT_MS);
  }

  try {
    const res = await fetch(url.toString(), { signal });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }

    const err = (body as { error?: GraphError } | undefined)?.error;
    if (!res.ok || err) {
      const rateLimited = isRateLimitError(res.status, err);
      return {
        ok: false,
        rateLimited,
        status: res.status,
        error: err?.message ?? `HTTP ${res.status}`,
      };
    }

    return { ok: true, rateLimited: false, status: res.status, data: body as T };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, rateLimited: false, status: 0, error: msg };
  } finally {
    if (timer) clearTimeout(timer);
  }
};
