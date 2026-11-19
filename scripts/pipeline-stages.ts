/**
 * Replace the Pipeline stages (owner, 2026-11-18): one board for everyone, in the order
 *
 *   Brief → Planning → Review → Approved → Not approved → Live / Ongoing → Billing → Reporting → Payment
 *
 * Stages are DATA (pipeline_phases), never a code enum, so this is a data script — no DDL, no
 * deploy. It runs in ONE transaction:
 *   1. upserts the nine stages by key (names, order; Payment is the only finished stage, so due
 *      and overdue alerts stop there, as they did for Done);
 *   2. moves every project (archived and deleted ones too) out of the two stages that go away:
 *      In Production → Planning, Done → Payment — appended at the bottom of the new column in
 *      their old order, header_rev bumped so open tabs re-read them;
 *   3. archives In Production and Done (a stage can be archived only when no project row uses it);
 *   4. bumps the board, so every open board re-reads.
 * Nobody is notified about the moves (they are a re-labelling, not work).
 *
 * The API caches the stage list for up to 60 s; boards pick the change up on their next sync.
 *
 * Run from packages/db (so Prisma loads packages/db/.env):
 *   npx tsx ../../scripts/pipeline-stages.ts                       # dry run: what would change
 *   npx tsx ../../scripts/pipeline-stages.ts --apply --confirm-prod
 */
import { randomUUID } from "crypto";
import { prisma } from "@dashmani/db";
import { keyBetween } from "../packages/shared/src/pipeline/rank";

const APPLY = process.argv.includes("--apply");
const CONFIRM_PROD = process.argv.includes("--confirm-prod");

/** The new board, in order. `key` is the stable slug; existing keys keep their row (and id). */
export const STAGES: ReadonlyArray<{ key: string; name: string; terminal: boolean }> = [
  { key: "brief", name: "Brief", terminal: false },
  { key: "planning", name: "Planning", terminal: false },
  { key: "review", name: "Review", terminal: false },
  { key: "approved", name: "Approved", terminal: false },
  { key: "not_approved", name: "Not approved", terminal: false },
  { key: "live", name: "Live / Ongoing", terminal: false },
  { key: "billing", name: "Billing", terminal: false },
  { key: "reporting", name: "Reporting", terminal: false },
  { key: "payment", name: "Payment", terminal: true },
];

/** Stages that go away, and where their projects go. */
export const RETIRE: Readonly<Record<string, string>> = { in_production: "planning", done: "payment" };

interface PhaseRow { id: string; key: string; name: string; position: number; is_terminal: boolean; archived_at: Date | null }

async function main() {
  const dbUrl = process.env.DATABASE_URL ?? "";
  const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(dbUrl);
  if (APPLY && !isLocal && !CONFIRM_PROD) {
    console.error("Refusing to write to a non-local database without --confirm-prod.");
    process.exit(1);
  }

  const result = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '3s'`);
      // Every stage row, locked: nothing else changes stages while this runs.
      const before = await tx.$queryRaw<PhaseRow[]>`
        SELECT id, key, name, position, is_terminal, archived_at FROM pipeline_phases ORDER BY position, id FOR UPDATE`;
      const byKey = new Map(before.map((p) => [p.key, p]));
      const plan: string[] = [];

      // 1. The nine stages. Positions are moved out of the way first (+1000) so the new order
      //    never collides with an old position mid-way (position is not unique, but keep it clean).
      await tx.$executeRaw`UPDATE pipeline_phases SET position = position + 1000`;
      const ids = new Map<string, string>();
      for (const [i, s] of STAGES.entries()) {
        const cur = byKey.get(s.key);
        if (cur) {
          if (cur.name !== s.name || cur.is_terminal !== s.terminal || cur.position !== i + 1 || cur.archived_at)
            plan.push(`stage ${s.key}: "${cur.name}" #${cur.position}${cur.archived_at ? " (archived)" : ""} → "${s.name}" #${i + 1}${s.terminal ? " (finished)" : ""}`);
          await tx.$executeRaw`
            UPDATE pipeline_phases SET name = ${s.name}, position = ${i + 1}, is_terminal = ${s.terminal},
                   archived_at = NULL, updated_at = timezone('utc', now())
             WHERE id = ${cur.id}`;
          ids.set(s.key, cur.id);
        } else {
          const id = randomUUID();
          plan.push(`stage ${s.key}: new "${s.name}" #${i + 1}${s.terminal ? " (finished)" : ""}`);
          await tx.$executeRaw`
            INSERT INTO pipeline_phases (id, key, name, position, is_terminal, created_at, updated_at)
            VALUES (${id}, ${s.key}, ${s.name}, ${i + 1}, ${s.terminal}, timezone('utc', now()), timezone('utc', now()))`;
          ids.set(s.key, id);
        }
      }

      // 2. Move projects out of the retired stages, appended at the bottom in their old order.
      const moved: Array<{ from: string; to: string; count: number }> = [];
      for (const [oldKey, newKey] of Object.entries(RETIRE)) {
        const old = byKey.get(oldKey);
        if (!old) continue;
        const toId = ids.get(newKey)!;
        const cards = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM pipeline_projects WHERE phase_id = ${old.id} ORDER BY rank COLLATE "C", id FOR UPDATE`;
        if (cards.length === 0) continue;
        const [last] = await tx.$queryRaw<Array<{ rank: string | null }>>`
          SELECT max(rank COLLATE "C") AS rank FROM pipeline_projects WHERE phase_id = ${toId}`;
        let rank: string | null = last?.rank ?? null;
        for (const c of cards) {
          rank = keyBetween(rank, null);
          await tx.$executeRaw`
            UPDATE pipeline_projects
               SET phase_id = ${toId}, rank = ${rank}, header_rev = header_rev + 1, updated_at = timezone('utc', now())
             WHERE id = ${c.id}`;
        }
        moved.push({ from: oldKey, to: newKey, count: cards.length });
      }

      // 3. Archive the retired stages (now unused).
      for (const oldKey of Object.keys(RETIRE)) {
        const old = byKey.get(oldKey);
        if (!old || old.archived_at) continue;
        const [{ n }] = await tx.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pipeline_projects WHERE phase_id = ${old.id}`;
        if (n > 0) throw new Error(`stage ${oldKey} still has ${n} projects`);
        await tx.$executeRaw`UPDATE pipeline_phases SET archived_at = timezone('utc', now()), position = position WHERE id = ${old.id}`;
        plan.push(`stage ${oldKey} ("${old.name}"): archived`);
      }

      // 4. Every open board re-reads.
      await tx.$executeRaw`UPDATE pipeline_board_state SET seq = seq + 1, updated_at = timezone('utc', now()) WHERE id = 1`;

      const after = await tx.$queryRaw<Array<{ key: string; name: string; position: number; projects: number }>>`
        SELECT ph.key, ph.name, ph.position,
               (SELECT count(*)::int FROM pipeline_projects p WHERE p.phase_id = ph.id AND p.deleted_at IS NULL AND p.archived_at IS NULL AND p.kind = 'project') AS projects
          FROM pipeline_phases ph WHERE ph.archived_at IS NULL ORDER BY ph.position, ph.id`;
      if (!APPLY) throw Object.assign(new Error("dry-run"), { dryRun: { plan, moved, after } });
      return { plan, moved, after };
    },
    { timeout: 60_000 },
  ).catch((e) => {
    if (e?.dryRun) return { ...e.dryRun, dry: true };
    throw e;
  });

  console.log(APPLY ? "APPLIED." : "Dry run — nothing was written.");
  for (const l of result.plan) console.log(`  ${l}`);
  for (const m of result.moved) console.log(`  moved ${m.count} project(s): ${m.from} → ${m.to}`);
  console.log("\nThe board now reads (live projects per stage):");
  for (const a of result.after) console.log(`  ${String(a.position).padStart(2)}. ${a.name.padEnd(16)} ${a.projects}`);
  if (!APPLY) console.log(`\nRe-run with --apply${isLocal ? "" : " --confirm-prod"} to write.`);
  else console.log("\nOpen boards update on their next sync; the stage list itself is cached up to 60 s.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
