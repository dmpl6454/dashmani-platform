import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  withHeavyQuerySlot,
  heavyQueryGateStats,
  resetHeavyQueryGateForTests,
} from "../src/utils/heavy-query";
import { AppError } from "../src/middleware/error-handler";

// The bulkhead's contract: at most HEAVY_QUERY_CONCURRENCY (default 2) heavy computes
// run at once; the rest WAIT without holding a pool connection and, past the wait
// ceiling, fail with a clean 503 REPORTS_BUSY — never a 500, never a hang.
describe("withHeavyQuerySlot (bulkhead)", () => {
  beforeEach(() => resetHeavyQueryGateForTests());
  afterEach(() => { vi.useRealTimers(); resetHeavyQueryGateForTests(); });

  function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }

  it("runs up to the cap concurrently and queues the rest until a slot frees", async () => {
    const { maxConcurrent } = heavyQueryGateStats();
    expect(maxConcurrent).toBe(2);
    const d1 = deferred<string>(), d2 = deferred<string>(), d3 = deferred<string>();
    let started3 = false;
    const p1 = withHeavyQuerySlot("t1", () => d1.promise);
    const p2 = withHeavyQuerySlot("t2", () => d2.promise);
    const p3 = withHeavyQuerySlot("t3", async () => { started3 = true; return d3.promise; });
    await Promise.resolve();
    expect(heavyQueryGateStats()).toMatchObject({ active: 2, queued: 1 });
    expect(started3).toBe(false);

    d1.resolve("one");
    await p1;
    await Promise.resolve();
    expect(started3).toBe(true);
    expect(heavyQueryGateStats()).toMatchObject({ active: 2, queued: 0 });

    d2.resolve("two"); d3.resolve("three");
    expect(await Promise.all([p2, p3])).toEqual(["two", "three"]);
    expect(heavyQueryGateStats().active).toBe(0);
  });

  it("releases the slot when the compute rejects", async () => {
    await expect(withHeavyQuerySlot("bad", async () => { throw new Error("x"); })).rejects.toThrow("x");
    expect(heavyQueryGateStats().active).toBe(0);
  });

  it("times out a queued caller with a 503 REPORTS_BUSY AppError, and later callers still get slots", async () => {
    vi.useFakeTimers();
    const { maxWaitMs } = heavyQueryGateStats();
    const d1 = deferred<void>(), d2 = deferred<void>();
    const p1 = withHeavyQuerySlot("h1", () => d1.promise);
    const p2 = withHeavyQuerySlot("h2", () => d2.promise);
    const p3 = withHeavyQuerySlot("h3", async () => "never");
    const p3Result = p3.then(() => "resolved", (e) => e);
    vi.advanceTimersByTime(maxWaitMs + 1);
    const err = await p3Result;
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(503);
    expect((err as AppError).code).toBe("REPORTS_BUSY");
    expect(heavyQueryGateStats()).toMatchObject({ active: 2, queued: 0 });

    d1.resolve(); d2.resolve();
    await Promise.all([p1, p2]);
    expect(await withHeavyQuerySlot("h4", async () => "ok")).toBe("ok");
  });
});
