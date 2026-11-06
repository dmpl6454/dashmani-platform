/**
 * Sales-portal chat: Slack-style channels and direct messages.
 *
 * A channel or DM is a `pipeline_projects` row with `kind` 'channel' or 'dm', so its thread,
 * replies, reactions, mentions, unread counts and sync are the project machinery unchanged
 * (messages.service.ts, sync.service.ts). What lives here is only what a project does not
 * have: creating them, membership by the Slack rules, public ↔ private, and the sidebar list.
 *
 * Rules (owner, 2026-11-03):
 *   - anyone active can create a channel and becomes its owner;
 *   - public channel: everyone can see it, browse it and join it;
 *   - private channel: members only (detail, history and sync answer 404 / "deleted");
 *   - any member can add people; only the owner or an admin removes someone else, renames,
 *     edits the description, switches public ↔ private or deletes the channel; anyone can leave;
 *   - DM: exactly two people (or one, the self-DM), found again by `dm_key`, never left —
 *     "deleting" one hides it from MY sidebar only (`hidden_seq`), until a newer message or
 *     until I open it again;
 *   - a channel may belong to a campaign (`parent_project_id`): it is listed in that campaign's
 *     sidebar (not the main one), its name is unique within the campaign, and a PUBLIC campaign
 *     channel starts with every member of the campaign in it.
 *
 * Every write takes the conversation row FOR UPDATE first (the project lock), like every
 * other Pipeline write, so participant changes stay serialised with message sends.
 * Channels and DMs never bump the board: they are not on it.
 */
import { randomUUID } from "crypto";
import {
  PIPELINE_LIMITS,
  type PipelineBrowseChannelsResponse,
  type PipelineCampaignChannelsResponse,
  type PipelineConversationResponse,
  type PipelineConversations,
} from "@dashmani/shared";
import { Prisma, type PipelineTx } from "./db";
import { pipelineRead, pipelineWrite } from "./tx";
import { PipelineError, PipelineDbError, isIdempotencyKeyViolation } from "./errors";
import { headerFromRow, participantFromRow, ts } from "./wire";
import { pickableByMode, type PipelineActor } from "./projects.service";
import { parentLiveSql } from "./access";
import { isPipelineAdmin } from "../../middleware/pipeline-gates";

type Row = Record<string, unknown>;

const NOW = Prisma.sql`timezone('utc', now())`;
/** Channels and DMs need a rank (NOT NULL); nothing orders them by it. */
const CHAT_RANK = "a0";
/** Serialises channel-name checks (create / rename) so two "#social"s can't both commit. */
const NAME_LOCK_KEY = 0x7069_6368; // "pich"

const notFound = () => new PipelineError(404, "CONVERSATION_NOT_FOUND", "This conversation doesn't exist");
const nameTaken = (name: string) => new PipelineError(409, "CHANNEL_NAME_TAKEN", `#${name} already exists — pick another name`);
const inactive = () => new PipelineError(403, "ACCOUNT_INACTIVE", "Your account is inactive");
const notAllowed = (what: string) => new PipelineError(403, "NOT_ALLOWED", `Only the channel owner or an admin can ${what}`);
const notPickable = () => new PipelineError(409, "MEMBER_NOT_PICKABLE", "Someone you picked can't be added right now");

/** `a:b` with the ids sorted; the self-DM is `me:me`. */
export function dmKeyOf(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

// ── Shared pieces ────────────────────────────────────────────────────────────────────

interface LockedChat {
  row: Row;
  isMember: boolean;
}

/**
 * S1: lock a channel or DM (never a project) and read whether I'm in it and active.
 * `admins: true` lets an admin manage a private channel they are not in (rename, privacy,
 * remove someone) — like a Slack workspace admin; it never lets anyone read the messages.
 */
async function lockChat(tx: PipelineTx, id: string, me: string, opts: { admins?: boolean } = {}): Promise<LockedChat> {
  const rows = await tx.$queryRaw<Row[]>`
    SELECT p.*,
           EXISTS (SELECT 1 FROM pipeline_participants pp WHERE pp.project_id = p.id AND pp.user_id = ${me}) AS is_member,
           (SELECT (u.status = 'ACTIVE' AND u.deleted_at IS NULL) FROM users u WHERE u.id = ${me}) AS actor_active
      FROM pipeline_projects p
     WHERE p.id = ${id} AND p.kind <> 'project' AND p.deleted_at IS NULL AND ${parentLiveSql("p")}
       FOR UPDATE OF p`;
  const row = rows[0];
  const isMember = row?.is_member === true;
  // A private channel or DM I'm not in does not exist, as far as I can tell.
  if (!row) throw notFound();
  if ((row.kind === "dm" || row.is_private === true) && !isMember) {
    if (!(opts.admins && row.kind === "channel" && (await isPipelineAdmin(tx, me)))) throw notFound();
  }
  if (row.actor_active !== true) throw inactive();
  return { row, isMember };
}

/** Slack rule: the owner can't walk away from a channel (nobody could then manage it). */
const ownerCantLeave = () =>
  new PipelineError(409, "OWNER_CANT_LEAVE", "The channel owner can't leave — delete the channel instead");

/** Recount MEMBER rows and bump header_rev, so open tabs pick up the new member list. */
async function recount(tx: PipelineTx, id: string): Promise<void> {
  await tx.$executeRaw`
    UPDATE pipeline_projects p
       SET member_count = (SELECT count(*)::int FROM pipeline_participants WHERE project_id = ${id} AND role = 'MEMBER'),
           header_rev = p.header_rev + 1,
           updated_at = ${NOW}
     WHERE p.id = ${id}`;
}

/** The conversation as the client renders it: header + participants (≤ 200). */
async function readConversation(db: Pick<PipelineTx, "$queryRaw">, id: string): Promise<PipelineConversationResponse> {
  const [r] = await db.$queryRaw<Array<{ project: Row; participants: Row[] }>>`
    SELECT (SELECT row_to_json(x) FROM (
              SELECT p.*, (SELECT t.title FROM pipeline_projects t WHERE t.id = p.parent_project_id) AS parent_title
                FROM pipeline_projects p WHERE p.id = ${id}) x) AS project,
           (SELECT COALESCE(json_agg(x ORDER BY x.created_at, x.user_id), '[]'::json) FROM (
              SELECT user_id, role, member_added_by_id, member_added_at, created_at
                FROM pipeline_participants WHERE project_id = ${id}
               ORDER BY created_at, user_id LIMIT ${PIPELINE_LIMITS.participantsMax}) x) AS participants`;
  if (!r?.project) throw notFound();
  const header = headerFromRow(r.project);
  return { id, header, participants: r.participants.map((p) => participantFromRow(p, header.ownerId)) };
}

/**
 * Throws 409 when another live channel in the same place already has `name` (call under
 * NAME_LOCK_KEY). Team-wide channels share one namespace; each campaign has its own.
 */
async function assertNameFree(tx: PipelineTx, name: string, exceptId: string | null, parentId: string | null): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM pipeline_projects
     WHERE kind = 'channel' AND deleted_at IS NULL AND lower(title) = lower(${name})
       AND parent_project_id IS NOT DISTINCT FROM ${parentId}::text
       AND (${exceptId}::text IS NULL OR id <> ${exceptId}::text)
     LIMIT 1`;
  if (rows[0]) throw nameTaken(name);
}

/** Every id is an ACTIVE user and pickable under the current mode, or 409. */
async function assertPickable(tx: PipelineTx, actor: PipelineActor, ids: string[]): Promise<void> {
  if (ids.some((id) => !pickableByMode(actor.settings, id))) throw notPickable();
  if (ids.length === 0) return;
  const [r] = await tx.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM users WHERE id = ANY(${ids}::text[]) AND status = 'ACTIVE' AND deleted_at IS NULL`;
  if (r.n !== ids.length) throw notPickable();
}

/** The first live phase: channels and DMs need one (phase_id is NOT NULL), boards filter them out. */
async function anyPhaseId(tx: PipelineTx): Promise<string> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM pipeline_phases ORDER BY archived_at IS NOT NULL, position, id LIMIT 1`;
  if (!rows[0]) throw new PipelineError(503, "PIPELINE_BUSY", "The pipeline isn't set up yet");
  return rows[0].id;
}

/**
 * Insert MEMBER rows for `ids` (existing rows are left alone). A new member starts "read up
 * to now", like joining a Slack channel: the history is there, but it isn't unread.
 */
async function insertMembers(tx: PipelineTx, id: string, ids: string[], addedBy: string | null): Promise<string[]> {
  if (ids.length === 0) return [];
  const sorted = [...new Set(ids)].sort();
  const rows = await tx.$queryRaw<Array<{ user_id: string }>>`
    INSERT INTO pipeline_participants
           (project_id, user_id, role, notify, last_read_seq, member_added_by_id, member_added_at, created_at, updated_at)
    SELECT ${id}, v.uid, 'MEMBER', true, p.last_message_seq,
           ${addedBy}::text, CASE WHEN ${addedBy}::text IS NULL THEN NULL ELSE ${NOW} END,
           ${NOW} + ((v.ord - 1) * interval '1 millisecond'), ${NOW}
      FROM unnest(${sorted}::text[]) WITH ORDINALITY AS v(uid, ord)
      JOIN pipeline_projects p ON p.id = ${id}
    ON CONFLICT (project_id, user_id) DO NOTHING
    RETURNING user_id`;
  return rows.map((r) => r.user_id);
}

// ── Sidebar and browse ───────────────────────────────────────────────────────────────

/** GET /pipeline/conversations: channels I'm in (by name) and my DMs (newest first). */
export async function listConversations(actor: PipelineActor): Promise<PipelineConversations> {
  const me = actor.userId;
  const rows = await pipelineRead((db) =>
    db.$queryRaw<Row[]>`
      SELECT p.id, p.kind, p.title, p.is_private, p.dm_key, p.last_message_at, p.parent_project_id, p.owner_id,
             (pp.hidden_seq IS NOT NULL AND p.last_message_seq <= pp.hidden_seq) AS hidden,
             GREATEST(p.last_message_seq - pp.last_read_seq, 0)::int AS unread
        FROM pipeline_participants pp
        JOIN pipeline_projects p ON p.id = pp.project_id
       WHERE pp.user_id = ${me} AND p.kind <> 'project' AND p.deleted_at IS NULL
       ORDER BY p.last_message_at DESC NULLS LAST, p.id
       LIMIT 500`,
  );
  const channels: PipelineConversations["channels"] = [];
  const dms: PipelineConversations["dms"] = [];
  const campaignChannelIds: string[] = [];
  const hiddenDmIds: string[] = [];
  for (const r of rows) {
    const unread = Number(r.unread);
    const lastMessageAt = ts(r.last_message_at);
    if (r.kind === "dm" && r.hidden === true) {
      hiddenDmIds.push(String(r.id));
    } else if (r.kind === "channel" && r.parent_project_id) {
      campaignChannelIds.push(String(r.id));
    } else if (r.kind === "channel") {
      channels.push({ id: String(r.id), name: String(r.title), isPrivate: r.is_private === true, ownerId: String(r.owner_id), unread, lastMessageAt });
    } else {
      const [a, b] = String(r.dm_key ?? "").split(":");
      const other = a === me ? b : a;
      dms.push({ id: String(r.id), userId: other ?? me, isSelf: other === me, unread, lastMessageAt });
    }
  }
  channels.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  // Self-DM first (like Slack's "you" row), then the most recent conversation.
  // ISO timestamps compare correctly as plain strings (the CI guard bans locale comparison here).
  const newest = (a: string | null, b: string | null) => ((b ?? "") > (a ?? "") ? 1 : (b ?? "") < (a ?? "") ? -1 : 0);
  dms.sort((x, y) => Number(y.isSelf) - Number(x.isSelf) || newest(x.lastMessageAt, y.lastMessageAt));
  return { channels, dms, campaignChannelIds, hiddenDmIds };
}

/** GET /pipeline/channels/browse: every public channel plus the private ones I'm in. */
export async function browseChannels(actor: PipelineActor, q: string | undefined): Promise<PipelineBrowseChannelsResponse> {
  const me = actor.userId;
  const needle = (q ?? "").trim().toLowerCase();
  const like = `%${needle.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = await pipelineRead((db) =>
    db.$queryRaw<Row[]>`
      SELECT p.id, p.title, p.description, p.is_private, p.member_count, p.owner_id,
             EXISTS (SELECT 1 FROM pipeline_participants pp WHERE pp.project_id = p.id AND pp.user_id = ${me}) AS joined
        FROM pipeline_projects p
       WHERE p.kind = 'channel' AND p.deleted_at IS NULL AND p.parent_project_id IS NULL
         AND (NOT p.is_private OR EXISTS (SELECT 1 FROM pipeline_participants pp WHERE pp.project_id = p.id AND pp.user_id = ${me}))
         AND (${needle} = '' OR lower(p.title) LIKE ${like})
       ORDER BY lower(p.title), p.id
       LIMIT 200`,
  );
  return {
    channels: rows.map((r) => ({
      id: String(r.id),
      name: String(r.title),
      description: String(r.description ?? ""),
      isPrivate: r.is_private === true,
      memberCount: Number(r.member_count),
      joined: r.joined === true,
      ownerId: String(r.owner_id),
    })),
  };
}

/**
 * GET /pipeline/projects/:id/channels — a campaign's sidebar: its public channels and the
 * private ones I'm in, by name. Unread counts only where I'm a member.
 */
export async function listCampaignChannels(actor: PipelineActor, projectId: string): Promise<PipelineCampaignChannelsResponse> {
  const me = actor.userId;
  const rows = await pipelineRead((db) =>
    db.$queryRaw<Row[]>`
      SELECT (SELECT count(*)::int FROM pipeline_projects pr
               WHERE pr.id = ${projectId} AND pr.kind = 'project' AND pr.deleted_at IS NULL) AS live,
             (SELECT COALESCE(json_agg(x ORDER BY lower(x.title), x.id), '[]'::json) FROM (
                SELECT p.id, p.title, p.is_private, p.member_count, p.owner_id, pp.user_id IS NOT NULL AS joined,
                       CASE WHEN pp.user_id IS NULL THEN 0
                            ELSE GREATEST(p.last_message_seq - pp.last_read_seq, 0) END AS unread
                  FROM pipeline_projects p
                  LEFT JOIN pipeline_participants pp ON pp.project_id = p.id AND pp.user_id = ${me}
                 WHERE p.parent_project_id = ${projectId} AND p.kind = 'channel' AND p.deleted_at IS NULL
                   AND (NOT p.is_private OR pp.user_id IS NOT NULL)
                 LIMIT 200) x) AS channels`,
  );
  if (!rows[0] || Number(rows[0].live) === 0) {
    throw new PipelineError(404, "PROJECT_NOT_FOUND", "This project doesn't exist");
  }
  return {
    channels: (rows[0].channels as Row[]).map((r) => ({
      id: String(r.id),
      name: String(r.title),
      isPrivate: r.is_private === true,
      ownerId: String(r.owner_id),
      joined: r.joined === true,
      unread: Number(r.unread),
      memberCount: Number(r.member_count),
    })),
  };
}

// ── Create a channel ─────────────────────────────────────────────────────────────────

export interface CreateChannelInput {
  clientId: string;
  /** The campaign (project) the channel belongs to, or undefined for a team-wide channel. */
  projectId?: string;
  name: string;
  description?: string;
  isPrivate: boolean;
  memberIds?: string[];
}

export async function createChannel(
  actor: PipelineActor,
  input: CreateChannelInput,
): Promise<{ status: 200 | 201; data: PipelineConversationResponse }> {
  const me = actor.userId;
  const memberIds = [...new Set(input.memberIds ?? [])].filter((id) => id !== me);
  if (memberIds.length + 1 > PIPELINE_LIMITS.participantsMax) {
    throw new PipelineError(409, "MEMBER_LIMIT", `A channel can have at most ${PIPELINE_LIMITS.participantsMax} people`);
  }
  const replay = async () => {
    const data = await pipelineRead(async (db) => {
      const rows = await db.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM pipeline_projects WHERE created_by_id = ${me} AND client_id = ${input.clientId}`;
      return rows[0] ? readConversation(db, rows[0].id) : null;
    });
    if (!data) throw new PipelineError(503, "PIPELINE_BUSY", "The pipeline is busy — retrying shortly", { retryAfterSec: 2 });
    return { status: 200 as const, data };
  };
  try {
    const result = await pipelineWrite(async (tx) => {
      const [s1] = await tx.$queryRaw<Row[]>`
        SELECT (SELECT id FROM pipeline_projects WHERE created_by_id = ${me} AND client_id = ${input.clientId}) AS existing_id,
               (SELECT (u.status = 'ACTIVE' AND u.deleted_at IS NULL) FROM users u WHERE u.id = ${me}) AS actor_active`;
      if (s1.existing_id) return { replayed: true as const };
      if (s1.actor_active !== true) throw inactive();
      await assertPickable(tx, actor, memberIds);
      // A campaign channel: the campaign must be live (not archived or deleted). A PUBLIC one
      // starts with every active member of the campaign; a private one with the people picked.
      const parentId = input.projectId ?? null;
      let campaignMembers: string[] = [];
      if (parentId) {
        const parent = await tx.$queryRaw<Array<{ archived: boolean; members: string[] }>>`
          SELECT p.archived_at IS NOT NULL AS archived,
                 ARRAY(SELECT pp.user_id FROM pipeline_participants pp JOIN users u ON u.id = pp.user_id
                        WHERE pp.project_id = p.id AND pp.role = 'MEMBER'
                          AND u.status = 'ACTIVE' AND u.deleted_at IS NULL) AS members
            FROM pipeline_projects p
           WHERE p.id = ${parentId} AND p.kind = 'project' AND p.deleted_at IS NULL
             FOR SHARE OF p`;
        if (!parent[0]) throw new PipelineError(404, "PROJECT_NOT_FOUND", "This project doesn't exist");
        if (parent[0].archived) throw new PipelineError(409, "PROJECT_ARCHIVED", "This project is archived — unarchive it to make changes");
        if (!input.isPrivate) {
          campaignMembers = parent[0].members.filter((u) => u !== me && pickableByMode(actor.settings, u));
        }
      }
      const everyone = [...new Set([...memberIds, ...campaignMembers])];
      if (everyone.length + 1 > PIPELINE_LIMITS.participantsMax) {
        throw new PipelineError(409, "MEMBER_LIMIT", `A channel can have at most ${PIPELINE_LIMITS.participantsMax} people`);
      }
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NAME_LOCK_KEY}::bigint)`;
      await assertNameFree(tx, input.name, null, parentId);
      const id = randomUUID();
      const phaseId = await anyPhaseId(tx);
      await tx.$executeRaw`
        INSERT INTO pipeline_projects
               (id, client_id, title, description, owner_id, created_by_id, phase_id, rank,
                member_count, kind, is_private, parent_project_id, created_at, updated_at)
        VALUES (${id}, ${input.clientId}, ${input.name}, ${input.description ?? ""}, ${me}, ${me}, ${phaseId}, ${CHAT_RANK},
                ${everyone.length + 1}, 'channel', ${input.isPrivate}, ${parentId}::text, ${NOW}, ${NOW})`;
      await insertMembers(tx, id, [me], null);
      await insertMembers(tx, id, everyone, me);
      return { id };
    });
    if ("replayed" in result) return replay();
    return { status: 201, data: await pipelineRead((db) => readConversation(db, result.id)) };
  } catch (err) {
    if (err instanceof PipelineDbError && isIdempotencyKeyViolation(err.info)) return replay();
    throw err;
  }
}

// ── Edit: rename, description, public ↔ private (owner or admin) ─────────────────────

export interface EditChannelInput {
  name?: string;
  description?: string;
  isPrivate?: boolean;
}

export async function editChannel(actor: PipelineActor, id: string, input: EditChannelInput): Promise<PipelineConversationResponse> {
  const me = actor.userId;
  return pipelineWrite(async (tx) => {
    const { row } = await lockChat(tx, id, me, { admins: true });
    if (row.kind !== "channel") throw notFound();
    if (row.owner_id !== me && !(await isPipelineAdmin(tx, me))) {
      throw notAllowed(input.isPrivate !== undefined ? "change who can see this channel" : "rename this channel");
    }
    if (input.name !== undefined && input.name !== row.title) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${NAME_LOCK_KEY}::bigint)`;
      await assertNameFree(tx, input.name, id, (row.parent_project_id as string | null) ?? null);
    }
    await tx.$executeRaw`
      UPDATE pipeline_projects
         SET title = COALESCE(${input.name ?? null}::text, title),
             description = COALESCE(${input.description ?? null}::text, description),
             is_private = COALESCE(${input.isPrivate ?? null}::boolean, is_private),
             header_rev = header_rev + 1,
             updated_at = ${NOW}
       WHERE id = ${id}`;
    return readConversation(tx, id);
  });
}

// ── Delete (owner or admin; typed name confirms) ─────────────────────────────────────

/**
 * DELETE /pipeline/channels/:id — a soft delete: every list, detail and sync stops showing it
 * at once (open tabs see "deleted"), and the nightly purge removes it with its messages after
 * 30 days, like a project. The name is free again immediately. A DM can't be deleted.
 */
export async function deleteChannel(actor: PipelineActor, id: string, confirmName: string): Promise<{ deleted: true }> {
  const me = actor.userId;
  return pipelineWrite(async (tx) => {
    const { row } = await lockChat(tx, id, me, { admins: true });
    if (row.kind !== "channel") throw new PipelineError(409, "CANT_DELETE_DM", "A direct message can't be deleted");
    if (row.owner_id !== me && !(await isPipelineAdmin(tx, me))) throw notAllowed("delete this channel");
    if (confirmName.trim().replace(/^#/, "").toLowerCase() !== String(row.title).toLowerCase()) {
      throw new PipelineError(400, "CONFIRM_MISMATCH", "The name you typed doesn't match the channel");
    }
    await tx.$executeRaw`
      UPDATE pipeline_projects
         SET deleted_at = ${NOW}, deleted_by_id = ${me}, deleted_by_admin = ${row.owner_id !== me},
             header_rev = header_rev + 1, updated_at = ${NOW}
       WHERE id = ${id} AND deleted_at IS NULL`;
    return { deleted: true as const };
  });
}

// ── Membership ───────────────────────────────────────────────────────────────────────

/** POST /pipeline/channels/:id/join — public channels only (a private one is "not found"). */
export async function joinChannel(actor: PipelineActor, id: string): Promise<PipelineConversationResponse> {
  const me = actor.userId;
  return pipelineWrite(async (tx) => {
    const { row, isMember } = await lockChat(tx, id, me);
    if (row.kind !== "channel") throw notFound();
    if (!isMember) {
      await insertMembers(tx, id, [me], null);
      await recount(tx, id);
    }
    return readConversation(tx, id);
  });
}

/** POST /pipeline/channels/:id/leave — anyone may leave a channel; a DM can't be left. */
export async function leaveChannel(actor: PipelineActor, id: string): Promise<{ left: true }> {
  const me = actor.userId;
  return pipelineWrite(async (tx) => {
    const { row, isMember } = await lockChat(tx, id, me);
    if (row.kind !== "channel") throw new PipelineError(409, "CANT_LEAVE_DM", "You can't leave a direct message");
    if (row.owner_id === me) throw ownerCantLeave();
    if (isMember) {
      await tx.$executeRaw`DELETE FROM pipeline_participants WHERE project_id = ${id} AND user_id = ${me}`;
      await recount(tx, id);
    }
    return { left: true as const };
  });
}

/** POST /pipeline/channels/:id/members — any member adds people. */
export async function addChannelMembers(actor: PipelineActor, id: string, userIds: string[]): Promise<PipelineConversationResponse> {
  const me = actor.userId;
  const ids = [...new Set(userIds)].sort();
  return pipelineWrite(async (tx) => {
    const { row, isMember } = await lockChat(tx, id, me);
    if (row.kind !== "channel") throw new PipelineError(409, "DM_MEMBERS_FIXED", "A direct message is between two people");
    if (!isMember) throw new PipelineError(403, "NOT_A_MEMBER", "Join this channel to add people");
    await assertPickable(tx, actor, ids);
    const [c] = await tx.$queryRaw<Array<{ total: number; existing: number }>>`
      SELECT (SELECT count(*)::int FROM pipeline_participants WHERE project_id = ${id}) AS total,
             (SELECT count(*)::int FROM pipeline_participants WHERE project_id = ${id} AND user_id = ANY(${ids}::text[])) AS existing`;
    if (c.total + ids.length - c.existing > PIPELINE_LIMITS.participantsMax) {
      throw new PipelineError(409, "MEMBER_LIMIT", `A channel can have at most ${PIPELINE_LIMITS.participantsMax} people`);
    }
    const added = await insertMembers(tx, id, ids, me);
    if (added.length) await recount(tx, id);
    return readConversation(tx, id);
  });
}

/** DELETE /pipeline/channels/:id/members/:userId — owner or admin; yourself = leave. */
export async function removeChannelMember(actor: PipelineActor, id: string, targetId: string): Promise<PipelineConversationResponse> {
  const me = actor.userId;
  return pipelineWrite(async (tx) => {
    const { row } = await lockChat(tx, id, me, { admins: true });
    if (row.kind !== "channel") throw new PipelineError(409, "DM_MEMBERS_FIXED", "A direct message is between two people");
    if (targetId === me) {
      if (row.owner_id === me) throw ownerCantLeave();
    } else {
      if (row.owner_id !== me && !(await isPipelineAdmin(tx, me))) throw notAllowed("remove people");
      if (targetId === row.owner_id) throw new PipelineError(409, "CANT_REMOVE_OWNER", "The channel owner can't be removed");
    }
    const n = await tx.$executeRaw`DELETE FROM pipeline_participants WHERE project_id = ${id} AND user_id = ${targetId}`;
    if (n > 0) await recount(tx, id);
    return readConversation(tx, id);
  });
}

// ── Direct messages ──────────────────────────────────────────────────────────────────

/**
 * POST /pipeline/dms/:id/hide — "Delete conversation": gone from MY sidebar only. The other
 * person keeps it; it comes back for me when a newer message arrives or when I open it again.
 * Also marks it read, so it can't come back as unread for what I already deleted.
 */
export async function hideDm(actor: PipelineActor, id: string): Promise<{ hidden: true }> {
  const me = actor.userId;
  return pipelineWrite(async (tx) => {
    const { row } = await lockChat(tx, id, me);
    if (row.kind !== "dm") throw new PipelineError(409, "NOT_A_DM", "Only a direct message can be removed from your list");
    await tx.$executeRaw`
      UPDATE pipeline_participants pp
         SET hidden_seq = p.last_message_seq, last_read_seq = GREATEST(pp.last_read_seq, p.last_message_seq),
             updated_at = ${NOW}
        FROM pipeline_projects p
       WHERE p.id = pp.project_id AND pp.project_id = ${id} AND pp.user_id = ${me}`;
    return { hidden: true as const };
  });
}

/** POST /pipeline/dms — the DM with `userId` (created on first use; yourself = the self-DM). */
export async function openDm(actor: PipelineActor, userId: string): Promise<PipelineConversationResponse> {
  const me = actor.userId;
  const key = dmKeyOf(me, userId);
  return pipelineWrite(async (tx) => {
    const [s1] = await tx.$queryRaw<Row[]>`
      SELECT (SELECT id FROM pipeline_projects WHERE dm_key = ${key}) AS existing_id,
             (SELECT (u.status = 'ACTIVE' AND u.deleted_at IS NULL) FROM users u WHERE u.id = ${me}) AS actor_active`;
    if (s1.actor_active !== true) throw inactive();
    if (s1.existing_id) {
      // Opening a DM I had deleted brings it back to my sidebar.
      await tx.$executeRaw`
        UPDATE pipeline_participants SET hidden_seq = NULL, updated_at = ${NOW}
         WHERE project_id = ${String(s1.existing_id)} AND user_id = ${me} AND hidden_seq IS NOT NULL`;
      return readConversation(tx, String(s1.existing_id));
    }
    if (userId !== me) await assertPickable(tx, actor, [userId]);
    const id = randomUUID();
    const phaseId = await anyPhaseId(tx);
    const people = userId === me ? [me] : [me, userId];
    // ON CONFLICT: two people opening the same DM at once — the loser reads the winner's row.
    const inserted = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO pipeline_projects
             (id, client_id, title, description, owner_id, created_by_id, phase_id, rank,
              member_count, kind, is_private, dm_key, created_at, updated_at)
      VALUES (${id}, ${`dm-${randomUUID()}`}, 'Direct message', '', ${me}, ${me}, ${phaseId}, ${CHAT_RANK},
              ${people.length}, 'dm', true, ${key}, ${NOW}, ${NOW})
      ON CONFLICT (dm_key) DO NOTHING
      RETURNING id`;
    if (!inserted[0]) {
      const again = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM pipeline_projects WHERE dm_key = ${key}`;
      if (!again[0]) throw notFound();
      return readConversation(tx, again[0].id);
    }
    await insertMembers(tx, id, people, null);
    return readConversation(tx, id);
  });
}
