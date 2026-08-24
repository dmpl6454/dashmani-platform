/**
 * Backfill REAL daily follower history for connected Facebook Pages.
 *
 * ⚠️ WHY THIS EXISTS. Account Growth can show a follower change per period, but
 * only from API-sourced snapshots — and ours began 2026-08-24, so the change was
 * blank on every channel. This fills the gap with Meta's own figures instead of
 * waiting four weeks for history to accumulate.
 *
 * ⚠️ FACEBOOK ONLY, AND THAT IS DELIBERATE. Live-probed 2026-08-24:
 *
 *   FACEBOOK  `page_follows` with period=day returns the TRUE DAILY TOTAL
 *             follower count — not a delta. Verified on Paparazzii: 90 days back
 *             reads 14,345,564 against 16,291,445 today, a smooth monotonic
 *             curve. One request spans at most 93 days ("Invalid parameter" at
 *             94), but OLDER WINDOWS ARE WALKABLE, so roughly a year is
 *             reachable (270-360d ago returned 90 points from 2025-08-30).
 *
 *   INSTAGRAM has no equivalent. `follower_count` gives DAILY DELTAS only, caps
 *             at 30 days per request, and is GROSS rather than net — so
 *             reconstructing past totals by subtraction runs LOW. Measured
 *             against corroborated snapshots on four accounts: -2.39%, -2.98%,
 *             -0.51%, -0.88%, all negative, which is the signature of unfollows
 *             not being subtracted. `follows_and_unfollows` does NOT rescue it:
 *             its follow_type breakdown returns FOLLOWER / NON_FOLLOWER, and
 *             reading those as follows/unfollows would have implied Paparazzi
 *             LOST 8,656 followers in 14 days while it was in fact growing.
 *             ⚠️ Do not "fix" Instagram by writing reconstructed values as
 *             source="api" — this page is verified-data-only, and IG deltas
 *             become exact on their own as our snapshots accumulate.
 *
 * ⚠️ `page_daily_follows_unique` is GROSS, not net (151,640 summed vs a 126,150
 * real change over 14 days) — never treat it as the follower total.
 *
 * Dry-run by default. Writing requires --apply, and prod additionally
 * --confirm-prod.
 *
 *   npx tsx ../../scripts/backfill-fb-follower-history.ts            # dry run
 *   npx tsx ../../scripts/backfill-fb-follower-history.ts --days=93 --apply --confirm-prod
 */

import { prisma } from "@dashmani/db";
import { istMidnight } from "@dashmani/shared";
import { decryptToken } from "../apps/api/src/utils/token-crypto";
import { resolveContestedOwners } from "../apps/api/src/services/meta-oauth/meta-channels.service";

const GRAPH = "https://graph.facebook.com/v21.0";
/** Meta rejects a span of 94+ days with "Invalid parameter". */
const MAX_SPAN_DAYS = 93;

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const CONFIRM_PROD = args.includes("--confirm-prod");
const DAYS = Number(args.find((a) => a.startsWith("--days="))?.split("=")[1] ?? 93);

interface Point { date: string; followers: number }

async function fetchFollowerCurve(pageId: string, token: string, days: number): Promise<Point[]> {
  const out = new Map<string, number>();
  const todayUtc = Math.floor(Date.now() / 86_400_000) * 86_400;

  // Walk backwards in <=93-day chunks; one request cannot span more.
  for (let offset = 0; offset < days; offset += MAX_SPAN_DAYS) {
    const span = Math.min(MAX_SPAN_DAYS, days - offset);
    const until = todayUtc - offset * 86_400;
    const since = until - span * 86_400;
    const u = new URL(`${GRAPH}/${pageId}/insights`);
    u.searchParams.set("metric", "page_follows");
    u.searchParams.set("period", "day");
    u.searchParams.set("since", String(since));
    u.searchParams.set("until", String(until));
    u.searchParams.set("access_token", token);

    const res = await fetch(u.toString());
    const body: any = await res.json().catch(() => ({}));
    if (body?.error) {
      // Fail soft per chunk: an older window may be unavailable while recent
      // ones are fine, and a partial curve is still worth writing.
      console.warn(`    chunk -${offset}d failed: ${String(body.error.message).slice(0, 90)}`);
      continue;
    }
    for (const v of body?.data?.[0]?.values ?? []) {
      const n = Number(v?.value);
      // ⚠️ Skip non-positive values rather than writing them. A 0 here means Meta
      // published nothing for that day, and a Page with 16m followers recorded as
      // having had 0 would render as a catastrophic collapse in the growth chart.
      if (!Number.isFinite(n) || n <= 0) continue;
      const date = String(v?.end_time ?? "").slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(date)) out.set(date, Math.round(n));
    }
  }
  return [...out.entries()].map(([date, followers]) => ({ date, followers })).sort((a, b) => a.date.localeCompare(b.date));
}

async function main() {
  const isProd = (process.env.DATABASE_URL ?? "").includes("dashmani_prod");
  if (APPLY && isProd && !CONFIRM_PROD) {
    console.error("Refusing to write to production without --confirm-prod.");
    process.exit(1);
  }
  console.log(`Mode: ${APPLY ? "APPLY" : "DRY RUN"} | days=${DAYS} | db=${isProd ? "PROD" : "local"}\n`);

  const assets = await prisma.metaAsset.findMany({
    where: {
      kind: "FACEBOOK_PAGE",
      disconnectedAt: null,
      socialAccountId: { not: null },
      pageTokenEnc: { not: null },
    },
    select: { id: true, name: true, metaId: true, pageTokenEnc: true, socialAccountId: true },
    orderBy: { followerCount: "desc" },
  });
  // ⚠️ Two different Pages sharing a name can be linked to ONE channel row (three
  // such collisions on prod). Both would write to the same (accountId, date) key
  // and the last one would win at random, so only the owning asset backfills.
  const owners = await resolveContestedOwners();
  const eligible = assets.filter((a) => {
    const owner = owners.get(a.socialAccountId!);
    if (owner !== undefined && owner !== a.id) {
      console.log(`  ${String(a.name).slice(0,28).padEnd(29)} skipped — shares its channel row with a larger Page`);
      return false;
    }
    return true;
  });
  console.log(`${eligible.length} of ${assets.length} connected Facebook Pages own their channel row\n`);

  let written = 0, skipped = 0, failed = 0;
  for (const a of eligible) {
    let token: string;
    try { token = decryptToken(a.pageTokenEnc!); }
    catch { console.warn(`  ${a.name}: page token unreadable`); failed++; continue; }

    let curve: Point[];
    try { curve = await fetchFollowerCurve(a.metaId, token, DAYS); }
    catch (e) { console.warn(`  ${a.name}: ${String(e).slice(0, 90)}`); failed++; continue; }

    if (curve.length === 0) { console.log(`  ${String(a.name).slice(0,28).padEnd(29)} no data`); skipped++; continue; }

    console.log(`  ${String(a.name).slice(0,28).padEnd(29)} ${String(curve.length).padStart(3)} days  ${curve[0].date} ${curve[0].followers.toLocaleString()} -> ${curve[curve.length-1].date} ${curve[curve.length-1].followers.toLocaleString()}`);

    if (!APPLY) { written += curve.length; continue; }

    for (const p of curve) {
      // Upsert on (accountId, date) and stamp source="api". This deliberately
      // OVERWRITES scraper-era rows: replacing an unverifiable number with Meta's
      // own figure for the same day is the entire point.
      try {
        await prisma.accountGrowthSnapshot.upsert({
          where: { accountId_date: { accountId: a.socialAccountId!, date: istMidnight(p.date) } },
          create: { accountId: a.socialAccountId!, date: istMidnight(p.date), followerCount: p.followers, source: "api" },
          update: { followerCount: p.followers, source: "api" },
        });
        written++;
      } catch (e) {
        console.warn(`    ${p.date} write failed: ${String(e).slice(0, 80)}`);
        failed++;
      }
    }
  }

  console.log(`\n${APPLY ? "Wrote" : "Would write"} ${written} snapshots | ${skipped} pages with no data | ${failed} failures`);
  if (!APPLY) console.log("Re-run with --apply --confirm-prod to write.");
  await prisma.$disconnect();
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
