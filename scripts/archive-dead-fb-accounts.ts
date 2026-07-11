/**
 * One-off: archive the 5 confirmed-permanently-dead Facebook accounts found during
 * the ~259-never-synced-accounts investigation.
 *
 * BACKGROUND: a live prod probe of 155 "numeric-display-name" Facebook accounts
 * found 150 are real pages recoverable via the mobile numeric-ID path (see
 * c4f27a2 "feat(follower-sync): recover FB numeric-ID page followers via
 * un-walled mobile path" on this branch). The remaining 5 are genuinely dead —
 * no follower count resolvable via ANY method tried (mobile path, vanity-slug
 * Googlebot path, nothing) — and have zero associated report_links. These are
 * archived (status: ARCHIVED), NEVER deleted, so the accounts list + follower-
 * growth totals stop counting clutter that will never resolve, while the rows
 * stay in the DB in case a page comes back to life or this was wrong.
 *
 * The 5 IDs are HARDCODED, not parameterized via CLI args. This is a one-time,
 * known, specific cleanup — a future similar cleanup should be a NEW script (or
 * an extended constant with a new commit), never a generic "pass any IDs"
 * archiver. A generic version of this tool is a foot-gun: it would make it too
 * easy to accidentally archive a live account by fat-fingering an ID.
 *
 * SAFETY (belt-and-suspenders): before touching any row, this script RE-VERIFIES
 * each of the 5 is STILL dead — still followerCount === 0 AND still zero
 * reportLinks. A human re-running this weeks later should have it skip (not
 * archive) any account that has since gotten real data from some later recovery
 * path. Never trusts the hardcoded ID list blindly.
 *
 * BEHAVIOUR:
 *   • Looks up each of the 5 IDs by matching the numeric id as a SUBSTRING of
 *     profileUrl (facebook.com/profile.php?id=<n>), same convention used
 *     elsewhere in this codebase for FB profile URLs (see profile.php?id=
 *     regex in follower-sync.service.ts / account-growth.service.ts).
 *   • 0 matches → reported, skipped (not_found).
 *   • 2+ matches → AMBIGUOUS. A 14-digit numeric ID colliding as a substring of
 *     more than one row's profileUrl is unlikely but not impossible, and we
 *     cannot tell which row is the intended target. Reported clearly (every
 *     matching row's id/handle), SKIPPED entirely — NEVER archived. Fail-safe:
 *     an ambiguous match must never result in a write.
 *   • Exactly 1 match, already ARCHIVED → reported, skipped (idempotent no-op).
 *   • Exactly 1 match, status !== ARCHIVED, re-verification FAILS (followerCount
 *     > 0 or reportLinks > 0) → reported, skipped — NOT archived.
 *   • Exactly 1 match, status !== ARCHIVED, re-verification PASSES →
 *     confirmed-still-dead, archived in --apply mode (status update ONLY,
 *     never a delete).
 *
 * Usage (run from packages/db so @dashmani/db auto-loads packages/db/.env):
 *   cd packages/db && npx tsx ../../scripts/archive-dead-fb-accounts.ts
 *   cd packages/db && npx tsx ../../scripts/archive-dead-fb-accounts.ts --apply --confirm-prod
 */

import { prisma } from "@dashmani/db";

// ── The 5 confirmed-dead numeric Facebook profile IDs (hardcoded, see header) ─
const DEAD_FB_IDS: readonly string[] = [
  "61569870441299",
  "61571952268643",
  "61588529114648",
  "61581310762918",
  "61587015153792",
];

// ── CLI flags ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const CONFIRM_PROD = args.includes("--confirm-prod");

interface AccountRow {
  id: string;
  handle: string;
  displayName: string;
  status: string;
  profileUrl: string | null;
  followerCount: number;
}

type Outcome =
  | { fbId: string; kind: "not_found" }
  | { fbId: string; kind: "ambiguous_match"; accounts: AccountRow[] }
  | { fbId: string; kind: "already_archived"; account: AccountRow }
  | { fbId: string; kind: "still_dead"; account: AccountRow }
  | { fbId: string; kind: "skipped_not_dead"; account: AccountRow; reason: string };

// ── Re-verify a candidate account is STILL dead (no trust in the hardcoded list) ─
async function reverify(fbId: string, account: AccountRow): Promise<Outcome> {
  if (account.status === "ARCHIVED") {
    return { fbId, kind: "already_archived", account };
  }

  if (account.followerCount !== 0) {
    return {
      fbId,
      kind: "skipped_not_dead",
      account,
      reason: `followerCount is now ${account.followerCount} (no longer 0) — a later recovery path must have resolved it`,
    };
  }

  const linkCount = await prisma.reportLink.count({ where: { accountId: account.id } });
  if (linkCount > 0) {
    return {
      fbId,
      kind: "skipped_not_dead",
      account,
      reason: `has ${linkCount} report_links now associated — no longer an empty/dead account`,
    };
  }

  return { fbId, kind: "still_dead", account };
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("\n=== archive-dead-fb-accounts ===");
  console.log(`Mode: ${APPLY ? "APPLY" : "DRY-RUN"}`);
  console.log(`Target IDs (${DEAD_FB_IDS.length}): ${DEAD_FB_IDS.join(", ")}`);

  if (APPLY && !CONFIRM_PROD) {
    console.error("\n[ERROR] --apply requires --confirm-prod to prevent accidental writes.");
    console.error("Run: cd packages/db && npx tsx ../../scripts/archive-dead-fb-accounts.ts --apply --confirm-prod\n");
    process.exitCode = 1;
    return;
  }

  console.log("\nRe-verifying each account is still dead before touching anything...\n");

  const outcomes: Outcome[] = [];

  for (const fbId of DEAD_FB_IDS) {
    const matches = await prisma.socialAccount.findMany({
      where: { profileUrl: { contains: fbId } },
      select: {
        id: true,
        handle: true,
        displayName: true,
        status: true,
        profileUrl: true,
        followerCount: true,
      },
    });

    if (matches.length === 0) {
      console.log(`  [NOT FOUND]      id=${fbId} — no social_accounts row matches this profileUrl`);
      outcomes.push({ fbId, kind: "not_found" });
      continue;
    }

    if (matches.length > 1) {
      console.log(`  [AMBIGUOUS]      id=${fbId} — ${matches.length} rows match this profileUrl substring, cannot tell which is the intended target — SKIPPING`);
      for (const m of matches) {
        console.log(`      candidate: account id=${m.id} handle="${m.handle}" (${m.displayName}) status=${m.status} profileUrl=${m.profileUrl}`);
      }
      outcomes.push({ fbId, kind: "ambiguous_match", accounts: matches });
      continue;
    }

    const account = matches[0];
    const outcome = await reverify(fbId, account);
    outcomes.push(outcome);

    const label = `handle="${account.handle}" (${account.displayName}) status=${account.status} followerCount=${account.followerCount}`;
    if (outcome.kind === "already_archived") {
      console.log(`  [ALREADY DONE]   id=${fbId} — ${label} — already ARCHIVED, nothing to do`);
    } else if (outcome.kind === "skipped_not_dead") {
      console.log(`  [SKIP]           id=${fbId} — ${label} — ${outcome.reason}`);
    } else {
      console.log(`  [STILL DEAD]     id=${fbId} — ${label} — confirmed 0 followers, 0 report_links`);
    }
  }

  const toArchive = outcomes.filter((o): o is Extract<Outcome, { kind: "still_dead" }> => o.kind === "still_dead");

  console.log(`\nSummary: ${toArchive.length} of ${DEAD_FB_IDS.length} accounts confirmed still-dead and archivable.`);
  for (const o of outcomes) {
    if (o.kind === "not_found") console.log(`  - ${o.fbId}: not found`);
    if (o.kind === "ambiguous_match") console.log(`  - ${o.fbId}: skipped (ambiguous — ${o.accounts.length} rows matched, refusing to guess)`);
    if (o.kind === "already_archived") console.log(`  - ${o.fbId}: already archived`);
    if (o.kind === "skipped_not_dead") console.log(`  - ${o.fbId}: skipped (${o.reason})`);
    if (o.kind === "still_dead") console.log(`  - ${o.fbId}: would archive (account id ${o.account.id})`);
  }

  if (!APPLY) {
    console.log(`\n[DRY-RUN] Would archive ${toArchive.length} of ${DEAD_FB_IDS.length} accounts. No changes made.`);
    console.log("Re-run with --apply --confirm-prod to write.\n");
    return;
  }

  if (toArchive.length === 0) {
    console.log("\nNothing to archive. Done.");
    return;
  }

  console.log("\n[APPLY] Archiving confirmed-dead accounts...\n");

  let archived = 0;
  let errors = 0;
  for (const o of toArchive) {
    try {
      await prisma.socialAccount.update({
        where: { id: o.account.id },
        data: { status: "ARCHIVED" },
      });
      archived++;
      console.log(`  [ARCHIVED] id=${o.fbId} — handle="${o.account.handle}" (account id ${o.account.id})`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [ERROR] failed to archive id=${o.fbId} (account id ${o.account.id}): ${msg}`);
      errors++;
    }
  }

  console.log("\n=== Final summary ===");
  console.log(`  Archived : ${archived}`);
  console.log(`  Errors   : ${errors}`);
  console.log(`  Skipped  : ${DEAD_FB_IDS.length - toArchive.length}`);
  console.log("\nDone. Archived accounts are reversible — flip status back to ACTIVE in the DB if this was wrong.\n");
}

main()
  .catch((err: unknown) => {
    console.error("\n[FATAL] archive-dead-fb-accounts failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
