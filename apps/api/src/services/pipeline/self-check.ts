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
 * unknown, gated requests answer 503 at once (no re-probe) for TRANSIENT_BACKOFF_MS, and
 * the first request after that checks again — so a blip costs one 6-statement probe per
 * 5 s, not one per request.
 *
 * Runs after `listen` (index.ts) and lazily on the first gated request, single-flight.
 *
 * THE EMAIL OUTBOX HAS ITS OWN VERDICT (isPipelineEmailSchemaOk). The same probe checks
 * pipeline_email_outbox's columns and EXPLAINs the exact `ON CONFLICT ... WHERE status =
 * 'pending'` clause the enqueue uses — EXPLAIN plans without executing, and planning fails
 * when the partial unique index (scripts/pipeline-email-ddl.sql) is missing. A missing
 * outbox or index turns EMAIL off (enqueue and worker both no-op) but NEVER pauses the
 * pipeline itself: email is an add-on, so its missing DDL must not take the board down,
 * and an enqueue can never fail an action's transaction. While the email verdict is false
 * the worker re-probes it at most once a minute (recheckPipelineEmailSchema).
 */
import { AppError } from "../../middleware/error-handler";
import { PipelineError, PIPELINE_RETRY_AFTER_SEC, normalizePipelineError } from "./errors";
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

/** The email outbox (email-outbox.ts). Keep in step with schema.prisma. */
export const PIPELINE_EMAIL_TABLE_COLUMNS: readonly string[] = [
  "id", "user_id", "project_id", "kind", "payload", "status", "attempts", "send_after",
  "last_error", "sent_at", "created_at", "updated_at",
];

/**
 * Planned, never executed: fails at plan time with "there is no unique or exclusion
 * constraint matching the ON CONFLICT specification" when the partial index is missing.
 */
export const PIPELINE_EMAIL_ARBITER_PROBE = `EXPLAIN INSERT INTO "pipeline_email_outbox"
  ("id", "user_id", "project_id", "kind", "payload", "status", "attempts", "send_after", "created_at", "updated_at")
  SELECT 'probe', 'probe', 'probe', 'moved', '{}'::jsonb, 'pending', 0, now(), now(), now() WHERE false
  ON CONFLICT ("user_id", "project_id", "kind") WHERE "status" = 'pending' DO NOTHING`;

const RECHECK_MS = 10 * 60_000;
const EMAIL_RECHECK_MS = 60_000;
const TRANSIENT_BACKOFF_MS = 5_000;

/** null = not checked yet in this process. */
let schemaOk: boolean | null = null;
let inflight: Promise<boolean> | null = null;
let recheckTimer: ReturnType<typeof setInterval> | null = null;
/** When the last check could not run (transient); 0 = never / cleared. */
let lastTransientAt = 0;
/** The email outbox verdict: null = not checked yet. Never affects `schemaOk`. */
let emailSchemaOk: boolean | null = null;
let emailCheckedAt = 0;
let emailFailureLogged = false;

export function isPipelineSchemaOk(): boolean | null {
  return schemaOk;
}

/** True only when pipeline_email_outbox and its partial unique index are both present. */
export function isPipelineEmailSchemaOk(): boolean | null {
  return emailSchemaOk;
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

type ProbeDb = { $queryRawUnsafe: (sql: string) => Promise<unknown> };

/** The email half of the probe. Throws the raw DB error when the schema is missing. */
async function probeEmail(db: ProbeDb): Promise<void> {
  await db.$queryRawUnsafe(
    `SELECT ${PIPELINE_EMAIL_TABLE_COLUMNS.map((c) => `"${c}"`).join(", ")} FROM "pipeline_email_outbox" LIMIT 0`,
  );
  await db.$queryRawUnsafe(PIPELINE_EMAIL_ARBITER_PROBE);
}

/** Record an email verdict from a probe outcome; a transient failure leaves it unknown. */
function recordEmailVerdict(err: unknown | null): void {
  emailCheckedAt = Date.now();
  if (err === null) {
    if (emailSchemaOk === false && process.env.NODE_ENV !== "test") console.log("[pipeline] email schema check passed");
    emailSchemaOk = true;
    emailFailureLogged = false;
    return;
  }
  if (isTransient(normalizePipelineError(err))) return;
  emailSchemaOk = false;
  if (!emailFailureLogged) {
    emailFailureLogged = true;
    console.warn(
      "[pipeline] ⚠️ EMAIL SCHEMA CHECK FAILED — pipeline emails are OFF (the board is unaffected) until scripts/pipeline-email-ddl.sql is applied:",
      String(err),
    );
  }
}

async function probe(): Promise<void> {
  await pipelineRead(async (db) => {
    // Sequential on purpose (one connection; no Promise.all over queries).
    for (const [table, cols] of Object.entries(PIPELINE_TABLE_COLUMNS)) {
      // Identifiers come from the constant above, never from input.
      await db.$queryRawUnsafe(`SELECT ${cols.map((c) => `"${c}"`).join(", ")} FROM "${table}" LIMIT 0`);
    }
    await db.$queryRawUnsafe(`SELECT 'PIPELINE'::"NotificationType"::text AS t`);
    // Autocommit statements: a failure here costs nothing above and never fails the check.
    let emailErr: unknown | null = null;
    try {
      await probeEmail(db);
    } catch (err) {
      emailErr = err;
    }
    recordEmailVerdict(emailErr);
  });
}

/**
 * The email worker, while the email verdict is false (or unknown after a transient
 * failure): re-probe the email half alone, at most once a minute. Resolves the verdict.
 */
export async function recheckPipelineEmailSchema(): Promise<boolean | null> {
  if (emailSchemaOk === true) return true;
  if (Date.now() - emailCheckedAt < EMAIL_RECHECK_MS && emailSchemaOk !== null) return emailSchemaOk;
  try {
    await pipelineRead(async (db) => {
      let emailErr: unknown | null = null;
      try {
        await probeEmail(db);
      } catch (err) {
        emailErr = err;
      }
      recordEmailVerdict(emailErr);
    });
  } catch {
    // the slot itself was refused (busy) — the verdict stays as it was
  }
  return emailSchemaOk;
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
    if (isTransient(err)) {
      lastTransientAt = Date.now();
      throw err;
    }
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
  if (!inflight && Date.now() - lastTransientAt < TRANSIENT_BACKOFF_MS) {
    // The last check could not run moments ago: answer 503 without probing again.
    throw new PipelineError(503, "PIPELINE_BUSY", "The pipeline is busy — retrying shortly", {
      retryAfterSec: PIPELINE_RETRY_AFTER_SEC,
    });
  }
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
  lastTransientAt = 0;
  emailSchemaOk = null;
  emailCheckedAt = 0;
  stopRecheck();
}

/** Tests only: force the email verdict (false = the outbox or its partial index is missing). */
export function __setPipelineEmailSchemaOkForTests(value: boolean | null): void {
  emailSchemaOk = value;
  emailCheckedAt = value === null ? 0 : Date.now();
}

/** Tests only: force a verdict (false = the schema is missing → paused). */
export function __setPipelineSchemaOkForTests(value: boolean | null): void {
  schemaOk = value;
  if (value !== false) stopRecheck();
}
