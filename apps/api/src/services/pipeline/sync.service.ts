/**
 * Read state (route #21) and the consolidated sync (route #3) — spec §5.2, §5.4.
 *
 * THE ACK (A1, §5.4) is ONE autocommit statement: it advances my `last_read_seq`
 * monotonically (never past the project's `last_message_seq`) and stamps `seen_at` —
 * or NULLs it on leave, so the next message is not suppressed as "being read". It also
 * re-checks that the actor is ACTIVE in SQL (§4.3). PR 9 appends the notification
 * clearing to this same statement.
 */
import { Prisma, type PipelineDbClient } from "./db";
import { pipelineWriteStatement } from "./tx";

const NOW = Prisma.sql`timezone('utc', now())`;

/**
 * A1. Returns my new `last_read_seq`, or null when I have no participant row (the
 * statement then changes nothing) or the project is deleted.
 */
export async function runAck(
  db: Pick<PipelineDbClient, "$queryRaw">,
  a: { projectId: string; userId: string; seq: number; leaving: boolean },
): Promise<number | null> {
  const rows = await db.$queryRaw<Array<{ last_read_seq: number }>>`
    UPDATE pipeline_participants pp
       SET last_read_seq = GREATEST(pp.last_read_seq, LEAST(${a.seq}::int, p.last_message_seq)),
           seen_at = CASE WHEN ${a.leaving}::boolean THEN NULL ELSE ${NOW} END,
           updated_at = ${NOW}
      FROM pipeline_projects p
     WHERE p.id = pp.project_id AND pp.project_id = ${a.projectId} AND pp.user_id = ${a.userId}
       AND p.deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM users u
                    WHERE u.id = ${a.userId} AND u.status = 'ACTIVE' AND u.deleted_at IS NULL)
 RETURNING pp.last_read_seq`;
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
