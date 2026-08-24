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
 *   FACEBOOK — WORKS:  page_media_view, page_total_media_view_unique,
 *                      page_post_engagements, page_views_total, page_follows,
 *                      page_actions_post_reactions_total, page_daily_follows_unique
 *              DEAD:   page_impressions, page_impressions_unique, page_reach,
 *                      page_organic_reach, page_fans, page_engaged_users,
 *                      page_posts_impressions, page_content_activity  → all (#100)
 *
 * ⚠️ META RETIRED "IMPRESSIONS" AND "REACH" PLATFORM-WIDE — they were not
 * restricted, they were REPLACED. Impressions metrics were deprecated from
 * 2025-11-15 and the remaining Page Insights reach metrics from 2026-06-15, on
 * EVERY API version (v21 and v23 were probed side by side and behave
 * identically, so pinning a newer version buys nothing). The successors:
 *
 *      page_impressions        →  page_media_view              (views)
 *      page_impressions_unique →  page_total_media_view_unique (reach)
 *
 * Both were live-probed across six real Pages on 2026-08-24: present on all six,
 * zero errors. This is why "Facebook publishes no whole-Page reach" — which this
 * file used to assert — was wrong: the metric exists, under a new name.
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
import { todayIST, istMidnight } from "@dashmani/shared";
import { oauthGraphFetch, makeBudget, type CallBudget } from "./oauth-graph";
import { decryptToken, scrubSecrets } from "../../utils/token-crypto";

/**
 * The windows the page can offer — dictated by Meta, not by us.
 *
 * ⚠️ Live-probed 2026-08-24. Facebook `period` accepts day | week | days_28 |
 * month (no 90-day period; `lifetime` returns 0/undefined for these metrics).
 * Instagram takes an arbitrary since/until but hard-fails past 30 days:
 *   (#100) There cannot be more than 30 days (2592000 s) between since and until.
 *
 * day / week / days_28 is the intersection — the only set BOTH platforms answer
 * natively. ⚠️ A longer window CANNOT be assembled from shorter ones: reach counts
 * UNIQUE people, so adding two 28-day reaches double-counts everyone in both.
 * Views and engagements would tolerate it; reach would silently inflate, which is
 * exactly the trap that produced a 56% overstatement when daily reach was summed.
 */
export const CHANNEL_WINDOWS = ["day", "week", "days_28"] as const;
export type ChannelWindow = (typeof CHANNEL_WINDOWS)[number];

/** IG equivalent of each Facebook period, as a since/until span in days. */
const IG_WINDOW_DAYS: Record<ChannelWindow, number> = { day: 1, week: 7, days_28: 28 };

/** The window whose figures also populate the legacy meta_assets.*_28d columns. */
const DEFAULT_WINDOW: ChannelWindow = "days_28";
const IG_PERIOD = "day";

const FB_METRICS = [
  // ⚠️ page_media_view, NOT page_video_views. The latter counts VIDEO plays only,
  // so it under-reports every Page by ~2-3x once photos and links are included
  // (measured: Bollywood Society 1,395,695,382 vs 501,540,051). It is also the
  // pre-deprecation metric; page_media_view is Meta's designated successor.
  "page_media_view",
  // Reach. Successor to the retired page_impressions_unique.
  "page_total_media_view_unique",
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

  // 3 windows x ~120 assets = ~360. Was 300, which is enough for one window only
  // and would have silently truncated the third window on most of the estate.
  const budget: CallBudget = makeBudget(opts?.budgetMax ?? 500);

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

      // ── One insights call PER WINDOW ────────────────────────────────────
      //
      // Three calls per asset rather than one. Meta accepts only a single
      // `period` per request and offers no way to batch them, so a window
      // selector genuinely costs 3x — ~360 calls across 120 assets, which the
      // budget covers. The alternative (fetch a daily series and aggregate) is
      // not open to us: it would work for views and engagements and quietly
      // corrupt reach.
      let sawRateLimit = false;
      let defaultWindowData: InsightsResponse | undefined;
      let defaultWindowOk = false;

      for (const win of CHANNEL_WINDOWS) {
        if (budget.used >= budget.max) break;

        // ⚠️ INSTAGRAM WINDOWS MUST END AT A UTC DAY BOUNDARY, NOT AT "NOW".
        //
        // IG's total_value buckets by whole UTC day, so a range ending mid-day
        // returns only the fraction of today that has been tallied — and it looks
        // like a real answer. Measured 2026-08-24 07:14 UTC on Paparazzi:
        //
        //   since=now-24h, until=now       ->    314 views   (WRONG: today so far)
        //   last COMPLETE UTC day          -> 809,371 views  (right)
        //   7 days (reference)             -> 6,670,450
        //
        // Shipping the first form would have put "7 views" next to a channel doing
        // 6.6m a week. Ending on the last completed day also matches Facebook,
        // whose series already stops at a closed boundary (probed: the newest point
        // is end_time 2026-08-23T07:00:00Z, never a partial today), so the two
        // platforms describe the same span instead of silently differing by a day.
        const untilTs = Math.floor(Date.now() / 86_400_000) * 86_400;
        const sinceTs = untilTs - IG_WINDOW_DAYS[win] * 86_400;

        const res = await oauthGraphFetch<InsightsResponse>(
          `${asset.metaId}/insights`,
          isIg
            ? {
                metric: IG_METRICS.join(","),
                // Required, and also the ONLY correct source for reach — see IG_METRICS.
                metric_type: "total_value",
                period: IG_PERIOD,
                since: sinceTs,
                until: untilTs,
              }
            : { metric: FB_METRICS.join(","), period: win },
          token,
          { label: isIg ? `channel-ig-insights-${win}` : `channel-fb-insights-${win}`, budget },
        );

        if (res.rateLimited) { sawRateLimit = true; break; }

        if (!res.ok) {
          await upsertWindowMetric(asset.id, win, null, scrubSecrets(res.error ?? "channel insights failed"));
          if (win === DEFAULT_WINDOW) out.errors.push(`${asset.name}: ${res.error ?? "insights failed"}`);
          continue;
        }

        await upsertWindowMetric(asset.id, win, readMetrics(res.data, isIg), null);
        if (win === DEFAULT_WINDOW) { defaultWindowData = res.data; defaultWindowOk = true; }
      }

      if (sawRateLimit) { out.rateLimited = true; break; }

      // Mirror the default window onto the legacy meta_assets.*_28d columns so
      // every existing reader keeps working unchanged.
      if (!defaultWindowOk) {
        await prisma.metaAsset.update({
          where: { id: asset.id },
          data: { metricsFetchedAt: new Date(), metricsError: "channel insights failed" },
        });
        continue;
      }

      const d = defaultWindowData;
      const m = readMetrics(d, isIg);
      await prisma.metaAsset.update({
        where: { id: asset.id },
        data: {
          views28d: bigintOrNull(m.views),
          reach28d: bigintOrNull(m.reach),
          engagements28d: bigintOrNull(m.engagements),
          profileViews28d: bigintOrNull(m.profileViews),
          reactions28d: bigintOrNull(m.reactions),
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
        await writeApiSnapshot(assetSocialAccountId, authoritative);
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

interface ChannelMetrics {
  views: number | null;
  reach: number | null;
  engagements: number | null;
  profileViews: number | null;
  reactions: number | null;
}

/**
 * Map one /insights response to our five channel figures.
 *
 * The two platforms answer in different SHAPES, not just under different names:
 * Instagram returns a single pre-aggregated `total_value` per metric, Facebook a
 * series that must be reduced with "last" (its days_28/week/day values are each a
 * ROLLING TOTAL stamped per day — summing them multiplies the truth).
 */
function readMetrics(d: InsightsResponse | undefined, isIg: boolean): ChannelMetrics {
  if (isIg) {
    const total = (name: string): number | null =>
      intOrNull(d?.data?.find((x) => x.name === name)?.total_value?.value);
    return {
      views: total("views"),
      reach: total("reach"),
      engagements: total("total_interactions"),
      profileViews: total("profile_views"),
      reactions: total("likes"),
    };
  }
  return {
    views: reduceSeries(seriesFor(d, "page_media_view"), "last"),
    reach: reduceSeries(seriesFor(d, "page_total_media_view_unique"), "last"),
    engagements: reduceSeries(seriesFor(d, "page_post_engagements"), "last"),
    profileViews: reduceSeries(seriesFor(d, "page_views_total"), "last"),
    reactions: reduceSeries(seriesFor(d, "page_actions_post_reactions_total"), "last"),
  };
}

/**
 * Store one window's figures. Upsert on (assetId, window) — latest state, never
 * an append. A failed window records its error and keeps whatever it last held,
 * so one bad window cannot blank a channel that the other two measured fine.
 */
async function upsertWindowMetric(
  assetId: string,
  window: ChannelWindow,
  m: ChannelMetrics | null,
  error: string | null,
): Promise<void> {
  const data = m
    ? {
        views: bigintOrNull(m.views),
        reach: bigintOrNull(m.reach),
        engagements: bigintOrNull(m.engagements),
        profileViews: bigintOrNull(m.profileViews),
        reactions: bigintOrNull(m.reactions),
        fetchedAt: new Date(),
        error: null,
      }
    : { fetchedAt: new Date(), error };
  try {
    await prisma.metaAssetMetric.upsert({
      where: { assetId_window: { assetId, window } },
      create: { assetId, window, ...data },
      update: data,
    });
  } catch (e) {
    console.warn(`[meta-channels] window write failed ${assetId}/${window}: ${scrubSecrets(String(e))}`);
  }
}

/**
 * Record today's API follower count in the growth series.
 *
 * ⚠️ WITHOUT THIS, ACCOUNT GROWTH SILENTLY FREEZES FOR EVERY META CHANNEL.
 * The hourly scraper used to be the only writer of account_growth_snapshots.
 * Once Meta scraping was switched off, nothing wrote them — so Net Change, the
 * baseline ("was X · 30d ago") and Top Movers would have kept comparing today
 * against a history that stopped advancing, drifting further from reality every
 * day while looking perfectly healthy.
 *
 * It also repairs a live wrong number. The channel sync corrects
 * social_accounts.follower_count from the API but used to leave the snapshot
 * holding the old scraped figure, so the two disagreed and every delta was
 * measured across that seam. Measured on prod 2026-08-24: Bollywood Society sat
 * at 14,000,000 in the series against a true 14,781,280, and the page reported
 * that 781,280-follower bookkeeping gap as "+781.3k growth" in Top Movers.
 *
 * `source: "api"` is written so a later reader can tell a measured point from a
 * scraped one. The column existed but no writer ever populated it.
 *
 * Idempotent: upsert on (accountId, date) at IST midnight, matching
 * follower-sync and account-growth so repeated runs converge on one row per day
 * rather than fighting each other. Never throws — a growth-history write must
 * not be able to fail a metrics run.
 */
async function writeApiSnapshot(accountId: string, followers: number): Promise<void> {
  if (followers <= 0) return;
  const date = istMidnight(todayIST());
  try {
    await prisma.accountGrowthSnapshot.upsert({
      where: { accountId_date: { accountId, date } },
      create: { accountId, date, followerCount: followers, source: "api" },
      update: { followerCount: followers, source: "api" },
    });
  } catch (e) {
    console.warn(`[meta-channels] snapshot write failed for ${accountId}: ${scrubSecrets(String(e))}`);
  }
}
