/**
 * One-off heal: un-poison link_content rows wrongly demoted to status='error'.
 *
 * BACKGROUND (2026-06-26): the old entity-extraction catch set status='error' on ANY
 * extraction failure — including a transient rate-limit / out-of-credit. When the
 * Anthropic account ran out of credit, 13k+ rows with PERFECTLY VALID captions were
 * demoted, hiding them from Link Search (which counts status='ok') and evicting them
 * from the retry queue (status='ok' AND extractedAt IS NULL). The service is now fixed
 * (a failure never demotes status); this script repairs the already-damaged rows.
 *
 * SAFE BY CONSTRUCTION:
 *  - Only flips rows that HAVE text (caption OR title) — verified live that EVERY
 *    status='error' row has a caption (FB 12,588 / IG 902 / YT 9, zero text-less). A
 *    genuinely text-less 'not_found' row is left untouched (it isn't 'error' anyway).
 *  - Sets status='ok' and LEAVES extractedAt as-is. The healed rows have extractedAt
 *    NULL (they never finished extraction) → they re-enter the retry queue and get
 *    re-tagged by the next extraction run.
 *  - Idempotent: re-running selects the shrinking 'error'+has-text set (→ 0 after a
 *    successful run). Non-destructive: only updates `status`, never deletes/nulls.
 *  - Dry-run by default; requires --apply --confirm-prod to write.
 *
 * Run from packages/db so Prisma loads its .env:
 *   cd packages/db && npx tsx ../../scripts/heal-error-link-content.ts            # dry run
 *   cd packages/db && npx tsx ../../scripts/heal-error-link-content.ts --apply --confirm-prod
 */
import { prisma } from "@dashmani/db";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const CONFIRM = args.includes("--confirm-prod");

// status='error' AND (caption present OR title present) — the wrongly-demoted set.
const HEAL_WHERE = {
  status: "error",
  OR: [{ caption: { not: null } }, { title: { not: null } }],
} as const;

async function main() {
  const byPlatform = await prisma.linkContent.groupBy({
    by: ["platform"],
    where: HEAL_WHERE,
    _count: { _all: true },
  });
  const total = byPlatform.reduce((a, b) => a + b._count._all, 0);
  const errorNoText = await prisma.linkContent.count({
    where: { status: "error", AND: [{ caption: null }, { title: null }] },
  });

  console.log("=== heal-error-link-content ===");
  console.log(`Rows to heal (status='error' AND has text): ${total}`);
  byPlatform.forEach((b) => console.log(`  ${b.platform}: ${b._count._all}`));
  console.log(`Left untouched (status='error', no text): ${errorNoText}`);

  if (!APPLY) {
    console.log("\n[DRY-RUN] no writes. Re-run with --apply --confirm-prod to heal.");
    return;
  }
  if (!CONFIRM) {
    console.error("\n[ERROR] --apply requires --confirm-prod (safety).");
    process.exitCode = 1;
    return;
  }
  if (total === 0) {
    console.log("\nNothing to heal.");
    return;
  }
  const r = await prisma.linkContent.updateMany({ where: HEAL_WHERE, data: { status: "ok" } });
  console.log(`\n[APPLY] Healed ${r.count} rows error→ok (extractedAt left as-is → re-enters extraction queue).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
