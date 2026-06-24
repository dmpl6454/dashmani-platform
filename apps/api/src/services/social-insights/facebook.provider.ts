import { extractFacebookPostId } from "@dashmani/shared";
import type { InsightProvider, InsightTarget, InsightFetchResult, HarvestedContent } from "./types";
import {
  graphFetch as defaultGraphFetch,
  metaConfigured,
  type GraphFetchFn,
} from "./meta-graph";

// ── Facebook insight provider (owned-Page paging — mirrors the Instagram model) ─
//
// WHY NOT GET /{post-id}: reading an arbitrary post by id needs the `likes.summary`
// / `comments.summary` FIELDS, which require pages_read_engagement to be FULLY
// App-Reviewed. Even on Pages we administer, those fields return (#10) while the
// app is in dev / "Ready for testing". Proven by live probing (2026-06-24).
//
// WHAT WORKS TODAY (no full App Review), on Pages the System User administers:
//   1. Mint a PAGE access token:  GET /{page-id}?fields=access_token
//   2. Captions:  GET /{page-id}/published_posts?fields=id,permalink_url,message
//      with the PAGE token → `message` is the caption. (The /feed edge and the
//      likes.summary post-field are still gated, but /published_posts + message
//      is NOT.)
//   3. Per-post engagement: GET /{post-id}/insights?metric=... (governed by
//      read_insights, which IS honored in testing) →
//        post_video_views            → views
//        post_reactions_by_type_total → reactions map; sum = likes
//        post_activity_by_action_type → { like, comment, share } (keys present
//                                        only when > 0) → comments + shares
//      Metrics are requested ONE-AT-A-TIME-ish (batched only with other known-valid
//      metrics) because an invalid metric for a given post type 400s the WHOLE call.
//
// So fetchBatch builds, once per run, a numericId → { caption, pageToken } map by
// paging each managed Page's /published_posts (like IG's shortcode→media map), then
// for each matched target pulls /insights with that Page's token. A target whose
// numeric id isn't in any administered Page's feed → not_found (correct + bounded).
//
// Pages WITHOUT an admin role (no `tasks` in /me/accounts) can't be read at all and
// are skipped. Opaque /share/ + pfbid links never reach here (extractFacebookPostId
// returns null for them — the cron skips them as "could not extract targetId").
//
// DARK SWITCH: while META_SYSTEM_USER_TOKEN is absent, isSupported() is false, the
// registry never polls this provider, and fetchBatch returns an all-error map
// without touching the network.
//
// ── ENV-OVERRIDABLE PAGING DEPTH (for a one-time deep historical backfill) ──
//   FB_BACKFILL_MAX_PAGES   — /published_posts pages per Page (default 8; backfill ↑)
//   FB_BACKFILL_WINDOW_DAYS — stop paging once a post is older than this (default 90)
// With neither set, the cron uses the shallow defaults that keep up with fresh posts
// without burning the shared ~200-call/hr Graph budget.

const TIMEOUT_MS = 10_000;
const PAGE_FEED_SIZE = 100;
const MAX_FEED_PAGES_PER_PAGE = Number(process.env.FB_BACKFILL_MAX_PAGES) || 8;
const POLL_WINDOW_DAYS = Number(process.env.FB_BACKFILL_WINDOW_DAYS) || 90;
const MAX_PAGE_DISCOVERY_PAGES = 25; // fixed: 87 managed Pages fit in <1 page of 100
// Insight metrics we request per post. Split into two batches by validity profile so
// one post type's invalid metric can't 400 the other batch.
const VIEW_METRICS = "post_video_views";
const ACTIVITY_METRICS = "post_reactions_by_type_total,post_activity_by_action_type";

// Module-level rate-limit flag — set when the Graph API throttles us, short-circuits
// the rest of the run to rate_limited. Reset at the top of each fetchBatch run.
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

// ── Graph response shapes (only the fields we request) ───────────────────────
interface FbAccountsResponse {
  data?: Array<{ id?: string; access_token?: string; tasks?: string[] }>;
  paging?: { next?: string };
}

interface FbPublishedPost {
  id: string;
  permalink_url?: string;
  message?: string;
  created_time?: string; // ISO-8601
}

interface FbPublishedPostsResponse {
  data?: FbPublishedPost[];
  paging?: { next?: string };
}

interface FbInsightsResponse {
  data?: Array<{ name: string; values?: Array<{ value: unknown }> }>;
}

// One entry per post we paged from a managed Page's feed.
//
// ⚠️ A Facebook post has TWO different ids and they are NOT interchangeable
// (verified live 2026-06-24):
//   • matchId   — the id our canonicalKey uses (fb:<matchId>): for a reel this is
//     the numeric id inside the /reel/<n> permalink — that's what a submitted
//     report_link resolves to via extractFacebookPostId, so the map MUST be keyed
//     on it for fetchBatch to find the target.
//   • insightsId — the "{pageId}_{postId}" COMPOSITE id from the feed: the ONLY id
//     the /{id}/insights endpoint accepts. The permalink reel id returns empty and
//     the bare post-id tail returns "(#12) deprecated".
// So we key the map by matchId but carry insightsId for the metrics call.
interface FbPostEntry {
  matchId: string; // fb:<matchId> canonicalKey id (permalink reel id, else composite tail)
  insightsId: string; // "{pageId}_{postId}" composite — for /{id}/insights
  caption: string | null;
  pageToken: string; // the owning Page's access token (to read this post's insights)
}

// Discover managed Pages WE ADMINISTER, with their Page access tokens. A Page with
// no `tasks` (no admin role) can't be read, so skip it.
async function discoverManagedPages(): Promise<Array<{ id: string; token: string }>> {
  const out: Array<{ id: string; token: string }> = [];
  let path: string | null = "me/accounts";
  let params: Record<string, string | number | undefined> | undefined = {
    fields: "id,access_token,tasks",
    limit: PAGE_FEED_SIZE,
  };
  let guard = 0;

  while (path && guard < MAX_PAGE_DISCOVERY_PAGES) {
    guard++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await graphFetchImpl<FbAccountsResponse>(path, params, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (res.rateLimited) {
      fbRateLimited = true;
      break;
    }
    if (!res.ok || !res.data) break;

    for (const pg of res.data.data ?? []) {
      // Only administered Pages (with tasks) expose readable content; need a token.
      if (pg.id && pg.access_token && Array.isArray(pg.tasks) && pg.tasks.length > 0) {
        out.push({ id: pg.id, token: pg.access_token });
      }
    }
    path = res.data.paging?.next ?? null;
    params = undefined;
  }
  return out;
}

// Page one Page's /published_posts into the shared numericId→entry map. Stops early
// once it sees a post older than the poll window (posts are newest-first).
async function loadPageFeed(
  page: { id: string; token: string },
  map: Map<string, FbPostEntry>
): Promise<void> {
  const oldestAllowed = Date.now() - POLL_WINDOW_DAYS * 86_400_000;
  let path: string | null = `${page.id}/published_posts`;
  // Note: pass the PAGE token (not the user/system token) — required to read content.
  let params: Record<string, string | number | undefined> | undefined = {
    fields: "id,permalink_url,message,created_time",
    limit: PAGE_FEED_SIZE,
    access_token: page.token,
  };
  let pages = 0;

  while (path && pages < MAX_FEED_PAGES_PER_PAGE) {
    pages++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await graphFetchImpl<FbPublishedPostsResponse>(path, params, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (res.rateLimited) {
      fbRateLimited = true;
      return;
    }
    if (!res.ok || !res.data) return;

    let sawOlderThanWindow = false;
    for (const post of res.data.data ?? []) {
      const ids = pickIds(post);
      // Key by matchId (what submitted links resolve to); carry insightsId (composite)
      // for the metrics call. A post with no usable composite id can't get insights.
      if (ids && !map.has(ids.matchId)) {
        map.set(ids.matchId, {
          matchId: ids.matchId,
          insightsId: ids.insightsId,
          caption: post.message ?? null,
          pageToken: page.token,
        });
      }
      if (post.created_time) {
        const t = Date.parse(post.created_time);
        if (!Number.isNaN(t) && t < oldestAllowed) sawOlderThanWindow = true;
      }
    }
    if (sawOlderThanWindow) return;

    path = res.data.paging?.next ?? null;
    params = undefined; // the paging.next cursor already carries fields + token
  }
}

// Derive BOTH ids for a paged post:
//   • matchId   — what fb:<id> canonicalKey resolves to from a submitted link: the
//     clean numeric id inside the /reel|/videos permalink if present, else the
//     composite-id tail (covers plain Page posts whose permalink carries no reel id).
//   • insightsId — the "{pageId}_{postId}" COMPOSITE (the post's own id field), which
//     is the only form /{id}/insights accepts.
// Returns null only when there's no usable composite id at all.
function pickIds(post: FbPublishedPost): { matchId: string; insightsId: string } | null {
  const composite = String(post.id || "");
  if (!composite || !composite.includes("_")) return null;
  const tail = composite.split("_").pop();
  if (!tail || !/^\d+$/.test(tail)) return null;
  let matchId = tail;
  if (post.permalink_url) {
    const fromUrl = extractFacebookPostId(post.permalink_url);
    if (fromUrl) matchId = fromUrl; // reel/video permalink id — matches submitted links
  }
  return { matchId, insightsId: composite };
}

// Sum a reactions-by-type map ({ like: 9, love: 2, ... }) into a single count.
function sumReactions(v: unknown): number | null {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    let total = 0;
    for (const n of Object.values(v as Record<string, unknown>)) {
      if (typeof n === "number") total += n;
    }
    return total;
  }
  return null;
}

function activityValue(v: unknown, key: string): number | null {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const n = (v as Record<string, unknown>)[key];
    return typeof n === "number" ? n : null;
  }
  return null;
}

// Pull views / likes / comments / shares for one post via the /insights endpoint
// using the owning Page's token. `insightsId` MUST be the "{pageId}_{postId}"
// composite (the reel permalink id returns empty; the bare tail is deprecated).
// Returns nulls on any gap — never throws.
async function fetchPostInsights(
  insightsId: string,
  pageToken: string
): Promise<{ views: number | null; likes: number | null; comments: number | null; shares: number | null }> {
  const out = { views: null as number | null, likes: null as number | null, comments: null as number | null, shares: null as number | null };

  // Batch 1 — video views (skipped silently if the post isn't a video).
  try {
    const r = await graphFetchImpl<FbInsightsResponse>(
      `${insightsId}/insights`,
      { metric: VIEW_METRICS, access_token: pageToken }
    );
    if (r.rateLimited) { fbRateLimited = true; return out; }
    if (r.ok && r.data?.data) {
      const m = r.data.data.find((x) => x.name === "post_video_views");
      const v = m?.values?.[0]?.value;
      if (typeof v === "number") out.views = v;
    }
  } catch { /* leave views null */ }

  // Batch 2 — reactions + activity (likes / comments / shares).
  try {
    const r = await graphFetchImpl<FbInsightsResponse>(
      `${insightsId}/insights`,
      { metric: ACTIVITY_METRICS, access_token: pageToken }
    );
    if (r.rateLimited) { fbRateLimited = true; return out; }
    if (r.ok && r.data?.data) {
      const reactions = r.data.data.find((x) => x.name === "post_reactions_by_type_total");
      const activity = r.data.data.find((x) => x.name === "post_activity_by_action_type");
      const reactionSum = sumReactions(reactions?.values?.[0]?.value);
      if (reactionSum != null) out.likes = reactionSum;
      else out.likes = activityValue(activity?.values?.[0]?.value, "like");
      out.comments = activityValue(activity?.values?.[0]?.value, "comment");
      out.shares = activityValue(activity?.values?.[0]?.value, "share");
    }
  } catch { /* leave engagement nulls */ }

  return out;
}

// Build the numericId→entry map across all administered Pages, once per run.
async function buildPostMap(): Promise<Map<string, FbPostEntry>> {
  const map = new Map<string, FbPostEntry>();
  const pages = await discoverManagedPages();
  for (const page of pages) {
    if (fbRateLimited) break;
    await loadPageFeed(page, map);
  }
  return map;
}

// The map built by the most recent fetchBatch run, cached so harvestContent() can
// expose every paged post's caption without re-paging. Reset each run.
let lastBuiltMap: Map<string, FbPostEntry> = new Map();

export function __resetFbMapForTesting(): void {
  lastBuiltMap = new Map();
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

    fbRateLimited = false;
    lastBuiltMap = new Map();

    // Build the numericId→{caption, pageToken} map once for this run.
    let map: Map<string, FbPostEntry>;
    try {
      map = await buildPostMap();
      lastBuiltMap = map; // cache for harvestContent() (same run, no re-paging)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      for (const t of targets) {
        results.set(t.linkId, { ok: false, status: "error", error: msg });
      }
      return results;
    }

    if (fbRateLimited) {
      for (const t of targets) {
        results.set(t.linkId, { ok: false, status: "rate_limited", error: "Facebook Graph API rate limit" });
      }
      return results;
    }

    // Resolve each target: caption comes from the map; engagement from /insights.
    for (const t of targets) {
      if (fbRateLimited) {
        results.set(t.linkId, { ok: false, status: "rate_limited", error: "Facebook Graph API rate limit" });
        continue;
      }
      const entry = map.get(t.targetId);
      if (!entry) {
        // Post not on any administered Page's recent feed (unmanaged Page, or older
        // than the paged window). Correct + bounded — we never guess.
        results.set(t.linkId, { ok: false, status: "not_found" });
        continue;
      }
      const metrics = await fetchPostInsights(entry.insightsId, entry.pageToken);
      results.set(t.linkId, {
        ok: true,
        status: "ok",
        views: metrics.views,
        likes: metrics.likes,
        comments: metrics.comments,
        shares: metrics.shares,
        title: null,
        caption: entry.caption,
      });
    }

    return results;
  },

  // Expose EVERY captioned post paged into the map this run (not just submitted/
  // top-of-feed ones), keyed by canonicalKey (fb:<numericId>), so the cron can
  // persist captions before firehose volume buries them — mirrors IG. No API calls.
  harvestContent(): HarvestedContent[] {
    const out: HarvestedContent[] = [];
    for (const entry of lastBuiltMap.values()) {
      if (entry.caption != null && entry.caption !== "") {
        out.push({ canonicalKey: `fb:${entry.matchId}`, caption: entry.caption, title: null });
      }
    }
    return out;
  },
};

// ── OPT-IN best-effort opaque-URL resolver (submit-time; NOT in fetchBatch) ────
//
// Does ONE redirect:manual fetch and reads the Location header. If Facebook
// redirects an opaque /share/r/… link to a clean numeric /reel/<n> or /videos/<n>
// URL, returns that numeric id (via extractFacebookPostId, which only accepts clean
// numeric forms). If it lands on pfbid / anything opaque → returns null (GIVE UP —
// no feed-matching). fetchImpl is injectable for tests; defaults to global fetch.
// `externalSignal` lets a caller (e.g. a batch with an overall wall-clock budget)
// abort the in-flight fetch when its own deadline fires — otherwise the probe would
// keep running in the background past the caller's return. We still arm our own 10s
// timeout as a fallback so a lone call without an external signal can't hang.
export async function resolveOpaqueFacebookUrl(
  url: string,
  fetchImpl: typeof fetch = fetch,
  externalSignal?: AbortSignal
): Promise<string | null> {
  if (!url) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  // Chain the caller's signal: if it aborts, abort our controller too (cancelling
  // the fetch). If it's already aborted, abort immediately.
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }
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
    if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
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
//
// `externalSignal` is forwarded so a batch caller's wall-clock budget can actually
// CANCEL the underlying fetch (not just stop awaiting it) — see the submit-path
// budget guard in daily-report.service.ts.
export async function resolveFacebookShareUrl(
  url: string,
  fetchImpl: typeof fetch = fetch,
  externalSignal?: AbortSignal
): Promise<string | null> {
  try {
    const id = await resolveOpaqueFacebookUrl(url, fetchImpl, externalSignal); // already fail-open
    return id ? `https://www.facebook.com/reel/${id}` : null;
  } catch {
    return null;
  }
}
