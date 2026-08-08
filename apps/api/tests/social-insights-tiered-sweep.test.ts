/**
 * social-insights-tiered-sweep.test.ts — regression tests for the tiered priority
 * sweep (2026-08-08).
 *
 * Bug: the metric sweep used ONE `id ASC` queue + one resume cursor. `id ASC` is
 * content-blind, so a ~90k-link Instagram window was walked in arbitrary order under
 * a 25-min budget — a full wrap took days, producing a measured ~21-day median metric
 * age on IG (~6.3d on FB). Links with millions of views were missing from Top Links or
 * ranked on three-week-old numbers. 52,910 of those IG links were OLD posts whose
 * latest status was `not_found` (the Meta feed-window ceiling), sitting AHEAD of
 * today's posts purely because their ids sorted first.
 *
 * Fix: order the queue fresh → unresolved → settled, each older tier with its own
 * cursor. Same call volume, same budget — just spent on what matters first.
 *
 * ⚠️ The critical invariant these tests protect: tiers only RE-ORDER, they NEVER
 * exclude. A "skip not_found" blacklist was rejected because such links recover
 * 94.4% of the time on FB and 18.2% on IG — blacklisting would have silently deleted
 * ~24k resolvable links from the rankings.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock prisma before importing the cron ──────────────────────────────────

const reportLinkFindMany = vi.fn();
const queryRawMock = vi.fn();
const systemSettingFindUnique = vi.fn();
const systemSettingUpsert = vi.fn();

vi.mock("@dashmani/db", () => ({
  prisma: {
    systemSetting: {
      findUnique: (...a: unknown[]) => systemSettingFindUnique(...a),
      upsert: (...a: unknown[]) => systemSettingUpsert(...a),
    },
    reportLink: {
      findMany: (...a: unknown[]) => reportLinkFindMany(...a),
    },
    linkMetric: {
      create: vi.fn(() => Promise.resolve({})),
    },
    $queryRaw: (...a: unknown[]) => queryRawMock(...a),
    $executeRaw: vi.fn(() => Promise.resolve(0)),
  },
}));

vi.mock("@dashmani/shared", () => ({
  extractYouTubeVideoId: vi.fn(() => null),
  canonicalKey: vi.fn((url: string) => `ig:${url}`),
}));

// ── Fake provider ──────────────────────────────────────────────────────────

const polledOrder: string[] = [];

const fakeProvider = {
  slug: "instagram",
  isSupported: () => true,
  extractTargetId: (u: string) => u,
  fetchBatch: vi.fn(async (batch: Array<{ linkId: string }>) => {
    const m = new Map();
    for (const t of batch) {
      polledOrder.push(t.linkId);
      m.set(t.linkId, {
        ok: true,
        status: "ok",
        views: 1,
        likes: 1,
        comments: 1,
        shares: null,
        title: null,
        caption: null,
      });
    }
    return m;
  }),
  harvestContent: vi.fn(async () => []),
};

vi.mock("../src/services/social-insights", () => ({
  getSupportedSlugs: () => ["instagram"],
  getProvider: () => fakeProvider,
}));

vi.mock("../src/services/social-insights/youtube.provider", () => ({
  youTubeQuotaExceeded: false,
}));

vi.mock("../src/services/link-content.service", () => ({
  upsertLinkContent: vi.fn(async () => {}),
}));

import { runSocialInsightsRefresh } from "../src/cron/social-insights.cron";

const DAY = 86_400_000;
const link = (id: string, ageDays: number) => ({
  id,
  url: `https://instagram.com/reel/${id}`,
  platform: "instagram",
  report: { employeeId: "emp1", date: new Date(Date.now() - ageDays * DAY) },
});

/**
 * The tier builder issues reportLink.findMany TWICE: first for the fresh tier
 * (report.date >= cutoff), then for the older tail (report.date < cutoff). We
 * route by inspecting the date filter so the mock mirrors real partitioning.
 */
function wireLinks(fresh: ReturnType<typeof link>[], older: ReturnType<typeof link>[]) {
  reportLinkFindMany.mockImplementation((args: any) => {
    const dateFilter = args?.where?.report?.date ?? {};
    if (dateFilter.gte !== undefined && dateFilter.lt === undefined) return Promise.resolve(fresh);
    if (dateFilter.lt !== undefined) return Promise.resolve(older);
    return Promise.resolve([...fresh, ...older]);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  polledOrder.length = 0;
  systemSettingFindUnique.mockResolvedValue(null); // no cursors set
  systemSettingUpsert.mockResolvedValue({});
  queryRawMock.mockResolvedValue([]);
});

describe("tiered priority sweep", () => {
  it("polls fresh links before the older tail, regardless of id order", async () => {
    // 'a-old' sorts FIRST by id but is an old post; 'z-fresh' sorts LAST but is recent.
    // Under the old `id ASC` queue 'a-old' won. Fresh must now come first.
    wireLinks([link("z-fresh", 1)], [link("a-old", 40)]);

    await runSocialInsightsRefresh();

    expect(polledOrder[0]).toBe("z-fresh");
    expect(polledOrder).toContain("a-old");
  });

  it("orders the older tail unresolved-before-settled", async () => {
    // 'b-settled' has a latest `ok` metric; 'c-unresolved' does not. Even though
    // 'b-settled' sorts first by id, the unresolved link must be polled first —
    // it is the coverage gap, the settled one is already in the rankings.
    wireLinks([], [link("b-settled", 40), link("c-unresolved", 40)]);
    queryRawMock.mockResolvedValue([{ link_id: "b-settled" }]);

    await runSocialInsightsRefresh();

    expect(polledOrder.indexOf("c-unresolved")).toBeLessThan(polledOrder.indexOf("b-settled"));
  });

  it("NEVER excludes a link — settled and unresolved are both still polled", async () => {
    // The load-bearing invariant. Tiers re-order; they must not blacklist. A
    // not_found link recovers 94.4% of the time on FB / 18.2% on IG.
    wireLinks([link("f1", 1)], [link("o1", 40), link("o2", 40)]);
    queryRawMock.mockResolvedValue([{ link_id: "o1" }]);

    await runSocialInsightsRefresh();

    expect(new Set(polledOrder)).toEqual(new Set(["f1", "o1", "o2"]));
  });

  it("writes per-tier cursors, and never a fresh-tier id", async () => {
    // Fresh links have NO cursor (always re-polled from the start). Writing a
    // fresh id into an older tier's cursor would rotate that tier to a bogus
    // position, since ids reset downward at each tier boundary.
    wireLinks([link("zzz-fresh", 1)], [link("aaa-old", 40)]);

    await runSocialInsightsRefresh();

    const keys = systemSettingUpsert.mock.calls.map((c: any) => c[0].where.key);
    expect(keys).toContain("insights-cursor:instagram:unresolved");
    expect(keys).toContain("insights-cursor:instagram:settled");

    const wroteFreshId = systemSettingUpsert.mock.calls.some(
      (c: any) => c[0].create.value === "zzz-fresh",
    );
    expect(wroteFreshId).toBe(false);
  });

  it("resumes an older tier past its persisted cursor", async () => {
    systemSettingFindUnique.mockImplementation((args: any) =>
      args.where.key === "insights-cursor:instagram:unresolved"
        ? Promise.resolve({ key: args.where.key, value: "o1" })
        : Promise.resolve(null),
    );
    wireLinks([], [link("o1", 40), link("o2", 40), link("o3", 40)]);

    await runSocialInsightsRefresh();

    // o1 is at/behind the cursor → skipped this run; the tail continues after it.
    expect(polledOrder).not.toContain("o1");
    expect(polledOrder).toEqual(["o2", "o3"]);
  });

  it("falls back to the legacy single queue if the tier build throws", async () => {
    // Fail-open: a tier-build failure must degrade freshness, never stop the sweep.
    queryRawMock.mockRejectedValue(new Error("db exploded"));
    reportLinkFindMany.mockImplementation((args: any) => {
      const d = args?.where?.report?.date ?? {};
      if (d.gte !== undefined && d.lt === undefined && args?.where?.id === undefined) {
        // fresh-tier call (succeeds) then the older call throws via $queryRaw
        return Promise.resolve([link("fresh1", 1)]);
      }
      return Promise.resolve([link("legacy1", 40)]);
    });

    await runSocialInsightsRefresh();

    expect(polledOrder).toContain("legacy1");
  });
});
