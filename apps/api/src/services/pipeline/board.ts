/**
 * The board version and the live phase list (spec §5.1, §5.3).
 *
 * `pipeline_board_state.seq` (the board "v") is bumped AFTER the writing transaction
 * commits — never inside one — as its own autocommit statement, so the single global row
 * is locked only for that sub-millisecond statement. Safety argument: a bump follows its
 * writer's commit, so a reader that reads v and then the rows sees every change whose
 * bump is ≤ v; at worst a snapshot is newer than its label (one redundant download).
 *
 * If a bump fails (lock timeout, pool busy, restart), `boardBumpPending` makes the next
 * gated pipeline request retry it (awaited — the feature has no fire-and-forget writes),
 * and the boot self-check bumps once, which covers a crash between commit and bump.
 *
 * ⚠️ A SUCCESS MAY ONLY CLEAR FAILURES THAT HAPPENED BEFORE IT STARTED. Bumps run
 * concurrently: bump A's UPDATE can execute before writer B commits, B's own bump can then
 * fail (queue_full is immediate), and A resolves afterwards. A's seq predates B's commit,
 * so it does not cover B — clearing the flag there would leave every board on a stale v.
 * `bumpFailGen` counts failures; a success clears the flag only if none happened during
 * its flight. The worst case is one redundant heal bump, which is harmless.
 *
 * getBoardSnapshot(v) (§5.3) lands with the board routes.
 */
import type { PipelinePhase } from "@dashmani/shared";
import { createSingleFlightMemo } from "../../utils/single-flight-memo";
import { pipelineRead, pipelineWriteStatement } from "./tx";

let boardBumpPending = false;
/** Incremented on every failed bump (see the ⚠️ above). */
let bumpFailGen = 0;
let lastBumpWarn = 0;
let warnedMissingRow = false;

export function isBoardBumpPending(): boolean {
  return boardBumpPending;
}

/**
 * Post-commit board bump. Never throws: a failure only sets the pending flag.
 * @returns the new board version, or null when the bump failed or the row is missing.
 */
export async function bumpBoard(): Promise<number | null> {
  const genAtStart = bumpFailGen;
  try {
    const rows = await pipelineWriteStatement((db) =>
      db.$queryRaw<Array<{ seq: number }>>`
        UPDATE pipeline_board_state
           SET seq = seq + 1, updated_at = timezone('utc', now())
         WHERE id = 1
     RETURNING seq`,
    );
    // Only failures from before this bump started are covered by it.
    if (bumpFailGen === genAtStart) boardBumpPending = false;
    if (rows.length === 0) {
      if (!warnedMissingRow) {
        warnedMissingRow = true;
        console.warn("[pipeline] pipeline_board_state row 1 is missing — was the DDL seed applied?");
      }
      return null;
    }
    return rows[0].seq;
  } catch (err) {
    bumpFailGen++;
    boardBumpPending = true;
    if (Date.now() - lastBumpWarn > 10_000) {
      lastBumpWarn = Date.now();
      console.warn("[pipeline] board bump failed — will retry on the next pipeline request:", String(err));
    }
    return null;
  }
}

/** A pending bump is retried at most this often, so a persistent failure cannot tax every request. */
const HEAL_MIN_INTERVAL_MS = 5_000;
let healInflight: Promise<void> | null = null;
let lastHealAttempt = 0;

/**
 * Called by the access gate: retry a bump that failed after its writer committed.
 * Awaited (the feature has no fire-and-forget writes), but single-flight and throttled:
 * while one request is healing, or within 5 s of the last attempt, others skip it — so a
 * board row stuck behind a lock costs one request per 5 s, never every request.
 */
export async function healPendingBoardBump(): Promise<void> {
  if (!boardBumpPending || healInflight) return;
  const now = Date.now();
  if (now - lastHealAttempt < HEAL_MIN_INTERVAL_MS) return;
  lastHealAttempt = now;
  healInflight = bumpBoard()
    .then(() => undefined)
    .finally(() => {
      healInflight = null;
    });
  await healInflight;
}

// ── Live phases (bootstrap; the board snapshot reads phases in its own statement) ────

const phasesMemo = createSingleFlightMemo({ ttlMs: 60_000, maxEntries: 1 });

/** Live (non-archived) phases in board order. Memoised 60 s: phases change only by script. */
export function getLivePhases(): Promise<PipelinePhase[]> {
  return phasesMemo.memo("phases", () =>
    pipelineRead(async (db) => {
      const rows = await db.$queryRaw<
        Array<{ id: string; key: string; name: string; position: number; color: string; is_terminal: boolean }>
      >`
        SELECT id, key, name, position, color, is_terminal
          FROM pipeline_phases
         WHERE archived_at IS NULL
         ORDER BY position, id`;
      return rows.map((r) => ({
        id: r.id,
        key: r.key,
        name: r.name,
        position: r.position,
        color: r.color,
        isTerminal: r.is_terminal,
      }));
    }),
  );
}

export function invalidatePhases(): void {
  phasesMemo.clear();
}

/** Tests only. */
export function resetBoardStateForTests(): void {
  boardBumpPending = false;
  bumpFailGen = 0;
  warnedMissingRow = false;
  lastHealAttempt = 0;
}
