import { extractFacebookPostId } from "@dashmani/shared";
import type { InsightProvider, InsightTarget, InsightFetchResult } from "./types";
import {
  graphFetch as defaultGraphFetch,
  metaConfigured,
  type GraphFetchFn,
} from "./meta-graph";

// ── Facebook insight provider ───────────────────────────────────────────────
//
// Clean numeric ids (fb:<numericId> from canonicalKey) resolve directly:
//   GET /{post-id}?fields=message,likes.summary(true),comments.summary(true)
// where `message` is the caption and the summaries carry the counts.
//
// OPAQUE URLs — /share/r/<code>, /posts/<code>, story.php, pfbid… — have NO public
// numeric id (extractFacebookPostId returns null for them), so the cron skips them
// as "could not extract targetId". That is correct and bounded: ~84% of our FB
// links are opaque /share/ URLs and there is no reliable opaque→id lookup.
//
// shares is unreliable/deprecated on the Graph API → always null.
//
// resolveOpaqueFacebookUrl (exported below) is a SEPARATE, OPT-IN best-effort
// helper that does ONE redirect:manual fetch and only succeeds if Facebook
// redirects to a clean numeric /reel|/videos URL. It is intentionally NOT wired
// into fetchBatch in this build (it needs the token + careful rate control); it is
// provided + unit-tested so it is ready to opt in later.
//
// DARK SWITCH: while META_SYSTEM_USER_TOKEN is absent, isSupported() is false, the
// registry never polls this provider, and fetchBatch (if ever called directly)
// returns an all-error map without touching the network.

const TIMEOUT_MS = 10_000;

// Module-level rate-limit flag — set when the Graph API throttles us, short-circuits
// the rest of the run to rate_limited (mirrors youTubeQuotaExceeded). Reset at the
// top of each fetchBatch run.
export let fbRateLimited = false;

// Injectable Graph fetcher. Defaults to the real implementation; tests swap it via
// __setGraphFetchForTesting so they need neither a token nor the network.
let graphFetchImpl: GraphFetchFn = defaultGraphFetch;

export function __setGraphFetchForTesting(fn: GraphFetchFn | null): void {
  graphFetchImpl = fn ?? defaultGraphFetch;
}

export function __resetFbRateLimitedForTesting(): void {
  fbRateLimited = false;
}

// ── Graph response shape (only the fields we request) ────────────────────────
interface FbPostResponse {
  id?: string;
  message?: string;
  likes?: { summary?: { total_count?: number } };
  comments?: { summary?: { total_count?: number } };
}

export const facebookProvider: InsightProvider = {
  slug: "facebook",

  isSupported() {
    return metaConfigured();
  },

  extractTargetId(url: string): string | null {
    return extractFacebookPostId(url);
  },

  async fetchBatch(targets: InsightTarget[]): Promise<Map<string, InsightFetchResult>> {
    const results = new Map<string, InsightFetchResult>();

    // DARK: no token → all-error map, NEVER touch the network.
    if (!metaConfigured()) {
      for (const t of targets) {
        results.set(t.linkId, { ok: false, status: "error", error: "META_SYSTEM_USER_TOKEN not configured" });
      }
      return results;
    }

    // Reset the run-scoped rate-limit flag.
    fbRateLimited = false;

    // The Graph API has no clean batch read for arbitrary post ids, so we fetch one
    // at a time. A rate-limit short-circuits the remaining targets to rate_limited.
    for (const t of targets) {
      if (fbRateLimited) {
        results.set(t.linkId, { ok: false, status: "rate_limited", error: "Facebook Graph API rate limit" });
        continue;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      let res;
      try {
        res = await graphFetchImpl<FbPostResponse>(
          t.targetId,
          { fields: "message,likes.summary(true),comments.summary(true)" },
          { signal: controller.signal }
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        results.set(t.linkId, { ok: false, status: "error", error: msg });
        continue;
      } finally {
        clearTimeout(timer);
      }

      if (res.rateLimited) {
        fbRateLimited = true;
        results.set(t.linkId, { ok: false, status: "rate_limited", error: "Facebook Graph API rate limit" });
        continue;
      }

      if (!res.ok || !res.data) {
        // Unknown id, deleted, no permission, etc. — treat as not_found so the cron
        // records a clean snapshot rather than an error.
        results.set(t.linkId, { ok: false, status: "not_found", error: res.error });
        continue;
      }

      const d = res.data;
      results.set(t.linkId, {
        ok: true,
        status: "ok",
        views: null, // Graph API does not return a reliable view count here
        likes: d.likes?.summary?.total_count ?? null,
        comments: d.comments?.summary?.total_count ?? null,
        shares: null, // shares unreliable/deprecated
        title: null,
        caption: d.message ?? null,
      });
    }

    return results;
  },
};

// ── OPT-IN best-effort opaque-URL resolver (NOT wired into fetchBatch) ─────────
//
// Does ONE redirect:manual fetch and reads the Location header. If Facebook
// redirects an opaque /share/r/… link to a clean numeric /reel/<n> or /videos/<n>
// URL, returns that numeric id (via extractFacebookPostId, which only accepts clean
// numeric forms). If it lands on pfbid / anything opaque → returns null (GIVE UP —
// no feed-matching). fetchImpl is injectable for tests; defaults to global fetch.
export async function resolveOpaqueFacebookUrl(
  url: string,
  fetchImpl: typeof fetch = fetch
): Promise<string | null> {
  if (!url) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { redirect: "manual", signal: controller.signal });
    const location = res.headers.get("location");
    if (!location) return null;
    // extractFacebookPostId returns a numeric id only for clean /reel|/videos|
    // /video|watch?v= forms; pfbid / opaque redirects → null.
    return extractFacebookPostId(location);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Submit-time clean-URL helper (clean-url-or-null) ───────────────────────────
//
// Thin wrapper over resolveOpaqueFacebookUrl used by the submit path. Returns a
// CLEAN canonical Facebook URL (not just the numeric id) when an opaque
// /share/r/<code> link redirects to a clean numeric /reel|/videos/<n>; else null.
//
// FAIL-OPEN by contract: resolveOpaqueFacebookUrl already swallows every
// throw/timeout into null, and this wrapper adds its own try/catch belt — any
// failure returns null and the caller keeps the original url. Dark-safe: with no
// META token the HEAD redirect simply doesn't yield a clean Location and we
// return null (we never read the token here — this is a plain redirect probe, not
// a Graph call). canonicalKey only cares about fb:<id>, so /reel/ is a fine
// canonical form even if the original was a /videos/ post.
export async function resolveFacebookShareUrl(
  url: string,
  fetchImpl: typeof fetch = fetch
): Promise<string | null> {
  try {
    const id = await resolveOpaqueFacebookUrl(url, fetchImpl); // already fail-open
    return id ? `https://www.facebook.com/reel/${id}` : null;
  } catch {
    return null;
  }
}
