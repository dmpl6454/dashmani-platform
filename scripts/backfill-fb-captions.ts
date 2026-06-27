/**
 * One-off backfill: capture Facebook reel CAPTIONS (+ engagement) for historical
 * clean /reel/<numericId> links, via the public-reel scraper — CONCURRENTLY.
 *
 * WHY A SEPARATE SCRIPT (not enrich-link-content.ts)
 * --------------------------------------------------
 * enrich-link-content.ts drives links through the cron's provider.fetchBatch,
 * which (a) rebuilds the administered-Pages feed-map once PER 50-reel batch and
 * (b) scrapes strictly sequentially with the cron's 250ms politeness delay. For a
 * 17k-reel historical backfill that measured ~200 reels/hr (~89h) on prod — far
 * too slow, and it collides with every 6h cron run.
 *
 * External reels are NOT on Pages we administer, so the Graph/feed-map path can
 * never resolve them — only the scraper can. So this script SKIPS Graph entirely
 * and calls scrapeFacebookReelEngagement() directly, in a small CONCURRENCY POOL.
 * The scrape is I/O-bound (~2.8s waiting on FB per reel, verified from the Linode
 * IP), so a pool of ~6 turns ~18h into ~2-3h while staying polite. Proven 40/40
 * first-try from the Linode datacenter IP (the scraper's home).
 *
 * WHAT IT DOES
 * ------------
 * 1. Select distinct clean fb:<numericId> canonicalKeys from submitted FB reels
 *    (URL host-matched, NOT the dirty platform column) that are NOT already ok.
 * 2. Scrape each (concurrency POOL) → upsert link_content(status='ok', caption)
 *    when a caption is found; mark 'not_found' when the scraper returns nothing
 *    (so we don't retry it forever). Engagement (views/likes/comments) is also
 *    surfaced by the scraper and picked up by the cron going forward.
 * 3. Wall short-circuit: if too many consecutive scrapes come back walled
 *    (login/checkpoint), STOP — looks like an IP block; never hammer.
 *
 * SAFETY
 * ------
 * - DRY-RUN BY DEFAULT. --apply to write.
 * - Fail-open: a scrape error/timeout for one reel never aborts the run.
 * - Idempotent: skips keys already status='ok'; re-running fills the rest.
 * - Run in the social-insights cron's idle window (cron runs 00:21/06:21/12:21/18:21
 *   UTC, ~1h each) so the shared Linode IP isn't double-loaded.
 * - Kill switch honored: FB_SCRAPER_ENABLED=0 → does nothing.
 *
 * Usage (from packages/db so DATABASE_URL loads):
 *   cd packages/db && npx tsx ../../scripts/backfill-fb-captions.ts                  # dry-run
 *   cd packages/db && npx tsx ../../scripts/backfill-fb-captions.ts --apply          # write
 *   cd packages/db && npx tsx ../../scripts/backfill-fb-captions.ts --apply --concurrency=6 --delay=200
 */

import { prisma } from "@dashmani/db";
import { canonicalKey } from "@dashmani/shared";
import { scrapeFacebookReelEngagement } from "../apps/api/src/services/social-insights/facebook-scraper";
import { upsertLinkContent } from "../apps/api/src/services/link-content.service";

const APPLY = process.argv.includes("--apply");
const CONCURRENCY = Math.max(1, Math.min(10, Number(process.argv.find((a) => a.startsWith("--concurrency="))?.split("=")[1]) || 6));
const DELAY_MS = Number(process.argv.find((a) => a.startsWith("--delay="))?.split("=")[1]) || 200;
const LIMIT = Number(process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1]) || 0; // 0 = all
const WALL_LIMIT = 8; // consecutive walls → stop (looks like an IP block)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (process.env.FB_SCRAPER_ENABLED === "0") {
    console.log("FB_SCRAPER_ENABLED=0 — scraper disabled, nothing to do.");
    await prisma.$disconnect();
    return;
  }
  console.log(`\nbackfill-fb-captions — mode: ${APPLY ? "APPLY" : "DRY-RUN"}  concurrency: ${CONCURRENCY}  delay: ${DELAY_MS}ms`);

  // 1. Clean numeric FB reels from submitted links (host-matched, not platform col).
  const links = await prisma.reportLink.findMany({
    where: {
      isScheduled: false,
      OR: [
        { url: { contains: "facebook.com", mode: "insensitive" } },
        { url: { contains: "fb.watch", mode: "insensitive" } },
        { url: { contains: "fb.me", mode: "insensitive" } },
      ],
    },
    select: { url: true },
  });

  // Distinct fb:<numericId> keys (canonicalKey rejects opaque /share/+pfbid → skipped).
  const keyToId = new Map<string, string>();
  for (const l of links) {
    if (!l.url) continue;
    const key = canonicalKey(l.url);
    if (!key || !key.startsWith("fb:")) continue;
    const id = key.slice(3);
    if (!/^\d+$/.test(id)) continue; // numeric-only — scraper URL needs a numeric reel id
    keyToId.set(key, id);
  }
  console.log(`distinct clean numeric FB reels: ${keyToId.size}`);

  // 2. Skip keys already ok.
  const allKeys = [...keyToId.keys()];
  const okRows = allKeys.length
    ? await prisma.linkContent.findMany({ where: { canonicalKey: { in: allKeys }, status: "ok" }, select: { canonicalKey: true } })
    : [];
  const okSet = new Set(okRows.map((r) => r.canonicalKey));
  let todo = allKeys.filter((k) => !okSet.has(k));
  if (LIMIT > 0) todo = todo.slice(0, LIMIT);
  console.log(`already ok: ${okSet.size}  to scrape: ${todo.length}`);

  if (!APPLY) {
    console.log("\nDRY-RUN — no rows written. Re-run with --apply.");
    await prisma.$disconnect();
    return;
  }
  if (todo.length === 0) {
    console.log("nothing to do.");
    await prisma.$disconnect();
    return;
  }

  // 3. Concurrency pool. A shared cursor index hands out work; WALL_LIMIT consecutive
  //    walls trips a global stop. Counters are plain numbers (single-threaded JS).
  let next = 0;
  let okCount = 0;
  let notFound = 0;
  let walled = 0;
  let consecutiveWalls = 0;
  let stopped = false;
  let done = 0;

  async function worker(): Promise<void> {
    while (!stopped) {
      const i = next++;
      if (i >= todo.length) return;
      const key = todo[i];
      const id = keyToId.get(key)!;
      try {
        const eng = await scrapeFacebookReelEngagement(id);
        if (eng.walled) {
          walled++;
          consecutiveWalls++;
          if (consecutiveWalls >= WALL_LIMIT) {
            stopped = true;
            console.warn(`\n⚠️  ${WALL_LIMIT} consecutive walls — stopping (looks like an IP block).`);
          }
        } else {
          consecutiveWalls = 0;
          if (eng.caption != null && eng.caption.trim() !== "") {
            await upsertLinkContent({ canonicalKey: key, title: null, caption: eng.caption, status: "ok" });
            okCount++;
          } else {
            // Scraper reached the page but found no caption → record not_found so we
            // don't re-scrape it every run. (Engagement-only reels with no text.)
            await upsertLinkContent({ canonicalKey: key, status: "not_found" });
            notFound++;
          }
        }
      } catch (err) {
        // Fail-open: a single reel error never aborts the run.
        console.error(`  [fb] scrape failed for ${key}:`, err instanceof Error ? err.message : err);
      }
      done++;
      if (done % 200 === 0) {
        console.log(`  progress: ${done}/${todo.length}  ok=${okCount} notFound=${notFound} walled=${walled}`);
      }
      if (DELAY_MS > 0) await sleep(DELAY_MS);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  console.log(`\n=== summary === scraped=${done}  ok=${okCount}  notFound=${notFound}  walled=${walled}  stopped=${stopped}`);
  console.log("Newly-captured captions still need entity-extraction before they're searchable BY NAME.");
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("backfill-fb-captions failed:", err);
  await prisma.$disconnect();
  process.exit(1);
});
