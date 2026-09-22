/**
 * Archive the duplicate YouTube rows on the Account Growth board, and repoint the
 * survivors at an id-based URL so they can never be re-bound to the wrong channel.
 *
 * ── WHY ───────────────────────────────────────────────────────────────────────────────
 *
 * Three rows on the YouTube board name a channel another row already tracks. Because
 * `social_accounts` is `@@unique([handle, platformId])` and stores no resolved channel id,
 * two spellings of one channel are two different rows to the database — so both are summed.
 * Measured on prod 2026-09-22: "Subscribers (now)" read 39,036,825 against a true
 * 27,496,825 (+41.97%) and "Lifetime views" 7,783,966,443 against 7,534,403,943 (+3.31%).
 *
 *   ARCHIVE  Inde-News         -> same channel (UCuUfbikjsCl6KYaoc4sMS5w) as IndeNewsOfficial
 *   ARCHIVE  TotalFilmi        -> same channel (UC_qXlnj3LcTg_qScXJcEL2w) as "Total filmi "
 *   ARCHIVE  moviefied         -> its URL names @Movified, which `Movified` already tracks
 *
 * ── HOW THE SURVIVOR WAS CHOSEN ───────────────────────────────────────────────────────
 *
 * By FOREIGN-KEY REFERENCES, not by which row looks tidier. `Total filmi ` carries 407
 * report_links and 3 account_assignments; `TotalFilmi` carries none. Archiving the
 * referenced row would orphan real submitted links from their channel.
 *
 * ⚠️ ACCEPTED TRADE-OFF, stated so nobody rediscovers it as a bug: `TotalFilmi` holds
 * snapshots back to 2026-04-08 while the survivor only reaches 2026-05-19, so ~6 weeks of
 * that channel's visible history goes quiet. The owner chose this over a history merge.
 *
 * ⚠️ ARCHIVED IS A SOFT FLAG, NEVER A DELETE. `report_links.accountId` references these
 * rows and `buildBoard` already filters `status != 'ARCHIVED'`, so the totals correct
 * themselves with no read-path change. Restoring a row is a single UPDATE.
 *
 * ── AND THE REASON THEY EXISTED AT ALL ────────────────────────────────────────────────
 *
 * A row whose stored URL carries no channel id, and whose handle is a display name rather
 * than a real @handle, has NO exact resolution path — so its identity rests on a ranked
 * name search. `Total filmi ` holds four distinct values across 90 days (1,040,000 /
 * 356,000 / 46,300 / 10,900), i.e. its history has been written from more than one channel.
 *
 * ⚠️ Stated precisely, because the obvious explanation is wrong: that search is not
 * whitespace-sensitive and is not flapping today — probed live, both spellings return an
 * identical top-3 led by the correct channel. The defect is the missing exact path. This
 * script therefore PINS each survivor to `/channel/<id>`, which is what the sync now does
 * on every successful resolution, and the resolver now also mines an @handle out of the
 * stored URL before it will pay for a name search at all.
 *
 * ⚠️ NOT DONE HERE, and it needs its own decision: the survivor `Total filmi ` KEEPS its
 * mixed history, so its own Change cell will read oddly until those rows age out of the
 * 90-day window. The board now marks that cell as unreliable and excludes it from the
 * totals rather than hiding it. Deleting the provably-foreign snapshots (CLAUDE.md's
 * 2026-08-24 precedent: back up to CSV first) would clear it sooner.
 *
 * Usage (from packages/db so the Prisma client loads its .env):
 *   npx tsx ../../scripts/archive-duplicate-channels.ts                     # dry run
 *   npx tsx ../../scripts/archive-duplicate-channels.ts --apply --confirm-prod
 */

import { prisma } from "@dashmani/db";

const APPLY = process.argv.includes("--apply");
const CONFIRM_PROD = process.argv.includes("--confirm-prod");

/** handle -> { survivor handle, the channel id BOTH resolve to } */
const DUPLICATES: Array<{ archive: string; keep: string; channelId: string; why: string }> = [
  {
    archive: "Inde-News",
    keep: "IndeNewsOfficial",
    channelId: "UCuUfbikjsCl6KYaoc4sMS5w",
    why: "same channel; survivor holds 87 snapshots back to 2026-06-25, this row 1 (created today)",
  },
  {
    archive: "TotalFilmi",
    keep: "Total filmi ",
    channelId: "UC_qXlnj3LcTg_qScXJcEL2w",
    why: "same channel; survivor holds 407 report_links + 3 assignments, this row none",
  },
  {
    archive: "moviefied",
    keep: "Movified",
    channelId: "UCrPBipWhCfKmSjJ7Ph58Lpg",
    why: "its stored URL names @Movified (1.08m), which the survivor already tracks; its own handle names a different, empty channel",
  },
];

async function main() {
  const url = process.env.DATABASE_URL ?? "";
  const isProd = !/localhost|127\.0\.0\.1/.test(url);
  if (APPLY && isProd && !CONFIRM_PROD) {
    console.error("Refusing to write to a non-local database without --confirm-prod.");
    process.exit(1);
  }
  console.log(APPLY ? "APPLYING\n" : "DRY RUN — nothing will be written. Add --apply --confirm-prod to write.\n");

  const yt = await prisma.platform.findUnique({ where: { slug: "youtube" }, select: { id: true } });
  if (!yt) throw new Error("no youtube platform row");

  for (const d of DUPLICATES) {
    const loser = await prisma.socialAccount.findFirst({
      where: { platformId: yt.id, handle: d.archive },
      select: { id: true, handle: true, displayName: true, status: true },
    });
    const keeper = await prisma.socialAccount.findFirst({
      where: { platformId: yt.id, handle: d.keep },
      select: { id: true, handle: true, displayName: true, profileUrl: true, status: true },
    });

    if (!loser) { console.log(`  · ${d.archive.padEnd(20)} not found — already archived or renamed, skipping`); continue; }
    if (!keeper) { console.log(`  ! ${d.archive.padEnd(20)} SURVIVOR "${d.keep}" not found — skipping rather than guessing`); continue; }
    if (loser.status === "ARCHIVED") { console.log(`  · ${d.archive.padEnd(20)} already ARCHIVED, skipping`); continue; }

    // ⚠️ Re-measure the references NOW rather than trusting the analysis that wrote this
    // list. If the row being archived has acquired a reference since, stop and say so.
    const [links, assigns, posts, tasks, projects] = await Promise.all([
      prisma.reportLink.count({ where: { accountId: loser.id } }),
      prisma.accountAssignment.count({ where: { accountId: loser.id } }),
      prisma.contentPost.count({ where: { accountId: loser.id } }),
      prisma.task.count({ where: { accountId: loser.id } }),
      prisma.projectAccount.count({ where: { accountId: loser.id } }),
    ]);
    if (links > 0 || posts > 0 || tasks > 0 || projects > 0) {
      console.log(
        `  ! ${d.archive.padEnd(20)} now has references (links=${links} posts=${posts} tasks=${tasks} projects=${projects}) — REFUSING. Re-check which row should survive.`,
      );
      continue;
    }

    console.log(`  ↓ ${d.archive.padEnd(20)} -> ARCHIVE  (keep "${keeper.handle}") — ${d.why}`);
    if (assigns > 0) console.log(`      moving ${assigns} account assignment(s) to "${keeper.handle}"`);
    const pinned = `https://www.youtube.com/channel/${d.channelId}`;
    if (!(keeper.profileUrl ?? "").includes(d.channelId)) {
      console.log(`      pinning survivor URL -> ${pinned}  (was ${keeper.profileUrl ?? "—"})`);
    }

    if (APPLY) {
      await prisma.$transaction(async (tx) => {
        if (assigns > 0) {
          // ⚠️ An assignment is a person's responsibility for a channel — it must land on
          // the survivor, not vanish with the archived row. updateMany is safe here because
          // the pair is (employee, account) and the survivor may already hold one; a
          // duplicate is removed below rather than allowed to violate the unique key.
          const existing = await tx.accountAssignment.findMany({
            where: { accountId: keeper.id }, select: { employeeId: true },
          });
          const held = new Set(existing.map((e) => e.employeeId));
          const moving = await tx.accountAssignment.findMany({
            where: { accountId: loser.id }, select: { id: true, employeeId: true },
          });
          for (const m of moving) {
            if (held.has(m.employeeId)) await tx.accountAssignment.delete({ where: { id: m.id } });
            else await tx.accountAssignment.update({ where: { id: m.id }, data: { accountId: keeper.id } });
          }
        }
        await tx.socialAccount.update({ where: { id: loser.id }, data: { status: "ARCHIVED" } });
        if (!(keeper.profileUrl ?? "").includes(d.channelId)) {
          await tx.socialAccount.update({ where: { id: keeper.id }, data: { profileUrl: pinned } });
        }
      });
    }
  }

  // What the board will read afterwards.
  const rows = await prisma.socialAccount.findMany({
    where: { platformId: yt.id, status: { not: "ARCHIVED" } },
    select: { followerCount: true, totalViews: true },
  });
  const subs = rows.reduce((a, r) => a + r.followerCount, 0);
  const views = rows.reduce((a, r) => a + Number(r.totalViews ?? 0n), 0);
  console.log(`\n  ${APPLY ? "NOW" : "WOULD BE"}: ${rows.length} channels · ${subs.toLocaleString()} subscribers · ${views.toLocaleString()} lifetime views`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
