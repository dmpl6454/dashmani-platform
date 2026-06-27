/**
 * One-off: merge same-person DUPLICATE entities into one canonical entity.
 *
 * LLM extraction tags the literal name in each caption, so one person can become
 * several Entity rows: "Kareena Kapoor" (138 posts) AND "Kareena Kapoor Khan" (16).
 * A name search then misses the other's posts. This folds confirmed same-person
 * pairs into one canonical entity (the larger keeps its name; the smaller's name +
 * aliases become aliases), re-pointing the smaller's link joins to the survivor.
 *
 * ⚠️ SAFETY — the cardinal rule: NEVER merge two DIFFERENT people. A false merge
 * corrupts data permanently. So this is deliberately conservative — a TWO-STAGE
 * funnel:
 *   STAGE 1 (filter): only consider pairs where the shorter canonicalName is a
 *     full WORD-BOUNDARY PREFIX of the longer AND the shorter is ≥2 tokens. This
 *     alone eliminates the catastrophic single-token traps — on prod, "Aditi" is a
 *     prefix of EIGHT different people (Aditi Rao Hydari, Aditi Sharma, …); a
 *     single-token prefix is NEVER safe. Multi-token prefixes ("Kareena Kapoor" →
 *     "Kareena Kapoor Khan") are almost always a married/extended name of ONE person.
 *   STAGE 2 (LLM adjudication): ask the LLM "is <shorter> the same real person as
 *     <longer>?" for each surviving pair. Only MERGE on an explicit yes. This also
 *     catches residual one-to-many (e.g. "Aditi Roy" → both "Aditi Roy Hydari" AND
 *     "Aditi Roy Kapur" — at least one is wrong, so SEPARATE both).
 *
 * If the LLM is unavailable or unsure → SEPARATE (leave split). We'd rather leave
 * two entities (search still works per-name) than wrongly merge two people.
 *
 * DRY-RUN BY DEFAULT — prints the proposed merges for review. --apply to write.
 * Idempotent. Needs an LLM key (OpenAI primary, same chain as extraction).
 *
 * Usage:
 *   cd packages/db && set -a && . ../../apps/api/.env && set +a
 *   npx tsx ../../scripts/merge-duplicate-entities.ts                  # dry-run
 *   npx tsx ../../scripts/merge-duplicate-entities.ts --apply
 */

import { prisma } from "@dashmani/db";

const APPLY = process.argv.includes("--apply");

// ── STAGE 2 adjudicator: is A the same real person as B? ─────────────────────
// OpenAI-primary (same order as entity-extraction), then Gemini-lite, then Anthropic.
async function samePersonLLM(shorter: string, longer: string): Promise<"MERGE" | "SEPARATE" | "UNSURE"> {
  const prompt = `Two name tags from Bollywood/Indian-celebrity social captions:\nA: "${shorter}"\nB: "${longer}"\nB starts with A. Are A and B the SAME real person (e.g. a maiden name vs married name, or a short vs full name of one individual)? Answer with ONE word: MERGE if they are certainly the same person, SEPARATE if they are or might be different people. If unsure, answer SEPARATE.`;

  // OpenAI gpt-4o-mini
  if (process.env.OPENAI_API_KEY) {
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o-mini", max_tokens: 4, messages: [{ role: "user", content: prompt }] }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) {
        const d = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const ans = (d.choices?.[0]?.message?.content ?? "").trim().toUpperCase();
        if (ans.startsWith("MERGE")) return "MERGE";
        if (ans.startsWith("SEPARATE")) return "SEPARATE";
      }
    } catch { /* fall through */ }
  }
  // (Gemini/Anthropic fallbacks omitted for brevity — OpenAI is the funded primary;
  //  if it's down, default UNSURE → SEPARATE, the safe direction.)
  return "UNSURE";
}

function tokenCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

async function main() {
  console.log(`\nmerge-duplicate-entities — mode: ${APPLY ? "APPLY" : "DRY-RUN"}`);
  if (!process.env.OPENAI_API_KEY) {
    console.log("⚠️  No OPENAI_API_KEY — cannot adjudicate; aborting (refusing to blind-merge).");
    await prisma.$disconnect();
    return;
  }

  // STAGE 1: multi-token word-boundary prefix pairs among PERSON entities.
  const pairs = await prisma.$queryRaw<Array<{ shorter_id: string; shorter: string; longer_id: string; longer: string }>>`
    SELECT e1.id AS shorter_id, e1."canonicalName" AS shorter,
           e2.id AS longer_id,  e2."canonicalName" AS longer
    FROM entities e1
    JOIN entities e2 ON lower(e2."canonicalName") LIKE lower(e1."canonicalName") || ' %'
    WHERE e1.type = 'PERSON' AND e2.type = 'PERSON' AND e1.id <> e2.id
      AND array_length(string_to_array(trim(e1."canonicalName"), ' '), 1) >= 2
    ORDER BY e1."canonicalName"
  `;
  console.log(`STAGE 1 — multi-token prefix pairs (single-token traps excluded): ${pairs.length}`);

  // Detect one-to-many: a shorter that maps to >1 longer → at least one is wrong → skip ALL.
  const byShorter = new Map<string, number>();
  for (const p of pairs) byShorter.set(p.shorter_id, (byShorter.get(p.shorter_id) ?? 0) + 1);

  let merged = 0;
  let separated = 0;
  let skippedAmbiguous = 0;

  for (const p of pairs) {
    if ((byShorter.get(p.shorter_id) ?? 0) > 1) {
      skippedAmbiguous++;
      console.log(`  SKIP (one-to-many): "${p.shorter}" → "${p.longer}" (shorter maps to multiple longers)`);
      continue;
    }
    const verdict = await samePersonLLM(p.shorter, p.longer);
    if (verdict !== "MERGE") {
      separated++;
      console.log(`  SEPARATE: "${p.shorter}" ⇎ "${p.longer}" (${verdict})`);
      continue;
    }

    // MERGE: fold shorter INTO longer (longer = survivor; it usually has more posts,
    // and the fuller name is the better canonical). Re-point shorter's link joins to
    // longer (skip ones the longer already has), add shorter's name+aliases as aliases.
    console.log(`  MERGE: "${p.shorter}" → "${p.longer}"`);
    if (!APPLY) { merged++; continue; }

    try {
      await prisma.$transaction(async (tx) => {
        const longer = await tx.entity.findUnique({ where: { id: p.longer_id }, select: { aliases: true } });
        const shorter = await tx.entity.findUnique({ where: { id: p.shorter_id }, select: { canonicalName: true, aliases: true } });
        if (!longer || !shorter) return;

        // Re-point link joins: for each of shorter's joins, create the same join on
        // longer if absent (the @@unique([linkContentId, entityId]) prevents dupes).
        const joins = await tx.linkContentEntity.findMany({ where: { entityId: p.shorter_id }, select: { linkContentId: true, confidence: true } });
        for (const j of joins) {
          const exists = await tx.linkContentEntity.findFirst({ where: { entityId: p.longer_id, linkContentId: j.linkContentId }, select: { id: true } });
          if (!exists) {
            await tx.linkContentEntity.create({ data: { entityId: p.longer_id, linkContentId: j.linkContentId, confidence: j.confidence } });
          }
        }
        // Merge aliases (lowercased, deduped): longer's + shorter's name + shorter's aliases.
        const mergedAliases = Array.from(new Set([
          ...longer.aliases,
          shorter.canonicalName.toLowerCase(),
          ...shorter.aliases,
        ]));
        await tx.entity.update({ where: { id: p.longer_id }, data: { aliases: mergedAliases } });
        // Delete the shorter entity (its joins cascade-delete; the re-pointed ones live on longer).
        await tx.entity.delete({ where: { id: p.shorter_id } });
      });
      merged++;
    } catch (err) {
      console.error(`    merge failed for "${p.shorter}" → "${p.longer}":`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`\n=== summary === ${APPLY ? "merged" : "would merge"}=${merged}  separated=${separated}  skipped(one-to-many)=${skippedAmbiguous}`);
  if (!APPLY) console.log("DRY-RUN — re-run with --apply to write.");
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("merge-duplicate-entities failed:", err);
  await prisma.$disconnect();
  process.exit(1);
});
