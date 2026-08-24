/**
 * CHANNEL-level metrics — the primary data Account Growth renders.
 *
 * This is deliberately separate from meta-posts.service.ts. That one fetches
 * individual posts; this one answers the question an admin actually asks:
 * "how is each Page / Instagram account performing?" — whole-account views,
 * engagement, reach and profile visits.
 *
 * Cost: ONE insights call per asset (metrics are batchable), so a 120-asset
 * estate is ~120 calls — cheap enough to refresh every run, unlike per-post
 * insights which cost one call per post.
 *
 * ⚠️ METRIC NAMES ARE VERSION-SENSITIVE AND THE DOCS LIE. All of the below was
 * live-probed on v21.0 (2026-08-24) against real Pages/accounts.
 *
 *   FACEBOOK — WORKS:  page_post_engagements, page_views_total, page_video_views,
 *                      page_actions_post_reactions_total, page_follows
 *              DEAD:   page_impressions, page_impressions_unique, page_fans,
 *                      page_fan_adds, page_fan_removes, page_content_activity,
 *                      page_posts_impressions   → all (#100)
 *
 *   INSTAGRAM — the API enumerates its own valid set when sent a bogus metric:
 *              reach, follower_count, website_clicks, profile_views,
 *              online_followers, accounts_engaged, total_interactions, likes,
 *              comments, shares, saves, replies, views, content_views, …
 *
 * ⚠️ A metric Meta does not publish stays NULL and renders as an em-dash. Never
 * coerce to 0 — that is the fabricated-zero class (the Snapchat showLikes bug),
 * where an absent number reads as a real result of zero.
 */

import { prisma } from "@dashmani/db";
import { oauthGraphFetch, makeBudget, type CallBudget } from "./oauth-graph";
import { decryptToken, scrubSecrets } from "../../utils/token-crypto";

/** 28-day window: long enough to be stable, short enough to reflect "now". */
const FB_PERIOD = "days_28";
/** IG account insights reject days_28 on several metrics; 28 daily points summed. */
const IG_PERIOD = "day";
const IG_WINDOW_DAYS = 28;

const FB_METRICS = [
  "page_video_views",
  "page_post_engagements",
  "page_views_total",
  "page_actions_post_reactions_total",
] as const;

/** Kept minimal and known-good; each extra metric risks 400-ing the whole call. */
const IG_METRICS = ["reach", "views", "profile_views", "total_interactions", "likes"] as const;

interface InsightsResponse {
  data?: Array<{ name?: string; values?: Array<{ value?: unknown }> }>;
}

export interface ChannelSyncOutcome {
  assetsUpdated: number;
  callsUsed: number;
  rateLimited: boolean;
  errors: string[];
}

/** Coerce to a non-negative integer, preserving "absent" as null. */
function intOrNull(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.max(0, Math.round(v));
}

/** Sum a reactions-by-type map ({like: 8938660, love: 157688} → total). */
function sumMap(v: unknown): number | null {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    let t = 0;
    let seen = false;
    for (const n of Object.values(v as Record<string, unknown>)) {
      if (typeof n === "number") { t += n; seen = true; }
    }
    return seen ? Math.round(t) : null;
  }
  return null;
}

/**
 * Reduce an insights series to ONE number.
 *
 * FB `days_28` returns a rolling total per day — the LAST point is the current
 * 28-day figure, so summing would multiply it ~28x. IG `day` returns genuine
 * per-day values, which must be SUMMED to get a 28-day total. Getting this
 * backwards silently inflates or deflates every number on the page.
 */
function reduceSeries(values: Array<{ value?: unknown }> | undefined, mode: "last" | "sum"): number | null {
  if (!values || values.length === 0) return null;
  if (mode === "last") {
    for (let i = values.length - 1; i >= 0; i--) {
      const v = values[i]?.value;
      const n = typeof v === "object" ? sumMap(v) : intOrNull(v);
      if (n !== null) return n;
    }
    return null;
  }
  let total = 0;
  let seen = false;
  for (const p of values) {
    const v = p?.value;
    const n = typeof v === "object" ? sumMap(v) : intOrNull(v);
    if (n !== null) { total += n; seen = true; }
  }
  return seen ? total : null;
}

function seriesFor(res: InsightsResponse | undefined, name: string) {
  return res?.data?.find((d) => d.name === name)?.values;
}

/**
 * Refresh channel-level metrics for every selected, connected asset.
 * Never throws; always returns a summary.
 */
export async function runMetaChannelSync(opts?: {
  assetId?: string;
  budgetMax?: number;
}): Promise<ChannelSyncOutcome> {
  const out: ChannelSyncOutcome = { assetsUpdated: 0, callsUsed: 0, rateLimited: false, errors: [] };

  const connections = await prisma.metaConnection.findMany({
    where: { revokedAt: null, status: { notIn: ["REVOKED"] } },
    select: { id: true, userTokenEnc: true },
  });

  const budget: CallBudget = makeBudget(opts?.budgetMax ?? 300);

  for (const conn of connections) {
    if (!conn.userTokenEnc) continue;
    let userToken: string;
    try {
      userToken = decryptToken(conn.userTokenEnc);
    } catch {
      out.errors.push(`connection ${conn.id}: token unreadable — re-authorise`);
      continue;
    }

    const assets = await prisma.metaAsset.findMany({
      where: {
        connectionId: conn.id,
        selected: true,
        disconnectedAt: null,
        ...(opts?.assetId ? { id: opts.assetId } : {}),
      },
      // Least-recently-refreshed first so coverage rotates if the budget runs out.
      orderBy: [{ metricsFetchedAt: { sort: "asc", nulls: "first" } }],
      select: { id: true, kind: true, metaId: true, name: true, pageTokenEnc: true },
    });

    for (const asset of assets) {
      if (out.rateLimited || budget.used >= budget.max) break;
      const isIg = asset.kind === "INSTAGRAM_ACCOUNT";

      let token = userToken;
      if (!isIg) {
        if (!asset.pageTokenEnc) {
          out.errors.push(`${asset.name}: no page token`);
          continue;
        }
        try {
          token = decryptToken(asset.pageTokenEnc);
        } catch {
          out.errors.push(`${asset.name}: page token unreadable`);
          continue;
        }
      }

      const since = Math.floor((Date.now() - IG_WINDOW_DAYS * 86_400_000) / 1000);
      const res = await oauthGraphFetch<InsightsResponse>(
        `${asset.metaId}/insights`,
        isIg
          ? { metric: IG_METRICS.join(","), period: IG_PERIOD, since, until: Math.floor(Date.now() / 1000) }
          : { metric: FB_METRICS.join(","), period: FB_PERIOD },
        token,
        { label: isIg ? "channel-ig-insights" : "channel-fb-insights", budget },
      );

      if (res.rateLimited) { out.rateLimited = true; break; }

      if (!res.ok) {
        await prisma.metaAsset.update({
          where: { id: asset.id },
          data: {
            metricsFetchedAt: new Date(),
            metricsError: scrubSecrets(res.error ?? "channel insights failed"),
          },
        });
        out.errors.push(`${asset.name}: ${res.error ?? "insights failed"}`);
        continue;
      }

      // FB days_28 is a rolling total (take the LAST point); IG day is per-day (SUM).
      const mode = isIg ? "sum" : ("last" as const);
      const d = res.data;

      await prisma.metaAsset.update({
        where: { id: asset.id },
        data: isIg
          ? {
              views28d: bigintOrNull(reduceSeries(seriesFor(d, "views"), mode)),
              reach28d: bigintOrNull(reduceSeries(seriesFor(d, "reach"), mode)),
              engagements28d: bigintOrNull(reduceSeries(seriesFor(d, "total_interactions"), mode)),
              profileViews28d: bigintOrNull(reduceSeries(seriesFor(d, "profile_views"), mode)),
              reactions28d: bigintOrNull(reduceSeries(seriesFor(d, "likes"), mode)),
              metricsFetchedAt: new Date(),
              metricsError: null,
            }
          : {
              views28d: bigintOrNull(reduceSeries(seriesFor(d, "page_video_views"), "last")),
              engagements28d: bigintOrNull(reduceSeries(seriesFor(d, "page_post_engagements"), "last")),
              profileViews28d: bigintOrNull(reduceSeries(seriesFor(d, "page_views_total"), "last")),
              // FB publishes no whole-page unique reach — deliberately left NULL
              // rather than substituting impressions, which would be a different fact.
              reach28d: null,
              reactions28d: bigintOrNull(
                reduceSeries(seriesFor(d, "page_actions_post_reactions_total"), "last"),
              ),
              metricsFetchedAt: new Date(),
              metricsError: null,
            },
      });
      out.assetsUpdated++;
    }
  }

  out.callsUsed = budget.used;
  console.log(
    `[meta-channels] assets=${out.assetsUpdated} calls=${out.callsUsed}/${budget.max}` +
      (out.rateLimited ? " RATE_LIMITED" : "") +
      (out.errors.length ? ` errors=${out.errors.length}` : ""),
  );
  return out;
}

function bigintOrNull(n: number | null): bigint | null {
  return n === null ? null : BigInt(n);
}
