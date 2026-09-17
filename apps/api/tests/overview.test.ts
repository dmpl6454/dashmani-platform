/**
 * Overview payload — the aggregated command-centre endpoint.
 *
 * The contract under test is honesty: every figure comes from stored platform
 * data, sums are like-for-like with their baselines, and anything no channel
 * reported is NULL rather than a fabricated zero. The pure helpers are tested
 * directly; the builder is tested against a small seeded estate.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@dashmani/db";
import {
  forwardFillFollowerSeries,
  getOverview,
  indexSeries,
  invalidateOverviewCache,
  parseCityBucket,
  pctChange,
  tierForRank,
  topWithOthers,
  trendFrom,
  genderLabel,
} from "../src/services/overview.service";
import { invalidateRangeCache } from "../src/services/meta-oauth/meta-range.service";
import "./setup";

const DAY = 86_400_000;
function isoDaysAgo(n: number): string {
  return new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
}
function dateOf(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

describe("overview helpers", () => {
  it("parses Meta's 'City, State' buckets and recognises Indian states, aliases and the Punjab trap", () => {
    expect(parseCityBucket("Mumbai, Maharashtra")).toEqual({ name: "Mumbai", state: "Maharashtra", india: true });
    expect(parseCityBucket("Bangalore, Karnataka").name).toBe("Bengaluru");
    expect(parseCityBucket("Gauhati, Assam").name).toBe("Guwahati");
    expect(parseCityBucket("Ludhiana, Punjab region").india).toBe(true);
    expect(parseCityBucket("Lahore, Punjab").india).toBe(false);
    expect(parseCityBucket("Karachi, Sindh").india).toBe(false);
    expect(parseCityBucket("Dubai").india).toBe(false);
  });

  it("tiers cities by rank: top three high, next four growing, the rest emerging", () => {
    expect(tierForRank(1)).toBe("high");
    expect(tierForRank(3)).toBe("high");
    expect(tierForRank(4)).toBe("growing");
    expect(tierForRank(7)).toBe("growing");
    expect(tierForRank(8)).toBe("emerging");
  });

  it("labels Meta gender codes and passes unknown buckets through", () => {
    expect(genderLabel("F")).toBe("Women");
    expect(genderLabel("M")).toBe("Men");
    expect(genderLabel("U")).toBe("Undisclosed");
    expect(genderLabel("X")).toBe("X");
  });

  it("pctChange is null without a usable baseline — never a fabricated 0% or ∞", () => {
    expect(pctChange(120, 100)).toBeCloseTo(20);
    expect(pctChange(null, 100)).toBeNull();
    expect(pctChange(100, null)).toBeNull();
    expect(pctChange(100, 0)).toBeNull();
  });

  it("trendFrom marks a thin baseline unreliable", () => {
    expect(trendFrom(120, { value: 100, coverageShare: 1, assets: 10 }, 10)).toEqual({ pct: 20, reliable: true });
    expect(trendFrom(120, { value: 100, coverageShare: 0.5, assets: 10 }, 10)?.reliable).toBe(false);
    // A 2-channel baseline compared against 400 contributing channels is the mid-backfill state.
    expect(trendFrom(120, { value: 100, coverageShare: 1, assets: 2 }, 400)?.reliable).toBe(false);
    expect(trendFrom(120, null, 10)).toBeNull();
  });

  it("indexSeries rebases to the first usable point and keeps gaps as null", () => {
    expect(indexSeries([200, 220, null, 260]).map((v) => (v == null ? null : Math.round(v * 1e6) / 1e6))).toEqual([100, 110, null, 130]);
    expect(indexSeries([null, null])).toEqual([null, null]);
    expect(indexSeries([0, 50, 100])).toEqual([0, 100, 200]);
  });

  it("topWithOthers folds the tail into one slice and shares sum to 100", () => {
    const rows = topWithOthers(
      [{ name: "a", value: 50 }, { name: "b", value: 30 }, { name: "c", value: 15 }, { name: "d", value: 5 }],
      2,
    );
    expect(rows.map((r) => r.name)).toEqual(["a", "b", "Others"]);
    expect(rows.reduce((s, r) => s + r.share, 0)).toBeCloseTo(100);
    expect(rows[2].value).toBe(20);
    expect(topWithOthers([], 3)).toEqual([]);
  });

  it("forward-fills follower snapshots and excludes accounts that appear mid-window", () => {
    const days = ["2026-09-10", "2026-09-11", "2026-09-12", "2026-09-13"];
    const rows = [
      { accountId: "a", date: "2026-09-09", followerCount: 100 }, // seeds day 1 from before the window
      { accountId: "a", date: "2026-09-11", followerCount: 110 },
      { accountId: "b", date: "2026-09-10", followerCount: 1000 },
      { accountId: "b", date: "2026-09-13", followerCount: 1030 },
      { accountId: "late", date: "2026-09-13", followerCount: 999_999 }, // joined mid-window → excluded
    ];
    const { series, used } = forwardFillFollowerSeries(rows, days);
    expect(used).toBe(2);
    expect(series.map((s) => s.followers)).toEqual([1100, 1110, 1110, 1140]);
  });
});

describe("getOverview against a seeded estate", () => {
  let fbId: string;
  let igId: string;
  let employeeId: string;

  beforeEach(async () => {
    invalidateOverviewCache();
    invalidateRangeCache();
    const admin = await prisma.user.create({ data: { name: "Admin One", email: "admin-ov@zz.test", passwordHash: "x", status: "ACTIVE" } });
    const emp = await prisma.user.create({ data: { name: "Roshan S", email: "emp-ov@zz.test", passwordHash: "x", status: "ACTIVE" } });
    employeeId = emp.id;
    const conn = await prisma.metaConnection.create({ data: { metaUserId: "mu-ov", connectedById: admin.id, status: "ACTIVE" } });
    const fb = await prisma.metaAsset.create({
      data: { connectionId: conn.id, kind: "FACEBOOK_PAGE", metaId: "fb-1", name: "Bollywood Society", followerCount: 1_000_000 },
    });
    const ig = await prisma.metaAsset.create({
      data: { connectionId: conn.id, kind: "INSTAGRAM_ACCOUNT", metaId: "ig-1", name: "Dashmani IG", username: "dashmani", followerCount: 250_000 },
    });
    fbId = fb.id;
    igId = ig.id;

    // 21 closed days of history: FB earns, IG does not report earnings at all.
    for (let n = 1; n <= 21; n++) {
      const date = dateOf(isoDaysAgo(n));
      await prisma.metaAssetDaily.create({
        data: { assetId: fb.id, date, views: BigInt(100), engagements: BigInt(10), reactions: BigInt(4), shares: 2, earningsCents: 50 },
      });
      await prisma.metaAssetDaily.create({
        data: { assetId: ig.id, date, views: BigInt(60), engagements: BigInt(6), reactions: BigInt(3), shares: 1 },
      });
    }
    await prisma.metaAssetMetric.create({ data: { assetId: fb.id, window: "week", reach: BigInt(5000) } });
    await prisma.metaAssetMetric.create({ data: { assetId: ig.id, window: "week", reach: BigInt(700) } });

    const demo = [
      ["city", "Mumbai, Maharashtra", 500],
      ["city", "Bangalore, Karnataka", 300],
      ["city", "Karachi, Sindh", 200],
      ["age", "18-24", 400],
      ["age", "25-34", 600],
      ["gender", "M", 700],
      ["gender", "F", 300],
      ["country", "IN", 900],
      ["country", "PK", 100],
    ] as const;
    for (const [dimension, bucket, value] of demo) {
      await prisma.metaAssetDemographic.create({
        data: { assetId: ig.id, audience: "follower", dimension, bucket, value, fetchedAt: new Date() },
      });
    }

    await prisma.metaPost.create({
      data: {
        assetId: fb.id, metaPostId: "p1", caption: "Ganpati Bappa Morya 🙏\nsecond line", permalink: "https://facebook.com/reel/1",
        postedAt: new Date(Date.now() - 5 * 60_000), views: 46, likes: 3, comments: 1, mediaProductType: "REELS",
      },
    });
    await prisma.metaPost.create({
      data: { assetId: ig.id, metaPostId: "p2", caption: null, postedAt: new Date(Date.now() - 60 * 60_000), views: 7 },
    });

    await prisma.dailyReport.create({
      data: { employeeId: emp.id, date: dateOf(isoDaysAgo(0)), submittedAt: new Date(Date.now() - 10 * 60_000) },
    });

    const entity = await prisma.entity.create({ data: { canonicalName: "Kriti Sanon", type: "PERSON", aliases: [] } });
    const content = await prisma.linkContent.create({ data: { canonicalKey: "ig:x1", platform: "instagram", status: "ok", caption: "Kriti" } });
    await prisma.linkContentEntity.create({ data: { linkContentId: content.id, entityId: entity.id } });
  });

  it("sums period metrics like-for-like and reports the reach window only where Meta publishes it", async () => {
    const o = await getOverview({ days: 7, audDays: 30, revDays: 30 });
    expect(o.channels).toEqual({ total: 2, facebook: 1, instagram: 1 });
    // 7 closed days × (100 + 60) views; both channels contribute.
    expect(o.kpis.views.value).toBe(7 * 160);
    expect(o.kpis.views.contributing).toBe(2);
    expect(o.kpis.views.previous).toBe(7 * 160);
    expect(o.kpis.views.trend).toEqual({ pct: 0, reliable: true });
    // Only Facebook reports earnings — the IG null must not drag the total to zero.
    expect(o.kpis.revenue.value).toBe(7 * 50);
    expect(o.kpis.revenue.contributing).toBe(1);
    expect(o.kpis.reach).toEqual({ value: 5700, window: "week", contributing: 2 });
    expect(o.kpis.followers.value).toBe(1_250_000);
    expect(o.period.days).toBe(7);
    expect(o.period.dataThroughDay).toBe(isoDaysAgo(1));
  });

  it("has no reach window for a 14-day period, because Meta only publishes 1/7/28-day unique counts", async () => {
    const o = await getOverview({ days: 14, audDays: 30, revDays: 30 });
    expect(o.kpis.reach.window).toBeNull();
    expect(o.kpis.reach.value).toBeNull();
    expect(o.kpis.views.value).toBe(14 * 160);
  });

  it("ranks channels, folds the donut tail and links revenue rows to earning channels only", async () => {
    const o = await getOverview({ days: 7, audDays: 30, revDays: 30 });
    expect(o.topChannels.map((c) => c.name)).toEqual(["Bollywood Society", "Dashmani IG"]);
    expect(o.topChannels[0]).toMatchObject({ metaId: "fb-1", platform: "facebook", views: 700, earningsCents: 350 });
    expect(o.revenueByChannel.map((c) => c.name)).toEqual(["Bollywood Society"]);
    expect(o.viewsByChannel.map((v) => v.name)).toEqual(["Bollywood Society", "Dashmani IG"]);
    expect(o.viewsByChannel.reduce((s, v) => s + v.share, 0)).toBeCloseTo(100);
  });

  it("maps the Instagram follower audience onto Indian cities and discloses the share outside India", async () => {
    const o = await getOverview({ days: 7, audDays: 30, revDays: 30 });
    expect(o.cities.total).toBe(1000);
    expect(o.cities.indiaShare).toBeCloseTo(80);
    expect(o.cities.items.map((c) => c.name)).toEqual(["Mumbai", "Bengaluru"]);
    expect(o.cities.items[0]).toMatchObject({ state: "Maharashtra", share: 50, tier: "high" });
    expect(o.demographics.age.map((a) => a.bucket)).toEqual(["18-24", "25-34"]);
    expect(o.demographics.gender[0]).toEqual({ bucket: "M", label: "Men", value: 700 });
    expect(o.demographics.country.map((c) => c.bucket)).toEqual(["IN", "PK"]);
    expect(o.demographics.assets).toBe(1);
  });

  it("builds the feed, activity and trending lists from real rows", async () => {
    const o = await getOverview({ days: 7, audDays: 30, revDays: 30 });
    expect(o.latestPosts).toHaveLength(2);
    expect(o.latestPosts[0]).toMatchObject({ title: "Ganpati Bappa Morya 🙏", mediaProductType: "REELS", views: 46 });
    expect(o.latestPosts[0].channel).toMatchObject({ name: "Bollywood Society", platform: "facebook" });
    expect(o.latestPosts[1].title).toBe("Untitled post");
    const kinds = o.activity.map((a) => a.kind);
    expect(kinds).toContain("post");
    expect(kinds).toContain("report");
    expect(o.activity.find((a) => a.kind === "report")?.text).toBe("Roshan S submitted a daily report with 0 links");
    // Newest first.
    for (let i = 1; i < o.activity.length; i++) expect(o.activity[i - 1].at >= o.activity[i].at).toBe(true);
    expect(o.trending).toEqual([{ id: expect.any(String), name: "Kriti Sanon", type: "PERSON", count: 1, previousCount: 0 }]);
  });

  it("computes traction over the last 7 closed days with an equal-length baseline", async () => {
    const o = await getOverview({ days: 7, audDays: 30, revDays: 30 });
    const views = o.traction.tiles.find((t) => t.key === "views")!;
    expect(views.value).toBe(7 * 160);
    expect(views.previous).toBe(7 * 160);
    expect(views.pct).toBe(0);
    expect(o.traction.series).toHaveLength(7);
    expect(o.traction.series[6].date).toBe(isoDaysAgo(1));
    expect(o.traction.series[0].shares).toBe(3);
  });

  it("returns NULL, never 0, for every metric of an estate that has reported nothing", async () => {
    await prisma.metaAssetDaily.deleteMany({});
    await prisma.metaAssetMetric.deleteMany({});
    invalidateOverviewCache();
    invalidateRangeCache();
    const o = await getOverview({ days: 7, audDays: 30, revDays: 30 });
    expect(o.kpis.views.value).toBeNull();
    expect(o.kpis.revenue.value).toBeNull();
    expect(o.kpis.reach.value).toBeNull();
    expect(o.kpis.views.trend).toBeNull();
    expect(o.revenue.totalCents).toBeNull();
    expect(o.traction.tiles.every((t) => t.value === null && t.pct === null)).toBe(true);
    // The channel count itself is a real fact and stays.
    expect(o.channels.total).toBe(2);
    expect(o.kpis.followers.value).toBe(1_250_000);
  });

  it("memoises the payload for a minute and honours invalidation", async () => {
    const a = await getOverview({ days: 7, audDays: 30, revDays: 30 });
    await prisma.metaAsset.update({ where: { id: igId }, data: { followerCount: 999 } });
    const b = await getOverview({ days: 7, audDays: 30, revDays: 30 });
    expect(b.kpis.followers.value).toBe(a.kpis.followers.value);
    invalidateOverviewCache();
    const c = await getOverview({ days: 7, audDays: 30, revDays: 30 });
    expect(c.kpis.followers.value).toBe(1_000_999);
  });
});
