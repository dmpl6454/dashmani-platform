/**
 * The only way pipeline code touches the database (spec §3.2 "Wrappers", §6).
 *
 *   pipelineRead(fn)  — one read slot; `fn` gets the pipeline client and should run ONE
 *                       autocommit statement (sync, detail, history, memo misses).
 *   pipelineWrite(fn) — one write slot; `fn` runs inside
 *                       pipelineDb.$transaction(fn, { maxWait: 1500, timeout: 4000 }).
 *
 * Both acquire a `pipelineGate` slot BEFORE touching a connection and release it in
 * `finally`, so at most `pipelineDbConnections` operations hold a pipeline connection
 * and everything else waits (briefly, without a connection) or gets 503 PIPELINE_BUSY.
 *
 * ⚠️ Rules for callers (spec §2 "DB access rules", §6):
 *   - Never nest: a function running inside pipelineRead/pipelineWrite must not call
 *     either wrapper again (it would wait for a slot it is itself holding).
 *   - Resolve memos (settings, access, directory) BEFORE taking a slot.
 *   - Transaction callbacks use only `tx` — never `pipelineDb`, never the global `prisma`.
 *   - No `Promise.all` over queries inside one operation.
 *   - Board bumps happen AFTER the write returns (post-commit), never inside `fn`.
 */
import { createBulkhead } from "../../utils/bulkhead";
import { pipelineDb, pipelineDbConnections, type PipelineDbClient, type PipelineTx } from "./db";
import { normalizePipelineError, withRetryOnce } from "./errors";

/**
 * Sized from the pipeline pool (3 in production, 1 in the main test suite): a slot is a
 * connection, so the gate never admits more work than the pool can serve without a
 * Prisma pool_timeout wait.
 */
export const pipelineGate = createBulkhead({
  max: pipelineDbConnections,
  queue: 100,
  maxWaitMs: 2000,
  writePriority: true,
  code: "PIPELINE_BUSY",
  message: "The pipeline is busy — retrying shortly",
  retryAfterSec: 2,
});

/**
 * One read slot, one autocommit statement (or a few sequential ones). Errors are
 * classified (errors.ts): a recognised DB failure is rethrown as its PipelineDbError
 * (503 / 409 / 404), an AppError thrown by `fn` passes through, anything else is
 * rethrown unchanged and becomes a logged 500.
 */
export async function pipelineRead<T>(fn: (db: PipelineDbClient) => Promise<T>): Promise<T> {
  try {
    return await pipelineGate.run("read", () => fn(pipelineDb));
  } catch (err) {
    throw normalizePipelineError(err);
  }
}

/**
 * One WRITE slot, one AUTOCOMMIT statement (no transaction): the post-commit board bump
 * and the sync ack (spec §5.1, §5.4). Write priority, because it completes a user action.
 */
export async function pipelineWriteStatement<T>(fn: (db: PipelineDbClient) => Promise<T>): Promise<T> {
  try {
    return await pipelineGate.run("write", () => fn(pipelineDb));
  } catch (err) {
    throw normalizePipelineError(err);
  }
}

export interface PipelineWriteOptions {
  /**
   * Retry once after 50–150 ms on a deadlock (40P01) or serialization failure (40001).
   * ONLY for operations that are safe to run twice (idempotent by key or by state).
   * The slot is released during the pause and re-acquired for the retry.
   */
  retryOnce?: boolean;
}

/** One write slot; `fn` runs in an interactive transaction on the pipeline client. */
export async function pipelineWrite<T>(
  fn: (tx: PipelineTx) => Promise<T>,
  opts: PipelineWriteOptions = {},
): Promise<T> {
  const attempt = () =>
    pipelineGate.run("write", () => pipelineDb.$transaction((tx) => fn(tx), { maxWait: 1500, timeout: 4000 }));
  try {
    return await (opts.retryOnce ? withRetryOnce(attempt) : attempt());
  } catch (err) {
    throw normalizePipelineError(err);
  }
}

/** Tests only: refuse every queued waiter and zero the gate's counters. */
export function resetPipelineBulkheadForTests(): void {
  pipelineGate.reset();
}
