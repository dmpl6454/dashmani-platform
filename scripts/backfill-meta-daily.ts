/**
 * Backfill meta_asset_daily — the per-day history behind calendar-month and
 * custom-range views on Account Growth.
 *
 * WHAT IT LOADS (limits live-probed 2026-08-31 on real prod assets):
 *
 *   FACEBOOK  period=day series in 90-day chunks, walking back. Views,
 *             engagements and profile views verified non-zero at 730 days;
 *             daily reach (page_total_media_view_unique) goes ~zero beyond
 *             ~365-540 days (the successor metric is younger than the Page) —
 *             zeros that Meta itself returns are stored as such. Earnings ride
 *             in their own call per chunk (they can NEVER share a call with
 *             regular metrics — the documented (#2) batching incident).
 *             Cost: 2 calls per asset per 90-day chunk.
 *
 *   INSTAGRAM ⚠️ NO DAILY SERIES EXISTS for views/engagements —
 *             metric_type=time_series is rejected ("incompatible with the
 *             metric type") and total_value only answers a whole span. Daily
 *             history therefore costs ONE CALL PER ASSET-DAY, which is why the
 *             default IG depth is 90 days, not two years (105 assets x 90 days
 *             = ~9,450 calls). Meta's own error caps IG at "the last 2 years",
 *             with sentinel -1s appearing past ~1 year — dailyNum() maps those
 *             to null, never stored.
 *
 * Ongoing days accrue FREE from the 3-hourly channel sync (its day-window fetch
 * is persisted), so this script is one-time per depth — and RESUMABLE: covered
 * days are skipped, so re-running with the same flags continues where the call
 * budget stopped.
 *
 * Dry-run by default. Writing requires --apply, and prod additionally
 * --confirm-prod.
 *
 *   npx tsx scripts/backfill-meta-daily.ts                                # dry run
 *   npx tsx scripts/backfill-meta-daily.ts --fb-days=730 --ig-days=90 \
 *       --max-calls=3000 --apply --confirm-prod
 */

import { prisma } from "@dashmani/db";
import { decryptToken } from "../apps/api/src/utils/token-crypto";
import { oauthGraphFetch, makeBudget, isTransientGraphFailure } from "../apps/api/src/services/meta-oauth/oauth-graph";
import {
  fbDailyRowsFromSeries,
  igDailyRowFromTotals,
  persistDailyRows,
  type DailyRow,
} from "../apps/api/src/services/meta-oauth/meta-channels.service";

const FB_METRICS = [
  "page_media_view", "page_total_media_view_unique", "page_post_engagements",
  "page_views_total", "page_actions_post_reactions_total",
  "page_daily_follows_unique", "page_daily_unfollows_unique", "page_video_view_time",
].join(",");
const FB_EARNINGS_METRIC = "monetization_approximate_earnings";
const IG_METRICS = ["reach", "views", "profile_views", "total_interactions", "likes", "saves", "shares", "accounts_engaged"].join(",");

const DAY = 86_400;
const DAY_MS = 86_400_000;
/** Meta rejects a period=day span of 94+ days ("Invalid parameter"). */
const FB_CHUNK_DAYS = 90;

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const CONFIRM_PROD = args.includes("--confirm-prod");
const num = (flag: string, dflt: number) =>
  Number(args.find((a) => a.startsWith(`--${flag}=`))?.split("=")[1] ?? dflt);
const FB_DAYS = num("fb-days", 730);
const IG_DAYS = num("ig-days", 90);
const MAX_CALLS = num("max-calls", 3000);
const DELAY_MS = num("delay-ms", 150);

const budget = makeBudget(MAX_CALLS);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

let written = 0;
let dryRows = 0;
let skippedCoveredChunks = 0;

async function coveredDates(assetId: string, sinceIso: string): Promise<Set<string>> {
  const rows = await prisma.metaAssetDaily.findMany({
    where: { assetId, date: { gte: new Date(`${sinceIso}T00:00:00Z`) } },
    select: { date: true },
  });
  return new Set(rows.map((r) => r.date.toISOString().slice(0, 10)));
}

async function save(assetId: string, rows: DailyRow[]) {
  if (rows.length === 0) return;
  if (APPLY) written += await persistDailyRows(assetId, rows);
  else dryRows += rows.length;
}

/** One Graph call with the same bounded transient retry the sync uses. */
async function call<T>(path: string, params: Record<string, string | number>, token: string, label: string) {
  let res = await oauthGraphFetch<T>(path, params, token, { label, budget });
  if (isTransientGraphFailure(res) && budget.used < budget.max) {
    await sleep(400);
    res = await oauthGraphFetch<T>(path, params, token, { label: `${label}-retry`, budget });
  }
  return res;
}

async function backfillFacebook(): Promise<boolean> {
  const yesterdayStartMs = Math.floor(Date.now() / DAY_MS) * DAY_MS - DAY_MS;
  const oldestIso = isoDay(yesterdayStartMs - (FB_DAYS - 1) * DAY_MS);

  const assets = await prisma.metaAsset.findMany({
    where: { kind: "FACEBOOK_PAGE", selected: true, disconnectedAt: null, pageTokenEnc: { not: null } },
    select: { id: true, name: true, metaId: true, pageTokenEnc: true },
    orderBy: { followerCount: "desc" }, // biggest channels get coverage first
  });
  console.log(`FB: ${assets.length} pages, ${FB_DAYS}d back (${oldestIso}..), ~2 calls per 90d chunk`);

  for (const a of assets) {
    if (budget.used >= budget.max) return false;
    let token: string;
    try { token = decryptToken(a.pageTokenEnc!); } catch { console.warn(`  ${a.name}: token unreadable`); continue; }
    const have = await coveredDates(a.id, oldestIso);

    // Walk back in 90-day chunks; skip a chunk whose days are all present.
    for (let offset = 0; offset < FB_DAYS; offset += FB_CHUNK_DAYS) {
      if (budget.used >= budget.max) return false;
      const chunkDays = Math.min(FB_CHUNK_DAYS, FB_DAYS - offset);
      const untilMs = yesterdayStartMs - offset * DAY_MS + DAY_MS; // exclusive-ish upper bound
      const sinceMs = untilMs - chunkDays * DAY_MS;
      let missing = 0;
      for (let d = sinceMs; d < untilMs; d += DAY_MS) if (!have.has(isoDay(d))) missing++;
      if (missing === 0) { skippedCoveredChunks++; continue; }

      const since = Math.floor(sinceMs / 1000);
      const until = Math.floor(untilMs / 1000);
      const metricsRes = await call<Parameters<typeof fbDailyRowsFromSeries>[0]>(
        `${a.metaId}/insights`, { metric: FB_METRICS, period: "day", since, until }, token, "backfill-fb-daily");
      if (metricsRes.rateLimited) { console.warn("RATE LIMITED — stopping politely; rerun later to resume."); return false; }
      if (!metricsRes.ok) {
        // Fail soft per chunk: an old window can be unavailable while recent ones are fine.
        console.warn(`  ${a.name} chunk -${offset}d: ${String(metricsRes.error).slice(0, 80)}`);
        await sleep(DELAY_MS);
        continue;
      }
      const earningsRes = await call<Parameters<typeof fbDailyRowsFromSeries>[1]>(
        `${a.metaId}/insights`, { metric: FB_EARNINGS_METRIC, period: "day", since, until }, token, "backfill-fb-earn");
      if (earningsRes.rateLimited) { console.warn("RATE LIMITED — stopping politely."); return false; }

      const rows = fbDailyRowsFromSeries(metricsRes.data, earningsRes.ok ? earningsRes.data : undefined)
        .filter((r) => !have.has(r.date));
      await save(a.id, rows);
      await sleep(DELAY_MS);
    }
  }
  return true;
}

async function backfillInstagram(): Promise<boolean> {
  const yesterdayStartMs = Math.floor(Date.now() / DAY_MS) * DAY_MS - DAY_MS;
  const oldestIso = isoDay(yesterdayStartMs - (IG_DAYS - 1) * DAY_MS);

  const assets = await prisma.metaAsset.findMany({
    where: { kind: "INSTAGRAM_ACCOUNT", selected: true, disconnectedAt: null },
    select: { id: true, name: true, metaId: true, connection: { select: { userTokenEnc: true } } },
    orderBy: { followerCount: "desc" },
  });
  console.log(`IG: ${assets.length} accounts, ${IG_DAYS}d back (${oldestIso}..), 1 call per asset-DAY`);

  for (const a of assets) {
    if (budget.used >= budget.max) return false;
    if (!a.connection?.userTokenEnc) continue;
    let token: string;
    try { token = decryptToken(a.connection.userTokenEnc); } catch { continue; }
    const have = await coveredDates(a.id, oldestIso);

    for (let offset = 0; offset < IG_DAYS; offset++) {
      if (budget.used >= budget.max) return false;
      const dayStartMs = yesterdayStartMs - offset * DAY_MS;
      const dayIso = isoDay(dayStartMs);
      if (have.has(dayIso)) continue;
      const since = Math.floor(dayStartMs / 1000);
      const res = await call<Parameters<typeof igDailyRowFromTotals>[0]>(
        `${a.metaId}/insights`,
        { metric: IG_METRICS, metric_type: "total_value", period: "day", since, until: since + DAY },
        token, "backfill-ig-daily");
      if (res.rateLimited) { console.warn("RATE LIMITED — stopping politely; rerun later to resume."); return false; }
      if (!res.ok) {
        console.warn(`  ${a.name} ${dayIso}: ${String(res.error).slice(0, 80)}`);
        await sleep(DELAY_MS);
        continue;
      }
      const row = igDailyRowFromTotals(res.data, since);
      if (row) await save(a.id, [row]);
      await sleep(DELAY_MS);
    }
    console.log(`  IG ${a.name}: done (calls so far ${budget.used}/${budget.max})`);
  }
  return true;
}

async function main() {
  const isProd = (process.env.DATABASE_URL ?? "").includes("dashmani_prod");
  if (APPLY && isProd && !CONFIRM_PROD) {
    console.error("Refusing to write to production without --confirm-prod.");
    process.exit(1);
  }
  console.log(`Mode: ${APPLY ? "APPLY" : "DRY RUN"} | fb-days=${FB_DAYS} ig-days=${IG_DAYS} max-calls=${MAX_CALLS}\n`);

  // FB first: 2 calls buy 90 asset-days, vs 1 call per asset-day on IG — the
  // cheap coverage should never be starved by the expensive one.
  const fbDone = await backfillFacebook();
  const igDone = fbDone ? await backfillInstagram() : false;

  console.log(`\ncalls used: ${budget.used}/${budget.max}`);
  console.log(APPLY ? `rows written: ${written}` : `rows that WOULD be written: ${dryRows}`);
  console.log(`chunks already covered (skipped): ${skippedCoveredChunks}`);
  if (!fbDone || !igDone) console.log("NOT FINISHED — rerun with the same flags to resume (covered days are skipped).");
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error("BACKFILL ERROR", e); await prisma.$disconnect(); process.exit(1); });
