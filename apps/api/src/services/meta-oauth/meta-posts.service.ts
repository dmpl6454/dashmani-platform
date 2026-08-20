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
 * Live-probed on v21.0: IG `impressions` is DEPRECATED (v22+) and FB `post_impressions`
 * / `post_views` / `post_engaged_users` DO NOT EXIST. The live equivalents are IG
 * `views` and FB `post_video_views`. Never re-add the dead names.
 *
 * ⚠️ A metric Meta does not publish is stored as NULL and rendered as an em-dash.
 * NEVER coerce to 0 — that is the fabricated-zero bug class from the Snapchat
 * showLikes incident, where an absent metric read as "this post got no likes".
 */

import { prisma } from "@dashmani/db";
import { oauthGraphFetch, makeBudget, type CallBudget } from "./oauth-graph";
import { decryptToken, scrubSecrets } from "../../utils/token-crypto";
import { metaTuning } from "./meta-config";

/** One page per asset per run. Forward posts are always page 1; following paging.next
 *  in a cron is what made an earlier feed build take ~20 min and starve everything. */
const FEED_LIMIT = 25;

/** IG per-post insight metrics, in one batched call. */
const IG_METRICS = ["reach", "views", "saved", "total_interactions", "shares"] as const;

/**
 * FB insights in TWO batches — never merged.
 * One post type's invalid metric 400s the WHOLE call, so views are asked for
 * separately from engagement.
 */
const FB_METRICS_VIEWS = ["post_video_views"] as const;
const FB_METRICS_ENGAGEMENT = [
  "post_reactions_by_type_total",
  "post_activity_by_action_type",
] as const;

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

interface FbPostsResponse {
  data?: Array<{
    id?: string;
    message?: string;
    permalink_url?: string;
    created_time?: string;
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

/** Sum a reactions-by-type map ({like: 3, love: 1} → 4). Absent ⇒ null, not 0. */
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
async function syncAsset(
  asset: {
    id: string;
    kind: "FACEBOOK_PAGE" | "INSTAGRAM_ACCOUNT";
    metaId: string;
    name: string;
    pageTokenEnc: string | null;
  },
  userToken: string,
  budget: CallBudget,
  out: PostsSyncOutcome,
): Promise<void> {
  const isIg = asset.kind === "INSTAGRAM_ACCOUNT";

  // IG reads with the USER token (every existing IG path in this repo does);
  // FB reads with the Page token, which arrived inline at discovery.
  let token = userToken;
  if (!isIg) {
    if (!asset.pageTokenEnc) {
      out.errors.push(`${asset.name}: no page token (re-run discovery)`);
      return;
    }
    try {
      token = decryptToken(asset.pageTokenEnc);
    } catch (e) {
      out.errors.push(`${asset.name}: page token undecryptable — re-authorise`);
      await prisma.metaAsset.update({
        where: { id: asset.id },
        data: { lastPostSyncStatus: "error", lastPostSyncError: scrubSecrets(String(e)) },
      });
      return;
    }
  }

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
        { fields: "id,message,permalink_url,created_time", limit: FEED_LIMIT },
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
      // IG hands us likes+comments for free. FB does not on this edge, so they stay
      // null until the insights pass fills them (or stay null honestly).
      likes: isIg ? numOrNull(r.like_count) : undefined,
      comments: isIg ? numOrNull(r.comments_count) : undefined,
    };

    await prisma.metaPost.upsert({
      where: { assetId_metaPostId: { assetId: asset.id, metaPostId } },
      create: { assetId: asset.id, metaPostId, ...base },
      // Never reset metricsStatus here — the insights pass owns it.
      update: base,
    });
    out.postsUpserted++;
  }

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
    // Pending first, then newest — so a post never sits permanently unmeasured
    // just because it fell outside one run's slice.
    orderBy: [{ metricsStatus: "asc" }, { postedAt: "desc" }],
    take: 25,
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
      // FB: two batches, never merged.
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
      if (budget.used >= budget.max) {
        out.metricsPending++;
        break;
      }
      const engRes = await oauthGraphFetch<InsightsResponse>(
        `${post.metaPostId}/insights`,
        { metric: FB_METRICS_ENGAGEMENT.join(",") },
        token,
        { label: "posts-fb-insights-engagement", budget },
      );
      if (engRes.rateLimited) {
        out.rateLimited = true;
        break;
      }

      const vm = insightMap(viewsRes.data);
      const em = insightMap(engRes.data);
      const activity = em.get("post_activity_by_action_type");
      const anyOk = viewsRes.ok || engRes.ok;

      await prisma.metaPost.update({
        where: { id: post.id },
        data: {
          views: numOrNull(vm.get("post_video_views")),
          likes:
            sumReactions(em.get("post_reactions_by_type_total")) ?? activityKey(activity, "like"),
          comments: activityKey(activity, "comment"),
          shares: activityKey(activity, "share"),
          metricsStatus: anyOk ? (viewsRes.ok && engRes.ok ? "ok" : "partial") : "unavailable",
          metricsFetchedAt: new Date(),
          metricsError: anyOk ? null : scrubSecrets(engRes.error ?? viewsRes.error ?? "insights failed"),
        },
      });
      if (anyOk) out.metricsUpdated++;
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

  const budget = makeBudget(opts?.budgetMax ?? metaTuning.postsCallBudget());

  const connections = await prisma.metaConnection.findMany({
    where: {
      revokedAt: null,
      status: { in: ["ACTIVE", "PARTIAL_SCOPE", "NEEDS_REAUTH_SOON", "RATE_LIMITED"] },
      ...(opts?.connectionId ? { id: opts.connectionId } : {}),
    },
    select: { id: true, userTokenEnc: true },
  });

  for (const conn of connections) {
    if (!conn.userTokenEnc) continue;
    let userToken: string;
    try {
      userToken = decryptToken(conn.userTokenEnc);
    } catch {
      out.errors.push(`connection ${conn.id}: token undecryptable — re-authorise`);
      continue;
    }

    const assets = await prisma.metaAsset.findMany({
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

    for (const asset of assets) {
      if (budget.used >= budget.max || out.rateLimited) break;
      await syncAsset(asset as never, userToken, budget, out);
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
