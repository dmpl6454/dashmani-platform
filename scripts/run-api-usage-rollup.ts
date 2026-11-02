/**
 * The api_usage rollup, run by hand over EVERY rollable day (the nightly job does at most
 * ROLLUP_MAX_DAYS_PER_RUN). Used by scripts/compact-usage-tables.sh for the first catch-up after
 * the keep window dropped from 90 to 14 days. Idempotent.
 *
 *   cd packages/db && npx tsx ../../scripts/run-api-usage-rollup.ts            # sizes only
 *   cd packages/db && npx tsx ../../scripts/run-api-usage-rollup.ts --apply
 */
import { prisma } from "@dashmani/db";
import { rollupApiUsage } from "../apps/api/src/services/api-usage-rollup.service";

async function size(label: string) {
  const [r] = await prisma.$queryRaw<Array<{ rows: bigint; size: string }>>`
    SELECT count(*)::bigint AS rows, pg_size_pretty(pg_total_relation_size('api_usage')) AS size FROM api_usage`;
  console.log(`${label}: ${r.rows} rows, ${r.size}`);
}

async function main() {
  await size("api_usage before");
  if (!process.argv.includes("--apply")) {
    console.log("dry run — pass --apply to roll up every day older than the keep window");
    return;
  }
  const t0 = Date.now();
  const r = await rollupApiUsage({ maxDays: 1000 });
  console.log(`rolled ${r.days.length} days before ${r.cutoffDay}: rows ${r.rowsBefore} -> ${r.rowsAfter} (${Math.round((Date.now() - t0) / 1000)}s)`);
  await size("api_usage after (space returned only by VACUUM FULL)");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
