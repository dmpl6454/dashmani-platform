/**
 * One-off: normalize social_accounts.handle by stripping any leading "@".
 *
 * A handle never legitimately starts with "@". A stray leading "@" (pasted from a
 * profile mention at creation time) renders as "@@handle" everywhere the UI
 * prepends its own "@" (spotted in Link Search: "@@BollywoodChronicle"). The write
 * boundary is now fixed (sanitizeAccountHandle strips leading "@"), so this only
 * cleans the EXISTING dirty rows.
 *
 * SAFETY: DRY-RUN by default; --apply to write. Idempotent (re-running is a no-op
 * once clean). Skips a rename that would COLLIDE with an existing
 * (handle, platformId) row — reports it for manual review instead of failing the
 * unique constraint. Never deletes; only updates the handle column.
 *
 * Usage:
 *   cd packages/db && npx tsx ../../scripts/normalize-account-handles.ts            # dry-run
 *   cd packages/db && npx tsx ../../scripts/normalize-account-handles.ts --apply
 */

import { prisma } from "@dashmani/db";

const APPLY = process.argv.includes("--apply");

async function main() {
  console.log(`\nnormalize-account-handles — mode: ${APPLY ? "APPLY" : "DRY-RUN"}`);

  const dirty = await prisma.socialAccount.findMany({
    where: { handle: { startsWith: "@" } },
    select: { id: true, handle: true, platformId: true, displayName: true },
  });
  console.log(`accounts with a leading '@' in handle: ${dirty.length}`);
  if (dirty.length === 0) {
    console.log("nothing to do.");
    await prisma.$disconnect();
    return;
  }

  let updated = 0;
  let collisions = 0;
  for (const a of dirty) {
    const clean = a.handle.replace(/^@+/, "");
    if (clean === a.handle) continue; // shouldn't happen given the filter
    // Would the cleaned handle collide with an existing row on (handle, platformId)?
    const clash = await prisma.socialAccount.findFirst({
      where: { handle: clean, platformId: a.platformId, id: { not: a.id } },
      select: { id: true },
    });
    if (clash) {
      collisions++;
      console.warn(`  COLLISION (manual review): "${a.displayName}" ${a.handle} → ${clean} clashes with account ${clash.id} on the same platform — skipped.`);
      continue;
    }
    console.log(`  ${APPLY ? "updating" : "would update"}: "${a.displayName}" ${a.handle} → ${clean}`);
    if (APPLY) {
      await prisma.socialAccount.update({ where: { id: a.id }, data: { handle: clean } });
      updated++;
    }
  }

  console.log(`\n=== summary === ${APPLY ? "updated" : "would update"}=${APPLY ? updated : dirty.length - collisions}  collisions(skipped)=${collisions}`);
  if (!APPLY) console.log("DRY-RUN — re-run with --apply to write.");
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("normalize-account-handles failed:", err);
  await prisma.$disconnect();
  process.exit(1);
});
