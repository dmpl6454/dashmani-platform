/**
 * scripts/seed-sales-role.ts — add the `sales` permission resource and the "Sales" role to a
 * database WITHOUT running the full seed (which resets the bootstrap accounts' passwords).
 *
 *   cd packages/db && npx tsx ../../scripts/seed-sales-role.ts
 *
 * Idempotent: roles and permission rows are upserted; nothing is removed, no user is touched.
 * Mirrors the grants in packages/db/prisma/seed.ts — keep the two in step.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const ACTIONS = ["view", "create", "edit", "delete", "approve", "export", "manage"];

async function grant(roleName: string, perms: Array<{ resource: string; action: string; scope: string }>, create?: { description: string }) {
  let role = await prisma.role.findUnique({ where: { name: roleName } });
  if (!role) {
    if (!create) { console.log(`  ${roleName}: role missing — skipped`); return; }
    role = await prisma.role.create({ data: { name: roleName, description: create.description, isSystemRole: true } });
    console.log(`  ${roleName}: role created`);
  }
  let added = 0;
  for (const p of perms) {
    const r = await prisma.rolePermission.upsert({
      where: { roleId_resource_action_scope: { roleId: role.id, resource: p.resource, action: p.action, scope: p.scope } },
      update: {},
      create: { roleId: role.id, ...p },
    });
    if (r) added++;
  }
  console.log(`  ${roleName}: ${perms.length} grants ensured`);
}

async function main() {
  console.log("seeding the sales permission + Sales role");
  await grant("Super Admin", ACTIONS.map((action) => ({ resource: "sales", action, scope: "global" })));
  await grant("Admin", ACTIONS.map((action) => ({ resource: "sales", action, scope: "global" })));
  await grant(
    "Sales",
    [
      ...["view", "create", "edit", "export", "manage"].map((action) => ({ resource: "sales", action, scope: "global" })),
      { resource: "clients", action: "view", scope: "global" },
      { resource: "clients", action: "create", scope: "global" },
      { resource: "clients", action: "edit", scope: "global" },
      { resource: "accounts", action: "view", scope: "global" },
    ],
    { description: "Sales portal: inventory, quotes, orders, invoices and payments" },
  );
  const n = await prisma.rolePermission.count({ where: { resource: "sales" } });
  console.log(`done — ${n} sales permission rows in total`);
}

main().then(() => prisma.$disconnect()).catch((e) => { console.error(e); prisma.$disconnect(); process.exit(1); });
