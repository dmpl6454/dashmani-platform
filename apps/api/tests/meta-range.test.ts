/**
 * Range mode, channel removal, daily-history plumbing and "keep me signed in".
 *
 * The invariants these lock:
 *  - a custom range is an exact SUM of daily flows, with reach NULL by design
 *    (unique people cannot be added across days — the 56% overstatement class);
 *  - coverage is disclosed (coveredDays/rangeDays), never papered over;
 *  - FB daily rows are keyed by the day a value DESCRIBES (end_time minus one),
 *    IG rows by the since date, and Instagram's -1 sentinels become null;
 *  - removed channels (selected:false) vanish from the default view AND its
 *    totals AND the dashboard growth qualification, but are restorable;
 *  - rememberMe stretches the refresh token 7d -> 30d and ROTATION PRESERVES IT
 *    (a 30d session must not silently shrink to 7d on first refresh).
 */
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import app from "../src/app";
import { prisma } from "@dashmani/db";
import { createTestRole, createTestUser, generateToken } from "./helpers";
import {
  fbDailyRowsFromSeries,
  igDailyRowFromTotals,
  resolveDuplicateAssetIds,
} from "../src/services/meta-oauth/meta-channels.service";
import { invalidateRangeCache, previousRange, rangeDayCount } from "../src/services/meta-oauth/meta-range.service";
import "./setup";

const dayIso = (offsetDays: number) => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};

describe("daily row builders (pure)", () => {
  it("keys Facebook rows by the day the value DESCRIBES — end_time minus one", () => {
    const rows = fbDailyRowsFromSeries({
      data: [
        { name: "page_media_view", period: "day", values: [
          { value: 100, end_time: "2026-06-03T07:00:00+0000" },
          { value: 200, end_time: "2026-06-04T07:00:00+0000" },
        ] },
        { name: "page_post_engagements", period: "day", values: [
          { value: 7, end_time: "2026-06-03T07:00:00+0000" },
        ] },
      ],
    }, {
      data: [
        { name: "monetization_approximate_earnings", period: "day", values: [
          // ⚠️ cents BEFORE rounding — 12.34 must become 1234, not 12.
          { value: 12.34, end_time: "2026-06-03T07:00:00+0000" },
        ] },
      ],
    });
    expect(rows).toHaveLength(2);
    const june2 = rows.find((r) => r.date === "2026-06-02");
    const june3 = rows.find((r) => r.date === "2026-06-03");
    expect(june2).toMatchObject({ views: 100, engagements: 7, earningsCents: 1234 });
    expect(june3).toMatchObject({ views: 200, engagements: null, earningsCents: null });
  });

  it("maps Instagram's -1 sentinels to null and keys by the since date", () => {
    const since = Math.floor(Date.parse("2026-05-10T00:00:00Z") / 1000);
    const row = igDailyRowFromTotals({
      data: [
        { name: "views", total_value: { value: 500 } },
        { name: "reach", total_value: { value: 300 } },
        // Live-probed: IG returns -1 for metrics it withholds on old spans.
        { name: "total_interactions", total_value: { value: -1 } },
        { name: "likes", total_value: { value: -1 } },
      ],
    } as never, since);
    expect(row).toMatchObject({ date: "2026-05-10", views: 500, reach: 300, engagements: null, reactions: null });
  });

  it("returns null for an all-sentinel Instagram day rather than an empty row", () => {
    const since = Math.floor(Date.parse("2026-05-10T00:00:00Z") / 1000);
    const row = igDailyRowFromTotals({
      data: [{ name: "views", total_value: { value: -1 } }],
    } as never, since);
    expect(row).toBeNull();
  });

  it("previousRange abuts the range exactly with equal length", () => {
    expect(rangeDayCount("2026-07-01", "2026-07-31")).toBe(31);
    expect(previousRange("2026-07-01", "2026-07-31")).toEqual({ start: "2026-05-31", end: "2026-06-30" });
  });
});

describe("GET /admin/meta/channels — range mode + removal", () => {
  let adminToken: string;
  let assetA: string;
  let assetB: string;
  let hiddenAssetId: string;

  beforeEach(async () => {
    invalidateRangeCache(); // module TTL cache — the documented cross-test class
    await createTestRole("Admin", [
      { resource: "reports", action: "manage", scope: "global" },
      { resource: "reports", action: "view", scope: "global" },
    ]);
    const admin = await createTestUser({ roleNames: ["Admin"] });
    adminToken = generateToken(admin.id, admin.email, ["Admin"]);

    const conn = await prisma.metaConnection.create({
      data: { metaUserId: "mu-range", connectedById: admin.id, status: "ACTIVE" },
    });
    const platform = await prisma.platform.create({ data: { name: "Facebook", slug: "facebook" } });
    const acct = await prisma.socialAccount.create({
      data: { handle: "rangy", displayName: "Rangy", platformId: platform.id, status: "ACTIVE" },
    });

    const a = await prisma.metaAsset.create({
      data: { connectionId: conn.id, kind: "FACEBOOK_PAGE", metaId: "pg-a", name: "Page A",
              selected: true, followerCount: 1200, socialAccountId: acct.id },
    });
    const b = await prisma.metaAsset.create({
      data: { connectionId: conn.id, kind: "INSTAGRAM_ACCOUNT", metaId: "ig-b", name: "Insta B",
              selected: true, followerCount: 300 },
    });
    const hidden = await prisma.metaAsset.create({
      data: { connectionId: conn.id, kind: "FACEBOOK_PAGE", metaId: "pg-hidden", name: "Hidden Page",
              selected: false, followerCount: 999 },
    });
    assetA = a.id; assetB = b.id; hiddenAssetId = hidden.id;

    const D = (iso: string) => new Date(`${iso}T00:00:00Z`);
    await prisma.metaAssetDaily.createMany({
      data: [
        // Range under test: [-4d .. -2d] (3 days). A covers all 3, B covers 1.
        { assetId: a.id, date: D(dayIso(-4)), views: 10n, engagements: 1, reach: 111n, earningsCents: 100 },
        { assetId: a.id, date: D(dayIso(-3)), views: 20n, engagements: 2, reach: 222n, earningsCents: 100 },
        { assetId: a.id, date: D(dayIso(-2)), views: 30n, engagements: 3, reach: 333n, earningsCents: 100 },
        { assetId: b.id, date: D(dayIso(-3)), views: 5n, engagements: 1 },
        // The hidden asset has data too — it must NOT surface anywhere.
        { assetId: hidden.id, date: D(dayIso(-3)), views: 9999n },
        // Previous equal-length span [-7d .. -5d], asset A fully covered.
        { assetId: a.id, date: D(dayIso(-7)), views: 10n, engagements: 1, earningsCents: 50 },
        { assetId: a.id, date: D(dayIso(-6)), views: 10n, engagements: 1, earningsCents: 50 },
        { assetId: a.id, date: D(dayIso(-5)), views: 10n, engagements: 1, earningsCents: 50 },
      ],
    });
    // Follower snapshots spanning the range (api-sourced).
    await prisma.accountGrowthSnapshot.createMany({
      data: [
        { accountId: acct.id, date: D(dayIso(-4)), followerCount: 1000, source: "api" },
        { accountId: acct.id, date: D(dayIso(-2)), followerCount: 1150, source: "api" },
      ],
    });
  });

  async function get(path: string) {
    return request(app).get(path).set("Authorization", `Bearer ${adminToken}`);
  }

  it("sums daily flows exactly, discloses coverage, and returns reach as NULL", async () => {
    const res = await get(`/v1/admin/meta/channels?start=${dayIso(-4)}&end=${dayIso(-2)}`);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.window).toBe("custom");
    expect(d.range).toEqual({ start: dayIso(-4), end: dayIso(-2), days: 3 });

    const a = d.items.find((i: { id: string }) => i.id === assetA);
    expect(a.views28d).toBe(60);
    expect(a.engagements28d).toBe(6);
    expect(a.earningsCents).toBe(300);
    // ⚠️ The load-bearing null: 111+222+333 would be a 56%-class lie.
    expect(a.reach28d).toBeNull();
    expect(a.coveredDays).toBe(3);
    expect(a.rangeDays).toBe(3);
    // Snapshot-measured follower change across the range, with its true span.
    expect(a.followerDelta).toBe(150);
    expect(a.followerDeltaDays).toBe(2);

    const b = d.items.find((i: { id: string }) => i.id === assetB);
    expect(b.views28d).toBe(5);
    expect(b.coveredDays).toBe(1);

    expect(d.totals.views).toBe(65);
    expect(d.totals.reach).toBe(0); // nothing contributes; the UI renders the tile from items
    expect(d.previousTotals).toMatchObject({ views: 30, earningsCents: 150, coverageShare: 1, assets: 1 });
  });

  it("rejects a bad range with a clean 400, never a 500", async () => {
    for (const qs of [
      `start=${dayIso(-2)}&end=${dayIso(-4)}`,        // start after end
      `start=0002-01-01&end=${dayIso(-2)}`,           // span > 731
      `start=${dayIso(-2)}&end=${dayIso(+3)}`,        // end in the future
      `start=garbage&end=${dayIso(-2)}`,
    ]) {
      const res = await get(`/v1/admin/meta/channels?${qs}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("BAD_RANGE");
    }
  });

  it("hides removed channels from the default view and its totals", async () => {
    const res = await get("/v1/admin/meta/channels?window=week");
    expect(res.status).toBe(200);
    const ids = res.body.data.items.map((i: { id: string }) => i.id);
    expect(ids).not.toContain(hiddenAssetId);
    // followers total excludes the hidden asset's 999
    expect(res.body.data.totals.followers).toBe(1500);
  });

  it("lists removed channels under ?hidden=1 and restores them via the bulk endpoint", async () => {
    const hiddenList = await get("/v1/admin/meta/channels?hidden=1");
    expect(hiddenList.status).toBe(200);
    expect(hiddenList.body.data.items.map((i: { id: string }) => i.id)).toEqual([hiddenAssetId]);

    const restore = await request(app)
      .patch("/v1/admin/meta/assets/bulk")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ ids: [hiddenAssetId], selected: true });
    expect(restore.status).toBe(200);
    expect(restore.body.data.updated).toBe(1);

    const after = await get("/v1/admin/meta/channels?window=week");
    expect(after.body.data.items.map((i: { id: string }) => i.id)).toContain(hiddenAssetId);
  });

  it("bulk endpoint rejects a bad body with 400", async () => {
    for (const body of [{}, { ids: [], selected: true }, { ids: [hiddenAssetId] }, { ids: "x", selected: false }]) {
      const res = await request(app)
        .patch("/v1/admin/meta/assets/bulk")
        .set("Authorization", `Bearer ${adminToken}`)
        .send(body);
      expect(res.status).toBe(400);
    }
  });

  it("a range over a contested channel row yields NO follower delta for either Page", async () => {
    // Second asset claiming the same social account -> contested -> no deltas.
    const conn = await prisma.metaConnection.findFirstOrThrow({ where: { metaUserId: "mu-range" } });
    const acct = await prisma.socialAccount.findFirstOrThrow({ where: { handle: "rangy" } });
    await prisma.metaAsset.create({
      data: { connectionId: conn.id, kind: "FACEBOOK_PAGE", metaId: "pg-a2", name: "Page A",
              selected: true, followerCount: 50, socialAccountId: acct.id },
    });
    invalidateRangeCache();
    const res = await get(`/v1/admin/meta/channels?start=${dayIso(-4)}&end=${dayIso(-2)}`);
    const a = res.body.data.items.find((i: { id: string }) => i.id === assetA);
    expect(a.followerDelta).toBeNull();
  });

  it("dashboard growth qualification excludes removed channels", async () => {
    // Link the HIDDEN asset to its own channel row: it must not qualify.
    const platform = await prisma.platform.findFirstOrThrow({ where: { slug: "facebook" } });
    const acct2 = await prisma.socialAccount.create({
      data: { handle: "hiddy", displayName: "Hiddy", platformId: platform.id, status: "ACTIVE", followerCount: 999 },
    });
    await prisma.metaAsset.update({ where: { id: hiddenAssetId }, data: { socialAccountId: acct2.id } });

    const res = await get("/v1/admin/growth");
    expect(res.status).toBe(200);
    const ids = (res.body.data.accounts as Array<{ accountId: string }>).map((x) => x.accountId);
    expect(ids).not.toContain(acct2.id);
  });
});

describe("POST /auth/login — keep me signed in", () => {
  beforeEach(async () => {
    await createTestRole("Admin", [{ resource: "reports", action: "manage", scope: "global" }]);
  });

  const DAY = 86_400_000;

  async function loginAndGetExpiry(rememberMe: boolean | undefined, email: string) {
    await createTestUser({ email, password: "TestPass123!", roleNames: ["Admin"] });
    const res = await request(app).post("/v1/auth/login")
      .send({ email, password: "TestPass123!", ...(rememberMe === undefined ? {} : { rememberMe }) });
    expect(res.status).toBe(200);
    const stored = await prisma.refreshToken.findFirstOrThrow({
      where: { user: { email } }, orderBy: { createdAt: "desc" },
    });
    return { days: (stored.expiresAt.getTime() - Date.now()) / DAY, refreshToken: res.body.data.refreshToken as string };
  }

  it("defaults to a 7-day refresh token", async () => {
    const { days } = await loginAndGetExpiry(undefined, "plain@zz.test");
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
  });

  it("rememberMe stretches it to 30 days — and ROTATION PRESERVES IT", async () => {
    const { days, refreshToken } = await loginAndGetExpiry(true, "rem@zz.test");
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);

    // First refresh: the successor token must ALSO be ~30d, not shrink to 7d.
    const ref = await request(app).post("/v1/auth/refresh").send({ refreshToken });
    expect(ref.status).toBe(200);
    const stored = await prisma.refreshToken.findFirstOrThrow({
      where: { user: { email: "rem@zz.test" } }, orderBy: { createdAt: "desc" },
    });
    const rotatedDays = (stored.expiresAt.getTime() - Date.now()) / DAY;
    expect(rotatedDays).toBeGreaterThan(29.9);
    expect(rotatedDays).toBeLessThan(30.1);
  });
});

describe("duplicate resolution vs removal", () => {
  it("a MONITORED copy always beats a REMOVED one, regardless of follower count", async () => {
    // Without the selected-first rule, the hidden 9m copy wins, the sync skips
    // it (it only polls selected assets), dedupe suppresses the visible copy,
    // and the channel silently vanishes and goes stale.
    const admin = await prisma.user.create({
      data: { name: "d", email: "dupe-admin@zz.test", passwordHash: "x", status: "ACTIVE" },
    });
    const connA = await prisma.metaConnection.create({
      data: { metaUserId: "mu-dupe-a", connectedById: admin.id, status: "ACTIVE" },
    });
    const connB = await prisma.metaConnection.create({
      data: { metaUserId: "mu-dupe-b", connectedById: admin.id, status: "ACTIVE" },
    });
    const hiddenBig = await prisma.metaAsset.create({
      data: { connectionId: connA.id, kind: "FACEBOOK_PAGE", metaId: "pg-shared", name: "Shared",
              selected: false, followerCount: 9_000_000 },
    });
    const visibleSmall = await prisma.metaAsset.create({
      data: { connectionId: connB.id, kind: "FACEBOOK_PAGE", metaId: "pg-shared", name: "Shared",
              selected: true, followerCount: 100 },
    });
    const suppressed = await resolveDuplicateAssetIds();
    expect(suppressed.has(hiddenBig.id)).toBe(true);
    expect(suppressed.has(visibleSmall.id)).toBe(false);
  });
});
