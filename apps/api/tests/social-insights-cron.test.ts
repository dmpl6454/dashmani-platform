/**
 * social-insights-cron.test.ts — regression test for the metric-sweep budget
 * clock starvation bug (2026-07-03).
 *
 * Bug: for owned-feed providers (Instagram/Facebook), the FIRST fetchBatch()
 * call internally builds and caches a full feed map (paging thousands of
 * captions) — this alone can consume most of the per-provider budget. But the
 * old code set `slugDeadline = Date.now() + SWEEP_BUDGET_MS` BEFORE the first
 * batch ran, so by the time the map build finished and the early harvest
 * fired, the budget was already spent — the loop yielded after polling only
 * ~1 batch instead of continuing through the cheap per-link polling phase.
 *
 * Fix: rebase the budget clock to start counting from the moment the early
 * harvest fires (map already built + cached), not from before the first
 * batch. This test simulates a 26-minute map-build cost inside the FIRST
 * fetchBatch call and asserts the loop still polls multiple subsequent
 * batches instead of stopping after just one.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock prisma before importing the cron ──────────────────────────────────

vi.mock("@dashmani/db", () => ({
  prisma: {
    systemSetting: {
      findUnique: vi.fn(() => Promise.resolve(null)),
      upsert: vi.fn(() => Promise.resolve({})),
    },
    reportLink: {
      findMany: vi.fn(() => Promise.resolve([])),
    },
    linkMetric: {
      create: vi.fn(() => Promise.resolve({})),
    },
    // Used by buildTieredQueue to find links whose LATEST metric is `ok` (the
    // "settled" tier). Must be mocked or the tier build throws and the cron
    // silently falls back to the legacy single-cursor queue — which would make
    // this budget-clock regression test pass for the wrong reason.
    $queryRaw: vi.fn(() => Promise.resolve([])),
    $executeRaw: vi.fn(() => Promise.resolve(0)),
  },
}));

vi.mock("@dashmani/shared", () => ({
  extractYouTubeVideoId: vi.fn(() => null),
  canonicalKey: vi.fn((url: string) => `ig:${url}`),
}));

// ── Fake provider wired via mocked registry ────────────────────────────────

let batchCalls = 0;
let harvestFlushedAtCall = -1;
let now = 0;

const fakeProvider = {
  slug: "instagram",
  isSupported: () => true,
  extractTargetId: (u: string) => u, // treat url as its own id
  fetchBatch: vi.fn(async (batch: Array<{ linkId: string }>) => {
    batchCalls++;
    if (batchCalls === 1) now += 26 * 60 * 1000; // simulate the 26-min map build
    const m = new Map();
    for (const t of batch) {
      m.set(t.linkId, {
        ok: true,
        status: "ok",
        views: 1,
        likes: 1,
        comments: 1,
        shares: null,
        title: null,
        caption: "c",
      });
    }
    return m;
  }),
  harvestContent: vi.fn(() => {
    harvestFlushedAtCall = batchCalls;
    return [{ canonicalKey: "ig:abc", caption: "c", title: null }];
  }),
};

vi.mock("../src/services/social-insights", () => ({
  getSupportedSlugs: () => ["instagram"],
  getProvider: () => fakeProvider,
}));

vi.mock("../src/services/social-insights/youtube.provider", () => ({
  youTubeQuotaExceeded: false,
}));

vi.mock("../src/services/link-content.service", () => ({
  upsertLinkContent: vi.fn(() => Promise.resolve(undefined)),
}));

// ── Import after mocks ──────────────────────────────────────────────────────

import { prisma } from "@dashmani/db";
import { runSocialInsightsRefresh } from "../src/cron/social-insights.cron";

const mockFindMany = prisma.reportLink.findMany as ReturnType<typeof vi.fn>;

function makeFakeLinks(count: number) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    rows.push({
      id: `link-${i}`,
      url: `https://www.instagram.com/reel/${i}/`,
      platform: "instagram",
      report: { employeeId: "emp1", date: new Date("2026-07-01T00:00:00Z") },
    });
  }
  return rows;
}

describe("social-insights cron — metric budget clock starts after harvest, not before map build", () => {
  beforeEach(() => {
    now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    batchCalls = 0;
    harvestFlushedAtCall = -1;
    fakeProvider.fetchBatch.mockClear();
    fakeProvider.harvestContent.mockClear();
    mockFindMany.mockResolvedValue(makeFakeLinks(250)); // 250 / 50 per batch = 5 batches
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not exhaust the budget on the map-build phase — polls multiple batches after harvest", async () => {
    await runSocialInsightsRefresh();

    expect(harvestFlushedAtCall).toBe(1);
    expect(batchCalls).toBeGreaterThanOrEqual(5);
  });

  it("HARD backstop yields once 2× METRIC_BUDGET_MS elapses even when harvest never fires (empty map)", async () => {
    // harvestContent() returns an EMPTY array every call → harvestedThisRun never flips
    // true → slugDeadline stays Number.MAX_SAFE_INTEGER → the SOFT check can never fire.
    // Only the HARD backstop (measured from runStartedForSlug) can stop the loop.
    fakeProvider.harvestContent.mockImplementation(() => {
      harvestFlushedAtCall = batchCalls;
      return [];
    });
    // Each batch call advances the clock by 20 minutes. With METRIC_BUDGET_MS defaulting
    // to 25 min, the HARD backstop (2× = 50 min) trips partway through the 5 available
    // batches — well before all 5 would run if there were no backstop at all.
    fakeProvider.fetchBatch.mockImplementation(async (batch: Array<{ linkId: string }>) => {
      batchCalls++;
      now += 20 * 60 * 1000;
      const m = new Map();
      for (const t of batch) {
        m.set(t.linkId, { ok: true, status: "ok", views: 1, likes: 1, comments: 1, shares: null, title: null, caption: "c" });
      }
      return m;
    });

    await runSocialInsightsRefresh();

    // The map never had content, so harvestedThisRun never became true — the harvest
    // was attempted every batch (no early exit from the empty-map guard).
    expect(harvestFlushedAtCall).toBeGreaterThanOrEqual(0);
    // The HARD backstop must have yielded before all 5 batches ran.
    expect(batchCalls).toBeLessThan(5);
    expect(batchCalls).toBeGreaterThanOrEqual(1);
  });
});
