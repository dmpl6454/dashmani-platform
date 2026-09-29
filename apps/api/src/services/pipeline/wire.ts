/**
 * Row → wire mappers shared by the project, board and (PR 8) message/sync services
 * (spec §3.4, §3.5). Pure: no statements, no memos beyond the directory passed in.
 *
 * Rows arrive in two shapes and both are accepted:
 *   - `$queryRaw` columns: timestamps and `@db.Date` columns as JS Dates (UTC);
 *   - `row_to_json` / `json_agg` objects: timestamps as "2026-09-28T11:51:00.123" (no zone
 *     — the columns are `timestamp(3) without time zone` holding UTC) and dates as
 *     "2026-09-28".
 */
import type {
  PipelineCard,
  PipelineHeader,
  PipelineMessage,
  PipelineParticipant,
  PipelineParticipantRole,
} from "@dashmani/shared";
import type { PipelineDirectory } from "./access";
// One message shape on every route: route #6 must clean reactions and name unknown
// users exactly as sync/history (toWireMessage) do.
import { cleanReactions, UNKNOWN_AUTHOR_NAME } from "./messages.service";

type Raw = Record<string, unknown>;

/**
 * `YYYY-MM-DD` for a `@db.Date` value. ⚠️ Spec §2 rule 9: `toISOString().slice(0,10)` is
 * correct ONLY for `@db.Date` columns (Prisma reads them as UTC midnight) — never use it
 * for a timestamp, which would give the UTC day, not the IST day.
 */
export function day(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

/** ISO-8601 UTC for a `timestamp(3) without time zone` column (stored as UTC). */
export function ts(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  const s = String(v);
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const str = (v: unknown): string => (typeof v === "string" ? v : String(v ?? ""));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const int = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));

/** The columns a card needs, in both snake-case shapes (`$queryRaw` or JSON). */
export const CARD_PREVIEW_LIMIT = 3;

export function cardFromRow(r: Raw, opts: { listFields?: boolean } = {}): PipelineCard {
  const card: PipelineCard = {
    id: str(r.id),
    phaseId: str(r.phase_id),
    title: str(r.title),
    rank: str(r.rank),
    ownerId: str(r.owner_id),
    startDate: day(r.start_date),
    dueDate: day(r.due_date),
    memberCount: int(r.member_count),
    preview: Array.isArray(r.preview) ? (r.preview as unknown[]).map(str).slice(0, CARD_PREVIEW_LIMIT) : [],
  };
  if (opts.listFields) {
    card.archivedAt = ts(r.archived_at);
    card.archivedByAdmin = r.archived_by_admin === true;
    card.deletedAt = ts(r.deleted_at);
    card.deletedByAdmin = r.deleted_by_admin === true;
  }
  return card;
}

export function headerFromRow(r: Raw): PipelineHeader {
  return {
    id: str(r.id),
    title: str(r.title),
    description: str(r.description),
    phaseId: str(r.phase_id),
    rank: str(r.rank),
    ownerId: str(r.owner_id),
    createdById: str(r.created_by_id),
    startDate: day(r.start_date),
    dueDate: day(r.due_date),
    memberCount: int(r.member_count),
    headerRev: int(r.header_rev),
    threadRev: int(r.thread_rev),
    lastMessageSeq: int(r.last_message_seq),
    lastMessageAt: ts(r.last_message_at),
    phaseChangedAt: ts(r.phase_changed_at),
    phaseChangedById: strOrNull(r.phase_changed_by_id),
    archivedAt: ts(r.archived_at),
    archivedById: strOrNull(r.archived_by_id),
    archivedByAdmin: r.archived_by_admin === true,
    deletedAt: ts(r.deleted_at),
    deletedById: strOrNull(r.deleted_by_id),
    deletedByAdmin: r.deleted_by_admin === true,
    createdAt: ts(r.created_at) ?? "",
    updatedAt: ts(r.updated_at) ?? "",
  };
}

/** The projection EVERYONE sees — never notify, last_read_seq or seen_at (spec §3.5). */
export function participantFromRow(r: Raw, ownerId: string): PipelineParticipant {
  const userId = str(r.user_id);
  return {
    userId,
    role: str(r.role) as PipelineParticipantRole,
    isOwner: userId === ownerId,
    memberAddedById: strOrNull(r.member_added_by_id),
    createdAt: ts(r.created_at) ?? "",
  };
}

function nameOf(dir: PipelineDirectory, id: string): string {
  return dir.byId.get(id)?.name ?? UNKNOWN_AUTHOR_NAME;
}

/**
 * The message wire shape (spec §3.5). `authorName` and mention names come from the
 * in-process directory memo — no query. `clientId` only on the viewer's own messages.
 */
export function messageFromRow(r: Raw, viewerId: string, dir: PipelineDirectory): PipelineMessage {
  const authorId = str(r.author_id);
  const mentionIds = Array.isArray(r.mention_ids) ? (r.mention_ids as unknown[]).map(str) : [];
  const msg: PipelineMessage = {
    id: str(r.id),
    projectId: str(r.project_id),
    seq: int(r.seq),
    rev: int(r.rev),
    parentId: strOrNull(r.parent_id),
    authorId,
    authorName: nameOf(dir, authorId),
    body: str(r.body),
    mentions: mentionIds.map((id) => ({ id, name: nameOf(dir, id) })),
    reactions: cleanReactions(r.reactions),
    replyCount: int(r.reply_count),
    lastReplyAt: ts(r.last_reply_at),
    editedAt: ts(r.edited_at),
    deletedAt: ts(r.deleted_at),
    createdAt: ts(r.created_at) ?? "",
  };
  if (authorId === viewerId && r.client_id) msg.clientId = str(r.client_id);
  return msg;
}
