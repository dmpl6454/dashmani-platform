/**
 * Stage 2 backfill: extract canonical entities (people/topics) from already-enriched
 * LinkContent rows (status='ok' AND extractedAt IS NULL) via Claude Haiku.
 *
 * This is the manual counterpart to the 6h entity-extraction cron. It shares the SAME
 * service (extractEntitiesFromContent) so behaviour is identical: idempotent (a row that
 * succeeds is stamped extractedAt and never reprocessed; a parse/LLM failure flips the
 * row to status='error' and is excluded by the status='ok' selector → no re-pay).
 *
 * Usage (run from packages/db so @dashmani/db's .env / DATABASE_URL is picked up):
 *   cd packages/db && npx tsx ../../scripts/extract-entities.ts                       # DRY-RUN: count only, writes nothing
 *   cd packages/db && npx tsx ../../scripts/extract-entities.ts --apply --confirm-prod        # process ALL pending
 *   cd packages/db && npx tsx ../../scripts/extract-entities.ts --apply --confirm-prod --max=1000   # cap total processed
 *
 * Requires DEEPSEEK_API_KEY in the environment to actually extract (the dry-run still
 * reports the pending count even without a key).
 */
import { prisma } from "@dashmani/db";
import { extractEntitiesFromContent } from "../apps/api/src/services/entity-extraction.service";

const PAGE_SIZE = 200;

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const CONFIRM_PROD = args.includes("--confirm-prod");
const maxArg = args.find((a) => a.startsWith("--max="));
const MAX = maxArg ? Math.max(0, parseInt(maxArg.slice("--max=".length), 10) || 0) : 0; // 0 = no cap

const PENDING_WHERE = { status: "ok", extractedAt: null } as const;

async function main() {
  const pending = await prisma.linkContent.count({ where: PENDING_WHERE });
  const hasKey = !!process.env.DEEPSEEK_API_KEY;

  console.log("\n=== Stage 2 entity extraction backfill ===");
  console.log(`Pending (status='ok' AND extractedAt IS NULL): ${pending}`);
  console.log(`DEEPSEEK_API_KEY present: ${hasKey ? "yes" : "NO"}`);
  if (MAX > 0) console.log(`Max cap: ${MAX}`);

  if (!APPLY) {
    console.log("\n[DRY-RUN] No changes made. Re-run with --apply --confirm-prod to write.");
    if (MAX > 0) {
      console.log(`[DRY-RUN] Would process up to ${Math.min(MAX, pending)} of ${pending} pending row(s).`);
    } else {
      console.log(`[DRY-RUN] Would process all ${pending} pending row(s).`);
    }
    return;
  }

  if (!CONFIRM_PROD) {
    console.error("\n[ERROR] --apply requires --confirm-prod to prevent accidental writes.");
    console.error("Run: cd packages/db && npx tsx ../../scripts/extract-entities.ts --apply --confirm-prod\n");
    process.exitCode = 1;
    return;
  }

  if (!hasKey) {
    console.error("\n[ERROR] DEEPSEEK_API_KEY is not set — cannot extract. Aborting (no changes made).\n");
    process.exitCode = 1;
    return;
  }

  if (pending === 0) {
    console.log("\nNothing to extract. Done.");
    return;
  }

  console.log("\n[APPLY] Processing pending rows...");
  let processed = 0;
  let totalOk = 0;
  let totalEmpty = 0;
  let totalError = 0;

  // Page through pending rows. extractOne always advances a row out of the
  // pending set (success → extractedAt; failure → status='error'), so re-selecting
  // status='ok' AND extractedAt IS NULL each loop never re-fetches a processed row.
  for (;;) {
    if (MAX > 0 && processed >= MAX) {
      console.log(`\nReached --max cap (${MAX}). Stopping.`);
      break;
    }
    const take = MAX > 0 ? Math.min(PAGE_SIZE, MAX - processed) : PAGE_SIZE;
    const rows = await prisma.linkContent.findMany({
      where: PENDING_WHERE,
      select: { id: true, title: true, caption: true },
      take,
      orderBy: { fetchedAt: "asc" },
    });
    if (rows.length === 0) break;

    const res = await extractEntitiesFromContent(rows);
    processed += rows.length;
    totalOk += res.ok;
    totalEmpty += res.empty;
    totalError += res.error;

    const remaining = await prisma.linkContent.count({ where: PENDING_WHERE });
    console.log(
      `  page: ${rows.length} processed (ok ${res.ok}, empty ${res.empty}, error ${res.error}) — running totals: ${processed} processed, ${remaining} still pending`
    );
  }

  console.log(
    `\n[APPLY] Done — ${processed} processed total: ${totalOk} ok, ${totalEmpty} empty, ${totalError} error.`
  );
}

main()
  .catch((err) => {
    console.error("\n[FATAL] extract-entities failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
