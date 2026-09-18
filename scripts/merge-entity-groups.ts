/**
 * Merge an EXPLICIT list of duplicate-entity groups into one canonical entity each.
 *
 * ⚠️ WHY THIS EXISTS BESIDE merge-duplicate-entities.ts. That script is PERSON-only and
 * adjudicates candidate pairs with an LLM. The fragmentation that made What's Trending
 * understate its own leader ~3.6x is in TOPIC/BRAND rows — "Ganpati Celebration" /
 * "Ganesh Utsav" / "Ganeshotsav" all naming Ganesh Chaturthi, plus eleven pure
 * case-collision groups ("CHANEL" / "Chanel") — which that script never considers. The
 * groups here were adjudicated BY INSPECTION of the live rows, not by a model, and are
 * written down so the decision is reviewable.
 *
 * ⚠️ THE CARDINAL RULE, INHERITED: never merge two DIFFERENT things. Related is not the
 * same. "Ganpati Visarjan" (the immersion) is not "Ganesh Chaturthi" (the festival);
 * "Lalbaugcha Raja" (one idol) is not "Ganpati Bappa" (the deity); "Ambani Ganpati" (one
 * household's celebration) is a topic of its own. Those stay separate on purpose, and so
 * does every PERSON row — "Bharat Ganeshpure" is an actor, "Ganesh Acharya" a
 * choreographer. Only within-concept synonyms and case variants are folded.
 *
 * MECHANICS (per group, one transaction, same shape as merge-duplicate-entities.ts):
 *   1. re-point each loser's link joins to the winner, skipping any caption the winner
 *      already carries (the @@unique([linkContentId, entityId]) would otherwise reject);
 *   2. delete the leftover duplicate joins;
 *   3. append every loser's canonicalName (lowercased) and aliases to the winner's aliases
 *      — ⚠️ THIS IS WHAT MAKES THE MERGE DURABLE: resolveAndPersist matches aliases before
 *      creating, so the hourly extractor will resolve "ganeshotsav" back to the winner
 *      instead of re-creating the deleted row;
 *   4. delete the losers.
 *
 * DRY-RUN BY DEFAULT. Prints every planned merge with live counts and writes nothing.
 * --apply --confirm-prod to write. Idempotent: a loser that no longer exists is skipped.
 *
 * Run from packages/db so Prisma loads that .env:
 *   cd packages/db && npx tsx ../../scripts/merge-entity-groups.ts
 *   cd packages/db && npx tsx ../../scripts/merge-entity-groups.ts --apply --confirm-prod
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const CONFIRM_PROD = process.argv.includes("--confirm-prod");

/** winner ← losers. The winner is the highest-count spelling as of 2026-09-18 on prod. */
const GROUPS: Array<{ winner: string; losers: string[]; why: string }> = [
  // ── pure case / spacing collisions ──
  { winner: "BeYon by House of Titan", losers: ["Beyon by House of Titan", "Beyon By House Of Titan"], why: "case variants of one brand" },
  { winner: "One8", losers: ["ONE8", "one8"], why: "case variants of one brand" },
  { winner: "Welcome To The Jungle", losers: ["Welcome to the Jungle", "Welcome to The Jungle"], why: "case variants of one title" },
  { winner: "Covid-19", losers: ["COVID-19"], why: "case variants" },
  { winner: "adidas", losers: ["Adidas"], why: "case variants of one brand (the brand styles itself lowercase)" },
  { winner: "EKTRA Jewels", losers: ["Ektra Jewels"], why: "case variants of one brand" },
  { winner: "KhanZaadi", losers: ["Khanzaadi"], why: "case variants of one person's stage name" },
  { winner: "Manoj Bachpayee", losers: ["Manoj BachPayee"], why: "case variants of the same (mis)spelling" },
  { winner: "ekatra jewels", losers: ["Ekatra Jewels"], why: "case variants of one brand" },
  { winner: "Ambani family", losers: ["Ambani Family"], why: "case variants; the PERSON row (1,400 posts) is the canonical one" },
  { winner: "CHANEL", losers: ["Chanel"], why: "case variants of one brand" },
  // ── within-concept synonyms of the FESTIVAL ──
  {
    winner: "Ganesh Chaturthi",
    losers: ["Ganpati Celebration", "GanpatiCelebration", "Ganpati Festival", "Ganesh Utsav", "Ganpati Utsav", "Ganeshotsav", "Ganpati Chaturthi"],
    why: "every one names the festival itself; none names a sub-event, idol or ritual",
  },
  // ── the DEITY ──
  {
    winner: "Ganpati Bappa",
    losers: ["Ganpati", "Bappa", "Lord Ganesha", "Ganpati Bappa Morya", "Bappa Morya"],
    why: "the deity under different names and the chant that names him; the festival, the immersion and specific idols stay separate",
  },
  // ── the IMMERSION (kept distinct from the festival) ──
  { winner: "Ganpati Visarjan", losers: ["Ganesh Visarjan", "Bappa Visarjan", "GanpatiVisarjan"], why: "one event, three spellings" },
  // ── DARSHAN, AARTI, PUJA — rituals, each kept distinct ──
  { winner: "Ganpati Darshan", losers: ["Ganesh Darshan", "Bappa Darshan", "Ganapati Darshan"], why: "one activity, four spellings" },
  { winner: "Ganpati Aarti", losers: ["Ganesh Aarti"], why: "one ritual, two spellings" },
  { winner: "Ganpati Puja", losers: ["Ganesh Puja", "Ganpati Pooja"], why: "one ritual, three spellings" },
  // ── one household's celebration ──
  { winner: "Ambani Ganpati", losers: ["Ambani Ganesh Chaturthi", "Antilia Ganpati"], why: "the same celebration at the same address" },
  // ── one pandal ──
  { winner: "GSB Seva Mandal Ganpati", losers: ["Seva Mandal Ganpati"], why: "the same mandal, with and without its initials" },
];

// Deliberately NOT merged — recorded so the omission is visible, not accidental:
//   Lalbaugcha Raja / Lalbaug (an idol vs a neighbourhood), Bappa Blessings, Ganpati Aagman
//   (the arrival — a distinct event), Bandra/Dadar/Mumbai Ganpati (places), Ganpati Pandal,
//   Kalachowki Cha Mahaganpati (a different pandal), and every PERSON row.

async function main() {
  const dbUrl = process.env.DATABASE_URL ?? "";
  const looksProd = /dashmani_prod|172\.105\.53\.101|digitalsukoon/.test(dbUrl) || process.env.NODE_ENV === "production";
  if (APPLY && looksProd && !CONFIRM_PROD) {
    console.error("Refusing to --apply against what looks like PRODUCTION without --confirm-prod.");
    process.exit(2);
  }
  console.log(`${APPLY ? "APPLY" : "DRY-RUN"} — ${GROUPS.length} groups`);

  let merged = 0, movedJoins = 0, droppedDupJoins = 0, skipped = 0;

  for (const g of GROUPS) {
    const winner = await prisma.entity.findUnique({ where: { canonicalName: g.winner }, select: { id: true, canonicalName: true, type: true, aliases: true } });
    if (!winner) { console.log(`  SKIP group "${g.winner}": winner row not found`); skipped++; continue; }
    const losers = await prisma.entity.findMany({ where: { canonicalName: { in: g.losers } }, select: { id: true, canonicalName: true, type: true, aliases: true } });
    if (losers.length === 0) { console.log(`  SKIP group "${g.winner}": no loser rows present (already merged?)`); skipped++; continue; }
    // ⚠️ Guard the cardinal rule mechanically as well as by inspection.
    if (winner.type === "PERSON" && losers.some((l) => l.type === "PERSON" && l.canonicalName.toLowerCase() !== winner.canonicalName.toLowerCase())) {
      console.log(`  REFUSE group "${g.winner}": would merge two differently-named PERSON rows`); skipped++; continue;
    }
    const counts = await prisma.linkContentEntity.groupBy({ by: ["entityId"], where: { entityId: { in: [winner.id, ...losers.map((l) => l.id)] } }, _count: { _all: true } });
    const cnt = new Map(counts.map((c) => [c.entityId, c._count._all]));
    console.log(`\n  MERGE → "${winner.canonicalName}" [${winner.type}:${cnt.get(winner.id) ?? 0}]  (${g.why})`);
    for (const l of losers) console.log(`      ← "${l.canonicalName}" [${l.type}:${cnt.get(l.id) ?? 0}]`);
    if (!APPLY) { merged++; continue; }

    await prisma.$transaction(async (tx) => {
      for (const l of losers) {
        // 1. re-point joins the winner does not already have
        const moved = await tx.$executeRaw`
          UPDATE link_content_entities lce SET entity_id = ${winner.id}
          WHERE lce.entity_id = ${l.id}
            AND NOT EXISTS (SELECT 1 FROM link_content_entities w WHERE w.entity_id = ${winner.id} AND w.link_content_id = lce.link_content_id)`;
        // 2. the rest are captions the winner already carried — drop the duplicate join
        const dropped = await tx.$executeRaw`DELETE FROM link_content_entities WHERE entity_id = ${l.id}`;
        movedJoins += moved; droppedDupJoins += dropped;
      }
      // 3. aliases: lowercased, deduped — the durability step
      const aliases = Array.from(new Set([
        ...winner.aliases,
        ...losers.map((l) => l.canonicalName.trim().toLowerCase()),
        ...losers.flatMap((l) => l.aliases),
      ].filter((a) => a && a !== winner.canonicalName.toLowerCase())));
      await tx.entity.update({ where: { id: winner.id }, data: { aliases } });
      // 4. losers go
      await tx.entity.deleteMany({ where: { id: { in: losers.map((l) => l.id) } } });
    });
    merged++;
  }

  console.log(`\n=== ${APPLY ? "applied" : "would apply"} === groups=${merged} skipped=${skipped}` + (APPLY ? ` joinsMoved=${movedJoins} duplicateJoinsDropped=${droppedDupJoins}` : ""));
  if (!APPLY) console.log("DRY-RUN — re-run with --apply --confirm-prod to write.");
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error("merge-entity-groups failed:", e); await prisma.$disconnect(); process.exit(1); });
