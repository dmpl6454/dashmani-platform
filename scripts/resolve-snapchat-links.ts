/**
 * Backfill: resolve historical snapchat.com/t/<code> share links in report_links to
 * clean https://www.snapchat.com/spotlight/<id> URLs via a redirect probe.
 *
 * WHY: the submit-time resolver (resolveSnapchatShareUrl in snapchat.provider.ts,
 * shipped in Task 6) was added AFTER ~124 /t/ rows were already stored. Those rows
 * are unkeyable by the insights pipeline (extractSnapchatSpotlightId returns null
 * for an unresolved /t/ share → the cron's extractTargetId skips them). This one-off
 * backfill canonicalizes the historical rows so the insights pipeline can pick them
 * up on its next run.
 *
 * BEHAVIOUR:
 *   • Selects report_links where url CONTAINS 'snapchat.com/t/' (case-insensitive).
 *   • For each row, does ONE unauthenticated redirect probe via resolveSnapchatShareUrl.
 *   • On a resolved Spotlight URL → updates report_links.url (--apply only). Idempotent:
 *     re-running skips rows that no longer match the /t/ filter.
 *   • On null result (ephemeral Story /p/<uuid>/<storyId>, or unresolvable) → the row
 *     is LEFT UNTOUCHED — a Story has no scrapeable Spotlight stats, so there's nothing
 *     to canonicalize it to.
 *   • On a unique-constraint violation (URL already exists — unlikely, no unique index
 *     on url, but defensive) → logs and skips without crashing.
 *   • Per-row try/catch — one bad row never aborts the batch.
 *
 * POLITENESS: Snapchat sees all probes from ONE server IP. The default concurrency
 * is 3 parallel requests with a 300ms delay between batches (mirrors the FB script's
 * philosophy of not hammering the target's servers, even though the Snapchat scraper
 * module used by the cron path has its own separate rate-limiting — this script is a
 * one-off tool with its own pacing). Adjust via env: SNAP_RESOLVE_CONCURRENCY (default
 * 3), SNAP_RESOLVE_DELAY_MS (default 300).
 *
 * DEDUP NOTE: this script updates url strings only. It does NOT attempt to merge rows
 * that may resolve to the same clean URL — that is handled by the canonicalKey logic
 * in the insights/entity-search pipelines. Never merge or delete rows here.
 *
 * Run from packages/db (so @dashmani/db auto-loads packages/db/.env):
 *   cd packages/db && npx tsx ../../scripts/resolve-snapchat-links.ts
 *   cd packages/db && npx tsx ../../scripts/resolve-snapchat-links.ts --apply --confirm-prod
 *   cd packages/db && npx tsx ../../scripts/resolve-snapchat-links.ts --apply --confirm-prod --limit=50
 *   cd packages/db && npx tsx ../../scripts/resolve-snapchat-links.ts --apply --confirm-prod --concurrency=5 --delay=100
 */

import { prisma } from "@dashmani/db";
import { resolveSnapchatShareUrl } from "../apps/api/src/services/social-insights/snapchat.provider";

// ── CLI flags ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const CONFIRM_PROD = args.includes("--confirm-prod");
const limitArg = args.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? Math.max(0, parseInt(limitArg.slice("--limit=".length), 10) || 0) : 0; // 0 = no cap
const concurrencyArg = args.find((a) => a.startsWith("--concurrency="));
const delayArg = args.find((a) => a.startsWith("--delay="));

// Default concurrency 3, delay 300ms — polite for the ~124-row scale (this is a
// much smaller backfill than the FB one, so glacial pacing costs almost nothing
// wall-clock while staying courteous to Snapchat's servers).
const CONCURRENCY = concurrencyArg
  ? Math.max(1, Math.min(10, parseInt(concurrencyArg.slice("--concurrency=".length), 10) || 3))
  : Number(process.env.SNAP_RESOLVE_CONCURRENCY) || 3;
const DELAY_MS = delayArg
  ? Math.max(0, parseInt(delayArg.slice("--delay=".length), 10) || 300)
  : Number(process.env.SNAP_RESOLVE_DELAY_MS) || 300;

const PAGE_SIZE = 200;
const SAMPLE_PRINT = 20; // how many dry-run samples to display

// ── Share-URL predicate ───────────────────────────────────────────────────────
function isShareUrl(url: string): boolean {
  return url.toLowerCase().includes("snapchat.com/t/");
}

// ── Sleep helper ─────────────────────────────────────────────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Process a batch of rows concurrently (bounded concurrency) ───────────────
async function processBatch(
  rows: Array<{ id: string; url: string | null }>,
  stats: { resolved: number; unresolvable: number; errors: number; skipped: number }
): Promise<void> {
  // Work through rows CONCURRENCY at a time, inserting DELAY_MS between groups.
  for (let start = 0; start < rows.length; start += CONCURRENCY) {
    const group = rows.slice(start, start + CONCURRENCY);

    await Promise.all(
      group.map(async (row) => {
        if (!row.url) {
          stats.skipped++;
          return;
        }
        try {
          const cleanUrl = await resolveSnapchatShareUrl(row.url);
          if (!cleanUrl) {
            // Ephemeral Story or unresolvable — no Spotlight id, leave untouched.
            stats.unresolvable++;
            return;
          }
          // APPLY: write the clean URL back to the row.
          try {
            await prisma.reportLink.update({
              where: { id: row.id },
              data: { url: cleanUrl },
            });
            stats.resolved++;
          } catch (updateErr: unknown) {
            // Defensive: handle a potential unique conflict (no unique index on url,
            // but a future schema change or race could produce one). Log + skip, never crash.
            const msg = updateErr instanceof Error ? updateErr.message : String(updateErr);
            if (msg.includes("Unique constraint") || msg.includes("unique constraint")) {
              console.warn(`  [SKIP] unique conflict on id=${row.id} url=${cleanUrl} — skipping`);
              stats.skipped++;
            } else {
              console.error(`  [ERROR] update failed for id=${row.id}: ${msg}`);
              stats.errors++;
            }
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`  [ERROR] resolveSnapchatShareUrl threw for id=${row.id} url=${row.url}: ${msg}`);
          stats.errors++;
        }
      })
    );

    // Delay between concurrency groups (not after the final group of the batch).
    if (start + CONCURRENCY < rows.length && DELAY_MS > 0) {
      await sleep(DELAY_MS);
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  // Count total share-link rows.
  const total = await prisma.reportLink.count({
    where: { url: { contains: "snapchat.com/t/", mode: "insensitive" } },
  });

  console.log("\n=== resolve-snapchat-links backfill ===");
  console.log(`snapchat.com/t/ rows: ${total}`);
  console.log(`Mode: ${APPLY ? "APPLY" : "DRY-RUN"}`);
  if (LIMIT > 0) console.log(`Limit: ${LIMIT} rows`);
  console.log(`Concurrency: ${CONCURRENCY} | Delay between groups: ${DELAY_MS}ms`);

  if (!APPLY) {
    // Dry-run: show a sample of what would change.
    const sample = await prisma.reportLink.findMany({
      where: { url: { contains: "snapchat.com/t/", mode: "insensitive" } },
      select: { id: true, url: true },
      take: SAMPLE_PRINT,
      orderBy: { createdAt: "asc" },
    });
    const cap = LIMIT > 0 ? Math.min(LIMIT, total) : total;
    console.log(`\n[DRY-RUN] Would probe up to ${cap} rows. No changes made.`);
    if (sample.length > 0) {
      console.log(`\nSample (first ${sample.length} of ${total} share-link rows):`);
      for (const r of sample) {
        console.log(`  id=${r.id}  url=${r.url}`);
      }
    }
    console.log("\nRe-run with --apply --confirm-prod to write.\n");
    return;
  }

  if (!CONFIRM_PROD) {
    console.error("\n[ERROR] --apply requires --confirm-prod to prevent accidental writes.");
    console.error("Run: cd packages/db && npx tsx ../../scripts/resolve-snapchat-links.ts --apply --confirm-prod\n");
    process.exitCode = 1;
    return;
  }

  if (total === 0) {
    console.log("\nNo snapchat.com/t/ rows found. Nothing to do.");
    return;
  }

  console.log("\n[APPLY] Processing share-link rows...\n");

  const stats = { resolved: 0, unresolvable: 0, errors: 0, skipped: 0 };
  let scanned = 0;
  let cursor: string | undefined;

  // Page through share-link rows. Because we UPDATE url on success (row leaves the
  // /t/ set), we CAN'T paginate by offset — rows shift out of the result set
  // mid-scan. Instead we page using a stable cursor (id ASC) and re-query after
  // each batch. Already-resolved rows fall out of the WHERE filter automatically
  // → idempotent.
  for (;;) {
    if (LIMIT > 0 && scanned >= LIMIT) {
      console.log(`\nReached --limit cap (${LIMIT}). Stopping.`);
      break;
    }

    const take = LIMIT > 0 ? Math.min(PAGE_SIZE, LIMIT - scanned) : PAGE_SIZE;

    // Use cursor-based pagination keyed on id (stable, never changes) to avoid
    // offset drift. Skip 1 on subsequent pages to move past the last seen id.
    const rows = await prisma.reportLink.findMany({
      where: {
        url: { contains: "snapchat.com/t/", mode: "insensitive" },
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      select: { id: true, url: true },
      take,
      orderBy: { id: "asc" },
    });

    if (rows.length === 0) break;

    // Validate predicate client-side (the Prisma contains filter is correct, but
    // belt-and-suspenders: skip any row whose url doesn't match the share pattern).
    const shares = rows.filter((r) => r.url && isShareUrl(r.url));
    const filtered = rows.length - shares.length;
    if (filtered > 0) {
      stats.skipped += filtered;
    }

    await processBatch(shares, stats);

    scanned += rows.length;
    cursor = rows[rows.length - 1].id;

    const total2 = await prisma.reportLink.count({
      where: { url: { contains: "snapchat.com/t/", mode: "insensitive" } },
    });
    console.log(
      `  scanned=${scanned}  resolved=${stats.resolved}  unresolvable=${stats.unresolvable}  errors=${stats.errors}  skipped=${stats.skipped}  remaining_share_links=${total2}`
    );

    // If all remaining share-link rows have already been visited (cursor past them), stop.
    if (rows.length < take) break;
  }

  console.log("\n=== Final summary ===");
  console.log(`  Total scanned      : ${scanned}`);
  console.log(`  Resolved (Spotlight): ${stats.resolved}`);
  console.log(`  Unresolvable (Story): ${stats.unresolvable}`);
  console.log(`  Errors             : ${stats.errors}`);
  console.log(`  Skipped            : ${stats.skipped}`);
  console.log("\nDone. The scheduled social-insights cron will pick up newly-resolved links on its next run.\n");
}

main()
  .catch((err: unknown) => {
    console.error("\n[FATAL] resolve-snapchat-links failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
