// ── X/Twitter follower-count resolver (anonymous guest-token GraphQL) ───────
//
// X's own embedded-tweet web client uses an ANONYMOUS "guest token" flow that
// requires no login: activate a guest token once, then call the
// UserByScreenName GraphQL query per handle. Live-verified 2026-07-10/11 (real
// network calls, from this environment, against elonmusk / NASA / a dead
// handle):
//   1. POST https://api.twitter.com/1.1/guest/activate.json with the public
//      web-client bearer below → {"guest_token":"<token>"}.
//   2. GET the UserByScreenName GraphQL query with that bearer + the guest
//      token in `x-guest-token` → on success:
//      {"data":{"user":{"result":{"legacy":{"followers_count":<n>, ...}}}}}
//      On a dead/renamed/suspended handle: {"data":{}} (HTTP 200, not an
//      error) — this is the "not found" case, never a crash.
//   3. One guest token is reusable for ~150 calls (the `x-rate-limit-limit:
//      150` response header decrements per call, confirmed live) — this
//      module activates ONE token per fetchTwitterFollowerMap() call and
//      reuses it across every handle in that batch.
//
// ⚠️⚠️ BOTH the bearer token below AND the GraphQL query id
// (G3KGOASz96M-Qu0nwmGXNg) are known to rotate periodically on X's side. If
// this endpoint starts failing (empty maps / non-200s across the board), it
// is almost certainly NOT a code bug — someone needs to re-probe live (open
// browser devtools on twitter.com and watch the network tab, or hit the
// endpoints directly with curl) to get the current bearer + query id and
// update the two constants below.
//
// Fail-open by contract, matching every other resolver in this directory
// (youtube-followers.ts, meta-followers.ts, snapchat-scraper.ts): a miss on
// any handle, or a total failure to activate a guest token, returns
// (a smaller, possibly empty) map — it NEVER throws out of the exported
// functions, so the caller (follower-sync.service.ts) always keeps the prior
// stored value on a miss.

// This is X's own public web-client bearer token (used by the logged-out
// embedded-tweet widget everywhere on the web) — read-only, no user auth.
const TWITTER_PUBLIC_BEARER =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

// GraphQL query id for UserByScreenName. Rotates independently of the bearer.
const USER_BY_SCREEN_NAME_QUERY_ID = "G3KGOASz96M-Qu0nwmGXNg";

// Minimal feature-flag blob the endpoint expects. Live-verified 2026-07-11:
// this exact set was accepted with no `errors` on real handles — the
// endpoint appears forgiving about extra/missing flags for this query as
// long as `screen_name` + `withSafetyModeUserFields` are present in
// `variables`.
const GRAPHQL_FEATURES = {
  hidden_profile_likes_enabled: true,
  hidden_profile_subscriptions_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  subscriptions_verification_info_is_identity_verified_enabled: false,
  subscriptions_verification_info_verified_since_enabled: true,
  highlights_tweets_tab_ui_enabled: true,
  responsive_web_twitter_article_notes_tab_enabled: true,
  subscriptions_feature_can_gift_premium: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
};

// Polite delay between per-handle calls, matching the DELAY_MS /
// SC_SCRAPER_DELAY_MS convention in follower-sync.service.ts /
// snapchat-scraper.ts. Tests set TWITTER_FOLLOWER_SYNC_DELAY_MS=0.
const DELAY_MS = parseInt(process.env.TWITTER_FOLLOWER_SYNC_DELAY_MS ?? "500", 10);

const REQUEST_TIMEOUT_MS = 10_000;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pure extractor for the UserByScreenName response body (already-parsed
 * JSON). Never throws — any missing/malformed path returns null so a bad
 * response can never crash the caller.
 *
 * Handles the three real shapes observed live:
 *   - success: data.user.result.legacy.followers_count populated
 *   - dead/renamed/suspended handle: {"data":{}} → null
 *   - a soft `errors[]` array can be present ALONGSIDE a fully populated
 *     legacy.followers_count — in that case the count is still extracted
 *     (the errors array is ignored when the count is present).
 */
export function parseTwitterFollowersResponse(json: unknown): number | null {
  if (json == null || typeof json !== "object") return null;

  const data = (json as Record<string, unknown>).data;
  if (data == null || typeof data !== "object") return null;

  const user = (data as Record<string, unknown>).user;
  if (user == null || typeof user !== "object") return null;

  const result = (user as Record<string, unknown>).result;
  if (result == null || typeof result !== "object") return null;

  const legacy = (result as Record<string, unknown>).legacy;
  if (legacy == null || typeof legacy !== "object") return null;

  const followersCount = (legacy as Record<string, unknown>).followers_count;
  if (typeof followersCount !== "number" || !Number.isFinite(followersCount)) return null;
  if (followersCount <= 0) return null;

  return followersCount;
}

/** Activates one guest token. Returns null (never throws) on any failure. */
async function activateGuestToken(): Promise<string | null> {
  const res = await fetchWithTimeout("https://api.twitter.com/1.1/guest/activate.json", {
    method: "POST",
    headers: { Authorization: `Bearer ${TWITTER_PUBLIC_BEARER}` },
  });
  if (!res || !res.ok) return null;
  try {
    const data = (await res.json()) as { guest_token?: string };
    return data.guest_token ?? null;
  } catch {
    return null;
  }
}

/** Fetches one handle's follower count via UserByScreenName. Never throws. */
async function fetchOneHandle(handle: string, guestToken: string): Promise<number | null> {
  const variables = JSON.stringify({ screen_name: handle, withSafetyModeUserFields: true });
  const features = JSON.stringify(GRAPHQL_FEATURES);
  const url =
    `https://twitter.com/i/api/graphql/${USER_BY_SCREEN_NAME_QUERY_ID}/UserByScreenName` +
    `?variables=${encodeURIComponent(variables)}&features=${encodeURIComponent(features)}`;

  try {
    const res = await fetchWithTimeout(url, {
      headers: {
        Authorization: `Bearer ${TWITTER_PUBLIC_BEARER}`,
        "x-guest-token": guestToken,
      },
    });
    if (!res || !res.ok) return null;
    const json = await res.json();
    return parseTwitterFollowersResponse(json);
  } catch {
    return null;
  }
}

/**
 * Resolves current X/Twitter follower counts for a batch of handles via the
 * anonymous guest-token GraphQL flow. Fail-open: any failure (kill switch,
 * activation failure, per-handle error) yields a smaller/empty map, never a
 * throw.
 *
 * One guest token is activated per call and reused across every handle
 * (~150 calls/token observed live) — never re-activate per-handle.
 */
export async function fetchTwitterFollowerMap(handles: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();

  // Kill switch — mirrors FB_SCRAPER_ENABLED=0 in facebook.provider.ts.
  if (process.env.TWITTER_FOLLOWER_SYNC_ENABLED === "0") return map;
  if (handles.length === 0) return map;

  let guestToken: string | null;
  try {
    guestToken = await activateGuestToken();
  } catch (e) {
    console.error("[follower-sync] X/Twitter guest-token activation threw:", e);
    return map;
  }
  if (!guestToken) {
    console.error("[follower-sync] X/Twitter guest-token activation failed — skipping this run");
    return map;
  }

  for (const handle of handles) {
    try {
      const followers = await fetchOneHandle(handle, guestToken);
      if (followers != null) {
        console.log(`[follower-sync] x/${handle}: ${followers}`);
        map.set(handle.toLowerCase(), followers);
      }
    } catch (e) {
      // Per-handle fail-open — one bad handle must never abort the batch.
      console.error(`[follower-sync] X/Twitter lookup failed for ${handle}:`, e);
    }
    await sleep(DELAY_MS);
  }

  return map;
}
