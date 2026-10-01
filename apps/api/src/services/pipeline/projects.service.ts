/**
 * Pipeline projects: create, list, detail, edit, move, archive/unarchive/delete/restore
 * and owner transfer (spec §3.4 routes #4–#11, §4, §6).
 *
 * ⚠️ Rules every function here follows (spec §2 "DB access rules", §6):
 *   - only `pipelineRead` / `pipelineWrite`; transaction callbacks use `tx` only;
 *   - statement 1 of every write locks the project row FOR UPDATE and re-checks the
 *     actor's status in SQL; later statements read after the lock;
 *   - no `Promise.all` over queries; ranks ordered only with COLLATE "C";
 *   - raw writes set `updated_at = timezone('utc', now())`;
 *   - owner/admin is decided from the LOCKED row plus a fresh DB admin check, never the JWT;
 *   - the board is bumped AFTER the transaction commits (bumpBoard), never inside it.
 */
import { randomUUID } from "node:crypto";
import {
  compareRank,
  keyBetween,
  nKeysBetween,
  type PipelineEditableFields,
  type PipelineHeader,
  type PipelineArchiveResponse,
  type PipelineMoveRequest,
  type PipelineMoveResponse,
  type PipelineProjectDetail,
  type PipelineMe,
  rankNeedsRebalance,
  PIPELINE_LIMITS,
  type PipelineCard,
  type PipelineCreateProjectResponse,
  type PipelineProjectListResponse,
} from "@dashmani/shared";
import type { PipelineDbClient, PipelineTx } from "./db";
import { pipelineRead, pipelineWrite } from "./tx";
import { PipelineDbError, PipelineError, isIdempotencyKeyViolation } from "./errors";
import { bumpBoard } from "./board";
import { notifier } from "./notifier";
import { cardFromRow, day, headerFromRow, messageFromRow, participantFromRow } from "./wire";
import type { PipelineDirectory } from "./access";
import { isPilotUser, type PipelineSettings } from "./settings";
import { pipelineEmailOn } from "./email-outbox";
import { assertOwnerOrAdmin } from "../../middleware/pipeline-gates";

type Row = Record<string, unknown>;
type Db = PipelineDbClient | PipelineTx;

/** Who is acting, resolved by the G gate BEFORE any slot is taken. */
export interface PipelineActor {
  userId: string;
  name: string;
  /** From the 60 s access memo: button visibility and read scoping only, never actions. */
  isAdminHint: boolean;
  settings: PipelineSettings;
}

/** The pilot allowlist a notifier must honour, or null outside pilot mode (spec §7.3). */
export function allowList(settings: PipelineSettings): string[] | null {
  return settings.mode === "pilot" ? [...settings.pilotUserIds] : null;
}

/** True when `userId` may be added, mentioned or made owner under the current mode (JS half). */
export function pickableByMode(settings: PipelineSettings, userId: string): boolean {
  return settings.mode !== "pilot" || isPilotUser(settings, userId);
}

// ── Shared SQL pieces ────────────────────────────────────────────────────────────────

/** Card columns plus the ≤3 MEMBER avatar preview (oldest first). */
async function readCard(db: Db, projectId: string): Promise<PipelineCard | null> {
  const rows = await db.$queryRaw<Row[]>`
    SELECT p.id, p.phase_id, p.title, p.rank, p.owner_id, p.start_date, p.due_date, p.member_count,
           ARRAY(SELECT pp.user_id FROM pipeline_participants pp
                  WHERE pp.project_id = p.id AND pp.role = 'MEMBER'
                  ORDER BY pp.created_at, pp.user_id LIMIT 3) AS preview
      FROM pipeline_projects p
     WHERE p.id = ${projectId}`;
  return rows[0] ? cardFromRow(rows[0]) : null;
}

export { readCard };

/**
 * Statement 1 of every project write: lock the row and re-check the actor (spec §4.3, §6).
 * `db_now` is the database clock, so time windows never depend on the API host's clock.
 */
export async function lockProject(tx: PipelineTx, projectId: string, actorId: string): Promise<Row | null> {
  const rows = await tx.$queryRaw<Row[]>`
    SELECT p.*,
           (SELECT (u.status = 'ACTIVE' AND u.deleted_at IS NULL) FROM users u WHERE u.id = ${actorId}) AS actor_active,
           timezone('utc', now()) AS db_now
      FROM pipeline_projects p
     WHERE p.id = ${projectId}
       FOR UPDATE OF p`;
  return rows[0] ?? null;
}

/**
 * The common refusals after the lock, in a fixed order: missing → 404, deleted → 404,
 * inactive actor → 403, archived → 409 (unless the operation is allowed on archived rows).
 */
export function assertWritable(row: Row | null, opts: { allowArchived?: boolean } = {}): asserts row is Row {
  if (!row) throw new PipelineError(404, "PROJECT_NOT_FOUND", "This project doesn't exist");
  if (row.deleted_at) throw new PipelineError(404, "PROJECT_DELETED", "This project was deleted");
  if (row.actor_active !== true) throw new PipelineError(403, "ACCOUNT_INACTIVE", "Your account is inactive");
  if (row.archived_at && !opts.allowArchived) {
    throw new PipelineError(409, "PROJECT_ARCHIVED", "This project is archived — unarchive it to make changes");
  }
}

// ── Route #5: create (spec §6 "Create project") ──────────────────────────────────────

export interface CreateProjectInput {
  clientId: string;
  title: string;
  description?: string;
  phaseId?: string;
  startDate?: string | null;
  dueDate?: string | null;
  memberIds?: string[];
}

export async function createProject(
  actor: PipelineActor,
  input: CreateProjectInput,
): Promise<{ status: 200 | 201; data: PipelineCreateProjectResponse }> {
  const me = actor.userId;
  // Deduped by the validator; the creator is always the owner, never an "added" member.
  const memberIds = [...new Set(input.memberIds ?? [])].filter((id) => id !== me);
  if (memberIds.some((id) => !pickableByMode(actor.settings, id))) {
    throw new PipelineError(409, "MEMBER_NOT_PICKABLE", "Someone you picked can't be added right now");
  }
  const phaseId = input.phaseId ?? null;

  const replay = async (): Promise<{ status: 200; data: PipelineCreateProjectResponse }> => {
    const card = await pipelineRead(async (db) => {
      const rows = await db.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM pipeline_projects WHERE created_by_id = ${me} AND client_id = ${input.clientId}`;
      return rows[0] ? readCard(db, rows[0].id) : null;
    });
    if (!card) throw new PipelineError(503, "PIPELINE_BUSY", "The pipeline is busy — retrying shortly", { retryAfterSec: 2 });
    return { status: 200, data: { card, replayed: true } };
  };

  let result: { replayedId: string } | { card: PipelineCard };
  try {
    result = await pipelineWrite(async (tx) => {
      // S1: the key, the phase, the actor, the members and the phase's first rank.
      const [s1] = await tx.$queryRaw<Row[]>`
        WITH ph AS (
          SELECT id, name, archived_at
            FROM pipeline_phases
           WHERE CASE WHEN ${phaseId}::text IS NULL THEN archived_at IS NULL ELSE id = ${phaseId}::text END
           ORDER BY position, id
           LIMIT 1)
        SELECT (SELECT id FROM pipeline_projects WHERE created_by_id = ${me} AND client_id = ${input.clientId}) AS existing_id,
               ph.id AS phase_id, ph.name AS phase_name, ph.archived_at AS phase_archived_at,
               (SELECT (u.status = 'ACTIVE' AND u.deleted_at IS NULL) FROM users u WHERE u.id = ${me}) AS actor_active,
               (SELECT count(*)::int FROM users u
                 WHERE u.id = ANY(${memberIds}::text[]) AND u.status = 'ACTIVE' AND u.deleted_at IS NULL) AS active_members,
               (SELECT p.rank FROM pipeline_projects p
                 WHERE p.phase_id = ph.id AND p.archived_at IS NULL AND p.deleted_at IS NULL
                 ORDER BY p.rank COLLATE "C", p.id LIMIT 1) AS first_rank
          FROM (SELECT 1) one
          LEFT JOIN ph ON true`;
      if (s1.existing_id) return { replayedId: String(s1.existing_id) };
      if (!s1.phase_id) throw new PipelineError(404, "PHASE_NOT_FOUND", "That phase doesn't exist");
      if (s1.phase_archived_at) throw new PipelineError(409, "PHASE_ARCHIVED", "That phase is no longer in use");
      if (s1.actor_active !== true) throw new PipelineError(403, "ACCOUNT_INACTIVE", "Your account is inactive");
      if (Number(s1.active_members) !== memberIds.length) {
        throw new PipelineError(409, "MEMBER_NOT_PICKABLE", "Someone you picked can't be added right now");
      }
      const targetPhase = String(s1.phase_id);
      let rank = keyBetween(null, (s1.first_rank as string | null) ?? null);
      if (rankNeedsRebalance(rank)) {
        // The top of the phase is exhausted (vanishingly rare): place it at the bottom instead.
        const [last] = await tx.$queryRaw<Array<{ rank: string }>>`
          SELECT rank FROM pipeline_projects
           WHERE phase_id = ${targetPhase} AND archived_at IS NULL AND deleted_at IS NULL
           ORDER BY rank COLLATE "C" DESC, id DESC LIMIT 1`;
        rank = keyBetween(last?.rank ?? null, null);
      }

      // S2: the project and its participant rows (owner first, then members in order).
      // created_at is offset 1 ms per row so the avatar preview keeps that order.
      const id = randomUUID();
      const everyone = [me, ...memberIds];
      await tx.$queryRaw`
        WITH proj AS (
          INSERT INTO pipeline_projects
                 (id, client_id, title, description, owner_id, created_by_id, phase_id, rank,
                  start_date, due_date, member_count, created_at, updated_at)
          VALUES (${id}, ${input.clientId}, ${input.title}, ${input.description ?? ""}, ${me}, ${me}, ${targetPhase}, ${rank},
                  ${input.startDate ?? null}::date, ${input.dueDate ?? null}::date, ${everyone.length},
                  timezone('utc', now()), timezone('utc', now()))
          RETURNING id, created_at),
        parts AS (
          INSERT INTO pipeline_participants
                 (project_id, user_id, role, notify, member_added_by_id, member_added_at, created_at, updated_at)
          SELECT proj.id, v.uid, 'MEMBER', true,
                 CASE WHEN v.ord = 1 THEN NULL ELSE ${me} END,
                 CASE WHEN v.ord = 1 THEN NULL ELSE proj.created_at END,
                 proj.created_at + ((v.ord - 1) * interval '1 millisecond'),
                 proj.created_at
            FROM proj, unnest(${everyone}::text[]) WITH ORDINALITY AS v(uid, ord)
          ON CONFLICT DO NOTHING
          RETURNING user_id)
        SELECT (SELECT count(*)::int FROM parts) AS inserted`;

      await notifier.onProjectCreated(tx, {
        projectId: id,
        projectTitle: input.title,
        actorId: me,
        actorName: actor.name,
        allow: allowList(actor.settings),
        phaseId: targetPhase,
        phaseName: String(s1.phase_name ?? ""),
        dueDate: input.dueDate ?? null,
        addedUserIds: memberIds,
      });

      const card: PipelineCard = {
        id,
        phaseId: targetPhase,
        title: input.title,
        rank,
        ownerId: me,
        startDate: input.startDate ?? null,
        dueDate: input.dueDate ?? null,
        memberCount: everyone.length,
        preview: everyone.slice(0, 3),
      };
      return { card };
    });
  } catch (err) {
    // Two concurrent creates with one key: the loser's INSERT hits the unique key → replay.
    if (err instanceof PipelineDbError && isIdempotencyKeyViolation(err.info)) return replay();
    throw err;
  }
  if ("replayedId" in result) return replay();
  await bumpBoard();
  return { status: 201, data: { card: result.card, replayed: false } };
}

// ── Route #4: archived / deleted lists (keyset) ──────────────────────────────────────

export interface ListProjectsInput {
  view: "archived" | "deleted";
  cursor?: { at: string; id: string };
  limit: number;
}

export async function listProjects(actor: PipelineActor, input: ListProjectsInput): Promise<PipelineProjectListResponse> {
  const limit = Math.min(Math.max(1, input.limit), PIPELINE_LIMITS.listPageMax);
  const at = input.cursor?.at ?? null;
  const cid = input.cursor?.id ?? null;
  const rows = await pipelineRead((db) =>
    input.view === "archived"
      ? db.$queryRaw<Row[]>`
          SELECT p.id, p.phase_id, p.title, p.rank, p.owner_id, p.start_date, p.due_date, p.member_count,
                 ARRAY(SELECT pp.user_id FROM pipeline_participants pp
                        WHERE pp.project_id = p.id AND pp.role = 'MEMBER'
                        ORDER BY pp.created_at, pp.user_id LIMIT 3) AS preview,
                 p.archived_at, p.archived_by_admin, p.deleted_at, p.deleted_by_admin
            FROM pipeline_projects p
           WHERE p.archived_at IS NOT NULL AND p.deleted_at IS NULL
             AND (${at}::timestamptz IS NULL
                  OR (p.archived_at, p.id) < ((${at}::timestamptz AT TIME ZONE 'UTC'), ${cid}::text))
           ORDER BY p.archived_at DESC, p.id DESC
           LIMIT ${limit + 1}`
      : db.$queryRaw<Row[]>`
          SELECT p.id, p.phase_id, p.title, p.rank, p.owner_id, p.start_date, p.due_date, p.member_count,
                 ARRAY(SELECT pp.user_id FROM pipeline_participants pp
                        WHERE pp.project_id = p.id AND pp.role = 'MEMBER'
                        ORDER BY pp.created_at, pp.user_id LIMIT 3) AS preview,
                 p.archived_at, p.archived_by_admin, p.deleted_at, p.deleted_by_admin
            FROM pipeline_projects p
           WHERE p.deleted_at IS NOT NULL
             AND p.deleted_at > timezone('utc', now()) - make_interval(days => ${PIPELINE_LIMITS.restoreWindowDays}::int)
             AND (${actor.isAdminHint}::boolean OR p.owner_id = ${actor.userId})
             AND (${at}::timestamptz IS NULL
                  OR (p.deleted_at, p.id) < ((${at}::timestamptz AT TIME ZONE 'UTC'), ${cid}::text))
           ORDER BY p.deleted_at DESC, p.id DESC
           LIMIT ${limit + 1}`,
  );
  const page = rows.slice(0, limit);
  const items = page.map((r) => cardFromRow(r, { listFields: true }));
  let nextCursor: string | null = null;
  if (rows.length > limit) {
    const last = items[items.length - 1];
    const stamp = input.view === "archived" ? last.archivedAt : last.deletedAt;
    nextCursor = `${stamp},${last.id}`;
  }
  return { items, nextCursor };
}

// ── Route #6: detail (one statement) ─────────────────────────────────────────────────

const LATEST_PAGE = PIPELINE_LIMITS.messagesPageDefault; // 30
const AROUND_HALF = Math.floor(LATEST_PAGE / 2); // 15 + 15

type DetailRow = {
  project: Row | null;
  me: Row | null;
  around_project: string | null;
  participants: Row[];
  latest: Row[];
  older: Row[];
  newer: Row[];
  anchored: boolean;
};

/**
 * Header, participants (≤ 200, projected), my row, button flags and one page of top-level
 * messages — in ONE statement (spec route #6). The page is, in order of preference:
 * around `?around=` (a reply anchors on its root); around my first unread; the latest 30.
 * An `around` from another project is 404; a vanished one returns the latest page with
 * `aroundMissing`.
 */
export async function getProjectDetail(
  actor: PipelineActor,
  projectId: string,
  around: string | undefined,
  dir: PipelineDirectory,
): Promise<PipelineProjectDetail> {
  const me = actor.userId;
  const aroundId = around ?? null;
  const rows = await pipelineRead((db) =>
    db.$queryRaw<DetailRow[]>`
      WITH p AS (
        SELECT * FROM pipeline_projects WHERE id = ${projectId}),
      me AS (
        SELECT role, notify, last_read_seq FROM pipeline_participants
         WHERE project_id = ${projectId} AND user_id = ${me}),
      arq AS (
        SELECT m.project_id, COALESCE(r.seq, m.seq) AS root_seq
          FROM pipeline_messages m
          LEFT JOIN pipeline_messages r ON r.id = m.parent_id
         WHERE m.id = ${aroundId}::text),
      unr AS (
        SELECT COALESCE(r.seq, m.seq) AS root_seq
          FROM pipeline_messages m
          LEFT JOIN pipeline_messages r ON r.id = m.parent_id
         WHERE ${aroundId}::text IS NULL
           AND m.project_id = ${projectId}
           AND m.seq > (SELECT last_read_seq FROM me)
         ORDER BY m.seq
         LIMIT 1),
      anchor AS (
        SELECT COALESCE((SELECT root_seq FROM arq WHERE project_id = ${projectId}), (SELECT root_seq FROM unr)) AS seq),
      latest AS (
        SELECT m.* FROM pipeline_messages m
         WHERE (SELECT seq FROM anchor) IS NULL
           AND m.project_id = ${projectId} AND m.parent_id IS NULL
         ORDER BY m.seq DESC
         LIMIT ${LATEST_PAGE + 1}),
      older AS (
        SELECT m.* FROM pipeline_messages m
         WHERE m.project_id = ${projectId} AND m.parent_id IS NULL
           AND m.seq < (SELECT seq FROM anchor)
         ORDER BY m.seq DESC
         LIMIT ${AROUND_HALF + 1}),
      newer AS (
        SELECT m.* FROM pipeline_messages m
         WHERE m.project_id = ${projectId} AND m.parent_id IS NULL
           AND m.seq >= (SELECT seq FROM anchor)
         ORDER BY m.seq
         LIMIT ${AROUND_HALF + 1}),
      parts AS (
        SELECT user_id, role, member_added_by_id, member_added_at, created_at FROM pipeline_participants
         WHERE project_id = ${projectId}
         ORDER BY created_at, user_id
         LIMIT ${PIPELINE_LIMITS.participantsMax})
      SELECT (SELECT row_to_json(p) FROM p) AS project,
             (SELECT row_to_json(me) FROM me) AS me,
             (SELECT project_id FROM arq) AS around_project,
             ((SELECT seq FROM anchor) IS NOT NULL) AS anchored,
             (SELECT COALESCE(json_agg(x ORDER BY x.created_at, x.user_id), '[]'::json) FROM parts x) AS participants,
             (SELECT COALESCE(json_agg(x ORDER BY x.seq), '[]'::json) FROM latest x) AS latest,
             (SELECT COALESCE(json_agg(x ORDER BY x.seq), '[]'::json) FROM older x) AS older,
             (SELECT COALESCE(json_agg(x ORDER BY x.seq), '[]'::json) FROM newer x) AS newer`,
  );
  const d = rows[0];
  if (!d?.project) throw new PipelineError(404, "PROJECT_NOT_FOUND", "This project doesn't exist");
  if (d.project.deleted_at) throw new PipelineError(404, "PROJECT_DELETED", "This project was deleted");
  let aroundMissing = false;
  if (aroundId !== null) {
    if (d.around_project === null) aroundMissing = true;
    else if (d.around_project !== projectId) throw new PipelineError(404, "MESSAGE_NOT_FOUND", "That message isn't in this project");
  }

  let page: Row[];
  let hasOlder: boolean;
  let hasNewer: boolean;
  if (d.anchored) {
    hasOlder = d.older.length > AROUND_HALF;
    hasNewer = d.newer.length > AROUND_HALF;
    page = [...d.older.slice(hasOlder ? 1 : 0), ...d.newer.slice(0, AROUND_HALF)];
  } else {
    hasOlder = d.latest.length > LATEST_PAGE;
    hasNewer = false;
    page = d.latest.slice(hasOlder ? 1 : 0);
  }

  const header = headerFromRow(d.project);
  const meRow: PipelineMe = d.me
    ? { role: String(d.me.role) as PipelineMe["role"], notify: d.me.notify === true, lastReadSeq: Number(d.me.last_read_seq) }
    : { role: null, notify: false, lastReadSeq: 0 };
  const ownerOrAdmin = header.ownerId === me || actor.isAdminHint;
  const archived = header.archivedAt !== null;
  const detail: PipelineProjectDetail = {
    header,
    description: header.description,
    participants: d.participants.map((r) => participantFromRow(r, header.ownerId)),
    me: meRow,
    // Button visibility only (memo admin flag); every action re-checks in the DB.
    can: {
      archive: ownerOrAdmin && !archived,
      delete: ownerOrAdmin,
      restore: ownerOrAdmin && archived && (!header.archivedByAdmin || actor.isAdminHint),
      transferOwner: ownerOrAdmin && !archived,
      removeOthers: ownerOrAdmin && !archived,
    },
    messages: page.map((r) => messageFromRow(r, me, dir)),
    threadRev: header.threadRev,
    headerRev: header.headerRev,
    hasOlder,
    hasNewer,
  };
  if (aroundMissing) detail.aroundMissing = true;
  return detail;
}

// ── Route #7: field edits (spec §6 "Field edits") ────────────────────────────────────

type EditKey = "title" | "description" | "startDate" | "dueDate";
const EDIT_KEYS: readonly EditKey[] = ["title", "description", "startDate", "dueDate"];

function editableOf(h: PipelineHeader): Record<EditKey, string | null> {
  return { title: h.title, description: h.description, startDate: h.startDate, dueDate: h.dueDate };
}

/**
 * Per field: a conflict iff `current ≠ base AND current ≠ desired` (someone else changed
 * it to something else). Fields already at the desired value are skipped, so a retry is a
 * no-op. The date order is checked on the merged result, against the STORED other date.
 * The board is bumped only when the title or a date changed.
 */
export async function editProject(
  actor: PipelineActor,
  projectId: string,
  changes: PipelineEditableFields,
  base: PipelineEditableFields,
): Promise<{ header: PipelineHeader }> {
  const email = pipelineEmailOn(actor.settings); // memo only — before the slot
  // retryOnce: a due change writes several of each participant's notification rows (D1/D4),
  // which a concurrent ack or mark-all-read may hold — a lost lock race (55P03 / 40P01) is
  // retried once rather than shown as "not saved". The edit is safe to repeat: the whole
  // transaction rolled back (outbox rows included), and a field already at the desired value
  // is skipped as a no-op.
  const out = await pipelineWrite(async (tx) => {
    const row = await lockProject(tx, projectId, actor.userId);
    assertWritable(row);
    const current = headerFromRow(row);
    const cur = editableOf(current);
    const changed: EditKey[] = [];
    for (const k of EDIT_KEYS) {
      const desired = changes[k];
      if (desired === undefined) continue;
      if (cur[k] === desired) continue;
      if (cur[k] !== (base[k] ?? null)) {
        throw new PipelineError(409, "EDIT_CONFLICT", "Someone else just changed this", { current });
      }
      changed.push(k);
    }
    const start = changes.startDate !== undefined ? changes.startDate : cur.startDate;
    const due = changes.dueDate !== undefined ? changes.dueDate : cur.dueDate;
    if (start && due && start > due) {
      throw new PipelineError(400, "DATE_ORDER", "The due date can't be before the start date");
    }
    if (changed.length === 0) return { header: current, boardChanged: false };

    const has = (k: EditKey) => changed.includes(k);
    const [updated] = await tx.$queryRaw<Row[]>`
      UPDATE pipeline_projects SET
             title       = CASE WHEN ${has("title")}::boolean THEN ${changes.title ?? null}::text ELSE title END,
             description = CASE WHEN ${has("description")}::boolean THEN ${changes.description ?? null}::text ELSE description END,
             start_date  = CASE WHEN ${has("startDate")}::boolean THEN ${changes.startDate ?? null}::date ELSE start_date END,
             due_date    = CASE WHEN ${has("dueDate")}::boolean THEN ${changes.dueDate ?? null}::date ELSE due_date END,
             -- D1: onDueChanged (below, same transaction) withdraws the old date's due-soon /
             -- overdue rows, so the markers go too: an A → B → A change must re-arm the A alert
             -- it just deleted (IS DISTINCT FROM re-arms B by itself). Side effect, accepted: such
             -- a flip re-alerts (and re-emails the due-soon for) A.
             due_soon_notified_for = CASE WHEN ${has("dueDate")}::boolean THEN NULL ELSE due_soon_notified_for END,
             overdue_notified_for  = CASE WHEN ${has("dueDate")}::boolean THEN NULL ELSE overdue_notified_for END,
             header_rev  = header_rev + 1,
             updated_at  = timezone('utc', now())
       WHERE id = ${projectId}
   RETURNING *, (SELECT ph.name FROM pipeline_phases ph WHERE ph.id = pipeline_projects.phase_id) AS phase_name`;
    const header = headerFromRow(updated);
    if (has("dueDate")) {
      // (d) a due date set, changed or removed: the bell row (re-armed in place) and the email.
      await notifier.onDueChanged(tx, {
        projectId,
        projectTitle: header.title,
        actorId: actor.userId,
        actorName: actor.name,
        allow: allowList(actor.settings),
        email,
        fromDue: cur.dueDate,
        toDue: header.dueDate,
        phaseName: String(updated.phase_name ?? ""),
      });
    }
    return {
      header,
      boardChanged: has("title") || has("startDate") || has("dueDate"),
    };
  }, { retryOnce: true });
  if (out.boardChanged) await bumpBoard();
  return { header: out.header };
}

// ── Route #8: move (spec §6 "Card move", "Rebalance", §7.6) ──────────────────────────

const MOVE_MERGE_IDLE_MS = 2 * 60_000;
const MOVE_MERGE_SPAN_MS = 10 * 60_000;

const asDate = (v: unknown): Date | null => (v instanceof Date ? v : v ? new Date(String(v)) : null);

/**
 * Thrown inside the first move attempt when the new key needs the locked rebalance: the
 * attempt rolls back (releasing its single card lock) and the move re-runs in
 * `lockPhaseFirst` mode. Never leaves this file.
 */
class NeedsRebalance extends Error {}

export async function moveProject(actor: PipelineActor, projectId: string, input: PipelineMoveRequest): Promise<PipelineMoveResponse> {
  let out: Awaited<ReturnType<typeof moveAttempt>>;
  try {
    out = await moveAttempt(actor, projectId, input, false);
  } catch (err) {
    if (!(err instanceof NeedsRebalance)) throw err;
    out = await moveAttempt(actor, projectId, input, true);
  }
  if (out.changed) await bumpBoard();
  return { card: out.card!, placementAdjusted: out.placementAdjusted };
}

/**
 * One move transaction (spec §6 "Card move").
 *
 * ⚠️ LOCK ORDER — why there are two modes. The common path locks ONE row (the card) and
 * never waits for another, so it cannot be part of a cycle. The rebalance locks every
 * live row of the target phase in id order — but a mover that has ALREADY locked its
 * own card and then asks for the phase in id order breaks that order: two movers in the
 * same phase each hold their card and wait for the other's (proven by the PR 12
 * concurrency suite: 5 concurrent rebalancing moves → 5 × 503 on lock_timeout). So a
 * move that discovers it needs a rebalance aborts (NeedsRebalance, holding nothing) and
 * re-runs with `lockPhaseFirst`: the card AND the target phase's live rows are locked in
 * ONE id-ordered statement before anything else. Every multi-row locker then uses the
 * same global id order (a cross-phase swap included), so no cycle can form.
 *
 * That holds for PROJECT rows only. A move into Done also writes several of each
 * participant's NOTIFICATION rows (withdrawDueRows, then the moved row), which a viewer's
 * ack or the main pool's "Mark all read" can hold in another order — a rare lock cycle there
 * is real. Both sides retry it once: this move (retryOnce below) and markAllAsRead.
 */
async function moveAttempt(actor: PipelineActor, projectId: string, input: PipelineMoveRequest, lockPhaseFirst: boolean) {
  const me = actor.userId;
  const email = pipelineEmailOn(actor.settings); // memo only — before the slot
  const { toPhaseId, basePhaseId } = input;
  const afterId = input.afterId === projectId ? null : input.afterId;
  // retryOnce: a move into Done withdraws several rows per participant (D2) — a lost lock
  // race is retried once (see editProject). Safe: the transaction rolled back whole, and an
  // attempt that finds the card already in place returns without writing.
  return pipelineWrite(async (tx) => {
    if (lockPhaseFirst) {
      await tx.$queryRaw`
        SELECT id FROM pipeline_projects
         WHERE id = ${projectId}
            OR (phase_id = ${toPhaseId} AND archived_at IS NULL AND deleted_at IS NULL)
         ORDER BY id
           FOR UPDATE`;
    }
    // S1: lock the card (already held in lockPhaseFirst mode; re-reads it fresh).
    const row = await lockProject(tx, projectId, me);
    assertWritable(row);
    const curPhase = String(row.phase_id);
    if (curPhase !== basePhaseId && curPhase !== toPhaseId) {
      const current = await readCard(tx, projectId);
      throw new PipelineError(409, "MOVE_CONFLICT", "Someone else just moved this card", { current });
    }

    // The §7.6 merge decision needs only the locked row and the DB clock.
    const phaseChanged = curPhase !== toPhaseId;
    const now = asDate(row.db_now)!.getTime();
    const lastAt = asDate(row.move_last_at);
    const startedAt = asDate(row.move_started_at);
    const sameGen =
      phaseChanged &&
      row.move_actor_id === me &&
      lastAt !== null &&
      startedAt !== null &&
      now - lastAt.getTime() <= MOVE_MERGE_IDLE_MS &&
      now - startedAt.getTime() <= MOVE_MERGE_SPAN_MS;
    const gen = sameGen ? Number(row.move_gen) : Number(row.move_gen) + 1;
    const fromPhaseId = sameGen ? String(row.move_from_phase_id ?? curPhase) : curPhase;
    const netZero = sameGen && toPhaseId === fromPhaseId;

    // S2: the target phase and the neighbours (a = after, b = the next rank above a).
    const [s2] = await tx.$queryRaw<Row[]>`
      WITH ph AS (
        SELECT id, name, archived_at, is_terminal FROM pipeline_phases WHERE id = ${toPhaseId}),
      aft AS (
        SELECT rank FROM pipeline_projects
         WHERE id = ${afterId}::text AND phase_id = ${toPhaseId}
           AND archived_at IS NULL AND deleted_at IS NULL AND id <> ${projectId}),
      lst AS (
        SELECT rank FROM pipeline_projects
         WHERE phase_id = ${toPhaseId} AND archived_at IS NULL AND deleted_at IS NULL AND id <> ${projectId}
         ORDER BY rank COLLATE "C" DESC, id DESC LIMIT 1),
      a AS (
        SELECT CASE WHEN ${afterId}::text IS NULL THEN NULL
                    WHEN EXISTS (SELECT 1 FROM aft) THEN (SELECT rank FROM aft)
                    ELSE (SELECT rank FROM lst) END AS rank,
               (${afterId}::text IS NOT NULL AND NOT EXISTS (SELECT 1 FROM aft)) AS adjusted),
      b AS (
        SELECT q.rank FROM pipeline_projects q, a
         WHERE q.phase_id = ${toPhaseId} AND q.archived_at IS NULL AND q.deleted_at IS NULL AND q.id <> ${projectId}
           AND (a.rank IS NULL OR q.rank COLLATE "C" > a.rank COLLATE "C")
         ORDER BY q.rank COLLATE "C", q.id LIMIT 1)
      SELECT ph.id AS phase_id, ph.name AS phase_name, ph.archived_at AS phase_archived_at,
             ph.is_terminal AS phase_terminal,
             (SELECT name FROM pipeline_phases WHERE id = ${fromPhaseId}) AS from_name,
             (SELECT rank FROM a) AS a_rank, (SELECT adjusted FROM a) AS adjusted, (SELECT rank FROM b) AS b_rank
        FROM (SELECT 1) one
        LEFT JOIN ph ON true`;
    if (!s2.phase_id) throw new PipelineError(404, "PHASE_NOT_FOUND", "That phase doesn't exist");
    if (s2.phase_archived_at) throw new PipelineError(409, "PHASE_ARCHIVED", "That phase is no longer in use");
    const a = (s2.a_rank as string | null) ?? null;
    const b = (s2.b_rank as string | null) ?? null;
    const placementAdjusted = s2.adjusted === true;
    const curRank = String(row.rank);

    if (!phaseChanged && (a === null || compareRank(a, curRank) < 0) && (b === null || compareRank(curRank, b) < 0)) {
      // Already exactly there: a retry after success.
      return { card: await readCard(tx, projectId), placementAdjusted, changed: false };
    }

    let rank = keyBetween(a, b);
    if (rankNeedsRebalance(rank)) {
      if (!lockPhaseFirst) throw new NeedsRebalance("rebalance needed");
      rank = await rebalancePhase(tx, toPhaseId, projectId, afterId);
    }
    // D2: entering a terminal phase (Done) withdraws this due date's due-soon / overdue rows
    // (notifier.onMoved below), so its markers are cleared with them: moving back out of Done
    // re-arms the alerts that were withdrawn (the due cron never alerts a terminal project).
    const toTerminal = phaseChanged && s2.phase_terminal === true;

    // S3: the card, with the move bookkeeping only when the phase changed.
    const [updated] = await tx.$queryRaw<Row[]>`
      UPDATE pipeline_projects p SET
             phase_id            = ${toPhaseId},
             rank                = ${rank},
             phase_changed_at    = CASE WHEN ${phaseChanged}::boolean THEN timezone('utc', now()) ELSE p.phase_changed_at END,
             phase_changed_by_id = CASE WHEN ${phaseChanged}::boolean THEN ${me} ELSE p.phase_changed_by_id END,
             move_gen            = ${phaseChanged ? gen : Number(row.move_gen)}::int,
             move_actor_id       = CASE WHEN ${phaseChanged}::boolean THEN ${netZero ? null : me}::text ELSE p.move_actor_id END,
             move_from_phase_id  = CASE WHEN ${phaseChanged}::boolean THEN ${fromPhaseId}::text ELSE p.move_from_phase_id END,
             move_started_at     = CASE WHEN ${phaseChanged && !sameGen}::boolean THEN timezone('utc', now()) ELSE p.move_started_at END,
             move_last_at        = CASE WHEN ${phaseChanged}::boolean THEN timezone('utc', now()) ELSE p.move_last_at END,
             due_soon_notified_for = CASE WHEN ${toTerminal}::boolean THEN NULL ELSE p.due_soon_notified_for END,
             overdue_notified_for  = CASE WHEN ${toTerminal}::boolean THEN NULL ELSE p.overdue_notified_for END,
             header_rev          = p.header_rev + 1,
             updated_at          = timezone('utc', now())
       WHERE p.id = ${projectId}
   RETURNING p.id, p.phase_id, p.title, p.rank, p.owner_id, p.start_date, p.due_date, p.member_count,
             ARRAY(SELECT pp.user_id FROM pipeline_participants pp
                    WHERE pp.project_id = p.id AND pp.role = 'MEMBER'
                    ORDER BY pp.created_at, pp.user_id LIMIT 3) AS preview`;

    if (phaseChanged) {
      await notifier.onMoved(tx, {
        projectId,
        projectTitle: String(row.title),
        actorId: me,
        actorName: actor.name,
        allow: allowList(actor.settings),
        gen,
        sameGeneration: sameGen,
        netZero,
        fromPhaseId,
        fromPhaseName: String(s2.from_name ?? ""),
        toPhaseId,
        toPhaseName: String(s2.phase_name ?? ""),
        prevPhaseId: curPhase,
        toTerminal,
        dueDate: day(row.due_date),
        email,
      });
    }
    return { card: cardFromRow(updated), placementAdjusted, changed: true };
  }, { retryOnce: true });
}

/**
 * The rare locked rebalance (spec §6 "Rebalance"): lock the target phase's live rows in
 * id order (a consistent lock order, fresh values once locked), recompute the order from
 * that read with the moving card inserted where `afterId` says, and rewrite every rank
 * with short evenly spaced keys. The UPDATE re-checks phase_id. Returns the card's rank.
 */
async function rebalancePhase(tx: PipelineTx, phaseId: string, projectId: string, afterId: string | null): Promise<string> {
  const locked = await tx.$queryRaw<Array<{ id: string; rank: string }>>`
    SELECT id, rank FROM pipeline_projects
     WHERE phase_id = ${phaseId} AND archived_at IS NULL AND deleted_at IS NULL
     ORDER BY id
       FOR UPDATE`;
  const others = locked
    .filter((r) => r.id !== projectId)
    .sort((x, y) => compareRank(x.rank, y.rank) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  let at = afterId === null ? 0 : others.findIndex((r) => r.id === afterId) + 1;
  if (afterId !== null && at === 0) at = others.length; // afterId gone → last
  const order = [...others.slice(0, at).map((r) => r.id), projectId, ...others.slice(at).map((r) => r.id)];
  const keys = nKeysBetween(null, null, order.length);
  const ids = order.filter((id) => id !== projectId);
  const ranks = order.map((id, i) => ({ id, rank: keys[i] })).filter((x) => x.id !== projectId).map((x) => x.rank);
  if (ids.length > 0) {
    await tx.$executeRaw`
      UPDATE pipeline_projects p
         SET rank = v.rank, header_rev = p.header_rev + 1, updated_at = timezone('utc', now())
        FROM unnest(${ids}::text[], ${ranks}::text[]) AS v(id, rank)
       WHERE p.id = v.id AND p.phase_id = ${phaseId} AND p.rank IS DISTINCT FROM v.rank`;
  }
  return keys[order.indexOf(projectId)];
}

// ── Routes #9–11: archive, unarchive, restore, delete, owner transfer (spec §4.5) ────

/**
 * Where an unarchived or restored card goes: its own phase if that is live, otherwise the
 * TOP of the first live phase (`phaseAdjusted`), so every live card sits in a live phase.
 */
async function relocationFor(tx: PipelineTx, row: Row): Promise<{ phaseId: string; rank: string; adjusted: boolean }> {
  const [r] = await tx.$queryRaw<Row[]>`
    WITH first AS (
      SELECT id FROM pipeline_phases WHERE archived_at IS NULL ORDER BY position, id LIMIT 1)
    SELECT (SELECT archived_at IS NOT NULL FROM pipeline_phases WHERE id = ${String(row.phase_id)}) AS phase_archived,
           (SELECT id FROM first) AS first_id,
           (SELECT p.rank FROM pipeline_projects p
             WHERE p.phase_id = (SELECT id FROM first) AND p.archived_at IS NULL AND p.deleted_at IS NULL
             ORDER BY p.rank COLLATE "C", p.id LIMIT 1) AS first_rank`;
  if (r.phase_archived !== true || !r.first_id) {
    return { phaseId: String(row.phase_id), rank: String(row.rank), adjusted: false };
  }
  let rank = keyBetween(null, (r.first_rank as string | null) ?? null);
  if (rankNeedsRebalance(rank)) rank = String(row.rank); // vanishingly rare; ties are allowed
  return { phaseId: String(r.first_id), rank, adjusted: true };
}

/** The card from an `UPDATE … RETURNING <card columns>` result. */
const firstCard = (rows: Row[]): PipelineCard => cardFromRow(rows[0]);

export async function archiveProject(actor: PipelineActor, projectId: string): Promise<PipelineArchiveResponse> {
  const me = actor.userId;
  const out = await pipelineWrite(async (tx) => {
    const row = await lockProject(tx, projectId, me);
    assertWritable(row, { allowArchived: true });
    const { isOwner, isAdmin } = await assertOwnerOrAdmin(tx, { actorId: me, ownerId: String(row.owner_id) });
    if (row.archived_at) return { card: (await readCard(tx, projectId))!, changed: false };
    const card = firstCard(
      await tx.$queryRaw<Row[]>`
        UPDATE pipeline_projects p SET
               archived_at = timezone('utc', now()), archived_by_id = ${me},
               archived_by_admin = ${!isOwner && isAdmin}::boolean,
               header_rev = p.header_rev + 1, updated_at = timezone('utc', now())
         WHERE p.id = ${projectId}
     RETURNING p.id, p.phase_id, p.title, p.rank, p.owner_id, p.start_date, p.due_date, p.member_count,
               ARRAY(SELECT pp.user_id FROM pipeline_participants pp
                      WHERE pp.project_id = p.id AND pp.role = 'MEMBER'
                      ORDER BY pp.created_at, pp.user_id LIMIT 3) AS preview`,
    );
    return { card, changed: true };
  });
  if (out.changed) await bumpBoard();
  return { card: out.card, phaseAdjusted: false };
}

export async function unarchiveProject(actor: PipelineActor, projectId: string): Promise<PipelineArchiveResponse> {
  const me = actor.userId;
  const out = await pipelineWrite(async (tx) => {
    const row = await lockProject(tx, projectId, me);
    assertWritable(row, { allowArchived: true });
    const { isAdmin } = await assertOwnerOrAdmin(tx, { actorId: me, ownerId: String(row.owner_id) });
    if (!row.archived_at) return { card: (await readCard(tx, projectId))!, adjusted: false, changed: false };
    if (row.archived_by_admin === true && !isAdmin) {
      throw new PipelineError(403, "REMOVED_BY_ADMIN", "An admin archived this project — ask an admin to unarchive it");
    }
    const to = await relocationFor(tx, row);
    const card = firstCard(
      await tx.$queryRaw<Row[]>`
        UPDATE pipeline_projects p SET
               archived_at = NULL, archived_by_id = NULL, archived_by_admin = false,
               phase_id = ${to.phaseId}, rank = ${to.rank},
               header_rev = p.header_rev + 1, updated_at = timezone('utc', now())
         WHERE p.id = ${projectId}
     RETURNING p.id, p.phase_id, p.title, p.rank, p.owner_id, p.start_date, p.due_date, p.member_count,
               ARRAY(SELECT pp.user_id FROM pipeline_participants pp
                      WHERE pp.project_id = p.id AND pp.role = 'MEMBER'
                      ORDER BY pp.created_at, pp.user_id LIMIT 3) AS preview`,
    );
    return { card, adjusted: to.adjusted, changed: true };
  });
  if (out.changed) await bumpBoard();
  return { card: out.card, phaseAdjusted: out.adjusted };
}

export async function restoreProject(actor: PipelineActor, projectId: string): Promise<PipelineArchiveResponse> {
  const me = actor.userId;
  const out = await pipelineWrite(async (tx) => {
    const row = await lockProject(tx, projectId, me);
    if (!row) throw new PipelineError(404, "PROJECT_NOT_FOUND", "This project doesn't exist");
    if (row.actor_active !== true) throw new PipelineError(403, "ACCOUNT_INACTIVE", "Your account is inactive");
    const { isAdmin } = await assertOwnerOrAdmin(tx, { actorId: me, ownerId: String(row.owner_id) });
    if (!row.deleted_at) return { card: (await readCard(tx, projectId))!, adjusted: false, changed: false };
    if (row.deleted_by_admin === true && !isAdmin) {
      throw new PipelineError(403, "REMOVED_BY_ADMIN", "An admin deleted this project — ask an admin to restore it");
    }
    const windowMs = PIPELINE_LIMITS.restoreWindowDays * 86_400_000;
    if (asDate(row.db_now)!.getTime() - asDate(row.deleted_at)!.getTime() >= windowMs) {
      throw new PipelineError(409, "RESTORE_WINDOW_PASSED", "Projects can be restored for 30 days after deletion");
    }
    const to = await relocationFor(tx, row);
    const card = firstCard(
      await tx.$queryRaw<Row[]>`
        UPDATE pipeline_projects p SET
               deleted_at = NULL, deleted_by_id = NULL, deleted_by_admin = false,
               phase_id = ${to.phaseId}, rank = ${to.rank},
               header_rev = p.header_rev + 1, updated_at = timezone('utc', now())
         WHERE p.id = ${projectId}
     RETURNING p.id, p.phase_id, p.title, p.rank, p.owner_id, p.start_date, p.due_date, p.member_count,
               ARRAY(SELECT pp.user_id FROM pipeline_participants pp
                      WHERE pp.project_id = p.id AND pp.role = 'MEMBER'
                      ORDER BY pp.created_at, pp.user_id LIMIT 3) AS preview`,
    );
    return { card, adjusted: to.adjusted, changed: true };
  });
  if (out.changed) await bumpBoard();
  return { card: out.card, phaseAdjusted: out.adjusted };
}

/** Soft delete (idempotent). The title must be retyped exactly (surrounding spaces ignored). */
export async function deleteProject(actor: PipelineActor, projectId: string, confirmTitle: string): Promise<{ deleted: true }> {
  const me = actor.userId;
  const changed = await pipelineWrite(async (tx) => {
    const row = await lockProject(tx, projectId, me);
    if (!row) throw new PipelineError(404, "PROJECT_NOT_FOUND", "This project doesn't exist");
    if (row.actor_active !== true) throw new PipelineError(403, "ACCOUNT_INACTIVE", "Your account is inactive");
    const { isOwner, isAdmin } = await assertOwnerOrAdmin(tx, { actorId: me, ownerId: String(row.owner_id) });
    if (row.deleted_at) return false;
    if (confirmTitle.trim() !== String(row.title)) {
      throw new PipelineError(409, "CONFIRM_MISMATCH", "Type the project's title exactly to delete it");
    }
    const parts = await tx.$queryRaw<Array<{ user_id: string }>>`
      SELECT user_id FROM pipeline_participants WHERE project_id = ${projectId}
       ORDER BY user_id LIMIT ${PIPELINE_LIMITS.participantsMax}`;
    await tx.$executeRaw`
      UPDATE pipeline_projects SET
             deleted_at = timezone('utc', now()), deleted_by_id = ${me},
             deleted_by_admin = ${!isOwner && isAdmin}::boolean,
             header_rev = header_rev + 1, updated_at = timezone('utc', now())
       WHERE id = ${projectId}`;
    await notifier.onProjectDeleted(tx, { projectId, actorId: me, participantIds: parts.map((p) => p.user_id) });
    return true;
  });
  if (changed) await bumpBoard();
  return { deleted: true };
}

/**
 * Owner transfer (+O). The target must be ACTIVE and pickable. In one transaction: upsert
 * the new owner's row as MEMBER with notify=true, then set owner_id and the exact
 * member_count. The old owner keeps a plain MEMBER row (and becomes removable).
 */
export async function transferOwner(actor: PipelineActor, projectId: string, targetId: string): Promise<{ header: PipelineHeader }> {
  const me = actor.userId;
  const notPickable = () => new PipelineError(409, "USER_NOT_PICKABLE", "That person can't own a project right now");
  const out = await pipelineWrite(async (tx) => {
    const row = await lockProject(tx, projectId, me);
    assertWritable(row);
    await assertOwnerOrAdmin(tx, { actorId: me, ownerId: String(row.owner_id) });
    if (String(row.owner_id) === targetId) return { header: headerFromRow(row), changed: false };
    if (!pickableByMode(actor.settings, targetId)) throw notPickable();
    const up = await tx.$queryRaw<Array<{ user_id: string }>>`
      INSERT INTO pipeline_participants (project_id, user_id, role, notify, created_at, updated_at)
      SELECT ${projectId}, u.id, 'MEMBER', true, timezone('utc', now()), timezone('utc', now())
        FROM users u
       WHERE u.id = ${targetId} AND u.status = 'ACTIVE' AND u.deleted_at IS NULL
      ON CONFLICT (project_id, user_id) DO UPDATE
         SET role = 'MEMBER', notify = true, updated_at = timezone('utc', now())
      RETURNING user_id`;
    if (up.length === 0) throw notPickable();
    const [updated] = await tx.$queryRaw<Row[]>`
      UPDATE pipeline_projects SET
             owner_id = ${targetId},
             member_count = (SELECT count(*)::int FROM pipeline_participants
                              WHERE project_id = ${projectId} AND role = 'MEMBER'),
             header_rev = header_rev + 1, updated_at = timezone('utc', now())
       WHERE id = ${projectId}
   RETURNING *`;
    return { header: headerFromRow(updated), changed: true };
  });
  if (out.changed) await bumpBoard();
  return { header: out.header };
}
