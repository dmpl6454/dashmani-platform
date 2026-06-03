/**
 * One-time backfill: set report_links.first_seen_at = created_at for every row.
 *
 * Why: firstSeenAt was added with @default(now()), so the db:push that created
 * the column stamped every PRE-EXISTING row with the push moment — which is
 * wrong. createdAt is the best available proxy for when a historical link was
 * first submitted (it's the last-edit time, but it predates the push). This
 * script resets first_seen_at to created_at for all rows.
 *
 * Idempotent and safe to re-run: it always sets first_seen_at := created_at.
 * After this runs once post-deploy, NEW links get their true first-submission
 * time via the preserve-across-resubmit logic in submitDailyReport(); only rows
 * created before the deploy carry the createdAt approximation.
 *
 * Usage locally:
 *   cd packages/db && npx tsx prisma/backfill-first-seen.ts
 *
 * Usage on prod (only when this feature is deployed there — NOT yet):
 *   ssh linode
 *   cd /opt/dashmani-platform/packages/db
 *   npx tsx prisma/backfill-first-seen.ts
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const before = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT COUNT(*)::bigint AS count FROM report_links`,
  );
  const total = Number(before[0]?.count ?? 0n);
  console.log(`report_links rows: ${total}`);

  const updated = await prisma.$executeRawUnsafe(
    `UPDATE report_links SET first_seen_at = created_at`,
  );
  console.log(`Backfilled first_seen_at = created_at on ${updated} row(s).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });