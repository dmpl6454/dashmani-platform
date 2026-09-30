/**
 * The seam between pipeline writes and pipeline notifications (plan PR 7, spec §7).
 *
 * Project and message services call `notifier.<event>(tx, args)` INSIDE their
 * transaction, after the participant upserts, so a notification is written exactly once
 * with the change it describes (no fire-and-forget, no dispatchNotification). Until
 * services/pipeline/index.ts installs notify.ts's realNotifier (PR 9) the default is
 * `noopNotifier`.
 *
 * Rules for an implementation (spec §7):
 *   - write only through `tx`; ids only via plnId()/plnIdSql();
 *   - every recipient passes the shared predicate: ACTIVE, not deleted, not the actor,
 *     and in `allow` when it is non-null (pilot mode);
 *   - never look up admins; recipient arrays are de-duplicated before an upsert;
 *   - text comes pre-built from notificationSnippet() — never raw `@{uuid}` tokens.
 */
import type { PipelineTx } from "./db";

interface NotifyBase {
  projectId: string;
  /** The project title as stored (≤ 120); the notifier cuts it to 60 for the "“…”: " prefix. */
  projectTitle: string;
  /** The user acting. Never a recipient. */
  actorId: string;
  /** The actor's display name, from the directory memo. */
  actorName: string;
  /** Pilot allowlist when `pipeline.mode = pilot`, else null (spec §7.3 `$allow`). */
  allow: string[] | null;
  /**
   * Also queue EMAIL for this event (email-outbox.ts pipelineEmailOn(settings), resolved
   * before the transaction). Absent = false. Only moved, mention and due_changed email.
   */
  email?: boolean;
}

/** §7.7 "added" rows for the members added at creation (never the creator). */
export interface ProjectCreatedArgs extends NotifyBase {
  phaseId: string;
  phaseName: string;
  /** `YYYY-MM-DD` or null. */
  dueDate: string | null;
  /** Newly created MEMBER rows other than the creator, de-duplicated. */
  addedUserIds: string[];
}

/** §7.7 "added" rows for members added later (newly created or promoted rows only). */
export interface MembersAddedArgs extends NotifyBase {
  phaseName: string;
  dueDate: string | null;
  addedUserIds: string[];
}

/** §7.6 phase-move rows, merged per generation. */
export interface MovedArgs extends NotifyBase {
  /** The move generation after the decision (§7.6). */
  gen: number;
  /** True when this move merged into the actor's current generation. */
  sameGeneration: boolean;
  /** True when the card went back to `move_from_phase_id` within the generation: delete this generation's unread rows instead. */
  netZero: boolean;
  fromPhaseId: string;
  fromPhaseName: string;
  toPhaseId: string;
  toPhaseName: string;
  /** The phase immediately before THIS move (the email compares its first one with the current phase). */
  prevPhaseId: string;
}

/** A due-date change through the field edit (route #7): the in-portal row and, if on, the email. */
export interface DueChangedArgs extends NotifyBase {
  /** `YYYY-MM-DD` before and after; null = no due date. Never equal. */
  fromDue: string | null;
  toDue: string | null;
  /** The project's current phase (the row's "Phase: …" line). */
  phaseName: string;
}

/** §7.11: a project soft delete removes the grouped rows of its current participants. */
export interface ProjectDeletedArgs {
  projectId: string;
  actorId: string;
  /** Current participants (≤ 200), whose `messages:<pid>:<uid>` rows are deleted by id. */
  participantIds: string[];
}

/** §7.4 grouped rows plus §7.5 mention and reply rows for one new message. */
export interface MessagePostedArgs extends NotifyBase {
  messageId: string;
  /** The root for a reply, else null. */
  rootId: string | null;
  seq: number;
  /** notificationSnippet(body, names, 100) — already token-free (the grouped preview). */
  snippet: string;
  /** notificationSnippet(body, names, 140) — the mention / reply row text (§7.5). */
  directSnippet: string;
  /** Mentioned users that passed the ACTIVE/pickable filter (stored in mention_ids). */
  deliveredMentionIds: string[];
  /** The root's author for a reply (gets a reply row unless mentioned or the actor), else null. */
  replyToAuthorId: string | null;
}

/** §7.11 edit: new snippets on existing rows, plus rows for NEWLY added mentions only. */
export interface MessageEditedArgs extends NotifyBase {
  messageId: string;
  rootId: string | null;
  seq: number;
  snippet: string;
  /** notificationSnippet(body, names, 140). */
  directSnippet: string;
  /** Delivered mentions not present before the edit. */
  addedMentionIds: string[];
  /** Every delivered mention after the edit (their rows get the new snippet). */
  mentionIds: string[];
  /** mention_ids BEFORE the edit (a dropped mention's row is DELETED, §7.11). */
  oldMentionIds: string[];
  replyToAuthorId: string | null;
  /** Current participants (≤ 200), whose grouped rows may carry this message's preview. */
  participantIds: string[];
}

/** §7.11 delete: remove mention and reply rows; rewrite grouped previews that came from it. */
export interface MessageDeletedArgs {
  projectId: string;
  messageId: string;
  actorId: string;
  actorName: string;
  /** mention_ids BEFORE the delete blanked them. */
  oldMentionIds: string[];
  /** Current participants (≤ 200). */
  participantIds: string[];
}

export interface PipelineNotifier {
  onProjectCreated(tx: PipelineTx, a: ProjectCreatedArgs): Promise<void>;
  onMembersAdded(tx: PipelineTx, a: MembersAddedArgs): Promise<void>;
  onMoved(tx: PipelineTx, a: MovedArgs): Promise<void>;
  onDueChanged(tx: PipelineTx, a: DueChangedArgs): Promise<void>;
  onProjectDeleted(tx: PipelineTx, a: ProjectDeletedArgs): Promise<void>;
  onMessagePosted(tx: PipelineTx, a: MessagePostedArgs): Promise<void>;
  onMessageEdited(tx: PipelineTx, a: MessageEditedArgs): Promise<void>;
  onMessageDeleted(tx: PipelineTx, a: MessageDeletedArgs): Promise<void>;
}

/** Writes nothing. The default until PR 9's notify.ts calls setNotifier(). */
export const noopNotifier: PipelineNotifier = {
  onProjectCreated: async () => {},
  onMembersAdded: async () => {},
  onMoved: async () => {},
  onDueChanged: async () => {},
  onProjectDeleted: async () => {},
  onMessagePosted: async () => {},
  onMessageEdited: async () => {},
  onMessageDeleted: async () => {},
};

/** The active notifier. Read it at call time (`notifier.onMoved(...)`), never cache it. */
export let notifier: PipelineNotifier = noopNotifier;

export function setNotifier(n: PipelineNotifier): void {
  notifier = n;
}
