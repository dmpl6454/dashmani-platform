/**
 * Pipeline EMAIL worker (owner request 2026-09-30): turns due outbox rows into ONE digest
 * email per recipient. The enqueue half is services/pipeline/email-outbox.ts.
 *
 * SCHEDULE: a tick every 60 s, the first one 4 minutes after boot (index.ts), so a deploy
 * restart never lands a burst of mail on top of the boot work. The overlap flag is claimed
 * SYNCHRONOUSLY, before the first await.
 *
 * EACH TICK
 *   (0)   first, write any book-keeping an earlier tick of this process could not (see
 *         BOOK-KEEPING below);
 *   (i)   no-op unless pipeline.mode != off, pipeline.email = on, SMTP_USER/SMTP_PASS are
 *         set, HR_APP_URL is set in production, and the schema self-check passed for the
 *         pipeline AND the email outbox;
 *   (ii)  rows stuck in 'sending' for > 10 min (a crash mid-send) go back to pending —
 *         counted as an attempt, so a row that keeps crashing the process ends 'failed';
 *   (iii) claim ≤ 100 due pending rows for ≤ min(30, daily cap left) recipients, one
 *         recipient at a time, with FOR UPDATE SKIP LOCKED in ONE autocommit UPDATE →
 *         'sending'. A recipient emailed in the last RECIPIENT_MIN_INTERVAL_MS is held
 *         back: their rows wait and fold into the next digest (≤ 6 emails an hour each);
 *   (iv)  read the CURRENT state in bulk — one query each for projects+phases, messages and
 *         users (names from the directory memo) — and build one digest per recipient,
 *         skipping what no longer applies: a deleted message or withdrawn mention, a
 *         net-zero move or due change, a deleted or archived project, an unfollow, an
 *         inactive or no-longer-pilot recipient, anything older than a day. If that read
 *         fails, every claimed row goes back to pending UNHARMED (no attempt counted);
 *   (v)   send OUTSIDE any DB transaction and outside any bulkhead slot, through the
 *         dedicated pooled transport (email-mailer.ts), ≤ 30 emails per tick and
 *         PIPELINE_EMAIL_DAILY_CAP (default 300) per IST day. The settings memo is checked
 *         before EVERY send, so `--email=off` / `--mode=off` also stops a tick that is
 *         already running, within the memo's 15 s;
 *   (vi)  mark sent / skipped; a failure is retried with exponential backoff (2, 4, 8,
 *         16 min) and after 5 attempts becomes 'failed' with last_error. A recipient the
 *         server refuses for good (a 5xx at RCPT TO) is 'failed' at once. A broken
 *         transport or a refused SENDER account (a 421, MAIL FROM refused, 4.7.x / 5.7.x,
 *         the 5.4.5 daily limit) stops the tick — the rest go back to pending unharmed —
 *         and no send is tried for 5 min (15 for a login or account refusal, 60 for the
 *         daily limit): the SMTP account is shared with password resets and HR mail.
 *
 * DB RULES: only pipelineDb, ONE short autocommit statement per call, never a transaction,
 * never a slot held across a send. Everything a statement needs is computed before it;
 * nothing is looked up per row. The reads and the claim run at BACKGROUND priority
 * (pipelineBackground: a slot is granted only when no request is waiting).
 *
 * BOOK-KEEPING (mark sent / skipped, return rows to pending) completes work that already
 * happened, so it runs at WRITE priority (pipelineWriteStatement) — one primary-key-bounded
 * statement each — and is tried 3 times: a busy gate must not leave a DELIVERED email in
 * 'sending', where the 10-minute recovery would send it again. Whatever still fails is kept
 * in memory and written first thing next tick (the recovery leaves those rows alone
 * meanwhile). Only a restart in between falls back to the 10-minute recovery — at worst
 * one duplicate email, never a lost one.
 *
 * RETURNING A ROW TO PENDING can meet a NEWER pending row for the same (recipient,
 * project, kind) — created while it was 'sending' — and the partial unique index allows
 * only one. requeueRows() therefore merges the returning row's payload (and its attempts)
 * INTO that newer row (the same merge the enqueue uses) and marks itself 'skipped', in one
 * statement. It locks those siblings FOR UPDATE SKIP LOCKED, so it never waits for a
 * sibling that an action's transaction is writing; that key is simply tried again a moment
 * later.
 */
import { dateToIST, notificationSnippet, scanMentionTokens } from "@dashmani/shared";
import { Prisma, type PipelineDbClient } from "../services/pipeline/db";
import { pipelineBackground, pipelineWriteStatement } from "../services/pipeline/tx";
import { getPipelineSettings, isPilotUser, type PipelineSettings } from "../services/pipeline/settings";
import {
  ensurePipelineSchemaChecked,
  isPipelineEmailSchemaOk,
  recheckPipelineEmailSchema,
} from "../services/pipeline/self-check";
import { getPipelineDirectory, displayName } from "../services/pipeline/access";
import {
  EMAIL_KINDS,
  emailLinksConfigured,
  mergePayloadSql,
  mergePayloadTs,
  smtpConfigured,
  type EmailKind,
} from "../services/pipeline/email-outbox";
import { renderPipelineDigest, type DigestItem, type DigestMention } from "../services/pipeline/email-template";
import {
  MailPermanentError,
  MailTransportError,
  describeMailError,
  pipelineEmailFrom,
  sendPipelineMail,
  type MailOutage,
} from "../services/pipeline/email-mailer";
import { pipelineStats } from "../services/pipeline/stats";
import { warnThrottled } from "../utils/throttled-warn";

export const EMAIL_TICK_MS = 60_000;
export const EMAIL_FIRST_TICK_MS = 4 * 60_000;
export const CLAIM_ROWS = 100;
export const EMAILS_PER_TICK = 30;
export const MAX_ATTEMPTS = 5;
export const STALE_SENDING_MS = 10 * 60_000;
/** A pending row older than this is not worth an email any more (e.g. email was off for a day). */
export const STALE_ROW_MS = 24 * 60 * 60_000;
/** Stop starting new sends after this much of a tick (the tick interval is 60 s). */
export const TICK_BUDGET_MS = 45_000;
/**
 * After the transport itself fails, pause sending (not enqueueing) for a while: the SMTP
 * account is SHARED with every other platform email (password resets, HR mail), and a
 * worker retrying a bad password — or pushing into an account the server is refusing —
 * every minute could get that account rate-limited or locked.
 */
export const TRANSPORT_COOLDOWN_MS = 5 * 60_000;
export const AUTH_COOLDOWN_MS = 15 * 60_000;
export const ACCOUNT_COOLDOWN_MS = 15 * 60_000;
/** Gmail's daily sending limit (5.4.5) lasts hours: probe it at most once an hour. */
export const DAILY_LIMIT_COOLDOWN_MS = 60 * 60_000;
/**
 * A recipient emailed less than this long ago is held back from the claim: their newer
 * rows fold into the next digest, so one busy recipient gets at most ~6 emails an hour and
 * cannot spend the shared daily cap alone. In-process (a restart forgets it).
 */
export const RECIPIENT_MIN_INTERVAL_MS = 10 * 60_000;
const RELEASE_DELAY_MS = 60_000;
const RECOVER_BATCH = 200;
const SNIPPET_MAX = 280;
const IST_OFFSET_MIN = 330;
/** Pauses before the 2nd and 3rd try of a book-keeping statement. */
const BOOKKEEPING_RETRY_MS = [150, 600] as const;
/** Book-keeping operations kept for the next tick; beyond this the oldest take the 10-min path. */
const UNSETTLED_MAX = 200;

const NOW = Prisma.sql`timezone('utc', now())`;

export function dailyCap(): number {
  const raw = process.env.PIPELINE_EMAIL_DAILY_CAP;
  if (raw == null || raw.trim() === "") return 300;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 300;
}

/** Backoff after the `attempts`-th failure: 2, 4, 8, 16 min … capped at an hour. */
export function backoffMs(attempts: number): number {
  return Math.min(60 * 60_000, 2 * 60_000 * 2 ** Math.max(0, attempts - 1));
}

/** How long to pause every send after `outage` (email-mailer.ts MailOutage). */
export function cooldownMs(outage: MailOutage): number {
  if (outage === "limit") return DAILY_LIMIT_COOLDOWN_MS;
  if (outage === "auth") return AUTH_COOLDOWN_MS;
  if (outage === "account") return ACCOUNT_COOLDOWN_MS;
  return TRANSPORT_COOLDOWN_MS;
}

export type EmailTickResult =
  | {
      status: "skipped";
      reason: "running" | "off" | "email_off" | "smtp" | "config" | "smtp_cooldown" | "schema" | "busy" | "cap";
    }
  | {
      status: "ran";
      recovered: number;
      claimed: number;
      emails: number;
      failed: number;
      skippedRows: number;
      released: number;
    };

interface OutboxRow {
  id: string;
  user_id: string;
  project_id: string;
  kind: EmailKind;
  payload: Record<string, unknown>;
  attempts: number;
  created_at: Date;
}

const ROW_COLUMNS = Prisma.sql`id, user_id, project_id, kind, payload, attempts, created_at`;

let running = false;
/** Emails sent in the current IST day by this process (seeded from the DB once per day). */
let sentToday: { day: string; n: number } | null = null;
/** No send is attempted before this time (set after a transport failure). */
let transportCooldownUntil = 0;
/** recipient → when this process last emailed them (only entries younger than the interval). */
const lastEmailedAt = new Map<string, number>();

type Run = <T>(fn: (db: PipelineDbClient) => Promise<T>) => Promise<T>;
/** Reads, the claim and the recovery: background priority. */
const bg: Run = (fn) => pipelineBackground(fn);
/** Book-keeping for work already done: write priority. */
const bk: Run = (fn) => pipelineWriteStatement(fn);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Requeue (failure, release, recovery) ─────────────────────────────────────────────

interface Requeue {
  row: OutboxRow;
  /** attempts to store (already incremented for a failure or a recovery). */
  attempts: number;
  delayMs: number;
  err: string;
  /** The server refused this recipient for good: 'failed' now, whatever the attempts. */
  permanent?: boolean;
}

/**
 * Send rows back to pending (or to 'failed' at MAX_ATTEMPTS or when permanent), one
 * statement. Rows sharing a key are folded into one (TS merge, oldest first) and the rest
 * marked skipped; a newer pending sibling absorbs the returning row (SQL merge, attempts
 * carried) so the partial unique index is never violated and no mention is lost.
 *
 * LOCKS. Siblings are locked FOR UPDATE SKIP LOCKED, so this statement never waits for a
 * sibling that an action's transaction is writing (an enqueue's ON CONFLICT, or its
 * withdrawal DELETE, which Postgres runs after the INSERT). A key whose sibling was skipped
 * is left exactly as it was ('sending') and returned, and the caller tries it again.
 *
 * @returns the items left untouched because their sibling was busy.
 */
async function requeueRows(items: Requeue[], run: Run): Promise<Requeue[]> {
  if (items.length === 0) return [];
  const groups = new Map<string, Requeue[]>();
  for (const it of items) {
    const key = `${it.row.user_id}\u0000${it.row.project_id}\u0000${it.row.kind}`;
    const g = groups.get(key);
    if (g) g.push(it);
    else groups.set(key, [it]);
  }
  const byKeep = new Map<string, Requeue[]>();
  const payload = [...groups.values()].map((g) => {
    g.sort((a, b) => a.row.created_at.getTime() - b.row.created_at.getTime() || (a.row.id < b.row.id ? -1 : 1));
    let merged = g[0].row.payload;
    for (const it of g.slice(1)) merged = mergePayloadTs(merged, it.row.payload);
    const attempts = Math.max(...g.map((x) => x.attempts));
    const keep = g[0];
    byKeep.set(keep.row.id, g);
    return {
      keep_id: keep.row.id,
      drop_ids: g.slice(1).map((x) => x.row.id),
      user_id: keep.row.user_id,
      project_id: keep.row.project_id,
      kind: keep.row.kind,
      payload: merged,
      attempts,
      delay_ms: Math.max(...g.map((x) => x.delayMs)),
      err: keep.err.slice(0, 500),
      final: g.some((x) => x.permanent === true) || attempts >= MAX_ATTEMPTS ? "failed" : "pending",
    };
  });
  const blocked = await run((db) => db.$queryRaw<Array<{ keep_id: string }>>`
    WITH g AS (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb)
        AS g(keep_id text, drop_ids text[], user_id text, project_id text, kind text, payload jsonb,
             attempts int, delay_ms int, err text, final text)
    ), cand AS (
      -- The pending siblings visible now (at most one per key: the partial unique index).
      SELECT g.keep_id
        FROM pipeline_email_outbox s
        JOIN g ON s.user_id = g.user_id AND s.project_id = g.project_id AND s.kind = g.kind
       WHERE g.final = 'pending' AND s.status = 'pending'
    ), lk AS (
      -- The same siblings, locked WITHOUT waiting, in (user, project, kind) order.
      SELECT s.id AS sid, g.keep_id, g.payload AS gpayload, g.delay_ms, g.attempts
        FROM pipeline_email_outbox s
        JOIN g ON s.user_id = g.user_id AND s.project_id = g.project_id AND s.kind = g.kind
       WHERE g.final = 'pending' AND s.status = 'pending'
       ORDER BY s.user_id, s.project_id, s.kind
         FOR UPDATE OF s SKIP LOCKED
    ), blocked AS (
      SELECT keep_id FROM cand EXCEPT SELECT keep_id FROM lk
    ), sib AS (
      UPDATE pipeline_email_outbox s
         SET payload = ${mergePayloadSql(Prisma.sql`lk.gpayload`, Prisma.sql`s.payload`)},
             attempts = GREATEST(s.attempts, lk.attempts),
             send_after = LEAST(s.send_after, ${NOW} + (lk.delay_ms * interval '1 millisecond')),
             updated_at = ${NOW}
        FROM lk
       WHERE s.id = lk.sid
   RETURNING lk.keep_id AS id
    ), dropped AS (
      UPDATE pipeline_email_outbox d
         SET status = 'skipped', last_error = 'merged into another row for the same email', updated_at = ${NOW}
        FROM g
       WHERE d.id = ANY(g.drop_ids) AND d.status = 'sending'
         AND NOT EXISTS (SELECT 1 FROM blocked b WHERE b.keep_id = g.keep_id)
   RETURNING d.id
    ), kept AS (
      UPDATE pipeline_email_outbox o
         SET status = CASE WHEN o.id IN (SELECT id FROM sib) THEN 'skipped' ELSE g.final END,
             payload = g.payload,
             attempts = g.attempts,
             send_after = ${NOW} + (g.delay_ms * interval '1 millisecond'),
             last_error = CASE WHEN o.id IN (SELECT id FROM sib) THEN 'merged into a newer pending row' ELSE g.err END,
             updated_at = ${NOW}
        FROM g
       WHERE o.id = g.keep_id AND o.status = 'sending'
         AND NOT EXISTS (SELECT 1 FROM blocked b WHERE b.keep_id = g.keep_id)
   RETURNING o.id
    )
    SELECT keep_id FROM blocked`);
  return blocked.flatMap((b) => byKeep.get(b.keep_id) ?? []);
}

// ── Book-keeping that must not be lost ───────────────────────────────────────────────

type Unsettled =
  | { kind: "sent"; ids: string[] }
  | { kind: "skip"; skips: Array<{ id: string; reason: string }> }
  | { kind: "requeue"; items: Requeue[] };

/** Written first thing next tick, by this process (see the header). */
const unsettled: Unsettled[] = [];

function unsettledIds(): string[] {
  return unsettled.flatMap((u) =>
    u.kind === "sent" ? u.ids : u.kind === "skip" ? u.skips.map((x) => x.id) : u.items.map((x) => x.row.id),
  );
}

function carry(op: Unsettled, err: unknown, what: string): void {
  unsettled.push(op);
  if (unsettled.length > UNSETTLED_MAX) unsettled.splice(0, unsettled.length - UNSETTLED_MAX);
  warnThrottled(
    `pipeline-email-settle:${what}`,
    `[pipeline-email] could not ${what} (${err === null ? "a row it merges into is busy" : String(err)}) — retrying next tick`,
  );
}

function markSentStmt(db: PipelineDbClient, ids: string[]) {
  // ONE statement per digest: every row of it gets the same sent_at, which is how the
  // daily cap counts emails (count(DISTINCT (user_id, sent_at))), not rows.
  return db.$executeRaw`
    UPDATE pipeline_email_outbox SET status = 'sent', sent_at = ${NOW}, last_error = NULL, updated_at = ${NOW}
     WHERE id = ANY(${ids}::text[]) AND status = 'sending'`;
}

function markSkippedStmt(db: PipelineDbClient, skips: Array<{ id: string; reason: string }>) {
  return db.$executeRaw`
    UPDATE pipeline_email_outbox o
       SET status = 'skipped', last_error = v.reason, updated_at = ${NOW}
      FROM unnest(${skips.map((s) => s.id)}::text[], ${skips.map((s) => s.reason)}::text[]) AS v(id, reason)
     WHERE o.id = v.id AND o.status = 'sending'`;
}

/** One book-keeping statement at write priority, up to 3 tries. @returns the last error, or null. */
async function bookkeep(fn: (db: PipelineDbClient) => Promise<unknown>): Promise<unknown | null> {
  let last: unknown = null;
  for (let i = 0; i <= BOOKKEEPING_RETRY_MS.length; i++) {
    if (i > 0) await sleep(BOOKKEEPING_RETRY_MS[i - 1]);
    try {
      await bk(fn);
      return null;
    } catch (err) {
      last = err;
    }
  }
  return last ?? new Error("book-keeping failed");
}

async function settleSent(ids: string[]): Promise<void> {
  const err = await bookkeep((db) => markSentStmt(db, ids));
  if (err !== null) carry({ kind: "sent", ids }, err, "mark sent");
}

async function settleSkipped(skips: Array<{ id: string; reason: string }>): Promise<void> {
  if (skips.length === 0) return;
  pipelineStats.emailSkipped(skips.length);
  const err = await bookkeep((db) => markSkippedStmt(db, skips));
  if (err !== null) carry({ kind: "skip", skips }, err, "mark rows skipped");
}

/** Requeue at write priority, up to 3 tries (a busy sibling included); the rest is carried. */
async function settleRequeue(items: Requeue[], what: string): Promise<void> {
  let left = items;
  let last: unknown = null;
  for (let i = 0; i <= BOOKKEEPING_RETRY_MS.length && left.length > 0; i++) {
    if (i > 0) await sleep(BOOKKEEPING_RETRY_MS[i - 1]);
    try {
      left = await requeueRows(left, bk);
      last = null;
    } catch (err) {
      last = err;
    }
  }
  if (left.length > 0) carry({ kind: "requeue", items: left }, last, what);
}

/** (0) Write what an earlier tick could not — one try each; what fails waits again. Never throws. */
async function flushUnsettled(): Promise<void> {
  const ops = unsettled.splice(0);
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    try {
      if (op.kind === "sent") await bk((db) => markSentStmt(db, op.ids));
      else if (op.kind === "skip") await bk((db) => markSkippedStmt(db, op.skips));
      else {
        const left = await requeueRows(op.items, bk);
        if (left.length > 0) unsettled.push({ kind: "requeue", items: left });
      }
    } catch {
      unsettled.push(...ops.slice(i)); // busy: all of the rest next tick
      return;
    }
  }
}

/**
 * (ii) 'sending' rows older than 10 min: a send was interrupted (crash, restart). Rows this
 * process still holds book-keeping for are left alone (it knows their real outcome); a key
 * whose sibling is busy right now is simply recovered on a later tick.
 */
async function recoverStale(): Promise<number> {
  const held = unsettledIds();
  const rows = await bg((db) => db.$queryRaw<OutboxRow[]>`
    SELECT ${ROW_COLUMNS} FROM pipeline_email_outbox
     WHERE status = 'sending' AND updated_at < ${NOW} - (${STALE_SENDING_MS}::int * interval '1 millisecond')
       AND NOT (id = ANY(${held}::text[]))
     ORDER BY updated_at
     LIMIT ${RECOVER_BATCH}::int`);
  if (rows.length === 0) return 0;
  const left = await requeueRows(
    rows.map((row) => ({ row, attempts: row.attempts + 1, delayMs: 0, err: "recovered after an interrupted send" })),
    bg,
  );
  return rows.length - left.length;
}

// ── The daily cap (per IST day, counted in EMAILS: a digest's rows share one sent_at) ──

async function emailsSentToday(day: string): Promise<number> {
  if (sentToday?.day === day) return sentToday.n;
  const [row] = await bg((db) => db.$queryRaw<Array<{ n: number }>>`
    SELECT count(DISTINCT (user_id, sent_at))::int AS n FROM pipeline_email_outbox
     WHERE status = 'sent'
       AND sent_at >= ${day}::date::timestamp - (${IST_OFFSET_MIN}::int * interval '1 minute')`);
  sentToday = { day, n: row?.n ?? 0 };
  return sentToday.n;
}

/** Recipients emailed within RECIPIENT_MIN_INTERVAL_MS of `nowMs` (older entries are dropped). */
function heldBackRecipients(nowMs: number): string[] {
  const out: string[] = [];
  for (const [uid, at] of lastEmailedAt) {
    if (nowMs - at >= RECIPIENT_MIN_INTERVAL_MS) lastEmailedAt.delete(uid);
    else out.push(uid);
  }
  return out;
}

// ── (iii) the claim ──────────────────────────────────────────────────────────────────

/**
 * The claim statement (exported for the EXPLAIN in the load measurement): the `users`
 * recipients whose mail has waited longest, then ≤ 100 of their due rows taken ONE
 * RECIPIENT AT A TIME (ordered by that recipient's first due row), so a recipient's due
 * rows land in one digest — at most the last recipient of a full claim is split.
 * `holdBack` are recipients emailed within RECIPIENT_MIN_INTERVAL_MS: their rows wait.
 */
export function claimStatement(
  users: number,
  prefix: "" | "EXPLAIN" | "EXPLAIN (ANALYZE, BUFFERS)" = "",
  holdBack: readonly string[] = [],
): Prisma.Sql {
  return Prisma.sql`${prefix ? Prisma.raw(prefix) : Prisma.empty}
    WITH u AS (
      SELECT y.user_id, min(y.send_after) AS first_due
        FROM pipeline_email_outbox y
       WHERE y.status = 'pending' AND y.send_after <= ${NOW}
         AND NOT (y.user_id = ANY(${[...holdBack]}::text[]))
       GROUP BY y.user_id
       ORDER BY first_due, y.user_id
       LIMIT ${users}::int)
    UPDATE pipeline_email_outbox o SET status = 'sending', updated_at = ${NOW}
     WHERE o.id IN (
       SELECT x.id FROM pipeline_email_outbox x
         JOIN u ON u.user_id = x.user_id
        WHERE x.status = 'pending' AND x.send_after <= ${NOW}
        ORDER BY u.first_due, x.user_id, x.send_after
        LIMIT ${CLAIM_ROWS}::int
          FOR UPDATE OF x SKIP LOCKED)
       AND o.status = 'pending'
 RETURNING o.id, o.user_id, o.project_id, o.kind, o.payload, o.attempts, o.created_at`;
}

// ── (iv) the current state ───────────────────────────────────────────────────────────

interface ProjectState {
  id: string;
  title: string;
  phase_id: string;
  phase_name: string;
  is_terminal: boolean;
  due: string | null;
  archived: boolean;
  deleted: boolean;
  notify_ids: string[];
  phase_names: Record<string, string>;
}
interface MessageState {
  id: string;
  project_id: string;
  parent_id: string | null;
  author_id: string;
  body: string;
  mention_ids: string[];
  deleted: boolean;
}
interface UserState {
  id: string;
  email: string | null;
  name: string;
  active: boolean;
}

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

async function readState(rows: OutboxRow[]) {
  const pids = [...new Set(rows.map((r) => r.project_id))];
  const uids = [...new Set(rows.map((r) => r.user_id))];
  const phaseIds = [...new Set(rows.flatMap((r) => (typeof r.payload.fromPhaseId === "string" ? [r.payload.fromPhaseId] : [])))];
  const mids = [...new Set(rows.flatMap((r) => (r.kind === "mention" ? strList(r.payload.messageIds) : [])))];

  const projects = await bg((db) => db.$queryRaw<ProjectState[]>`
    SELECT p.id, p.title, p.phase_id, ph.name AS phase_name, ph.is_terminal,
           to_char(p.due_date, 'YYYY-MM-DD') AS due,
           (p.archived_at IS NOT NULL) AS archived, (p.deleted_at IS NOT NULL) AS deleted,
           ARRAY(SELECT pp.user_id FROM pipeline_participants pp
                  WHERE pp.project_id = p.id AND pp.notify AND pp.user_id = ANY(${uids}::text[])) AS notify_ids,
           (SELECT COALESCE(json_object_agg(x.id, x.name), '{}'::json)
              FROM pipeline_phases x WHERE x.id = ANY(${phaseIds}::text[])) AS phase_names
      FROM pipeline_projects p
      JOIN pipeline_phases ph ON ph.id = p.phase_id
     WHERE p.id = ANY(${pids}::text[])`);
  const messages = mids.length
    ? await bg((db) => db.$queryRaw<MessageState[]>`
        SELECT m.id, m.project_id, m.parent_id, m.author_id, m.body,
               COALESCE(m.mention_ids, '{}'::text[]) AS mention_ids, (m.deleted_at IS NOT NULL) AS deleted
          FROM pipeline_messages m WHERE m.id = ANY(${mids}::text[])`)
    : [];
  const users = await bg((db) => db.$queryRaw<UserState[]>`
    SELECT u.id, u.email, u.name, (u.status = 'ACTIVE' AND u.deleted_at IS NULL) AS active
      FROM users u WHERE u.id = ANY(${uids}::text[])`);
  return {
    projects: new Map(projects.map((p) => [p.id, p])),
    messages: new Map(messages.map((m) => [m.id, m])),
    users: new Map(users.map((u) => [u.id, u])),
  };
}

type Resolved = { item: DigestItem } | { skip: string };

const KIND_ORDER: Record<EmailKind, number> = { mention: 0, moved: 1, due_changed: 2, due_soon: 3 };

function resolveRow(
  row: OutboxRow,
  state: Awaited<ReturnType<typeof readState>>,
  nameOf: (id: string) => string,
  today: string,
  nowMs: number,
): Resolved {
  const p = state.projects.get(row.project_id);
  if (!p || p.deleted) return { skip: "project deleted" };
  if (p.archived) return { skip: "project archived" };
  if (nowMs - new Date(row.created_at).getTime() > STALE_ROW_MS) return { skip: "stale (older than a day)" };
  const followed = p.notify_ids.includes(row.user_id);
  const actorNames = strList(row.payload.actorIds).map(nameOf);
  switch (row.kind) {
    case "moved": {
      if (!followed) return { skip: "no longer following" };
      const from = typeof row.payload.fromPhaseId === "string" ? row.payload.fromPhaseId : null;
      if (from === null || from === p.phase_id) return { skip: "net-zero move" };
      return {
        item: {
          kind: "moved",
          projectId: p.id,
          projectTitle: p.title,
          actorNames,
          fromPhase: p.phase_names[from] ?? "another phase",
          toPhase: p.phase_name,
        },
      };
    }
    case "due_changed": {
      if (!followed) return { skip: "no longer following" };
      const fromDue = typeof row.payload.fromDue === "string" ? row.payload.fromDue : null;
      if (fromDue === p.due) return { skip: "net-zero due change" };
      return { item: { kind: "due_changed", projectId: p.id, projectTitle: p.title, actorNames, fromDue, toDue: p.due } };
    }
    case "due_soon": {
      if (!followed) return { skip: "no longer following" };
      const due = typeof row.payload.due === "string" ? row.payload.due : null;
      if (!due || due !== p.due) return { skip: "due date changed" };
      if (p.is_terminal) return { skip: "finished phase" };
      if (due < today) return { skip: "due date passed" };
      return { item: { kind: "due_soon", projectId: p.id, projectTitle: p.title, due, phase: p.phase_name } };
    }
    case "mention": {
      const mentions: DigestMention[] = [];
      for (const mid of strList(row.payload.messageIds)) {
        const m = state.messages.get(mid);
        if (!m || m.deleted || m.project_id !== row.project_id || !m.mention_ids.includes(row.user_id)) continue;
        const names = new Map(scanMentionTokens(m.body).map((t) => [t.id, nameOf(t.id)]));
        mentions.push({
          messageId: m.id,
          rootId: m.parent_id,
          authorName: nameOf(m.author_id),
          snippet: notificationSnippet(m.body, names, SNIPPET_MAX),
        });
      }
      if (mentions.length === 0) return { skip: "mention deleted or removed" };
      return { item: { kind: "mention", projectId: p.id, projectTitle: p.title, mentions } };
    }
    default:
      return { skip: "unknown kind" };
  }
}

// ── The tick ─────────────────────────────────────────────────────────────────────────

interface Digest {
  user: UserState;
  rows: OutboxRow[];
  items: DigestItem[];
}

/** (iv) Read the current state and build one digest per recipient. Throws on a DB failure. */
async function buildDigests(claimed: OutboxRow[], settings: PipelineSettings, today: string, nowMs: number) {
  const state = await readState(claimed);
  const directory = await getPipelineDirectory();
  const nameOf = (id: string) => directory.byId.get(id)?.name ?? "Someone";
  const skips: Array<{ id: string; reason: string }> = [];
  const digests = new Map<string, Digest>();
  for (const row of claimed) {
    const user = state.users.get(row.user_id);
    let resolved: Resolved;
    if (!user || !user.active) resolved = { skip: "recipient inactive" };
    else if (settings.mode === "pilot" && !isPilotUser(settings, user.id)) resolved = { skip: "recipient not in the pilot" };
    else if (!user.email || !user.email.includes("@")) resolved = { skip: "recipient has no email address" };
    else if (!(EMAIL_KINDS as readonly string[]).includes(row.kind)) resolved = { skip: "unknown kind" };
    else resolved = resolveRow(row, state, nameOf, today, nowMs);
    if ("skip" in resolved) {
      skips.push({ id: row.id, reason: resolved.skip });
      continue;
    }
    const d = digests.get(user!.id) ?? { user: user!, rows: [], items: [] };
    d.rows.push(row);
    d.items.push(resolved.item);
    digests.set(user!.id, d);
  }
  return { digests: [...digests.values()], skips };
}

function gateSkip(settings: PipelineSettings): EmailTickResult | null {
  if (settings.mode === "off") return { status: "skipped", reason: "off" };
  if (!settings.email) return { status: "skipped", reason: "email_off" };
  if (!smtpConfigured()) return { status: "skipped", reason: "smtp" };
  if (!emailLinksConfigured()) {
    warnThrottled("pipeline-email-config", "[pipeline-email] HR_APP_URL is not set — pipeline emails are OFF (every link would point at localhost)");
    return { status: "skipped", reason: "config" };
  }
  return null;
}

/**
 * One tick. `now` is injectable for tests (staleness, IST day, relative due dates, pauses);
 * so is `clock` — what time it is at each SEND (default: `now` advanced by the real time the
 * tick has taken), so a test can start a tick before IST midnight and send after it (D7).
 */
export function runPipelineEmailTick(opts: { now?: Date; clock?: () => number } = {}): Promise<EmailTickResult> {
  if (running) return Promise.resolve({ status: "skipped", reason: "running" });
  running = true; // claimed before the first await
  return (async (): Promise<EmailTickResult> => {
    try {
      const started = Date.now();
      const now = opts.now ?? new Date();
      /** `now`, advanced by the real time this tick has taken. */
      const clock = opts.clock ?? (() => now.getTime() + (Date.now() - started));

      await flushUnsettled();

      let settings: PipelineSettings;
      try {
        settings = await getPipelineSettings();
        const skip = gateSkip(settings);
        if (skip) return skip;
        if (!(await ensurePipelineSchemaChecked())) return { status: "skipped", reason: "schema" };
        if (isPipelineEmailSchemaOk() !== true && (await recheckPipelineEmailSchema()) !== true) {
          return { status: "skipped", reason: "schema" };
        }
      } catch {
        return { status: "skipped", reason: "busy" };
      }
      if (now.getTime() < transportCooldownUntil) return { status: "skipped", reason: "smtp_cooldown" };

      const today = dateToIST(now);
      let recovered: number;
      let claimed: OutboxRow[];
      try {
        // Nothing is claimed until the claim itself commits, so a failure here leaves
        // nothing behind: the tick just ends early.
        recovered = await recoverStale();
        const allowance = Math.min(EMAILS_PER_TICK, dailyCap() - (await emailsSentToday(today)));
        if (allowance <= 0) {
          warnThrottled("pipeline-email-cap", `[pipeline-email] daily cap of ${dailyCap()} emails reached — pending mail waits for the next IST day`);
          return { status: "skipped", reason: "cap" };
        }
        const holdBack = heldBackRecipients(now.getTime());
        claimed = await bg((db) => db.$queryRaw<OutboxRow[]>(claimStatement(allowance, "", holdBack)));
      } catch (err) {
        warnThrottled("pipeline-email-claim", `[pipeline-email] tick stopped before claiming (${String(err)})`);
        return { status: "skipped", reason: "busy" };
      }
      if (claimed.length === 0) {
        return { status: "ran", recovered, claimed: 0, emails: 0, failed: 0, skippedRows: 0, released: 0 };
      }

      const release = async (rows: OutboxRow[], err: string) => {
        await settleRequeue(
          rows.map((row) => ({ row, attempts: row.attempts, delayMs: RELEASE_DELAY_MS, err })),
          "release claimed rows",
        );
        return rows.length;
      };

      // (iv) Everything claimed is now 'sending': from here on, EVERY way out puts it back.
      let built: Awaited<ReturnType<typeof buildDigests>>;
      try {
        built = await buildDigests(claimed, settings, today, now.getTime());
      } catch (err) {
        warnThrottled("pipeline-email-state", `[pipeline-email] could not read the current state (${String(err)}) — the claimed rows go back to pending`);
        const released = await release(claimed, "state read failed");
        return { status: "ran", recovered, claimed: claimed.length, emails: 0, failed: 0, skippedRows: 0, released };
      }
      await settleSkipped(built.skips);

      let emails = 0;
      let failed = 0;
      let released = 0;
      let skippedRows = built.skips.length;
      const queue = built.digests;
      for (let i = 0; i < queue.length; i++) {
        const d = queue[i];
        if (Date.now() - started > TICK_BUDGET_MS) {
          released += await release(queue.slice(i).flatMap((x) => x.rows), "tick time budget");
          break;
        }
        // The kill switch applies to a running tick too (a memo hit — no statement).
        const live = await getPipelineSettings().catch(() => settings);
        const stop = gateSkip(live);
        if (stop) {
          released += await release(queue.slice(i).flatMap((x) => x.rows), "email switched off");
          break;
        }
        if (live.mode === "pilot" && !isPilotUser(live, d.user.id)) {
          await settleSkipped(d.rows.map((r) => ({ id: r.id, reason: "recipient not in the pilot" })));
          skippedRows += d.rows.length;
          continue;
        }

        // D7 (R5): the SEND day, per digest — a tick (≤ 45 s of sends plus SMTP time) can cross
        // IST midnight, and a digest worded against the tick's start would then say "due
        // tomorrow (Thu 1 Oct)" on Thursday. A due-soon item whose date has passed by now is
        // dropped (as buildDigests drops it against the tick's day) — never mailed as current.
        const sendDay = dateToIST(new Date(clock()));
        const order: Array<{ item: DigestItem; row: OutboxRow }> = [];
        const passed: Array<{ id: string; reason: string }> = [];
        d.items.forEach((item, k) => {
          if (item.kind === "due_soon" && item.due < sendDay) passed.push({ id: d.rows[k].id, reason: "due date passed" });
          else order.push({ item, row: d.rows[k] });
        });
        if (passed.length) {
          await settleSkipped(passed);
          skippedRows += passed.length;
        }
        if (order.length === 0) continue;
        order.sort(
          (a, b) =>
            KIND_ORDER[a.row.kind] - KIND_ORDER[b.row.kind] ||
            (a.item.projectTitle < b.item.projectTitle ? -1 : a.item.projectTitle > b.item.projectTitle ? 1 : 0),
        );
        const mail = renderPipelineDigest({ recipientName: displayName(d.user.name ?? ""), items: order.map((o) => o.item), today: sendDay });
        let sendError: unknown = null;
        try {
          // ⚠️ No DB slot and no transaction is held here (every statement above returned).
          await sendPipelineMail({ from: pipelineEmailFrom(), to: d.user.email!, ...mail });
        } catch (err) {
          sendError = err;
        }
        if (sendError === null) {
          emails++;
          if (sentToday?.day === today) sentToday.n++;
          lastEmailedAt.set(d.user.id, clock());
          pipelineStats.emailSent();
          await settleSent(order.map((o) => o.row.id));
          continue;
        }
        failed++;
        pipelineStats.emailFailed();
        const reason = describeMailError(sendError);
        const mailRows = order.map((o) => o.row); // exactly the rows this email carried
        if (sendError instanceof MailPermanentError) {
          // This recipient is refused for good (e.g. 550 5.1.1): no retries.
          await settleRequeue(
            mailRows.map((row) => ({ row, attempts: row.attempts + 1, delayMs: 0, err: reason, permanent: true })),
            "fail a refused recipient",
          );
          warnThrottled("pipeline-email-refused", `[pipeline-email] recipient refused by the mail server: ${reason}`);
          continue;
        }
        await settleRequeue(
          mailRows.map((row) => ({ row, attempts: row.attempts + 1, delayMs: backoffMs(row.attempts + 1), err: reason })),
          "requeue a failed send",
        );
        if (sendError instanceof MailTransportError) {
          const pause = cooldownMs(sendError.outage);
          transportCooldownUntil = clock() + pause;
          warnThrottled(
            "pipeline-email-transport",
            `[pipeline-email] SMTP unavailable (${sendError.outage}: ${reason}) — stopping this tick; no send for ${Math.round(pause / 60_000)} min`,
          );
          released += await release(queue.slice(i + 1).flatMap((x) => x.rows), "SMTP unavailable");
          break;
        }
        warnThrottled("pipeline-email-send", `[pipeline-email] send failed: ${reason}`);
      }
      return { status: "ran", recovered, claimed: claimed.length, emails, failed, skippedRows, released };
    } finally {
      running = false;
    }
  })();
}

/** index.ts: first tick 4 minutes after boot, then every 60 s. Never throws. */
export function startPipelineEmailCron(): { stop(): void } {
  let interval: ReturnType<typeof setInterval> | null = null;
  const tick = () => {
    runPipelineEmailTick()
      .then((r) => {
        if (r.status === "ran" && r.emails + r.failed + r.recovered + r.released > 0) {
          console.log(
            `[pipeline-email] emails=${r.emails} failed=${r.failed} rows=${r.claimed} skipped=${r.skippedRows} released=${r.released} recovered=${r.recovered}`,
          );
        }
      })
      .catch((err) => warnThrottled("pipeline-email-tick", `[pipeline-email] tick failed: ${String(err)}`));
  };
  const first = setTimeout(() => {
    tick();
    interval = setInterval(tick, EMAIL_TICK_MS);
    interval.unref?.();
  }, EMAIL_FIRST_TICK_MS);
  first.unref?.();
  return {
    stop() {
      clearTimeout(first);
      if (interval) clearInterval(interval);
    },
  };
}

/** Tests only: forget the daily counter, the pauses, the pacing, held book-keeping and the overlap flag. */
export function resetPipelineEmailWorkerForTests(): void {
  sentToday = null;
  transportCooldownUntil = 0;
  lastEmailedAt.clear();
  unsettled.length = 0;
  running = false;
}
