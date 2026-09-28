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

/** One read slot, one autocommit statement (or a few sequential ones). */
export async function pipelineRead<T>(fn: (db: PipelineDbClient) => Promise<T>): Promise<T> {
  return pipelineGate.run("read", () => fn(pipelineDb));
}

/** One write slot; `fn` runs in an interactive transaction on the pipeline client. */
export async function pipelineWrite<T>(fn: (tx: PipelineTx) => Promise<T>): Promise<T> {
  return pipelineGate.run("write", () =>
    pipelineDb.$transaction((tx) => fn(tx), { maxWait: 1500, timeout: 4000 }),
  );
}

/** Tests only: refuse every queued waiter and zero the gate's counters. */
export function resetPipelineBulkheadForTests(): void {
  pipelineGate.reset();
}
