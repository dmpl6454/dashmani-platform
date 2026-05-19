/**
 * One-time backfill: assign the "Employee" role to every user who currently
 * has no roles. Skips users who already have at least one role (any role).
 * Safe to re-run — skips users that were already fixed.
 *
 * Run on production after deploy:
 *   ssh linode
 *   cd /opt/dashmani-platform/packages/db
 *   npx tsx prisma/backfill-employee-role.ts
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const employeeRole = await prisma.role.findUnique({ where: { name: "Employee" } });
  if (!employeeRole) {
    console.error("Employee role not found — run the seed first.");
    process.exit(1);
  }

  // Find all non-deleted users with zero role assignments
  const rolelessUsers = await prisma.user.findMany({
    where: {
      deletedAt: null,
      roles: { none: {} },
    },
    select: { id: true, name: true, email: true, status: true },
  });

  if (rolelessUsers.length === 0) {
    console.log("No roleless users found — nothing to do.");
    return;
  }

  console.log(`Found ${rolelessUsers.length} roleless user(s):`);
  for (const u of rolelessUsers) {
    console.log(`  ${u.name} <${u.email}> [${u.status}]`);
  }

  const result = await prisma.userRole.createMany({
    data: rolelessUsers.map((u) => ({ userId: u.id, roleId: employeeRole.id })),
    skipDuplicates: true,
  });

  console.log(`\nAssigned Employee role to ${result.count} user(s).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
