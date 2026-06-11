/**
 * One-time backfill: for every user that has a primary team (users.org_unit_id
 * is set), ensure a matching team_memberships row exists with is_primary = true.
 *
 * This migrates the old single-team model (one org_unit_id column per user) onto
 * the new many-to-many TeamMembership join table WITHOUT losing any existing
 * membership. After this runs, every current single-team assignment is also
 * represented as a membership row, so the Teams page (which now reads from the
 * join table) shows exactly what it showed before — plus new multi-team
 * assignments going forward.
 *
 * Safe to run more than once — idempotent (upsert on the [userId, orgUnitId]
 * unique key). Does NOT touch users.org_unit_id, so all single-team read paths
 * (leaderboard, announcements, analytics) keep working off the primary team.
 *
 * Usage on prod (after `db:push` has created the team_memberships table):
 *   ssh linode
 *   cd /opt/dashmani-platform/packages/db
 *   npx tsx prisma/backfill-team-memberships.ts
 *
 * Usage locally:
 *   cd packages/db && npx tsx prisma/backfill-team-memberships.ts
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const users = await prisma.user.findMany({
    where: { orgUnitId: { not: null } },
    select: { id: true, orgUnitId: true, name: true },
  });

  console.log(`Found ${users.length} user(s) with a primary team to backfill.`);

  let created = 0;
  let alreadyOk = 0;

  for (const u of users) {
    const orgUnitId = u.orgUnitId!;
    const existing = await prisma.teamMembership.findUnique({
      where: { userId_orgUnitId: { userId: u.id, orgUnitId } },
    });

    if (existing) {
      // Make sure the membership mirroring the primary team is flagged primary.
      if (!existing.isPrimary) {
        await prisma.teamMembership.update({
          where: { id: existing.id },
          data: { isPrimary: true },
        });
        created++; // counts as a mutation
        console.log(`  • ${u.name}: marked existing membership as primary`);
      } else {
        alreadyOk++;
      }
      continue;
    }

    await prisma.teamMembership.create({
      data: { userId: u.id, orgUnitId, isPrimary: true },
    });
    created++;
    console.log(`  • ${u.name}: created primary membership`);
  }

  console.log(
    `\nDone. ${created} membership(s) created/updated, ${alreadyOk} already correct.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
