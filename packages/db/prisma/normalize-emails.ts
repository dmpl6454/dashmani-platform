/**
 * One-time backfill: lowercase every email in users / clients / admin_invites /
 * client_invites. Safe to run more than once — idempotent. Detects collisions
 * (two rows that lowercase to the same email) and reports them without
 * touching the DB so an admin can resolve manually.
 *
 * Usage on prod:
 *   ssh linode
 *   cd /opt/dashmani-platform/packages/db
 *   npx tsx prisma/normalize-emails.ts
 *
 * Usage locally:
 *   cd packages/db && npx tsx prisma/normalize-emails.ts
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function normalizeTable<T extends { id: string; email: string }>(
  label: string,
  rows: T[],
  updateFn: (id: string, email: string) => Promise<unknown>,
) {
  let mutated = 0;
  let alreadyOk = 0;
  const collisions: Array<{ a: T; b: T }> = [];

  // Group by normalized email to detect collisions before we write.
  const byNormalized = new Map<string, T[]>();
  for (const row of rows) {
    const norm = row.email.trim().toLowerCase();
    const bucket = byNormalized.get(norm) || [];
    bucket.push(row);
    byNormalized.set(norm, bucket);
  }

  for (const [norm, bucket] of byNormalized) {
    if (bucket.length > 1) {
      // Multiple rows would collide on the unique constraint after normalization.
      for (let i = 1; i < bucket.length; i++) {
        collisions.push({ a: bucket[0], b: bucket[i] });
      }
      continue;
    }
    const [row] = bucket;
    if (row.email === norm) {
      alreadyOk++;
      continue;
    }
    await updateFn(row.id, norm);
    mutated++;
  }

  console.log(`[${label}] normalized=${mutated}, already_ok=${alreadyOk}, collisions=${collisions.length}`);
  if (collisions.length > 0) {
    console.warn(`[${label}] COLLISIONS — these rows share an email when lowercased and must be resolved by hand:`);
    for (const c of collisions) {
      console.warn(`  - ${c.a.id} (${c.a.email}) vs ${c.b.id} (${c.b.email})`);
    }
  }
}

async function main() {
  // users
  const users = await prisma.user.findMany({ select: { id: true, email: true } });
  await normalizeTable("users", users, async (id, email) => {
    await prisma.user.update({ where: { id }, data: { email } });
  });

  // clients
  const clients = await prisma.client.findMany({ select: { id: true, email: true } });
  await normalizeTable("clients", clients, async (id, email) => {
    await prisma.client.update({ where: { id }, data: { email } });
  });

  // admin_invites
  const adminInvites = await prisma.adminInvite.findMany({ select: { id: true, email: true } });
  await normalizeTable("admin_invites", adminInvites, async (id, email) => {
    await prisma.adminInvite.update({ where: { id }, data: { email } });
  });

  // client_invites
  const clientInvites = await prisma.clientInvite.findMany({ select: { id: true, email: true } });
  await normalizeTable("client_invites", clientInvites, async (id, email) => {
    await prisma.clientInvite.update({ where: { id }, data: { email } });
  });

  console.log("\nDone.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
