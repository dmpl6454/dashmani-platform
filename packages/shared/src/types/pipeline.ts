/**
 * Pipeline wire types (spec §3.4 routes, §3.5 shapes, §5.2 sync, §5.3 snapshot, §7.1 metadata).
 *
 * ⚠️ ADDITIVE-ONLY CONTRACT. An old HR tab keeps polling a new API until it reloads
 * (`clientBuild` / `pipeline.minClientBuild`, §9.9), so fields may be ADDED here but never
 * renamed, removed or re-typed without bumping PIPELINE_CLIENT_BUILD on the client.
 *
 * Conventions:
 *   - ids are lowercase UUID strings;
 *   - calendar days (`startDate`, `dueDate`) are `YYYY-MM-DD` IST days;
 *   - timestamps are ISO-8601 UTC strings (`…Z`);
 *   - a field the server could not determine is `null`, never a fabricated 0 or "".
 */
import type {
  PipelineMode,
  PipelineParticipantRole,
  PipelineReactionKey,
  PipelineLimits,
} from "../pipeline/constants";
// (PipelineMode, PipelineParticipantRole, PipelineReactionKey and PipelineLimits are
// exported from the package index via pipeline/constants.)

/** `YYYY-MM-DD`. */
export type PipelineDay = string;
/** ISO-8601 UTC timestamp. */
export type PipelineTimestamp = string;

// ── Errors ──────────────────────────────────────────────────────────────────────────

/** Every error code a pipeline route can return (spec §3.3, §3.4, §4, §8.1). */
export type PipelineErrorCode =
  // auth & gates
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "PIPELINE_DISABLED"
  | "PIPELINE_NOT_IN_PILOT"
  | "ACCOUNT_INACTIVE"
  // capacity (retry silently after retryAfterSec)
  | "PIPELINE_RATE_LIMIT"
  | "PIPELINE_BUSY"
  // request shape
  | "VALIDATION_ERROR"
  | "PAYLOAD_TOO_LARGE"
  | "INVALID_JSON"
  | "DATE_ORDER"
  | "MENTION_LIMIT"
  // not found
  | "NOT_FOUND"
  | "PROJECT_NOT_FOUND"
  | "PROJECT_DELETED"
  | "MESSAGE_NOT_FOUND"
  | "PHASE_NOT_FOUND"
  | "USER_NOT_FOUND"
  // authorization
  | "NOT_OWNER_OR_ADMIN"
  | "REMOVED_BY_ADMIN"
  | "NOT_AUTHOR"
  | "CANNOT_REMOVE_MEMBER"
  // conflicts
  | "CONFLICT"
  | "IDEMPOTENCY_KEY_REUSED"
  | "EDIT_CONFLICT"
  | "MOVE_CONFLICT"
  | "PROJECT_ARCHIVED"
  | "PHASE_ARCHIVED"
  | "MESSAGE_DELETED"
  | "MEMBER_NOT_PICKABLE"
  | "USER_NOT_PICKABLE"
  | "MEMBER_LIMIT"
  | "OWNER_CANNOT_BE_REMOVED"
  | "RESTORE_WINDOW_PASSED"
  | "CONFIRM_MISMATCH"
  // anything unexpected (the UI never shows the server message)
  | "PIPELINE_INTERNAL";

/** The `error` object of a failed pipeline response. */
export interface PipelineErrorBody {
  code: PipelineErrorCode;
  message: string;
  details?: Array<{ field: string; message: string }>;
  /** Present on 429 PIPELINE_RATE_LIMIT and 503 PIPELINE_BUSY. */
  retryAfterSec?: number;
  /** Present on 409 EDIT_CONFLICT (the current Header) and MOVE_CONFLICT (the current Card). */
  current?: unknown;
}

export interface PipelineErrorResponse {
  success: false;
  error: PipelineErrorBody;
}

// ── Phases, cards and the board (§5.3) ──────────────────────────────────────────────

export interface PipelinePhase {
  id: string;
  key: string;
  name: string;
  position: number;
  /** A design-token name from the allowlist (e.g. "indigo"). */
  color: string;
  /** Terminal phases (Done) get no due / overdue alerts. */
  isTerminal: boolean;
}

/** One card on the board, or one row of the archived / deleted lists. */
export interface PipelineCard {
  id: string;
  phaseId: string;
  title: string;
  /** Fractional index. Order only with `compareRank`. */
  rank: string;
  ownerId: string;
  startDate: PipelineDay | null;
  dueDate: PipelineDay | null;
  memberCount: number;
  /** Up to 3 member user ids, oldest first, for the avatar stack. */
  preview: string[];
  /** Only on archived / deleted list rows. */
  archivedAt?: PipelineTimestamp | null;
  archivedByAdmin?: boolean;
  deletedAt?: PipelineTimestamp | null;
  deletedByAdmin?: boolean;
}

export interface PipelinePhaseCount {
  shown: number;
  total: number;
  truncated: boolean;
}

/** The whole board at version `v`. The label always equals its rows (one statement). */
export interface PipelineBoardSnapshot {
  v: number;
  phases: PipelinePhase[];
  cards: PipelineCard[];
  perPhase: Record<string, PipelinePhaseCount>;
}

/** My overlay row for one live project I participate in (sync `mine`). */
export interface PipelineMineEntry {
  projectId: string;
  role: PipelineParticipantRole;
  notify: boolean;
  /** `last_message_seq − last_read_seq`, clamped at 0. */
  unread: number;
}

// ── Project header, participants, permissions (§3.4 route #6, §3.5) ─────────────────

export interface PipelineHeader {
  id: string;
  title: string;
  description: string;
  phaseId: string;
  rank: string;
  ownerId: string;
  createdById: string;
  startDate: PipelineDay | null;
  dueDate: PipelineDay | null;
  memberCount: number;
  headerRev: number;
  threadRev: number;
  lastMessageSeq: number;
  lastMessageAt: PipelineTimestamp | null;
  phaseChangedAt: PipelineTimestamp | null;
  phaseChangedById: string | null;
  archivedAt: PipelineTimestamp | null;
  archivedById: string | null;
  archivedByAdmin: boolean;
  deletedAt: PipelineTimestamp | null;
  deletedById: string | null;
  deletedByAdmin: boolean;
  createdAt: PipelineTimestamp;
  updatedAt: PipelineTimestamp;
}

/**
 * Another participant as everyone sees them. `notify`, `lastReadSeq` and `seenAt` are
 * NEVER sent for other people — only in `me`.
 */
export interface PipelineParticipant {
  userId: string;
  role: PipelineParticipantRole;
  isOwner: boolean;
  memberAddedById: string | null;
  createdAt: PipelineTimestamp;
}

/** The viewer's own relationship to the project. `role` is null when not a participant. */
export interface PipelineMe {
  role: PipelineParticipantRole | null;
  notify: boolean;
  lastReadSeq: number;
}

/** Button visibility only — every action is re-checked in the DB at action time. */
export interface PipelineCan {
  archive: boolean;
  delete: boolean;
  restore: boolean;
  transferOwner: boolean;
  removeOthers: boolean;
}

// ── Messages (§3.5) ──────────────────────────────────────────────────────────────────

export interface PipelineMention {
  id: string;
  name: string;
}

export type PipelineReactions = Partial<Record<PipelineReactionKey, string[]>>;

export interface PipelineMessage {
  id: string;
  /** Only on the viewer's own messages (resolves a pending send). */
  clientId?: string;
  projectId: string;
  seq: number;
  rev: number;
  /** null = top-level; a reply points at its ROOT. */
  parentId: string | null;
  authorId: string;
  authorName: string;
  /** "" when deleted. Contains `@{uuid}` tokens; render as React text only. */
  body: string;
  /** Delivered mentions only. */
  mentions: PipelineMention[];
  reactions: PipelineReactions;
  replyCount: number;
  lastReplyAt: PipelineTimestamp | null;
  editedAt: PipelineTimestamp | null;
  deletedAt: PipelineTimestamp | null;
  createdAt: PipelineTimestamp;
}

export type PipelineNotNotifiedReason = "inactive" | "not_in_pilot" | "unknown";

export interface PipelineNotNotified {
  id: string;
  reason: PipelineNotNotifiedReason;
}

// ── Route #1: bootstrap ──────────────────────────────────────────────────────────────

/** Why the feature is unavailable to this user. The client shows copy per reason (§9.8). */
export type PipelineDisabledReason =
  /** `pipeline.mode` is off or absent: "Pipeline is paused" (auto-resumes). */
  | "off"
  /** The boot schema self-check failed: also shown as paused (auto-resumes). */
  | "paused"
  /** Pilot mode and this user is not on the list. */
  | "not_in_pilot"
  /** The account is inactive or deleted. */
  | "inactive";

export interface PipelinePollMs {
  /** Project open, tab focused. */
  project: number;
  /** Project open, visible but not focused. */
  projectBg: number;
  /** Board only, focused. */
  board: number;
  /** Board only, visible but not focused. */
  boardBg: number;
  /** Visible with no input for 5 minutes. */
  idle: number;
}

export interface PipelineReactionOption {
  key: PipelineReactionKey;
  emoji: string;
}

export interface PipelineBootstrapDisabled {
  enabled: false;
  reason: PipelineDisabledReason;
}

export interface PipelineBootstrapEnabled {
  enabled: true;
  mode: Exclude<PipelineMode, "off">;
  /** The nav item shows only when true (mode "on"). */
  navVisible: boolean;
  me: { id: string; name: string; isAdmin: boolean };
  phases: PipelinePhase[];
  pollMs: PipelinePollMs;
  reactions: PipelineReactionOption[];
  limits: PipelineLimits;
  /** A client whose PIPELINE_CLIENT_BUILD is below this must reload. */
  minClientBuild: number;
}

export type PipelineBootstrap = PipelineBootstrapDisabled | PipelineBootstrapEnabled;

// ── Route #2: directory ──────────────────────────────────────────────────────────────

/** Names only — never an email or phone. ONBOARDING users are excluded. */
export interface PipelineDirectoryEntry {
  id: string;
  /** ≤ 60 characters, bidi-stripped. */
  name: string;
  initials: string;
  /** ACTIVE and not soft-deleted. */
  active: boolean;
  /** Can be added, mentioned or made owner (active, and on the pilot list in pilot mode). */
  pickable: boolean;
  /** Primary team name, sent only when another user has the same name. */
  hint?: string;
}

// ── Route #3: sync (§5.2) ────────────────────────────────────────────────────────────

export interface PipelineSyncAck {
  /** Highest seq whose row was ≥ 50% in the viewport. */
  seq: number;
  open?: boolean;
  leaving?: boolean;
  /** Rendered messages that mention me or reply to me and were actually seen (≤ 50). */
  seen?: string[];
}

export interface PipelineSyncRequest {
  clientBuild: number;
  /** Sent only while the board is mounted; `v: -1` forces a snapshot. */
  board?: { v: number };
  /** Hash of the `mine` overlay the client holds. */
  mineH?: string;
  /** Sent only while a project view is mounted; `ack` only while it is visible. */
  project?: { id: string; rev: number; hv: number; ack?: PipelineSyncAck };
}

export type PipelineProjectStatus = "ok" | "archived" | "deleted";

export interface PipelineSyncProject {
  id: string;
  /** "deleted" also covers a project that no longer exists — never a 404. */
  status: PipelineProjectStatus;
  /** Next delta cursor (thread_rev, or the 50th row's rev when hasMore). */
  rev: number;
  hv: number;
  /** Sent only when header_rev changed since `hv`. */
  header: PipelineHeader | null;
  participants: PipelineParticipant[] | null;
  /** The viewer's own row; sent with the header. */
  me?: PipelineMe | null;
  /** Messages with rev > the request's rev, ordered by rev (≤ 50). */
  messages: PipelineMessage[];
  hasMore: boolean;
  lastReadSeq: number;
}

export interface PipelineSyncResponse {
  /** Current board version. */
  v: number;
  /** A snapshot when the request's board.v differs from v (either direction). */
  board: PipelineBoardSnapshot | null;
  mineH: string;
  /** null when unchanged from the request's mineH. */
  mine: PipelineMineEntry[] | null;
  project: PipelineSyncProject | null;
  /**
   * The server's current base intervals (same shape as bootstrap's). Sent on every sync
   * so a `pipeline.pollMs` change reaches open tabs with no deploy and no re-bootstrap.
   */
  pollMs: PipelinePollMs;
  /** true → one hard reload (the client build is too old). */
  reload: boolean;
  /** Present when a board was asked for and no snapshot could be built this tick. */
  boardUnavailable?: true;
}

// ── Routes #4–14: projects ───────────────────────────────────────────────────────────

export type PipelineListView = "archived" | "deleted";

export interface PipelineProjectListResponse {
  items: PipelineCard[];
  /** Opaque; pass back as `cursor`. null at the end. */
  nextCursor: string | null;
}

export interface PipelineCreateProjectRequest {
  clientId: string;
  title: string;
  description?: string;
  phaseId?: string;
  startDate?: PipelineDay | null;
  dueDate?: PipelineDay | null;
  memberIds?: string[];
}

export interface PipelineCreateProjectResponse {
  card: PipelineCard;
  replayed: boolean;
}

export interface PipelineProjectDetail {
  header: PipelineHeader;
  description: string;
  participants: PipelineParticipant[];
  me: PipelineMe;
  can: PipelineCan;
  messages: PipelineMessage[];
  threadRev: number;
  headerRev: number;
  hasOlder: boolean;
  hasNewer: boolean;
  /** true when `?around=` named a message that no longer exists; the latest page is returned. */
  aroundMissing?: boolean;
}

export interface PipelineEditableFields {
  title?: string;
  description?: string;
  startDate?: PipelineDay | null;
  dueDate?: PipelineDay | null;
}

export interface PipelineEditProjectRequest {
  changes: PipelineEditableFields;
  /** The values the user started editing from, for every changed key. */
  base: PipelineEditableFields;
}

export interface PipelineHeaderResponse {
  header: PipelineHeader;
}

export interface PipelineMoveRequest {
  toPhaseId: string;
  /** The card to drop after; null = top of the phase. */
  afterId: string | null;
  /** The phase the client believed the card was in. */
  basePhaseId: string;
}

export interface PipelineMoveResponse {
  card: PipelineCard;
  /** true when `afterId` was gone and the card went to the end instead. */
  placementAdjusted: boolean;
}

export interface PipelineArchiveResponse {
  card: PipelineCard;
  /** true when the card's phase was archived and it moved to the first live phase. */
  phaseAdjusted: boolean;
}

export interface PipelineDeleteProjectRequest {
  confirmTitle: string;
}

export interface PipelineDeleteProjectResponse {
  deleted: true;
}

export interface PipelineTransferOwnerRequest {
  userId: string;
}

export interface PipelineAddMembersRequest {
  userIds: string[];
}

export interface PipelineAddMembersResponse {
  participants: PipelineParticipant[];
  /** Users newly created or promoted to MEMBER by this call. */
  added: string[];
}

export interface PipelineRemoveMemberResponse {
  result: "demoted" | "removed" | "none";
}

export interface PipelineFollowRequest {
  following: boolean;
}

export interface PipelineFollowResponse {
  role: PipelineParticipantRole | null;
  notify: boolean;
}

// ── Routes #15–21: messages ──────────────────────────────────────────────────────────

export interface PipelineMessagesPage {
  messages: PipelineMessage[];
  hasOlder: boolean;
}

export interface PipelineRepliesPage {
  root: PipelineMessage;
  replies: PipelineMessage[];
  hasMore: boolean;
}

export interface PipelinePostMessageRequest {
  clientId: string;
  body: string;
  parentId?: string;
}

export interface PipelinePostMessageResponse {
  message: PipelineMessage;
  /** The updated root, for a reply. */
  root?: PipelineMessage;
  replayed: boolean;
  notified: string[];
  notNotified: PipelineNotNotified[];
}

export interface PipelineEditMessageRequest {
  body: string;
}

export interface PipelineEditMessageResponse {
  message: PipelineMessage;
  notNotified: PipelineNotNotified[];
}

export interface PipelineDeleteMessageResponse {
  message: PipelineMessage;
}

export interface PipelineReactionRequest {
  on: boolean;
}

export interface PipelineReactionResponse {
  messageId: string;
  reactions: PipelineReactions;
  rev: number;
}

export interface PipelineReadRequest {
  seq: number;
  leaving?: boolean;
}

export interface PipelineReadResponse {
  lastReadSeq: number;
}

// ── Notifications (§7.1) ─────────────────────────────────────────────────────────────

export type PipelineNotificationKind =
  | "messages"
  | "mention"
  | "reply"
  | "added"
  | "moved"
  | "due_soon"
  | "overdue"
  /** A due date set, changed or removed (route #7); re-armed in place. */
  | "due_changed";

/** `notifications.metadata` for rows of type PIPELINE. */
export interface PipelineNotificationMetadata {
  v: 1;
  kind: PipelineNotificationKind;
  pid: string;
  mid?: string;
  rid?: string;
  seq?: number;
  /** Grouped rows: messages since the row was last read. */
  n?: number;
  lastMid?: string;
  app: "hr";
  /** In-app path, always starting with `/pipeline/`. */
  path: string;
  /** Absolute HR URL built from HR_APP_URL (the internal bell's new-tab link). */
  url: string;
}
