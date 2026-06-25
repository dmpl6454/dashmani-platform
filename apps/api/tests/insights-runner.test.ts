/**
 * insights-runner.test.ts
 *
 * Tests for the in-memory singleton that coordinates on-demand enrichment runs.
 * The two cron functions are mocked so the tests stay deterministic and fast
 * (no DB or network required).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks — must be declared before the module-under-test is imported ────────

// We need controllable promises so we can assert the concurrent-trigger guard
// while a run is still in flight.
let resolveHarvest!: () => void;
let rejectHarvest!: (err: Error) => void;
let harvestPromise: Promise<void>;

let resolveExtract!: () => void;
let extractPromise: Promise<void>;

function resetPromises() {
  harvestPromise = new Promise<void>((res, rej) => {
    resolveHarvest = res;
    rejectHarvest = rej;
  });
  extractPromise = new Promise<void>((res) => {
    resolveExtract = res;
  });
}

// vi.mock is hoisted before imports, so the factory runs in the correct order.
vi.mock("../src/cron/social-insights.cron", () => ({
  runSocialInsightsRefresh: vi.fn(() => harvestPromise),
}));

vi.mock("../src/cron/entity-extraction.cron", () => ({
  runEntityExtraction: vi.fn(() => extractPromise),
}));

// Import AFTER mocks are declared so the module gets the mock implementations.
import { getInsightsRunState, triggerInsightsRun } from "../src/services/insights-runner";
import { runSocialInsightsRefresh } from "../src/cron/social-insights.cron";
import { runEntityExtraction } from "../src/cron/entity-extraction.cron";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Yield control back to the micro-task queue so async IIFE continuations run.
 * Equivalent to a single "tick" without relying on real timers.
 */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const ticks = (n: number) => Array.from({ length: n }).reduce((p) => (p as Promise<void>).then(tick), tick()) as Promise<void>;

// ── Reset singleton state between tests ─────────────────────────────────────
// The singleton is module-level state; we reset it by accessing the exported
// functions. Between tests we ensure a clean slate by waiting for any in-flight
// run to settle, then resetting the mock promises.

beforeEach(async () => {
  // Drain any leftover in-flight run from a previous test by resolving both promises.
  resolveHarvest?.();
  resolveExtract?.();
  await ticks(4);

  vi.clearAllMocks();
  resetPromises();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("initial state", () => {
  it("starts idle with all-null fields", async () => {
    // After beforeEach drains any leftover, the module should be back to idle.
    const s = getInsightsRunState();
    expect(s.running).toBe(false);
    expect(s.phase).toBe("idle");
    expect(s.startedAt).toBeNull();
    expect(s.finishedAt).toBeNull();
    expect(s.lastError).toBeNull();
    expect(s.trigger).toBeNull();
    expect(s.durationMs).toBeNull();
  });
});

describe("triggerInsightsRun — happy path", () => {
  it("returns {started:true, running:true} and sets phase to harvesting", () => {
    const result = triggerInsightsRun("manual");

    expect(result).toEqual({ started: true, running: true });

    const s = getInsightsRunState();
    expect(s.running).toBe(true);
    expect(s.phase).toBe("harvesting");
    expect(s.trigger).toBe("manual");
    expect(s.startedAt).not.toBeNull();
    expect(s.finishedAt).toBeNull();
    expect(s.lastError).toBeNull();
    expect(vi.mocked(runSocialInsightsRefresh)).toHaveBeenCalledTimes(1);
  });

  it("passes {harvestOnly:true} for manual trigger — skips metric sweep", () => {
    triggerInsightsRun("manual");
    expect(vi.mocked(runSocialInsightsRefresh)).toHaveBeenCalledWith({ harvestOnly: true });
  });

  it("passes {harvestOnly:false} for scheduled trigger — runs full metric sweep", () => {
    triggerInsightsRun("scheduled");
    expect(vi.mocked(runSocialInsightsRefresh)).toHaveBeenCalledWith({ harvestOnly: false });
  });

  it("transitions to extracting after harvest resolves", async () => {
    triggerInsightsRun();

    resolveHarvest();
    await ticks(2); // let the IIFE continue past await runSocialInsightsRefresh

    const s = getInsightsRunState();
    expect(s.phase).toBe("extracting");
    expect(s.running).toBe(true);
    expect(vi.mocked(runEntityExtraction)).toHaveBeenCalledTimes(1);
  });

  it("returns to idle with finishedAt and durationMs after both crons complete", async () => {
    triggerInsightsRun();

    resolveHarvest();
    await ticks(2);
    resolveExtract();
    await ticks(2);

    const s = getInsightsRunState();
    expect(s.running).toBe(false);
    expect(s.phase).toBe("idle");
    expect(s.finishedAt).not.toBeNull();
    expect(s.durationMs).not.toBeNull();
    expect(typeof s.durationMs).toBe("number");
    expect(s.lastError).toBeNull();
  });

  it("getInsightsRunState returns a COPY — mutating the return value does not affect the singleton", async () => {
    triggerInsightsRun();

    const snap = getInsightsRunState();
    (snap as any).running = false; // mutate the copy

    const fresh = getInsightsRunState();
    expect(fresh.running).toBe(true); // singleton is unaffected
  });
});

describe("triggerInsightsRun — concurrent-trigger guard", () => {
  it("returns {started:false, running:true} when called while a run is in flight", () => {
    // First trigger — starts a run (harvest promise left pending).
    triggerInsightsRun("manual");
    expect(getInsightsRunState().running).toBe(true);

    // Second trigger — must be a no-op.
    const second = triggerInsightsRun("manual");
    expect(second).toEqual({ started: false, running: true });

    // runSocialInsightsRefresh must not have been called a second time.
    expect(vi.mocked(runSocialInsightsRefresh)).toHaveBeenCalledTimes(1);
  });

  it("allows a new run AFTER the previous one finishes", async () => {
    triggerInsightsRun();

    resolveHarvest();
    await ticks(2);
    resolveExtract();
    await ticks(2);

    expect(getInsightsRunState().running).toBe(false);

    // Reset promises for the second run.
    resetPromises();
    vi.clearAllMocks();

    const second = triggerInsightsRun("manual");
    expect(second).toEqual({ started: true, running: true });
    expect(vi.mocked(runSocialInsightsRefresh)).toHaveBeenCalledTimes(1);
  });
});

describe("triggerInsightsRun — error handling", () => {
  it("sets lastError and returns to idle when the harvest cron rejects", async () => {
    triggerInsightsRun();

    rejectHarvest(new Error("harvest network timeout"));
    await ticks(4);

    const s = getInsightsRunState();
    expect(s.running).toBe(false);
    expect(s.phase).toBe("idle");
    expect(s.lastError).toBe("harvest network timeout");
    expect(s.finishedAt).not.toBeNull();
    expect(s.durationMs).not.toBeNull();

    // Entity extraction must NOT have been called (harvest threw first).
    expect(vi.mocked(runEntityExtraction)).not.toHaveBeenCalled();
  });

  it("sets lastError when the extraction cron rejects (harvest succeeded)", async () => {
    let rejectExtract!: (err: Error) => void;
    extractPromise = new Promise<void>((_, rej) => {
      rejectExtract = rej;
    });
    // Re-wire the mock for this test only.
    vi.mocked(runEntityExtraction).mockReturnValueOnce(extractPromise);

    triggerInsightsRun();

    resolveHarvest();
    await ticks(2);

    rejectExtract(new Error("extraction quota exceeded"));
    await ticks(4);

    const s = getInsightsRunState();
    expect(s.running).toBe(false);
    expect(s.phase).toBe("idle");
    expect(s.lastError).toBe("extraction quota exceeded");
    expect(s.finishedAt).not.toBeNull();
  });

  it("stores a string representation when a non-Error is thrown", async () => {
    harvestPromise = Promise.reject("string error");
    vi.mocked(runSocialInsightsRefresh).mockReturnValueOnce(harvestPromise);

    triggerInsightsRun();
    await ticks(4);

    const s = getInsightsRunState();
    expect(s.lastError).toBe("string error");
    expect(s.running).toBe(false);
  });
});
