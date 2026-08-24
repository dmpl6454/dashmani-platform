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
const IG_PERIOD = "day";
const IG_WINDOW_DAYS = 28;

const FB_METRICS = [
  "page_video_views",
  "page_post_engagements",
  "page_views_total",
  "page_actions_post_reactions_total",
  // Authoritative follower count, and it rides along in the SAME batched call —
  // so keeping followers truthful costs zero extra requests.
  "page_follows",
] as const;

/**
 * IG account metrics — ALL fetched with `metric_type=total_value`.
 *
 * ⚠️ TWO BUGS LIVE HERE, both found only by running it against real accounts:
 *
 * 1. Without `metric_type=total_value` Meta rejects the whole call:
 *      (#100) The following metrics (views,profile_views,total_interactions,likes)
 *      should be specified with parameter metric_type=total_value
 *    That failed all 48 Instagram accounts on the first run.
 *
 * 2. ⚠️⚠️ `reach` MUST come from total_value too — it must NOT be summed from a
 *    daily series. Reach counts UNIQUE people, so adding up 28 daily values
 *    double-counts anyone who visited on more than one day. Measured on one real
 *    account: summing daily reach gave 10,187,906 while the true 28-day figure is
 *    6,509,641 — a 56% overstatement that would have looked entirely plausible.
 *    Never reintroduce a sum over a unique-user metric.
 */
const IG_METRICS = [
  "reach",
  "views",
  "profile_views",
  "total_interactions",
  "likes",
] as const;

interface InsightsResponse {
  data?: Array<{
    name?: string;
    /** FB (and IG time-series) shape. */
    values?: Array<{ value?: unknown }>;
    /** IG `metric_type=total_value` shape — a single pre-aggregated figure. */
    total_value?: { value?: unknown };
  }>;
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
 * Reduce an insights series to ONE number. FACEBOOK ONLY — Instagram uses
 * `metric_type=total_value` and never comes through here.
 *
 * ⚠️ FB `days_28` returns a ROLLING 28-DAY TOTAL stamped once per day, so the
 * correct answer is the LAST point. Summing the series would multiply the real
 * figure by ~28 and every headline number on the page would be nonsense.
 *
 * The "sum" mode is retained for a genuine per-day series, but note it must NEVER
 * be applied to a unique-user metric such as reach: adding daily uniques
 * double-counts repeat visitors (measured 10,187,906 summed vs a true 6,509,641).
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
      select: {
        id: true, kind: true, metaId: true, name: true, pageTokenEnc: true,
        socialAccountId: true, followerCount: true,
      },
    });

    for (const asset of assets) {
      if (out.rateLimited || budget.used >= budget.max) break;
      const isIg = asset.kind === "INSTAGRAM_ACCOUNT";
      const assetSocialAccountId = asset.socialAccountId;
      const assetFollowerCount = asset.followerCount;

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
          ? {
              metric: IG_METRICS.join(","),
              // Required, and also the ONLY correct source for reach — see IG_METRICS.
              metric_type: "total_value",
              period: IG_PERIOD,
              since,
              until: Math.floor(Date.now() / 1000),
            }
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

      const d = res.data;
      /** IG total_value: one pre-aggregated number per metric. */
      const igTotal = (name: string): number | null => {
        const row = d?.data?.find((x) => x.name === name);
        return intOrNull(row?.total_value?.value);
      };

      await prisma.metaAsset.update({
        where: { id: asset.id },
        data: isIg
          ? {
              views28d: bigintOrNull(igTotal("views")),
              reach28d: bigintOrNull(igTotal("reach")),
              engagements28d: bigintOrNull(igTotal("total_interactions")),
              profileViews28d: bigintOrNull(igTotal("profile_views")),
              reactions28d: bigintOrNull(igTotal("likes")),
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
      // ── Write the AUTHORITATIVE follower count back to the channel registry ──
      //
      // ⚠️ WHY THIS EXISTS. Account Growth was rendering STALE SCRAPED follower
      // counts for channels we are connected to and have exact API figures for.
      // Measured on prod 2026-08-24: MRP Reels showed 3,618,496 against a true
      // 1,078,045 (3.4x too high), C4B Reels showed 4 against 183,485, and
      // Bollywood Society showed a suspiciously round 14,000,000 against
      // 14,677,412. The row was correctly included as a connected channel, but the
      // NUMBER still came from the old scraper.
      //
      // The connected asset is the single source of truth, so it wins.
      const freshFollowers = isIg
        ? null // IG followers come from discovery's profile read, not the insights edge
        : intOrNull(reduceSeries(seriesFor(d, "page_follows"), "last"));

      if (freshFollowers !== null && freshFollowers > 0) {
        await prisma.metaAsset.update({
          where: { id: asset.id },
          data: { followerCount: freshFollowers },
        });
      }

      // Push it onto the linked SocialAccount so the page (and the accounts list)
      // stop showing scraper values for channels we can measure exactly.
      // ⚠️ Guarded on > 0 — never overwrite a real number with a zero. A 0 here is
      // far more likely to be an API quirk than a Page genuinely losing every
      // follower, and the existing follower-sync applies the same rule.
      const authoritative = freshFollowers ?? assetFollowerCount;
      if (assetSocialAccountId && authoritative !== null && authoritative > 0) {
        await prisma.socialAccount.update({
          where: { id: assetSocialAccountId },
          data: {
            followerCount: authoritative,
            syncSource: "api",
            lastSyncedAt: new Date(),
          },
        });
      }

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
