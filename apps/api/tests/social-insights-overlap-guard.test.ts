/**
 * social-insights-overlap-guard.test.ts — regression tests for the 2026-09-08 outage.
 *
 * Incident: the 2-hourly sweep was started by a bare setInterval with NO guard, so a
 * sweep that ran longer than the interval got a concurrent sibling every tick. On
 * 2026-09-08 the 06:27 run stalled in the Instagram phase, 08:27 stacked on top, and
 * after an OOM restart the boot-time run pinned the main thread within minutes — the
 * API was unreachable for 5h44m. Each stacked sweep rebuilt the Meta feed maps and drew
 * from the same ~200-call/hr budget, rate-limiting its siblings.
 *
 * Contract under test:
 *   1. A second call while a run is in flight returns IMMEDIATELY, does no provider work,
 *      and logs a loud "still in progress" warning. It does NOT take over — taking over
 *      cannot stop the old JS, it only adds a second sweep.
 *   2. Once the run completes, the next call runs normally.
 *   3. The guard is released even when the run throws (finally), so one failure cannot
 *      wedge the sweep forever (the follower-sync hung-guard lesson).
 *   4. An in-flight run older than INSIGHTS_STALE_RUN_MS is called out as STALE so the
 *      operator can see a wedged sweep in pm2 logs instead of silent skips.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@dashmani/db", () => ({
  prisma: {
    systemSetting: {
      findUnique: vi.fn(() => Promise.resolve(null)),
      upsert: vi.fn(() => Promise.resolve({})),
    },
    reportLink: { findMany: vi.fn(() => Promise.resolve([])) },
    linkMetric: { create: vi.fn(() => Promise.resolve({})) },
    $queryRaw: vi.fn(() => Promise.resolve([])),
    $executeRaw: vi.fn(() => Promise.resolve(0)),
  },
}));

vi.mock("@dashmani/shared", () => ({
  extractYouTubeVideoId: vi.fn(() => null),
  canonicalKey: vi.fn((url: string) => `ig:${url}`),
}));

// ── Fake provider whose FIRST fetchBatch blocks until the test releases it ──────

let release: (() => void) | null = null;
let fetchCalls = 0;
let now = 0;

const fakeProvider = {
  slug: "instagram",
  isSupported: () => true,
  extractTargetId: (u: string) => u,
  fetchBatch: vi.fn(async (batch: Array<{ linkId: string }>) => {
    fetchCalls++;
    if (fetchCalls === 1) {
      await new Promise<void>((r) => {
        release = r;
      });
    }
    const m = new Map();
    for (const t of batch) {
      m.set(t.linkId, { ok: true, status: "ok", views: 1, likes: 1, comments: 1, shares: null, title: null, caption: "c" });
    }
    return m;
  }),
  harvestContent: vi.fn(() => []),
};

const getSupportedSlugs = vi.fn(() => ["instagram"]);

vi.mock("../src/services/social-insights", () => ({
  getSupportedSlugs: () => getSupportedSlugs(),
  getProvider: () => fakeProvider,
}));

vi.mock("../src/services/social-insights/youtube.provider", () => ({ youTubeQuotaExceeded: false }));
vi.mock("../src/services/link-content.service", () => ({ upsertLinkContent: vi.fn(() => Promise.resolve(undefined)) }));

import { prisma } from "@dashmani/db";
import * as cron from "../src/cron/social-insights.cron";

const { runSocialInsightsRefresh } = cron;
const mockFindMany = prisma.reportLink.findMany as ReturnType<typeof vi.fn>;

function fakeLinks(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `link-${i}`,
    url: `https://www.instagram.com/reel/${i}/`,
    platform: "instagram",
    report: { employeeId: "emp1", date: new Date("2026-09-01T00:00:00Z") },
  }));
}

/** Let the first run advance until it is parked inside fetchBatch #1. */
async function untilBlockedInFetchBatch() {
  for (let i = 0; i < 500 && release === null; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
  if (release === null) throw new Error("first run never reached fetchBatch");
}

describe("social-insights cron — overlap guard (2026-09-08 stacked-sweep outage)", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    release = null;
    fetchCalls = 0;
    fakeProvider.fetchBatch.mockClear();
    getSupportedSlugs.mockClear();
    getSupportedSlugs.mockImplementation(() => ["instagram"]);
    mockFindMany.mockResolvedValue(fakeLinks(60)); // 2 batches
    // Module-level guard state must not leak between tests (the documented
    // cross-test-pollution class — same as invalidateLeaderboardCache()).
    (cron as unknown as { resetSocialInsightsRunStateForTests?: () => void }).resetSocialInsightsRunStateForTests?.();
  });

  afterEach(async () => {
    // Never leave a run parked — release and drain so the next test starts clean.
    if (release) release();
    await new Promise((r) => setTimeout(r, 0));
    vi.restoreAllMocks();
  });

  it("a second call while a run is in flight returns immediately, does no provider work, and warns", async () => {
    const first = runSocialInsightsRefresh();
    await untilBlockedInFetchBatch();
    expect(getSupportedSlugs).toHaveBeenCalledTimes(1);

    const t0 = performance.now();
    await runSocialInsightsRefresh(); // must resolve promptly — it must NOT wait for `first`
    expect(performance.now() - t0).toBeLessThan(500);

    // The second call never entered the provider loop.
    expect(getSupportedSlugs).toHaveBeenCalledTimes(1);
    expect(fakeProvider.fetchBatch).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("still in progress"));

    release!();
    await first;
  });

  it("does not take over a stale run, but calls it out as STALE", async () => {
    const first = runSocialInsightsRefresh();
    await untilBlockedInFetchBatch();

    now += cron.INSIGHTS_STALE_RUN_MS + 60_000;
    await runSocialInsightsRefresh();

    expect(fakeProvider.fetchBatch).toHaveBeenCalledTimes(1); // still only the parked run
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("STALE"));

    release!();
    await first;
  });

  it("runs normally again once the in-flight run has completed", async () => {
    const first = runSocialInsightsRefresh();
    await untilBlockedInFetchBatch();
    release!();
    await first;
    const callsAfterFirst = fakeProvider.fetchBatch.mock.calls.length;
    // 60 mocked links → ≥2 batches (the fresh/older tier queries share one mock, so the
    // exact count is a fixture detail — what matters is the second run does the SAME work).
    expect(callsAfterFirst).toBeGreaterThanOrEqual(2);

    await runSocialInsightsRefresh();
    expect(fakeProvider.fetchBatch.mock.calls.length).toBe(callsAfterFirst * 2);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("still in progress"));
  });

  it("releases the guard when the run throws, so one failure cannot wedge the sweep", async () => {
    getSupportedSlugs.mockImplementationOnce(() => {
      throw new Error("registry exploded");
    });
    await expect(runSocialInsightsRefresh()).rejects.toThrow("registry exploded");

    // Next call must run for real — guard must have been released in `finally`.
    const run = runSocialInsightsRefresh();
    await untilBlockedInFetchBatch();
    release!();
    await run;
    expect(fakeProvider.fetchBatch).toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("still in progress"));
  });
});
