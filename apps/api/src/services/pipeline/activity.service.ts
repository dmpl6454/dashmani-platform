/**
 * A project's activity timeline (2026-11-24). Wording and wire shape:
 * packages/shared/src/pipeline/activity.ts; table: pipeline_activity (scripts/pipeline-docs-ddl.sql).
 *
 *   - Separate from the chat: deleting or editing messages never touches it.
 *   - Written INSIDE the action's own transaction, after its lock, but behind a SAVEPOINT: if the
 *     insert fails (table missing on an old database, anything else) the savepoint is rolled back
 *     and the action itself still commits. ⚠️ Never let an activity write fail a move, a document,
 *     a review or a page — the timeline is a record, not a gate.
 *   - A quick run of moves by one person (≤ 2 minutes apart) is ONE row: the destination is
 *     updated, and a run that ends where it started removes the row (like the "moved" bell rows).
 *   - Reads: the newest 100 rows of one project (index (project_id, created_at)); a project older
 *     than the table gets a synthetic "created" row from its own created_at.
 *
 * ⚠️ Pipeline pool only. No FK into users; actor names come from the pipeline directory.
 */
import { randomUUID } from "crypto";
import { PIPELINE_ACTIVITY_LIST_MAX, activityText, type PipelineActivityDto, type PipelineActivityKind } from "@dashmani/shared";
import { Prisma, type PipelineTx } from "./db";
import { pipelineRead } from "./tx";
import { PipelineError } from "./errors";
import { ts } from "./wire";
import type { PipelineDirectory } from "./access";

type Row = Record<string, unknown>;

/** Moves by the same person within this window collapse into one row. */
export const ACTIVITY_MOVE_MERGE_MS = 2 * 60_000;

/** Runs `fn` behind a savepoint; any failure is rolled back to it and logged, never thrown. */
async function bestEffort(tx: PipelineTx, what: string, fn: () => Promise<unknown>): Promise<void> {
  await tx.$executeRawUnsafe("SAVEPOINT pl_activity");
  try {
    await fn();
    await tx.$executeRawUnsafe("RELEASE SAVEPOINT pl_activity");
  } catch (err) {
    await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT pl_activity");
    console.warn(`[pipeline-activity] ${what} not recorded: ${(err as Error)?.message?.slice(0, 200) ?? err}`);
  }
}

export async function recordActivity(
  tx: PipelineTx,
  a: { projectId: string; kind: PipelineActivityKind; actorId: string | null; data?: Record<string, unknown> },
): Promise<void> {
  await bestEffort(tx, a.kind, () =>
    tx.$executeRaw`
      INSERT INTO pipeline_activity (id, project_id, kind, actor_id, data, created_at)
      VALUES (${randomUUID()}, ${a.projectId}, ${a.kind}, ${a.actorId}, ${JSON.stringify(a.data ?? {})}::jsonb, timezone('utc', now()))`,
  );
}

/** A phase change; merged with the same person's move of the last 2 minutes. */
export async function recordMove(
  tx: PipelineTx,
  m: { projectId: string; actorId: string; fromId: string; fromName: string | null; toId: string; toName: string },
): Promise<void> {
  await bestEffort(tx, "moved", async () => {
    const [last] = await tx.$queryRaw<Row[]>`
      SELECT id, kind, actor_id, data, created_at > timezone('utc', now()) - (${ACTIVITY_MOVE_MERGE_MS}::int * interval '1 millisecond') AS recent
        FROM pipeline_activity WHERE project_id = ${m.projectId}
       ORDER BY created_at DESC, id DESC LIMIT 1`;
    const prev = (last?.data ?? {}) as Record<string, unknown>;
    if (last && last.kind === "moved" && last.actor_id === m.actorId && last.recent === true) {
      if (prev.fromId === m.toId) {
        await tx.$executeRaw`DELETE FROM pipeline_activity WHERE id = ${String(last.id)}`;
      } else {
        const data = { ...prev, toId: m.toId, to: m.toName };
        await tx.$executeRaw`
          UPDATE pipeline_activity SET data = ${JSON.stringify(data)}::jsonb, created_at = timezone('utc', now())
           WHERE id = ${String(last.id)}`;
      }
      return;
    }
    let fromName = m.fromName;
    if (fromName === null) {
      const [ph] = await tx.$queryRaw<Row[]>`SELECT name FROM pipeline_phases WHERE id = ${m.fromId}`;
      fromName = ph ? String(ph.name) : "";
    }
    await tx.$executeRaw`
      INSERT INTO pipeline_activity (id, project_id, kind, actor_id, data, created_at)
      VALUES (${randomUUID()}, ${m.projectId}, 'moved', ${m.actorId},
              ${JSON.stringify({ fromId: m.fromId, from: fromName, toId: m.toId, to: m.toName })}::jsonb, timezone('utc', now()))`;
  });
}

const SAFE_HREF = /^https?:\/\/[^\s<>"]+$/i;

export async function listActivity(dir: PipelineDirectory, projectId: string): Promise<PipelineActivityDto> {
  const r = await pipelineRead(async (db) => {
    const [p] = await db.$queryRaw<Row[]>`
      SELECT p.created_at, p.created_by_id, p.deleted_at, p.kind FROM pipeline_projects p WHERE p.id = ${projectId}`;
    if (!p || p.kind !== "project") throw new PipelineError(404, "PROJECT_NOT_FOUND", "This project doesn't exist");
    if (p.deleted_at) throw new PipelineError(404, "PROJECT_DELETED", "This project was deleted");
    let rows: Row[] = [];
    try {
      rows = await db.$queryRaw<Row[]>(Prisma.sql`
        SELECT id, kind, actor_id, data, created_at FROM pipeline_activity
         WHERE project_id = ${projectId}
         ORDER BY created_at DESC, id DESC LIMIT ${PIPELINE_ACTIVITY_LIST_MAX}`);
    } catch (err) {
      // The table is missing (DDL not applied yet): an empty timeline, not an error.
      if (!/pipeline_activity/.test(String((err as Error)?.message ?? ""))) throw err;
    }
    return { p, rows };
  });

  const name = (id: string | null) => (id ? dir.byId.get(id)?.name ?? "Former member" : null);
  const items: PipelineActivityDto["items"] = r.rows.map((x) => {
    const data = (x.data ?? {}) as Record<string, unknown>;
    const actorId = x.actor_id ? String(x.actor_id) : null;
    const href = typeof data.href === "string" && SAFE_HREF.test(data.href) ? data.href : null;
    return {
      id: String(x.id),
      kind: String(x.kind) as PipelineActivityKind,
      actor: actorId ? { id: actorId, name: name(actorId)! } : null,
      at: ts(x.created_at) ?? "",
      text: activityText(String(x.kind), data, (id) => dir.byId.get(id)?.name ?? null),
      href,
    };
  });
  // Projects older than the timeline: their creation is still the first entry.
  if (items.length < PIPELINE_ACTIVITY_LIST_MAX && !items.some((i) => i.kind === "created")) {
    const by = String(r.p.created_by_id);
    items.push({
      id: `created-${projectId}`,
      kind: "created",
      actor: { id: by, name: name(by)! },
      at: ts(r.p.created_at) ?? "",
      text: activityText("created", {}),
      href: null,
    });
  }
  return { items };
}
