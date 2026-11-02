/**
 * link_metrics retention — caps the per-poll snapshot log.
 *
 * link_metrics appends one row per poll that changed something (shouldAppendSnapshot). It
 * held 15.4M rows / ~6 GB on 2026-11-02 — almost all of it from the Jul–Sep sweeps before
 * the dedupe — while no portal path reads it: every engagement surface reads
 * link_metrics_latest. The only readers left are by link_id:
 *
 *   - the cron's dedupe lookup (findLatestSnapshotsByLinkIds) — needs the NEWEST row per link;
 *   - GET /admin/reports/links/:linkId/metrics (no UI calls it) — history, best-effort;
 *   - scripts/backfill-link-metrics-latest.ts, the recovery tool that rebuilds the read model
 *     from the newest status='ok' row — needs the NEWEST OK row per link.
 *
 * So a row is deleted only when ALL of these hold:
 *   - fetched_at is older than LINK_METRICS_KEEP_DAYS (30);
 *   - it has a link_id (orphans are left for the cron's re-heal — ~17k rows, not worth it);
 *   - a NEWER row exists for the same link (the newest row per link is never deleted);
 *   - it is not 'ok', or a NEWER 'ok' row exists for the same link (the newest ok row survives).
 * Both EXISTS probes ride link_metrics_link_id_idx, the table's one index.
 *
 * ⚠️ There is no index on fetched_at, and one must not be added for this: the table is walked
 * in physical order by ctid range (Postgres 14+ TID Range Scan), BLOCKS_PER_BATCH heap blocks
 * per short transaction. Each block is read once per sweep — no batch re-scans the dead
 * tuples of the batch before it. A sweep that runs out of its time budget saves its block
 * cursor and the next night resumes there.
 *
 * Deleted space is reused by later inserts; it is not returned to the OS. The one-time catch-up
 * of the 15M-row backlog (scripts/link-metrics-catchup.sql — the same rule, against a per-link
 * summary built in one sequential pass, because these probes would take ~3 h over that much
 * cold history) and the VACUUM FULL that returns the space live in
 * scripts/compact-usage-tables.sh.
 *
 * Scheduled by WALL CLOCK for 04:40 IST, after the api_usage rollup (04:20), never at boot,
 * once per IST day via a system_settings marker. Kill switch: LINK_METRICS_RETENTION_ENABLED=0.
 */
import { prisma } from "@dashmani/db";
import { dateToIST, istMinutesOfDay } from "@dashmani/shared";
import { msUntilNextIST } from "./pipeline/jobs";

// 30 days (2026-11-02): 9.2M of the 15.4M rows were inside a 60-day window — the mid-September
// sweep burst — and nothing on a portal path reads this history.
export const LINK_METRICS_KEEP_DAYS = 30;
export const LINK_METRICS_RETENTION_MARKER_KEY = "linkMetrics.retentionLastRunIST";
export const LINK_METRICS_RETENTION_CURSOR_KEY = "linkMetrics.retentionCursorBlock";
// 4 MB of heap per transaction. Measured on prod 2026-11-02 BEFORE the catch-up: 2000 blocks of
// July rows took 35 s cold (the EXISTS probes fetch every sibling row from the heap). After the
// catch-up the table is ~1M rows and a night's sweep is a few dozen batches.
export const BLOCKS_PER_BATCH = 500;
const RUN_BUDGET_MS = 25 * 60_000;
const PAUSE_MS = 100;
const TARGET_MIN = 280; // 04:40 IST
const RUN_FROM_MIN = 210; // 03:30 IST
const RUN_UNTIL_MIN = 330; // 05:30 IST

export interface RetentionResult {
  cutoff: string;
  fromBlock: number;
  /** Block the next sweep resumes from; 0 when this sweep reached the end of the table. */
  nextBlock: number;
  totalBlocks: number;
  batches: number;
  deleted: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function tableBlocks(): Promise<number> {
  const [r] = await prisma.$queryRaw<Array<{ blocks: bigint }>>`
    SELECT (pg_relation_size('link_metrics') / current_setting('block_size')::int)::bigint AS blocks`;
  return Number(r?.blocks ?? 0);
}

/** Delete the expendable rows in heap blocks [startBlock, endBlock). Returns rows deleted. */
export async function pruneLinkMetricsBlocks(startBlock: number, endBlock: number, cutoff: Date): Promise<number> {
  const from = `(${startBlock},0)`;
  const to = `(${endBlock},0)`;
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET LOCAL statement_timeout = '60s'`;
      await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
      // fetched_at is timestamp WITHOUT time zone holding UTC: compare in UTC whatever the
      // session TimeZone is (same rule as the Cost Sheet query).
      return tx.$executeRaw`
        DELETE FROM link_metrics m
         WHERE m.ctid >= ${from}::tid AND m.ctid < ${to}::tid
           AND m.fetched_at < (${cutoff}::timestamptz AT TIME ZONE 'UTC')
           AND m.link_id IS NOT NULL
           AND EXISTS (SELECT 1 FROM link_metrics n
                        WHERE n.link_id = m.link_id AND n.fetched_at > m.fetched_at)
           AND (m.status <> 'ok'
                OR EXISTS (SELECT 1 FROM link_metrics k
                            WHERE k.link_id = m.link_id AND k.status = 'ok' AND k.fetched_at > m.fetched_at))`;
    },
    { maxWait: 5_000, timeout: 75_000 },
  );
}

/**
 * One sweep from `fromBlock` toward the end of the table, stopping early when `budgetMs` runs
 * out. Pure of scheduling — the runner below persists the cursor.
 */
export async function pruneLinkMetrics(
  opts: { now?: Date; keepDays?: number; fromBlock?: number; budgetMs?: number; blocksPerBatch?: number; pauseMs?: number } = {},
): Promise<RetentionResult> {
  const now = opts.now ?? new Date();
  const keepDays = opts.keepDays ?? LINK_METRICS_KEEP_DAYS;
  const cutoff = new Date(now.getTime() - keepDays * 86_400_000);
  const step = opts.blocksPerBatch ?? BLOCKS_PER_BATCH;
  const budgetMs = opts.budgetMs ?? RUN_BUDGET_MS;
  const pauseMs = opts.pauseMs ?? PAUSE_MS;
  const started = Date.now();
  const totalBlocks = await tableBlocks();
  const fromBlock = Math.min(Math.max(0, opts.fromBlock ?? 0), totalBlocks);

  let block = fromBlock;
  let batches = 0;
  let deleted = 0;
  while (block < totalBlocks) {
    if (batches > 0 && Date.now() - started >= budgetMs) break;
    const end = block + step;
    deleted += await pruneLinkMetricsBlocks(block, end, cutoff);
    batches++;
    block = end;
    if (pauseMs > 0 && block < totalBlocks) await sleep(pauseMs);
  }
  return {
    cutoff: cutoff.toISOString(),
    fromBlock,
    nextBlock: block >= totalBlocks ? 0 : block,
    totalBlocks,
    batches,
    deleted,
  };
}

export type RetentionRunResult =
  | { status: "skipped"; reason: "disabled" | "hours" | "done" | "running" }
  | ({ status: "ran" } & RetentionResult);

let running = false;

/** One retention sweep, if due (enabled, quiet IST window, not yet done today). */
export function runLinkMetricsRetentionIfDue(
  opts: { now?: Date; keepDays?: number; budgetMs?: number; blocksPerBatch?: number; pauseMs?: number } = {},
): Promise<RetentionRunResult> {
  if (process.env.LINK_METRICS_RETENTION_ENABLED === "0") return Promise.resolve({ status: "skipped", reason: "disabled" });
  if (running) return Promise.resolve({ status: "skipped", reason: "running" });
  running = true; // claimed before the first await
  return (async (): Promise<RetentionRunResult> => {
    try {
      const now = opts.now ?? new Date();
      const minutes = istMinutesOfDay(now);
      if (minutes < RUN_FROM_MIN || minutes >= RUN_UNTIL_MIN) return { status: "skipped", reason: "hours" };
      const today = dateToIST(now);
      const marker = await prisma.systemSetting.findUnique({ where: { key: LINK_METRICS_RETENTION_MARKER_KEY } });
      if (marker?.value === today) return { status: "skipped", reason: "done" };
      const cursor = await prisma.systemSetting.findUnique({ where: { key: LINK_METRICS_RETENTION_CURSOR_KEY } });
      const fromBlock = Number(cursor?.value);
      const result = await pruneLinkMetrics({ ...opts, now, fromBlock: Number.isFinite(fromBlock) ? fromBlock : 0 });
      for (const [key, value] of [
        [LINK_METRICS_RETENTION_CURSOR_KEY, String(result.nextBlock)],
        [LINK_METRICS_RETENTION_MARKER_KEY, today],
      ] as const) {
        await prisma.systemSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
      }
      return { status: "ran", ...result };
    } finally {
      running = false;
    }
  })();
}

/**
 * index.ts: arm a timer for the next 04:40 IST (never a run at boot); after each run — done,
 * skipped or failed — re-arm for the following 04:40. Returns a handle for tests.
 */
export function scheduleLinkMetricsRetention(
  run: () => Promise<RetentionRunResult> = () => runLinkMetricsRetentionIfDue(),
): { stop(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const arm = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      run()
        .then((r) => {
          if (r.status === "ran") {
            console.log(
              `[link-metrics-retention] deleted=${r.deleted} blocks ${r.fromBlock}->${r.nextBlock || r.totalBlocks}/${r.totalBlocks} batches=${r.batches} (older than ${r.cutoff})`,
            );
          }
        })
        .catch((err) => console.warn("[link-metrics-retention] failed:", String(err)))
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
