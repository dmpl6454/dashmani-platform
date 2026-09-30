/**
 * pipeline/bulkhead.test.ts — utils/bulkhead.ts and the pipelineRead/pipelineWrite wrappers.
 *
 * The bulkhead caps how many pipeline operations hold a pipeline connection at once. A
 * caller past the cap waits WITHOUT a connection, briefly, then gets a clean 503
 * PIPELINE_BUSY with retryAfterSec (the client retries silently) — never a 500 and never
 * a request stuck behind a pool timeout. Writes are granted ahead of queued reads so a
 * burst of polls cannot starve a user's send.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { createBulkhead, BulkheadBusyError } from "../../src/utils/bulkhead";
import { AppError } from "../../src/middleware/error-handler";
import {
  pipelineGate,
  pipelineRead,
  pipelineWrite,
  resetPipelineBulkheadForTests,
} from "../../src/services/pipeline/tx";
import { pipelineDb } from "../../src/services/pipeline/db";

const tick = () => new Promise((r) => setTimeout(r, 5));

function settled<T>(p: Promise<T>) {
  const state = { done: false, value: undefined as T | undefined, error: undefined as unknown };
  p.then(
    (v) => {
      state.done = true;
      state.value = v;
    },
    (e) => {
      state.done = true;
      state.error = e;
    },
  );
  return state;
}

describe("createBulkhead({ max: 2, queue: 3, maxWaitMs: 100, writePriority: true })", () => {
  const make = () => createBulkhead({ max: 2, queue: 3, maxWaitMs: 100, writePriority: true });

  it("a third acquire waits until a slot is released", async () => {
    const b = make();
    const r1 = await b.acquire("read");
    await b.acquire("read");
    const third = settled(b.acquire("read"));
    await tick();
    expect(third.done).toBe(false);
    expect(b.stats()).toMatchObject({ active: 2, queued: 1 });
    r1();
    await tick();
    expect(third.done).toBe(true);
    expect(third.error).toBeUndefined();
    expect(b.stats()).toMatchObject({ active: 2, queued: 0 });
  });

  it("a write acquire is granted before a read that queued earlier", async () => {
    const b = make();
    const s1 = await b.acquire("read");
    const s2 = await b.acquire("read");
    const order: string[] = [];
    const read = b.acquire("read").then((rel) => {
      order.push("read");
      return rel;
    });
    await tick();
    const write = b.acquire("write").then((rel) => {
      order.push("write");
      return rel;
    });
    await tick();
    s1();
    await tick();
    expect(order).toEqual(["write"]);
    s2();
    await tick();
    expect(order).toEqual(["write", "read"]);
    (await read)();
    (await write)();
    expect(b.stats()).toMatchObject({ active: 0, queued: 0 });
  });

  it("a background acquire (the email worker) waits behind every queued read and write", async () => {
    const b = make();
    const s1 = await b.acquire("read");
    const s2 = await b.acquire("read");
    const order: string[] = [];
    const track = (kind: "read" | "write" | "background") =>
      b.acquire(kind).then((rel) => {
        order.push(kind);
        return rel;
      });
    const bgWait = track("background");
    await tick();
    const readWait = track("read");
    const writeWait = track("write");
    await tick();
    expect(b.stats()).toMatchObject({ queued: 3, queuedBackground: 1, queuedReads: 1, queuedWrites: 1 });
    s1();
    await tick();
    s2();
    await tick();
    // Queued first, granted last.
    expect(order).toEqual(["write", "read"]);
    (await writeWait)();
    await tick();
    expect(order).toEqual(["write", "read", "background"]);
    (await readWait)();
    (await bgWait)();
    expect(b.stats()).toMatchObject({ active: 0, queued: 0 });
  });

  it("a background acquire with a free slot and an empty queue is granted at once", async () => {
    const b = make();
    const rel = await b.acquire("background");
    expect(b.stats()).toMatchObject({ active: 1, queued: 0 });
    rel();
  });

  it("stats().granted counts every slot handed out (fast path and from the queue), never a refusal", async () => {
    const b = createBulkhead({ max: 1, queue: 1, maxWaitMs: 100, writePriority: true });
    const r1 = await b.acquire("read"); // fast path
    expect(b.stats().granted).toBe(1);
    const queued = b.acquire("write");
    await expect(b.acquire("read")).rejects.toBeInstanceOf(BulkheadBusyError); // queue full
    expect(b.stats().granted).toBe(1);
    r1();
    (await queued)(); // granted from the queue
    expect(b.stats()).toMatchObject({ granted: 2, rejected: 1 });
    b.reset();
    expect(b.stats().granted).toBe(0);
  });

  it("a waiter past maxWaitMs rejects with AppError(503, PIPELINE_BUSY) carrying retryAfterSec", async () => {
    const b = make();
    await b.acquire("read");
    await b.acquire("read");
    const t0 = Date.now();
    const err = await b.acquire("read").then(
      () => null,
      (e: unknown) => e,
    );
    const waited = Date.now() - t0;
    expect(waited).toBeGreaterThanOrEqual(90);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(BulkheadBusyError);
    expect((err as AppError).statusCode).toBe(503);
    expect((err as AppError).code).toBe("PIPELINE_BUSY");
    expect((err as BulkheadBusyError).retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(b.stats()).toMatchObject({ active: 2, queued: 0 });
  });

  it("a queue overflow rejects immediately", async () => {
    const b = make();
    await b.acquire("read");
    await b.acquire("read");
    const queued = [b.acquire("read"), b.acquire("write"), b.acquire("read")];
    for (const q of queued) q.catch(() => {}); // they time out at the end of the test
    const t0 = Date.now();
    const err = await b.acquire("write").then(
      () => null,
      (e: unknown) => e,
    );
    expect(Date.now() - t0).toBeLessThan(50);
    expect(err).toBeInstanceOf(BulkheadBusyError);
    expect((err as AppError).code).toBe("PIPELINE_BUSY");
    expect(b.stats().queued).toBe(3);
    b.reset();
    await Promise.allSettled(queued);
  });

  it("a slot is released even when the function throws, and a double release is harmless", async () => {
    const b = make();
    await expect(
      b.run("write", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(b.stats().active).toBe(0);
    const rel = await b.acquire("read");
    rel();
    rel();
    expect(b.stats().active).toBe(0);
    await expect(b.run("read", async () => 42)).resolves.toBe(42);
    expect(b.stats().active).toBe(0);
  });

  it("run() grants in order and never exceeds max in flight", async () => {
    const b = make();
    let inFlight = 0;
    let peak = 0;
    const jobs = Array.from({ length: 5 }, (_, i) =>
      b.run(i % 2 ? "write" : "read", async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await tick();
        inFlight--;
        return i;
      }),
    );
    expect((await Promise.all(jobs)).sort()).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
  });
});

describe("pipelineRead / pipelineWrite", () => {
  beforeEach(() => resetPipelineBulkheadForTests());
  afterAll(async () => {
    await pipelineDb.$disconnect();
  });

  it("pipelineWrite runs fn in one transaction on pipelineDb and rolls back when it throws", async () => {
    await expect(
      pipelineWrite(async (tx) => {
        await tx.$executeRaw`INSERT INTO pipeline_phases (id, key, name, position, updated_at)
                             VALUES (gen_random_uuid()::text, 'zz_tx', 'ZZ', 1, timezone('utc', now()))`;
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    const rows = await pipelineRead((db) => db.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pipeline_phases`);
    expect(rows[0].n).toBe(0);
    expect(pipelineGate.stats().active).toBe(0);
  });

  it("pipelineWrite commits on success and holds exactly one gate slot while running", async () => {
    let activeInside = -1;
    await pipelineWrite(async (tx) => {
      activeInside = pipelineGate.stats().active;
      await tx.$executeRaw`INSERT INTO pipeline_phases (id, key, name, position, updated_at)
                           VALUES (gen_random_uuid()::text, 'zz_tx2', 'ZZ', 1, timezone('utc', now()))`;
    });
    expect(activeInside).toBe(1);
    const rows = await pipelineRead((db) => db.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pipeline_phases`);
    expect(rows[0].n).toBe(1);
    expect(pipelineGate.stats().active).toBe(0);
  });

  it("the gate is sized from the pipeline pool (1 connection in the main suite)", () => {
    expect(pipelineGate.stats()).toMatchObject({ max: 1, queue: 100, maxWaitMs: 2000 });
  });
});
