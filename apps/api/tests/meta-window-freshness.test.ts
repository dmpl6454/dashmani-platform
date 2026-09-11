/**
 * Live-window freshness, honest totals and the trend baseline (2026-09-10).
 *
 * The invariants these lock:
 *  - Facebook windows are requested with an EXPLICIT since/until. Meta's default
 *    span stops one closed day early (live-probed), which made "Yesterday" the
 *    day before yesterday and delayed the newest daily row by ~24h;
 *  - the OPEN bucket (end_time in the future) is never read as a closed window,
 *    never persisted as daily history, and IS the Facebook "Today (so far)" row;
 *  - a window total is NULL, not 0, when no channel reported the metric — the
 *    "$0.00 today" fabricated-zero class;
 *  - the trend baseline is anchored on the day each row's figures actually
 *    cover (from periodEnd), not on "UTC yesterday" — the old anchoring put the
 *    1-day baseline ON the covered day itself, a permanent 0.0%;
 *  - dataThroughDay is the covered day, not the date of the boundary instant.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import app from "../src/app";
import { prisma } from "@dashmani/db";
import { createTestRole, createTestUser, generateToken } from "./helpers";
import { encryptToken } from "../src/utils/token-crypto";
import {
  runMetaChannelSync,
  splitFbSeries,
  fbDailyRowsFromSeries,
} from "../src/services/meta-oauth/meta-channels.service";
import { coveredDayOf, shiftDay, invalidateRangeCache } from "../src/services/meta-oauth/meta-range.service";
import { oauthGraphFetch } from "../src/services/meta-oauth/oauth-graph";
import "./setup";

vi.mock("../src/services/meta-oauth/oauth-graph", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/services/meta-oauth/oauth-graph")>();
  return { ...orig, oauthGraphFetch: vi.fn() };
});
const mockedFetch = vi.mocked(oauthGraphFetch);

const DAY = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** The most recent Pacific-midnight-shaped boundary (07:00Z) at or before now. */
function lastFbBoundaryMs(): number {
  const now = Date.now();
  return Math.floor((now - 7 * 3_600_000) / DAY) * DAY + 7 * 3_600_000;
}
/** Graph's stamp format, e.g. 2026-09-10T07:00:00+0000. */
const stamp = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "+0000");

function okSeries(metric: string, points: Array<[number, number]>) {
  return {
    ok: true as const, rateLimited: false, authInvalid: false, status: 200, usage: null,
    data: { data: [{ name: metric, period: "day", values: points.map(([ms, value]) => ({ value, end_time: stamp(ms) })) }] },
  };
}

describe("splitFbSeries / fbDailyRowsFromSeries (pure)", () => {
  const now = Date.parse("2026-09-10T09:47:00Z");
  const res = {
    data: [{
      name: "page_media_view", period: "day",
      values: [
        { value: 1913, end_time: "2026-09-09T07:00:00+0000" },
        { value: 4099, end_time: "2026-09-10T07:00:00+0000" },
        { value: 313, end_time: "2026-09-11T07:00:00+0000" }, // open: the future-stamped bucket
        { value: 7 },                                          // no end_time → treated as closed
      ],
    }],
  };

  it("separates closed points from the one still open, keeping unparseable stamps as closed", () => {
    const { closed, open } = splitFbSeries(res, now);
    expect(closed?.data?.[0].values?.map((v) => v.value)).toEqual([1913, 4099, 7]);
    expect(open?.data?.[0].values?.map((v) => v.value)).toEqual([313]);
    expect(splitFbSeries(undefined, now)).toEqual({ closed: undefined, open: undefined });
    // No future point → no open series at all (the caller clears any stale today row).
    const allClosed = { data: [{ name: "x", values: [{ value: 1, end_time: "2026-09-10T07:00:00+0000" }] }] };
    expect(splitFbSeries(allClosed, now).open).toBeUndefined();
  });

  it("the daily writer skips the open bucket even when handed the unsplit response", () => {
    const rows = fbDailyRowsFromSeries(res, undefined, now);
    expect(rows.map((r) => r.date)).toEqual(["2026-09-08", "2026-09-09"]); // end_time minus one, no Sep 10
    expect(rows.find((r) => r.date === "2026-09-09")?.views).toBe(4099);
  });

  it("coveredDayOf reads the day a periodEnd closes, for Pacific and UTC boundaries alike", () => {
    expect(coveredDayOf(new Date("2026-09-10T07:00:00Z"))).toBe("2026-09-09"); // Facebook, PDT midnight
    expect(coveredDayOf(new Date("2026-09-10T08:00:00Z"))).toBe("2026-09-09"); // Facebook, PST midnight
    expect(coveredDayOf(new Date("2026-09-10T00:00:00Z"))).toBe("2026-09-09"); // Instagram, UTC midnight
    expect(shiftDay("2026-09-09", -6)).toBe("2026-09-03");
  });
});

describe("channel sync — Facebook asks with since/until and splits the open bucket", () => {
  let assetId: string;

  beforeEach(async () => {
    await createTestRole("Admin", [{ resource: "reports", action: "manage", scope: "global" }]);
    mockedFetch.mockReset();
    const admin = await createTestUser({ roleNames: ["Admin"], email: "meta-fresh-admin@zz.test" });
    const conn = await prisma.metaConnection.create({
      data: { metaUserId: "mu-fresh", connectedById: admin.id, status: "ACTIVE", userTokenEnc: encryptToken("user-token") },
    });
    const asset = await prisma.metaAsset.create({
      data: { connectionId: conn.id, kind: "FACEBOOK_PAGE", metaId: "page-fresh-1", name: "Fresh Page",
              selected: true, pageTokenEnc: encryptToken("page-token") },
    });
    assetId = asset.id;
  });

  it("window = newest CLOSED point, today = the open bucket, daily rows = closed days only, same call count", async () => {
    const B = lastFbBoundaryMs(); // close of the newest completed Pacific day
    const before = Date.now();
    mockedFetch.mockImplementation(async (_path, params) => {
      const p = params as Record<string, unknown>;
      // Every Facebook request must carry an explicit span ending now.
      expect(typeof p.since).toBe("number");
      expect(typeof p.until).toBe("number");
      expect((p.until as number) * 1000).toBeGreaterThanOrEqual(before - 5_000);
      const isEarn = String(p.metric).includes("monetization");
      return isEarn
        ? okSeries("monetization_approximate_earnings", [[B - DAY, 1.0], [B, 2.0], [B + DAY, 0.25]])
        : okSeries("page_media_view", [[B - DAY, 100], [B, 200], [B + DAY, 30]]);
    });

    const out = await runMetaChannelSync();
    expect(out.errors).toHaveLength(0);
    // 3 windows x (insights + earnings) — the open bucket rides along for free.
    expect(mockedFetch).toHaveBeenCalledTimes(6);

    const rows = await prisma.metaAssetMetric.findMany({ where: { assetId } });
    const byWin = new Map(rows.map((r) => [r.window, r]));
    for (const w of ["day", "week", "days_28"]) {
      const r = byWin.get(w)!;
      expect(Number(r.views)).toBe(200);           // the newest CLOSED point, never the open 30
      expect(r.earningsCents).toBe(200);
      expect(r.periodEnd?.getTime()).toBe(B);      // stamped with the close of that day
      expect(r.error).toBeNull();
    }
    const today = byWin.get("today")!;
    expect(Number(today.views)).toBe(30);
    expect(today.earningsCents).toBe(25);
    expect(today.periodEnd!.getTime()).toBeGreaterThanOrEqual(before - 5_000);

    // The 28d mirror also reads the closed point.
    const asset = await prisma.metaAsset.findUniqueOrThrow({ where: { id: assetId } });
    expect(Number(asset.views28d)).toBe(200);

    const daily = await prisma.metaAssetDaily.findMany({ where: { assetId }, orderBy: { date: "asc" } });
    expect(daily.map((d) => d.date.toISOString().slice(0, 10))).toEqual([isoDay(B - 2 * DAY), isoDay(B - DAY)]);
    expect(daily.map((d) => d.earningsCents)).toEqual([100, 200]);
  });

  it("a FAILED day fetch flags the Facebook today row instead of letting last run's total linger unwarned", async () => {
    const B = lastFbBoundaryMs();
    await prisma.metaAssetMetric.create({
      data: { assetId, window: "today", views: 4099n, earningsCents: 26_202, fetchedAt: new Date(B - 3 * 3_600_000) },
    });
    const PERM = "The user must be an administrator, editor, or moderator of the page.";
    mockedFetch.mockImplementation(async (_path, params) => {
      const p = params as Record<string, unknown>;
      if (p.period === "day" && !String(p.metric).includes("monetization")) {
        return { ok: false as const, rateLimited: false, authInvalid: false, status: 400, usage: null, error: PERM, errorCode: 200 };
      }
      return String(p.metric).includes("monetization")
        ? okSeries("monetization_approximate_earnings", [[B - DAY, 1.0], [B, 2.0], [B + DAY, 0.25]])
        : okSeries("page_media_view", [[B - DAY, 100], [B, 200], [B + DAY, 30]]);
    });
    await runMetaChannelSync();
    const today = await prisma.metaAssetMetric.findFirstOrThrow({ where: { assetId, window: "today" } });
    expect(today.error).toContain("administrator");     // the warning triangle shows
    expect(Number(today.views)).toBe(4099);              // prior values survive, flagged
    const day = await prisma.metaAssetMetric.findFirstOrThrow({ where: { assetId, window: "day" } });
    expect(day.error).toContain("administrator");
  });

  it("no open bucket → a stale Facebook today row is removed, not left to read as today", async () => {
    const B = lastFbBoundaryMs();
    await prisma.metaAssetMetric.create({
      data: { assetId, window: "today", views: 999n, earningsCents: 999, fetchedAt: new Date(B - 3 * 3_600_000) },
    });
    mockedFetch.mockImplementation(async (_path, params) => {
      const isEarn = String((params as Record<string, unknown>).metric).includes("monetization");
      return isEarn
        ? okSeries("monetization_approximate_earnings", [[B - DAY, 1.0], [B, 2.0]])
        : okSeries("page_media_view", [[B - DAY, 100], [B, 200]]);
    });
    await runMetaChannelSync();
    const today = await prisma.metaAssetMetric.findFirst({ where: { assetId, window: "today" } });
    expect(today).toBeNull();
  });
});

describe("GET /admin/meta/channels — honest totals, covered-day baseline, dataThroughDay", () => {
  let adminToken: string;
  let fbId: string;
  let igId: string;
  const dayIso = (offset: number) => isoDay(Date.now() + offset * DAY);
  const D = (iso: string) => new Date(`${iso}T00:00:00Z`);

  beforeEach(async () => {
    invalidateRangeCache();
    await createTestRole("Admin", [
      { resource: "reports", action: "manage", scope: "global" },
      { resource: "reports", action: "view", scope: "global" },
    ]);
    const admin = await createTestUser({ roleNames: ["Admin"] });
    adminToken = generateToken(admin.id, admin.email, ["Admin"]);
    const conn = await prisma.metaConnection.create({
      data: { metaUserId: "mu-fresh-route", connectedById: admin.id, status: "ACTIVE" },
    });
    const fb = await prisma.metaAsset.create({
      data: { connectionId: conn.id, kind: "FACEBOOK_PAGE", metaId: "pg-fresh", name: "FB", selected: true, followerCount: 10 },
    });
    const ig = await prisma.metaAsset.create({
      data: { connectionId: conn.id, kind: "INSTAGRAM_ACCOUNT", metaId: "ig-fresh", name: "IG", selected: true, followerCount: 5 },
    });
    fbId = fb.id; igId = ig.id;
  });

  const get = (path: string) => request(app).get(path).set("Authorization", `Bearer ${adminToken}`);

  it("anchors the 1-day baseline on the day each row COVERS — Facebook on Pacific, Instagram on UTC", async () => {
    // Prod state on 2026-09-10: FB's day row closed at YESTERDAY 07:00Z (covers
    // the day before yesterday); IG's at TODAY 00:00Z (covers yesterday).
    const fbPeriodEnd = new Date(`${dayIso(-1)}T07:00:00Z`);
    const igPeriodEnd = new Date(`${dayIso(0)}T00:00:00Z`);
    await prisma.metaAssetMetric.createMany({
      data: [
        { assetId: fbId, window: "day", views: 9n, earningsCents: 125_425, fetchedAt: new Date(), periodEnd: fbPeriodEnd },
        { assetId: igId, window: "day", views: 50n, fetchedAt: new Date(), periodEnd: igPeriodEnd },
      ],
    });
    await prisma.metaAssetDaily.createMany({
      data: [
        // FB covers -2d; its baseline must be -3d (the OLD code read -2d — the row's own day).
        { assetId: fbId, date: D(dayIso(-2)), views: 9n, earningsCents: 125_425 },
        { assetId: fbId, date: D(dayIso(-3)), views: 7n, earningsCents: 111_563 },
        // IG covers -1d; its baseline is -2d.
        { assetId: igId, date: D(dayIso(-1)), views: 50n },
        { assetId: igId, date: D(dayIso(-2)), views: 40n },
      ],
    });

    const res = await get("/v1/admin/meta/channels?window=day");
    expect(res.status).toBe(200);
    const prev = res.body.data.previousTotals;
    expect(prev.earningsCents).toBe(111_563);   // not 125,425 — the day before, not the same day
    expect(prev.views).toBe(7 + 40);            // each platform against ITS OWN prior day
    expect(prev.assets).toBe(2);
    expect(prev.coverageShare).toBe(1);
    expect(prev.start).toBe(dayIso(-3));
    expect(prev.end).toBe(dayIso(-2));
    // Current totals are what the rows say; the chip would now read a real +12.4%.
    expect(res.body.data.totals.earningsCents).toBe(125_425);
    // Figures are complete through the EARLIEST covered day, as a calendar day.
    expect(res.body.data.dataThroughDay).toBe(dayIso(-2));
    expect(res.body.data.dataThrough).toBe(fbPeriodEnd.toISOString());
  });

  it("anchors the 7-day baseline on the covered span with ZERO overlap (the old anchoring overlapped by a day)", async () => {
    // FB week row closed at yesterday 07:00Z → covers [-8d .. -2d]; baseline is [-15d .. -9d].
    await prisma.metaAssetMetric.create({
      data: { assetId: fbId, window: "week", views: 700n, earningsCents: 7_000, fetchedAt: new Date(), periodEnd: new Date(`${dayIso(-1)}T07:00:00Z`) },
    });
    await prisma.metaAssetDaily.createMany({
      data: [
        // Inside the CURRENT covered span — must NOT enter the baseline (old code counted -8d).
        { assetId: fbId, date: D(dayIso(-8)), views: 1_000_000n, earningsCents: 1_000_000 },
        // The baseline week, fully covered.
        ...[-15, -14, -13, -12, -11, -10, -9].map((o) => ({ assetId: fbId, date: D(dayIso(o)), views: 10n, earningsCents: 100 })),
      ],
    });
    const res = await get("/v1/admin/meta/channels?window=week");
    expect(res.status).toBe(200);
    expect(res.body.data.previousTotals).toMatchObject({
      views: 70, earningsCents: 700, assets: 1, coverageShare: 1, start: dayIso(-15), end: dayIso(-9),
    });
    expect(res.body.data.dataThroughDay).toBe(dayIso(-2));
  });

  it("today: revenue is NULL (a dash) when no Facebook figure exists, never $0.00; day starts are stated", async () => {
    await prisma.metaAssetMetric.create({
      data: { assetId: igId, window: "today", views: 42n, fetchedAt: new Date(), periodEnd: new Date() },
    });
    const res = await get("/v1/admin/meta/channels?window=today");
    expect(res.status).toBe(200);
    expect(res.body.data.totals.views).toBe(42);
    expect(res.body.data.totals.earningsCents).toBeNull();
    expect(res.body.data.totals.reach).toBeNull();
    expect(res.body.data.contributing.earnings).toBe(0);
    expect(res.body.data.dataThroughDay).toBeNull();
    const ds = res.body.data.dayStarts;
    expect(Date.parse(ds.facebook)).toBeLessThanOrEqual(Date.now());
    expect(Date.now() - Date.parse(ds.facebook)).toBeLessThan(DAY);
    expect(new Date(ds.instagram).toISOString().endsWith("T00:00:00.000Z")).toBe(true);
    const fb = new Date(ds.facebook);
    expect([7, 8]).toContain(fb.getUTCHours());          // Pacific midnight: 07:00Z in PDT, 08:00Z in PST
    expect(fb.getUTCMinutes() + fb.getUTCSeconds() + fb.getUTCMilliseconds()).toBe(0);
    expect(res.body.data.previousTotals).toBeNull();
  });

  it("today: once Facebook has an open-bucket row its revenue counts, a reported zero stays 0", async () => {
    await prisma.metaAssetMetric.createMany({
      data: [
        { assetId: fbId, window: "today", views: 313n, earningsCents: 2_665, fetchedAt: new Date(), periodEnd: new Date() },
        { assetId: igId, window: "today", views: 42n, fetchedAt: new Date(), periodEnd: new Date() },
      ],
    });
    const res = await get("/v1/admin/meta/channels?window=today");
    expect(res.body.data.totals.earningsCents).toBe(2_665);
    expect(res.body.data.totals.views).toBe(355);
    // A Page that answered with $0 is a reported zero, not "no figure".
    await prisma.metaAssetMetric.update({ where: { assetId_window: { assetId: fbId, window: "today" } }, data: { earningsCents: 0 } });
    const res2 = await get("/v1/admin/meta/channels?window=today");
    expect(res2.body.data.totals.earningsCents).toBe(0);
  });
});
