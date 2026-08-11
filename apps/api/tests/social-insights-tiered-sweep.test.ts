/**
 * social-insights-tiered-sweep.test.ts — regression tests for the tiered priority sweep.
 *
 * ORIGINAL BUG (2026-08-08): the metric sweep used ONE `id ASC` queue + one resume cursor.
 * `id ASC` is content-blind, so a ~90k-link Instagram window was walked in arbitrary order
 * under a 25-min budget — a full wrap took days, producing a measured ~21-day median metric
 * age on IG (~6.3d on FB). 52,910 of those IG links were OLD posts whose latest status was
 * `not_found` (the Meta feed-window ceiling), sitting AHEAD of today's posts purely because
 * their uuids sorted first.
 *
 * FIRST FIX ATTEMPT WAS WRONG and these tests encode why. It concatenated the tiers
 * (`[...fresh, ...older]`) and left `fresh` cursorless on the assumption
 * that fresh would be fully covered every run. At prod scale it is not: the IG provider
 * rebuilds its whole feed map inside EVERY fetchBatch, so real throughput is hundreds of
 * links per run while IG's fresh tier alone is ~6.8k. Consequences:
 *   - the budget expired inside `fresh` on every run, so the older tier got ZERO polls
 *     forever — strictly worse than the single cursor it replaced;
 *   - with no fresh cursor, the same lowest-uuid prefix was re-polled forever and every
 *     link past it was PERMANENTLY EXCLUDED;
 *   - cursor persistence wrote "" when a tier was never reached, which is indistinguishable
 *     from "tier completed", destroying real stored progress.
 *
 * CURRENT DESIGN: weighted round-robin interleave (fresh:older = 6:4), every
 * tier has its own cursor, and cursor persistence resolves three distinct outcomes
 * (not-reached / partial / complete).
 *
 * ⚠️ The invariant these tests exist to protect: tiers only RE-ORDER, they NEVER exclude.
 * A "skip not_found" blacklist was rejected because such links later resolve for 94.4% of
 * Facebook and 18.2% of Instagram — blacklisting would delete ~24k resolvable links.
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
 * buildTieredQueue issues reportLink.findMany TWICE — once for fresh
 * (report.date = { gte: freshCutoff }) and once for the older tail
 * (report.date = { gte: since, lt: freshCutoff }). The legacy FALLBACK path issues a third
 * shape (report.date = { gte: since }, no `lt`).
 *
 * Fresh and fallback both have "gte and no lt", so they are distinguished by HOW FAR BACK
 * the bound reaches: fresh is FRESH_DAYS (7d), fallback is POLL_WINDOW_DAYS (60d). A 30-day
 * threshold separates them unambiguously. (An earlier version of this helper keyed off
 * `where.id === undefined`, which matched BOTH and made the fallback test assert against
 * the fresh list — that is the bug CI caught.)
 */
const FRESH_VS_WINDOW_THRESHOLD_DAYS = 30;
function wireLinks(opts: {
  fresh?: ReturnType<typeof link>[];
  older?: ReturnType<typeof link>[];
  fallback?: ReturnType<typeof link>[];
}) {
  const { fresh = [], older = [], fallback = null } = opts as {
    fresh?: ReturnType<typeof link>[];
    older?: ReturnType<typeof link>[];
    fallback?: ReturnType<typeof link>[] | null;
  };
  reportLinkFindMany.mockImplementation((args: Record<string, any>) => {
    const d = args?.where?.report?.date ?? {};
    if (d.lt !== undefined) return Promise.resolve(older);
    if (d.gte !== undefined) {
      const daysBack = (Date.now() - new Date(d.gte).getTime()) / DAY;
      if (daysBack > FRESH_VS_WINDOW_THRESHOLD_DAYS) {
        return Promise.resolve(fallback ?? [...fresh, ...older]);
      }
      return Promise.resolve(fresh);
    }
    return Promise.resolve([...fresh, ...older]);
  });
}

const cursorKey = (tier: string) => `insights-cursor:instagram:${tier}`;
const upsertedKeys = () => systemSettingUpsert.mock.calls.map((c: any) => c[0].where.key);
const upsertedValue = (tier: string) => {
  const call = systemSettingUpsert.mock.calls.find((c: any) => c[0].where.key === cursorKey(tier));
  return call ? call[0].create.value : undefined;
};

beforeEach(() => {
  vi.clearAllMocks();
  polledOrder.length = 0;
  systemSettingFindUnique.mockResolvedValue(null); // no cursors set
  systemSettingUpsert.mockResolvedValue({});
  queryRawMock.mockResolvedValue([]);
});

describe("tiered priority sweep — ordering", () => {
  it("polls fresh links before the older tail, regardless of id order", async () => {
    // 'a-old' sorts FIRST by id but is an old post; 'z-fresh' sorts LAST but is recent.
    // Under the old `id ASC` queue 'a-old' won.
    wireLinks({ fresh: [link("z-fresh", 1)], older: [link("a-old", 40)] });

    await runSocialInsightsRefresh();

    expect(polledOrder[0]).toBe("z-fresh");
    expect(polledOrder).toContain("a-old");
  });

  it("INTERLEAVES tiers by weight rather than concatenating them", async () => {
    // The critical regression guard. With weights fresh:older = 6:4, the first cycle must
    // be 6 fresh then 4 older — NOT all 20 fresh first. Concatenation is what starved the
    // older tier completely at prod scale, because the budget never left `fresh`.
    const fresh = Array.from({ length: 20 }, (_, i) => link(`f${String(i).padStart(2, "0")}`, 1));
    const older = Array.from({ length: 20 }, (_, i) => link(`o${String(i).padStart(2, "0")}`, 40));
    wireLinks({ fresh, older });

    await runSocialInsightsRefresh();

    const firstCycle = polledOrder.slice(0, 10).map((id) => id[0]);
    expect(firstCycle).toEqual(["f", "f", "f", "f", "f", "f", "o", "o", "o", "o"]);
  });

  it("consumes each tier in id-ascending order (the cursor prefix property)", async () => {
    // Cursor resume is only valid if the polled portion of a tier is a PREFIX of it.
    const fresh = Array.from({ length: 8 }, (_, i) => link(`f${i}`, 1));
    const older = Array.from({ length: 8 }, (_, i) => link(`o${i}`, 40));
    wireLinks({ fresh, older });

    await runSocialInsightsRefresh();

    for (const prefix of ["f", "o"]) {
      const seq = polledOrder.filter((id) => id.startsWith(prefix));
      expect(seq).toEqual([...seq].sort());
    }
  });
});

describe("tiered priority sweep — no exclusion", () => {
  it("NEVER excludes a link — every link in the window is polled", async () => {
    // The load-bearing invariant. Tiers re-order; they must not blacklist. A not_found
    // link recovers 94.4% of the time on FB / 18.2% on IG.
    wireLinks({ fresh: [link("f1", 1)], older: [link("o1", 40), link("o2", 40)] });

    await runSocialInsightsRefresh();

    expect(new Set(polledOrder)).toEqual(new Set(["f1", "o1", "o2"]));
  });
});

describe("tiered priority sweep — cursors", () => {
  it("gives EVERY tier its own cursor, including fresh", async () => {
    // Fresh was originally cursorless, which permanently excluded every fresh link past
    // the first budget's worth. All three tiers must be tracked.
    wireLinks({ fresh: [link("f1", 1)], older: [link("o1", 40)] });

    await runSocialInsightsRefresh();

    expect(upsertedKeys()).toContain(cursorKey("fresh"));
    expect(upsertedKeys()).toContain(cursorKey("older"));
  });

  it("resets a tier's cursor to empty when that tier was fully polled", async () => {
    wireLinks({ fresh: [link("f1", 1), link("f2", 1)] });

    await runSocialInsightsRefresh();

    expect(upsertedValue("fresh")).toBe("");
  });

  it("does NOT touch the cursor of a tier that was never reached", async () => {
    // Outcome 1. Writing "" here was a silent data-loss bug: "budget ran out before this
    // tier" became indistinguishable from "this tier finished a full pass", resetting real
    // stored progress to the head and reintroducing the F3 starvation bug.
    // Here the older tier is EMPTY, so it is never polled.
    wireLinks({ fresh: [link("f1", 1)] });

    await runSocialInsightsRefresh();

    expect(upsertedKeys()).toContain(cursorKey("fresh"));
    expect(upsertedKeys()).not.toContain(cursorKey("older"));
  });

  it("resumes an older tier past its persisted cursor", async () => {
    systemSettingFindUnique.mockImplementation((args: any) =>
      args.where.key === cursorKey("older")
        ? Promise.resolve({ key: args.where.key, value: "o1" })
        : Promise.resolve(null),
    );
    wireLinks({ older: [link("o1", 40), link("o2", 40), link("o3", 40)] });

    await runSocialInsightsRefresh();

    // o1 is at/behind the cursor → skipped this run; the tail continues after it.
    expect(polledOrder).not.toContain("o1");
    expect(polledOrder).toEqual(["o2", "o3"]);
  });

  it("wraps a tier to the start when its cursor is past the end", async () => {
    systemSettingFindUnique.mockImplementation((args: any) =>
      args.where.key === cursorKey("older")
        ? Promise.resolve({ key: args.where.key, value: "zzzz" })
        : Promise.resolve(null),
    );
    wireLinks({ older: [link("o1", 40), link("o2", 40)] });

    await runSocialInsightsRefresh();

    expect(polledOrder).toEqual(["o1", "o2"]);
  });
});

describe("tiered priority sweep — fail-open", () => {
  // A tier-build failure must degrade freshness, never stop the sweep. The tier build's
  // only fallible step is its two reportLink.findMany calls, so the fresh-tier query is
  // what we make throw. (An earlier revision classified the older tail with a $queryRaw
  // over link_metrics and this test threw from there; that query was removed because at
  // prod scale it seq-scanned a 1266MB table four times per run for almost no benefit.)
  function wireTierBuildFailure(fallbackRows: ReturnType<typeof link>[]) {
    reportLinkFindMany.mockImplementation((args: Record<string, any>) => {
      const d = args?.where?.report?.date ?? {};
      const daysBack = d.gte ? (Date.now() - new Date(d.gte).getTime()) / DAY : 0;
      // Fresh-tier query (short lookback, no upper bound) → throw, tripping the fallback.
      if (d.lt === undefined && d.gte !== undefined && daysBack <= FRESH_VS_WINDOW_THRESHOLD_DAYS) {
        return Promise.reject(new Error("db exploded"));
      }
      return Promise.resolve(fallbackRows);
    });
  }

  it("falls back to the legacy single queue if the tier build throws", async () => {
    wireTierBuildFailure([link("legacy1", 40)]);

    await runSocialInsightsRefresh();

    expect(polledOrder).toContain("legacy1");
  });

  it("writes the legacy cursor, not tier cursors, on the fallback path", async () => {
    wireTierBuildFailure([link("legacy1", 40)]);

    await runSocialInsightsRefresh();

    expect(upsertedKeys()).toContain("insights-cursor:instagram");
    expect(upsertedKeys()).not.toContain(cursorKey("fresh"));
    expect(upsertedKeys()).not.toContain(cursorKey("older"));
  });
});
