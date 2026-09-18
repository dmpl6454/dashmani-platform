/**
 * Regressions from the 2026-09-17 "standalone Overview + accuracy" pass.
 *
 * Every assertion here locks a defect that was LIVE on production, so they are
 * deliberately about MECHANISM rather than exact figures:
 *   1. the window must end on a day the whole estate has closed, not the clock's
 *      yesterday (which held Instagram rows only for most of each UTC day and made
 *      Views render ↓14.2% where the truth was ↓5.1%);
 *   2. the header search must reach every channel, not the 8 that happened to rank;
 *   3. an absent like-for-like denominator is NULL, never 0;
 *   4. a future-dated post must not head "Latest Posts";
 *   5. ⚠️ the endpoint carries org-wide REVENUE and is deliberately open to every
 *      internal role — but it must still reject HR and CLIENT-portal tokens, which
 *      `authenticate` alone would admit because all three portals share JWT_SECRET.
 */

import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import app from "../src/app";
import { prisma } from "@dashmani/db";
import { createTestUser, createTestRole, generateToken } from "./helpers";
import { getOverview, invalidateOverviewCache } from "../src/services/overview.service";
import { shiftDay } from "../src/services/meta-oauth/meta-range.service";
import { invalidateRangeCache } from "../src/services/meta-oauth/meta-range.service";
import "./setup";

const DAY = 86_400_000;
const isoDaysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
const dateOf = (iso: string) => new Date(`${iso}T00:00:00Z`);

async function seedEstate() {
  const admin = await prisma.user.create({
    data: { name: "Admin W", email: `admin-ovs-${Date.now()}@zz.test`, passwordHash: "x", status: "ACTIVE" },
  });
  const conn = await prisma.metaConnection.create({
    data: { metaUserId: `mu-ovs-${Date.now()}`, connectedById: admin.id, status: "ACTIVE" },
  });
  const fb = await prisma.metaAsset.create({
    data: { connectionId: conn.id, kind: "FACEBOOK_PAGE", metaId: "fb-w", name: "Page W", followerCount: 900_000 },
  });
  const ig = await prisma.metaAsset.create({
    data: { connectionId: conn.id, kind: "INSTAGRAM_ACCOUNT", metaId: "ig-w", name: "IG W", username: "igw", followerCount: 100_000 },
  });
  for (let n = 1; n <= 14; n++) {
    const date = dateOf(isoDaysAgo(n));
    await prisma.metaAssetDaily.create({
      data: { assetId: fb.id, date, views: BigInt(200), engagements: BigInt(20), earningsCents: 100 },
    });
    await prisma.metaAssetDaily.create({
      data: { assetId: ig.id, date, views: BigInt(50), engagements: BigInt(5) },
    });
  }
  return { fbId: fb.id, igId: ig.id };
}

describe("overview — window end, directory and NULL discipline", () => {
  let fbId: string;
  let igId: string;

  beforeEach(async () => {
    // ⚠️ Mandatory: both caches are module-level and 60s TTL'd. Without this a
    // payload built by the previous test leaks into this one (the documented
    // cross-test cache-pollution class).
    invalidateOverviewCache();
    invalidateRangeCache();
    ({ fbId, igId } = await seedEstate());
  });

  it("ends the window on the newest FULLY covered day, not the clock's yesterday", async () => {
    // Every day is covered by both assets, so yesterday is genuinely complete.
    const full = await getOverview({ days: 7, audDays: 30, revDays: 30 });
    expect(full.period.end).toBe(isoDaysAgo(1));

    // Now reproduce a real morning on prod: Instagram has closed its UTC day and
    // written its row; Facebook, whose day closes at Pacific midnight, has not.
    // Coverage falls to 1 of 2 and that day must NOT be allowed to end the window.
    invalidateOverviewCache();
    invalidateRangeCache();
    await prisma.metaAssetDaily.deleteMany({ where: { assetId: fbId, date: dateOf(isoDaysAgo(1)) } });

    const partial = await getOverview({ days: 7, audDays: 30, revDays: 30 });
    expect(partial.period.end).toBe(isoDaysAgo(2));
    // the whole window shifts with it, so current and baseline stay equal-length
    expect(partial.period.start).toBe(isoDaysAgo(8));
    expect(partial.period.prevEnd).toBe(isoDaysAgo(9));
    // and the freshness label follows the data rather than the clock
    expect(partial.period.dataThroughDay).toBe(isoDaysAgo(2));
  });

  it("lists EVERY live channel in allChannels, not just the ranked few", async () => {
    const o = await getOverview({ days: 7, audDays: 30, revDays: 30 });
    expect(o.allChannels).toHaveLength(2);
    expect(o.allChannels.map((c) => c.id).sort()).toEqual([fbId, igId].sort());
    // followers-desc, so an empty query opens on the biggest channels
    expect(o.allChannels[0].id).toBe(fbId);
    // and it carries the figures the drawer needs, not merely a name
    expect(o.allChannels[0].views).toBeGreaterThan(0);
  });

  it("reports followersWithHistory as NULL — never 0 — when no channel has snapshot history", async () => {
    const o = await getOverview({ days: 7, audDays: 30, revDays: 30 });
    // The stock is real and must still be reported…
    expect(o.kpis.followers.value).toBe(1_000_000);
    // …but the like-for-like denominator is absent, and absent is null.
    expect(o.kpis.followers.channelsWithHistory).toBe(0);
    expect(o.kpis.followers.followersWithHistory).toBeNull();
    expect(o.kpis.followers.delta).toBeNull();
  });

  it("keeps a future-dated post out of Latest Posts", async () => {
    await prisma.metaPost.create({
      data: { assetId: fbId, metaPostId: "future-1", caption: "Scheduled for tomorrow", postedAt: new Date(Date.now() + 6 * 60 * 60_000) },
    });
    await prisma.metaPost.create({
      data: { assetId: fbId, metaPostId: "now-1", caption: "Published moments ago", postedAt: new Date(Date.now() - 60_000), views: 5 },
    });
    invalidateOverviewCache();
    const o = await getOverview({ days: 7, audDays: 30, revDays: 30 });
    const titles = o.latestPosts.map((p) => p.title);
    expect(titles).toContain("Published moments ago");
    expect(titles).not.toContain("Scheduled for tomorrow");
  });
});

describe("GET /v1/admin/overview — open to every internal role, closed to other portals", () => {
  beforeEach(async () => {
    invalidateOverviewCache();
    invalidateRangeCache();
    await seedEstate();
  });

  it("serves a plain Employee with no permissions at all", async () => {
    // ⚠️ This is the whole point of the 2026-09-17 change. The endpoint used to be
    // gated on reports.manage + requireAdminRole, which 403'd 111 of 115 real users.
    // Note the role has NO permissions — not even reports.view, which the Employee
    // role genuinely does not hold.
    await createTestRole("PlainEmployee", []);
    const user = await createTestUser({ email: `plain-${Date.now()}@test.com`, roleNames: ["PlainEmployee"] });
    const token = generateToken(user.id, user.email, ["PlainEmployee"]);

    const res = await request(app).get("/v1/admin/overview?days=7").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.kpis.revenue).toBeDefined();
  });

  it("rejects a CLIENT-portal token, which shares the same JWT secret", async () => {
    // ⚠️ THE REGRESSION GUARD. All three portals sign with one JWT_SECRET and
    // `authenticate` never inspects payload.type, so a client token verifies there.
    // Before requireInternalUser it was stopped only as a side effect of the
    // permission lookup failing. Reduce the gate to [authenticate] and this test
    // fails — which is the point: it would hand org-wide revenue to an external client.
    const client = await prisma.client.findFirst();
    const clientId = client?.id ?? "00000000-0000-0000-0000-000000000000";
    const token = jwt.sign(
      { userId: clientId, email: "someone@client.test", roles: [], type: "client" },
      process.env.JWT_SECRET || "dev-secret",
      { expiresIn: "15m" },
    );

    const res = await request(app).get("/v1/admin/overview?days=7").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  it("rejects an HR-portal token for the same reason", async () => {
    const user = await createTestUser({ email: `hrtok-${Date.now()}@test.com` });
    const token = jwt.sign(
      { userId: user.id, email: user.email, roles: [], type: "hr" },
      process.env.JWT_SECRET || "dev-secret",
      { expiresIn: "15m" },
    );

    const res = await request(app).get("/v1/admin/overview?days=7").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  it("still requires a token at all", async () => {
    const res = await request(app).get("/v1/admin/overview?days=7");
    expect(res.status).toBe(401);
  });
});

/**
 * ⚠️ THE PRECEDENCE CONTRACT. A card follows the global period until it is explicitly
 * detached, and a detached card's period then applies to THAT CARD ONLY. Every one of
 * these would have been satisfied by the old code returning `undefined` and falling
 * through to the global — which is why the detached cases assert a DIFFERENT window,
 * not merely a present one.
 */
describe("overview — per-card periods override the global for that card only", () => {
  beforeEach(async () => {
    invalidateOverviewCache();
    invalidateRangeCache();
    await seedEstate();
  });

  const base = { days: 7, audDays: 0, revDays: 0, vbcDays: 0, tracDays: 0 } as const;

  it("0 means follow the global period, for every card", async () => {
    const o = await getOverview({ ...base, days: 30 });
    expect(o.period.days).toBe(30);
    expect(o.audience.days).toBe(30);
    expect(o.revenue.days).toBe(30);
    expect(o.viewsByChannelDays).toBe(30);
    expect(o.traction.days).toBe(30);
    // and moving the global moves them all
    invalidateOverviewCache();
    const seven = await getOverview({ ...base, days: 7 });
    expect([seven.audience.days, seven.revenue.days, seven.viewsByChannelDays, seven.traction.days]).toEqual([7, 7, 7, 7]);
  });

  it("a detached card keeps its own window while every other card follows the global", async () => {
    const o = await getOverview({ ...base, days: 7, vbcDays: 30 });
    expect(o.period.days).toBe(7);
    expect(o.viewsByChannelDays).toBe(30);      // detached
    expect(o.audience.days).toBe(7);            // still following
    expect(o.revenue.days).toBe(7);
    expect(o.traction.days).toBe(7);
  });

  it("each card can be detached independently", async () => {
    const o = await getOverview({ days: 7, audDays: 90, revDays: 14, vbcDays: 30, tracDays: 90 });
    expect(o.period.days).toBe(7);
    expect(o.audience.days).toBe(90);
    expect(o.revenue.days).toBe(14);
    expect(o.viewsByChannelDays).toBe(30);
    expect(o.traction.days).toBe(90);
    // the traction series really is that long, not a 7-day series wearing a 90-day label
    expect(o.traction.series).toHaveLength(90);
  });

  it("⚠️ the memo keys on EVERY period — one card's window can never be served another's", async () => {
    const a = await getOverview({ ...base, days: 7, vbcDays: 7 });
    const b = await getOverview({ ...base, days: 7, vbcDays: 90 });
    expect(a.viewsByChannelDays).toBe(7);
    expect(b.viewsByChannelDays).toBe(90);
    // same global window, so the shared parts must still agree
    expect(b.period.start).toBe(a.period.start);
    expect(b.kpis.views.value).toBe(a.kpis.views.value);
  });

  it("a detached Views by Channel really aggregates over its own window", async () => {
    // The estate reports a fixed 250 views/day (200 FB + 50 IG) for 14 days.
    const wide = await getOverview({ ...base, days: 7, vbcDays: 14 });
    const narrow = await getOverview({ ...base, days: 7, vbcDays: 7 });
    const sum = (o: Awaited<ReturnType<typeof getOverview>>) =>
      o.viewsByChannelAll.reduce((t, c) => t + c.views, 0);
    expect(sum(wide)).toBe(sum(narrow) * 2);
    // …while the KPI strip, which follows the global, is untouched by that choice
    expect(wide.kpis.views.value).toBe(narrow.kpis.views.value);
  });

  it("every channel appears in the expanded Views-by-Channel list, with shares summing to 100", async () => {
    const o = await getOverview(base);
    expect(o.viewsByChannelAll).toHaveLength(2);
    const total = o.viewsByChannelAll.reduce((t, c) => t + c.share, 0);
    expect(total).toBeCloseTo(100, 6);
    // the card itself still folds to a readable top-N + Others
    expect(o.viewsByChannel.length).toBeLessThanOrEqual(8);
  });
});

/**
 * ⚠️ REACH IS NULL FOR 14 AND 90 DAYS BY DESIGN, NOT BY FAILURE.
 * It counts UNIQUE PEOPLE, so it cannot be summed across days (the documented 56%
 * overstatement). We can only report Meta's own native windows — `week` and `days_28`.
 * An owner read the resulting em-dash as missing data, so the contract is locked here
 * and the UI states whose limitation it is.
 */
describe("overview — reach is reported only for Meta's native windows", () => {
  beforeEach(async () => {
    invalidateOverviewCache();
    invalidateRangeCache();
    const { fbId, igId } = await seedEstate();
    // Meta publishes reach per native window, never per arbitrary range.
    await prisma.metaAssetMetric.create({ data: { assetId: fbId, window: "week", reach: BigInt(5_000) } });
    await prisma.metaAssetMetric.create({ data: { assetId: igId, window: "week", reach: BigInt(700) } });
    await prisma.metaAssetMetric.create({ data: { assetId: fbId, window: "days_28", reach: BigInt(14_000) } });
    await prisma.metaAssetMetric.create({ data: { assetId: igId, window: "days_28", reach: BigInt(2_000) } });
  });

  const base = { audDays: 0, revDays: 0, vbcDays: 0, tracDays: 0 } as const;

  it("reports Meta's week figure at 7 days and its 28-day figure at 30", async () => {
    const seven = await getOverview({ ...base, days: 7 });
    expect(seven.kpis.reach.window).toBe("week");
    expect(seven.kpis.reach.value).toBe(5_700);
    expect(seven.kpis.reach.contributing).toBe(2);

    invalidateOverviewCache();
    const thirty = await getOverview({ ...base, days: 30 });
    expect(thirty.kpis.reach.window).toBe("days_28");
    expect(thirty.kpis.reach.value).toBe(16_000);
  });

  it("returns NULL — never 0, never a sum — for 14 and 90 days", async () => {
    for (const days of [14, 90] as const) {
      invalidateOverviewCache();
      const o = await getOverview({ ...base, days });
      expect(o.kpis.reach.window).toBeNull();
      expect(o.kpis.reach.value).toBeNull();     // ⚠️ null, so the UI renders an em-dash
      expect(o.kpis.reach.contributing).toBe(0);
      // …and the rest of the period is emphatically NOT missing
      expect(o.kpis.views.value).toBeGreaterThan(0);
      expect(o.kpis.engagements.value).toBeGreaterThan(0);
    }
  });

  it("never adds the two native windows together to fake a longer one", async () => {
    invalidateOverviewCache();
    const ninety = await getOverview({ ...base, days: 90 });
    // 5,700 + 16,000 = 21,700 would be the tempting (and wrong) answer
    expect(ninety.kpis.reach.value).not.toBe(21_700);
    expect(ninety.kpis.reach.value).toBeNull();
  });
});

/**
 * Regressions from the 2026-09-18 "interactions + accuracy" pass.
 *
 * ⚠️ THE FIXTURE GAP THESE CLOSE. Until now no fixture anywhere carried
 * `earningsCents: 0`, so the two definitions of "contributing" — `!= null` (the overview)
 * and `> 0` (Account Growth) — were INDISTINGUISHABLE to the suite. That is precisely why
 * the KPI could report 317 "Pages reporting earnings" on prod while 260 of those 317 had
 * earned exactly nothing, and why no test caught it. A zero-earning Page is now seeded.
 */
describe("overview — 2026-09-18 interactions and accuracy", () => {
  beforeEach(async () => {
    invalidateOverviewCache();
    invalidateRangeCache();
  });

  async function seedWithAZeroEarningPage() {
    const admin = await prisma.user.create({
      data: { name: "Admin Z", email: `admin-ovz-${Date.now()}@zz.test`, passwordHash: "x", status: "ACTIVE" },
    });
    const conn = await prisma.metaConnection.create({
      data: { metaUserId: `mu-ovz-${Date.now()}`, connectedById: admin.id, status: "ACTIVE" },
    });
    // Earns real money.
    const earner = await prisma.metaAsset.create({
      data: { connectionId: conn.id, kind: "FACEBOOK_PAGE", metaId: "fb-earn", name: "Earner", followerCount: 500_000 },
    });
    // Monetised and REPORTING, but every day is a genuine 0.00 — the 260-Page case on prod.
    const zero = await prisma.metaAsset.create({
      data: { connectionId: conn.id, kind: "FACEBOOK_PAGE", metaId: "fb-zero", name: "Zero Earner", followerCount: 400_000 },
    });
    for (let n = 1; n <= 14; n++) {
      const date = dateOf(isoDaysAgo(n));
      await prisma.metaAssetDaily.create({
        data: { assetId: earner.id, date, views: BigInt(1000), engagements: BigInt(100), earningsCents: 250 },
      });
      await prisma.metaAssetDaily.create({
        data: { assetId: zero.id, date, views: BigInt(900), engagements: BigInt(90), earningsCents: 0 },
      });
    }
    return { earnerId: earner.id, zeroId: zero.id };
  }

  it("counts REPORTING and EARNING Pages separately — a monetised Page at $0.00 reports but does not earn", async () => {
    await seedWithAZeroEarningPage();
    const o = await getOverview({ days: 7, audDays: 0, revDays: 0, vbcDays: 0, tracDays: 0 });
    // Both Pages answered, so both are "contributing"...
    expect(o.kpis.revenue.contributing).toBe(2);
    // ...but only one of them actually earned. This is the assertion that would have
    // caught the mislabel: with a single count these two numbers are the same.
    expect(o.kpis.revenue.earning).toBe(1);
    expect(o.kpis.revenue.earning).toBeLessThan(o.kpis.revenue.contributing);
  });

  it("never reports a zero-earning Page as earning, even though its figure is a real 0 and not null", async () => {
    const { zeroId } = await seedWithAZeroEarningPage();
    const o = await getOverview({ days: 7, audDays: 0, revDays: 0, vbcDays: 0, tracDays: 0 });
    const zeroRow = o.allChannels.find((c) => c.id === zeroId)!;
    // A real 0 — NOT null. That distinction is the whole bug.
    expect(zeroRow.earningsCents).toBe(0);
    expect(zeroRow.earningsCents).not.toBeNull();
    // And it must not appear in the earning-channel list.
    expect(o.revenueByChannel.map((c) => c.id)).not.toContain(zeroId);
  });

  it("⚠️ never emits a `leave` activity item — named leave status must not reach every internal user", async () => {
    const admin = await prisma.user.create({
      data: { name: "Leave Admin", email: `lv-admin-${Date.now()}@zz.test`, passwordHash: "x", status: "ACTIVE" },
    });
    await prisma.leaveRequest.create({
      data: {
        employeeId: admin.id,
        type: "SICK",
        status: "PENDING",
        startDate: dateOf(isoDaysAgo(1)),
        endDate: dateOf(isoDaysAgo(0)),
        reason: "flu",
      },
    });
    const o = await getOverview({ days: 7, audDays: 0, revDays: 0, vbcDays: 0, tracDays: 0 });
    // The row exists in the database; it must simply never be published here.
    expect(await prisma.leaveRequest.count()).toBeGreaterThan(0);
    expect(o.activity.map((a) => a.kind)).not.toContain("leave");
    expect(JSON.stringify(o.activity)).not.toMatch(/sick/i);
  });

  it("gives every activity item a target, so the feed is not a dead end", async () => {
    await seedEstate();
    await prisma.metaPost.create({
      data: {
        assetId: (await prisma.metaAsset.findFirstOrThrow({ where: { kind: "FACEBOOK_PAGE" } })).id,
        metaPostId: `pz-${Date.now()}`,
        caption: "hello",
        postedAt: new Date(Date.now() - 30 * 60_000),
        views: 5,
      },
    });
    const o = await getOverview({ days: 7, audDays: 0, revDays: 0, vbcDays: 0, tracDays: 0 });
    expect(o.activity.length).toBeGreaterThan(0);
    for (const a of o.activity) {
      // Exactly one of the two is how the client knows where to go.
      expect(a.postId != null || a.href != null).toBe(true);
    }
    // A post item must point at a post that is actually in the payload, or the drawer
    // would open empty.
    for (const a of o.activity.filter((x) => x.postId)) {
      expect(o.latestPosts.some((p) => p.id === a.postId)).toBe(true);
    }
  });

  it("carries the Views-by-Channel total over THAT card's window, not the global period", async () => {
    await seedEstate();
    // Global 7 days, card detached to 14 — the two totals must differ and each must match
    // its own window. The donut centre used to render the GLOBAL figure beside 14-day
    // slices (measured 12x apart on prod).
    const o = await getOverview({ days: 7, audDays: 0, revDays: 0, vbcDays: 14, tracDays: 0 });
    expect(o.viewsByChannelDays).toBe(14);
    const sliceSum = o.viewsByChannelAll.reduce((t, c) => t + c.views, 0);
    expect(o.viewsByChannelTotal).toBe(sliceSum);
    expect(o.viewsByChannelTotal).not.toBe(o.kpis.views.value);
  });
});

/**
 * Custom date range (2026-09-18).
 *
 * The owner asked for Account Growth's calendar range on the overview. These lock the
 * three things that make it trustworthy rather than merely present: it overrides the
 * preset, it is CLAMPED to the last closed day (Account Growth's version is not, and was
 * measured understating a 7-day span by 7.2%), and it never invents a reach figure.
 */
describe("overview — custom date range", () => {
  beforeEach(async () => {
    invalidateOverviewCache();
    invalidateRangeCache();
    await seedEstate();
  });

  it("an explicit start/end overrides the preset and reports its own span", async () => {
    const o = await getOverview({
      days: 7,
      range: { start: isoDaysAgo(10), end: isoDaysAgo(4) },
      audDays: 0, revDays: 0, vbcDays: 0, tracDays: 0,
    });
    expect(o.period.custom).toBe(true);
    expect(o.period.start).toBe(isoDaysAgo(10));
    expect(o.period.end).toBe(isoDaysAgo(4));
    expect(o.period.days).toBe(7); // inclusive span
  });

  it("⚠️ clamps an end the estate has not closed yet, and says so", async () => {
    // Tomorrow cannot possibly be closed.
    const o = await getOverview({
      days: 7,
      range: { start: isoDaysAgo(5), end: isoDaysAgo(-1) },
      audDays: 0, revDays: 0, vbcDays: 0, tracDays: 0,
    });
    expect(o.period.clampedTo).not.toBeNull();
    expect(o.period.end).toBe(o.period.clampedTo);
    // And the end must not be in the future.
    expect(o.period.end <= isoDaysAgo(0)).toBe(true);
  });

  it("never reports a reach figure for a custom range — not even a 7-day one", async () => {
    // Exactly 7 days, which as a PRESET would resolve Meta's native `week` window.
    const preset = await getOverview({ days: 7, audDays: 0, revDays: 0, vbcDays: 0, tracDays: 0 });
    const ranged = await getOverview({
      days: 7,
      range: { start: shiftDay(preset.period.end, -6), end: preset.period.end },
      audDays: 0, revDays: 0, vbcDays: 0, tracDays: 0,
    });
    expect(ranged.period.days).toBe(7);
    // A custom range describes a span the user chose, not Meta's own trailing window.
    expect(ranged.kpis.reach.window).toBeNull();
    expect(ranged.kpis.reach.value).toBeNull();
  });

  it("a card following the global follows the RANGE, while a detached card keeps its own", async () => {
    const o = await getOverview({
      days: 7,
      range: { start: isoDaysAgo(20), end: isoDaysAgo(6) },
      audDays: 0,   // follow → 15 days
      revDays: 0,
      vbcDays: 7,   // detached → 7 days
      tracDays: 0,
    });
    expect(o.period.days).toBe(15);
    expect(o.audience.days).toBe(15);
    expect(o.revenue.days).toBe(15);
    expect(o.traction.days).toBe(15);
    expect(o.viewsByChannelDays).toBe(7);
  });

  it("the memo distinguishes two different ranges — one range's numbers can never be served under another's label", async () => {
    const a = await getOverview({
      days: 7, range: { start: isoDaysAgo(14), end: isoDaysAgo(8) },
      audDays: 0, revDays: 0, vbcDays: 0, tracDays: 0,
    });
    const b = await getOverview({
      days: 7, range: { start: isoDaysAgo(7), end: isoDaysAgo(1) },
      audDays: 0, revDays: 0, vbcDays: 0, tracDays: 0,
    });
    expect(a.period.start).not.toBe(b.period.start);
    expect(a.period.end).not.toBe(b.period.end);
  });
});
