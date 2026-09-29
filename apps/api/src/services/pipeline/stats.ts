/**
 * Pipeline counters and the hourly `[pipeline] stats` log line (spec §12 step 8, plan M6).
 *
 * Everything here is in-process and O(1) per event: plain counters plus two bounded
 * sample buffers (sync latency and the R1 slot hold) for the p95s. Nothing touches the
 * database, so recording can never slow or fail a request. The hourly line is the pilot's
 * monitoring surface:
 *
 *   [pipeline] stats 60m syncs=… sync_p95=…ms slow_syncs=… hold_p95=…ms writes=…
 *     429_read=… 429_write=… 429_message=… 503_busy=… bulkhead_waits=… max_queue=…
 *     conflicts=… notif_rows=… bump_failures=… bump_pending=…
 *
 * Counters reset after each line; `max_queue` is the highest bulkhead queue seen since boot
 * (the bulkhead keeps it; resetting it would also refuse its waiters).
 */
import { pipelineGate } from "./tx";
import { isBoardBumpPending } from "./board";

/** A sync slower than this counts as slow (spec §12 step 8). */
export const SLOW_SYNC_MS = 200;
const SAMPLE_CAP = 20_000;

type Bucket = "read" | "write" | "message";

interface Window {
  startedAt: number;
  syncs: number;
  slowSyncs: number;
  writes: number;
  rateLimited: Record<Bucket, number>;
  busy503: number;
  conflicts409: number;
  notifRows: number;
  bumpFailures: number;
  syncMs: number[];
  holdMs: number[];
  heavyHoldMs: number[];
}

function fresh(): Window {
  return {
    startedAt: Date.now(),
    syncs: 0,
    slowSyncs: 0,
    writes: 0,
    rateLimited: { read: 0, write: 0, message: 0 },
    busy503: 0,
    conflicts409: 0,
    notifRows: 0,
    bumpFailures: 0,
    syncMs: [],
    holdMs: [],
    heavyHoldMs: [],
  };
}

let w = fresh();
let gateBase = { waits: 0 };

/** Reservoir-free bounded buffer: past the cap, overwrite a random slot (keeps a fair sample). */
function push(buf: number[], v: number): void {
  if (buf.length < SAMPLE_CAP) buf.push(v);
  else buf[Math.floor(Math.random() * SAMPLE_CAP)] = v;
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i];
}

/** Only the load harness sets this: the §2 heavy user's R1 hold is reported on its own. */
const heavyUserId = process.env.PIPELINE_LOADTEST_HEAVY_USER || null;

export const pipelineStats = {
  sync(ms: number): void {
    w.syncs++;
    if (ms > SLOW_SYNC_MS) w.slowSyncs++;
    push(w.syncMs, ms);
  },
  /** The R1 (+A1) slot hold of one sync. */
  syncHold(userId: string, ms: number): void {
    push(w.holdMs, ms);
    if (heavyUserId && userId === heavyUserId) push(w.heavyHoldMs, ms);
  },
  write(): void {
    w.writes++;
  },
  rateLimited(bucket: Bucket): void {
    w.rateLimited[bucket]++;
  },
  errorStatus(status: number, code: string): void {
    if (status === 503 && code === "PIPELINE_BUSY") w.busy503++;
    else if (status === 409) w.conflicts409++;
  },
  notificationRows(n: number): void {
    if (Number.isFinite(n) && n > 0) w.notifRows += n;
  },
  bumpFailure(): void {
    w.bumpFailures++;
  },
};

export interface PipelineStatsSnapshot {
  windowMs: number;
  syncs: number;
  syncP95Ms: number | null;
  slowSyncs: number;
  holdP95Ms: number | null;
  heavyHoldP95Ms: number | null;
  heavyHoldSamples: number;
  writes: number;
  rateLimited: Record<Bucket, number>;
  busy503: number;
  bulkheadWaits: number;
  maxQueue: number;
  conflicts409: number;
  notifRows: number;
  bumpFailures: number;
  bumpPending: boolean;
}

/** Read the current window; `reset` starts a new one (the hourly line does). */
export function snapshotPipelineStats(reset = false): PipelineStatsSnapshot {
  const g = pipelineGate.stats();
  const snap: PipelineStatsSnapshot = {
    windowMs: Date.now() - w.startedAt,
    syncs: w.syncs,
    syncP95Ms: percentile(w.syncMs, 95),
    slowSyncs: w.slowSyncs,
    holdP95Ms: percentile(w.holdMs, 95),
    heavyHoldP95Ms: percentile(w.heavyHoldMs, 95),
    heavyHoldSamples: w.heavyHoldMs.length,
    writes: w.writes,
    rateLimited: { ...w.rateLimited },
    busy503: w.busy503,
    bulkheadWaits: Math.max(0, g.waits - gateBase.waits),
    maxQueue: g.maxQueuedSeen,
    conflicts409: w.conflicts409,
    notifRows: w.notifRows,
    bumpFailures: w.bumpFailures,
    bumpPending: isBoardBumpPending(),
  };
  if (reset) {
    w = fresh();
    gateBase = { waits: g.waits };
  }
  return snap;
}

const f = (n: number | null) => (n === null ? "-" : `${Math.round(n * 10) / 10}ms`);

export function formatPipelineStats(s: PipelineStatsSnapshot): string {
  return (
    `[pipeline] stats ${Math.round(s.windowMs / 60_000)}m syncs=${s.syncs} sync_p95=${f(s.syncP95Ms)} slow_syncs=${s.slowSyncs}` +
    ` hold_p95=${f(s.holdP95Ms)} writes=${s.writes}` +
    ` 429_read=${s.rateLimited.read} 429_write=${s.rateLimited.write} 429_message=${s.rateLimited.message}` +
    ` 503_busy=${s.busy503} bulkhead_waits=${s.bulkheadWaits} max_queue=${s.maxQueue}` +
    ` conflicts=${s.conflicts409} notif_rows=${s.notifRows} bump_failures=${s.bumpFailures} bump_pending=${s.bumpPending}`
  );
}

let timer: NodeJS.Timeout | null = null;

/** Boot only (src/index.ts). One line per interval; the timer never holds the process open. */
export function startPipelineStatsLog(intervalMs = 60 * 60 * 1000): void {
  if (timer) return;
  timer = setInterval(() => {
    try {
      console.log(formatPipelineStats(snapshotPipelineStats(true)));
    } catch (err) {
      console.warn("[pipeline] stats line failed:", String(err));
    }
  }, intervalMs);
  timer.unref();
}

/** Tests only. */
export function resetPipelineStatsForTests(): void {
  w = fresh();
  gateBase = { waits: pipelineGate.stats().waits };
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
