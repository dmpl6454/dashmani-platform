/**
 * social-insights-write-dedupe.test.ts — the 2026-09-18 write path.
 *
 * link_metrics is an append-only per-poll log. Once the Instagram provider could poll
 * its whole window every 2h, the log grew ~850k rows/day — 760k of them identical
 * `not_found` re-polls — and the "latest per link" reads took minutes and took the
 * pool (and login) down. The cron now:
 *   • looks up the latest stored snapshot per link ONCE per batch,
 *   • SKIPS appending a log row when the poll result is byte-identical to it,
 *   • upserts link_metrics_latest (the read model) on EVERY ok poll regardless,
 *   • re-heals link_metrics_latest link_ids after the sweep, like link_metrics.
 * The lookup/upsert are mocked here (they are DB-backed and tested in
 * link-metrics-latest.test.ts); this test locks the cron's DECISIONS.
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

// The latest-state service is mocked so this test drives the cron's decisions only.
// isIdenticalSnapshot is the REAL implementation (pure).
vi.mock("../src/services/link-metrics-latest.service", async () => {
  const actual = await vi.importActual<typeof import("../src/services/link-metrics-latest.service")>(
    "../src/services/link-metrics-latest.service",
  );
  return {
    isIdenticalSnapshot: actual.isIdenticalSnapshot,
    // ⚠️ REAL implementations, not stubs — these encode the cron's append/skip
    // DECISION, which is exactly what this file exists to lock.
    isViewsOnlyChange: actual.isViewsOnlyChange,
    shouldAppendSnapshot: actual.shouldAppendSnapshot,
    VIEWS_ONLY_MIN_INTERVAL_MS: actual.VIEWS_ONLY_MIN_INTERVAL_MS,
    findLatestSnapshotsByLinkIds: vi.fn(async () => new Map()),
    upsertLinkMetricLatest: vi.fn(async () => true),
    rehealLinkMetricLatest: vi.fn(async () => 0),
  };
});

type Result = { ok: boolean; status: string; views?: number | null; likes?: number | null; comments?: number | null; shares?: number | null; error?: string };
let resultsByLink = new Map<string, Result>();

const fakeProvider = {
  slug: "instagram",
  isSupported: () => true,
  extractTargetId: (u: string) => u,
  fetchBatch: vi.fn(async (batch: Array<{ linkId: string }>) => {
    const m = new Map<string, Result>();
    for (const t of batch) m.set(t.linkId, resultsByLink.get(t.linkId)!);
    return m;
  }),
  // No harvestContent on purpose: keeps the run to the metric sweep.
};

vi.mock("../src/services/social-insights", () => ({
  getSupportedSlugs: () => ["instagram"],
  getProvider: () => fakeProvider,
}));
vi.mock("../src/services/social-insights/youtube.provider", () => ({ youTubeQuotaExceeded: false }));
vi.mock("../src/services/link-content.service", () => ({ upsertLinkContent: vi.fn(() => Promise.resolve(undefined)) }));

import { prisma } from "@dashmani/db";
import {
  findLatestSnapshotsByLinkIds,
  upsertLinkMetricLatest,
  rehealLinkMetricLatest,
  isIdenticalSnapshot,
} from "../src/services/link-metrics-latest.service";
import { runSocialInsightsRefresh, resetSocialInsightsRunStateForTests } from "../src/cron/social-insights.cron";

const mockFindMany = prisma.reportLink.findMany as ReturnType<typeof vi.fn>;
const mockCreate = prisma.linkMetric.create as ReturnType<typeof vi.fn>;
const mockLookup = findLatestSnapshotsByLinkIds as ReturnType<typeof vi.fn>;
const mockUpsert = upsertLinkMetricLatest as ReturnType<typeof vi.fn>;
const mockReheal = rehealLinkMetricLatest as ReturnType<typeof vi.fn>;

const LINKS = ["L1", "L2", "L3"].map((id, i) => ({
  id,
  url: `https://www.instagram.com/reel/${id}/`,
  platform: "instagram",
  report: { employeeId: "emp1", date: new Date("2026-09-10T00:00:00Z") },
}));

// The tiered queue issues one findMany per tier; hand ALL links to the first call and
// nothing to the others so each link is polled exactly once per run.
function armLinks() {
  mockFindMany.mockReset();
  mockFindMany.mockResolvedValueOnce(LINKS);
  mockFindMany.mockResolvedValue([]);
}

async function run() {
  resetSocialInsightsRunStateForTests();
  armLinks();
  await runSocialInsightsRefresh();
}

function createdLinkIds(): string[] {
  return mockCreate.mock.calls.map((c: any[]) => c[0].data.linkId);
}

describe("social-insights cron — write dedupe + latest-state upsert", () => {
  beforeEach(() => {
    mockCreate.mockClear();
    mockUpsert.mockClear();
    mockReheal.mockClear();
    mockLookup.mockReset();
    mockLookup.mockResolvedValue(new Map());
    resultsByLink = new Map([
      ["L1", { ok: true, status: "ok", views: 100, likes: 10, comments: 1, shares: null }],
      ["L2", { ok: true, status: "ok", views: null, likes: 5, comments: 0, shares: null }],
      ["L3", { ok: false, status: "not_found", error: "gone" }],
    ]);
  });
  afterEach(() => vi.restoreAllMocks());

  it("first sight: appends a log row for every result, upserts latest for ok results only", async () => {
    await run();
    expect(createdLinkIds().sort()).toEqual(["L1", "L2", "L3"]);
    expect(mockUpsert).toHaveBeenCalledTimes(2);
    const upserted = mockUpsert.mock.calls.map((c: any[]) => c[0]);
    expect(upserted.map((u: any) => u.linkId).sort()).toEqual(["L1", "L2"]);
    expect(upserted.find((u: any) => u.linkId === "L1")).toMatchObject({
      employeeId: "emp1", platform: "instagram", views: 100, likes: 10, comments: 1, shares: null,
      urlNormalized: "https://www.instagram.com/reel/l1/",
    });
    expect(mockReheal).toHaveBeenCalledTimes(1);
    expect(mockReheal).toHaveBeenCalledWith("instagram");
    // The dedupe reference is fetched once per batch with the batch's link ids.
    expect(mockLookup).toHaveBeenCalledTimes(1);
    expect((mockLookup.mock.calls[0][0] as string[]).sort()).toEqual(["L1", "L2", "L3"]);
  });

  it("identical re-poll: NO new log row for any link, but ok links still refresh the latest row", async () => {
    mockLookup.mockResolvedValue(new Map([
      ["L1", { status: "ok", views: 100, likes: 10, comments: 1, shares: null }],
      ["L2", { status: "ok", views: null, likes: 5, comments: 0, shares: null }],
      ["L3", { status: "not_found", views: null, likes: null, comments: null, shares: null }],
    ]));
    await run();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockUpsert).toHaveBeenCalledTimes(2); // fetched_at bump keeps the staleness chip honest
    expect(mockUpsert.mock.calls.map((c: any[]) => c[0].linkId).sort()).toEqual(["L1", "L2"]);
  });

  it("changed metrics or changed status → a new log row for exactly those links", async () => {
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    mockLookup.mockResolvedValue(new Map([
      ["L1", { status: "ok", views: 100, likes: 10, comments: 1, shares: null, fetchedAt: hourAgo }],
      ["L2", { status: "ok", views: null, likes: 5, comments: 0, shares: null, fetchedAt: hourAgo }],
      ["L3", { status: "not_found", views: null, likes: null, comments: null, shares: null, fetchedAt: hourAgo }],
    ]));
    // L1: likes moved TOO, so it appends immediately — a views-only tick would not.
    resultsByLink.set("L1", { ok: true, status: "ok", views: 150, likes: 11, comments: 1, shares: null });
    resultsByLink.set("L3", { ok: true, status: "ok", views: 7, likes: 1, comments: 0, shares: null }); // not_found → ok (the 94% FB recovery class)
    await run();
    expect(createdLinkIds().sort()).toEqual(["L1", "L3"]);
    expect(mockUpsert).toHaveBeenCalledTimes(3);
  });

  /**
   * ⚠️ THE GROWTH GUARD (2026-09-19). Instagram views became real, so a view tick is now
   * the only difference between two consecutive polls of an unchanged post. Without a
   * floor that defeats the whole 2026-09-18 dedupe: measured on prod, one IG sweep polls
   * 68,827 links and suppresses 67,190 — ~9,175 ok polls x 12 sweeps/day would append
   * ~110,000 rows/day against today's ~37,900, on a table already at 14.8M rows / 11GB.
   */
  it("a views-ONLY tick appends nothing while the stored row is fresh, but STILL refreshes the latest row", async () => {
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    mockLookup.mockResolvedValue(new Map([
      ["L1", { status: "ok", views: 100, likes: 10, comments: 1, shares: null, fetchedAt: hourAgo }],
    ]));
    resultsByLink.set("L1", { ok: true, status: "ok", views: 150, likes: 10, comments: 1, shares: null });
    await run();
    // L2/L3 have no stored snapshot in this fixture, so they append (first sight) —
    // the claim under test is only about L1.
    expect(createdLinkIds()).not.toContain("L1");
    // The read model every portal path uses is still updated — only the history is skipped.
    expect(mockUpsert).toHaveBeenCalledTimes(2);
  });

  it("the same views-only tick DOES append once the stored row is a day old", async () => {
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    mockLookup.mockResolvedValue(new Map([
      ["L1", { status: "ok", views: 100, likes: 10, comments: 1, shares: null, fetchedAt: twoDaysAgo }],
    ]));
    resultsByLink.set("L1", { ok: true, status: "ok", views: 150, likes: 10, comments: 1, shares: null });
    await run();
    expect(createdLinkIds()).toContain("L1");
  });

  it("FAIL-OPEN: a lookup failure writes every result (the pre-2026-09-18 behaviour) and does not stop the sweep", async () => {
    mockLookup.mockRejectedValue(new Error("db hiccup"));
    await run();
    expect(createdLinkIds().sort()).toEqual(["L1", "L2", "L3"]);
    expect(mockUpsert).toHaveBeenCalledTimes(2);
  });

  it("a failing latest upsert never blocks the snapshot write or the next link", async () => {
    mockUpsert.mockRejectedValue(new Error("latest table missing"));
    await run();
    expect(createdLinkIds().sort()).toEqual(["L1", "L2", "L3"]);
  });
});

describe("isIdenticalSnapshot (pure)", () => {
  const prev = { status: "ok", views: 10, likes: null, comments: 2, shares: null };
  it("same status + same metrics → identical; undefined and null are the same absence", () => {
    expect(isIdenticalSnapshot(prev, { status: "ok", views: 10, comments: 2 })).toBe(true);
    expect(isIdenticalSnapshot(prev, { status: "ok", views: 10, likes: undefined, comments: 2, shares: undefined })).toBe(true);
  });
  it("any metric or the status differing → not identical", () => {
    expect(isIdenticalSnapshot(prev, { status: "ok", views: 11, comments: 2 })).toBe(false);
    expect(isIdenticalSnapshot(prev, { status: "ok", views: 10, likes: 0, comments: 2 })).toBe(false);
    expect(isIdenticalSnapshot(prev, { status: "not_found" })).toBe(false);
  });
  it("error text is deliberately ignored (repeated failures with changing messages still dedupe)", () => {
    const p = { status: "error", views: null, likes: null, comments: null, shares: null };
    expect(isIdenticalSnapshot(p, { status: "error", error: "timeout at 12:01" })).toBe(true);
  });
});
