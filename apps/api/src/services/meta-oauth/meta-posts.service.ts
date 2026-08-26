/**
 * Post fetching — the data the revamped Account Growth page renders.
 *
 * Two-speed by design, because the cost profile is wildly asymmetric (all figures
 * live-probed 2026-08-19, see .planning/META-POST-INSIGHTS-LIVE-PROBE-2026-08-19.md):
 *
 *   CHEAP  — one paginated feed call per asset returns a whole page of posts. For
 *            Instagram it also returns like_count and comments_count INLINE, so an
 *            IG row is never empty even if we never spend an insights call on it.
 *   COSTLY — per-post insights (reach/views/saves) is one call PER POST. Bounded by
 *            a call budget, a staleness TTL, and pending-first prioritisation.
 *
 * ⚠️ METRIC NAMES ARE VERSION-SENSITIVE AND THE DOCS LIE.
 * Live-probed on v21.0 AND v23.0 (identical behaviour, so pinning a newer version
 * buys nothing): IG `impressions` is deprecated, and FB `post_impressions`,
 * `post_impressions_unique`, `post_views`, `post_reach` and `post_engaged_users` all
 * return (#100). The live equivalents are IG `views` and FB `post_media_view` /
 * `post_total_media_view_unique`. Never re-add the dead names.
 *
 * ⚠️ A metric Meta does not publish is stored as NULL and rendered as an em-dash.
 * NEVER coerce to 0 — that is the fabricated-zero bug class from the Snapchat
 * showLikes incident, where an absent metric read as "this post got no likes".
 */

import { prisma } from "@dashmani/db";
import { oauthGraphFetch, makeBudget, type CallBudget } from "./oauth-graph";
import { resolveDuplicateAssetIds } from "./meta-channels.service";
import { decryptToken, scrubSecrets } from "../../utils/token-crypto";
import { metaTuning } from "./meta-config";

/** One page per asset per run. Forward posts are always page 1; following paging.next
 *  in a cron is what made an earlier feed build take ~20 min and starve everything. */
const FEED_LIMIT = 25;

/** Share of the budget reserved for the phase-1 feed pass. */
const FEED_RESERVE_SHARE = 0.7;
/** Calls left for phase-2 per-post insights once every asset's feed is covered. */
const POST_INSIGHTS_ALLOWANCE = 300;

/** IG per-post insight metrics, in one batched call. */
const IG_METRICS = ["reach", "views", "saved", "total_interactions", "shares"] as const;

/**
 * The ONLY FB metric still fetched per-post.
 *
 * The engagement batch (post_reactions_by_type_total + post_activity_by_action_type)
 * was REMOVED 2026-08-20: likes/comments/shares now arrive inline on the feed via the
 * summary fields, so that call was pure waste. Keeping it also meant each FB post cost
 * two calls, which let Facebook consume the whole insights budget and starve Instagram
 * on the first prod run.
 *
 * ⚠️ Do NOT re-add an engagement batch here without first checking whether the feed's
 * summary fields still work — if they ever stop, the fallback belongs in the FEED
 * error path, not as an unconditional second call per post.
 */
/**
 * ⚠️ post_media_view, NOT post_video_views.
 *
 * post_video_views counts VIDEO PLAYS only and is the pre-deprecation metric.
 * Meta retired the impressions/views family on 2025-11-15 (with the rest
 * following 2026-06-15) and named these successors:
 *
 *      post_impressions        →  post_media_view              (views)
 *      post_impressions_unique →  post_total_media_view_unique (reach)
 *
 * Probed live on three real posts, 2026-08-24:
 *
 *      post_media_view    3263   1107   2596
 *      post_video_views      0      0    931   ← what we were storing
 *
 * That is why 1,543 of the 1,663 measured Facebook posts on prod held a views
 * value of exactly 0. Those zeros were not "this post got no views" — they were
 * a video-only metric answering about content it does not describe, rendered as
 * a real zero. Both names live in ONE batched call, so reach is free.
 */
const FB_METRICS_VIEWS = ["post_media_view", "post_total_media_view_unique"] as const;

interface IgMediaResponse {
  data?: Array<{
    id?: string;
    shortcode?: string;
    permalink?: string;
    caption?: string;
    like_count?: number;
    comments_count?: number;
    media_type?: string;
    media_product_type?: string;
    timestamp?: string;
  }>;
  paging?: { next?: string };
}

/**
 * ⚠️ THE SUMMARY FIELDS ARE THE ~20× COST LEVER — verified live 2026-08-20 under the
 * "Post Automation 2" app, which has pages_read_engagement at Advanced Access.
 *
 * These same fields returned `(#10) requires pages_read_engagement` under the OLDER
 * "Dashmani Insights" app, which is why every prior note in this repo says FB
 * engagement is only reachable via per-post /insights. That is TRUE FOR THAT APP and
 * FALSE for this one. Live proof (Bollywood Society, 3 posts): likes 30/243/117,
 * comments 0/9/4, shares 1/1/4 — all inline on /published_posts.
 *
 * Consequence: FB likes/comments/shares now cost ZERO extra calls, exactly like IG's
 * inline like_count. Per-post /insights is then only needed for views and reach,
 * which genuinely have no inline equivalent — Instagram does not expose a `views`
 * field on the media object either (probed 2026-08-24: silently omitted).
 *
 * ⚠️ `shares` is ABSENT (not 0) when a post has none, so it must map to null.
 */
interface FbPostsResponse {
  data?: Array<{
    id?: string;
    message?: string;
    permalink_url?: string;
    created_time?: string;
    likes?: { summary?: { total_count?: number } };
    comments?: { summary?: { total_count?: number } };
    shares?: { count?: number };
  }>;
  paging?: { next?: string };
}

interface InsightsResponse {
  data?: Array<{ name?: string; values?: Array<{ value?: unknown }> }>;
}

export interface PostsSyncOutcome {
  assetsPolled: number;
  postsUpserted: number;
  metricsUpdated: number;
  metricsPending: number;
  callsUsed: number;
  rateLimited: boolean;
  trimmed: number;
  errors: string[];
}

/** Read a numeric insight value, preserving "absent" as null. */
function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Sum a reactions-by-type map ({like: 3, love: 1} → 4). Absent ⇒ null, not 0.
 *
 * Currently UNUSED — the feed's summary fields supply likes directly. Retained
 * deliberately (with activityKey below) because it is the documented fallback shape
 * if Meta ever revokes the summary fields for this app, and re-deriving it from the
 * Graph docs would cost another live-probing session.
 */
function sumReactions(v: unknown): number | null {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    let total = 0;
    let seen = false;
    for (const n of Object.values(v as Record<string, unknown>)) {
      if (typeof n === "number") {
        total += n;
        seen = true;
      }
    }
    return seen ? total : null;
  }
  return null;
}

/** Pull one key out of an activity map. Keys are present only when > 0. */
function activityKey(v: unknown, key: string): number | null {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const n = (v as Record<string, unknown>)[key];
    return typeof n === "number" ? n : null;
  }
  return null;
}

function insightMap(res: InsightsResponse | undefined): Map<string, unknown> {
  const m = new Map<string, unknown>();
  for (const item of res?.data ?? []) {
    if (item.name) m.set(item.name, (item.values ?? [{}])[0]?.value);
  }
  return m;
}

/** The IG shortcode / FB reel id a submitted link would canonicalise to. */
function deriveMatchId(kind: "FACEBOOK_PAGE" | "INSTAGRAM_ACCOUNT", permalink: string | null, shortcode?: string) {
  if (kind === "INSTAGRAM_ACCOUNT") {
    if (shortcode) return shortcode;
    const m = permalink?.match(/instagram\.com\/(?:p|reel|tv)\/([^/?#]+)/i);
    return m ? m[1] : null;
  }
  // FB: the numeric id inside the /reel/<n> or /posts/<n> permalink. This is the
  // "map key" half of the documented DUAL-ID gotcha; the {pageId}_{postId} composite
  // is the only id /insights accepts and is stored separately as metaPostId.
  const m = permalink?.match(/\/(?:reel|videos|posts)\/(\d{6,})/i);
  return m ? m[1] : null;
}

/**
 * Sync one asset: one feed page, then bounded per-post insights.
 * Never throws.
 */
type SyncAsset = {
  id: string;
  kind: "FACEBOOK_PAGE" | "INSTAGRAM_ACCOUNT";
  metaId: string;
  name: string;
  pageTokenEnc: string | null;
};

/** Resolve the right token for an asset, or null with the reason recorded. */
async function tokenForAsset(
  asset: SyncAsset,
  userToken: string,
  out: PostsSyncOutcome,
): Promise<string | null> {
  if (asset.kind === "INSTAGRAM_ACCOUNT") return userToken;
  if (!asset.pageTokenEnc) {
    out.errors.push(`${asset.name}: no page token (re-run discovery)`);
    return null;
  }
  try {
    return decryptToken(asset.pageTokenEnc);
  } catch (e) {
    out.errors.push(`${asset.name}: page token undecryptable — re-authorise`);
    await prisma.metaAsset.update({
      where: { id: asset.id },
      data: { lastPostSyncStatus: "error", lastPostSyncError: scrubSecrets(String(e)) },
    });
    return null;
  }
}

async function syncAsset(
  asset: SyncAsset,
  userToken: string,
  budget: CallBudget,
  out: PostsSyncOutcome,
): Promise<void> {
  const isIg = asset.kind === "INSTAGRAM_ACCOUNT";

  // IG reads with the USER token (every existing IG path in this repo does);
  // FB reads with the Page token, which arrived inline at discovery.
  const token = await tokenForAsset(asset, userToken, out);
  if (!token) return;

  // ── Feed: one page ────────────────────────────────────────────────────────
  const feed = isIg
    ? await oauthGraphFetch<IgMediaResponse>(
        `${asset.metaId}/media`,
        {
          // like_count + comments_count are FREE here — this is the perf lever.
          fields:
            "id,shortcode,permalink,caption,like_count,comments_count,media_type,media_product_type,timestamp",
          limit: FEED_LIMIT,
        },
        token,
        { label: "posts-ig-feed", budget },
      )
    : await oauthGraphFetch<FbPostsResponse>(
        `${asset.metaId}/published_posts`,
        {
          // Summary fields ride along FREE — see the FbPostsResponse note above.
          fields:
            "id,message,permalink_url,created_time," +
            "likes.summary(true).limit(0),comments.summary(true).limit(0),shares",
          limit: FEED_LIMIT,
        },
        token,
        { label: "posts-fb-feed", budget },
      );

  if (feed.rateLimited) {
    out.rateLimited = true;
    await prisma.metaAsset.update({
      where: { id: asset.id },
      data: { lastPostSyncStatus: "rate_limited", lastPostSyncAt: new Date() },
    });
    return;
  }
  if (!feed.ok || !feed.data) {
    out.errors.push(`${asset.name}: feed failed — ${feed.error ?? "unknown"}`);
    await prisma.metaAsset.update({
      where: { id: asset.id },
      data: {
        lastPostSyncStatus: "error",
        lastPostSyncError: scrubSecrets(feed.error ?? "feed failed"),
        lastPostSyncAt: new Date(),
      },
    });
    return;
  }

  out.assetsPolled++;
  const rows = (feed.data as { data?: unknown[] }).data ?? [];

  for (const raw of rows) {
    const r = raw as Record<string, unknown>;
    const metaPostId = typeof r.id === "string" ? r.id : null;
    if (!metaPostId) continue;

    const permalink = (isIg ? r.permalink : r.permalink_url) as string | undefined;
    const postedRaw = (isIg ? r.timestamp : r.created_time) as string | undefined;
    const postedAt = postedRaw ? new Date(postedRaw) : null;

    const base = {
      permalink: permalink ?? null,
      caption: ((isIg ? r.caption : r.message) as string | undefined) ?? null,
      mediaType: (r.media_type as string | undefined) ?? null,
      mediaProductType: (r.media_product_type as string | undefined) ?? null,
      postedAt: postedAt && !Number.isNaN(postedAt.getTime()) ? postedAt : null,
      matchId: deriveMatchId(asset.kind, permalink ?? null, r.shortcode as string | undefined),
      // BOTH platforms now hand us engagement inline — IG via like_count/comments_count,
      // FB via the likes/comments summary fields (Advanced Access, verified live).
      // So a row is never blank on either platform, and /insights is reserved for
      // views alone.
      likes: isIg
        ? numOrNull(r.like_count)
        : numOrNull((r.likes as { summary?: { total_count?: number } } | undefined)?.summary?.total_count),
      comments: isIg
        ? numOrNull(r.comments_count)
        : numOrNull((r.comments as { summary?: { total_count?: number } } | undefined)?.summary?.total_count),
      // FB only: `shares` is ABSENT rather than 0 when there are none ⇒ honest null.
      ...(isIg ? {} : { shares: numOrNull((r.shares as { count?: number } | undefined)?.count) }),
    };

    await prisma.metaPost.upsert({
      where: { assetId_metaPostId: { assetId: asset.id, metaPostId } },
      create: { assetId: asset.id, metaPostId, ...base },
      // Never reset metricsStatus here — the insights pass owns it.
      update: base,
    });
    out.postsUpserted++;
  }

  await prisma.metaAsset.update({
    where: { id: asset.id },
    data: {
      lastPostSyncAt: new Date(),
      lastPostSyncStatus: out.rateLimited ? "rate_limited" : "ok",
      lastPostSyncError: null,
    },
  });
}

/**
 * PHASE 2 — per-post insights for ONE asset.
 *
 * ⚠️ Split out from the feed pass deliberately. Running feed+insights together per
 * asset meant the call budget was consumed by the FIRST few assets and the remaining
 * ~115 were never polled at all, so most channels showed nothing after a run. Now the
 * runner does a cheap feed pass across EVERY asset first (one call each, and for IG
 * that alone yields likes+comments inline), then spends whatever budget is left on
 * insights — so every channel has visible data after one run, and the expensive
 * metrics fill in across runs.
 */
async function syncAssetInsights(
  asset: SyncAsset,
  userToken: string,
  budget: CallBudget,
  out: PostsSyncOutcome,
): Promise<void> {
  const isIg = asset.kind === "INSTAGRAM_ACCOUNT";
  const token = await tokenForAsset(asset, userToken, out);
  if (!token) return;

  // ── Insights: bounded, pending-first, TTL-gated ───────────────────────────
  const ttlHours = metaTuning.insightsRefreshHours();
  const staleBefore = new Date(Date.now() - ttlHours * 3_600_000);

  const needMetrics = await prisma.metaPost.findMany({
    where: {
      assetId: asset.id,
      OR: [
        { metricsStatus: "pending" },
        { metricsFetchedAt: null },
        { metricsFetchedAt: { lt: staleBefore } },
      ],
    },
    // ⚠️ NEWEST FIRST — and note what this replaced. The previous ordering was
    // `[{ metricsStatus: "asc" }, { postedAt: "desc" }]` with a comment claiming
    // "pending first". It did the opposite: metricsStatus sorts as a STRING, and
    // ascending over the four live values gives
    //     "error" < "ok" < "pending" < "unavailable"
    // so already-measured posts were re-measured ahead of posts that had never
    // been measured at all. With a slice of 8 against thousands of posts, the
    // never-measured tail could not drain: 4,608 of 6,271 Facebook posts on prod
    // (73%) still had no views value.
    //
    // Newest-first is also the right priority on its own terms. Per-post insights
    // cost one call each and the busiest Pages publish ~1,200 posts per 28 days,
    // so full coverage is not purchasable at any budget we have. Recent posts are
    // what the drill-down shows and what an admin is asking about; the channel
    // totals already account for every post, measured or not.
    orderBy: [{ postedAt: "desc" }],
    // ⚠️ 8, not 25. A Facebook post costs TWO insights calls, so a 25-post slice is
    // up to 50 calls — one asset could take a fifth of the whole run's budget and
    // only ~7 of 120 channels would ever be measured. A smaller slice spreads the
    // same budget across ~4x more channels per run; the pending-first ordering here
    // plus the pending-count asset ordering above means the remainder is picked up
    // on subsequent runs rather than dropped.
    take: 8,
    select: { id: true, metaPostId: true, mediaProductType: true },
  });

  for (const post of needMetrics) {
    if (budget.used >= budget.max) {
      out.metricsPending++;
      continue;
    }

    if (isIg) {
      const res = await oauthGraphFetch<InsightsResponse>(
        `${post.metaPostId}/insights`,
        { metric: IG_METRICS.join(",") },
        token,
        { label: "posts-ig-insights", budget },
      );
      if (res.rateLimited) {
        out.rateLimited = true;
        break;
      }
      if (!res.ok) {
        // A genuinely unsupported metric set for this post type. Record it as
        // measured-and-unavailable so the UI can distinguish it from "not yet tried".
        await prisma.metaPost.update({
          where: { id: post.id },
          data: {
            metricsStatus: res.errorCode === 100 ? "unavailable" : "error",
            metricsFetchedAt: new Date(),
            metricsError: scrubSecrets(res.error ?? "insights failed"),
          },
        });
        continue;
      }
      const m = insightMap(res.data);
      await prisma.metaPost.update({
        where: { id: post.id },
        data: {
          reach: numOrNull(m.get("reach")),
          views: numOrNull(m.get("views")),
          saves: numOrNull(m.get("saved")),
          shares: numOrNull(m.get("shares")),
          metricsStatus: "ok",
          metricsFetchedAt: new Date(),
          metricsError: null,
        },
      });
      out.metricsUpdated++;
    } else {
      // FB: ONLY views now. likes/comments/shares already arrived inline on the feed,
      // so the second (engagement) batch was pure waste — removing it halves the FB
      // insights cost and doubles how many posts one budget can measure.
      const viewsRes = await oauthGraphFetch<InsightsResponse>(
        `${post.metaPostId}/insights`,
        { metric: FB_METRICS_VIEWS.join(",") },
        token,
        { label: "posts-fb-insights-views", budget },
      );
      if (viewsRes.rateLimited) {
        out.rateLimited = true;
        break;
      }
      // ⚠️ NO second (engagement) batch any more. likes/comments/shares now arrive
      // INLINE on the feed via the summary fields, so asking /insights for
      // post_reactions_by_type_total + post_activity_by_action_type was pure waste:
      // it doubled the per-post cost and, on the first prod run, let Facebook consume
      // the entire insights budget while Instagram got none. Views are the only FB
      // metric with no inline equivalent.
      //
      // Deliberately NOT overwriting likes/comments/shares here — the feed pass owns
      // them, and the insights map returns {} for most reels, which would blank out
      // good inline values.
      const vm = insightMap(viewsRes.data);
      await prisma.metaPost.update({
        where: { id: post.id },
        data: {
          views: numOrNull(vm.get("post_media_view")),
          // ⚠️ POST-LEVEL reach is only stored when positive. Facebook returns a
          // literal 0 for it on almost every post — measured across 188 freshly
          // synced posts, every single one came back 0, including one with 298,346
          // views. A post cannot be seen 298,346 times by nobody, so that 0 is a
          // placeholder for "not published", not a measurement. Meta is still
          // rolling this metric out at post level (it reads correctly at PAGE level,
          // where page_total_media_view_unique returns real figures on all 72 Pages).
          // Storing the 0 would put a false number in the database for any later
          // reader to pick up — the fabricated-zero class. Revisit once Meta
          // populates it; the metric name is already correct.
          reach: (() => { const r = numOrNull(vm.get("post_total_media_view_unique")); return r && r > 0 ? r : null; })(),
          // `unavailable` = we asked and Meta publishes nothing; distinct from
          // `pending` = not asked yet.
          metricsStatus: viewsRes.ok ? "ok" : viewsRes.errorCode === 100 ? "unavailable" : "error",
          metricsFetchedAt: new Date(),
          metricsError: viewsRes.ok ? null : scrubSecrets(viewsRes.error ?? "insights failed"),
        },
      });
      if (viewsRes.ok) out.metricsUpdated++;
    }
  }

  await prisma.metaAsset.update({
    where: { id: asset.id },
    data: {
      lastPostSyncAt: new Date(),
      lastPostSyncStatus: out.rateLimited ? "rate_limited" : "ok",
      lastPostSyncError: null,
    },
  });
}

/**
 * Sync posts for every selected asset across all live connections.
 * Never throws; always returns a summary.
 */
export async function runMetaPostsSync(opts?: {
  connectionId?: string;
  assetId?: string;
  budgetMax?: number;
}): Promise<PostsSyncOutcome> {
  const out: PostsSyncOutcome = {
    assetsPolled: 0,
    postsUpserted: 0,
    metricsUpdated: 0,
    metricsPending: 0,
    callsUsed: 0,
    rateLimited: false,
    trimmed: 0,
    errors: [],
  };

  // ⚠️ DERIVED FROM THE ESTATE, with the FEED PASS as the floor.
  //
  // Phase 1 spends one call per asset and is what guarantees every channel has
  // visible data after a single run; phase 2 spends whatever is left on per-post
  // insights. A flat budget therefore fails in a specific way as the estate grows:
  // the feed pass eats it and insights get nothing. At 264 assets against the old
  // flat 400 the log read `assets=257 calls=400/400 metrics=136` — the feed pass
  // alone consumed most of it.
  //
  // So: one call per asset, plus a fixed insights allowance on top. Per-post
  // insights can never cover everything (the busiest Page publishes 1,200+ posts a
  // month), so that half stays a bounded rotation by design — but the feed pass
  // must always fit, because that is the part that must not degrade.
  const liveAssetCount = await prisma.metaAsset.count({
    where: { selected: true, disconnectedAt: null,
             connection: { revokedAt: null, status: { notIn: ["REVOKED"] } } },
  });
  const derivedPostsBudget = Math.max(
    metaTuning.postsCallBudget(),
    Math.ceil(liveAssetCount / FEED_RESERVE_SHARE) + POST_INSIGHTS_ALLOWANCE,
  );
  const budget = makeBudget(opts?.budgetMax ?? derivedPostsBudget);

  const connections = await prisma.metaConnection.findMany({
    where: {
      revokedAt: null,
      status: { in: ["ACTIVE", "PARTIAL_SCOPE", "NEEDS_REAUTH_SOON", "RATE_LIMITED"] },
      ...(opts?.connectionId ? { id: opts.connectionId } : {}),
    },
    select: { id: true, userTokenEnc: true },
  });

  // ⚠️ A Page two admins both administer exists once PER CONNECTION, so without
  // this it would be fed-and-measured twice out of one budget — and the budget
  // truncates silently, so the duplicate does not cost itself, it costs OTHER
  // channels their data. The channel sync has had this guard since it was
  // written; posts did not, which is the gap this closes.
  const duplicateAssetIds = await resolveDuplicateAssetIds();

  for (const conn of connections) {
    if (!conn.userTokenEnc) continue;
    let userToken: string;
    try {
      userToken = decryptToken(conn.userTokenEnc);
    } catch {
      out.errors.push(`connection ${conn.id}: token undecryptable — re-authorise`);
      continue;
    }

    const allAssets = await prisma.metaAsset.findMany({
      where: {
        connectionId: conn.id,
        selected: true,
        disconnectedAt: null,
        ...(opts?.assetId ? { id: opts.assetId } : {}),
      },
      // Least-recently-synced first, so coverage rotates instead of always
      // re-polling the same head of the list (the PR #130 starvation lesson).
      orderBy: [{ lastPostSyncAt: { sort: "asc", nulls: "first" } }],
      select: { id: true, kind: true, metaId: true, name: true, pageTokenEnc: true },
    });

    // Drop duplicates BEFORE the budget is apportioned — feedReserve is a share of
    // assets.length, so leaving them in would shrink every real channel's slice.
    const assets = duplicateAssetIds.size > 0
      ? allAssets.filter((a) => !duplicateAssetIds.has(a.id))
      : allAssets;

    // ── PHASE 1 — cheap feed pass across EVERY selected asset ───────────────
    //
    // ⚠️ THIS ORDERING IS LOAD-BEARING. Doing feed+insights per asset meant the
    // budget was exhausted by the first few assets and the remaining ~115 were
    // never polled at all, so most channels showed nothing after a run. One feed
    // call per asset is cheap (120 assets = 120 calls) and for Instagram it alone
    // yields like_count + comments_count inline — so every channel has visible
    // data after ONE run. Reserve a slice of the budget for it explicitly.
    const feedReserve = Math.min(assets.length, Math.floor(budget.max * FEED_RESERVE_SHARE));
    for (const asset of assets) {
      if (out.rateLimited) break;
      if (budget.used >= feedReserve) break;
      await syncAsset(asset as never, userToken, budget, out);
    }

    // ── PHASE 2 — spend whatever is left on per-post insights ────────────────
    //
    // ⚠️ INTERLEAVED BY PLATFORM, NOT SEQUENTIAL. Measured on the first real prod
    // run (120 assets, budget 400): iterating the flat list gave Facebook the ENTIRE
    // insights budget and Instagram got ZERO — FB assets sort first AND each FB post
    // costs TWO insights calls (views and engagement must be separate batches), so
    // 140 FB posts consumed all 280 remaining calls. Result: IG had 0 views/reach on
    // every run, permanently, which is the exact starvation shape PR #130 fixed for
    // the link sweep.
    //
    // Alternating platforms makes each one's share independent of the other's cost,
    // so neither can shut the other out however the list happens to be ordered.
    // ⚠️ ROTATION ACROSS RUNS. Phase 1 stamps lastPostSyncAt on EVERY asset, so
    // re-using that ordering here would hand insights to the same head of the list
    // on every run and the tail would never be measured. Instead, prioritise assets
    // that actually still have unmeasured posts (most pending first) — an asset drops
    // down the list as it gets measured, so coverage rotates on its own.
    let pendingByAsset = new Map<string, number>();
    try {
      const grouped = await prisma.metaPost.groupBy({
        by: ["assetId"],
        where: { assetId: { in: assets.map((a) => a.id) }, metricsStatus: "pending" },
        _count: { _all: true },
      });
      pendingByAsset = new Map(grouped.map((g) => [g.assetId, g._count._all]));
    } catch {
      /* prioritisation is an optimisation; a failure must not stop the run */
    }
    const byPendingDesc = (a: { id: string }, b: { id: string }) =>
      (pendingByAsset.get(b.id) ?? 0) - (pendingByAsset.get(a.id) ?? 0);

    const fbAssets = assets.filter((a) => a.kind === "FACEBOOK_PAGE").sort(byPendingDesc);
    const igAssets = assets.filter((a) => a.kind === "INSTAGRAM_ACCOUNT").sort(byPendingDesc);
    const interleaved: typeof assets = [];
    for (let i = 0; i < Math.max(fbAssets.length, igAssets.length); i++) {
      if (i < igAssets.length) interleaved.push(igAssets[i]);
      if (i < fbAssets.length) interleaved.push(fbAssets[i]);
    }

    for (const asset of interleaved) {
      if (out.rateLimited) break;
      if (budget.used >= budget.max) {
        out.metricsPending++;
        break;
      }
      await syncAssetInsights(asset as never, userToken, budget, out);
    }

    await prisma.metaConnection.update({
      where: { id: conn.id },
      data: { lastSyncedAt: new Date() },
    });
  }

  // Bounded retention trim — one deleteMany per run keeps meta_posts from becoming
  // another link_metrics (3.99M rows / 1266MB because it appended forever).
  try {
    const cutoff = new Date(Date.now() - metaTuning.postRetentionDays() * 86_400_000);
    const del = await prisma.metaPost.deleteMany({ where: { postedAt: { lt: cutoff } } });
    out.trimmed = del.count;
  } catch {
    /* trimming is housekeeping; never fail a run over it */
  }

  out.callsUsed = budget.used;
  console.log(
    `[meta-posts] assets=${out.assetsPolled} posts=${out.postsUpserted} ` +
      `metrics=${out.metricsUpdated} pending=${out.metricsPending} calls=${out.callsUsed}/${budget.max}` +
      (out.rateLimited ? " RATE_LIMITED" : "") +
      (out.trimmed ? ` trimmed=${out.trimmed}` : "") +
      (out.errors.length ? ` errors=${out.errors.length}` : ""),
  );
  return out;
}
