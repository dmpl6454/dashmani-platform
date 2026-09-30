/**
 * Pipeline EMAIL notifications — the ENQUEUE half (owner request 2026-09-30).
 *
 * The owner asked for an email when: the phase of a project you are part of changes
 * ("moved"); you are @mentioned ("mention"); a project's deadline is approaching
 * ("due_soon", the due cron's existing rule); a project's deadline changes, including
 * being removed ("due_changed").
 *
 * PERFORMANCE RULES (the whole reason this is an outbox):
 *   - NOTHING here sends mail. Each event writes ONE `INSERT … SELECT` into
 *     pipeline_email_outbox INSIDE the action's own transaction (the same transaction that
 *     writes its bell rows), so an email is queued exactly once with the change it
 *     describes and never on a request's critical path. cron/pipeline-email.cron.ts sends.
 *   - Recipients are EXACTLY the in-portal recipients (spec §7.3): the same
 *     recipientFragment (ACTIVE, not soft-deleted, never the actor, the pilot allowlist in
 *     pilot mode); participants with notify=true for moved / due_changed / due_soon; the
 *     mentioned user for a mention (as for the bell, even after an unfollow).
 *   - Pending rows COALESCE per (recipient, project, kind) through the partial unique index
 *     `pipeline_email_outbox_pending_key` (scripts/pipeline-email-ddl.sql):
 *     `ON CONFLICT (user_id, project_id, kind) WHERE status = 'pending' DO UPDATE`. An
 *     update keeps the row's ORIGINAL send_after, so a burst cannot postpone mail forever.
 *   - Settle delays let a quick undo, edit or delete land before anything is sent:
 *     moved 3 min, mention 2 min, due_changed 3 min, due_soon immediately.
 *   - An event by X also withdraws X's OWN pending row of the same kind for that project
 *     (moved, due_changed): X just made the change, so an email about the earlier state is
 *     noise. Same statement (a data-modifying CTE), different rows.
 *   - LOCK ORDER. Every enqueue runs after its action locked the project row, so two
 *     enqueues for one project never interleave. Within a statement, rows are written in
 *     user order — except the withdrawal DELETE, which Postgres runs after the INSERT (an
 *     unreferenced data-modifying CTE). The only other writer, the worker's requeue, takes
 *     its sibling locks with SKIP LOCKED: a pending row an enqueue holds is skipped and the
 *     requeue retried, never waited for. Its one remaining wait — returning a row to
 *     pending while an enqueue's UNCOMMITTED new row has the same key (the unique check) —
 *     is bounded by the pipeline pool's 1 s lock_timeout; the worker retries, and an action
 *     that lost a deadlock gets the usual clean 503.
 *   - Gated (pipelineEmailOn) on `pipeline.email = on`, SMTP and HR_APP_URL configured and
 *     the email schema self-check: with any of them off, NOTHING is written — email ships
 *     dark.
 *   - Writes only through the caller's `tx`; ids from gen_random_uuid(); timestamps are
 *     timezone('utc', now()) (spec §2 DB rules 1–2).
 */
import { Prisma, type PipelineTx } from "./db";
import { recipientFragment } from "./recipients";
import { isPipelineEmailSchemaOk } from "./self-check";
import { pipelineStats } from "./stats";
import type { PipelineSettings } from "./settings";

export const EMAIL_KINDS = ["moved", "mention", "due_soon", "due_changed"] as const;
export type EmailKind = (typeof EMAIL_KINDS)[number];

/** How long a new pending row waits before it may be sent (a later update keeps it). */
export const EMAIL_SETTLE_MS: Readonly<Record<EmailKind, number>> = {
  moved: 3 * 60_000,
  mention: 2 * 60_000,
  due_changed: 3 * 60_000,
  due_soon: 0,
};

/** Mention message ids kept on one pending row (the latest ones). */
export const EMAIL_MENTION_IDS_MAX = 20;
/** Distinct actors kept on one pending row (the latest ones). */
export const EMAIL_ACTOR_IDS_MAX = 5;

const NOW = Prisma.sql`timezone('utc', now())`;

export function smtpConfigured(): boolean {
  return Boolean(process.env.SMTP_USER && process.env.SMTP_PASS);
}

/**
 * Every link in a pipeline email is built from HR_APP_URL (notify.ts hrUrl), whose
 * fallback is http://localhost:3002 — right for a local bell row, a dead link in a real
 * inbox. In production an unset HR_APP_URL therefore keeps email OFF (the worker says so
 * in the log) instead of mailing localhost links to everyone.
 */
export function emailLinksConfigured(): boolean {
  return process.env.NODE_ENV !== "production" || Boolean(process.env.HR_APP_URL?.trim());
}

/**
 * Should an action enqueue email? Resolved from memos BEFORE the transaction, zero
 * statements: the feature is on, `pipeline.email = on`, SMTP and the link base are
 * configured and the self-check found the outbox and its partial index. Anything else →
 * false, so a missing DDL can never fail an action's transaction.
 */
export function pipelineEmailOn(settings: Pick<PipelineSettings, "mode" | "email">): boolean {
  return (
    settings.mode !== "off" &&
    settings.email === true &&
    smtpConfigured() &&
    emailLinksConfigured() &&
    isPipelineEmailSchemaOk() === true
  );
}

// ── The payload merge (one definition, used by the enqueue AND the worker's requeue) ──

/** Keys the merge understands. Code constants only — never input. */
const FROM_KEYS = ["fromPhaseId", "fromDue"] as const;
const ID_LIST_KEYS = [
  ["actorIds", EMAIL_ACTOR_IDS_MAX],
  ["messageIds", EMAIL_MENTION_IDS_MAX],
] as const;

/** The union of two jsonb string arrays, first occurrence wins, the latest `cap` kept, oldest first. */
function unionIds(older: Prisma.Sql, newer: Prisma.Sql, key: string, cap: number): Prisma.Sql {
  const k = Prisma.raw(`'${key}'`);
  const arr = (x: Prisma.Sql) => Prisma.sql`CASE WHEN jsonb_typeof(${x} -> ${k}) = 'array' THEN ${x} -> ${k} ELSE '[]'::jsonb END`;
  return Prisma.sql`(SELECT COALESCE(jsonb_agg(z.v ORDER BY z.pos), '[]'::jsonb)
      FROM (SELECT y.v, y.pos
              FROM (SELECT e.v, min(e.pos) AS pos
                      FROM jsonb_array_elements_text(${arr(older)} || ${arr(newer)}) WITH ORDINALITY AS e(v, pos)
                     WHERE e.v IS NOT NULL
                     GROUP BY e.v) y
             ORDER BY y.pos DESC
             LIMIT ${cap}::int) z)`;
}

/**
 * Merge an OLDER pending payload with a NEWER one for the same (recipient, project, kind):
 * the newer wins, except the older row's `from*` fields (the state before the FIRST change
 * in the window — what the email compares the current state against) and the union of the
 * id lists. `older`/`newer` are jsonb SQL expressions.
 *
 *   moved        {fromPhaseId, actorIds}  → the first fromPhaseId, all actors (≤ 5)
 *   due_changed  {fromDue, actorIds}      → the first fromDue, all actors (≤ 5)
 *   mention      {messageIds}             → every message (the latest 20)
 *   due_soon     {due}                    → the newer due date
 */
export function mergePayloadSql(older: Prisma.Sql, newer: Prisma.Sql): Prisma.Sql {
  const parts: Prisma.Sql[] = [Prisma.sql`${newer}`];
  for (const key of FROM_KEYS) {
    const k = Prisma.raw(`'${key}'`);
    parts.push(Prisma.sql`CASE WHEN ${older} -> ${k} IS NOT NULL THEN jsonb_build_object(${k}::text, ${older} -> ${k}) ELSE '{}'::jsonb END`);
  }
  for (const [key, cap] of ID_LIST_KEYS) {
    const k = Prisma.raw(`'${key}'`);
    parts.push(Prisma.sql`CASE WHEN ${older} -> ${k} IS NOT NULL OR ${newer} -> ${k} IS NOT NULL
      THEN jsonb_build_object(${k}::text, ${unionIds(older, newer, key, cap)}) ELSE '{}'::jsonb END`);
  }
  return Prisma.sql`(${Prisma.join(parts, " || ")})`;
}

/** The same merge in TypeScript (the worker pre-merges same-key rows). A parity test pins both. */
export function mergePayloadTs(older: Record<string, unknown>, newer: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...newer };
  for (const key of FROM_KEYS) if (key in older) out[key] = older[key];
  for (const [key, cap] of ID_LIST_KEYS) {
    if (!(key in older) && !(key in newer)) continue;
    const seen = new Set<string>();
    const all: string[] = [];
    for (const v of [...asIdList(older[key]), ...asIdList(newer[key])]) {
      if (seen.has(v)) continue;
      seen.add(v);
      all.push(v);
    }
    out[key] = all.slice(Math.max(0, all.length - cap));
  }
  return out;
}

function asIdList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** The existing pending row is `o` (older); the proposed row is EXCLUDED (newer). */
const ON_PENDING_CONFLICT = Prisma.sql`ON CONFLICT (user_id, project_id, kind) WHERE status = 'pending' DO UPDATE SET
    payload = ${mergePayloadSql(Prisma.sql`o.payload`, Prisma.sql`EXCLUDED.payload`)},
    updated_at = EXCLUDED.updated_at`;

const settleSql = (kind: EmailKind) => Prisma.sql`${NOW} + (${EMAIL_SETTLE_MS[kind]}::int * interval '1 millisecond')`;

const INSERT_COLUMNS = Prisma.sql`(id, user_id, project_id, kind, payload, status, attempts, send_after, created_at, updated_at)`;

// ── The events ───────────────────────────────────────────────────────────────────────

interface ParticipantEvent {
  projectId: string;
  actorId: string;
  allow: string[] | null;
}

/**
 * One row per notify=true participant (minus the actor), and the actor's own pending row
 * of this kind for the project withdrawn — one statement.
 */
async function enqueueForParticipants(
  tx: PipelineTx,
  kind: "moved" | "due_changed",
  e: ParticipantEvent,
  payload: Record<string, unknown>,
): Promise<number> {
  const n = await tx.$executeRaw`
    WITH mine AS (
      DELETE FROM pipeline_email_outbox
       WHERE user_id = ${e.actorId} AND project_id = ${e.projectId} AND kind = ${kind} AND status = 'pending')
    INSERT INTO pipeline_email_outbox AS o ${INSERT_COLUMNS}
    SELECT gen_random_uuid()::text, pp.user_id, ${e.projectId}, ${kind}, ${JSON.stringify(payload)}::jsonb,
           'pending', 0, ${settleSql(kind)}, ${NOW}, ${NOW}
      FROM pipeline_participants pp
      JOIN users u ON u.id = pp.user_id
     WHERE pp.project_id = ${e.projectId} AND pp.notify
       AND ${recipientFragment(Prisma.sql`pp.user_id`, e.actorId, e.allow)}
     ORDER BY pp.user_id
    ${ON_PENDING_CONFLICT}`;
  pipelineStats.emailQueued(n);
  return n;
}

/** A phase change (every one, net-zero included: the worker compares with the current phase). */
export function enqueueMovedEmails(tx: PipelineTx, e: ParticipantEvent & { fromPhaseId: string }): Promise<number> {
  return enqueueForParticipants(tx, "moved", e, { fromPhaseId: e.fromPhaseId, actorIds: [e.actorId] });
}

/** A due-date change; `fromDue` is the date before THIS change (`YYYY-MM-DD` or null). */
export function enqueueDueChangedEmails(tx: PipelineTx, e: ParticipantEvent & { fromDue: string | null }): Promise<number> {
  return enqueueForParticipants(tx, "due_changed", e, { fromDue: e.fromDue, actorIds: [e.actorId] });
}

/** Delivered mentions of one message (the caller already dropped the author). */
export async function enqueueMentionEmails(
  tx: PipelineTx,
  e: ParticipantEvent & { messageId: string; recipients: string[] },
): Promise<number> {
  const ids = [...new Set(e.recipients)].sort();
  if (ids.length === 0) return 0;
  const n = await tx.$executeRaw`
    INSERT INTO pipeline_email_outbox AS o ${INSERT_COLUMNS}
    SELECT gen_random_uuid()::text, r.uid, ${e.projectId}, 'mention', ${JSON.stringify({ messageIds: [e.messageId] })}::jsonb,
           'pending', 0, ${settleSql("mention")}, ${NOW}, ${NOW}
      FROM unnest(${ids}::text[]) AS r(uid)
      JOIN users u ON u.id = r.uid
     WHERE ${recipientFragment(Prisma.sql`r.uid`, e.actorId, e.allow)}
     ORDER BY r.uid
    ${ON_PENDING_CONFLICT}`;
  pipelineStats.emailQueued(n);
  return n;
}

/**
 * The due cron's claimed batch (spec §7.8): one due_soon row per notify=true participant
 * of each project, sent at once. Called in the SAME transaction as the claim and the bell
 * rows, from exactly what the claim returned.
 */
export async function enqueueDueSoonEmails(
  tx: PipelineTx,
  projects: Array<{ pid: string; due: string }>,
  allow: string[] | null,
): Promise<number> {
  if (projects.length === 0) return 0;
  const n = await tx.$executeRaw`
    INSERT INTO pipeline_email_outbox AS o ${INSERT_COLUMNS}
    SELECT gen_random_uuid()::text, pp.user_id, t.pid, 'due_soon', jsonb_build_object('due', t.due),
           'pending', 0, ${settleSql("due_soon")}, ${NOW}, ${NOW}
      FROM jsonb_to_recordset(${JSON.stringify(projects)}::jsonb) AS t(pid text, due text)
      JOIN pipeline_participants pp ON pp.project_id = t.pid AND pp.notify
      JOIN users u ON u.id = pp.user_id
     WHERE ${recipientFragment(Prisma.sql`pp.user_id`, null, allow)}
     -- (user, project) order — the order the worker's requeue walks pending siblings in —
     -- so this multi-project batch never takes outbox row locks in the opposite order.
     ORDER BY pp.user_id, t.pid
    ${ON_PENDING_CONFLICT}`;
  pipelineStats.emailQueued(n);
  return n;
}
