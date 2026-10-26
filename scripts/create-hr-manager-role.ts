/**
 * create-hr-manager-role.ts — create (or top up) the "HR Manager" role and its permissions.
 *
 * The role definition lives in packages/shared/src/constants/roles.ts (DEFAULT_ROLES.HR_MANAGER).
 * This only ADDS: it creates the role if missing and inserts any missing permission rows. It
 * never removes a permission and never touches any other role or any user.
 *
 * DRY RUN BY DEFAULT. Writing needs BOTH `--apply` and `--confirm-prod`.
 *
 *   cd packages/db && npx tsx ../../scripts/create-hr-manager-role.ts
 *   cd packages/db && npx tsx ../../scripts/create-hr-manager-role.ts --apply --confirm-prod
 *
 * After it runs, an admin assigns the role from Employees → (person) → Roles.
 */
import { prisma } from "@dashmani/db";
import { DEFAULT_ROLES } from "@dashmani/shared";

async function main() {
  const apply = process.argv.includes("--apply");
  const confirm = process.argv.includes("--confirm-prod");
  if (apply && !confirm) {
    console.error("Refusing to write without --confirm-prod (writing needs --apply --confirm-prod).");
    process.exit(2);
  }

  const def = DEFAULT_ROLES.HR_MANAGER;
  const role = await prisma.role.findUnique({
    where: { name: def.name },
    include: { permissions: true },
  });
  const have = new Set((role?.permissions ?? []).map((p) => `${p.resource}.${p.action}.${p.scope}`));
  const missing = def.permissions.filter((p) => !have.has(`${p.resource}.${p.action}.${p.scope}`));

  console.log(role ? `Role "${def.name}" exists (${role.permissions.length} permissions).` : `Role "${def.name}" does not exist — will create it.`);
  console.log(missing.length ? `Permissions to add (${missing.length}):` : "No permissions missing.");
  for (const p of missing) console.log(`  + ${p.resource}.${p.action}.${p.scope}`);

  if (!(apply && confirm)) {
    console.log("DRY-RUN — re-run with --apply --confirm-prod to write.");
    return;
  }

  const r = role ?? (await prisma.role.create({
    data: { name: def.name, description: def.description, isSystemRole: true },
  }));
  if (missing.length) {
    await prisma.rolePermission.createMany({
      data: missing.map((p) => ({ roleId: r.id, resource: p.resource, action: p.action, scope: p.scope })),
      skipDuplicates: true,
    });
  }
  console.log(`APPLIED — "${def.name}" (id ${r.id}) has ${have.size + missing.length} permissions.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
