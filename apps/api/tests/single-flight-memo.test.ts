import { describe, it, expect, vi, afterEach } from "vitest";
import { createSingleFlightMemo } from "../src/utils/single-flight-memo";

// The property that matters for the pool: N concurrent COLD callers for one key
// must share ONE compute (one DB connection), not N.
describe("createSingleFlightMemo", () => {
  afterEach(() => vi.useRealTimers());

  it("collapses concurrent cold callers into a single compute", async () => {
    const m = createSingleFlightMemo({ ttlMs: 60_000 });
    let calls = 0;
    let release!: (v: number) => void;
    const compute = () => {
      calls++;
      return new Promise<number>((res) => { release = res; });
    };
    const a = m.memo("k", compute);
    const b = m.memo("k", compute);
    const c = m.memo("k", compute);
    expect(calls).toBe(1);
    release(42);
    expect(await Promise.all([a, b, c])).toEqual([42, 42, 42]);
    expect(calls).toBe(1);
  });

  it("serves the cached value inside the TTL and recomputes after it", async () => {
    vi.useFakeTimers();
    const m = createSingleFlightMemo({ ttlMs: 1_000 });
    let calls = 0;
    const compute = async () => ++calls;
    expect(await m.memo("k", compute)).toBe(1);
    expect(await m.memo("k", compute)).toBe(1);
    vi.advanceTimersByTime(1_001);
    expect(await m.memo("k", compute)).toBe(2);
  });

  it("keys are independent", async () => {
    const m = createSingleFlightMemo({ ttlMs: 60_000 });
    expect(await m.memo("a", async () => "A")).toBe("A");
    expect(await m.memo("b", async () => "B")).toBe("B");
    expect(m.size()).toBe(2);
  });

  it("self-evicts a rejected compute so the next caller retries (never caches a failure)", async () => {
    const m = createSingleFlightMemo({ ttlMs: 60_000 });
    let calls = 0;
    const failing = async () => { calls++; throw new Error("boom"); };
    await expect(m.memo("k", failing)).rejects.toThrow("boom");
    expect(m.size()).toBe(0);
    expect(await m.memo("k", async () => { calls++; return "ok"; })).toBe("ok");
    expect(calls).toBe(2);
  });

  it("a synchronous throw inside compute becomes a rejection, not an uncaught exception", async () => {
    const m = createSingleFlightMemo({ ttlMs: 60_000 });
    await expect(m.memo("k", () => { throw new Error("sync"); })).rejects.toThrow("sync");
    expect(m.size()).toBe(0);
  });

  it("bounds the entry count: sweeps expired entries first, hard-clears as a last resort", async () => {
    vi.useFakeTimers();
    const m = createSingleFlightMemo({ ttlMs: 1_000, maxEntries: 3 });
    await m.memo("a", async () => 1);
    await m.memo("b", async () => 1);
    await m.memo("c", async () => 1);
    expect(m.size()).toBe(3);
    // All three expire → the 4th insert sweeps them instead of clearing blindly.
    vi.advanceTimersByTime(1_001);
    await m.memo("d", async () => 1);
    expect(m.size()).toBe(1);
    // Fill again with LIVE entries → hard clear on overflow (bounded, never unbounded).
    await m.memo("e", async () => 1);
    await m.memo("f", async () => 1);
    expect(m.size()).toBe(3);
    await m.memo("g", async () => 1);
    expect(m.size()).toBe(1);
  });

  it("clear() drops everything (the test-isolation hook)", async () => {
    const m = createSingleFlightMemo({ ttlMs: 60_000 });
    await m.memo("a", async () => 1);
    m.clear();
    expect(m.size()).toBe(0);
  });
});
