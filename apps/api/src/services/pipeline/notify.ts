/**
 * Pipeline notifications (spec §7). The ONLY writer of `NotificationType.PIPELINE` rows —
 * `NOTIFICATION_AUDIENCE.PIPELINE = []`, so a stray dispatchNotification writes nothing.
 *
 * ⚠️ Rules (spec §7.2–§7.3, §10 "Forbidden"):
 *   - every id comes from plnId() / plnIdSql() — deterministic, UUID-shaped, so
 *     markAsRead and the existing bell routes work unchanged and every write is an
 *     idempotent primary-key upsert or probe (no scan, no new index);
 *   - every INSERT filters its recipients through recipientFragment();
 *   - no admin lookup anywhere: admins are notified only as participants;
 *   - writes go through the caller's `tx` (the action's own transaction) — never
 *     pipelineDb, never the global prisma.
 */
import { createHash } from "crypto";
import { notificationSnippet, todayIST } from "@dashmani/shared";
import {
  setNotifier,
  type PipelineNotifier,
  type ProjectCreatedArgs,
  type MembersAddedArgs,
  type MovedArgs,
  type DueChangedArgs,
  type ProjectDeletedArgs,
  type MessagePostedArgs,
  type MessageEditedArgs,
  type MessageDeletedArgs,
} from "./notifier";
import { pipelineStats } from "./stats";
import { Prisma, type PipelineTx } from "./db";
import { recipientFragment } from "./recipients";
import { enqueueDueChangedEmails, enqueueMentionEmails, enqueueMovedEmails } from "./email-outbox";

export const PLN_KINDS = ["messages", "mention", "reply", "added", "moved", "due_soon", "overdue", "due_changed"] as const;
export type PlnKind = (typeof PLN_KINDS)[number];

/** md5('pln:<kind>:' || parts joined by ':')::uuid::text — the TypeScript half. */
export function plnId(kind: PlnKind, ...parts: string[]): string {
  const h = createHash("md5").update(`pln:${kind}:${parts.join(":")}`, "utf8").digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * The SQL half of plnId(). A string part is bound as a parameter; a Prisma.Sql part is a
 * column expression that must already render as text exactly like the JS part (dates via
 * `to_char(d, 'YYYY-MM-DD')`, ints via `::text`). A parity test asserts both agree.
 */
export function plnIdSql(kind: PlnKind, ...parts: Array<string | Prisma.Sql>): Prisma.Sql {
  const pieces = parts.map((p) => (typeof p === "string" ? Prisma.sql`${p}::text` : p));
  return Prisma.sql`md5(${`pln:${kind}:`}::text || ${Prisma.join(pieces, " || ':' || ")})::uuid::text`;
}

/**
 * The one recipient predicate every notification INSERT uses (spec §7.3) — defined in
 * recipients.ts so the email outbox shares it; re-exported here for existing importers.
 */
export { recipientFragment };

// ══ The real notifier (spec §7.4–§7.7, §7.11) ═════════════════════════════════════════

const NOW = Prisma.sql`timezone('utc', now())`;
const PIPELINE_TYPE = Prisma.sql`'PIPELINE'::"NotificationType"`;

/**
 * A participant row that is DELETED (a leave, or removing someone never engaged) takes with
 * it that user's rows that only a CURRENT participant's row can ever correct:
 *   - §7.11: the grouped "N new messages" row — edit and delete redaction only reach current
 *     participants, so a row left behind would keep the preview of a message that is later
 *     edited or deleted;
 *   - the due-soon / overdue rows for the project's current due date (`dueDate`, or null when
 *     it has none) — a later due change or a move into Done withdraws them only for current
 *     participants (withdrawDueRows), so a leaver's row would keep a deadline that no longer
 *     exists for up to 90 days. (Rows of an earlier date were withdrawn when it changed — for
 *     changes made since D1 shipped; rows written before that deploy age out in ≤ 90 days.)
 * The "added" row stays — a remove and re-add within 24 h must not re-alert (§7.7), and "X
 * added you" is still true — but it loses its due date: D4 rewrites that date for current
 * participants only, so a leaver's copy would keep a deadline that may change. It is rewritten
 * by primary key, NOT re-armed, to `addedMessage(phaseName, null)` (the current phase, as D4).
 * Primary-key probes only, in the caller's transaction.
 */
export async function dropLeaverRows(
  tx: PipelineTx,
  projectId: string,
  userId: string,
  dueDate: string | null,
  phaseName: string,
): Promise<void> {
  const ids = [plnId("messages", projectId, userId)];
  if (dueDate) ids.push(plnId("due_soon", projectId, userId, dueDate), plnId("overdue", projectId, userId, dueDate));
  await tx.$executeRaw`DELETE FROM notifications WHERE id = ANY(${ids}::text[]) AND type = ${PIPELINE_TYPE}`;
  const added = addedMessage(phaseName, null);
  await tx.$executeRaw`
    UPDATE notifications SET message = ${added}
     WHERE id = ${plnId("added", projectId, userId)} AND type = ${PIPELINE_TYPE} AND message <> ${added}`;
}
const NO_NAMES: Record<string, string> = {};
const TITLE_MAX = 120;
const MESSAGE_MAX = 200;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const DAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Plain text, token-free, grapheme-safe, at most `max` (spec §7.9). */
export function clip(s: string, max: number): string {
  return notificationSnippet(s, NO_NAMES, max);
}

/** “<title ≤ 60>” — the quoted project title used in every row. */
export function quotedTitle(title: string): string {
  return `“${clip(title, 60)}”`;
}

/**
 * STORED TEXT MUST STAY TRUE AFTER IT IS WRITTEN (owner request 2026-10-01). A bell row is
 * read for up to 90 days and mobile shows it verbatim, so every date in it is ABSOLUTE ("Sat
 * 3 Oct", never "tomorrow") and carries its year whenever that is not the IST year the row
 * was written in ("Fri 1 Jan 2027"). The email may say "tomorrow" — it is read near send time
 * — but it words every date against the SEND day (email-template.ts, cron D7).
 *
 * `textToday()` is that write-time IST day. Tests pin it (a suite that writes 2026 dates must
 * not become a time bomb in 2027); production always reads the clock.
 */
let pinnedTextToday: string | null = null;
export function textToday(): string {
  return pinnedTextToday ?? todayIST();
}
/** Tests only: pin the IST day stored text is written against (null restores the clock). */
export function __setPipelineTextTodayForTests(day: string | null): void {
  pinnedTextToday = day;
}

/** " 2027" when the day key's year is not `today`'s (the year rule above), else "". */
function yearSuffix(key: string, today: string): string {
  const y = key.slice(0, 4);
  return y !== today.slice(0, 4) ? ` ${y}` : "";
}

/** `YYYY-MM-DD` → "Sat 27 Sep" — "Fri 1 Jan 2027" when its year is not `today`'s. */
export function shortDay(key: string, today: string = textToday()): string {
  const d = new Date(`${key}T00:00:00.000Z`);
  return `${DAYS_SHORT[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${yearSuffix(key, today)}`;
}

/** `YYYY-MM-DD` → "29 Sep" — "1 Jan 2027" when its year is not `today`'s. */
export function dayMonth(key: string, today: string = textToday()): string {
  const d = new Date(`${key}T00:00:00.000Z`);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${yearSuffix(key, today)}`;
}

/** metadata.url is built server-side from HR_APP_URL (spec §7.1). */
export function hrUrl(path: string): string {
  const base = (process.env.HR_APP_URL || "http://localhost:3002").replace(/\/+$/, "");
  return `${base}${path}`;
}

/** The deep link for a project, optionally at a message (and its thread root). */
export function projectPath(pid: string, mid?: string | null, rid?: string | null): string {
  const q: string[] = [];
  if (mid) q.push(`m=${mid}`);
  if (rid) q.push(`t=${rid}`);
  return `/pipeline/${pid}${q.length ? `?${q.join("&")}` : ""}`;
}

export function pipelineMeta(kind: PlnKind, pid: string, extra: Record<string, unknown>, path: string): string {
  return JSON.stringify({ v: 1, kind, pid, ...extra, app: "hr", path, url: hrUrl(path) });
}

const uniq = (ids: Iterable<string>) => [...new Set(ids)].sort();

/**
 * Direct rows (mention, reply, added) for an explicit recipient list, filtered by the
 * recipient fragment. `conflict` is the ON CONFLICT clause for the kind (§7.2).
 */
async function insertDirect(
  tx: PipelineTx,
  o: {
    kind: "mention" | "reply" | "added";
    key: string;
    recipients: string[];
    actorId: string;
    allow: string[] | null;
    title: string;
    message: string;
    meta: string;
    conflict: Prisma.Sql;
  },
): Promise<void> {
  const ids = uniq(o.recipients);
  if (ids.length === 0) return;
  const id =
    o.kind === "reply" ? plnIdSql("reply", o.key) : plnIdSql(o.kind, o.key, Prisma.sql`r.uid`);
  const n = await tx.$executeRaw`
    INSERT INTO notifications (id, user_id, type, title, message, read, metadata, created_at)
    SELECT ${id}, r.uid, ${PIPELINE_TYPE}, ${clip(o.title, TITLE_MAX)}, ${clip(o.message, MESSAGE_MAX)},
           false, ${o.meta}::jsonb, ${NOW}
      FROM unnest(${ids}::text[]) AS r(uid)
      JOIN users u ON u.id = r.uid
     WHERE ${recipientFragment(Prisma.sql`r.uid`, o.actorId, o.allow)}
     ORDER BY r.uid
    ${o.conflict}`;
  pipelineStats.notificationRows(n);
}

const DO_NOTHING = Prisma.sql`ON CONFLICT (id) DO NOTHING`;

/** §7.7: re-arm only when the existing row is more than 24 h old. */
const ADDED_CONFLICT = Prisma.sql`ON CONFLICT (id) DO UPDATE SET
  read = false, created_at = EXCLUDED.created_at, title = EXCLUDED.title,
  message = EXCLUDED.message, metadata = EXCLUDED.metadata
  WHERE notifications.created_at < timezone('utc', now()) - interval '24 hours'`;

/** The "added" row's message: "Phase: Brief · due Sat 3 Oct" (one builder for the insert and the D4 rewrite). */
export function addedMessage(phaseName: string, dueDate: string | null, today: string = textToday()): string {
  return clip(`Phase: ${phaseName}${dueDate ? ` · due ${shortDay(dueDate, today)}` : ""}`, MESSAGE_MAX);
}

async function notifyAdded(
  tx: PipelineTx,
  a: { projectId: string; projectTitle: string; actorId: string; actorName: string; allow: string[] | null; phaseName: string; dueDate: string | null; addedUserIds: string[] },
): Promise<void> {
  const path = projectPath(a.projectId);
  await insertDirect(tx, {
    kind: "added",
    key: a.projectId,
    recipients: a.addedUserIds.filter((id) => id !== a.actorId),
    actorId: a.actorId,
    allow: a.allow,
    title: `${a.actorName} added you to ${quotedTitle(a.projectTitle)}`,
    message: addedMessage(a.phaseName, a.dueDate),
    meta: pipelineMeta("added", a.projectId, {}, path),
    conflict: ADDED_CONFLICT,
  });
}

/** Mention rows (DO NOTHING) for the given users, and the reply row for the root author. */
async function notifyDirectForMessage(
  tx: PipelineTx,
  a: {
    projectId: string;
    projectTitle: string;
    actorId: string;
    actorName: string;
    allow: string[] | null;
    messageId: string;
    rootId: string | null;
    seq: number;
    directSnippet: string;
  },
  mentionIds: string[],
  replyTo: string | null,
): Promise<void> {
  const path = projectPath(a.projectId, a.messageId, a.rootId);
  const extra = { mid: a.messageId, ...(a.rootId ? { rid: a.rootId } : {}), seq: a.seq };
  const quoted = `“${a.directSnippet}”`;
  await insertDirect(tx, {
    kind: "mention",
    key: a.messageId,
    recipients: mentionIds,
    actorId: a.actorId,
    allow: a.allow,
    title: `${a.actorName} mentioned you in ${quotedTitle(a.projectTitle)}`,
    message: quoted,
    meta: pipelineMeta("mention", a.projectId, extra, path),
    conflict: DO_NOTHING,
  });
  if (replyTo) {
    await insertDirect(tx, {
      kind: "reply",
      key: a.messageId,
      recipients: [replyTo],
      actorId: a.actorId,
      allow: a.allow,
      title: `${a.actorName} replied to your message in ${quotedTitle(a.projectTitle)}`,
      message: quoted,
      meta: pipelineMeta("reply", a.projectId, extra, path),
      conflict: DO_NOTHING,
    });
  }
}

/** The direct-row recipients of a message: mentions win over the reply (§7.5). */
function directRecipients(actorId: string, mentionIds: string[], replyToAuthorId: string | null) {
  const mentions = uniq(mentionIds.filter((id) => id !== actorId));
  const replyTo = replyToAuthorId && replyToAuthorId !== actorId && !mentions.includes(replyToAuthorId) ? replyToAuthorId : null;
  return { mentions, replyTo };
}

/**
 * §7.4: a participant whose seen_at is younger than this is watching the thread live and
 * gets no grouped bump. sync.service.ts SEEN_REFRESH_MS must keep active readers inside it.
 */
export const ACTIVE_READER_WINDOW_MS = 45_000;

async function onMessagePosted(tx: PipelineTx, a: MessagePostedArgs): Promise<void> {
  const { mentions, replyTo } = directRecipients(a.actorId, a.deliveredMentionIds, a.replyToAuthorId);
  await notifyDirectForMessage(tx, a, mentions, replyTo);
  // Email for the same mention recipients (a reply alone does not email).
  if (a.email && mentions.length) {
    await enqueueMentionEmails(tx, { projectId: a.projectId, actorId: a.actorId, allow: a.allow, messageId: a.messageId, recipients: mentions });
  }

  // §7.4 grouped row, in place and race-safe.
  const direct = replyTo ? [...mentions, replyTo] : mentions;
  const prefix = `${quotedTitle(a.projectTitle)}: `;
  const preview = clip(`${a.actorName}: ${a.snippet}`, MESSAGE_MAX);
  const path = projectPath(a.projectId);
  const meta = pipelineMeta("messages", a.projectId, { n: 1, seq: a.seq, lastMid: a.messageId }, path);
  const written = await tx.$executeRaw`
    INSERT INTO notifications AS n (id, user_id, type, title, message, read, metadata, created_at)
    SELECT ${plnIdSql("messages", a.projectId, Prisma.sql`r.user_id`)}, r.user_id, ${PIPELINE_TYPE},
           ${prefix} || '1 new message', ${preview}, false, ${meta}::jsonb, ${NOW}
      FROM (SELECT pp.user_id FROM pipeline_participants pp
              JOIN users u ON u.id = pp.user_id
             WHERE pp.project_id = ${a.projectId} AND pp.notify
               AND ${recipientFragment(Prisma.sql`pp.user_id`, a.actorId, a.allow)}
               AND NOT (pp.user_id = ANY(${direct}::text[]))
               AND (pp.seen_at IS NULL OR pp.seen_at < ${NOW} - (${ACTIVE_READER_WINDOW_MS / 1000}::int * interval '1 second'))
             ORDER BY pp.user_id) r
    ON CONFLICT (id) DO UPDATE SET
      read = false, created_at = EXCLUDED.created_at, message = EXCLUDED.message,
      metadata = EXCLUDED.metadata || jsonb_build_object('n',
        CASE WHEN n.read THEN 1 ELSE COALESCE((n.metadata->>'n')::int, 0) + 1 END),
      title = ${prefix} || (CASE WHEN n.read THEN '1 new message'
                                 ELSE (COALESCE((n.metadata->>'n')::int, 0) + 1)::text || ' new messages' END)`;
  pipelineStats.notificationRows(written);
}

async function onMessageEdited(tx: PipelineTx, a: MessageEditedArgs): Promise<void> {
  // Rows for NEWLY added mentions only; the reply row already exists (or never will).
  const { mentions } = directRecipients(a.actorId, a.addedMentionIds, null);
  await notifyDirectForMessage(tx, a, mentions, null);
  if (a.email && mentions.length) {
    await enqueueMentionEmails(tx, { projectId: a.projectId, actorId: a.actorId, allow: a.allow, messageId: a.messageId, recipients: mentions });
  }

  // §7.11: an edit that drops a mention DELETES that user's mention row — the message no
  // longer mentions them, and a rewritten row would outlive a later leave + delete (the
  // delete only reaches current mentions and current participants).
  const dropped = uniq(a.oldMentionIds.filter((uid) => !a.mentionIds.includes(uid)));
  if (dropped.length) {
    const droppedIds = dropped.map((uid) => plnId("mention", a.messageId, uid));
    await tx.$executeRaw`DELETE FROM notifications WHERE id = ANY(${droppedIds}::text[]) AND type = ${PIPELINE_TYPE}`;
  }
  // Then rewrite the text wherever this message is still quoted — the kept mention rows,
  // the reply row, and grouped rows whose preview came from it. All by primary key.
  const quoted = clip(`“${a.directSnippet}”`, MESSAGE_MAX);
  const mentionRowIds = uniq(a.mentionIds).map((uid) => plnId("mention", a.messageId, uid));
  const directIds = [...mentionRowIds, plnId("reply", a.messageId)];
  await tx.$executeRaw`
    UPDATE notifications SET message = ${quoted}
     WHERE id = ANY(${directIds}::text[]) AND type = ${PIPELINE_TYPE}`;
  const groupedIds = uniq(a.participantIds).map((uid) => plnId("messages", a.projectId, uid));
  if (groupedIds.length) {
    await tx.$executeRaw`
      UPDATE notifications SET message = ${clip(`${a.actorName}: ${a.snippet}`, MESSAGE_MAX)}
       WHERE id = ANY(${groupedIds}::text[]) AND metadata->>'lastMid' = ${a.messageId}`;
  }
}

async function onMessageDeleted(tx: PipelineTx, a: MessageDeletedArgs): Promise<void> {
  // Mention rows of every user this message could have mentioned (the stored mentions,
  // plus current participants: an earlier edit may have dropped a mention), and the reply row.
  const ids = [
    ...uniq([...a.oldMentionIds, ...a.participantIds]).map((uid) => plnId("mention", a.messageId, uid)),
    plnId("reply", a.messageId),
  ];
  await tx.$executeRaw`DELETE FROM notifications WHERE id = ANY(${ids}::text[]) AND type = ${PIPELINE_TYPE}`;
  const groupedIds = uniq(a.participantIds).map((uid) => plnId("messages", a.projectId, uid));
  if (groupedIds.length) {
    await tx.$executeRaw`
      UPDATE notifications SET message = ${clip(`${a.actorName} deleted a message`, MESSAGE_MAX)}
       WHERE id = ANY(${groupedIds}::text[]) AND metadata->>'lastMid' = ${a.messageId}`;
  }
}

async function onProjectDeleted(tx: PipelineTx, a: ProjectDeletedArgs): Promise<void> {
  const ids = uniq(a.participantIds).map((uid) => plnId("messages", a.projectId, uid));
  if (ids.length) await tx.$executeRaw`DELETE FROM notifications WHERE id = ANY(${ids}::text[])`;
}

const dueRowIds = (projectId: string, due: string) => [
  plnIdSql("due_soon", projectId, Prisma.sql`pp.user_id`, due),
  plnIdSql("overdue", projectId, Prisma.sql`pp.user_id`, due),
];

/**
 * Withdraw the due-soon and overdue rows keyed on `due` for EVERY current participant (notify
 * on or off — a muted follower's stale row is just as false). Used when that date stops being
 * true: the due date changed (D1, B1 — the bell kept "due tomorrow (Tue 6 Oct)" for a deadline
 * that no longer existed) and the project reached a terminal phase (D2 — "is overdue" after
 * Done). Unread or read, they go: the deadline they describe is gone. Primary-key probes
 * only (≤ 2 × 200), in the caller's transaction; the caller also clears the
 * project's *_notified_for markers, so a row withdrawn here can be re-armed by the due cron
 * if the date comes back (A → B → A, or Done → back out).
 */
export async function withdrawDueRows(tx: PipelineTx, projectId: string, due: string): Promise<void> {
  // ⚠️ With the rewrite and upsert that follow it, a due change (or a move into Done) now
  // writes SEVERAL of a participant's rows. A viewer's ack marks the same rows read in one
  // statement whose plan (a bitmap heap scan) takes them in heap order, so in a rare overlap
  // one side waits out the pool's 1 s lock_timeout (55P03). The edit and the move therefore
  // run with retryOnce (projects.service.ts) — the user's action always lands; a lost ack is
  // idempotent and re-sent with the next poll. The main pool's "Mark all read" (one statement
  // over ALL of a user's unread rows) can close the same kind of cycle; Postgres's deadlock
  // check then kills one side, and markAllAsRead retries a lost deadlock once
  // (notification.service.ts) — so the bell click lands too. (Locking these rows in id order
  // first does not help: no concurrent locker takes them in id order.)
  const [soon, overdue] = dueRowIds(projectId, due);
  await tx.$executeRaw`
    DELETE FROM notifications
     WHERE type = ${PIPELINE_TYPE}
       AND id IN (SELECT ${soon} FROM pipeline_participants pp WHERE pp.project_id = ${projectId}
                  UNION ALL
                  SELECT ${overdue} FROM pipeline_participants pp WHERE pp.project_id = ${projectId})`;
}

async function onMoved(tx: PipelineTx, a: MovedArgs): Promise<void> {
  // D2: Done (terminal) gets no due alerts, so the ones already sent stop being true.
  // Before the net-zero return: a generation that ends back IN Done withdraws them too.
  if (a.toTerminal && a.dueDate) await withdrawDueRows(tx, a.projectId, a.dueDate);
  // Email first: every phase change is queued (a net-zero one too — the worker compares the
  // FIRST pending from-phase with the phase at send time and skips a round trip).
  if (a.email) {
    await enqueueMovedEmails(tx, { projectId: a.projectId, actorId: a.actorId, allow: a.allow, fromPhaseId: a.prevPhaseId });
  }
  const gen = String(a.gen);
  const idOf = plnIdSql("moved", a.projectId, Prisma.sql`pp.user_id`, gen);
  if (a.netZero) {
    // Back where the generation started: withdraw its unread rows (read ones stay).
    await tx.$executeRaw`
      DELETE FROM notifications
       WHERE read = false
         AND id IN (SELECT ${idOf} FROM pipeline_participants pp WHERE pp.project_id = ${a.projectId})`;
    return;
  }
  const path = projectPath(a.projectId);
  const title = clip(`${a.actorName} moved ${quotedTitle(a.projectTitle)} to ${a.toPhaseName}`, TITLE_MAX);
  const message = clip(`From ${a.fromPhaseName} → ${a.toPhaseName}`, MESSAGE_MAX);
  const meta = pipelineMeta("moved", a.projectId, { gen: a.gen, from: a.fromPhaseId, to: a.toPhaseId }, path);
  const moved = await tx.$executeRaw`
    INSERT INTO notifications (id, user_id, type, title, message, read, metadata, created_at)
    SELECT ${idOf}, pp.user_id, ${PIPELINE_TYPE}, ${title}, ${message}, false, ${meta}::jsonb, ${NOW}
      FROM pipeline_participants pp
      JOIN users u ON u.id = pp.user_id
     WHERE pp.project_id = ${a.projectId} AND pp.notify
       AND ${recipientFragment(Prisma.sql`pp.user_id`, a.actorId, a.allow)}
     ORDER BY pp.user_id
    ON CONFLICT (id) DO UPDATE SET
      read = false, created_at = EXCLUDED.created_at, title = EXCLUDED.title,
      message = EXCLUDED.message, metadata = EXCLUDED.metadata`;
  pipelineStats.notificationRows(moved);
}

/** `YYYY-MM-DD` → "Sat 3 Oct" (the year rule against `today`), or null. */
const dayOrNull = (key: string | null, today: string) => (key ? shortDay(key, today) : null);

/**
 * "Priya changed the due date of “X” to Sat 3 Oct (was Mon 28 Sep)", "Priya removed the due
 * date of “X” (was Mon 28 Sep)", "Priya set the due date of “X” to Sat 3 Oct". The project
 * title is cut further when needed so the dates — the point of the row — always survive
 * the 120-character title limit.
 */
export function dueChangedTitle(
  actorName: string,
  projectTitle: string,
  fromDue: string | null,
  toDue: string | null,
  today: string = textToday(),
): string {
  const from = dayOrNull(fromDue, today);
  const to = dayOrNull(toDue, today);
  const build = (who: string, qt: string) =>
    to === null
      ? `${who} removed the due date of ${qt}${from ? ` (was ${from})` : ""}`
      : from === null
        ? `${who} set the due date of ${qt} to ${to}`
        : `${who} changed the due date of ${qt} to ${to} (was ${from})`;
  const len = (s: string) => Array.from(s).length;
  let who = actorName;
  let title = clip(projectTitle, 60);
  let over = len(build(who, `“${title}”`)) - TITLE_MAX;
  // Shrink the project title first (down to 12), then the name (down to 12).
  if (over > 0) {
    title = clip(projectTitle, Math.max(12, len(title) - over));
    over = len(build(who, `“${title}”`)) - TITLE_MAX;
  }
  if (over > 0) who = clip(actorName, Math.max(12, len(who) - over));
  return clip(build(who, `“${title}”`), TITLE_MAX);
}

/**
 * The bell row for a due-date change: `due_changed:<pid>:<uid>`, one per participant with
 * notify (minus the actor), upserted and RE-ARMED IN PLACE like the grouped row — it
 * always describes the latest change. Cleared by the project-level ack (sync.service.ts).
 */
async function onDueChanged(tx: PipelineTx, a: DueChangedArgs): Promise<void> {
  const today = textToday();
  // D1 (B1): the due-soon / overdue rows of the date that no longer exists go. (editProject
  // cleared the *_notified_for markers in the same transaction.)
  if (a.fromDue !== null) await withdrawDueRows(tx, a.projectId, a.fromDue);
  // D4 (R11): an "added" row quotes the due date it was written with ("Phase: Brief · due Sat
  // 3 Oct"). Rewrite it in place — by primary key, current participants, NOT re-armed (a read
  // row stays read) — so it never shows a date that no longer exists. It takes the CURRENT
  // phase too: the phase someone was added in is not stored, and the current one is true.
  // (Simplest correct option: keeping the due date in "added" is useful context, and this one
  // UPDATE keeps it true; dropping it would still need this rewrite for rows already written.)
  const added = addedMessage(a.phaseName, a.toDue, today);
  await tx.$executeRaw`
    UPDATE notifications SET message = ${added}
     WHERE type = ${PIPELINE_TYPE}
       AND id IN (SELECT ${plnIdSql("added", a.projectId, Prisma.sql`pp.user_id`)}
                    FROM pipeline_participants pp WHERE pp.project_id = ${a.projectId})
       AND message <> ${added}`;
  const path = projectPath(a.projectId);
  const title = dueChangedTitle(a.actorName, a.projectTitle, a.fromDue, a.toDue, today);
  const message = clip(`Phase: ${a.phaseName}`, MESSAGE_MAX);
  const meta = pipelineMeta("due_changed", a.projectId, { from: a.fromDue, to: a.toDue }, path);
  const written = await tx.$executeRaw`
    INSERT INTO notifications (id, user_id, type, title, message, read, metadata, created_at)
    SELECT ${plnIdSql("due_changed", a.projectId, Prisma.sql`pp.user_id`)}, pp.user_id, ${PIPELINE_TYPE},
           ${title}, ${message}, false, ${meta}::jsonb, ${NOW}
      FROM pipeline_participants pp
      JOIN users u ON u.id = pp.user_id
     WHERE pp.project_id = ${a.projectId} AND pp.notify
       AND ${recipientFragment(Prisma.sql`pp.user_id`, a.actorId, a.allow)}
     ORDER BY pp.user_id
    ON CONFLICT (id) DO UPDATE SET
      read = false, created_at = EXCLUDED.created_at, title = EXCLUDED.title,
      message = EXCLUDED.message, metadata = EXCLUDED.metadata`;
  pipelineStats.notificationRows(written);
  if (a.email) {
    await enqueueDueChangedEmails(tx, { projectId: a.projectId, actorId: a.actorId, allow: a.allow, fromDue: a.fromDue });
  }
}

export const realNotifier: PipelineNotifier = {
  onProjectCreated: (tx, a: ProjectCreatedArgs) => notifyAdded(tx, a),
  onMembersAdded: (tx, a: MembersAddedArgs) => notifyAdded(tx, a),
  onMoved,
  onDueChanged,
  onProjectDeleted,
  onMessagePosted,
  onMessageEdited,
  onMessageDeleted,
};

/** Called once from services/pipeline/index.ts. */
export function installPipelineNotifier(): void {
  setNotifier(realNotifier);
}
