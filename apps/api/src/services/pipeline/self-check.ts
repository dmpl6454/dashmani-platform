/**
 * Boot schema self-check (spec §3.2, §12 step 5).
 *
 * The pipeline's DDL is applied to production BY HAND before merge. If a deploy ever
 * reaches a database without it (a missed DDL step, a restore), every pipeline statement
 * would fail with "relation does not exist" → 500s. Instead this check runs one
 * `SELECT <every column> FROM <table> LIMIT 0` per pipeline table plus
 * `SELECT 'PIPELINE'::"NotificationType"` on pipelineDb:
 *   - pass → pipelineSchemaOk = true, then one post-commit board bump (§5.1), which
 *     invalidates every open board after a restart;
 *   - fail → logged loudly, pipelineSchemaOk = false: every gated route answers 403
 *     PIPELINE_DISABLED (clients show "paused" and re-check), no job runs, and the check
 *     is repeated every 10 minutes until it passes.
 * A TRANSIENT failure (pool busy, DB restarting) is not a schema verdict: the state stays
 * unknown and the next request checks again.
 *
 * Runs after `listen` (index.ts) and lazily on the first gated request, single-flight.
 */
import { AppError } from "../../middleware/error-handler";
import { pipelineRead } from "./tx";
import { bumpBoard } from "./board";

/** Every column of every pipeline table (spec §2). Keep in step with schema.prisma. */
export const PIPELINE_TABLE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  pipeline_phases: ["id", "key", "name", "position", "color", "is_terminal", "archived_at", "created_at", "updated_at"],
  pipeline_board_state: ["id", "seq", "updated_at"],
  pipeline_projects: [
    "id", "client_id", "title", "description", "owner_id", "created_by_id", "phase_id", "rank",
    "start_date", "due_date", "header_rev", "thread_rev", "last_message_seq", "last_message_at",
    "member_count", "phase_changed_at", "phase_changed_by_id", "move_gen", "move_actor_id",
    "move_started_at", "move_last_at", "move_from_phase_id", "due_soon_notified_for",
    "overdue_notified_for", "archived_at", "archived_by_id", "archived_by_admin", "deleted_at",
    "deleted_by_id", "deleted_by_admin", "created_at", "updated_at",
  ],
  pipeline_participants: [
    "project_id", "user_id", "role", "notify", "last_read_seq", "seen_at", "engaged_at",
    "member_added_by_id", "member_added_at", "created_at", "updated_at",
  ],
  pipeline_messages: [
    "id", "client_id", "project_id", "seq", "rev", "parent_id", "author_id", "body", "mention_ids",
    "reactions", "reply_count", "last_reply_at", "edited_at", "deleted_at", "created_at", "updated_at",
  ],
};

const RECHECK_MS = 10 * 60_000;

/** null = not checked yet in this process. */
let schemaOk: boolean | null = null;
let inflight: Promise<boolean> | null = null;
let recheckTimer: ReturnType<typeof setInterval> | null = null;

export function isPipelineSchemaOk(): boolean | null {
  return schemaOk;
}

function isTransient(err: unknown): boolean {
  return err instanceof AppError && err.statusCode === 503;
}

function stopRecheck(): void {
  if (recheckTimer) {
    clearInterval(recheckTimer);
    recheckTimer = null;
  }
}

function scheduleRecheck(): void {
  if (recheckTimer) return;
  recheckTimer = setInterval(() => {
    runPipelineSelfCheck().catch(() => {
      // transient — the next tick or request retries
    });
  }, RECHECK_MS);
  recheckTimer.unref?.();
}

async function probe(): Promise<void> {
  await pipelineRead(async (db) => {
    // Sequential on purpose (one connection; no Promise.all over queries).
    for (const [table, cols] of Object.entries(PIPELINE_TABLE_COLUMNS)) {
      // Identifiers come from the constant above, never from input.
      await db.$queryRawUnsafe(`SELECT ${cols.map((c) => `"${c}"`).join(", ")} FROM "${table}" LIMIT 0`);
    }
    await db.$queryRawUnsafe(`SELECT 'PIPELINE'::"NotificationType"::text AS t`);
  });
}

/**
 * Run the check (single-flight). Resolves true/false for a schema verdict.
 * @throws the 503 AppError when the check could not run (transient); state stays unknown.
 */
export function runPipelineSelfCheck(): Promise<boolean> {
  if (!inflight) {
    inflight = checkOnce().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

async function checkOnce(): Promise<boolean> {
  try {
    await probe();
  } catch (err) {
    if (isTransient(err)) throw err;
    schemaOk = false;
    console.error(
      "[pipeline] ⚠️ SCHEMA SELF-CHECK FAILED — the pipeline is PAUSED (403 PIPELINE_DISABLED) until the pipeline DDL is applied. Re-checking every 10 min.",
      err,
    );
    scheduleRecheck();
    return false;
  }
  const wasOk = schemaOk === true;
  schemaOk = true;
  stopRecheck();
  if (!wasOk) {
    if (process.env.NODE_ENV !== "test") console.log("[pipeline] schema self-check passed");
    // One post-commit board bump per process start (and per recovery): every open board
    // adopts a fresh snapshot, which covers a crash between a commit and its bump.
    await bumpBoard();
  }
  return true;
}

/** The gate's view: the verdict, checking first if this process has not checked yet. */
export async function ensurePipelineSchemaChecked(): Promise<boolean> {
  if (schemaOk !== null) return schemaOk;
  return runPipelineSelfCheck();
}

/** index.ts, after listen. Never throws. */
export function startPipelineSelfCheck(): void {
  runPipelineSelfCheck().catch((err) => {
    console.warn("[pipeline] boot self-check could not run (will retry on the first request):", String(err));
  });
}

/** Forget the verdict so the next gated request checks again (a cheap re-check). */
export function resetPipelineSchemaCheck(): void {
  schemaOk = null;
  stopRecheck();
}

/** Tests only: force a verdict (false = the schema is missing → paused). */
export function __setPipelineSchemaOkForTests(value: boolean | null): void {
  schemaOk = value;
  if (value !== false) stopRecheck();
}
