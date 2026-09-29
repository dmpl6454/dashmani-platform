/**
 * Pipeline background maintenance (spec §7.12): the notification trim and the purge of
 * projects soft-deleted more than 30 days ago.
 *
 * SCHEDULED BY WALL CLOCK, NEVER AT BOOT: index.ts calls schedulePipelineMaintenance(),
 * which sets a timer for the next 04:00 IST. A run proceeds only when the IST time is in
 * [03:30, 05:30) and `pipeline.trimLastRunIST` is not already today, sets the marker when
 * done, and the timer is re-armed for the next 04:00. A deploy restart therefore never
 * starts a heavy DELETE during working hours.
 *
 * Every batch is its own short transaction on the pipeline pool, through pipelineWrite
 * (one bulkhead slot, so request traffic is never starved for more than one batch).
 */
import { dateToIST, istMinutesOfDay } from "@dashmani/shared";
import { Prisma, type PipelineTx } from "./db";
import { pipelineRead, pipelineWrite, pipelineWriteStatement } from "./tx";
import { ensurePipelineSchemaChecked } from "./self-check";

export const TRIM_MARKER_KEY = "pipeline.trimLastRunIST";
const TARGET_MIN = 240; // 04:00 IST
const RUN_FROM_MIN = 210; // 03:30 IST
const RUN_UNTIL_MIN = 330; // 05:30 IST
const DAY_MS = 86_400_000;
const IST_OFFSET_MS = 330 * 60_000;

const TRIM_BATCH = 2000;
const TRIM_MAX_ITERATIONS = 20;
const PURGE_MAX_PROJECTS = 20;
const PURGE_CHUNK = 1000;
const USER_CHUNK = 50;

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/** Milliseconds until the next `targetMin` (minutes after IST midnight). Never 0. */
export function msUntilNextIST(targetMin: number, now: Date = new Date()): number {
  const msOfDay = (now.getTime() + IST_OFFSET_MS) % DAY_MS;
  const delta = (targetMin * 60_000 - msOfDay + DAY_MS) % DAY_MS;
  return delta === 0 ? DAY_MS : delta;
}

// ── Trim ─────────────────────────────────────────────────────────────────────────────

const TRIM_PREDICATE = (a: string) => Prisma.sql`${Prisma.raw(a)}.type = 'PIPELINE'::"NotificationType"
  AND ((${Prisma.raw(a)}.read AND ${Prisma.raw(a)}.created_at < timezone('utc', now()) - interval '30 days')
       OR ${Prisma.raw(a)}.created_at < timezone('utc', now()) - interval '90 days')`;

/**
 * Delete read PIPELINE rows older than 30 days and any older than 90 days, in batches of
 * 2,000 (≤ 20), each with a 5 s statement timeout, pausing between batches. The outer
 * DELETE repeats the predicate so a row re-armed (read=false, created_at=now) after the
 * inner select — or held by the writer re-arming it (SKIP LOCKED) — is never deleted.
 * A deleted grouped row is simply recreated by the next message.
 */
export async function trimPipelineNotifications(opts: { pauseMs?: number } = {}): Promise<number> {
  const pauseMs = opts.pauseMs ?? 500;
  let total = 0;
  for (let i = 0; i < TRIM_MAX_ITERATIONS; i++) {
    if (i > 0) await sleep(pauseMs);
    const n = await pipelineWrite(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
        return tx.$executeRaw`
          DELETE FROM notifications n
           WHERE n.id IN (SELECT x.id FROM notifications x WHERE ${TRIM_PREDICATE("x")}
                           LIMIT ${TRIM_BATCH}::int FOR UPDATE SKIP LOCKED)
             AND ${TRIM_PREDICATE("n")}`;
      },
      { timeoutMs: 7000 },
    );
    total += n;
    if (n === 0) break;
  }
  return total;
}

// ── Purge ────────────────────────────────────────────────────────────────────────────

export interface PurgeChunk {
  phase: "notifications" | "replies" | "roots";
  rows: number;
  ms: number;
}

const PURGEABLE = Prisma.sql`deleted_at IS NOT NULL AND deleted_at < timezone('utc', now()) - interval '30 days'`;

/** Lock the project and re-check it is still purgeable. False → stop (restored or gone). */
async function lockPurgeable(tx: PipelineTx, pid: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM pipeline_projects WHERE id = ${pid} AND ${PURGEABLE} FOR UPDATE`;
  return rows.length > 0;
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - t0 };
}

async function purgeProject(pid: string, onChunk?: (c: PurgeChunk) => void): Promise<boolean> {
  // 1–2. Lock, re-check, and collect every user who can hold a row about this project:
  // participants ∪ message authors (reply rows go to root authors) ∪ everyone mentioned.
  const users = await pipelineWrite(async (tx) => {
    if (!(await lockPurgeable(tx, pid))) return null;
    const [row] = await tx.$queryRaw<Array<{ ids: string[] }>>`
      SELECT COALESCE(array_agg(DISTINCT uid ORDER BY uid), '{}'::text[]) AS ids FROM (
        SELECT user_id AS uid FROM pipeline_participants WHERE project_id = ${pid}
        UNION SELECT author_id FROM pipeline_messages WHERE project_id = ${pid}
        UNION SELECT unnest(mention_ids) FROM pipeline_messages WHERE project_id = ${pid}) s`;
    return row.ids;
  });
  if (!users) return false;

  // 3. The project's PIPELINE rows, per user through the (user_id, read) index prefix.
  for (let i = 0; i < users.length; i += USER_CHUNK) {
    const chunk = users.slice(i, i + USER_CHUNK);
    const { value, ms } = await timed(() =>
      pipelineWrite(
        (tx) => tx.$executeRaw`
          DELETE FROM notifications
           WHERE user_id = ANY(${chunk}::text[]) AND type = 'PIPELINE'::"NotificationType"
             AND metadata->>'pid' = ${pid}`,
      ),
    );
    onChunk?.({ phase: "notifications", rows: value, ms });
  }

  // 4. Replies, then roots, 1,000 per transaction, each re-checking the project lock.
  for (const phase of ["replies", "roots"] as const) {
    const which = phase === "replies" ? Prisma.sql`parent_id IS NOT NULL` : Prisma.sql`parent_id IS NULL`;
    for (;;) {
      const { value, ms } = await timed(() =>
        pipelineWrite(async (tx) => {
          if (!(await lockPurgeable(tx, pid))) return -1;
          return tx.$executeRaw`
            DELETE FROM pipeline_messages
             WHERE id IN (SELECT id FROM pipeline_messages
                           WHERE project_id = ${pid} AND ${which} LIMIT ${PURGE_CHUNK}::int)`;
        }),
      );
      if (value < 0) return false;
      if (value === 0) break;
      onChunk?.({ phase, rows: value, ms });
    }
  }

  // 5. The project row (cascades its participants).
  return pipelineWrite(async (tx) => {
    if (!(await lockPurgeable(tx, pid))) return false;
    await tx.$executeRaw`DELETE FROM pipeline_projects WHERE id = ${pid}`;
    return true;
  });
}

/** Up to 20 projects soft-deleted more than 30 days ago. */
export async function purgeDeletedProjects(opts: { onChunk?: (c: PurgeChunk) => void } = {}): Promise<{ purged: number }> {
  const ids = await pipelineRead((db) =>
    db.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM pipeline_projects WHERE ${PURGEABLE}
       ORDER BY deleted_at, id LIMIT ${PURGE_MAX_PROJECTS}::int`,
  );
  let purged = 0;
  for (const { id } of ids) if (await purgeProject(id, opts.onChunk)) purged++;
  return { purged };
}

// ── The wall-clock run ───────────────────────────────────────────────────────────────

export type MaintenanceResult =
  | { status: "skipped"; reason: "hours" | "done" | "schema" | "running" }
  | { status: "ran"; trimmed: number; purged: number };

let running = false;

/** One maintenance run, if it is due. `now` / `pauseMs` are injectable for tests. */
export function runPipelineMaintenanceIfDue(opts: { now?: Date; pauseMs?: number } = {}): Promise<MaintenanceResult> {
  if (running) return Promise.resolve({ status: "skipped", reason: "running" });
  running = true; // claimed before the first await
  return (async (): Promise<MaintenanceResult> => {
    try {
      const now = opts.now ?? new Date();
      const minutes = istMinutesOfDay(now);
      if (minutes < RUN_FROM_MIN || minutes >= RUN_UNTIL_MIN) return { status: "skipped", reason: "hours" };
      const today = dateToIST(now);
      const marker = await pipelineRead((db) => db.systemSetting.findUnique({ where: { key: TRIM_MARKER_KEY } }));
      if (marker?.value === today) return { status: "skipped", reason: "done" };
      if (!(await ensurePipelineSchemaChecked())) return { status: "skipped", reason: "schema" };
      const trimmed = await trimPipelineNotifications({ pauseMs: opts.pauseMs });
      const { purged } = await purgeDeletedProjects();
      await pipelineWriteStatement((db) =>
        db.systemSetting.upsert({
          where: { key: TRIM_MARKER_KEY },
          create: { key: TRIM_MARKER_KEY, value: today },
          update: { value: today },
        }),
      );
      return { status: "ran", trimmed, purged };
    } finally {
      running = false;
    }
  })();
}

/**
 * index.ts: arm a timer for the next 04:00 IST (never a run at boot); after each run —
 * done, skipped or failed — re-arm for the following 04:00. Returns a handle for tests.
 */
export function schedulePipelineMaintenance(
  run: () => Promise<MaintenanceResult> = () => runPipelineMaintenanceIfDue(),
): { stop(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const arm = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      run()
        .then((r) => {
          if (r.status === "ran") console.log(`[pipeline-jobs] trimmed=${r.trimmed} purged=${r.purged}`);
        })
        .catch((err) => console.warn("[pipeline-jobs] maintenance failed:", String(err)))
        .finally(arm);
    }, msUntilNextIST(TARGET_MIN));
    timer.unref?.();
  };
  arm();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
