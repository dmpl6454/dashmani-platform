/**
 * Read state (route #21) and the consolidated sync (route #3) — spec §5.2, §5.4.
 *
 * SYNC = one bulkhead slot, one connection, every statement autocommit:
 *   R1  ONE read statement, so every part shares ONE snapshot: the board v, my `mine`
 *       overlay (≤ 500 live projects, unread = last_message_seq − last_read_seq), and for
 *       the open project its head, the delta (rev > cursor, ≤ limit+1 rows through the
 *       unique (project_id, rev) index), my participant row, and — only when header_rev
 *       moved — the header and ≤ 200 projected participants. The returned cursor is the
 *       limit-th row's rev when there is more, else the head's thread_rev read in the SAME
 *       statement: a message and its thread_rev bump commit together, so no snapshot can
 *       contain one without the other and no poller ever skips a message.
 *   A1  the ack (below), only when it would change something.
 *   The board snapshot, when the client's v differs, is fetched AFTER the slot is
 *   released (the snapshot builder takes its own slot; never nest).
 *
 * THE ACK (A1, §5.4) is ONE autocommit statement: it advances my `last_read_seq`
 * monotonically (never past the project's `last_message_seq`) and stamps `seen_at` —
 * or NULLs it on leave, so the next message is not suppressed as "being read". It also
 * re-checks that the actor is ACTIVE in SQL (§4.3). The same statement marks my
 * notifications read by primary key (ackStatement).
 */
import { createHash } from "crypto";
import type {
  PipelineBoardSnapshot,
  PipelineHeader,
  PipelineMe,
  PipelineMineEntry,
  PipelineParticipant,
  PipelineParticipantRole,
  PipelineSyncProject,
  PipelineSyncRequest,
  PipelineSyncResponse,
} from "@dashmani/shared";
import { Prisma, type PipelineDbClient } from "./db";
import { pipelineRead, pipelineWriteStatement } from "./tx";
import { MESSAGE_COLUMNS, isoUtc, toWireMessage, type MessageRow, type PipelineActor } from "./messages.service";
import { warnThrottled } from "../../utils/throttled-warn";
import { plnId, plnIdSql } from "./notify";
import { pipelineStats } from "./stats";

const NOW = Prisma.sql`timezone('utc', now())`;

/** How many earlier move generations a project view still clears (§5.4). */
const MOVE_GENS_CLEARED = 5;

export interface AckInput {
  projectId: string;
  userId: string;
  seq: number;
  leaving: boolean;
  /** Rendered message ids that mention me or reply to my message (§5.4), ≤ 50. */
  seen?: readonly string[];
}

/**
 * A1 as ONE autocommit statement (spec §5.4): advance my read marker and stamp or clear
 * `seen_at`, then mark notifications read — by PRIMARY KEY only:
 *   - project-level ids (grouped, added, the current move generation and the 4 before it,
 *     due-soon / overdue for the current due date, computed in SQL from the locked-free
 *     project row), the grouped one only up to my new marker (or
 *     LEAST(ack.seq, last_message_seq) when I have no participant row);
 *   - `mention:<mid>:<me>` and `reply:<mid>` for each seen id — the ONLY way those clear.
 * ≤ ~110 PK probes; no scan, no new index. `prefix` = "EXPLAIN" for the plan test.
 */
export function ackStatement(a: AckInput, prefix: "" | "EXPLAIN" = ""): Prisma.Sql {
  const pid = a.projectId;
  const me = a.userId;
  const gens = Array.from({ length: MOVE_GENS_CLEARED }, (_, i) =>
    plnIdSql("moved", pid, me, Prisma.sql`(p.move_gen - ${i}::int)::text`),
  );
  const due = Prisma.sql`to_char(p.due_date, 'YYYY-MM-DD')`;
  // The grouped row is the only project-level row with a `seq`: it clears only up to my
  // new marker. One `id = ANY(...)` over ≤ ~110 primary keys keeps the plan a PK probe.
  const groupedId = plnId("messages", pid, me);
  const projectIds = Prisma.join([
    Prisma.sql`${groupedId}::text`,
    plnIdSql("added", pid, me),
    ...gens,
    plnIdSql("due_soon", pid, me, due),
    plnIdSql("overdue", pid, me, due),
  ]);
  const seenIds = [...new Set(a.seen ?? [])].flatMap((mid) => [plnId("mention", mid, me), plnId("reply", mid)]);
  return Prisma.sql`${prefix === "EXPLAIN" ? Prisma.sql`EXPLAIN` : Prisma.empty}
    WITH proj AS (
      SELECT p.id, p.last_message_seq, ARRAY[${projectIds}] AS ids
        FROM pipeline_projects p
       WHERE p.id = ${pid} AND p.deleted_at IS NULL
    ), adv AS (
      UPDATE pipeline_participants pp
         SET last_read_seq = GREATEST(pp.last_read_seq, LEAST(${a.seq}::int, p.last_message_seq)),
             seen_at = CASE WHEN ${a.leaving}::boolean THEN NULL ELSE ${NOW} END,
             updated_at = ${NOW}
        FROM proj p
       WHERE pp.project_id = p.id AND pp.user_id = ${me}
         AND EXISTS (SELECT 1 FROM users u
                      WHERE u.id = ${me} AND u.status = 'ACTIVE' AND u.deleted_at IS NULL)
   RETURNING pp.last_read_seq
    ), clr AS (
      UPDATE notifications n SET read = true
       WHERE n.id = ANY((SELECT ids FROM proj)::text[] || ${seenIds}::text[])
         AND n.user_id = ${me} AND n.read = false
         AND ( n.id <> ${groupedId}
               OR n.metadata->>'seq' IS NULL
               OR (n.metadata->>'seq')::int <= COALESCE(
                    (SELECT last_read_seq FROM adv),
                    (SELECT LEAST(${a.seq}::int, last_message_seq) FROM proj)) )
   RETURNING 1
    )
    SELECT (SELECT last_read_seq FROM adv) AS last_read_seq, (SELECT count(*)::int FROM clr) AS cleared`;
}

/**
 * A1. Returns my new `last_read_seq`, or null when I have no participant row (only
 * `seen` rows can then clear) or the project is deleted.
 */
export async function runAck(db: Pick<PipelineDbClient, "$queryRaw">, a: AckInput): Promise<number | null> {
  const rows = await db.$queryRaw<Array<{ last_read_seq: number | null }>>(ackStatement(a));
  return rows[0]?.last_read_seq ?? null;
}

/**
 * Route #21: the keepalive read marker (sent on leave or when the tab hides). A
 * non-participant has no read state: `lastReadSeq` is 0 and nothing is written.
 */
export async function markRead(
  userId: string,
  projectId: string,
  seq: number,
  leaving: boolean,
): Promise<{ lastReadSeq: number }> {
  const lastReadSeq = await pipelineWriteStatement((db) => runAck(db, { projectId, userId, seq, leaving }));
  return { lastReadSeq: lastReadSeq ?? 0 };
}

// ── Route #3: sync ───────────────────────────────────────────────────────────────────

/** Delta rows per sync (spec §5.2: 50, fetched as LIMIT 51 to detect hasMore). */
const DEFAULT_DELTA_LIMIT = 50;
let deltaLimit = DEFAULT_DELTA_LIMIT;

/** Tests only: shrink the delta page to prove hasMore chaining; null restores 50. */
export function __setSyncDeltaLimitForTests(n: number | null): void {
  deltaLimit = n ?? DEFAULT_DELTA_LIMIT;
}

/** The overlay is capped (spec §5.2); the accepted per-user bound is documented in §2. */
const MINE_LIMIT = 500;
/** Re-stamp seen_at at most this often while nothing else changes (§5.2 A1). */
const SEEN_REFRESH_MS = 30_000;

/**
 * The board snapshot builder (route #6 / §5.3). It lands with the project routes (PR 7,
 * board.ts `getBoardSnapshot`), which register it here with setBoardSnapshotProvider.
 * ⚠️ Until one is registered a board-mounted client gets `board: null` and its OWN `v`
 * back, so it keeps asking — never a `v` that no snapshot it holds carries.
 */
export type BoardSnapshotProvider = (v: number) => Promise<PipelineBoardSnapshot>;
let boardSnapshotProvider: BoardSnapshotProvider | null = null;

export function setBoardSnapshotProvider(p: BoardSnapshotProvider | null): void {
  boardSnapshotProvider = p;
}

type JsonTs = string | null;

interface R1Row {
  v: number | null;
  mine: PipelineMineEntry[];
  head?: { threadRev: number; headerRev: number; lastMessageSeq: number; archived: boolean; deleted: boolean } | null;
  delta?: MessageRow[];
  me_row?: { lastReadSeq: number; seenAt: JsonTs; role: PipelineParticipantRole; notify: boolean } | null;
  header?: (Omit<PipelineHeader, "lastMessageAt" | "phaseChangedAt" | "archivedAt" | "deletedAt" | "createdAt" | "updatedAt"> & {
    lastMessageAt: JsonTs;
    phaseChangedAt: JsonTs;
    archivedAt: JsonTs;
    deletedAt: JsonTs;
    createdAt: string;
    updatedAt: string;
  }) | null;
  participants?: Array<{ userId: string; role: PipelineParticipantRole; memberAddedById: string | null; createdAt: string }>;
}

function projectPartSql(p: NonNullable<PipelineSyncRequest["project"]>, me: string, limit: number) {
  const live = Prisma.sql`EXISTS (SELECT 1 FROM pipeline_projects h WHERE h.id = ${p.id} AND h.deleted_at IS NULL)`;
  const headerMoved = Prisma.sql`EXISTS (SELECT 1 FROM pipeline_projects h
                                          WHERE h.id = ${p.id} AND h.deleted_at IS NULL AND h.header_rev <> ${p.hv}::int)`;
  return Prisma.sql`,
    (SELECT json_build_object('threadRev', h.thread_rev, 'headerRev', h.header_rev,
                              'lastMessageSeq', h.last_message_seq,
                              'archived', h.archived_at IS NOT NULL, 'deleted', h.deleted_at IS NOT NULL)
       FROM pipeline_projects h WHERE h.id = ${p.id}) AS head,
    (SELECT COALESCE(json_agg(d ORDER BY d.rev), '[]'::json) FROM (
        SELECT ${MESSAGE_COLUMNS} FROM pipeline_messages m
         WHERE m.project_id = ${p.id} AND m.rev > ${p.rev}::int AND ${live}
         ORDER BY m.rev
         LIMIT ${limit + 1}::int) d) AS delta,
    (SELECT json_build_object('lastReadSeq', pp.last_read_seq, 'seenAt', pp.seen_at,
                              'role', pp.role, 'notify', pp.notify)
       FROM pipeline_participants pp WHERE pp.project_id = ${p.id} AND pp.user_id = ${me}) AS me_row,
    (SELECT json_build_object(
              'id', h.id, 'title', h.title, 'description', h.description, 'phaseId', h.phase_id,
              'rank', h.rank, 'ownerId', h.owner_id, 'createdById', h.created_by_id,
              'startDate', h.start_date, 'dueDate', h.due_date, 'memberCount', h.member_count,
              'headerRev', h.header_rev, 'threadRev', h.thread_rev, 'lastMessageSeq', h.last_message_seq,
              'lastMessageAt', h.last_message_at, 'phaseChangedAt', h.phase_changed_at,
              'phaseChangedById', h.phase_changed_by_id, 'archivedAt', h.archived_at,
              'archivedById', h.archived_by_id, 'archivedByAdmin', h.archived_by_admin,
              'deletedAt', h.deleted_at, 'deletedById', h.deleted_by_id, 'deletedByAdmin', h.deleted_by_admin,
              'createdAt', h.created_at, 'updatedAt', h.updated_at)
       FROM pipeline_projects h
      WHERE h.id = ${p.id} AND h.deleted_at IS NULL AND h.header_rev <> ${p.hv}::int) AS header,
    (SELECT COALESCE(json_agg(json_build_object('userId', x.user_id, 'role', x.role,
                                                'memberAddedById', x.member_added_by_id, 'createdAt', x.created_at)
                              ORDER BY x.created_at, x.user_id), '[]'::json)
       FROM (SELECT pp.user_id, pp.role, pp.member_added_by_id, pp.created_at
               FROM pipeline_participants pp
              WHERE pp.project_id = ${p.id} AND ${headerMoved}
              ORDER BY pp.created_at, pp.user_id
              LIMIT 200) x) AS participants`;
}

/** A stable, short hash of the overlay (the client echoes it back as `mineH`). */
export function mineHash(mine: PipelineMineEntry[]): string {
  return createHash("sha1").update(JSON.stringify(mine)).digest("base64url");
}

function toHeader(h: NonNullable<R1Row["header"]>): PipelineHeader {
  return {
    ...h,
    lastMessageAt: isoUtc(h.lastMessageAt),
    phaseChangedAt: isoUtc(h.phaseChangedAt),
    archivedAt: isoUtc(h.archivedAt),
    deletedAt: isoUtc(h.deletedAt),
    createdAt: isoUtc(h.createdAt)!,
    updatedAt: isoUtc(h.updatedAt)!,
  };
}

/** A1 only when it would change something (spec §5.2). */
function shouldAck(
  ack: NonNullable<NonNullable<PipelineSyncRequest["project"]>["ack"]>,
  meRow: R1Row["me_row"],
  now: number,
): boolean {
  const seenCount = ack.seen?.length ?? 0;
  // Without a participant row there is no read state to move; clearing mention/reply
  // rows through `seen` is the only thing an ack can then do.
  if (!meRow) return seenCount > 0;
  if (ack.seq > meRow.lastReadSeq) return true;
  if (seenCount > 0 || ack.open === true || ack.leaving === true) return true;
  const seenAt = meRow.seenAt ? Date.parse(isoUtc(meRow.seenAt)!) : NaN;
  return !Number.isFinite(seenAt) || now - seenAt > SEEN_REFRESH_MS;
}

export async function syncPipeline(actor: PipelineActor, body: PipelineSyncRequest): Promise<PipelineSyncResponse> {
  const me = actor.userId;
  const p = body.project;
  const limit = deltaLimit;

  const { row, lastReadSeqAfterAck } = await pipelineRead(async (db) => {
    const holdStart = performance.now();
    const rows = await db.$queryRaw<R1Row[]>`
      WITH mine AS (
        SELECT pp.project_id, pp.role, pp.notify,
               GREATEST(pr.last_message_seq - pp.last_read_seq, 0)::int AS unread
          FROM pipeline_participants pp
          JOIN pipeline_projects pr ON pr.id = pp.project_id
         WHERE pp.user_id = ${me} AND pr.archived_at IS NULL AND pr.deleted_at IS NULL
         ORDER BY pp.project_id
         LIMIT ${MINE_LIMIT}::int)
      SELECT (SELECT bs.seq FROM pipeline_board_state bs WHERE bs.id = 1) AS v,
             (SELECT COALESCE(json_agg(json_build_object('projectId', mine.project_id, 'role', mine.role,
                                                         'notify', mine.notify, 'unread', mine.unread)
                                       ORDER BY mine.project_id), '[]'::json)
                FROM mine) AS mine
             ${p ? projectPartSql(p, me, limit) : Prisma.empty}`;
    const r1 = rows[0];
    let acked: number | null = null;
    const liveHead = r1.head && !r1.head.deleted ? r1.head : null;
    if (p?.ack && liveHead && shouldAck(p.ack, r1.me_row, Date.now())) {
      acked = await runAck(db, {
        projectId: p.id,
        userId: me,
        seq: p.ack.seq,
        leaving: p.ack.leaving === true,
        seen: p.ack.seen ?? [],
      });
    }
    pipelineStats.syncHold(me, performance.now() - holdStart);
    return { row: r1, lastReadSeqAfterAck: acked };
  });

  const boardV = row.v ?? 0;
  const mine = row.mine ?? [];
  const hash = mineHash(mine);

  let project: PipelineSyncProject | null = null;
  if (p) {
    const head = row.head;
    const lastReadSeq = lastReadSeqAfterAck ?? row.me_row?.lastReadSeq ?? 0;
    if (!head || head.deleted) {
      project = {
        id: p.id,
        status: "deleted",
        rev: p.rev,
        hv: p.hv,
        header: null,
        participants: null,
        messages: [],
        hasMore: false,
        lastReadSeq,
      };
    } else {
      const delta = row.delta ?? [];
      const hasMore = delta.length > limit;
      const page = delta.slice(0, limit);
      const header = row.header ? toHeader(row.header) : null;
      const participants: PipelineParticipant[] | null = header
        ? (row.participants ?? []).map((x) => ({
            userId: x.userId,
            role: x.role,
            isOwner: x.userId === header.ownerId,
            memberAddedById: x.memberAddedById,
            createdAt: isoUtc(x.createdAt)!,
          }))
        : null;
      project = {
        id: p.id,
        status: head.archived ? "archived" : "ok",
        rev: hasMore ? page[page.length - 1].rev : head.threadRev,
        hv: head.headerRev,
        header,
        participants,
        messages: page.map((m) => toWireMessage(m, actor)),
        hasMore,
        lastReadSeq,
      };
      if (header) {
        const meOut: PipelineMe = row.me_row
          ? { role: row.me_row.role, notify: row.me_row.notify, lastReadSeq }
          : { role: null, notify: false, lastReadSeq: 0 };
        project.me = meOut;
      }
    }
  }

  // The board, outside the slot. A failure keeps the client's v so it asks again.
  let v = boardV;
  let board: PipelineBoardSnapshot | null = null;
  if (body.board && body.board.v !== boardV) {
    if (boardSnapshotProvider) {
      try {
        board = await boardSnapshotProvider(boardV);
        v = board.v;
      } catch (err) {
        warnThrottled("sync-board", `[pipeline] sync: board snapshot unavailable — ${String(err)}`);
        v = body.board.v;
      }
    } else {
      v = body.board.v;
    }
  }

  const { settings } = actor;
  return {
    v,
    board,
    mineH: hash,
    mine: body.mineH === hash ? null : mine,
    project,
    pollMs: p ? settings.pollMs.project : settings.pollMs.board,
    reload: body.clientBuild < settings.minClientBuild,
  };
}
