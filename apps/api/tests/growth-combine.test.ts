/**
 * growth-combine.test.ts — the Account Growth "All" tab's pure combination logic.
 *
 *   packages/shared/src/growth/combine.ts — composes the THREE boards' own figures (Meta's
 *   API board, YouTube's Data API board, Snapchat's public-profile board) into per-platform
 *   rows, combined totals and one channel list, without re-measuring anything.
 *
 * Pure functions only: no DB, no network. They live in @dashmani/shared because the
 * internal portal runs them and this suite is the only test runner in the repo.
 *
 * The invariants these lock (owner request 2026-10-01, plan "Account Growth All tab"):
 *  - a null (nothing published / nothing measurable) is never summed as a 0;
 *  - Meta's follower change follows the Meta tab's own 90% full-span rule (7 → 7, 28 → 26);
 *  - the Facebook/Instagram split partitions the server's own Meta totals exactly;
 *  - Snapchat views are never totalled, and YouTube views stay null until history exists;
 *  - unreliable rows never enter a sum or a ranking;
 *  - a partially loaded page names exactly what is missing;
 *  - every span is exact dates, formatted deterministically (year only when not current).
 */
import { describe, it, expect } from "vitest";
import {
  combineGrowth,
  growthMetaWindow,
  growthPeriodOfMetaWindow,
  growthFullSpanMin,
  growthErrorIsForbidden,
  growthErrorKind,
  growthChannelSortValue,
  filterGrowthChannels,
  fmtGrowthDay,
  fmtGrowthSpan,
  fmtGrowthIstClock,
  growthPlatformChangeView,
  growthCombinedChangeView,
  growthHistoryRequirement,
  growthPeriodText,
  growthSourceProblems,
  growthTableCountLabel,
  growthTableEmpty,
  growthRefreshFailureKind,
  growthRefreshFailureText,
  growthListNames,
  GROWTH_ALL_PERIODS,
  DEFAULT_GROWTH_ALL_PERIOD,
  type GrowthMetaInput,
  type GrowthMetaItemInput,
  type GrowthBoardInput,
  type GrowthBoardRowInput,
  type GrowthAllPeriod,
  // By path, as the portal imports it — it is deliberately not in the shared barrel (zod
  // and every validator would otherwise ride into the Account Growth page's first load).
} from "@dashmani/shared/src/growth/combine";

// ── Fixture builders ────────────────────────────────────────────────────────────────

function metaItem(o: Partial<GrowthMetaItemInput> & Pick<GrowthMetaItemInput, "id" | "platform">): GrowthMetaItemInput {
  return {
    metaId: `meta-${o.id}`,
    name: `Channel ${o.id}`,
    username: null,
    followers: null,
    followerDelta: null,
    followerDeltaDays: null,
    views28d: null,
    metricsError: null,
    ...o,
  };
}

function meta(o: Partial<GrowthMetaInput> = {}): GrowthMetaInput {
  return {
    window: "days_28",
    items: [],
    dataThroughDayByPlatform: { facebook: "2026-09-29", instagram: "2026-09-30" },
    ...o,
  };
}

function boardRow(o: Partial<GrowthBoardRowInput> & Pick<GrowthBoardRowInput, "id">): GrowthBoardRowInput {
  return {
    handle: o.id,
    displayName: `Name ${o.id}`,
    profileUrl: null,
    followers: null,
    followerDelta: null,
    followerDeltaDays: null,
    followerDeltaUnreliable: false,
    lastSyncedAt: null,
    metricsError: null,
    viewsDelta: null,
    viewsDeltaDays: null,
    ...o,
  };
}

function board(
  platform: "youtube" | "snapchat",
  o: { days?: number; rows?: GrowthBoardRowInput[]; totals?: Partial<GrowthBoardInput["totals"]>; historyFrom?: string | null } = {},
): GrowthBoardInput {
  return {
    platform,
    days: o.days ?? 28,
    rows: o.rows ?? [],
    totals: {
      channels: 0,
      followers: null,
      followersReported: 0,
      followersWithheld: 0,
      followerDelta: null,
      followerDeltaChannels: 0,
      followerDeltaSuppressed: 0,
      followerDeltaExcluded: 0,
      followerDeltaUncertainty: 0,
      viewsDelta: null,
      viewsDeltaChannels: 0,
      followerDeltaSpan: null,
      viewsDeltaSpan: null,
      ...o.totals,
    },
    historyFrom: o.historyFrom ?? null,
  };
}

/** Everything loaded and empty — the baseline most tests start from. */
function allReady(periodDays: GrowthAllPeriod = 28) {
  return {
    meta: meta({ window: growthMetaWindow(periodDays) }),
    youtube: board("youtube", { days: periodDays }),
    snapchat: board("snapchat", { days: periodDays }),
    periodDays,
  };
}

/**
 * The live /admin/meta/channels route's own totals arithmetic (meta.routes.ts), restated
 * so the split test checks our partition against the SERVER's sums, not against itself.
 */
function serverMetaTotals(items: GrowthMetaItemInput[]) {
  let followers = 0, views = 0, viewsContributing = 0;
  for (const r of items) {
    followers += r.followers ?? 0;
    if (r.views28d != null) { views += r.views28d; viewsContributing++; }
  }
  return { followers, views: viewsContributing > 0 ? views : null, viewsContributing, channelCount: items.length };
}

// ── Periods ─────────────────────────────────────────────────────────────────────────

describe("periods — only the spans every platform measures alike", () => {
  it("offers 7 and 28 days, defaulting to 28 (Meta's native week and days_28)", () => {
    expect([...GROWTH_ALL_PERIODS]).toEqual([7, 28]);
    expect(DEFAULT_GROWTH_ALL_PERIOD).toBe(28);
    expect(growthMetaWindow(7)).toBe("week");
    expect(growthMetaWindow(28)).toBe("days_28");
    expect(growthPeriodOfMetaWindow("week")).toBe(7);
    expect(growthPeriodOfMetaWindow("days_28")).toBe(28);
    for (const other of ["day", "today", "custom", "", undefined, null]) {
      expect(growthPeriodOfMetaWindow(other)).toBeNull();
    }
  });

  it("the full-span minimum is the Meta tab's 90% rule: 7 needs all 7, 28 needs 26", () => {
    expect(growthFullSpanMin(7)).toBe(7);
    expect(growthFullSpanMin(28)).toBe(26);
  });

  it("a source that answered for a different period is an ERROR, never figures under the wrong label", () => {
    // A board coerced back to 30 (e.g. an API that predates `days=28`) must not render as 28d.
    const r = combineGrowth({ ...allReady(28), youtube: board("youtube", { days: 30 }) });
    expect(r.platforms.youtube.state).toBe("error");
    expect(r.platforms.youtube.errorKind).toBe("mismatch");
    expect(r.platforms.youtube.error).toMatch(/30 days/);
    expect(r.platforms.youtube.channels).toBeNull();

    // Meta echoing the 28-day window while 7 days was asked for.
    const m = combineGrowth({ ...allReady(7), meta: meta({ window: "days_28" }) });
    expect(m.platforms.facebook.state).toBe("error");
    expect(m.platforms.instagram.state).toBe("error");
    expect(m.combined.failedPlatforms).toEqual(["facebook", "instagram"]);
  });

  it("7d and 28d read the same stock but each period's own flows and dates", () => {
    const items = [
      metaItem({ id: "f1", platform: "facebook", followers: 1_000, views28d: 70, followerDelta: 5, followerDeltaDays: 7 }),
    ];
    const week = combineGrowth({
      ...allReady(7),
      meta: meta({ window: "week", items, dataThroughDayByPlatform: { facebook: "2026-09-29", instagram: null } }),
    });
    expect(week.periodDays).toBe(7);
    expect(week.platforms.facebook.followers).toBe(1_000);
    expect(week.platforms.facebook.followerDelta).toBe(5);
    expect(week.platforms.facebook.span).toEqual({ from: "2026-09-23", to: "2026-09-29" });

    const month = combineGrowth({
      ...allReady(28),
      meta: meta({ window: "days_28", items, dataThroughDayByPlatform: { facebook: "2026-09-29", instagram: null } }),
    });
    expect(month.platforms.facebook.followers).toBe(1_000); // a stock: identical on both
    // A 7-day history is NOT full-span for 28 days, so it drops out of the 28-day sum.
    expect(month.platforms.facebook.followerDelta).toBeNull();
    expect(month.platforms.facebook.span).toEqual({ from: "2026-09-02", to: "2026-09-29" });
  });
});

// ── Null semantics ──────────────────────────────────────────────────────────────────

describe("null is never summed as 0", () => {
  it("an estate where nothing published a figure reads null — not 0 — in every flow and stock", () => {
    const r = combineGrowth({
      ...allReady(),
      meta: meta({ items: [metaItem({ id: "f1", platform: "facebook" }), metaItem({ id: "i1", platform: "instagram" })] }),
    });
    expect(r.combined.settled).toBe(true);
    expect(r.combined.channels).toBe(2); // a COUNT of channels is a real number
    expect(r.combined.followers).toBeNull();
    expect(r.combined.followerDelta).toBeNull();
    expect(r.combined.views).toBeNull();
    expect(r.platforms.facebook.followers).toBeNull();
    expect(r.platforms.facebook.views).toBeNull();
    expect(r.platforms.youtube.followerDelta).toBeNull();
  });

  it("a REAL reported zero survives as 0 and is distinguishable from absence", () => {
    const r = combineGrowth({
      ...allReady(),
      meta: meta({
        items: [metaItem({ id: "f1", platform: "facebook", followers: 10, followerDelta: 0, followerDeltaDays: 28, views28d: 0 })],
      }),
    });
    expect(r.platforms.facebook.followerDelta).toBe(0);
    expect(r.platforms.facebook.views).toBe(0);
    expect(r.combined.followerDelta).toBe(0);
    expect(r.combined.views).toBe(0);
    expect(r.combined.followerDeltaPlatforms).toEqual(["facebook"]);
  });

  it("sums only the non-null platform values, and names the platforms in each sum", () => {
    const r = combineGrowth({
      ...allReady(),
      meta: meta({ items: [metaItem({ id: "f1", platform: "facebook", followers: 1_000, followerDelta: 40, followerDeltaDays: 27, views28d: 900 })] }),
      youtube: board("youtube", {
        totals: { channels: 2, followers: 5_000, followersReported: 2, followerDelta: null, viewsDelta: 300, viewsDeltaChannels: 1 },
      }),
      snapchat: board("snapchat", {
        totals: { channels: 1, followers: 700, followersReported: 1, followerDelta: 100, followerDeltaChannels: 1 },
      }),
    });
    expect(r.combined.followers).toBe(6_700);
    expect(r.combined.followersPlatforms).toEqual(["facebook", "youtube", "snapchat"]);
    expect(r.combined.followerDelta).toBe(140);
    expect(r.combined.followerDeltaPlatforms).toEqual(["facebook", "snapchat"]);
    expect(r.combined.views).toBe(1_200);
    expect(r.combined.viewsPlatforms).toEqual(["facebook", "youtube"]);
  });
});

// ── Meta ────────────────────────────────────────────────────────────────────────────

describe("Meta — the Facebook/Instagram split of the Meta board's own figures", () => {
  it("follows the 90% full-span rule for the follower change at 28 days (26 qualifies, 25 does not)", () => {
    const r = combineGrowth({
      ...allReady(28),
      meta: meta({
        items: [
          metaItem({ id: "a", platform: "facebook", followerDelta: 100, followerDeltaDays: 26 }),
          metaItem({ id: "b", platform: "facebook", followerDelta: 50, followerDeltaDays: 25 }),
          metaItem({ id: "c", platform: "facebook", followerDelta: 10, followerDeltaDays: 28 }),
          // No span reported (an older response): never counted as full-span.
          metaItem({ id: "d", platform: "facebook", followerDelta: 7, followerDeltaDays: null }),
          metaItem({ id: "e", platform: "instagram", followerDelta: -30, followerDeltaDays: 28 }),
        ],
      }),
    });
    expect(r.platforms.facebook.followerDelta).toBe(110);
    expect(r.platforms.facebook.followerDeltaChannels).toBe(2);
    expect(r.platforms.facebook.followerDeltaMinDays).toBe(26);
    expect(r.platforms.instagram.followerDelta).toBe(-30);
    expect(r.combined.followerDelta).toBe(80);
    expect(r.platforms.facebook.uncertainty).toBe(0); // Meta's counts are not rounded
  });

  it("follows the same rule at 7 days, where it means the full 7", () => {
    const r = combineGrowth({
      ...allReady(7),
      meta: meta({
        window: "week",
        items: [
          metaItem({ id: "a", platform: "instagram", followerDelta: 5, followerDeltaDays: 7 }),
          metaItem({ id: "b", platform: "instagram", followerDelta: 3, followerDeltaDays: 6 }),
        ],
      }),
    });
    expect(r.platforms.instagram.followerDelta).toBe(5);
    expect(r.platforms.instagram.followerDeltaChannels).toBe(1);
    expect(r.platforms.instagram.followerDeltaMinDays).toBe(7);
  });

  it("the split partitions the server's own Meta totals exactly — followers, views and reporting counts", () => {
    const items = [
      metaItem({ id: "f1", platform: "facebook", followers: 1_000, views28d: 500 }),
      metaItem({ id: "f2", platform: "facebook", followers: null, views28d: 300 }),
      metaItem({ id: "i1", platform: "instagram", followers: 2_000, views28d: null }),
      metaItem({ id: "i2", platform: "instagram", followers: 50, views28d: 70 }),
    ];
    const server = serverMetaTotals(items);
    const r = combineGrowth({ ...allReady(), meta: meta({ items }) });
    const fb = r.platforms.facebook, ig = r.platforms.instagram;

    expect((fb.followers ?? 0) + (ig.followers ?? 0)).toBe(server.followers);
    expect((fb.views ?? 0) + (ig.views ?? 0)).toBe(server.views);
    expect((fb.viewsChannels ?? 0) + (ig.viewsChannels ?? 0)).toBe(server.viewsContributing);
    expect((fb.channels ?? 0) + (ig.channels ?? 0)).toBe(server.channelCount);
    expect(fb.followersReported).toBe(1);
    expect(fb.followersTotal).toBe(2);
    expect(ig.followersReported).toBe(2);
    expect(fb.views).toBe(800);
    expect(ig.views).toBe(70);
  });

  it("each platform's window is its own covered day back N−1 days, labelled with its boundary", () => {
    const r = combineGrowth({
      ...allReady(28),
      meta: meta({ dataThroughDayByPlatform: { facebook: "2026-09-29", instagram: "2026-09-30" } }),
    });
    expect(r.platforms.facebook.span).toEqual({ from: "2026-09-02", to: "2026-09-29" });
    expect(r.platforms.facebook.viewsSpan).toEqual(r.platforms.facebook.span);
    expect(r.platforms.facebook.spanKind).toBe("pacific-day");
    expect(r.platforms.instagram.span).toEqual({ from: "2026-09-03", to: "2026-09-30" });
    expect(r.platforms.instagram.spanKind).toBe("utc-day");
  });

  it("a window crossing a year boundary keeps its arithmetic in UTC calendar days", () => {
    const r = combineGrowth({
      ...allReady(28),
      meta: meta({ dataThroughDayByPlatform: { facebook: "2026-01-10", instagram: "2026-03-01" } }),
    });
    expect(r.platforms.facebook.span).toEqual({ from: "2025-12-14", to: "2026-01-10" });
    expect(r.platforms.instagram.span).toEqual({ from: "2026-02-02", to: "2026-03-01" }); // not a leap year
  });

  it("no covered day (missing, null or malformed) → no span, never a guessed one", () => {
    for (const d of [undefined, { facebook: null, instagram: null }, { facebook: "2026-02-30", instagram: "yesterday" }]) {
      const r = combineGrowth({ ...allReady(), meta: meta({ dataThroughDayByPlatform: d }) });
      expect(r.platforms.facebook.span).toBeNull();
      expect(r.platforms.instagram.span).toBeNull();
    }
  });

  it("counts the channels whose latest refresh failed, so the stated dates can disclose them", () => {
    const r = combineGrowth({
      ...allReady(),
      meta: meta({
        items: [
          metaItem({ id: "f1", platform: "facebook", metricsError: "(#10) permission" }),
          metaItem({ id: "f2", platform: "facebook" }),
          metaItem({ id: "i1", platform: "instagram" }),
        ],
      }),
    });
    expect(r.platforms.facebook.staleChannels).toBe(1);
    expect(r.platforms.instagram.staleChannels).toBe(0);
    expect(r.platforms.youtube.staleChannels).toBeNull(); // not a dated window there
  });
});

// ── YouTube and Snapchat ────────────────────────────────────────────────────────────

describe("YouTube and Snapchat — the boards' own server totals, never re-summed from rows", () => {
  it("YouTube views stay null until history spans the period, and are named as pending", () => {
    const r = combineGrowth({
      ...allReady(28),
      meta: meta({ items: [metaItem({ id: "f1", platform: "facebook", views28d: 1_000 })] }),
      youtube: board("youtube", {
        totals: { channels: 3, followers: 9_000, followersReported: 3, viewsDelta: null, viewsDeltaChannels: 0 },
        historyFrom: "2026-05-19",
      }),
    });
    expect(r.platforms.youtube.views).toBeNull();
    expect(r.platforms.youtube.viewsSpan).toBeNull();
    expect(r.platforms.youtube.viewsPublished).toBe(true);
    expect(r.platforms.youtube.historyFrom).toBe("2026-05-19");
    expect(r.combined.views).toBe(1_000);
    expect(r.combined.viewsPlatforms).toEqual(["facebook"]);
    expect(r.combined.viewsPendingPlatforms).toEqual(["youtube"]);
  });

  it("…and count once history exists, with their own exact snapshot dates", () => {
    const r = combineGrowth({
      ...allReady(7),
      youtube: board("youtube", {
        days: 7,
        totals: {
          channels: 2, viewsDelta: 4_000, viewsDeltaChannels: 2,
          followerDelta: 100_000, followerDeltaChannels: 1,
          followerDeltaSpan: { from: "2026-09-23", to: "2026-09-30" },
          viewsDeltaSpan: { from: "2026-09-24", to: "2026-09-30" },
        },
      }),
    });
    expect(r.platforms.youtube.views).toBe(4_000);
    expect(r.platforms.youtube.viewsChannels).toBe(2);
    expect(r.platforms.youtube.span).toEqual({ from: "2026-09-23", to: "2026-09-30" });
    expect(r.platforms.youtube.viewsSpan).toEqual({ from: "2026-09-24", to: "2026-09-30" });
    expect(r.platforms.youtube.spanKind).toBe("ist-snapshot");
    expect(r.combined.views).toBe(4_000);
  });

  it("Snapchat views are NEVER totalled — not from totals, not from rows", () => {
    // Snapchat publishes no period view count. Even a (hypothetical) number in the payload
    // must not leak into a sum or a row: its recentViews is a sample, not a window.
    const snap = board("snapchat", {
      rows: [boardRow({ id: "s1", followers: 100, viewsDelta: 5, viewsDeltaDays: 28 })],
      totals: { channels: 1, followers: 100, followersReported: 1, viewsDelta: 999, viewsDeltaChannels: 1 },
    });
    (snap.rows[0] as unknown as { recentViews: number }).recentViews = 123_456;
    const r = combineGrowth({ ...allReady(), snapchat: snap });
    expect(r.platforms.snapchat.views).toBeNull();
    expect(r.platforms.snapchat.viewsChannels).toBeNull();
    expect(r.platforms.snapchat.viewsPublished).toBe(false);
    expect(r.platforms.snapchat.viewsSpan).toBeNull();
    expect(r.combined.views).toBeNull();
    expect(r.combined.viewsUnpublishedPlatforms).toEqual(["snapchat"]);
    const row = r.channels.find((c) => c.platform === "snapchat")!;
    expect(row.views).toBeNull();
    expect(row.viewsPublished).toBe(false);
    expect(growthChannelSortValue(row, "views")).toBeNull();
  });

  it("an unreliable row is excluded from the sum (the server's) AND from the ranking", () => {
    const yt = board("youtube", {
      rows: [
        boardRow({ id: "steady", followers: 500_000, followerDelta: 10_000, followerDeltaDays: 29 }),
        boardRow({ id: "jumpy", followers: 1_040_000, followerDelta: 993_700, followerDeltaDays: 29, followerDeltaUnreliable: true }),
      ],
      totals: { channels: 2, followerDelta: 10_000, followerDeltaChannels: 1, followerDeltaExcluded: 1 },
    });
    const r = combineGrowth({ ...allReady(), youtube: yt });
    // The total is the server's guarded figure, not a re-sum of the rows (which would be 1,003,700).
    expect(r.platforms.youtube.followerDelta).toBe(10_000);
    expect(r.platforms.youtube.followerDeltaExcluded).toBe(1);
    expect(r.combined.followerDelta).toBe(10_000);

    const jumpy = r.channels.find((c) => c.id === "jumpy")!;
    expect(jumpy.followerDeltaUnreliable).toBe(true);
    expect(jumpy.followerDelta).toBe(993_700); // still shown (struck through) …
    expect(growthChannelSortValue(jumpy, "change")).toBeNull(); // … but never ranked
    const steady = r.channels.find((c) => c.id === "steady")!;
    expect(growthChannelSortValue(steady, "change")).toBe(10_000);
  });

  it("the uncertainty is YouTube's plus Snapchat's rounding; Meta adds none", () => {
    const r = combineGrowth({
      ...allReady(),
      meta: meta({ items: [metaItem({ id: "f1", platform: "facebook", followerDelta: 15_000, followerDeltaDays: 28 })] }),
      youtube: board("youtube", { totals: { channels: 20, followerDelta: 1_500, followerDeltaChannels: 4, followerDeltaUncertainty: 186_310 } }),
      snapchat: board("snapchat", { totals: { channels: 30, followerDelta: 3_500, followerDeltaChannels: 6, followerDeltaUncertainty: 3_000 } }),
    });
    expect(r.combined.uncertainty).toBe(189_310);
    expect(r.combined.followerDelta).toBe(20_000);
    // |20,000| < ±189,310: inside the error bar → shown as approximate, never as a bare figure.
    expect(r.combined.followerDeltaApprox).toBe(true);
    expect(r.platforms.youtube.followerDeltaApprox).toBe(true);
    expect(r.platforms.facebook.followerDeltaApprox).toBe(false);

    const big = combineGrowth({
      ...allReady(),
      meta: meta({ items: [metaItem({ id: "f1", platform: "facebook", followerDelta: 1_200_000, followerDeltaDays: 28 })] }),
      youtube: board("youtube", { totals: { channels: 20, followerDelta: 1_500, followerDeltaChannels: 4, followerDeltaUncertainty: 186_310 } }),
    });
    expect(big.combined.followerDeltaApprox).toBe(false);
  });

  it("a board that failed contributes no uncertainty — it is named as missing instead", () => {
    const r = combineGrowth({
      ...allReady(),
      youtube: { error: "boom" },
      snapchat: board("snapchat", { totals: { channels: 3, followerDelta: 200, followerDeltaChannels: 2, followerDeltaUncertainty: 300 } }),
    });
    expect(r.combined.uncertainty).toBe(300);
    expect(r.combined.missingPlatforms).toEqual(["youtube"]);
  });

  it("board spans pass through only when well-formed", () => {
    const r = combineGrowth({
      ...allReady(),
      snapchat: board("snapchat", { totals: { followerDeltaSpan: { from: "2026-09-03", to: "not-a-day" } } }),
    });
    expect(r.platforms.snapchat.span).toBeNull();
  });

  it("the newest sync per board is reported, for the 'as of the latest sync' line", () => {
    const r = combineGrowth({
      ...allReady(),
      youtube: board("youtube", {
        rows: [
          boardRow({ id: "a", lastSyncedAt: "2026-09-30T10:00:00.000Z" }),
          boardRow({ id: "b", lastSyncedAt: null }),
          boardRow({ id: "c", lastSyncedAt: "2026-09-30T12:30:00.000Z" }),
        ],
      }),
    });
    expect(r.platforms.youtube.latestSyncedAt).toBe("2026-09-30T12:30:00.000Z");
    expect(r.platforms.snapchat.latestSyncedAt).toBeNull();
    expect(r.platforms.facebook.latestSyncedAt).toBeNull(); // Meta has no per-row follower instant
  });
});

// ── Partial loads ───────────────────────────────────────────────────────────────────

describe("partial loads — sum only what loaded, and say exactly what did not", () => {
  it("one errored, one still loading: named, excluded, and the page is not 'settled'", () => {
    const r = combineGrowth({
      meta: meta({ items: [metaItem({ id: "f1", platform: "facebook", followers: 100 })] }),
      youtube: { error: "This board could not be loaded" },
      snapchat: undefined,
      periodDays: 28,
    });
    expect(r.platforms.youtube.state).toBe("error");
    expect(r.platforms.youtube.error).toBe("This board could not be loaded");
    expect(r.platforms.youtube.forbidden).toBe(false);
    expect(r.platforms.youtube.errorKind).toBe("failed");
    expect(r.platforms.snapchat.state).toBe("loading");
    expect(r.platforms.snapchat.errorKind).toBeNull();
    expect(r.platforms.facebook.state).toBe("ready");
    expect(r.combined.includedPlatforms).toEqual(["facebook", "instagram"]);
    expect(r.combined.missingPlatforms).toEqual(["youtube", "snapchat"]);
    expect(r.combined.failedPlatforms).toEqual(["youtube"]);
    expect(r.combined.loadingPlatforms).toEqual(["snapchat"]);
    expect(r.combined.settled).toBe(false);
    expect(r.combined.followers).toBe(100);
    // Only a LOADED response may list channels.
    expect(r.channels.map((c) => c.platform)).toEqual(["facebook"]);
  });

  it("Meta not loaded takes Facebook AND Instagram out together", () => {
    const r = combineGrowth({ ...allReady(), meta: undefined });
    expect(r.platforms.facebook.state).toBe("loading");
    expect(r.platforms.instagram.state).toBe("loading");
    expect(r.combined.includedPlatforms).toEqual(["youtube", "snapchat"]);
  });

  it("nothing loaded yet: no channel count, no sums, no rows", () => {
    const r = combineGrowth({ meta: undefined, youtube: undefined, snapchat: undefined, periodDays: 28 });
    expect(r.combined.settled).toBe(false);
    expect(r.combined.channels).toBeNull();
    expect(r.combined.followers).toBeNull();
    expect(r.channels).toEqual([]);
  });

  it("settles once every source has answered, even if one answered with an error", () => {
    const r = combineGrowth({ ...allReady(), snapchat: { error: "boom" } });
    expect(r.combined.settled).toBe(true);
    expect(r.combined.failedPlatforms).toEqual(["snapchat"]);
  });

  it("recognises the admin-only gate's 403 messages, and nothing else, as 'forbidden'", () => {
    expect(growthErrorIsForbidden("Admin role required")).toBe(true);
    expect(growthErrorIsForbidden("No permission: manage on reports")).toBe(true);
    expect(growthErrorIsForbidden("API error")).toBe(false);
    expect(growthErrorIsForbidden("Session expired")).toBe(false);
    expect(growthErrorIsForbidden(null)).toBe(false);
    const r = combineGrowth({ ...allReady(), youtube: { error: "Admin role required" } });
    expect(r.platforms.youtube.forbidden).toBe(true);
    expect(r.platforms.youtube.errorKind).toBe("forbidden");
  });

  it("classifies every failure so the panel can word it calmly — the raw texts must never reach the screen", () => {
    // The API's own strings (app.ts rate limiter, middleware/error-handler.ts), plus what
    // `res.json()` throws when a gateway answers with an HTML error page instead of JSON.
    expect(growthErrorKind("Too many requests, please try again later")).toBe("busy");
    expect(growthErrorKind("An unexpected error occurred")).toBe("failed");
    expect(growthErrorKind(`Unexpected token '<', "<html>"... is not valid JSON`)).toBe("failed");
    expect(growthErrorKind("Failed to fetch")).toBe("failed");
    expect(growthErrorKind(null)).toBe("failed");
    expect(growthErrorKind("No permission: manage on reports")).toBe("forbidden");

    const r = combineGrowth({
      ...allReady(),
      meta: { error: "Too many requests, please try again later" },
      youtube: { error: "An unexpected error occurred" },
      snapchat: board("snapchat", { days: 30 }), // a period mismatch is this module's own sentence
    });
    expect(r.platforms.facebook.errorKind).toBe("busy");
    expect(r.platforms.instagram.errorKind).toBe("busy");
    expect(r.platforms.youtube.errorKind).toBe("failed");
    expect(r.platforms.snapchat.errorKind).toBe("mismatch");
    expect(r.platforms.snapchat.error).toMatch(/30 days, not the 28 days asked for/);
    // Ready platforms carry no error at all.
    expect(combineGrowth(allReady()).platforms.youtube.errorKind).toBeNull();
  });
});

// ── The unified channel list ────────────────────────────────────────────────────────

describe("the unified channel list", () => {
  it("keys are unique across platforms even when two boards share an id", () => {
    const r = combineGrowth({
      ...allReady(),
      meta: meta({ items: [metaItem({ id: "x", platform: "facebook" }), metaItem({ id: "y", platform: "instagram" })] }),
      youtube: board("youtube", { rows: [boardRow({ id: "x" })] }),
      snapchat: board("snapchat", { rows: [boardRow({ id: "x" })] }),
    });
    const keys = r.channels.map((c) => c.key);
    expect(keys).toEqual(["facebook:x", "instagram:y", "youtube:x", "snapchat:x"]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("maps each platform's own figures: Meta windowed views, YouTube's views change, Snapchat none", () => {
    const r = combineGrowth({
      ...allReady(28),
      meta: meta({
        items: [metaItem({ id: "f1", platform: "facebook", name: "Filme Flicks", username: "filmeflicks", followers: 9, views28d: 400, followerDelta: 3, followerDeltaDays: 12 })],
      }),
      youtube: board("youtube", {
        rows: [boardRow({ id: "y1", handle: "Inde-News", displayName: "", profileUrl: "https://www.youtube.com/channel/UC1", viewsDelta: 77, viewsDeltaDays: 6 })],
      }),
      snapchat: board("snapchat", {
        rows: [boardRow({ id: "s1", handle: "bollywoodchroni", displayName: "Bollywood Chronicle", followerDelta: null, followerDeltaDays: 20 })],
      }),
      metaHref: (c) => `https://example.test/${c.platform}/${c.metaId}`,
    });
    const [f, y, s] = r.channels;
    expect(f).toMatchObject({
      platform: "facebook", name: "Filme Flicks", handle: "filmeflicks",
      href: "https://example.test/facebook/meta-f1",
      followers: 9, views: 400, viewsDays: 28, viewsPublished: true,
      followerDelta: 3, followerDeltaDays: 12, followerDeltaSuppressed: false,
    });
    expect(y).toMatchObject({
      platform: "youtube", name: "Inde-News", handle: "Inde-News", // displayName empty → the handle
      href: "https://www.youtube.com/channel/UC1", views: 77, viewsDays: 6,
    });
    // A measured span with no countable change = finer than Snapchat's ×100 grid.
    expect(s).toMatchObject({ platform: "snapchat", followerDeltaSuppressed: true, views: null, viewsDays: null });
  });

  it("without a link builder Meta rows carry no href rather than a guessed one", () => {
    const r = combineGrowth({ ...allReady(), meta: meta({ items: [metaItem({ id: "f1", platform: "facebook" })] }) });
    expect(r.channels[0].href).toBeNull();
  });

  it("search is client-side over name and handle, case-insensitive, '@' optional, platform-filterable", () => {
    const r = combineGrowth({
      ...allReady(),
      meta: meta({ items: [metaItem({ id: "f1", platform: "facebook", name: "Bollywood Society", username: "bollywoodsociety" })] }),
      youtube: board("youtube", { rows: [boardRow({ id: "y1", handle: "TotalFilmi", displayName: "Total Filmi" })] }),
      snapchat: board("snapchat", { rows: [boardRow({ id: "s1", handle: "bollywoodchroni", displayName: "Chronicle" })] }),
    });
    const ids = (q: string, platform?: "all" | "youtube" | "snapchat") =>
      filterGrowthChannels(r.channels, { q, platform }).map((c) => c.id);
    expect(ids("")).toEqual(["f1", "y1", "s1"]);
    expect(ids("BOLLY")).toEqual(["f1", "s1"]);
    expect(ids("  @bollywoodchroni ")).toEqual(["s1"]);
    expect(ids("filmi")).toEqual(["y1"]);
    expect(ids("bolly", "snapchat")).toEqual(["s1"]);
    expect(ids("", "youtube")).toEqual(["y1"]);
    expect(ids("@")).toEqual(["f1", "y1", "s1"]);
  });

  it("sort values: nulls stay null (so they sort last), names and platforms are strings", () => {
    const r = combineGrowth({
      ...allReady(),
      youtube: board("youtube", { rows: [boardRow({ id: "y1", displayName: "Zed", followers: null })] }),
    });
    const row = r.channels[0];
    expect(growthChannelSortValue(row, "name")).toBe("Zed");
    expect(growthChannelSortValue(row, "platform")).toBe("YouTube");
    expect(growthChannelSortValue(row, "followers")).toBeNull();
  });
});

// ── Dates ───────────────────────────────────────────────────────────────────────────

describe("dates — exact, deterministic, the year only when it is not the current one", () => {
  it("formats a day key as '3 Sep', adding the year only outside the current year", () => {
    expect(fmtGrowthDay("2026-09-03", 2026)).toBe("3 Sep");
    expect(fmtGrowthDay("2025-09-30", 2026)).toBe("30 Sep 2025");
    expect(fmtGrowthDay("2027-01-01", 2026)).toBe("1 Jan 2027");
    expect(fmtGrowthDay("2026-02-30", 2026)).toBe("—"); // not a real day
    expect(fmtGrowthDay(null, 2026)).toBe("—");
  });

  it("formats spans per side, so a span across New Year names the year it leaves", () => {
    expect(fmtGrowthSpan({ from: "2026-09-02", to: "2026-09-29" }, 2026)).toBe("2 Sep – 29 Sep");
    expect(fmtGrowthSpan({ from: "2025-12-28", to: "2026-01-03" }, 2026)).toBe("28 Dec 2025 – 3 Jan");
    expect(fmtGrowthSpan({ from: "2026-09-23", to: "2026-09-30" }, 2026, " → ")).toBe("23 Sep → 30 Sep");
    expect(fmtGrowthSpan({ from: "2026-09-30", to: "2026-09-30" }, 2026)).toBe("30 Sep");
    expect(fmtGrowthSpan(null, 2026)).toBe("—");
  });

  it("states a day boundary in IST, following Pacific daylight saving rather than hard-coding it", () => {
    expect(fmtGrowthIstClock("2026-10-01T07:00:00.000Z")).toBe("12:30 PM"); // PDT midnight
    expect(fmtGrowthIstClock("2026-12-01T08:00:00.000Z")).toBe("1:30 PM");  // PST midnight
    expect(fmtGrowthIstClock("2026-10-01T18:30:00.000Z")).toBe("12:00 AM");
    expect(fmtGrowthIstClock("2026-10-01T00:00:00.000Z")).toBe("5:30 AM");  // UTC midnight
    expect(fmtGrowthIstClock("not a date")).toBeNull();
    expect(fmtGrowthIstClock(undefined)).toBeNull();
  });
});

// ── Display rules (review of the first build, 2026-10-01) ───────────────────────────

/** Phrases the owner banned from the screen, and the raw API texts that carry them. */
const BANNED = [/too many requests/i, /something went wrong/i, /unexpected error/i, /unexpected token/i];
const noBanned = (s: string) => BANNED.every((re) => !re.test(s));

describe("a board's change is shown only where its own tab would show it (the PR #166 gate)", () => {
  it("a YouTube change inside its own rounding error bar shows the limit, never the number", () => {
    // Live shape: +1,500 against ±186,310 at 7 days. The YouTube tab prints "movement is
    // smaller than the ±186.3k the rounding can resolve", so the All tab must not print a number.
    const r = combineGrowth({
      ...allReady(7),
      youtube: board("youtube", {
        days: 7,
        totals: { channels: 22, followerDelta: 1_500, followerDeltaChannels: 4, followerDeltaSuppressed: 12, followerDeltaUncertainty: 186_310 },
      }),
    });
    const v = growthPlatformChangeView(r.platforms.youtube);
    expect(v).toEqual({ kind: "unresolved", uncertainty: 186_310 });
    expect("value" in v).toBe(false);
  });

  it("no board ever shows a number while it is inside its error bar — across the edges", () => {
    for (const platform of ["youtube", "snapchat"] as const) {
      for (const delta of [-301, -300, -299, -1, 0, 1, 299, 300, 301, 5_000]) {
        for (const unc of [0, 300]) {
          const r = combineGrowth({
            ...allReady(),
            [platform]: board(platform, { totals: { channels: 2, followerDelta: delta, followerDeltaChannels: 1, followerDeltaUncertainty: unc } }),
          });
          const a = r.platforms[platform];
          const v = growthPlatformChangeView(a);
          if (unc > 0 && Math.abs(delta) < unc) {
            expect(a.followerDeltaApprox).toBe(true);
            expect(v).toEqual({ kind: "unresolved", uncertainty: unc });
          } else {
            expect(v).toEqual({ kind: "value", value: delta, approx: false });
          }
        }
      }
    }
  });

  it("Meta's counts are exact, so its change is never gated", () => {
    const r = combineGrowth({
      ...allReady(),
      meta: meta({ items: [metaItem({ id: "f1", platform: "facebook", followerDelta: 3, followerDeltaDays: 28, followerDeltaFrom: "2026-09-03" })] }),
    });
    expect(growthPlatformChangeView(r.platforms.facebook)).toEqual({ kind: "value", value: 3, approx: false });
  });

  it("the combined figure keeps its ≈ (plan decision) and names the platforms its ± comes from", () => {
    const r = combineGrowth({
      ...allReady(),
      meta: meta({ items: [metaItem({ id: "f1", platform: "facebook", followerDelta: 15_000, followerDeltaDays: 28, followerDeltaFrom: "2026-09-03" })] }),
      youtube: board("youtube", { totals: { channels: 20, followerDelta: 1_500, followerDeltaChannels: 4, followerDeltaUncertainty: 186_310 } }),
      snapchat: board("snapchat", { totals: { channels: 30, followerDelta: 3_500, followerDeltaChannels: 6, followerDeltaUncertainty: 3_000 } }),
    });
    expect(growthCombinedChangeView(r.combined)).toEqual({ kind: "value", value: 20_000, approx: true });
    expect(r.combined.uncertaintyPlatforms).toEqual(["youtube", "snapchat"]);
    // A board with no rounding contributes no ± and is not named as a source of one.
    const exact = combineGrowth({ ...allReady(), youtube: board("youtube", { totals: { channels: 1, followerDelta: 5, followerDeltaChannels: 1 } }) });
    expect(exact.combined.uncertaintyPlatforms).toEqual([]);
  });

  it("nothing loaded yet: the combined change is 'not loaded', never a number", () => {
    const r = combineGrowth({ meta: undefined, youtube: undefined, snapchat: undefined, periodDays: 28 });
    expect(growthCombinedChangeView(r.combined)).toEqual({ kind: "absent", reason: "not-loaded" });
    expect(growthPlatformChangeView(r.platforms.youtube)).toEqual({ kind: "absent", reason: "not-loaded" });
  });
});

describe("why a change is absent — told apart from the data, never guessed", () => {
  it("full-span channels that all moved less than the rounding step are not 'not enough history'", () => {
    const r = combineGrowth({
      ...allReady(7),
      youtube: board("youtube", { days: 7 }),
      snapchat: board("snapchat", {
        days: 7,
        totals: { channels: 30, followerDelta: null, followerDeltaChannels: 0, followerDeltaSuppressed: 30, followerDeltaUncertainty: 3_000 },
        historyFrom: "2026-07-01",
      }),
    });
    expect(growthPlatformChangeView(r.platforms.snapchat)).toEqual({ kind: "absent", reason: "below-step" });
    expect(growthCombinedChangeView(r.combined)).toEqual({ kind: "absent", reason: "below-step" });
    expect(r.combined.followerDeltaSuppressed).toBe(30);
    const t = growthPeriodText(r.platforms.snapchat, 2026);
    expect(t.change).toBeNull();
    expect(t.changeWhy).toMatch(/rounding step/);
    expect(t.changeWhy).not.toMatch(/history|collecting/);
  });

  it("full-span changes all excluded as unreliable read as that", () => {
    const r = combineGrowth({
      ...allReady(),
      youtube: board("youtube", { totals: { channels: 3, followerDelta: null, followerDeltaChannels: 0, followerDeltaExcluded: 1 } }),
    });
    expect(growthPlatformChangeView(r.platforms.youtube)).toEqual({ kind: "absent", reason: "excluded" });
    expect(growthPeriodText(r.platforms.youtube, 2026).changeWhy).toMatch(/unreliable/);
    expect(r.combined.followerDeltaExcluded).toBe(1);
  });

  it("short history reads as that, with the real 90% requirement and the date collecting began", () => {
    const r = combineGrowth({
      ...allReady(28),
      youtube: board("youtube", { totals: { channels: 3 }, historyFrom: "2026-09-22" }),
      meta: meta({ items: [metaItem({ id: "f1", platform: "facebook", followerDelta: 9, followerDeltaDays: 5, followerDeltaFrom: "2026-09-26" })] }),
    });
    expect(growthPlatformChangeView(r.platforms.youtube)).toEqual({ kind: "absent", reason: "no-history" });
    expect(growthPeriodText(r.platforms.youtube, 2026).changeWhy).toBe("not enough history yet · collecting since 22 Sep");
    expect(growthPlatformChangeView(r.platforms.facebook)).toEqual({ kind: "absent", reason: "no-history" });
    expect(growthPeriodText(r.platforms.facebook, 2026).changeWhy).toBe("no API history covers at least 26 of the 28 days yet");
  });

  it("a platform with no channels has nothing to explain", () => {
    const r = combineGrowth(allReady());
    expect(growthPlatformChangeView(r.platforms.instagram)).toEqual({ kind: "absent", reason: "no-channels" });
    const t = growthPeriodText(r.platforms.instagram, 2026);
    expect([t.views, t.viewsWhy, t.change, t.changeWhy]).toEqual([null, null, null, null]);
  });

  it("states the 90% rule as it is: all 7 of 7 days, at least 26 of 28", () => {
    expect(growthHistoryRequirement(7)).toBe("the 7 days");
    expect(growthHistoryRequirement(28)).toBe("at least 26 of the 28 days");
  });

  it("views: a board waiting for history is pending; Meta with no figure is 'none reported', never a history problem", () => {
    const r = combineGrowth({
      ...allReady(),
      meta: meta({ items: [metaItem({ id: "f1", platform: "facebook", views28d: null }), metaItem({ id: "i1", platform: "instagram", views28d: 5 })] }),
      youtube: board("youtube", { totals: { channels: 2, viewsDelta: null } }),
    });
    expect(r.combined.viewsPendingPlatforms).toEqual(["youtube"]);
    expect(r.combined.viewsUnreportedPlatforms).toEqual(["facebook"]);
    expect(growthPeriodText(r.platforms.facebook, 2026).views).toBe("2 Sep – 29 Sep");
  });
});

describe("the dates each figure covers", () => {
  it("Facebook's change runs from its earliest contributing snapshot to the latest sync — not over the views window", () => {
    const r = combineGrowth({
      ...allReady(28),
      meta: meta({
        items: [
          metaItem({ id: "f1", platform: "facebook", followerDelta: 500, followerDeltaDays: 28, followerDeltaFrom: "2026-09-03" }),
          metaItem({ id: "f2", platform: "facebook", followerDelta: 100, followerDeltaDays: 27, followerDeltaFrom: "2026-09-04" }),
          // Not full-span: it is not in the sum, so it must not move the dates either.
          metaItem({ id: "f3", platform: "facebook", followerDelta: 9, followerDeltaDays: 5, followerDeltaFrom: "2026-09-26" }),
        ],
      }),
    });
    const fb = r.platforms.facebook;
    expect(fb.changeSince).toBe("2026-09-03");
    expect(fb.changeUntil).toBeNull();
    const t = growthPeriodText(fb, 2026);
    expect(t.views).toBe("2 Sep – 29 Sep");
    expect(t.change).toBe("3 Sep → latest sync");
    expect(t.calendar).toMatch(/Pacific/);
    expect(t.calendar).toMatch(/IST/);
  });

  it("Instagram's runs to the last channel refresh, because its counts are re-read only then", () => {
    const r = combineGrowth({
      ...allReady(28),
      meta: meta({
        items: [
          metaItem({ id: "i1", platform: "instagram", followerDelta: 50, followerDeltaDays: 28, followerDeltaFrom: "2026-09-05" }),
          // Meta's own accounting for the window starts on the window's first day.
          metaItem({ id: "i2", platform: "instagram", followerDelta: 40, followerDeltaDays: 28, followerDeltaFrom: null }),
        ],
      }),
    });
    const ig = r.platforms.instagram;
    expect(ig.changeSince).toBe("2026-09-03");
    expect(ig.followerDeltaAccounting).toBe(1);
    const t = growthPeriodText(ig, 2026);
    expect(t.change).toBe("3 Sep → last channel refresh");
    expect(t.calendar).toMatch(/1 by Meta's follows − unfollows/);
  });

  it("an Instagram change that is entirely Meta's accounting spans the window itself", () => {
    const r = combineGrowth({
      ...allReady(28),
      meta: meta({ items: [metaItem({ id: "i1", platform: "instagram", followerDelta: 40, followerDeltaDays: 28, followerDeltaFrom: null })] }),
    });
    expect(r.platforms.instagram.changeSince).toBe("2026-09-03");
    expect(r.platforms.instagram.changeUntil).toBe("2026-09-30");
    expect(growthPeriodText(r.platforms.instagram, 2026).change).toBe("3 Sep – 30 Sep");
  });

  it("a response without followerDeltaFrom states no start date rather than guessing one", () => {
    const r = combineGrowth({
      ...allReady(28),
      meta: meta({ items: [metaItem({ id: "f1", platform: "facebook", followerDelta: 5, followerDeltaDays: 28 })].map((i) => {
        const { followerDeltaFrom: _omit, ...rest } = i as GrowthMetaItemInput & { followerDeltaFrom?: string | null };
        return rest;
      }) }),
    });
    expect(r.platforms.facebook.followerDelta).toBe(5);
    expect(r.platforms.facebook.changeSince).toBeNull();
    const t = growthPeriodText(r.platforms.facebook, 2026);
    expect(t.change).toBeNull();
    expect(t.changeWhy).toBe("start date not reported");
  });

  it("boards carry their own snapshot dates for the change and for views", () => {
    const r = combineGrowth({
      ...allReady(7),
      youtube: board("youtube", {
        days: 7,
        totals: {
          channels: 2, followerDelta: 900_000, followerDeltaChannels: 1, viewsDelta: 50, viewsDeltaChannels: 1,
          followerDeltaSpan: { from: "2026-09-23", to: "2026-09-30" },
          viewsDeltaSpan: { from: "2026-09-24", to: "2026-09-30" },
        },
      }),
      snapchat: board("snapchat", { days: 7, totals: { channels: 1 } }),
    });
    const yt = growthPeriodText(r.platforms.youtube, 2026);
    expect(yt.change).toBe("23 Sep → 30 Sep");
    expect(yt.views).toBe("24 Sep → 30 Sep");
    const sc = growthPeriodText(r.platforms.snapchat, 2026);
    expect(sc.views).toBeNull();
    expect(sc.viewsWhy).toBe("not published");
  });

  it("mid-sync, a platform whose channels sit on two windows says so instead of printing one", () => {
    const r = combineGrowth({
      ...allReady(28),
      meta: meta({
        dataThroughDayByPlatform: { facebook: "2026-09-28", instagram: "2026-09-30" },
        newestCoveredDayByPlatform: { facebook: "2026-09-29", instagram: "2026-09-30" },
        items: [metaItem({ id: "f1", platform: "facebook" }), metaItem({ id: "i1", platform: "instagram" })],
      }),
    });
    expect(r.platforms.facebook.spanEnds).toEqual({ from: "2026-09-28", to: "2026-09-29" });
    expect(growthPeriodText(r.platforms.facebook, 2026).views).toBe("28-day windows ending 28 Sep – 29 Sep");
    expect(growthPeriodText(r.platforms.facebook, 2026).windowsNote).toMatch(/a sync is moving channels onto the next window — some end a day later/);
    expect(growthPeriodText(r.platforms.instagram, 2026).views).toBe("3 Sep – 30 Sep");
    expect(growthPeriodText(r.platforms.instagram, 2026).windowsNote).toBeNull();
    // A channel weeks behind (restored after removal, say) is not "a day later".
    const lag = combineGrowth({
      ...allReady(28),
      meta: meta({
        dataThroughDayByPlatform: { facebook: "2026-09-10", instagram: "2026-09-30" },
        newestCoveredDayByPlatform: { facebook: "2026-09-29", instagram: "2026-09-30" },
        items: [metaItem({ id: "f1", platform: "facebook" })],
      }),
    });
    expect(growthPeriodText(lag.platforms.facebook, 2026).windowsNote).toBe(
      "channels' windows end up to 19 days apart — some haven't refreshed onto the latest one yet");
    // A response without the newest day reads as one window, as before.
    const old = combineGrowth({ ...allReady(28), meta: meta({ items: [metaItem({ id: "f1", platform: "facebook" })] }) });
    expect(old.platforms.facebook.spanEnds).toBeNull();
    expect(growthPeriodText(old.platforms.facebook, 2026).views).toBe("2 Sep – 29 Sep");
  });
});

describe("only a loaded response may claim a count or an emptiness", () => {
  const ytRow = boardRow({ id: "y1" });

  it("the counter says loading or unavailable, never '0 channels', when nothing could be counted", () => {
    const none = combineGrowth({ meta: { error: "x" }, youtube: { error: "x" }, snapchat: { error: "x" }, periodDays: 28 });
    expect(growthTableCountLabel(none, { shown: 0, platform: "all" })).toBe("none loaded");
    const pending = combineGrowth({ meta: undefined, youtube: undefined, snapchat: undefined, periodDays: 28 });
    expect(growthTableCountLabel(pending, { shown: 0, platform: "all" })).toBe("Loading…");

    const metaFailed = combineGrowth({ ...allReady(), meta: { error: "x" }, youtube: board("youtube", { rows: [ytRow] }) });
    expect(growthTableCountLabel(metaFailed, { shown: 0, platform: "facebook" })).toBe("Facebook couldn't load");
    const metaLoading = combineGrowth({ ...allReady(), meta: undefined, youtube: board("youtube", { rows: [ytRow] }) });
    expect(growthTableCountLabel(metaLoading, { shown: 0, platform: "instagram" })).toBe("Loading Instagram…");
  });

  it("…and a real count once its source loaded", () => {
    const r = combineGrowth({ ...allReady(), youtube: board("youtube", { rows: [ytRow, boardRow({ id: "y2" })] }) });
    expect(growthTableCountLabel(r, { shown: 2, platform: "all" })).toBe("2 channels");
    expect(growthTableCountLabel(r, { shown: 1, platform: "all" })).toBe("1 channel of 2");
    expect(growthTableCountLabel(r, { shown: 2, platform: "youtube" })).toBe("2 channels");
    expect(growthTableCountLabel(r, { shown: 0, platform: "facebook" })).toBe("0 channels of 2");
    const part = combineGrowth({ ...allReady(), snapchat: undefined, youtube: board("youtube", { rows: [ytRow] }) });
    expect(growthTableCountLabel(part, { shown: 1, platform: "all" })).toBe("1 channel so far");
  });

  it("the empty table names what did not load instead of claiming there are no channels", () => {
    const partial = combineGrowth({ ...allReady(), youtube: { error: "x" }, snapchat: { error: "x" } });
    const e = growthTableEmpty(partial, { platform: "all", searching: false });
    expect(e.error).toBe(true);
    expect(e.text).toBe("No Facebook or Instagram channels to list, and YouTube and Snapchat couldn't load — see the note above.");
    expect(growthTableEmpty(combineGrowth(allReady()), { platform: "all", searching: false }))
      .toEqual({ text: "No channels tracked yet — add them on each platform's tab.", error: false });
    const none = combineGrowth({ meta: { error: "x" }, youtube: { error: "x" }, snapchat: { error: "x" }, periodDays: 28 });
    expect(growthTableEmpty(none, { platform: "all", searching: false }).error).toBe(true);
    expect(growthTableEmpty(partial, { platform: "youtube", searching: false }))
      .toEqual({ text: "YouTube couldn't be loaded — see the note above.", error: true });
    const loading = combineGrowth({ ...allReady(), snapchat: undefined });
    expect(growthTableEmpty(loading, { platform: "snapchat", searching: false }).text).toBe("Loading Snapchat channels…");
  });
});

describe("errors are worded by kind — the raw reply never reaches the screen", () => {
  it("a failed source gets a calm sentence for its kind, never the API's own text", () => {
    const r = combineGrowth({
      meta: { error: "Too many requests, please try again later" },
      youtube: { error: "An unexpected error occurred" },
      snapchat: { error: `Unexpected token '<', "<html>"... is not valid JSON` },
      periodDays: 28,
    });
    const problems = growthSourceProblems(r);
    expect(problems.map((p) => [p.source, p.kind])).toEqual([["meta", "busy"], ["youtube", "failed"], ["snapchat", "failed"]]);
    expect(problems[0].platforms).toEqual(["facebook", "instagram"]);
    expect(problems[0].text).toMatch(/^Facebook and Instagram asked us to slow down/);
    expect(problems[1].text).toMatch(/^YouTube couldn't be loaded just now/);
    for (const p of problems) expect(noBanned(p.text)).toBe(true);
  });

  it("a period mismatch keeps this module's own sentence; a 403 says it is admin-only", () => {
    const r = combineGrowth({ ...allReady(28), youtube: board("youtube", { days: 30 }), snapchat: { error: "Admin role required" } });
    const [yt, sc] = growthSourceProblems(r);
    expect(yt.kind).toBe("mismatch");
    expect(yt.text).toMatch(/30 days, not the 28 days asked for/);
    expect(sc.kind).toBe("forbidden");
    expect(sc.text).toBe("Only administrators can see Account Growth.");
    expect(growthSourceProblems(combineGrowth(allReady()))).toEqual([]);
  });

  it("a channel's failed refresh is classified, and the tooltip never repeats the platform's reply", () => {
    const cases: Array<[string, string]> = [
      ["An unexpected error has occurred. Please retry your request later.", "temporary"],
      ["(#4) Application request limit reached", "temporary"],
      ["This operation was aborted", "temporary"],
      ["(#10) Application does not have permission for this action", "access"],
      ["The user must be an administrator, editor, or moderator of the page … Two Factor Authentication.", "access"],
      ["YouTube returned no channel for this handle — it has most likely been renamed, deleted or terminated.", "gone"],
      ["handle does not exist (404)", "gone"],
      ["(#100) Tried accessing nonexisting field", "other"],
    ];
    for (const [msg, kind] of cases) {
      expect(growthRefreshFailureKind(msg)).toBe(kind);
      for (const p of ["facebook", "youtube", "snapchat"] as const) {
        const text = growthRefreshFailureText(msg, p);
        expect(text).not.toContain(msg);
        expect(noBanned(text)).toBe(true);
      }
    }
    expect(growthRefreshFailureText("(#10) permission", "instagram")).toMatch(/Meta tab/);
  });

  it("lists names the way the copy reads them", () => {
    expect(growthListNames(["youtube"])).toBe("YouTube");
    expect(growthListNames(["facebook", "instagram"], "or")).toBe("Facebook or Instagram");
    expect(growthListNames(["facebook", "instagram", "youtube"])).toBe("Facebook, Instagram and YouTube");
    expect(growthListNames([])).toBe("");
  });
});
