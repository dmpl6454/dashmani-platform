import { AppError } from "../middleware/error-handler";

// Bulkhead factory (spec §3.2). A new, independent primitive: utils/heavy-query.ts is a
// separate gate for analytics and is deliberately NOT reused here.
//
// WHY: a pool that is asked for more connections than it has makes callers wait inside
// Prisma for pool_timeout and then fail with P2024 — while they wait they look exactly
// like a hung request. A bulkhead in front of the pool keeps "more work than connections"
// in a cheap in-process queue instead, sized so that:
//   • at most `max` operations hold a connection at once (sized to the pool);
//   • at most `queue` callers wait; the next one is refused IMMEDIATELY (no pile-up);
//   • a waiter gives up after `maxWaitMs` with a clean 503 + retryAfterSec that the
//     client retries silently — never a 500 and never a minute-long stall;
//   • with `writePriority`, a queued write (a user's send, move or edit) is granted ahead
//     of queued reads (polls), so a poll burst cannot starve a real action;
//   • a "background" waiter (the pipeline email worker) is granted only when no read or
//     write is waiting, so background work never delays a user's request. With a free slot
//     and an empty queue it is granted at once like anything else.
//
// Single-threaded state, no timers except each waiter's own give-up timer.

export type BulkheadKind = "read" | "write" | "background";

export class BulkheadBusyError extends AppError {
  constructor(
    code: string,
    message: string,
    readonly retryAfterSec: number,
    readonly reason: "queue_full" | "wait_timeout",
  ) {
    super(503, code, message);
    this.name = "BulkheadBusyError";
  }
}

export interface BulkheadOptions {
  /** Operations allowed in flight at once. */
  max: number;
  /** Callers allowed to wait; one more is refused immediately. */
  queue: number;
  /** How long a caller may wait for a slot before it is refused. */
  maxWaitMs: number;
  /** Grant queued writes before queued reads. */
  writePriority: boolean;
  /** Error code for a refusal (default PIPELINE_BUSY — the pipeline is the only user). */
  code?: string;
  /** Message for a refusal. */
  message?: string;
  /** retryAfterSec sent with a refusal (default: maxWaitMs rounded up, at least 1 s). */
  retryAfterSec?: number;
}

export interface BulkheadStats {
  active: number;
  queued: number;
  queuedReads: number;
  queuedWrites: number;
  queuedBackground: number;
  max: number;
  queue: number;
  maxWaitMs: number;
  /** Highest number of queued callers seen since the last reset. */
  maxQueuedSeen: number;
  /** Slots handed out (fast path + from the queue) since the last reset. Every pipeline
   *  statement takes one, so tests use it to prove a hit path runs ZERO statements. */
  granted: number;
  /** Callers that had to wait at all. */
  waits: number;
  /** Callers refused (queue full or wait timeout). */
  rejected: number;
}

export interface Bulkhead {
  /** Wait for a slot; resolves with an idempotent release function. */
  acquire(kind: BulkheadKind): Promise<() => void>;
  /** Run `fn` inside a slot; the slot is released however `fn` settles. */
  run<T>(kind: BulkheadKind, fn: () => Promise<T>): Promise<T>;
  stats(): BulkheadStats;
  /** Tests only: refuse every waiter and zero the counters. */
  reset(): void;
}

interface Waiter {
  kind: BulkheadKind;
  grant: () => void;
  timer: ReturnType<typeof setTimeout>;
  reject: (err: Error) => void;
}

export function createBulkhead(opts: BulkheadOptions): Bulkhead {
  const max = Math.max(1, Math.floor(opts.max));
  const queueCap = Math.max(0, Math.floor(opts.queue));
  const maxWaitMs = Math.max(1, Math.floor(opts.maxWaitMs));
  const code = opts.code ?? "PIPELINE_BUSY";
  const message = opts.message ?? "Busy right now — retrying shortly";
  const retryAfterSec = opts.retryAfterSec ?? Math.max(1, Math.ceil(maxWaitMs / 1000));

  let active = 0;
  // One FIFO list; with writePriority the first queued write is taken ahead of reads.
  const waiters: Waiter[] = [];
  let maxQueuedSeen = 0;
  let waits = 0;
  let rejected = 0;
  let granted = 0;

  function makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active = Math.max(0, active - 1);
      grantNext();
    };
  }

  function grantNext(): void {
    while (active < max && waiters.length > 0) {
      // writes first (with writePriority), then reads in FIFO order, then background.
      let idx = opts.writePriority ? waiters.findIndex((x) => x.kind === "write") : -1;
      if (idx < 0) idx = waiters.findIndex((x) => x.kind !== "background");
      if (idx < 0) idx = 0;
      const next = waiters.splice(idx, 1)[0];
      next.grant();
    }
  }

  function acquire(kind: BulkheadKind): Promise<() => void> {
    if (active < max && waiters.length === 0) {
      active++;
      granted++;
      return Promise.resolve(makeRelease());
    }
    if (waiters.length >= queueCap) {
      rejected++;
      return Promise.reject(new BulkheadBusyError(code, message, retryAfterSec, "queue_full"));
    }
    waits++;
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        kind,
        grant: () => {
          clearTimeout(waiter.timer);
          active++;
          granted++;
          resolve(makeRelease());
        },
        reject,
        timer: setTimeout(() => {
          const i = waiters.indexOf(waiter);
          if (i >= 0) waiters.splice(i, 1);
          rejected++;
          reject(new BulkheadBusyError(code, message, retryAfterSec, "wait_timeout"));
        }, maxWaitMs),
      };
      waiters.push(waiter);
      if (waiters.length > maxQueuedSeen) maxQueuedSeen = waiters.length;
    });
  }

  async function run<T>(kind: BulkheadKind, fn: () => Promise<T>): Promise<T> {
    const release = await acquire(kind);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  function stats(): BulkheadStats {
    let queuedWrites = 0;
    let queuedBackground = 0;
    for (const w of waiters) {
      if (w.kind === "write") queuedWrites++;
      else if (w.kind === "background") queuedBackground++;
    }
    return {
      active,
      queued: waiters.length,
      queuedReads: waiters.length - queuedWrites - queuedBackground,
      queuedWrites,
      queuedBackground,
      max,
      queue: queueCap,
      maxWaitMs,
      maxQueuedSeen,
      granted,
      waits,
      rejected,
    };
  }

  function reset(): void {
    for (const w of waiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(new BulkheadBusyError(code, message, retryAfterSec, "wait_timeout"));
    }
    active = 0;
    maxQueuedSeen = 0;
    granted = 0;
    waits = 0;
    rejected = 0;
  }

  return { acquire, run, stats, reset };
}
