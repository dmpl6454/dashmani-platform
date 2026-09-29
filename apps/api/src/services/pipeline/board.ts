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
 * getBoardSnapshot(v) (§5.3) builds the whole board in ONE statement, so its label equals
 * its rows, and caches it: the cache is served only while `cache.v === board_v` (a newer
 * OR a regressed v — e.g. after a DB restore — forces a rebuild), and a rebuild is
 * single-flight: one rebuild per board change for the whole company.
 */
import { PIPELINE_LIMITS, type PipelineBoardSnapshot, type PipelinePhase, type PipelinePhaseCount } from "@dashmani/shared";
import { cardFromRow } from "./wire";
import { createSingleFlightMemo } from "../../utils/single-flight-memo";
import { pipelineRead, pipelineWriteStatement } from "./tx";
import { pipelineStats } from "./stats";

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
    pipelineStats.bumpFailure();
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
  snapshotCache = null;
}

// ── Board snapshot (§5.3) ────────────────────────────────────────────────────────────

let snapshotCache: PipelineBoardSnapshot | null = null;
let snapshotInflight: Promise<PipelineBoardSnapshot> | null = null;

type SnapRow = { v: number | null; phases: Array<Record<string, unknown>> | null; cards: Array<Record<string, unknown>> | null };

async function buildBoardSnapshot(): Promise<PipelineBoardSnapshot> {
  const cap = PIPELINE_LIMITS.cardsPerPhase;
  const rows = await pipelineRead((db) =>
    db.$queryRaw<SnapRow[]>`
      SELECT (SELECT seq FROM pipeline_board_state WHERE id = 1) AS v,
             (SELECT json_agg(ph ORDER BY ph.position, ph.id)
                FROM pipeline_phases ph WHERE ph.archived_at IS NULL) AS phases,
             (SELECT json_agg(c) FROM (
                SELECT ph.id AS phase_id, cards.*
                  FROM pipeline_phases ph
                 CROSS JOIN LATERAL (
                   SELECT p.id, p.title, p.rank, p.owner_id, p.start_date, p.due_date, p.member_count,
                          ARRAY(SELECT pp.user_id FROM pipeline_participants pp
                                 WHERE pp.project_id = p.id AND pp.role = 'MEMBER'
                                 ORDER BY pp.created_at, pp.user_id LIMIT 3) AS preview,
                          count(*) OVER ()::int AS phase_total
                     FROM pipeline_projects p
                    WHERE p.phase_id = ph.id AND p.archived_at IS NULL AND p.deleted_at IS NULL
                    ORDER BY p.rank COLLATE "C", p.id
                    LIMIT ${cap + 1}) cards
                 WHERE ph.archived_at IS NULL
                 ORDER BY ph.position, ph.id, cards.rank COLLATE "C", cards.id) c) AS cards`,
  );
  const row = rows[0];
  const phases: PipelinePhase[] = (row?.phases ?? []).map((r) => ({
    id: String(r.id),
    key: String(r.key),
    name: String(r.name),
    position: Number(r.position),
    color: String(r.color),
    isTerminal: r.is_terminal === true,
  }));
  const perPhase: Record<string, PipelinePhaseCount> = {};
  for (const ph of phases) perPhase[ph.id] = { shown: 0, total: 0, truncated: false };
  const cards = [];
  for (const r of row?.cards ?? []) {
    const phaseId = String(r.phase_id);
    const count = perPhase[phaseId] ?? (perPhase[phaseId] = { shown: 0, total: 0, truncated: false });
    count.total = Number(r.phase_total);
    count.truncated = count.total > cap;
    if (count.shown >= cap) continue; // the 101st row only proves truncation
    count.shown++;
    cards.push(cardFromRow(r));
  }
  return { v: Number(row?.v ?? 0), phases, cards, perPhase };
}

/**
 * The board at `boardV` (the caller's freshly read `pipeline_board_state.seq`). A cache hit
 * costs zero statements. A snapshot's `v` is the seq read in the SAME statement as its rows,
 * so it may be newer than `boardV` (never older than what it shows).
 */
export async function getBoardSnapshot(boardV: number): Promise<PipelineBoardSnapshot> {
  if (snapshotCache && snapshotCache.v === boardV) return snapshotCache;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!snapshotInflight) {
      snapshotInflight = buildBoardSnapshot().finally(() => {
        snapshotInflight = null;
      });
    }
    const snap = await snapshotInflight;
    snapshotCache = snap;
    // A rebuild that started before boardV's bump may carry an older v: build once more.
    // (A NEWER v is fine: the snapshot is at worst newer than the caller's read.)
    if (snap.v >= boardV || attempt === 1) return snap;
  }
  return snapshotCache!;
}

export function invalidateBoardSnapshot(): void {
  snapshotCache = null;
}

/** Tests only. */
export function resetBoardStateForTests(): void {
  snapshotCache = null;
  boardBumpPending = false;
  bumpFailGen = 0;
  warnedMissingRow = false;
  lastHealAttempt = 0;
}
