/**
 * The participant mutation path (spec §4.6, §6 "Participant mutation path"): add members,
 * remove / leave, follow / unfollow. PR 8's auto-follow on send reuses recountMembers.
 *
 * Every mutation: lock the project row (statement 1, which also re-checks the actor), lock
 * or upsert participant rows in user_id order, then recount `member_count` exactly
 * (`count(*)::int` of MEMBER rows, inside the same transaction — never a ±1 that could
 * drift under races) and bump `header_rev`. The board is bumped after COMMIT only when
 * `member_count` changed. A call that changes nothing writes nothing (idempotent).
 *
 * Rules (§4.6):
 *   - anyone may add; an add creates or PROMOTES a FOLLOWER to MEMBER and never touches
 *     `notify` (only the user changes that, via follow);
 *   - removing someone else: the owner, an admin (fresh DB check), or the adder within
 *     10 minutes of their add. Never-engaged → row deleted; engaged → demoted to FOLLOWER
 *     (their notify and read state kept);
 *   - leave deletes your own row; nobody can remove or leave the OWNER (transfer first);
 *   - follow/unfollow is self-only.
 */
import {
  PIPELINE_LIMITS,
  type PipelineAddMembersResponse,
  type PipelineFollowResponse,
  type PipelineParticipantRole,
  type PipelineRemoveMemberResponse,
} from "@dashmani/shared";
import type { PipelineTx } from "./db";
import { pipelineWrite } from "./tx";
import { PipelineError } from "./errors";
import { bumpBoard } from "./board";
import { notifier } from "./notifier";
import { dropLeaverRows } from "./notify";
import { day, participantFromRow } from "./wire";
import { isPipelineAdmin } from "../../middleware/pipeline-gates";
import { allowList, assertWritable, lockProject, pickableByMode, type PipelineActor } from "./projects.service";

type Row = Record<string, unknown>;

/**
 * Set `member_count` to the exact MEMBER count and bump `header_rev` (one statement, after
 * the participant DML in the same transaction, so it sees that DML).
 * @returns the new and the previous member_count.
 */
export async function recountMembers(
  tx: PipelineTx,
  projectId: string,
): Promise<{ memberCount: number; headerRev: number; changedCount: boolean }> {
  const [r] = await tx.$queryRaw<Array<{ member_count: number; header_rev: number; old_count: number }>>`
    UPDATE pipeline_projects p
       SET member_count = (SELECT count(*)::int FROM pipeline_participants
                            WHERE project_id = ${projectId} AND role = 'MEMBER'),
           header_rev = p.header_rev + 1,
           updated_at = timezone('utc', now())
      FROM (SELECT member_count AS old_count FROM pipeline_projects WHERE id = ${projectId}) old
     WHERE p.id = ${projectId}
 RETURNING p.member_count, p.header_rev, old.old_count`;
  return { memberCount: r.member_count, headerRev: r.header_rev, changedCount: r.member_count !== r.old_count };
}

async function listParticipants(tx: PipelineTx, projectId: string, ownerId: string) {
  const rows = await tx.$queryRaw<Row[]>`
    SELECT user_id, role, member_added_by_id, member_added_at, created_at FROM pipeline_participants
     WHERE project_id = ${projectId}
     ORDER BY created_at, user_id
     LIMIT ${PIPELINE_LIMITS.participantsMax}`;
  return rows.map((r) => participantFromRow(r, ownerId));
}

// ── Route #12: add members ───────────────────────────────────────────────────────────

export async function addMembers(actor: PipelineActor, projectId: string, userIds: string[]): Promise<PipelineAddMembersResponse> {
  const me = actor.userId;
  // Sorted: the upsert then locks participant rows in user_id order (the global lock order).
  const ids = [...new Set(userIds)].sort();
  if (ids.some((id) => !pickableByMode(actor.settings, id))) {
    throw new PipelineError(409, "MEMBER_NOT_PICKABLE", "Someone you picked can't be added right now");
  }
  const out = await pipelineWrite(async (tx) => {
    const row = await lockProject(tx, projectId, me);
    assertWritable(row);
    const ownerId = String(row.owner_id);

    const [s2] = await tx.$queryRaw<Row[]>`
      SELECT (SELECT count(*)::int FROM pipeline_participants WHERE project_id = ${projectId}) AS total,
             (SELECT count(*)::int FROM pipeline_participants
               WHERE project_id = ${projectId} AND user_id = ANY(${ids}::text[])) AS existing,
             (SELECT count(*)::int FROM users
               WHERE id = ANY(${ids}::text[]) AND status = 'ACTIVE' AND deleted_at IS NULL) AS active,
             (SELECT name FROM pipeline_phases WHERE id = ${String(row.phase_id)}) AS phase_name`;
    if (Number(s2.active) !== ids.length) {
      throw new PipelineError(409, "MEMBER_NOT_PICKABLE", "Someone you picked can't be added right now");
    }
    if (Number(s2.total) + ids.length - Number(s2.existing) > PIPELINE_LIMITS.participantsMax) {
      throw new PipelineError(409, "MEMBER_LIMIT", `A project can have at most ${PIPELINE_LIMITS.participantsMax} people`);
    }

    // New rows become MEMBER; an existing FOLLOWER is promoted; a MEMBER is untouched.
    // `notify` is never in the SET list. created_at is offset 1 ms per row for a stable order.
    const added = await tx.$queryRaw<Array<{ user_id: string }>>`
      INSERT INTO pipeline_participants
             (project_id, user_id, role, notify, member_added_by_id, member_added_at, created_at, updated_at)
      SELECT ${projectId}, v.uid, 'MEMBER', true, ${me}, timezone('utc', now()),
             timezone('utc', now()) + ((v.ord - 1) * interval '1 millisecond'), timezone('utc', now())
        FROM unnest(${ids}::text[]) WITH ORDINALITY AS v(uid, ord)
      ON CONFLICT (project_id, user_id) DO UPDATE
         SET role = 'MEMBER',
             member_added_by_id = EXCLUDED.member_added_by_id,
             member_added_at = EXCLUDED.member_added_at,
             updated_at = EXCLUDED.updated_at
       WHERE pipeline_participants.role = 'FOLLOWER'
      RETURNING user_id`;
    const addedIds = added.map((a) => a.user_id).sort();
    let changedCount = false;
    if (addedIds.length > 0) {
      ({ changedCount } = await recountMembers(tx, projectId));
      await notifier.onMembersAdded(tx, {
        projectId,
        projectTitle: String(row.title),
        actorId: me,
        actorName: actor.name,
        allow: allowList(actor.settings),
        phaseName: String(s2.phase_name ?? ""),
        dueDate: day(row.due_date),
        addedUserIds: addedIds.filter((id) => id !== me),
      });
    }
    return { participants: await listParticipants(tx, projectId, ownerId), added: addedIds, changedCount };
  });
  if (out.changedCount) await bumpBoard();
  return { participants: out.participants, added: out.added };
}

// ── Route #13: remove / leave ────────────────────────────────────────────────────────

export async function removeMember(actor: PipelineActor, projectId: string, targetId: string): Promise<PipelineRemoveMemberResponse> {
  const me = actor.userId;
  // retryOnce: a deletion writes several of the target's notification rows (dropLeaverRows),
  // which a concurrent ack or "Mark all read" may hold — a lost lock race (55P03 / 40P01) is
  // retried once, like the due edit and the move. Safe: the transaction rolled back whole,
  // and the second attempt re-reads the participant row (one already gone is "none").
  const out = await pipelineWrite(async (tx) => {
    const row = await lockProject(tx, projectId, me);
    assertWritable(row);
    const ownerId = String(row.owner_id);
    if (targetId === ownerId) {
      throw new PipelineError(409, "OWNER_CANNOT_BE_REMOVED", "Transfer ownership before removing the owner");
    }
    const [target] = await tx.$queryRaw<Row[]>`
      SELECT role, engaged_at, member_added_by_id,
             (member_added_at > timezone('utc', now()) - interval '10 minutes') AS within_undo
        FROM pipeline_participants
       WHERE project_id = ${projectId} AND user_id = ${targetId}
         FOR UPDATE`;
    if (!target) return { result: "none" as const, changedCount: false };

    const leaving = targetId === me;
    if (!leaving) {
      const adderUndo = target.role === "MEMBER" && target.member_added_by_id === me && target.within_undo === true;
      const allowed = me === ownerId || adderUndo || (await isPipelineAdmin(tx, me));
      if (!allowed) {
        throw new PipelineError(403, "CANNOT_REMOVE_MEMBER", "Only the owner, an admin, or whoever just added them can remove someone");
      }
    }

    let result: "demoted" | "removed" | "none";
    if (leaving || !target.engaged_at) {
      // Never matches the owner (belt and braces: the owner check above already refused).
      const n = await tx.$executeRaw`
        DELETE FROM pipeline_participants
         WHERE project_id = ${projectId} AND user_id = ${targetId} AND user_id <> ${ownerId}`;
      result = n > 0 ? "removed" : "none";
      // Their grouped row and the current date's due rows go too, and their "added" row loses
      // its date (no later redaction, withdrawal or D4 rewrite can reach a non-participant).
      if (n > 0) {
        const [ph] = await tx.$queryRaw<Row[]>`SELECT name FROM pipeline_phases WHERE id = ${String(row.phase_id)}`;
        await dropLeaverRows(tx, projectId, targetId, day(row.due_date), String(ph?.name ?? ""));
      }
    } else if (target.role === "MEMBER") {
      const n = await tx.$executeRaw`
        UPDATE pipeline_participants
           SET role = 'FOLLOWER', updated_at = timezone('utc', now())
         WHERE project_id = ${projectId} AND user_id = ${targetId} AND user_id <> ${ownerId} AND role = 'MEMBER'`;
      result = n > 0 ? "demoted" : "none";
    } else {
      result = "none"; // an engaged FOLLOWER stays; they may unfollow themselves
    }
    if (result === "none") return { result, changedCount: false };
    const { changedCount } = await recountMembers(tx, projectId);
    return { result, changedCount };
  }, { retryOnce: true });
  if (out.changedCount) await bumpBoard();
  return { result: out.result };
}

// ── Route #14: follow / unfollow (self only) ─────────────────────────────────────────

export async function setFollow(actor: PipelineActor, projectId: string, following: boolean): Promise<PipelineFollowResponse> {
  const me = actor.userId;
  return pipelineWrite(async (tx) => {
    const row = await lockProject(tx, projectId, me);
    assertWritable(row);
    const [mine] = await tx.$queryRaw<Row[]>`
      SELECT role, notify, engaged_at FROM pipeline_participants
       WHERE project_id = ${projectId} AND user_id = ${me}
         FOR UPDATE`;
    if (!mine) {
      if (!following) return { role: null, notify: false };
      await tx.$executeRaw`
        INSERT INTO pipeline_participants (project_id, user_id, role, notify, engaged_at, created_at, updated_at)
        VALUES (${projectId}, ${me}, 'FOLLOWER', true, timezone('utc', now()), timezone('utc', now()), timezone('utc', now()))`;
      await recountMembers(tx, projectId);
      return { role: "FOLLOWER", notify: true };
    }
    const role = String(mine.role) as PipelineParticipantRole;
    const needs = following ? mine.notify !== true || !mine.engaged_at : mine.notify === true;
    if (!needs) return { role, notify: mine.notify === true };
    // An explicit follow counts as engagement (so a later removal demotes instead of deleting).
    await tx.$executeRaw`
      UPDATE pipeline_participants
         SET notify = ${following}::boolean,
             engaged_at = CASE WHEN ${following}::boolean THEN COALESCE(engaged_at, timezone('utc', now())) ELSE engaged_at END,
             updated_at = timezone('utc', now())
       WHERE project_id = ${projectId} AND user_id = ${me}`;
    await recountMembers(tx, projectId);
    return { role, notify: following };
  });
}
