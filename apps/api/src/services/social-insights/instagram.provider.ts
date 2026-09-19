import { extractInstagramShortcode } from "@dashmani/shared";
import type { InsightProvider, InsightTarget, InsightFetchResult, HarvestedContent } from "./types";
import {
  graphFetch as defaultGraphFetch,
  metaConfigured,
  type GraphFetchFn,
} from "./meta-graph";

// ── Instagram insight provider ──────────────────────────────────────────────
//
// THE TWO-STEP ID PROBLEM
// -----------------------
// Our links only carry the post *shortcode* (ig:<shortcode> from canonicalKey),
// but the Graph media endpoint needs the NUMERIC media id, and Meta deprecated
// shortcode→media-id lookup. So we cannot resolve a shortcode directly.
//
// CORRECT APPROACH (what this provider does):
//   1. The META_SYSTEM_USER_TOKEN manages a set of IG Business accounts.
//      Discover them via GET /me/accounts?fields=instagram_business_account (bare
//      field — NO sub-selection). The `{id}` nested sub-selection form
//      (instagram_business_account{id}) intermittently returns HTTP 500 from the
//      live Graph API; the bare field reliably returns { instagram_business_account:
//      { id } } for each Page. See meta-followers.ts STEP 1 for the same rationale.
//   2. For each managed IG user id, page GET /{ig-user-id}/media?fields=
//      id,shortcode,caption,like_count,comments_count,media_type,timestamp,
//      insights.metric(views)&limit=100
//      (paginate up to a sane cap; stop early once media is older than the poll
//      window), building a shortcode→media map ONCE per run, cached on the provider.
//   3. extractTargetId(url) returns the shortcode; fetchBatch looks each target
//      shortcode up in the prebuilt map.
//
// A shortcode not in any managed account's map → status `not_found` (the post is
// on an account we don't manage, or older than what we paged). That is correct and
// bounded — we never guess.
//
// Views, captions and like/comment counts ALL come straight from the media list.
// ⚠️ The old note here claimed views "would require a per-media
// GET /{media-id}/insights?metric=plays call" and this provider therefore returned
// views: null for every Instagram link. That was WRONG, and it is why 0 of 43,828
// stored Instagram rows carried a view count. `insights.metric(views)` is a FREE
// EXPANSION on the media list — see IG_MEDIA_FIELDS below for the live proof.
//
// DARK SWITCH: while META_SYSTEM_USER_TOKEN is absent, isSupported() is false, the
// registry never polls this provider, and fetchBatch (if ever called directly)
// returns an all-error map without touching the network.
//
// ── ENV-OVERRIDABLE PAGING DEPTH ─────────────────────────────────────────────
// The forward 6h cron and the one-off deep backfill share THIS provider; the only
// difference is how deep each pages an account's /media feed. Two bounds are
// env-overridable so the cron uses SHALLOW forward defaults while a single backfill
// run can claw back more history:
//   IG_BACKFILL_MAX_PAGES    — pages per account (forward default 8 → up to 800
//                              recent media/account). The deep one-time backfill
//                              sets 200.
//   IG_BACKFILL_WINDOW_DAYS  — paging stops once media is older than this window
//                              (forward default 21). The deep backfill sets 1825.
//
// ⚠️ WHY THE FORWARD DEFAULTS ARE SHALLOW (8 pages / 21 days), not 60/90:
// buildShortcodeMap() pages EVERY managed account's feed newest-first ONCE per run,
// and the harvest (the only thing Link Search needs) can't run until that build
// finishes. With a 90-day window, high-volume "firehose" accounts (10k+ posts/yr)
// stay within the window for 20-25 pages each → the build took ~20 MINUTES on the
// 2GB prod box and competed with follower-sync for Meta's shared ~200-call/hr
// budget, so the harvest was perpetually starved (measured live 2026-06-25:
// IG link_content stuck at ~1k of 40k). Shallow forward paging builds the map in
// ~2 min and captures today/yesterday's posts (always page 1-2) reliably every
// cycle. The IG/FB Graph API has no fetch-by-shortcode — the only read path is
// paging /media newest-first — so deep paging never resolved meaningful history
// anyway (measured ~1% historical resolve, a Meta API design limit, not a bug).
// See .planning/LINK-SEARCH-ACCURACY-AUDIT-2026-06-25.md and
// docs/superpowers/plans/2026-06-23-ig-fb-futureproof-handoff.md.

const TIMEOUT_MS = 10_000;
const MEDIA_PAGE_SIZE = 100;
// Per-account /media paging cap. Forward cron uses the shallow default; the deep
// backfill raises it via env. 8 * 100 = up to 800 newest media/account.
const MAX_PAGES_PER_ACCOUNT = Number(process.env.IG_BACKFILL_MAX_PAGES) || 8;
// Stop paging once media is older than this window. Forward default 21d keeps the
// build fast + captures fresh posts; the deep backfill raises it via env.
const POLL_WINDOW_DAYS = Number(process.env.IG_BACKFILL_WINDOW_DAYS) || 21;
// Account-discovery (me/accounts) pagination guard — intentionally fixed (NOT the
// deep-paging cap). 38 IG accounts on prod fit well within 25 pages of 100; this
// must not balloon when IG_BACKFILL_MAX_PAGES is raised for media paging.
const MAX_ACCOUNT_DISCOVERY_PAGES = 25;

// Module-level rate-limit flag — set when the Graph API throttles us, short-circuits
// the rest of the run to rate_limited (mirrors youTubeQuotaExceeded). Reset at the
// top of each fetchBatch run.
export let igRateLimited = false;

// Injectable Graph fetcher. Defaults to the real implementation; tests swap it via
// __setGraphFetchForTesting so they need neither a token nor the network.
let graphFetchImpl: GraphFetchFn = defaultGraphFetch;

export function __setGraphFetchForTesting(fn: GraphFetchFn | null): void {
  graphFetchImpl = fn ?? defaultGraphFetch;
}

export function __resetIgRateLimitedForTesting(): void {
  igRateLimited = false;
}

// ── Graph response shapes (only the fields we request) ───────────────────────
interface IgAccountsResponse {
  data?: Array<{ instagram_business_account?: { id?: string } }>;
  paging?: { next?: string };
}

interface IgMediaItem {
  id: string;
  shortcode?: string;
  caption?: string;
  like_count?: number;
  comments_count?: number;
  media_type?: string;
  timestamp?: string; // ISO-8601
  /**
   * `insights.metric(views)` expanded inline on the media list — see the header note.
   * Shape: { data: [{ name: "views", values: [{ value: 12345 }] }] }.
   */
  insights?: { data?: Array<{ name?: string; values?: Array<{ value?: number }> }> };
}

interface IgMediaResponse {
  data?: IgMediaItem[];
  paging?: { next?: string };
}

// Discover the IG Business account ids the token manages.
//
// IMPORTANT: request the bare `instagram_business_account` field — NOT the
// `instagram_business_account{id}` sub-selection form. The sub-selection
// intermittently triggers HTTP 500 from the live Graph API, causing this
// function to silently return an empty array (the `!res.ok` guard breaks the
// loop with no warning). The bare field is reliably honored and the response
// shape is identical: { instagram_business_account: { id } }. This mirrors
// the pattern documented in meta-followers.ts STEP 1.
async function discoverIgUserIds(): Promise<string[]> {
  const ids: string[] = [];
  let path: string | null = "me/accounts";
  let params: Record<string, string | number | undefined> | undefined = {
    fields: "instagram_business_account",
    limit: MEDIA_PAGE_SIZE,
  };
  let guard = 0;

  while (path && guard < MAX_ACCOUNT_DISCOVERY_PAGES) {
    guard++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await graphFetchImpl<IgAccountsResponse>(path, params, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }

    if (res.rateLimited) {
      igRateLimited = true;
      break;
    }
    if (!res.ok || !res.data) break;

    for (const page of res.data.data ?? []) {
      const igId = page.instagram_business_account?.id;
      if (igId) ids.push(igId);
    }

    // Follow paging cursor (absolute URL already carries its params + token).
    path = res.data.paging?.next ?? null;
    params = undefined;
  }

  if (ids.length === 0) {
    console.warn(
      "[social-insights/instagram] discovery returned 0 IG accounts — possible Graph API issue (token is set)",
    );
  }

  return ids;
}

/**
 * ⚠️ `insights.metric(views)` IS A FREE FIELD EXPANSION ON THE MEDIA LIST — it rides
 * along in the call this provider already makes, exactly like `like_count`. It does
 * NOT cost one request per media.
 *
 * This overturns the note that stood in this file's header until 2026-09-19 ("reel
 * plays would require a per-media GET /{media-id}/insights"), which was written from
 * the media OBJECT's fields (where a bare `views` field genuinely is absent) and was
 * never probed as an expansion. Live-probed 2026-09-19 against the real prod token:
 * **8/8 accounts, 800/800 media, 100% populated**, at the production `limit=100` page
 * size, on v21.0 — and identically on v22.0/v23.0. Coverage held across every media
 * type (VIDEO 731/731, IMAGE 4/4, CAROUSEL_ALBUM 65/65).
 *
 * ⚠️ Read it defensively anyway. Meta omits an expansion rather than erroring when it
 * has nothing to say, so `viewsOf` returns null on any missing layer and the caller
 * stores null. A null is rendered as an em-dash; it must NEVER become 0 (the
 * documented fabricated-zero class).
 */
const IG_MEDIA_FIELDS =
  "id,shortcode,caption,like_count,comments_count,media_type,timestamp,insights.metric(views)";

export function viewsOf(item: { insights?: IgMediaItem["insights"] }): number | null {
  const v = item.insights?.data?.find((d) => d?.name === "views")?.values?.[0]?.value;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// Page one IG user's media into the shared shortcode→item map. Stops early once it
// sees media older than the poll window.
async function loadAccountMedia(
  igUserId: string,
  map: Map<string, IgMediaItem>
): Promise<void> {
  const oldestAllowed = Date.now() - POLL_WINDOW_DAYS * 86_400_000;
  let path: string | null = `${igUserId}/media`;
  let params: Record<string, string | number | undefined> | undefined = {
    fields: IG_MEDIA_FIELDS,
    limit: MEDIA_PAGE_SIZE,
  };
  let pages = 0;

  while (path && pages < MAX_PAGES_PER_ACCOUNT) {
    pages++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await graphFetchImpl<IgMediaResponse>(path, params, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }

    if (res.rateLimited) {
      igRateLimited = true;
      return;
    }
    if (!res.ok || !res.data) return;

    let sawOlderThanWindow = false;
    for (const item of res.data.data ?? []) {
      if (item.shortcode && !map.has(item.shortcode)) {
        map.set(item.shortcode, item);
      }
      if (item.timestamp) {
        const t = Date.parse(item.timestamp);
        if (!Number.isNaN(t) && t < oldestAllowed) sawOlderThanWindow = true;
      }
    }

    // Media is returned newest-first; once a page contains anything older than the
    // window there's no point paging further back.
    if (sawOlderThanWindow) {
      if (process.env.INSIGHTS_DEBUG) {
        console.log(`[social-insights/instagram] account ${igUserId}: paged ${pages} page(s), stopped at window edge`);
      }
      return;
    }

    path = res.data.paging?.next ?? null;
    params = undefined;
  }

  // Reached the page cap or end of feed without hitting the window edge. Surface the
  // depth under INSIGHTS_DEBUG so "why wasn't post X harvested?" is answerable without
  // a code change — a firehose account that maxes out MAX_PAGES_PER_ACCOUNT can't be
  // paged deeper (Meta has no fetch-by-shortcode), so older posts are structurally
  // out of reach. Default off (no log spam).
  if (process.env.INSIGHTS_DEBUG) {
    console.log(`[social-insights/instagram] account ${igUserId}: paged ${pages} page(s) (cap ${MAX_PAGES_PER_ACCOUNT}), feed ${path ? "has more (cap hit)" : "exhausted"}`);
  }
}

// Build the shortcode→media map across all managed accounts, once per run.
async function buildShortcodeMap(): Promise<Map<string, IgMediaItem>> {
  const map = new Map<string, IgMediaItem>();
  const igUserIds = await discoverIgUserIds();
  for (const igUserId of igUserIds) {
    if (igRateLimited) break;
    await loadAccountMedia(igUserId, map);
  }
  return map;
}

// The map built by the most recent fetchBatch run, cached so harvestContent() can
// expose the FULL set of paged posts without re-paging the Graph API. Reset at the
// start of each fetchBatch run. Module-level (mirrors igRateLimited) — the cron
// calls fetchBatch then harvestContent sequentially in one run.
// ⚠️ 2026-09-08 incident: fetchBatch used to rebuild this map on EVERY 50-link batch (the
// cron's "cached after the first batch" comment was false) — 100-800 Graph calls and a
// fresh ~15k-entry Map per batch, 6-17× the call volume of building once, and the reason a
// sweep could not finish inside its 2h interval. Now reused for FEED_MAP_TTL_MS within a
// sweep; a throttled (possibly partial) build is harvested but never reused for lookups.
// See facebook.provider.ts for the fuller note — the two providers share this shape.
const FEED_MAP_TTL_MS = Number(process.env.IG_FEED_MAP_TTL_MS) || 20 * 60 * 1000;
let lastBuiltMap: Map<string, IgMediaItem> = new Map();
let lastBuiltAt = 0; // 0 = never built / not reusable

export function __resetIgMapForTesting(): void {
  lastBuiltMap = new Map();
  lastBuiltAt = 0;
}

export const instagramProvider: InsightProvider = {
  slug: "instagram",

  isSupported() {
    return metaConfigured();
  },

  extractTargetId(url: string): string | null {
    return extractInstagramShortcode(url);
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
    igRateLimited = false;

    // Reuse the map built earlier in this sweep (FEED_MAP_TTL_MS above); rebuild only when
    // there is none, it is stale, or the last build was rate-limited (possibly partial).
    let map: Map<string, IgMediaItem>;
    const reusable = lastBuiltMap.size > 0 && lastBuiltAt > 0 && Date.now() - lastBuiltAt < FEED_MAP_TTL_MS;
    if (reusable) {
      map = lastBuiltMap;
    } else {
      lastBuiltMap = new Map();
      lastBuiltAt = 0;
      try {
        map = await buildShortcodeMap();
        lastBuiltMap = map; // cache for harvestContent() (same run, no re-paging)
        lastBuiltAt = igRateLimited ? 0 : Date.now(); // a throttled (partial) build is harvestable but never reused
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        for (const t of targets) {
          results.set(t.linkId, { ok: false, status: "error", error: msg });
        }
        return results;
      }
    }

    // If we got rate-limited while building the map, every target is rate_limited.
    if (igRateLimited) {
      for (const t of targets) {
        results.set(t.linkId, { ok: false, status: "rate_limited", error: "Instagram Graph API rate limit" });
      }
      return results;
    }

    // Map each target shortcode → result.
    for (const t of targets) {
      const item = map.get(t.targetId);
      if (!item) {
        // Shortcode not in any managed account's recent media: an account we don't
        // manage, or a post older than the paged window.
        results.set(t.linkId, { ok: false, status: "not_found" });
        continue;
      }
      results.set(t.linkId, {
        ok: true,
        status: "ok",
        // Real Instagram views — see IG_MEDIA_FIELDS. Null when Meta omits the
        // expansion for this media; never coerced to 0.
        views: viewsOf(item),
        likes: item.like_count ?? null,
        comments: item.comments_count ?? null,
        shares: null, // not provided by the media list
        title: null,
        caption: item.caption ?? null,
      });
    }

    return results;
  },

  // Expose EVERY post paged into the map this run (not just submitted/top-of-feed
  // ones), so the cron can persist captions before firehose volume buries them.
  // Keyed by canonicalKey (ig:<shortcode>) to match how submitted links are keyed.
  // Only posts that actually carry a caption are worth harvesting. No API calls —
  // reads the cached map from the just-completed fetchBatch.
  harvestContent(): HarvestedContent[] {
    const out: HarvestedContent[] = [];
    for (const [shortcode, item] of lastBuiltMap) {
      if (item.caption != null && item.caption !== "") {
        out.push({ canonicalKey: `ig:${shortcode}`, caption: item.caption, title: null });
      }
    }
    return out;
  },
};
