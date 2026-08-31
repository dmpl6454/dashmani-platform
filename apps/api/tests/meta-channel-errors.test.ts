/**
 * Channel-metrics error handling — the "warning triangle" pipeline.
 *
 * Two defects these tests lock out (both found live on prod 2026-08-31, when
 * ~26 channels per sync run carried warning triangles over perfectly good data):
 *
 * 1. NO RETRY ON META'S TRANSIENT (#2). ~1% of the ~2,700 Graph calls per run
 *    fail with "An unexpected error has occurred. Please retry your request
 *    later." (errorCode 2). Without a retry, each of those stamps a visible
 *    error on a window whose figures are fine, for up to 3 hours until the next
 *    sync. The error set CHURNS between runs (errors=2 then errors=8 in
 *    consecutive prod runs) — proof they are transient, not deterministic.
 *    ⚠️ The retry must be BOUNDED (exactly one) and GATED on transient error
 *    codes — the repo has a documented incident where an unconditional retry
 *    fired on every call and wasted 216 requests/run against a deterministic
 *    failure.
 *
 * 2. THE ASSET-LEVEL ERROR LEAKED ONTO HEALTHY WINDOWS. The route computed
 *    `win(r)?.error ?? r.metricsError` — but a HEALTHY window row has
 *    `error: null`, and `??` falls through null, so a stale asset-level
 *    "channel insights failed" (set when the days_28 fetch failed) painted a
 *    triangle on the 7d and 24h views whose own rows were fine. The fallback
 *    must apply only when there is NO row for the window at all.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import app from "../src/app";
import { prisma } from "@dashmani/db";
import { createTestRole, createTestUser, generateToken } from "./helpers";
import { encryptToken } from "../src/utils/token-crypto";
import { runMetaChannelSync } from "../src/services/meta-oauth/meta-channels.service";
import { oauthGraphFetch } from "../src/services/meta-oauth/oauth-graph";
import { isTransientGraphFailure } from "../src/services/meta-oauth/oauth-graph";
import "./setup";

// Replace ONLY oauthGraphFetch; makeBudget and the rest stay real so the sync's
// budget accounting is the production code path, not a test double.
vi.mock("../src/services/meta-oauth/oauth-graph", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/services/meta-oauth/oauth-graph")>();
  return { ...orig, oauthGraphFetch: vi.fn() };
});

const mockedFetch = vi.mocked(oauthGraphFetch);

const TRANSIENT_MSG = "An unexpected error has occurred. Please retry your request later.";
const PERM_MSG = "The user must be an administrator, editor, or moderator of the page.";

function fail(errorCode: number, error: string) {
  return {
    ok: false as const, rateLimited: false, authInvalid: false,
    status: 500, usage: null, error, errorCode,
  };
}

function ok(metricName: string, value: number) {
  return {
    ok: true as const, rateLimited: false, authInvalid: false,
    status: 200, usage: null,
    data: {
      data: [
        { name: metricName, period: "day", values: [{ value, end_time: "2026-08-29T07:00:00+0000" }] },
      ],
    },
  };
}

/** Success payload for whichever call this is (earnings vs regular insights). */
function okFor(params: Record<string, unknown>) {
  const metric = String(params.metric ?? "");
  return metric.includes("monetization")
    ? ok("monetization_approximate_earnings", 12.34)
    : ok("page_media_view", 123);
}

async function seedConnectedFbAsset() {
  const admin = await createTestUser({ roleNames: ["Admin"], email: "meta-err-admin@zz.test" });
  const conn = await prisma.metaConnection.create({
    data: {
      metaUserId: "mu-err-test",
      connectedById: admin.id,
      status: "ACTIVE",
      userTokenEnc: encryptToken("user-token"),
    },
  });
  const asset = await prisma.metaAsset.create({
    data: {
      connectionId: conn.id,
      kind: "FACEBOOK_PAGE",
      metaId: "page-err-1",
      name: "Errory Page",
      selected: true,
      pageTokenEnc: encryptToken("page-token"),
    },
  });
  return asset;
}

describe("channel sync — transient Graph failures are retried once", () => {
  beforeEach(async () => {
    await createTestRole("Admin", [
      { resource: "reports", action: "manage", scope: "global" },
    ]);
    mockedFetch.mockReset();
  });

  it("retries a transient (#2) failure once and lands every window healthy", async () => {
    const asset = await seedConnectedFbAsset();

    // First attempt per (metric, period) fails transiently; the retry succeeds.
    const attempts = new Map<string, number>();
    mockedFetch.mockImplementation(async (_path, params) => {
      const p = params as Record<string, unknown>;
      const key = `${p.metric}|${p.period}`;
      const n = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, n);
      return n === 1 ? fail(2, TRANSIENT_MSG) : okFor(p);
    });

    const out = await runMetaChannelSync();

    const rows = await prisma.metaAssetMetric.findMany({ where: { assetId: asset.id } });
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.error).toBeNull();
      expect(Number(row.views)).toBe(123);
      expect(row.earningsCents).toBe(1234);
    }
    const after = await prisma.metaAsset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(after.metricsError).toBeNull();
    expect(out.errors).toHaveLength(0);
    // 3 windows x (insights fail + retry ok + earnings fail + retry ok) = 12.
    // More than 12 would mean a second retry; fewer would mean a window skipped.
    expect(mockedFetch).toHaveBeenCalledTimes(12);
  });

  it("does NOT retry a non-transient failure (permission errors are deterministic)", async () => {
    const asset = await seedConnectedFbAsset();
    mockedFetch.mockImplementation(async () => fail(200, PERM_MSG));

    await runMetaChannelSync();

    const rows = await prisma.metaAssetMetric.findMany({ where: { assetId: asset.id } });
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row.error).toContain("administrator");
    // Exactly one insights call per window — no retry, and earnings is never
    // reached because the window's main fetch failed.
    expect(mockedFetch).toHaveBeenCalledTimes(3);
  });

  it("bounds the retry to exactly one attempt when the failure persists", async () => {
    const asset = await seedConnectedFbAsset();
    mockedFetch.mockImplementation(async () => fail(2, TRANSIENT_MSG));

    await runMetaChannelSync();

    const rows = await prisma.metaAssetMetric.findMany({ where: { assetId: asset.id } });
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row.error).toContain("unexpected error");
    // 3 windows x (attempt + one retry) = 6. A third attempt per window would
    // make this 9+ — the bound is the point.
    expect(mockedFetch).toHaveBeenCalledTimes(6);
  });
});

describe("GET /admin/meta/channels — error reporting per window", () => {
  let adminToken: string;
  let assetId: string;

  beforeEach(async () => {
    mockedFetch.mockReset();
    await createTestRole("Admin", [
      { resource: "reports", action: "manage", scope: "global" },
    ]);
    const admin = await createTestUser({ roleNames: ["Admin"] });
    adminToken = generateToken(admin.id, admin.email, ["Admin"]);

    const asset = await seedConnectedFbAsset();
    assetId = asset.id;
    // Stale asset-level error from a failed default-window (days_28) fetch…
    await prisma.metaAsset.update({
      where: { id: asset.id },
      data: { metricsError: "channel insights failed" },
    });
    // …while the week window is perfectly healthy…
    await prisma.metaAssetMetric.create({
      data: { assetId: asset.id, window: "week", views: 5n, error: null, fetchedAt: new Date() },
    });
    // …and the days_28 window carries its own real error.
    await prisma.metaAssetMetric.create({
      data: { assetId: asset.id, window: "days_28", error: "boom", fetchedAt: new Date() },
    });
  });

  async function getChannel(window: string) {
    const res = await request(app)
      .get(`/v1/admin/meta/channels?window=${window}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    return res.body.data.items.find((i: { id: string }) => i.id === assetId);
  }

  it("a HEALTHY window row is not painted with the stale asset-level error", async () => {
    const item = await getChannel("week");
    expect(item.metricsError).toBeNull();
    expect(item.views28d).toBe(5);
  });

  it("a window with no row at all still falls back to the asset-level error", async () => {
    const item = await getChannel("day");
    expect(item.metricsError).toBe("channel insights failed");
  });

  it("a window whose own fetch failed reports that window's error", async () => {
    const item = await getChannel("days_28");
    expect(item.metricsError).toBe("boom");
  });
});

/**
 * A channel row claimed by TWO Pages must yield NO snapshot-measured delta.
 *
 * ⚠️ This is an EXCLUSION, which is the kind of behaviour nothing notices
 * regressing: re-allowing it does not break a page, it silently puts a fabricated
 * number back on it. Measured on prod 2026-08-31, "The Candid Couch" is one
 * social_accounts row claimed by a 5,233,880-follower Page and a 131,838-follower
 * Page. The snapshot series is keyed on the CHANNEL ROW and switched Pages
 * mid-history (5,235,935 through 2026-08-26, then 131,886 from 2026-08-27), so
 * the route subtracted one Page's history from the other Page's current count and
 * reported +5,102,038 of 24h growth that never happened.
 *
 * ⚠️ Note the shape: the snapshot rows themselves move by ~12/day. The fabrication
 * only appears when the per-ASSET follower count is differenced against the
 * per-CHANNEL-ROW baseline, which is why diffing the snapshot series alone shows
 * nothing wrong.
 */
describe("GET /admin/meta/channels — contested channel rows get no fabricated delta", () => {
  let adminToken: string;
  let bigId: string;
  let smallId: string;
  let soloId: string;

  beforeEach(async () => {
    mockedFetch.mockReset();
    await createTestRole("Admin", [{ resource: "reports", action: "manage", scope: "global" }]);
    const admin = await createTestUser({ roleNames: ["Admin"] });
    adminToken = generateToken(admin.id, admin.email, ["Admin"]);

    const conn = await prisma.metaConnection.create({
      data: { metaUserId: "mu-contested", connectedById: admin.id, status: "ACTIVE" },
    });
    const platform = await prisma.platform.create({ data: { name: "Facebook", slug: "facebook" } });

    // ONE channel row, TWO Pages — the real prod shape.
    const shared = await prisma.socialAccount.create({
      data: { handle: "candid", displayName: "The Candid Couch", platformId: platform.id, status: "ACTIVE" },
    });
    const big = await prisma.metaAsset.create({
      data: { connectionId: conn.id, kind: "FACEBOOK_PAGE", metaId: "pg-big", name: "The Candid Couch",
              selected: true, followerCount: 5_233_880, socialAccountId: shared.id },
    });
    const small = await prisma.metaAsset.create({
      data: { connectionId: conn.id, kind: "FACEBOOK_PAGE", metaId: "pg-small", name: "The Candid Couch",
              selected: true, followerCount: 131_838, socialAccountId: shared.id },
    });
    bigId = big.id; smallId = small.id;

    // An uncontested channel, to prove the suppression is targeted and the
    // ordinary delta still works.
    const soloAcct = await prisma.socialAccount.create({
      data: { handle: "solo", displayName: "Solo Page", platformId: platform.id, status: "ACTIVE" },
    });
    const solo = await prisma.metaAsset.create({
      data: { connectionId: conn.id, kind: "FACEBOOK_PAGE", metaId: "pg-solo", name: "Solo Page",
              selected: true, followerCount: 1_000_500, socialAccountId: soloAcct.id },
    });
    soloId = solo.id;

    // Yesterday's snapshots. The shared row carries the SMALL Page's value — the
    // exact seam that produced the phantom +5.1m.
    const yday = new Date();
    yday.setUTCHours(0, 0, 0, 0);
    yday.setUTCDate(yday.getUTCDate() - 1);
    await prisma.accountGrowthSnapshot.createMany({
      data: [
        { accountId: shared.id, date: yday, followerCount: 131_842, source: "api" },
        { accountId: soloAcct.id, date: yday, followerCount: 1_000_000, source: "api" },
      ],
    });
  });

  async function items(window: string) {
    const res = await request(app)
      .get(`/v1/admin/meta/channels?window=${window}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    return res.body.data.items as Array<{ id: string; followerDelta: number | null }>;
  }

  it("reports NO delta for either Page of a contested channel row", async () => {
    const rows = await items("day");
    const big = rows.find((r) => r.id === bigId);
    const small = rows.find((r) => r.id === smallId);
    // The bug produced 5_233_880 - 131_842 = 5_102_038 here.
    expect(big?.followerDelta ?? null).toBeNull();
    expect(small?.followerDelta ?? null).toBeNull();
  });

  it("still reports the real delta for an uncontested channel", async () => {
    const rows = await items("day");
    const solo = rows.find((r) => r.id === soloId);
    expect(solo?.followerDelta).toBe(500);
  });
});

/**
 * The retry predicate must stay NARROW.
 *
 * ⚠️ An earlier draft also matched `errorCode === undefined`. That single clause
 * would have retried every status-0 abort/timeout (doubling worst-case wall clock
 * during a Meta outage) AND the fetcher's own synthetic sentinels — "call budget
 * exhausted" and "invalid graph path" — which are deterministic by construction
 * and carry no errorCode. Retrying a budget-exhausted call is precisely the
 * runaway the budget exists to prevent.
 */
describe("isTransientGraphFailure — narrowness", () => {
  const base = { ok: false, rateLimited: false, authInvalid: false };
  it("matches ONLY Meta's retryable codes 1 and 2", () => {
    expect(isTransientGraphFailure({ ...base, errorCode: 1 })).toBe(true);
    expect(isTransientGraphFailure({ ...base, errorCode: 2 })).toBe(true);
  });
  it("does NOT match a code-less failure (timeout, abort, budget sentinel)", () => {
    expect(isTransientGraphFailure({ ...base, errorCode: undefined })).toBe(false);
  });
  it("does NOT match rate limiting, auth failure, deterministic codes, or success", () => {
    expect(isTransientGraphFailure({ ...base, rateLimited: true, errorCode: 2 })).toBe(false);
    expect(isTransientGraphFailure({ ...base, authInvalid: true, errorCode: 2 })).toBe(false);
    expect(isTransientGraphFailure({ ...base, errorCode: 100 })).toBe(false);
    expect(isTransientGraphFailure({ ...base, errorCode: 200 })).toBe(false);
    expect(isTransientGraphFailure({ ok: true, rateLimited: false, authInvalid: false, errorCode: undefined })).toBe(false);
  });
});

/**
 * The delta must be labelled with the span it ACTUALLY covers.
 *
 * ⚠️ Measured on prod 2026-08-31: at the 28-day window, 105 of 148 channels had a
 * baseline spanning as little as 5 days, every one rendered "· 28d". API follower
 * history mostly begins 2026-08-24, so a 28-day window cannot reach back that far
 * for most channels. Reporting windowDays there understates growth while sounding
 * authoritative.
 */
describe("GET /admin/meta/channels — followerDeltaDays reports the real span", () => {
  let adminToken: string;
  let assetId: string;

  beforeEach(async () => {
    mockedFetch.mockReset();
    await createTestRole("Admin", [{ resource: "reports", action: "manage", scope: "global" }]);
    const admin = await createTestUser({ roleNames: ["Admin"] });
    adminToken = generateToken(admin.id, admin.email, ["Admin"]);

    const conn = await prisma.metaConnection.create({
      data: { metaUserId: "mu-span", connectedById: admin.id, status: "ACTIVE" },
    });
    const platform = await prisma.platform.create({ data: { name: "Facebook", slug: "facebook" } });
    const acct = await prisma.socialAccount.create({
      data: { handle: "spanner", displayName: "Spanner", platformId: platform.id, status: "ACTIVE" },
    });
    const asset = await prisma.metaAsset.create({
      data: { connectionId: conn.id, kind: "FACEBOOK_PAGE", metaId: "pg-span", name: "Spanner",
              selected: true, followerCount: 1_005_000, socialAccountId: acct.id },
    });
    assetId = asset.id;

    // Only FIVE days of history — far short of a 28-day window.
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - 5);
    await prisma.accountGrowthSnapshot.create({
      data: { accountId: acct.id, date: d, followerCount: 1_000_000, source: "api" },
    });
  });

  it("reports a 5-day span for a 28-day window rather than claiming 28 days", async () => {
    const res = await request(app)
      .get("/v1/admin/meta/channels?window=days_28")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const row = res.body.data.items.find((i: { id: string }) => i.id === assetId);
    expect(row.followerDelta).toBe(5000);
    // The whole point: NOT 28.
    expect(row.followerDeltaDays).toBe(5);
  });

  it("reports the full span when history does cover the window", async () => {
    const res = await request(app)
      .get("/v1/admin/meta/channels?window=week")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const row = res.body.data.items.find((i: { id: string }) => i.id === assetId);
    expect(row.followerDelta).toBe(5000);
    expect(row.followerDeltaDays).toBe(5);
  });
});
