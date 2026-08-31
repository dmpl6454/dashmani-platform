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
import { oauthGraphFetch, makeBudget, isTransientGraphFailure, type CallBudget } from "./oauth-graph";
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
  // Churn behind the net follower number, and watch time. All three verified on
  // 72/72 Pages, so they batch safely — but see the (#2) note on earnings for why
  // "it worked on one Page" is never enough to justify adding a metric here.
  "page_daily_follows_unique",
  "page_daily_unfollows_unique",
  "page_video_view_time",
  // Authoritative follower count, and it rides along in the SAME batched call —
  // so keeping followers truthful costs zero extra requests.
  "page_follows",
] as const;

/**
 * Approximate earnings — the same figure the Meta app labels "Approximate
 * earnings".
 *
 * ⚠️⚠️ MUST BE FETCHED IN ITS OWN CALL. MONETIZATION METRICS CANNOT BE MIXED
 * WITH REGULAR PAGE INSIGHTS. Probed exhaustively on a real Page 2026-08-24:
 *
 *   monetization_approximate_earnings                      OK
 *   monetization_approximate_earnings + content_monetization_earnings  OK
 *   monetization_approximate_earnings + page_media_view    (#2) unexpected error
 *   the full regular batch                                 OK
 *   the full regular batch + earnings                      (#2) unexpected error
 *
 * A single regular metric alongside it is enough to fail the request, and the
 * error is the generic "(#2) An unexpected error has occurred. Please retry your
 * request later." — which reads like a transient blip and is not. An earlier
 * revision batched them and retried without earnings on failure; the retry fired
 * on EVERY Facebook call (216 wasted requests a run) and earnings came back empty
 * on all 216 rows while looking like it had merely "not been reported yet".
 *
 * ⚠️ FACEBOOK ONLY. Instagram's insights enumeration rejects both monetization
 * metric names outright — there is no IG earnings figure to fetch.
 */
const FB_EARNINGS_METRIC = "monetization_approximate_earnings";

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
  // Saves and shares are the strongest reach-intent signals Instagram publishes
  // and neither has a Facebook page-level equivalent. accounts_engaged is the
  // unique-people counterpart to total_interactions. Verified on 48/48 accounts.
  "saves",
  "shares",
  "accounts_engaged",
] as const;

/**
 * Instagram's follower change for a period — the only route Meta offers.
 *
 * ⚠️ INSTAGRAM PUBLISHES NO TOTAL-FOLLOWERS-OVER-TIME METRIC AT ALL. Facebook's
 * `page_follows` returns the true daily total; Instagram's nearest equivalent,
 * `follower_count`, is DAILY GROSS NEW FOLLOWS — never negative (0 of 348 daily
 * points across 12 accounts), capped to "the last 30 days" with no walking back,
 * and blind to unfollows. Reconstructing totals by subtracting it is not merely
 * imprecise, it gets the DIRECTION wrong: on an 18-day window it disagreed in
 * sign with the real change on 5 of 8 accounts.
 *
 * `follows_and_unfollows` closes it. Its `follow_type` breakdown returns
 * FOLLOWER and NON_FOLLOWER, and those are follows and UNFOLLOWS — proven by the
 * fact that over the same 14 days the FOLLOWER bucket (6,554) equals
 * `follower_count` summed (6,554) exactly. So net = follows − unfollows.
 *
 * ⚠️ An earlier note in this repo claimed this metric was unusable because a
 * negative net "implied Paparazzi lost followers while it was growing". Paparazzi
 * was NOT growing — its own snapshots fell 7,178,021 → 7,164,810 over the same
 * period. The metric was right and the reasoning was wrong.
 *
 * Verified against real snapshots on 12 accounts: the SIGN is correct on every
 * one, and the residual is under ~1% of follower count (the per-change percentage
 * looks larger only where the change itself is tiny). 44/44 accounts answer.
 *
 * ⚠️ Meta refuses the breakdown for a 1-day span ("missing buckets"), so the 24h
 * window has no Instagram delta and must render as a dash rather than a zero.
 * ⚠️ Hard 30-day cap per request (31 days errors), though unlike `follower_count`
 * older 30-day windows ARE walkable if longer history is ever wanted.
 */
async function fetchIgNetFollowerChange(
  igId: string,
  token: string,
  sinceTs: number,
  untilTs: number,
  budget: CallBudget,
): Promise<{ net: number; follows: number; unfollows: number } | null> {
  const res = await oauthGraphFetch<{
    data?: Array<{ total_value?: { breakdowns?: Array<{ results?: Array<{ dimension_values?: string[]; value?: unknown }> }> } }>;
  }>(
    `${igId}/insights`,
    {
      metric: "follows_and_unfollows",
      metric_type: "total_value",
      breakdown: "follow_type",
      period: "day",
      since: sinceTs,
      until: untilTs,
    },
    token,
    { label: "channel-ig-follower-delta", budget },
  );
  if (!res.ok || !res.data) return null;
  const results = res.data.data?.[0]?.total_value?.breakdowns?.[0]?.results ?? [];
  const pick = (key: string): number | null => {
    const v = results.find((r) => r.dimension_values?.[0] === key)?.value;
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  const follows = pick("FOLLOWER");
  const unfollows = pick("NON_FOLLOWER");
  // Both buckets or nothing — half an answer would be a fabricated number.
  if (follows === null || unfollows === null) return null;
  // The gross halves are returned too: they arrive in this same response, so
  // surfacing the churn behind the net change costs nothing.
  return { net: Math.round(follows - unfollows), follows: Math.round(follows), unfollows: Math.round(unfollows) };
}

interface InsightsResponse {
  data?: Array<{
    name?: string;
    /** FB (and IG time-series) shape. */
    values?: Array<{ value?: unknown; end_time?: string }>;
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
/**
 * Pause before the single retry of a transient Graph failure.
 *
 * ⚠️ WHAT IS PROVEN AND WHAT IS NOT. The live probe (see isTransientGraphFailure)
 * proved the failure is TIME-VARYING: 26 of 26 failed calls succeeded on an
 * identical replay. It did NOT prove that a retry milliseconds later recovers —
 * 48 consecutive probe calls on healthy Pages produced zero failures, so there
 * was nothing to retry against. A short pause is therefore cheap insurance
 * rather than a measured requirement: if the blip is a per-request backend
 * hiccup an immediate retry would have worked anyway, and if it is a brief
 * server-side condition this is what makes the retry land after it.
 *
 * Cost is bounded and trivial — ~26 failures a run at 400ms is ~10s added to a
 * multi-minute job, and the budget check still gates the retry itself.
 */
const RETRY_DELAY_MS = 400;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/**
 * Last published earnings value, in cents. Decimal-preserving by design — see the
 * call site. Returns null when Meta published nothing.
 */
function readEarningsCents(res: InsightsResponse | undefined): number | null {
  const values = res?.data?.find((d) => d.name === FB_EARNINGS_METRIC)?.values;
  if (!values || values.length === 0) return null;
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i]?.value;
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.round(v * 100);
  }
  return null;
}

/**
 * The end of the period Meta published, from its own `end_time` stamp.
 * Facebook only. Instagram is asked for an explicit since/until, so the caller
 * already knows its boundary.
 */
function readPeriodEnd(res: InsightsResponse | undefined): Date | null {
  for (const d of res?.data ?? []) {
    const vals = d.values ?? [];
    const et = (vals[vals.length - 1] as { end_time?: string } | undefined)?.end_time;
    if (typeof et === "string") {
      const parsed = new Date(et);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
  }
  return null;
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

  // ⚠️ THE BUDGET IS DERIVED FROM THE ESTATE, NEVER HARDCODED.
  //
  // It used to be a flat 780, sized empirically when the estate was 120 assets
  // (~672 calls). An admin then connected with 264 and every run logged
  // `assets=132 calls=780/780` — exactly half the channels polled, the rest left
  // to the next run. Rotation meant nothing was permanently lost, but freshness
  // silently halved and nothing said so. A constant tuned to today's data becomes
  // a ceiling the moment the data grows.
  //
  // Exact cost per asset, from the call sites below:
  //   Facebook  3 windows x (1 regular + 1 earnings)              = 6
  //   Instagram 3 windows x 1 regular, + follower-change on 7d/28d = 5
  const [fbCount, igCount] = await Promise.all([
    prisma.metaAsset.count({
      where: { kind: "FACEBOOK_PAGE", selected: true, disconnectedAt: null,
               connection: { revokedAt: null, status: { notIn: ["REVOKED"] } } },
    }),
    prisma.metaAsset.count({
      where: { kind: "INSTAGRAM_ACCOUNT", selected: true, disconnectedAt: null,
               connection: { revokedAt: null, status: { notIn: ["REVOKED"] } } },
    }),
  ]);
  // +10% so a retry or a newly discovered channel does not push the last asset off
  // the end, and a floor so a tiny/empty estate still has room to work.
  const derivedBudget = Math.max(200, Math.ceil((fbCount * 6 + igCount * 5) * 1.1));
  const budget: CallBudget = makeBudget(opts?.budgetMax ?? derivedBudget);
  console.log(
    `[meta-channels] estate fb=${fbCount} ig=${igCount} -> budget ${budget.max}` +
      (opts?.budgetMax ? " (overridden)" : ""),
  );
  const contestedOwners = await resolveContestedOwners();
  // Never poll the same Meta object twice because two admins both administer it.
  const duplicateAssetIds = await resolveDuplicateAssetIds();

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
      if (duplicateAssetIds.has(asset.id)) continue;
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

        const insightsParams = isIg
          ? {
              metric: IG_METRICS.join(","),
              // Required, and also the ONLY correct source for reach — see IG_METRICS.
              metric_type: "total_value",
              period: IG_PERIOD,
              since: sinceTs,
              until: untilTs,
            }
          : { metric: FB_METRICS.join(","), period: win };
        const insightsLabel = isIg ? `channel-ig-insights-${win}` : `channel-fb-insights-${win}`;

        let res = await oauthGraphFetch<InsightsResponse>(
          `${asset.metaId}/insights`, insightsParams, token, { label: insightsLabel, budget },
        );
        // ONE bounded retry, transient (#1/#2) failures only. ~1% of calls per
        // run fail with Meta's "retry your request later" — without this, each
        // one stamps a visible error on a window whose figures are fine, for up
        // to 3h until the next sync. The +10% budget headroom exists for exactly
        // this. Deterministic failures (permissions, 2FA) are NOT retried.
        if (isTransientGraphFailure(res) && budget.used < budget.max) {
          await sleep(RETRY_DELAY_MS);
          res = await oauthGraphFetch<InsightsResponse>(
            `${asset.metaId}/insights`, insightsParams, token, { label: `${insightsLabel}-retry`, budget },
          );
        }

        if (res.rateLimited) { sawRateLimit = true; break; }

        if (!res.ok) {
          await upsertWindowMetric(asset.id, win, null, scrubSecrets(res.error ?? "channel insights failed"));
          if (win === DEFAULT_WINDOW) out.errors.push(`${asset.name}: ${res.error ?? "insights failed"}`);
          continue;
        }

        // Instagram's follower change for this window. Skipped for "day" — Meta
        // will not break a single day down — and skipped when the budget is spent,
        // in which case it stays null rather than becoming a misleading 0.
        // Earnings: its OWN request — see FB_EARNINGS_METRIC for why it cannot
        // ride along. Failing it must never cost the channel its other metrics,
        // so it is fetched after them and simply stays null if it does not answer.
        let earningsCents: number | null = null;
        let dayEarningsData: InsightsResponse | undefined;
        if (!isIg && budget.used < budget.max) {
          let er = await oauthGraphFetch<InsightsResponse>(
            `${asset.metaId}/insights`,
            { metric: FB_EARNINGS_METRIC, period: win },
            token,
            { label: `channel-fb-earnings-${win}`, budget },
          );
          // Same bounded retry as the main insights call — a transient miss here
          // silently nulls the window's revenue until the next sync.
          if (isTransientGraphFailure(er) && budget.used < budget.max) {
            await sleep(RETRY_DELAY_MS);
            er = await oauthGraphFetch<InsightsResponse>(
              `${asset.metaId}/insights`,
              { metric: FB_EARNINGS_METRIC, period: win },
              token,
              { label: `channel-fb-earnings-${win}-retry`, budget },
            );
          }
          if (er.rateLimited) { sawRateLimit = true; break; }
          // Meta returns a plain USD number. Store CENTS — money must never be
          // carried as a float.
          if (er.ok) {
            earningsCents = readEarningsCents(er.data);
            if (win === "day") dayEarningsData = er.data;
          }
        }

        let igDelta: number | null = null;
        let igFollows: number | null = null;
        let igUnfollows: number | null = null;
        if (isIg && win !== "day" && budget.used < budget.max) {
          const fu = await fetchIgNetFollowerChange(asset.metaId, token, sinceTs, untilTs, budget);
          if (fu) { igDelta = fu.net; igFollows = fu.follows; igUnfollows = fu.unfollows; }
        }

        // What the numbers DESCRIBE, as distinct from when we fetched them.
        // Instagram was asked for an explicit until, so we already know its end.
        const periodEnd = isIg ? new Date(untilTs * 1000) : readPeriodEnd(res.data);

        const metrics = readMetrics(res.data, isIg);
        if (isIg) { metrics.follows = igFollows; metrics.unfollows = igUnfollows; }

        await upsertWindowMetric(asset.id, win, metrics, null, igDelta, earningsCents, periodEnd);

        // ── The day window doubles as the FREE writer of per-day history ──
        //
        // Calendar months and custom ranges are served from meta_asset_daily,
        // and this is where those rows come from at ZERO extra API cost: the
        // day fetch already carries per-day values (Facebook returns 2-3 daily
        // points; Instagram's since/until IS one day). Guarded so a history
        // write can never affect the sync — same contract as writeApiSnapshot.
        if (win === "day") {
          try {
            const rows = isIg
              ? (() => { const r = igDailyRowFromTotals(res.data, sinceTs); return r ? [r] : []; })()
              : fbDailyRowsFromSeries(res.data, dayEarningsData);
            if (rows.length > 0) await persistDailyRows(asset.id, rows);
          } catch (e) {
            console.warn(`[meta-daily] persist failed for ${asset.name}: ${scrubSecrets(String(e))}`);
          }
        }

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
      // Only the owning asset writes to a contested channel row — see resolveContestedOwners.
      const ownsChannelRow =
        !assetSocialAccountId ||
        !contestedOwners.has(assetSocialAccountId) ||
        contestedOwners.get(assetSocialAccountId) === asset.id;
      if (ownsChannelRow && assetSocialAccountId && authoritative !== null && authoritative > 0) {
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

/**
 * Which asset "owns" each linked channel row.
 *
 * ⚠️ A SocialAccount CAN BE CLAIMED BY MORE THAN ONE CONNECTED ASSET. Discovery
 * links assets to channel rows by name, so two genuinely different Facebook Pages
 * that share a name land on the same row. Measured on prod 2026-08-24 — three
 * collisions across six assets:
 *
 *   Bollywood Insider    1,925,388  and    527,857
 *   The Candid Couch     5,235,735  and    131,975
 *   Mad About Marketing    352,407  and          0
 *
 * Without this, the follower write-back is LAST-WRITER-WINS over an iteration
 * order that changes every run (assets are ordered by metricsFetchedAt), so the
 * stored count can flip between two real-but-different Pages — and because every
 * run also writes a growth snapshot, the series would show enormous alternating
 * gains and losses that never happened. It also silently picked the SMALLER page
 * in two of the three cases.
 *
 * One asset owns the row: the one with the most followers, which is deterministic
 * and is in practice the main Page. The others still appear as their own rows in
 * Connected channels with their own figures — nothing is hidden. They simply do
 * not write back, and they carry no follower delta, because the channel row's
 * history is not theirs to claim.
 *
 * Returns socialAccountId -> owning assetId, ONLY for accounts that are contested.
 * An account with a single asset is not in the map and needs no check.
 */
/**
 * Assets that are the SAME Meta object reached through a different connection.
 *
 * ⚠️ CONNECTING A SECOND ADMIN IS ADDITIVE, NOT A REPLACEMENT. MetaConnection is
 * unique on `metaUserId`, so the same Facebook user reconnecting UPDATES their row
 * in place, but a DIFFERENT person creates a SECOND live connection and both are
 * synced. MetaAsset is unique on `(connectionId, kind, metaId)` — per connection —
 * so a Page both admins administer is stored TWICE, once under each.
 *
 * Left alone that has two consequences, neither of them visible as an error:
 *   • the Page appears twice in Connected channels and is DOUBLE-COUNTED in the
 *     views / reach / engagement / revenue totals;
 *   • the sync polls it once per connection, doubling its share of the call budget
 *     — and the budget silently truncates, so other channels lose data instead.
 *
 * One row wins, deterministically: most followers, then the earliest connection,
 * then id, so it never flips between runs. The loser is hidden from the table and
 * skipped by the sync; nothing is deleted, and if the winning connection is later
 * revoked the other simply takes over.
 *
 * Returns the asset ids to SUPPRESS. Empty while only one connection exists.
 */
export async function resolveDuplicateAssetIds(): Promise<Set<string>> {
  const rows = await prisma.metaAsset.findMany({
    where: { disconnectedAt: null },
    select: { id: true, kind: true, metaId: true, followerCount: true, name: true, createdAt: true, selected: true },
  });
  const byObject = new Map<string, typeof rows>();
  for (const r of rows) {
    const key = `${r.kind}:${r.metaId}`;
    const list = byObject.get(key) ?? [];
    list.push(r);
    byObject.set(key, list);
  }
  const suppress = new Set<string>();
  for (const [key, list] of byObject) {
    if (list.length < 2) continue;
    list.sort(
      (a, b) =>
        // ⚠️ A MONITORED copy must always beat a REMOVED one. Without this, a
        // hidden (selected:false) duplicate could win on follower count — the
        // sync then skips the winner (it only polls selected assets) AND
        // dedupe suppresses the visible copy, so the channel silently vanishes
        // from the page and goes stale, when the admin only removed one copy.
        Number(b.selected) - Number(a.selected) ||
        (b.followerCount ?? 0) - (a.followerCount ?? 0) ||
        a.createdAt.getTime() - b.createdAt.getTime() ||
        a.id.localeCompare(b.id),
    );
    for (const dupe of list.slice(1)) suppress.add(dupe.id);
    console.warn(
      `[meta-channels] ${key} ("${list[0].name}") is reachable through ${list.length} connections; ` +
        `keeping one and suppressing ${list.length - 1} so it is not double-counted.`,
    );
  }
  return suppress;
}

export async function resolveContestedOwners(): Promise<Map<string, string>> {
  const rows = await prisma.metaAsset.findMany({
    where: { disconnectedAt: null, socialAccountId: { not: null } },
    select: { id: true, socialAccountId: true, followerCount: true, name: true },
  });
  const byAccount = new Map<string, Array<{ id: string; followers: number; name: string }>>();
  for (const r of rows) {
    const list = byAccount.get(r.socialAccountId!) ?? [];
    list.push({ id: r.id, followers: r.followerCount ?? 0, name: r.name });
    byAccount.set(r.socialAccountId!, list);
  }
  const owners = new Map<string, string>();
  for (const [accountId, list] of byAccount) {
    if (list.length < 2) continue;
    // Deterministic: most followers, then id, so ties never flip between runs.
    list.sort((a, b) => b.followers - a.followers || a.id.localeCompare(b.id));
    owners.set(accountId, list[0].id);
    console.warn(
      `[meta-channels] channel row ${accountId} is claimed by ${list.length} connected assets ` +
        `(${list.map((x) => `${x.name}=${x.followers}`).join(", ")}). ` +
        `"${list[0].name}" owns it; the others keep their own figures but do not write back.`,
    );
  }
  return owners;
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
  follows: number | null;
  unfollows: number | null;
  videoViewTimeMs: number | null;
  saves: number | null;
  shares: number | null;
  accountsEngaged: number | null;
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
      saves: total("saves"),
      shares: total("shares"),
      accountsEngaged: total("accounts_engaged"),
      // Instagram's follows/unfollows come from follows_and_unfollows, which the
      // follower-change fetch already reads — filled in by the caller.
      follows: null,
      unfollows: null,
      videoViewTimeMs: null, // no Instagram equivalent
    };
  }
  return {
    views: reduceSeries(seriesFor(d, "page_media_view"), "last"),
    reach: reduceSeries(seriesFor(d, "page_total_media_view_unique"), "last"),
    engagements: reduceSeries(seriesFor(d, "page_post_engagements"), "last"),
    profileViews: reduceSeries(seriesFor(d, "page_views_total"), "last"),
    reactions: reduceSeries(seriesFor(d, "page_actions_post_reactions_total"), "last"),
    follows: reduceSeries(seriesFor(d, "page_daily_follows_unique"), "last"),
    unfollows: reduceSeries(seriesFor(d, "page_daily_unfollows_unique"), "last"),
    videoViewTimeMs: reduceSeries(seriesFor(d, "page_video_view_time"), "last"),
    saves: null,   // Facebook publishes no page-level saves
    shares: null,  // nor page-level shares
    accountsEngaged: null,
  };
}

/** One day of channel figures, keyed by the calendar day it DESCRIBES. */
export interface DailyRow {
  date: string; // YYYY-MM-DD
  views: number | null;
  reach: number | null;
  engagements: number | null;
  profileViews: number | null;
  reactions: number | null;
  follows: number | null;
  unfollows: number | null;
  videoViewTimeMs: number | null;
  saves: number | null;
  shares: number | null;
  accountsEngaged: number | null;
  earningsCents: number | null;
}

/**
 * A daily value, or null. Negative values are SENTINELS, not data — Instagram
 * returns -1 for metrics it will not publish for old spans (live-probed
 * 2026-08-31: total_interactions=-1, likes=-1 at ~545 days back). Storing a -1
 * would poison every range sum that touches it; the fabricated-negative class.
 */
function dailyNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
}

/**
 * The day a Facebook daily point DESCRIBES.
 *
 * ⚠️ end_time is the moment the day CLOSED (the Page-local midnight after it),
 * stamped e.g. 2026-06-03T07:00:00Z for the day that was June 2 in the Page's
 * timezone — so the covered day is end_time's date MINUS ONE. Keying by end_time
 * directly would shift every range sum a day late and silently exclude the last
 * day of any [start, end] filter.
 */
function fbDayCovered(endTime: unknown): string | null {
  const d = String(endTime ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - 1);
  return t.toISOString().slice(0, 10);
}

const FB_DAILY_FIELD: Record<string, keyof Omit<DailyRow, "date">> = {
  page_media_view: "views",
  page_total_media_view_unique: "reach",
  page_post_engagements: "engagements",
  page_views_total: "profileViews",
  page_actions_post_reactions_total: "reactions",
  page_daily_follows_unique: "follows",
  page_daily_unfollows_unique: "unfollows",
  page_video_view_time: "videoViewTimeMs",
  // page_follows is a STOCK (the running follower total) — it belongs to
  // account_growth_snapshots, never to a flow-metrics day row.
};

function emptyDailyRow(date: string): DailyRow {
  return { date, views: null, reach: null, engagements: null, profileViews: null,
    reactions: null, follows: null, unfollows: null, videoViewTimeMs: null,
    saves: null, shares: null, accountsEngaged: null, earningsCents: null };
}

/**
 * Explode a Facebook period=day response (plus its separate earnings response —
 * see FB_EARNINGS_METRIC for why they can never share a call) into per-day rows.
 * Pure; exported for the backfill script and tests.
 */
export function fbDailyRowsFromSeries(
  d: InsightsResponse | undefined,
  earnings?: InsightsResponse,
): DailyRow[] {
  const byDate = new Map<string, DailyRow>();
  const rowFor = (date: string) => {
    let r = byDate.get(date);
    if (!r) { r = emptyDailyRow(date); byDate.set(date, r); }
    return r;
  };
  for (const series of d?.data ?? []) {
    const field = series.name ? FB_DAILY_FIELD[series.name] : undefined;
    if (!field) continue;
    for (const v of series.values ?? []) {
      const date = fbDayCovered(v.end_time);
      if (!date) continue;
      const n = dailyNum(v.value);
      if (n !== null) (rowFor(date)[field] as number | null) = n;
    }
  }
  for (const v of earnings?.data?.find((x) => x.name === FB_EARNINGS_METRIC)?.values ?? []) {
    const date = fbDayCovered(v.end_time);
    if (!date) continue;
    const usd = typeof v.value === "number" && Number.isFinite(v.value) && v.value >= 0 ? v.value : null;
    // ⚠️ Cents BEFORE rounding — $4,346.92 rounded as dollars loses the cents
    // before they are ever written (the documented earnings-rounding trap).
    if (usd !== null) rowFor(date).earningsCents = Math.round(usd * 100);
  }
  return [...byDate.values()].filter(
    (r) => Object.entries(r).some(([k, val]) => k !== "date" && val !== null),
  );
}

/**
 * One Instagram day from a total_value response whose since/until spanned
 * exactly that day. The day described is the SINCE date (IG buckets by UTC day).
 * Pure; exported for the backfill script and tests.
 */
export function igDailyRowFromTotals(d: InsightsResponse | undefined, sinceTs: number): DailyRow | null {
  // ⚠️ Raw values, NOT readMetrics(): its intOrNull() clamps with Math.max(0, …),
  // which converts Instagram's -1 "withheld" sentinel into a confident zero —
  // the fabricated-zero class, and stored history would carry it forever.
  // dailyNum() maps every negative to null instead. (The clamp is harmless for
  // the live windows, which never reach the ~1-year-old spans where sentinels
  // appear.)
  const raw = (name: string): unknown => d?.data?.find((x) => x.name === name)?.total_value?.value;
  const row: DailyRow = {
    date: new Date(sinceTs * 1000).toISOString().slice(0, 10),
    views: dailyNum(raw("views")),
    reach: dailyNum(raw("reach")),
    engagements: dailyNum(raw("total_interactions")),
    profileViews: dailyNum(raw("profile_views")),
    reactions: dailyNum(raw("likes")),
    follows: null,
    unfollows: null,
    videoViewTimeMs: null,
    saves: dailyNum(raw("saves")),
    shares: dailyNum(raw("shares")),
    accountsEngaged: dailyNum(raw("accounts_engaged")),
    earningsCents: null, // Instagram publishes no earnings metric at all
  };
  const hasAny = Object.entries(row).some(([k, val]) => k !== "date" && val !== null);
  return hasAny ? row : null;
}

/**
 * Persist day rows. Fail-open with a loud warn — a daily-history write must
 * never be able to fail the metrics sync (same contract as writeApiSnapshot),
 * but a SILENT fail-open is indistinguishable from success, which is the
 * documented follower-map-builder incident class.
 */
export async function persistDailyRows(assetId: string, rows: DailyRow[]): Promise<number> {
  let written = 0;
  for (const r of rows) {
    const date = new Date(`${r.date}T00:00:00Z`);
    const data = {
      views: bigintOrNull(r.views),
      reach: bigintOrNull(r.reach),
      engagements: bigintOrNull(r.engagements),
      profileViews: bigintOrNull(r.profileViews),
      reactions: bigintOrNull(r.reactions),
      follows: r.follows,
      unfollows: r.unfollows,
      videoViewTimeMs: bigintOrNull(r.videoViewTimeMs),
      saves: r.saves,
      shares: r.shares,
      accountsEngaged: r.accountsEngaged,
      earningsCents: r.earningsCents,
    };
    try {
      await prisma.metaAssetDaily.upsert({
        where: { assetId_date: { assetId, date } },
        create: { assetId, date, ...data },
        update: data,
      });
      written++;
    } catch (e) {
      console.warn(`[meta-daily] write failed ${assetId}/${r.date}: ${scrubSecrets(String(e))}`);
    }
  }
  return written;
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
  followerDelta: number | null = null,
  earningsCents: number | null = null,
  periodEnd: Date | null = null,
): Promise<void> {
  const data = m
    ? {
        views: bigintOrNull(m.views),
        reach: bigintOrNull(m.reach),
        engagements: bigintOrNull(m.engagements),
        profileViews: bigintOrNull(m.profileViews),
        reactions: bigintOrNull(m.reactions),
        follows: m.follows,
        unfollows: m.unfollows,
        videoViewTimeMs: bigintOrNull(m.videoViewTimeMs),
        saves: m.saves,
        shares: m.shares,
        accountsEngaged: m.accountsEngaged,
        followerDelta,
        earningsCents,
        periodEnd,
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
