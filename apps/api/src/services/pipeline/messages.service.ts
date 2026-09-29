/**
 * Pipeline messages: routes #15–20 (spec §3.4, §5.1, §6).
 *
 * CURSORS (§5.1). Every change that restamps k message rows bumps the project's
 * `thread_rev` by k INSIDE its transaction, under the project row lock, and assigns
 * r−k+1 … r child first, root last:
 *   k = 2 — sending or deleting a reply (the reply, then its root)
 *   k = 1 — a top-level send, an edit, a reaction, deleting a top-level message
 * `@@unique([projectId, rev])` then gives a total, commit-ordered delta cursor.
 *
 * TRANSACTION SHAPE (§6, DB access rule 6 "lock first"). Every write takes the project
 * row FOR UPDATE in statement 1 and reads what it decides on in statement 2. Under READ
 * COMMITTED a later statement's snapshot is taken AFTER the lock, so those reads see
 * everything committed by whoever held the lock before us; subqueries inside the locking
 * statement itself would not. ⚠️ Spec §6's "Message send" row folds the key/parent/actor
 * reads into S1; they live in S2 here for that reason (rule 6 wins). The idempotency key
 * is still the first decision after the lock (review item 36), and a 23505 on the key is
 * still re-read and replayed.
 *
 * Everything that is not a statement — mention extraction, the directory (names), the
 * settings (pilot list), the new message id, snippets — is resolved BEFORE the slot.
 * Notifications go through `notifier` inside the transaction (a no-op until PR 9).
 */
import { randomUUID } from "crypto";
import {
  PIPELINE_LIMITS,
  PIPELINE_REACTION_KEYS,
  extractMentionIds,
  notificationSnippet,
  type PipelineMessage,
  type PipelineNotNotified,
  type PipelineReactions,
  type PipelineReactionKey,
  type PipelinePostMessageResponse,
  type PipelineEditMessageResponse,
  type PipelineDeleteMessageResponse,
  type PipelineReactionResponse,
  type PipelineMessagesPage,
  type PipelineRepliesPage,
} from "@dashmani/shared";
import { Prisma, type PipelineTx } from "./db";
import { pipelineRead, pipelineWrite } from "./tx";
import { PipelineError, classifyDbError, isIdempotencyKeyViolation } from "./errors";
import { notifier } from "./notifier";
import { isPilotUser, type PipelineSettings } from "./settings";
import type { PipelineDirectory } from "./access";
import { warnThrottled } from "../../utils/throttled-warn";

// ── Context ──────────────────────────────────────────────────────────────────────────

/** Who is acting, with every memo already resolved (never inside a slot). */
export interface PipelineActor {
  userId: string;
  /** The actor's display name (access memo). */
  name: string;
  settings: PipelineSettings;
  directory: PipelineDirectory;
}

/** Shown for an author or mention the directory does not (yet) know. */
export const UNKNOWN_AUTHOR_NAME = "Unknown user";

function nameOf(actor: PipelineActor, id: string): string {
  if (id === actor.userId && actor.name) return actor.name;
  return actor.directory.byId.get(id)?.name ?? UNKNOWN_AUTHOR_NAME;
}

function pilotAllow(settings: PipelineSettings): string[] | null {
  return settings.mode === "pilot" ? [...settings.pilotUserIds] : null;
}

// ── Rows and the wire shape (§3.5) ───────────────────────────────────────────────────

/** Columns of a message row, as every query here selects them (alias `m`). */
export const MESSAGE_COLUMNS = Prisma.sql`m.id, m.client_id, m.project_id, m.seq, m.rev, m.parent_id,
  m.author_id, m.body, m.mention_ids, m.reactions, m.reply_count, m.last_reply_at,
  m.edited_at, m.deleted_at, m.created_at`;

type Ts = Date | string | null;

/** A message row from a raw query, or from json_agg (timestamps are then strings). */
export interface MessageRow {
  id: string;
  client_id: string;
  project_id: string;
  seq: number;
  rev: number;
  parent_id: string | null;
  author_id: string;
  body: string;
  mention_ids: string[] | null;
  reactions: unknown;
  reply_count: number;
  last_reply_at: Ts;
  edited_at: Ts;
  deleted_at: Ts;
  created_at: Date | string;
}

/**
 * A timestamp column → ISO-8601 UTC. `timestamp(3)` columns hold UTC without a zone:
 * a Date from the driver is already right; json_agg renders them as zone-less text,
 * which must be read as UTC (appending "Z"), never as local time.
 */
export function isoUtc(v: Ts): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  const hasZone = /(Z|[+-]\d\d:?\d\d)$/i.test(v);
  return new Date(hasZone ? v : `${v}Z`).toISOString();
}

const REACTION_KEY_SET: ReadonlySet<string> = new Set(PIPELINE_REACTION_KEYS);

/** Only allowlisted keys with non-empty arrays of ids reach the wire. */
export function cleanReactions(raw: unknown): PipelineReactions {
  const out: PipelineReactions = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!REACTION_KEY_SET.has(key) || !Array.isArray(value)) continue;
    const ids = value.filter((v): v is string => typeof v === "string");
    if (ids.length) out[key as PipelineReactionKey] = ids;
  }
  return out;
}

export function toWireMessage(row: MessageRow, actor: PipelineActor): PipelineMessage {
  const mentionIds = row.mention_ids ?? [];
  const msg: PipelineMessage = {
    id: row.id,
    projectId: row.project_id,
    seq: row.seq,
    rev: row.rev,
    parentId: row.parent_id,
    authorId: row.author_id,
    authorName: nameOf(actor, row.author_id),
    body: row.body,
    mentions: mentionIds.map((id) => ({ id, name: nameOf(actor, id) })),
    reactions: cleanReactions(row.reactions),
    replyCount: row.reply_count,
    lastReplyAt: isoUtc(row.last_reply_at),
    editedAt: isoUtc(row.edited_at),
    deletedAt: isoUtc(row.deleted_at),
    createdAt: isoUtc(row.created_at)!,
  };
  // The idempotency key is the author's own business (it resolves their pending send).
  if (row.author_id === actor.userId) msg.clientId = row.client_id;
  return msg;
}

// ── Mentions (§3.5): delivered = ACTIVE, not deleted, and pickable ───────────────────

interface MentionUser {
  id: string;
  status: string;
  deleted: boolean;
}

interface MentionVerdict {
  delivered: string[];
  notNotified: PipelineNotNotified[];
}

export function classifyMentions(ids: string[], users: MentionUser[], settings: PipelineSettings): MentionVerdict {
  const byId = new Map(users.map((u) => [u.id, u]));
  const delivered: string[] = [];
  const notNotified: PipelineNotNotified[] = [];
  for (const id of ids) {
    const u = byId.get(id);
    // ONBOARDING users are not in the directory, so the composer cannot have picked them.
    if (!u || u.status === "ONBOARDING") notNotified.push({ id, reason: "unknown" });
    else if (u.status !== "ACTIVE" || u.deleted) notNotified.push({ id, reason: "inactive" });
    else if (settings.mode === "pilot" && !isPilotUser(settings, id)) notNotified.push({ id, reason: "not_in_pilot" });
    else delivered.push(id);
  }
  return { delivered, notNotified };
}

/** Subquery: the statuses of `ids` (json array), for classifyMentions. */
function mentionUsersSql(ids: string[]) {
  return Prisma.sql`(SELECT COALESCE(json_agg(json_build_object(
                             'id', u.id, 'status', u.status, 'deleted', u.deleted_at IS NOT NULL)), '[]'::json)
                       FROM users u WHERE u.id = ANY(${ids}::text[]))`;
}

const ACTOR_ACTIVE_SQL = (me: string) =>
  Prisma.sql`(SELECT u.status = 'ACTIVE' AND u.deleted_at IS NULL FROM users u WHERE u.id = ${me})`;

// ── Errors ───────────────────────────────────────────────────────────────────────────

const notFoundProject = () => new PipelineError(404, "PROJECT_NOT_FOUND", "This project doesn't exist or was deleted");
const notFoundMessage = () => new PipelineError(404, "MESSAGE_NOT_FOUND", "This message doesn't exist");
const archived = () => new PipelineError(409, "PROJECT_ARCHIVED", "This project is archived — unarchive it to make changes");
const messageDeleted = () => new PipelineError(409, "MESSAGE_DELETED", "That message was deleted");
const notAuthor = () => new PipelineError(403, "NOT_AUTHOR", "Only the author can change this message");
const inactive = () => new PipelineError(403, "ACCOUNT_INACTIVE", "Your account is inactive");
const keyReused = () =>
  new PipelineError(409, "IDEMPOTENCY_KEY_REUSED", "That message id was already used in another project");

const NOW = Prisma.sql`timezone('utc', now())`;

// ── Route #17: send ──────────────────────────────────────────────────────────────────

export interface PostMessageInput {
  clientId: string;
  body: string;
  parentId?: string;
}

export interface PostMessageResult {
  status: 200 | 201;
  data: PipelinePostMessageResponse;
}

interface LockedProject {
  id: string;
  title: string;
  archived_at: Date | null;
  deleted_at: Date | null;
}

interface SendReads {
  existing: { id: string; projectId: string } | null;
  actor_active: boolean | null;
  parent: { projectId: string; rootId: string; rootDeleted: boolean; rootAuthorId: string } | null;
  mention_users: MentionUser[];
  participant_count: number;
  existing_participants: string[];
}

/** The stored message (and its root, for a reply) by id — for a replay. */
async function readWithRoot(db: Pick<PipelineTx, "$queryRaw">, id: string) {
  const rows = await db.$queryRaw<MessageRow[]>`
    SELECT ${MESSAGE_COLUMNS} FROM pipeline_messages m
     WHERE m.id = ${id}
        OR m.id = (SELECT x.parent_id FROM pipeline_messages x WHERE x.id = ${id})`;
  const message = rows.find((r) => r.id === id) ?? null;
  const root = message?.parent_id ? rows.find((r) => r.id === message.parent_id) ?? null : null;
  return { message, root };
}

function replayResult(
  actor: PipelineActor,
  message: MessageRow,
  root: MessageRow | null,
  mentionIds: string[],
  users: MentionUser[],
): PostMessageResult {
  const stored = new Set(message.mention_ids ?? []);
  const verdict = classifyMentions(mentionIds.filter((id) => !stored.has(id)), users, actor.settings);
  return {
    status: 200,
    data: {
      message: toWireMessage(message, actor),
      ...(root ? { root: toWireMessage(root, actor) } : {}),
      replayed: true,
      notified: [...stored].filter((id) => id !== actor.userId),
      notNotified: verdict.notNotified,
    },
  };
}

export async function postMessage(actor: PipelineActor, projectId: string, input: PostMessageInput): Promise<PostMessageResult> {
  const me = actor.userId;
  // Before the slot: parse (throws MentionLimitError → 400), ids, names, snippet.
  const mentionIds = extractMentionIds(input.body);
  const messageId = randomUUID();
  const targets = [me, ...mentionIds.filter((id) => id !== me)];
  const names = new Map(mentionIds.map((id) => [id, nameOf(actor, id)]));
  const snippet = notificationSnippet(input.body, names, 100);
  const directSnippet = notificationSnippet(input.body, names, 140);
  const parentId = input.parentId ?? null;

  try {
    return await pipelineWrite(async (tx) => {
      // S1 — lock first.
      const locked = await tx.$queryRaw<LockedProject[]>`
        SELECT p.id, p.title, p.archived_at, p.deleted_at
          FROM pipeline_projects p WHERE p.id = ${projectId} FOR UPDATE`;
      const project = locked[0];

      // S2 — everything the decisions need, read after the lock.
      const [reads] = await tx.$queryRaw<SendReads[]>`
        SELECT
          (SELECT json_build_object('id', x.id, 'projectId', x.project_id)
             FROM pipeline_messages x WHERE x.author_id = ${me} AND x.client_id = ${input.clientId}) AS existing,
          ${ACTOR_ACTIVE_SQL(me)} AS actor_active,
          (SELECT json_build_object(
                    'projectId', pm.project_id,
                    'rootId', COALESCE(pm.parent_id, pm.id),
                    'rootDeleted', CASE WHEN pm.parent_id IS NULL THEN pm.deleted_at IS NOT NULL
                                        ELSE r.deleted_at IS NOT NULL END,
                    'rootAuthorId', CASE WHEN pm.parent_id IS NULL THEN pm.author_id ELSE r.author_id END)
             FROM pipeline_messages pm
             LEFT JOIN pipeline_messages r ON r.id = pm.parent_id
            WHERE pm.id = ${parentId}::text) AS parent,
          ${mentionUsersSql(mentionIds)} AS mention_users,
          (SELECT count(*)::int FROM pipeline_participants pp WHERE pp.project_id = ${projectId}) AS participant_count,
          (SELECT COALESCE(array_agg(pp.user_id), '{}'::text[]) FROM pipeline_participants pp
            WHERE pp.project_id = ${projectId} AND pp.user_id = ANY(${targets}::text[])) AS existing_participants`;

      // Decisions, in the spec's order (§6 "Message send").
      if (reads.existing) {
        if (reads.existing.projectId !== projectId) throw keyReused();
        const { message, root } = await readWithRoot(tx, reads.existing.id);
        if (message) return replayResult(actor, message, root, mentionIds, reads.mention_users);
      }
      if (!project || project.deleted_at) throw notFoundProject();
      if (project.archived_at) throw archived();
      if (reads.actor_active !== true) throw inactive();
      const parent = parentId ? reads.parent : null;
      if (parentId && (!parent || parent.projectId !== projectId)) throw notFoundMessage();
      if (parent?.rootDeleted) throw messageDeleted();
      const rootId = parent ? parent.rootId : null;
      const k = rootId ? 2 : 1;

      const { delivered, notNotified } = classifyMentions(mentionIds, reads.mention_users, actor.settings);

      // Participants (§6 "participant mutation path"; FOLLOWER rows, so member_count is
      // unchanged). The project lock serialises every participant change, so the count
      // and the existing set read in S2 are exact. New rows stop at the 200 cap.
      const existing = new Set(reads.existing_participants);
      let room = Math.max(0, PIPELINE_LIMITS.participantsMax - reads.participant_count);
      let inserted = 0;
      const skipped: string[] = [];
      let authorIncluded = existing.has(me);
      if (!authorIncluded && room > 0) {
        authorIncluded = true;
        room--;
        inserted++;
      } else if (!authorIncluded) skipped.push(me);
      const mentionTargets: string[] = [];
      for (const id of delivered) {
        if (id === me) continue;
        if (existing.has(id)) mentionTargets.push(id);
        else if (room > 0) {
          mentionTargets.push(id);
          room--;
          inserted++;
        } else skipped.push(id);
      }
      if (skipped.length) {
        warnThrottled(
          `participant-cap:${projectId}`,
          `[pipeline] project ${projectId} is at ${PIPELINE_LIMITS.participantsMax} participants — ${skipped.length} not auto-followed`,
        );
      }

      // S3 — one data-modifying statement: counters, the message, the root, participants.
      const rows = await tx.$queryRaw<Array<MessageRow & { kind: string }>>`
        WITH bump AS (
          UPDATE pipeline_projects
             SET last_message_seq = last_message_seq + 1,
                 thread_rev = thread_rev + ${k}::int,
                 header_rev = header_rev + ${inserted > 0 ? 1 : 0}::int,
                 last_message_at = ${NOW},
                 updated_at = ${NOW}
           WHERE id = ${projectId}
       RETURNING last_message_seq AS seq, thread_rev AS r
        ), msg AS (
          INSERT INTO pipeline_messages AS m
                 (id, client_id, project_id, seq, rev, parent_id, author_id, body, mention_ids, created_at, updated_at)
          SELECT ${messageId}, ${input.clientId}, ${projectId}, b.seq, b.r - ${k}::int + 1, ${rootId}::text, ${me},
                 ${input.body}, ${delivered}::text[], ${NOW}, ${NOW}
            FROM bump b
       RETURNING ${MESSAGE_COLUMNS}
        ), rootu AS (
          UPDATE pipeline_messages m
             SET reply_count = m.reply_count + 1, last_reply_at = ${NOW}, rev = b.r, updated_at = ${NOW}
            FROM bump b
           WHERE m.id = ${rootId}::text
       RETURNING ${MESSAGE_COLUMNS}
        ), pa AS (
          INSERT INTO pipeline_participants AS pp
                 (project_id, user_id, role, notify, last_read_seq, engaged_at, created_at, updated_at)
          SELECT ${projectId}, ${me}, 'FOLLOWER', true, b.seq, ${NOW}, ${NOW}, ${NOW}
            FROM bump b WHERE ${authorIncluded}::boolean
              ON CONFLICT (project_id, user_id) DO UPDATE
             SET notify = true,
                 engaged_at = COALESCE(pp.engaged_at, EXCLUDED.engaged_at),
                 last_read_seq = CASE WHEN pp.last_read_seq = EXCLUDED.last_read_seq - 1
                                      THEN EXCLUDED.last_read_seq ELSE pp.last_read_seq END,
                 updated_at = EXCLUDED.updated_at
       RETURNING pp.user_id
        ), pm AS (
          INSERT INTO pipeline_participants AS pp
                 (project_id, user_id, role, notify, last_read_seq, engaged_at, created_at, updated_at)
          SELECT ${projectId}, t.uid, 'FOLLOWER', true, b.seq - 1, ${NOW}, ${NOW}, ${NOW}
            FROM bump b CROSS JOIN unnest(${mentionTargets}::text[]) AS t(uid)
              ON CONFLICT (project_id, user_id) DO UPDATE
             SET engaged_at = COALESCE(pp.engaged_at, EXCLUDED.engaged_at),
                 updated_at = EXCLUDED.updated_at
       RETURNING pp.user_id
        )
        SELECT 'message' AS kind, msg.* FROM msg
        UNION ALL
        SELECT 'root' AS kind, rootu.* FROM rootu`;
      const message = rows.find((r) => r.kind === "message");
      if (!message) throw new PipelineError(409, "CONFLICT", "That was changed at the same time — please retry");
      const root = rows.find((r) => r.kind === "root") ?? null;

      await notifier.onMessagePosted(tx, {
        projectId,
        projectTitle: project.title,
        actorId: me,
        actorName: actor.name,
        allow: pilotAllow(actor.settings),
        messageId,
        rootId,
        seq: message.seq,
        snippet,
        directSnippet,
        deliveredMentionIds: delivered,
        replyToAuthorId: parent && parent.rootAuthorId !== me ? parent.rootAuthorId : null,
      });

      const result: PostMessageResult = {
        status: 201,
        data: {
          message: toWireMessage(message, actor),
          ...(root ? { root: toWireMessage(root, actor) } : {}),
          replayed: false,
          notified: delivered.filter((id) => id !== me),
          notNotified,
        },
      };
      return result;
    });
  } catch (err) {
    // A concurrent send with the same key committed first (§3.3): re-read by key.
    if (!isIdempotencyKeyViolation(classifyDbError(err))) throw err;
    return pipelineRead(async (db) => {
      const found = await db.$queryRaw<Array<{ id: string; project_id: string }>>`
        SELECT id, project_id FROM pipeline_messages WHERE author_id = ${me} AND client_id = ${input.clientId}`;
      if (!found[0]) throw err;
      if (found[0].project_id !== projectId) throw keyReused();
      const { message, root } = await readWithRoot(db, found[0].id);
      if (!message) throw err;
      return replayResult(actor, message, root, mentionIds, []);
    });
  }
}

// ── Routes #18–20: resolve a message → lock its (live) project ───────────────────────

interface LockedFromMessage {
  id: string;
  title: string;
  archived_at: Date | null;
}

/** S1 for every message-only write: the project derived from the stored row, locked. */
async function lockProjectOfMessage(tx: PipelineTx, mid: string): Promise<LockedFromMessage> {
  const rows = await tx.$queryRaw<LockedFromMessage[]>`
    SELECT p.id, p.title, p.archived_at
      FROM pipeline_messages m
      JOIN pipeline_projects p ON p.id = m.project_id AND p.deleted_at IS NULL
     WHERE m.id = ${mid}
       FOR UPDATE OF p`;
  if (!rows[0]) throw notFoundMessage();
  return rows[0];
}

interface MessageReads extends MessageRow {
  actor_active: boolean | null;
  root_author_id: string | null;
  participant_ids: string[];
}

/** S2: the message, the actor's status and the current participants (≤ 200). */
async function readMessage(tx: PipelineTx, mid: string, me: string, extra = Prisma.empty) {
  const rows = await tx.$queryRaw<Array<MessageReads & Record<string, unknown>>>`
    SELECT ${MESSAGE_COLUMNS},
           ${ACTOR_ACTIVE_SQL(me)} AS actor_active,
           (SELECT r.author_id FROM pipeline_messages r WHERE r.id = m.parent_id) AS root_author_id,
           (SELECT COALESCE(array_agg(pp.user_id ORDER BY pp.user_id), '{}'::text[])
              FROM pipeline_participants pp WHERE pp.project_id = m.project_id) AS participant_ids
           ${extra}
      FROM pipeline_messages m
     WHERE m.id = ${mid}`;
  if (!rows[0]) throw notFoundMessage();
  return rows[0];
}

// ── Route #18: edit (author only; §6 "Message edit") ─────────────────────────────────

export async function editMessage(actor: PipelineActor, mid: string, body: string): Promise<PipelineEditMessageResponse> {
  const me = actor.userId;
  const mentionIds = extractMentionIds(body);
  const names = new Map(mentionIds.map((id) => [id, nameOf(actor, id)]));
  const snippet = notificationSnippet(body, names, 100);
  const directSnippet = notificationSnippet(body, names, 140);

  return pipelineWrite(async (tx) => {
    const project = await lockProjectOfMessage(tx, mid);
    const row = await readMessage(tx, mid, me, Prisma.sql`, ${mentionUsersSql(mentionIds)} AS mention_users`);
    if (row.author_id !== me) throw notAuthor();
    if (row.deleted_at) throw messageDeleted();
    if (project.archived_at) throw archived();
    if (row.actor_active !== true) throw inactive();

    const { delivered, notNotified } = classifyMentions(mentionIds, row.mention_users as MentionUser[], actor.settings);
    // Unchanged → nothing to restamp (a retried edit is a no-op).
    if (row.body === body) return { message: toWireMessage(row, actor), notNotified };

    const updated = await tx.$queryRaw<MessageRow[]>`
      WITH bump AS (
        UPDATE pipeline_projects SET thread_rev = thread_rev + 1, updated_at = ${NOW}
         WHERE id = ${project.id}
     RETURNING thread_rev AS r)
      UPDATE pipeline_messages m
         SET body = ${body}, mention_ids = ${delivered}::text[], edited_at = ${NOW}, rev = b.r, updated_at = ${NOW}
        FROM bump b
       WHERE m.id = ${mid} AND m.project_id = ${project.id} AND m.author_id = ${me} AND m.deleted_at IS NULL
   RETURNING ${MESSAGE_COLUMNS}`;
    if (!updated[0]) throw new PipelineError(409, "CONFLICT", "That was changed at the same time — please retry");

    const before = new Set(row.mention_ids ?? []);
    await notifier.onMessageEdited(tx, {
      projectId: project.id,
      projectTitle: project.title,
      actorId: me,
      actorName: actor.name,
      allow: pilotAllow(actor.settings),
      messageId: mid,
      rootId: row.parent_id,
      seq: row.seq,
      snippet,
      directSnippet,
      addedMentionIds: delivered.filter((id) => !before.has(id)),
      mentionIds: delivered,
      oldMentionIds: [...before],
      replyToAuthorId: row.root_author_id && row.root_author_id !== me ? row.root_author_id : null,
      participantIds: row.participant_ids,
    });
    return { message: toWireMessage(updated[0], actor), notNotified };
  });
}

// ── Route #19: delete (author only, allowed on archived; §6 "Message delete") ────────

export async function deleteMessage(actor: PipelineActor, mid: string): Promise<PipelineDeleteMessageResponse> {
  const me = actor.userId;
  return pipelineWrite(async (tx) => {
    const project = await lockProjectOfMessage(tx, mid);
    const row = await readMessage(tx, mid, me);
    if (row.author_id !== me) throw notAuthor();
    // Idempotent: an existing tombstone is returned as is.
    if (row.deleted_at) return { message: toWireMessage(row, actor) };
    if (row.actor_active !== true) throw inactive();
    const k = row.parent_id ? 2 : 1;

    const rows = await tx.$queryRaw<Array<MessageRow & { kind: string }>>`
      WITH bump AS (
        UPDATE pipeline_projects SET thread_rev = thread_rev + ${k}::int, updated_at = ${NOW}
         WHERE id = ${project.id}
     RETURNING thread_rev AS r
      ), del AS (
        UPDATE pipeline_messages m
           SET body = '', mention_ids = '{}'::text[], reactions = '{}'::jsonb,
               deleted_at = ${NOW}, rev = b.r - ${k}::int + 1, updated_at = ${NOW}
          FROM bump b
         WHERE m.id = ${mid} AND m.project_id = ${project.id} AND m.author_id = ${me} AND m.deleted_at IS NULL
     RETURNING ${MESSAGE_COLUMNS}
      ), rootu AS (
        UPDATE pipeline_messages m
           SET reply_count = GREATEST(m.reply_count - 1, 0), rev = b.r, updated_at = ${NOW}
          FROM bump b
         WHERE m.id = ${row.parent_id}::text AND m.project_id = ${project.id}
     RETURNING ${MESSAGE_COLUMNS}
      )
      SELECT 'message' AS kind, del.* FROM del
      UNION ALL
      SELECT 'root' AS kind, rootu.* FROM rootu`;
    const message = rows.find((r) => r.kind === "message");
    if (!message) throw new PipelineError(409, "CONFLICT", "That was changed at the same time — please retry");

    await notifier.onMessageDeleted(tx, {
      projectId: project.id,
      messageId: mid,
      actorId: me,
      actorName: actor.name,
      oldMentionIds: row.mention_ids ?? [],
      participantIds: row.participant_ids,
    });
    return { message: toWireMessage(message, actor) };
  });
}

// ── Route #20: reactions (§6 "Reactions"; a no-op changes nothing) ───────────────────

export async function setReaction(
  actor: PipelineActor,
  mid: string,
  emoji: PipelineReactionKey,
  on: boolean,
): Promise<PipelineReactionResponse> {
  const me = actor.userId;
  return pipelineWrite(async (tx) => {
    const project = await lockProjectOfMessage(tx, mid);
    const rows = await tx.$queryRaw<Array<{ deleted: boolean; reactions: unknown; rev: number; actor_active: boolean | null }>>`
      SELECT m.deleted_at IS NOT NULL AS deleted, m.reactions, m.rev, ${ACTOR_ACTIVE_SQL(me)} AS actor_active
        FROM pipeline_messages m WHERE m.id = ${mid}`;
    const row = rows[0];
    if (!row) throw notFoundMessage();
    if (row.deleted) throw messageDeleted();
    if (project.archived_at) throw archived();
    if (row.actor_active !== true) throw inactive();

    const current = cleanReactions(row.reactions);
    const has = (current[emoji] ?? []).includes(me);
    if (has === on) return { messageId: mid, reactions: current, rev: row.rev };

    const updated = await tx.$queryRaw<Array<{ reactions: unknown; rev: number }>>`
      WITH bump AS (
        UPDATE pipeline_projects SET thread_rev = thread_rev + 1, updated_at = ${NOW}
         WHERE id = ${project.id}
     RETURNING thread_rev AS r)
      UPDATE pipeline_messages m
         SET reactions = CASE
               WHEN ${on}::boolean THEN
                 jsonb_set(m.reactions, ARRAY[${emoji}::text],
                           COALESCE(m.reactions -> ${emoji}::text, '[]'::jsonb) || to_jsonb(${me}::text), true)
               WHEN (m.reactions -> ${emoji}::text) - ${me}::text = '[]'::jsonb THEN m.reactions - ${emoji}::text
               ELSE jsonb_set(m.reactions, ARRAY[${emoji}::text], (m.reactions -> ${emoji}::text) - ${me}::text)
             END,
             rev = b.r, updated_at = ${NOW}
        FROM bump b
       WHERE m.id = ${mid}
   RETURNING m.reactions, m.rev`;
    return { messageId: mid, reactions: cleanReactions(updated[0].reactions), rev: updated[0].rev };
  });
}

// ── Route #15: top-level history (§3.4; keyset on seq, never OFFSET) ─────────────────

/**
 * One statement: the live project and ≤ limit+1 top-level messages below `before`,
 * newest first through (project_id, parent_id, seq). Archived projects stay readable.
 */
export async function listTopLevel(
  actor: PipelineActor,
  projectId: string,
  before: number | undefined,
  limit: number,
): Promise<PipelineMessagesPage> {
  const beforeSql = before !== undefined ? Prisma.sql`AND m.seq < ${before}::int` : Prisma.empty;
  const rows = await pipelineRead((db) =>
    db.$queryRaw<Array<Partial<MessageRow> & { pid: string }>>`
      SELECT p.id AS pid, h.*
        FROM pipeline_projects p
        LEFT JOIN LATERAL (
          SELECT ${MESSAGE_COLUMNS} FROM pipeline_messages m
           WHERE m.project_id = p.id AND m.parent_id IS NULL ${beforeSql}
           ORDER BY m.seq DESC
           LIMIT ${limit + 1}::int) h ON true
       WHERE p.id = ${projectId} AND p.deleted_at IS NULL`,
  );
  if (rows.length === 0) throw notFoundProject();
  const found = rows.filter((r) => r.id != null) as unknown as MessageRow[];
  const page = found.slice(0, limit).reverse();
  return { messages: page.map((r) => toWireMessage(r, actor)), hasOlder: found.length > limit };
}

// ── Route #16: a thread's replies (§3.4; keyset on seq) ──────────────────────────────

/**
 * One statement: the root (a reply id resolves to its root) and ≤ limit+1 replies after
 * `after`, through (project_id, parent_id, seq). A soft-deleted project is a 404.
 */
export async function listReplies(
  actor: PipelineActor,
  mid: string,
  after: number,
  limit: number,
): Promise<PipelineRepliesPage> {
  const rows = await pipelineRead((db) =>
    db.$queryRaw<Array<MessageRow & { kind: string }>>`
      WITH tgt AS (
        SELECT COALESCE(x.parent_id, x.id) AS root_id, x.project_id
          FROM pipeline_messages x
          JOIN pipeline_projects p ON p.id = x.project_id AND p.deleted_at IS NULL
         WHERE x.id = ${mid})
      SELECT 'root' AS kind, r.*
        FROM tgt CROSS JOIN LATERAL (
          SELECT ${MESSAGE_COLUMNS} FROM pipeline_messages m WHERE m.id = tgt.root_id) r
      UNION ALL
      SELECT 'reply' AS kind, c.*
        FROM tgt CROSS JOIN LATERAL (
          SELECT ${MESSAGE_COLUMNS} FROM pipeline_messages m
           WHERE m.project_id = tgt.project_id AND m.parent_id = tgt.root_id AND m.seq > ${after}::int
           ORDER BY m.seq
           LIMIT ${limit + 1}::int) c`,
  );
  const root = rows.find((r) => r.kind === "root");
  if (!root) throw notFoundMessage();
  const replies = rows.filter((r) => r.kind === "reply").sort((a, b) => a.seq - b.seq);
  return {
    root: toWireMessage(root, actor),
    replies: replies.slice(0, limit).map((r) => toWireMessage(r, actor)),
    hasMore: replies.length > limit,
  };
}
