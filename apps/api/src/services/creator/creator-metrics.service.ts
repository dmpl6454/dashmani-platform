/**
 * Creator portal — the daily page stats staff see when vetting a creator (followers and the
 * last 28 days' views / engagements per page).
 *
 * One budgeted pass (creatorConfig.metricsCallBudget(), default 200 Graph calls), least recently
 * fetched first, so a budget smaller than the estate ROTATES instead of re-reading the same pages
 * forever. Every asset costs two calls (profile + insights).
 *
 * The request shapes are the ones services/meta-oauth/meta-channels.service.ts proved live:
 *  • Facebook: page_media_view + page_post_engagements, period=days_28, with an EXPLICIT
 *    since/until (without one Meta stops a closed day early); the open "today so far" bucket is
 *    split off with splitFbSeries and the LAST closed point is the rolling 28-day total
 *    (never a sum — that would be ~28× the truth).
 *  • Instagram: views + total_interactions, metric_type=total_value, over the last 28 COMPLETED
 *    UTC days (a range ending "now" returns only today's partial slice).
 * A metric Meta did not give us is NULL, never 0, and the reason goes to metricsError.
 * Never writes any meta_* table.
 */

import { prisma } from "@dashmani/db";
import { oauthGraphFetch, makeBudget, type CallBudget } from "../meta-oauth/oauth-graph";
import { splitFbSeries } from "../meta-oauth/meta-channels.service";
import { decryptToken, scrubSecrets } from "../../utils/token-crypto";
import { creatorConfig } from "./creator-config";
import { creatorMetaAppSecret } from "./creator-meta-config";

const DAY = 86_400;
/** How far back the Facebook request reaches; the last CLOSED point is what we keep. */
const FB_LOOKBACK_DAYS = 4;
const CALLS_PER_ASSET = 2;

interface InsightsResponse {
  data?: Array<{ name?: string; values?: Array<{ value?: unknown; end_time?: string }>; total_value?: { value?: unknown } }>;
}

/** Non-negative integer or null. ⚠️ Negative is Instagram's "withheld" sentinel → null, not 0. */
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
const clip = (s: string) => (s.length > 300 ? `${s.slice(0, 299)}…` : s);

function lastClosed(res: InsightsResponse | undefined, name: string): number | null {
  const values = res?.data?.find((d) => d.name === name)?.values ?? [];
  for (let i = values.length - 1; i >= 0; i--) {
    const n = numOrNull(values[i]?.value);
    if (n !== null) return n;
  }
  return null;
}

const totalValue = (res: InsightsResponse | undefined, name: string) =>
  numOrNull(res?.data?.find((d) => d.name === name)?.total_value?.value);

export interface CreatorMetricsOutcome {
  assetsUpdated: number;
  failed: number;
  callsUsed: number;
  rateLimited: boolean;
}

/** Refresh stats for the least-recently-fetched creator pages within the call budget. Never throws. */
export async function refreshCreatorMetrics(opts?: { budget?: CallBudget; now?: Date }): Promise<CreatorMetricsOutcome> {
  const out: CreatorMetricsOutcome = { assetsUpdated: 0, failed: 0, callsUsed: 0, rateLimited: false };
  const budget = opts?.budget ?? makeBudget(creatorConfig.metricsCallBudget());
  const startUsed = budget.used;
  const now = opts?.now ?? new Date();

  const assets = await prisma.creatorAsset.findMany({
    where: {
      disconnectedAt: null,
      creator: { status: { not: "closed" } },
      connection: { revokedAt: null, userTokenEnc: { not: null }, status: { notIn: ["REVOKED", "NEEDS_REAUTH"] } },
    },
    orderBy: [{ metricsFetchedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
    take: Math.max(1, Math.floor((budget.max - budget.used) / CALLS_PER_ASSET)),
    select: {
      id: true,
      kind: true,
      metaId: true,
      pageTokenEnc: true,
      followerCount: true,
      mediaCount: true,
      connectionId: true,
      connection: { select: { userTokenEnc: true } },
    },
  });
  /** Connections Meta refused this run (code 190): their remaining pages are skipped. */
  const lapsed = new Set<string>();
  // Meta no longer accepts the token (password changed, app removed without a deauthorize
  // callback reaching us): the CONNECTION needs a reconnect — say so, and stop offering its
  // pages (LIVE_CONNECTION_STATUSES in creator-view.ts excludes NEEDS_REAUTH).
  const markLapsed = async (assetId: string, connectionId: string) => {
    lapsed.add(connectionId);
    out.failed++;
    await prisma.creatorConnection.updateMany({
      where: { id: connectionId, revokedAt: null },
      data: { status: "NEEDS_REAUTH", lastError: "Facebook no longer accepts this connection — please reconnect." },
    });
    await prisma.creatorAsset.update({
      where: { id: assetId },
      data: { views28d: null, engagements28d: null, metricsFetchedAt: now, metricsError: "Facebook no longer accepts this connection." },
    });
  };

  const nowTs = Math.floor(now.getTime() / 1000);
  // Instagram: the last 28 COMPLETED UTC days.
  const igUntil = Math.floor(now.getTime() / 86_400_000) * DAY;
  const igSince = igUntil - 28 * DAY;

  for (const a of assets) {
    if (budget.used + CALLS_PER_ASSET > budget.max) break;
    if (lapsed.has(a.connectionId)) continue;
    const isIg = a.kind === "instagram_account";
    let token: string;
    try {
      const enc = isIg ? a.connection.userTokenEnc : a.pageTokenEnc;
      if (!enc) throw new Error("no token stored");
      token = decryptToken(enc);
    } catch (e) {
      out.failed++;
      await prisma.creatorAsset.update({
        where: { id: a.id },
        data: { views28d: null, engagements28d: null, metricsFetchedAt: now, metricsError: clip(`Token unavailable: ${scrubSecrets(String(e))}`) },
      });
      continue;
    }

    const prof = await oauthGraphFetch<{ followers_count?: number; fan_count?: number; media_count?: number }>(
      a.metaId,
      { fields: isIg ? "followers_count,media_count" : "followers_count,fan_count" },
      token,
      { label: "creator-metrics-profile", budget, appSecret: creatorMetaAppSecret() },
    );
    if (prof.rateLimited) { out.rateLimited = true; break; }
    if (prof.authInvalid) { await markLapsed(a.id, a.connectionId); continue; }

    const ins = await oauthGraphFetch<InsightsResponse>(
      `${a.metaId}/insights`,
      isIg
        ? { metric: "views,total_interactions", metric_type: "total_value", period: "day", since: igSince, until: igUntil }
        : { metric: "page_media_view,page_post_engagements", period: "days_28", since: nowTs - FB_LOOKBACK_DAYS * DAY, until: nowTs },
      token,
      { label: isIg ? "creator-metrics-ig-insights" : "creator-metrics-fb-insights", budget, appSecret: creatorMetaAppSecret() },
    );
    if (ins.rateLimited) { out.rateLimited = true; break; }

    if (ins.authInvalid) { await markLapsed(a.id, a.connectionId); continue; }

    let views: number | null = null;
    let engagements: number | null = null;
    if (ins.ok) {
      if (isIg) {
        views = totalValue(ins.data, "views");
        engagements = totalValue(ins.data, "total_interactions");
      } else {
        const closed = splitFbSeries(ins.data as never, now.getTime()).closed as InsightsResponse | undefined;
        views = lastClosed(closed, "page_media_view");
        engagements = lastClosed(closed, "page_post_engagements");
      }
    }

    const errors = [
      prof.ok ? null : `followers: ${prof.error ?? "failed"}`,
      ins.ok ? null : `insights: ${ins.error ?? "failed"}`,
    ].filter(Boolean) as string[];
    const followers = prof.ok ? (numOrNull(prof.data?.followers_count) ?? numOrNull(prof.data?.fan_count)) : null;

    await prisma.creatorAsset.update({
      where: { id: a.id },
      data: {
        // A failed profile read keeps the last known follower count (it came from discovery);
        // a failed insights read is NULL — never a stale or fabricated figure.
        ...(prof.ok ? { followerCount: followers } : {}),
        ...(prof.ok && isIg ? { mediaCount: numOrNull(prof.data?.media_count) } : {}),
        views28d: views == null ? null : BigInt(views),
        engagements28d: engagements == null ? null : BigInt(engagements),
        metricsFetchedAt: now,
        metricsError: errors.length ? clip(scrubSecrets(errors.join("; "))) : null,
      },
    });
    if (errors.length) out.failed++;
    else out.assetsUpdated++;
  }

  out.callsUsed = budget.used - startUsed;
  console.log(
    `[creator-metrics] updated=${out.assetsUpdated} failed=${out.failed} calls=${out.callsUsed}/${budget.max}` +
      (out.rateLimited ? " RATE_LIMITED" : ""),
  );
  return out;
}
