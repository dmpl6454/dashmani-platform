/**
 * create-admin.ts — create (or reset) an internal-portal Super Admin.
 *
 * The password is read from the ADMIN_PASSWORD env var so it never lands in the repo or in
 * shell history as an argument. An existing user with the email (matched case-insensitively,
 * the platform's email rule) gets the new password, status ACTIVE and the Super Admin role;
 * otherwise a new user is created.
 *
 * DRY RUN BY DEFAULT: it prints what it would do and writes nothing. Writing needs BOTH
 * `--apply` and `--confirm-prod`.
 *
 *   cd packages/db && ADMIN_PASSWORD='…' npx tsx ../../scripts/create-admin.ts --email=a@x.com --name="A Person"
 *   cd packages/db && ADMIN_PASSWORD='…' npx tsx ../../scripts/create-admin.ts --email=a@x.com --name="A Person" --apply --confirm-prod
 *
 * Requires the "Super Admin" role (created by `npm run db:seed`).
 */
import { prisma } from "@dashmani/db";
import { hash } from "bcrypt";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const confirm = process.argv.includes("--confirm-prod");
  if (apply && !confirm) {
    console.error("Refusing to write without --confirm-prod (writing needs --apply --confirm-prod).");
    process.exit(2);
  }

  const email = arg("email")?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error("--email=<address> is required.");
    process.exit(2);
  }
  if (!password || password.length < 8) {
    console.error("ADMIN_PASSWORD env var is required (at least 8 characters).");
    process.exit(2);
  }
  const name = arg("name")?.trim() || email.split("@")[0].replace(/^./, (c) => c.toUpperCase());

  const role = await prisma.role.findUnique({ where: { name: "Super Admin" } });
  if (!role) {
    console.error('The "Super Admin" role does not exist — run the seed first.');
    process.exit(1);
  }

  const matches = await prisma.user.findMany({
    where: { email: { equals: email, mode: "insensitive" } },
    select: { id: true, name: true, email: true, status: true, deletedAt: true },
  });
  if (matches.length > 1) {
    console.error(`More than one user matches ${email}: ${matches.map((u) => u.email).join(", ")}. Nothing written.`);
    process.exit(1);
  }
  const existing = matches[0];

  if (existing) {
    console.log(`Existing user ${existing.email} (${existing.name}, ${existing.status}${existing.deletedAt ? ", DELETED" : ""}):`);
    console.log("  → reset password, set ACTIVE, restore if deleted, grant Super Admin.");
  } else {
    console.log(`New user ${email} (${name}): create ACTIVE with Super Admin.`);
  }

  if (!(apply && confirm)) {
    console.log("DRY-RUN — re-run with --apply --confirm-prod to write.");
    return;
  }

  const passwordHash = await hash(password, 12);
  const user = existing
    ? await prisma.user.update({
        where: { id: existing.id },
        data: { passwordHash, status: "ACTIVE", deletedAt: null },
      })
    : await prisma.user.create({ data: { name, email, passwordHash, status: "ACTIVE" } });

  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: user.id, roleId: role.id } },
    update: {},
    create: { userId: user.id, roleId: role.id },
  });

  console.log(`APPLIED — ${user.email} is a Super Admin (id ${user.id}).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
