/**
 * ISOLATION: the creator portal must never touch our own network's Meta data.
 *
 * A full creator connect + discovery — using the SAME Facebook identity as a staff grant and
 * pages that are already on our network — must leave meta_connections / meta_assets (and every
 * other meta_* table) byte-for-byte as they were, and the admin Account Growth view
 * (GET /v1/admin/meta/channels) must answer exactly the same body before and after.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { prisma } from "@dashmani/db";
import "./setup";

vi.mock("../src/services/email.service", async (orig) => {
  const actual = await orig<typeof import("../src/services/email.service")>();
  return { ...actual, sendEmail: vi.fn(async () => ({ messageId: "test" })), notifyAdminByEmail: vi.fn(async () => null) };
});

import app from "../src/app";
import { createTestRole, createTestUser, generateClientToken, generateCreatorToken, generateHrToken, generateToken } from "./helpers";
import { CREATOR_META_SCOPES } from "../src/services/creator/creator-meta-config";
import { invalidateRangeCache } from "../src/services/meta-oauth/meta-range.service";

const APP_ID = "298449321694397";
const META_USER = "10000000000000099";
const STAFF_META_USER = "10000000000000098";
const PAGE = "300000000000001";
const IG = "17841400000000031";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fakeGraph(input: string | URL): Response {
  const url = new URL(String(input));
  const p = url.pathname.replace(/^\/v\d+\.\d+\//, "/");
  const now = Math.floor(Date.now() / 1000);
  if (p === "/oauth/access_token") return json({ access_token: "EAAlonglivedisolationxxxxxxxx" });
  if (p === "/debug_token")
    return json({ data: { app_id: APP_ID, user_id: META_USER, is_valid: true, scopes: [...CREATOR_META_SCOPES], expires_at: now + 5e6, data_access_expires_at: now + 7e6 } });
  if (p === "/me") return json({ id: META_USER, name: "Staff Person" });
  if (p === "/me/accounts") {
    if ((url.searchParams.get("fields") ?? "").includes("access_token"))
      return json({ data: [{ id: PAGE, name: "Our Page", tasks: ["MANAGE", "CREATE_CONTENT"], access_token: "EAApageisolationxxxxxxxxxxxx", followers_count: 9 }] });
    return json({ data: [{ id: PAGE, instagram_business_account: { id: IG } }] });
  }
  if (p === `/${IG}`) return json({ id: IG, username: "ourig", name: "Our IG", followers_count: 5, media_count: 2 });
  if (p === `/${IG}/content_publishing_limit`) return json({ data: [{ quota_usage: 0 }] });
  return json({ error: { code: 100, message: `unexpected ${p}` } }, 400);
}

const ENV = {
  CREATORS_ENABLED: "1",
  CREATORS_APP_URL: "https://creators.example.com",
  META_OAUTH_APP_ID: APP_ID,
  META_OAUTH_APP_SECRET: "test-app-secret",
  META_CREATOR_REDIRECT_URI: "https://api.example.com/v1/creator/meta/oauth/callback",
};
const saved: Record<string, string | undefined> = {};

/** Every meta_* table, as rows, in a stable order. */
async function snapshotMeta() {
  const [connections, assets, metrics, daily, posts, demographics, states] = await Promise.all([
    prisma.metaConnection.findMany({ orderBy: { id: "asc" } }),
    prisma.metaAsset.findMany({ orderBy: { id: "asc" } }),
    prisma.metaAssetMetric.findMany({ orderBy: { id: "asc" } }),
    prisma.metaAssetDaily.findMany({ orderBy: [{ assetId: "asc" }, { date: "asc" }] }),
    prisma.metaPost.findMany({ orderBy: { id: "asc" } }),
    prisma.metaAssetDemographic.findMany({ orderBy: { id: "asc" } }),
    prisma.metaOAuthState.findMany({ orderBy: { state: "asc" } }),
  ]);
  return { connections, assets, metrics, daily, posts, demographics, states };
}

describe("creator portal ↔ our Meta network isolation", () => {
  let adminToken: string;

  beforeEach(async () => {
    for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => fakeGraph(input)));
    invalidateRangeCache();

    await createTestRole("Admin", [
      { resource: "reports", action: "manage", scope: "global" },
      { resource: "reports", action: "view", scope: "global" },
    ]);
    const admin = await createTestUser({ roleNames: ["Admin"] });
    adminToken = generateToken(admin.id, admin.email, ["Admin"]);

    // Our own network: the SAME page/IG the creator will connect, under a DIFFERENT staff
    // identity (someone outside who also manages our pages, e.g. an agency). A staff grantor's
    // OWN identity is refused outright — see the test below.
    const mc = await prisma.metaConnection.create({ data: { metaUserId: STAFF_META_USER, connectedById: admin.id, status: "ACTIVE", grantedScopes: "pages_show_list" } });
    const page = await prisma.metaAsset.create({
      data: { connectionId: mc.id, kind: "FACEBOOK_PAGE", metaId: PAGE, name: "Our Page", selected: true, followerCount: 123456 },
    });
    await prisma.metaAsset.create({
      data: { connectionId: mc.id, kind: "INSTAGRAM_ACCOUNT", metaId: IG, name: "Our IG", username: "ourig", selected: true, followerCount: 4321 },
    });
    await prisma.metaAssetMetric.create({ data: { assetId: page.id, window: "days_28", views: BigInt(1000), engagements: BigInt(50), fetchedAt: new Date() } });
  });

  afterEach(() => {
    for (const k of Object.keys(ENV)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.unstubAllGlobals();
  });

  it("a full connect + discovery changes nothing in meta_* and nothing on the admin channels view", async () => {
    const before = await snapshotMeta();
    const channelsBefore = await request(app).get("/v1/admin/meta/channels").set("Authorization", `Bearer ${adminToken}`);
    expect(channelsBefore.status).toBe(200);
    expect(JSON.stringify(channelsBefore.body)).toContain("Our Page"); // the comparison is not vacuous

    const creator = await prisma.creator.create({ data: { email: "iso@example.com", passwordHash: "x", name: "Iso" } });
    const token = generateCreatorToken(creator.id, creator.email);
    const start = await request(app).post("/v1/creator/meta/oauth/start").set("Authorization", `Bearer ${token}`).send({});
    const state = new URL(start.body.data.authorizeUrl).searchParams.get("state")!;
    const cb = await request(app).get(`/v1/creator/meta/oauth/callback?code=x&state=${encodeURIComponent(state)}`);
    expect(cb.headers.location).toBe(`https://creators.example.com/connect#${new URLSearchParams({ state, code: "x" }).toString()}`);
    const done = await request(app).post("/v1/creator/meta/oauth/complete").set("Authorization", `Bearer ${token}`).send({ state, code: "x" });
    expect(done.status).toBe(200);

    // Wait for the background discovery, then run a manual refresh too.
    for (let i = 0; i < 100; i++) {
      const c = await prisma.creatorConnection.findFirst({ where: { creatorId: creator.id } });
      if (c && (c.discoveryState === "done" || c.discoveryState === "failed")) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const refresh = await request(app).post("/v1/creator/meta/refresh").set("Authorization", `Bearer ${token}`);
    expect(refresh.status).toBe(200);

    // The creator side did its job — and flagged both pages as ours.
    const assets = await prisma.creatorAsset.findMany({ where: { creatorId: creator.id } });
    expect(assets).toHaveLength(2);
    expect(assets.every((a) => a.networkDuplicateOf != null)).toBe(true);
    expect(refresh.body.data.assets.every((a: { networkDuplicate: boolean }) => a.networkDuplicate)).toBe(true);

    // …and our side is untouched.
    const after = await snapshotMeta();
    expect(after).toEqual(before);
    invalidateRangeCache();
    const channelsAfter = await request(app).get("/v1/admin/meta/channels").set("Authorization", `Bearer ${adminToken}`);
    expect(channelsAfter.status).toBe(200);
    expect(channelsAfter.body).toEqual(channelsBefore.body);
  });

  it("a staff grantor's own Facebook identity is refused by the creator flow, and nothing on either side changes", async () => {
    await prisma.metaConnection.updateMany({ data: { metaUserId: META_USER } });
    const before = await snapshotMeta();
    const creator = await prisma.creator.create({ data: { email: "iso3@example.com", passwordHash: "x", name: "Iso" } });
    const token = generateCreatorToken(creator.id, creator.email);
    const start = await request(app).post("/v1/creator/meta/oauth/start").set("Authorization", `Bearer ${token}`).send({});
    const state = new URL(start.body.data.authorizeUrl).searchParams.get("state")!;
    const done = await request(app).post("/v1/creator/meta/oauth/complete").set("Authorization", `Bearer ${token}`).send({ state, code: "x" });
    expect(done.status).toBe(409);
    expect(done.body.error.code).toBe("STAFF_ACCOUNT");
    expect(await prisma.creatorConnection.count()).toBe(0);
    expect(await prisma.creatorAsset.count()).toBe(0);
    expect(await snapshotMeta()).toEqual(before);
  });

  it("a creator token is refused by the admin channels view, and a staff token by the creator routes", async () => {
    const creator = await prisma.creator.create({ data: { email: "iso2@example.com", passwordHash: "x", name: "Iso" } });
    const ct = generateCreatorToken(creator.id, creator.email);
    expect((await request(app).get("/v1/admin/meta/channels").set("Authorization", `Bearer ${ct}`)).status).toBe(401);
    expect((await request(app).get("/v1/creator/meta/connection").set("Authorization", `Bearer ${adminToken}`)).status).toBe(401);
  });
});

// ── Creator bookings (payout plan Phase 3): the four portals' tokens never cross ─────────────────────────────

describe("creator-portal tokens against the campaign, rate-card and payout routes", () => {
  const saved3: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ["CREATORS_ENABLED", "CREATORS_MARKETPLACE_ENABLED", "CREATOR_ROUTE_ENABLED"]) saved3[k] = process.env[k];
    process.env.CREATORS_ENABLED = "1";
    process.env.CREATORS_MARKETPLACE_ENABLED = "1";
    process.env.CREATOR_ROUTE_ENABLED = "1";
  });
  afterEach(() => {
    for (const k of Object.keys(saved3)) {
      if (saved3[k] === undefined) delete process.env[k];
      else process.env[k] = saved3[k];
    }
  });

  /** Every route a creator booking touches on the staff and client sides. */
  const STAFF_ROUTES: Array<[string, string]> = [
    ["get", "/v1/admin/campaigns/rate-cards/creator-targets"],
    ["get", "/v1/admin/campaign-rate-cards"],
    ["put", "/v1/admin/campaign-rate-cards"],
    ["get", "/v1/admin/campaigns"],
    ["post", "/v1/admin/campaigns/00000000-0000-0000-0000-000000000000/approve"],
    ["post", "/v1/admin/campaigns/00000000-0000-0000-0000-000000000000/items/00000000-0000-0000-0000-000000000001/refund"],
    ["post", "/v1/admin/campaigns/00000000-0000-0000-0000-000000000000/reject"],
    // Creator offers, the staff side: verify the creator's link, withdraw an offer.
    ["post", "/v1/admin/campaigns/00000000-0000-0000-0000-000000000000/items/00000000-0000-0000-0000-000000000001/verify-creator-link"],
    ["post", "/v1/admin/campaigns/00000000-0000-0000-0000-000000000000/items/00000000-0000-0000-0000-000000000001/withdraw-offer"],
    ["post", "/v1/admin/campaigns/00000000-0000-0000-0000-000000000000/items/00000000-0000-0000-0000-000000000001/posted"],
    ["post", "/v1/admin/campaigns/00000000-0000-0000-0000-000000000000/items/00000000-0000-0000-0000-000000000001/failed"],
  ];
  const CLIENT_ROUTES: Array<[string, string]> = [
    ["get", "/v1/client/campaigns/catalogue"],
    ["get", "/v1/client/campaigns"],
    ["put", "/v1/client/campaigns/00000000-0000-0000-0000-000000000000/items"],
    ["post", "/v1/client/campaigns/00000000-0000-0000-0000-000000000000/checkout"],
    ["post", "/v1/client/campaigns/00000000-0000-0000-0000-000000000000/cancel"],
  ];
  const CREATOR_ROUTES: Array<[string, string]> = [
    ["get", "/v1/creator/me"],
    ["get", "/v1/creator/payout-account"],
    ["put", "/v1/creator/payout-account"],
    // Creator offers: the creator's own bookings.
    ["get", "/v1/creator/marketplace-status"],
    ["get", "/v1/creator/offers"],
    ["get", "/v1/creator/offers/00000000-0000-0000-0000-000000000000"],
    ["post", "/v1/creator/offers/00000000-0000-0000-0000-000000000000/accept"],
    ["post", "/v1/creator/offers/00000000-0000-0000-0000-000000000000/decline"],
    ["post", "/v1/creator/offers/00000000-0000-0000-0000-000000000000/posted"],
  ];
  const call = (method: string, path: string, token?: string) => {
    const r = (request(app) as any)[method](path);
    return (token ? r.set("Authorization", `Bearer ${token}`) : r).send({});
  };

  it("a creator token is refused by every staff and client campaign route, with no data and no side effect", async () => {
    const creator = await prisma.creator.create({ data: { email: "iso-bookings@example.com", passwordHash: "x", name: "Iso", status: "approved", emailVerifiedAt: new Date() } });
    const token = generateCreatorToken(creator.id, creator.email);
    for (const [method, path] of [...STAFF_ROUTES, ...CLIENT_ROUTES]) {
      const res = await call(method, path, token);
      expect([401, 403], `${method} ${path}`).toContain(res.status);
      expect(JSON.stringify(res.body), `${method} ${path}`).not.toContain("creatorTerm");
    }
    expect(await prisma.campaignBooking.count()).toBe(0);
    expect(await prisma.campaignRateCard.count()).toBe(0);
    expect(await prisma.creatorPayout.count()).toBe(0);
    expect(await prisma.creatorOffer.count()).toBe(0);
  });

  it("staff, client and HR tokens are refused by the creator routes, and no token at all gets 401", async () => {
    const staff = await createTestUser({ roleNames: [] });
    const tokens = [
      generateToken(staff.id, staff.email, ["Admin"]),
      generateClientToken("client-1", "c@brand.test"),
      generateHrToken(staff.id, staff.email, ["Admin"]),
    ];
    for (const [method, path] of CREATOR_ROUTES) {
      for (const t of tokens) {
        const res = await call(method, path, t);
        expect([401, 403], `${method} ${path}`).toContain(res.status);
      }
      expect((await call(method, path)).status, `${method} ${path} (no token)`).toBe(401);
    }
  });

  it("a client token is refused by every staff route, and an HR token by the staff and client ones", async () => {
    const staff = await createTestUser({ roleNames: [] });
    for (const [method, path] of STAFF_ROUTES) {
      expect([401, 403], `${method} ${path}`).toContain((await call(method, path, generateClientToken("client-1", "c@brand.test"))).status);
      expect([401, 403], `${method} ${path}`).toContain((await call(method, path, generateHrToken(staff.id, staff.email, ["Admin"]))).status);
    }
    for (const [method, path] of CLIENT_ROUTES) {
      expect([401, 403], `${method} ${path}`).toContain((await call(method, path, generateHrToken(staff.id, staff.email, ["Admin"]))).status);
      expect([401, 403], `${method} ${path}`).toContain((await call(method, path, generateToken(staff.id, staff.email, ["Admin"]))).status);
    }
  });

  it("a creator token is refused by the HR portal's routes and by the shared notification and account routes, and an HR token by the creator offers", async () => {
    const creator = await prisma.creator.create({ data: { email: "iso-hr@example.com", passwordHash: "x", name: "Iso", status: "approved", emailVerifiedAt: new Date() } });
    const token = generateCreatorToken(creator.id, creator.email);
    for (const [method, path] of [
      ["get", "/v1/hr/profile"],
      ["get", "/v1/hr/reports/today"],
      ["post", "/v1/hr/reports"],
      ["get", "/v1/hr/notifications"],
      ["get", "/v1/admin/notifications"],
      ["get", "/v1/accounts"],
    ] as Array<[string, string]>) {
      expect([401, 403], `${method} ${path}`).toContain((await call(method, path, token)).status);
    }
    const hr = await createTestUser({ roleNames: [] });
    for (const path of ["/v1/creator/offers", "/v1/creator/marketplace-status", "/v1/creator/offers/00000000-0000-0000-0000-000000000000"]) {
      expect([401, 403], path).toContain((await call("get", path, generateHrToken(hr.id, hr.email, ["Employee"]))).status);
    }
  });

  it("an employee token without the admin role is refused by the staff creator-offer routes, and the creator routes refuse it too", async () => {
    const employee = await createTestUser({ roleNames: [] });
    const token = generateToken(employee.id, employee.email, ["Employee"]);
    for (const [method, path] of STAFF_ROUTES.filter(([, p]) => /verify-creator-link|withdraw-offer|\/failed|\/posted/.test(p))) {
      expect([401, 403], `${method} ${path}`).toContain((await call(method, path, token)).status);
    }
    for (const [method, path] of CREATOR_ROUTES.filter(([, p]) => p.includes("/creator/offers") || p.includes("marketplace-status"))) {
      expect([401, 403], `${method} ${path}`).toContain((await call(method, path, token)).status);
    }
    expect(await prisma.creatorOffer.count()).toBe(0);
  });

  it("a creator token is refused by the new staff routes against a REAL offer: nothing about it changes and nothing about it is returned", async () => {
    const creator = await prisma.creator.create({ data: { email: "iso-offers@example.com", passwordHash: "x", name: "Iso", status: "approved", emailVerifiedAt: new Date() } });
    const client = await prisma.client.create({ data: { companyName: "Iso Brand", contactName: "Iso", email: "iso@brand.test", passwordHash: "x" } });
    const booking = await prisma.campaignBooking.create({ data: { clientId: client.id, name: "Iso", brand: "B", status: "approved", format: "post", totalPaise: 250_000, paidAt: new Date() } });
    const card = await prisma.campaignRateCard.create({ data: { targetType: "creator_asset", targetId: "00000000-0000-0000-0000-0000000000aa", platform: "instagram", format: "post", pricePaise: 250_000 } });
    const item = await prisma.campaignBookingItem.create({ data: { bookingId: booking.id, rateCardId: card.id, targetType: "creator_asset", targetId: card.targetId, platform: "instagram", format: "post", accountName: "Page", pricePaise: 250_000, status: "manual_pending" } });
    await prisma.creatorPayout.create({ data: { bookingId: booking.id, bookingItemId: item.id, creatorId: creator.id, payoutAccountId: "pa", razorpayAccountId: "acc_x", razorpayPaymentId: "pay_x", itemPricePaise: 250_000, shareBps: 4000, grossPaise: 100_000, amountPaise: 100_000 } });
    const offer = await prisma.creatorOffer.create({
      data: { bookingId: booking.id, bookingItemId: item.id, creatorId: creator.id, creatorAssetId: card.targetId, pageName: "Page", platform: "instagram", format: "post", status: "accepted", payoutPaise: 100_000, expiresAt: new Date(Date.now() + 86_400_000), linkUrl: "https://www.instagram.com/p/ABC/", linkSubmittedAt: new Date(), ownershipCheck: "auto_ok" },
    });
    const before = await prisma.creatorOffer.findUniqueOrThrow({ where: { id: offer.id } });
    const token = generateCreatorToken(creator.id, creator.email);
    for (const action of ["verify-creator-link", "withdraw-offer", "posted", "failed", "refund"]) {
      const res = await call("post", `/v1/admin/campaigns/${booking.id}/items/${item.id}/${action}`, token);
      expect([401, 403], action).toContain(res.status);
      expect(JSON.stringify(res.body), action).not.toContain("Iso Brand");
    }
    expect(await prisma.creatorOffer.findUniqueOrThrow({ where: { id: offer.id } })).toEqual(before);
    expect((await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe("manual_pending");
  });

  it("⚠️ what a creator reads back about THEIR OWN link is an exact allow-list: the staff verify key, the check's internal detail and who verified are staff-only, and a verified (completed) offer reads the same way", async () => {
    const creator = await prisma.creator.create({ data: { email: "iso-link@example.com", passwordHash: "x", name: "Iso", status: "approved", emailVerifiedAt: new Date() } });
    const client = await prisma.client.create({ data: { companyName: "Iso Brand 2", contactName: "Iso", email: "iso2@brand.test", passwordHash: "x" } });
    const booking = await prisma.campaignBooking.create({ data: { clientId: client.id, name: "Iso", brand: "B", status: "approved", format: "post", totalPaise: 250_000, paidAt: new Date() } });
    const card = await prisma.campaignRateCard.create({ data: { targetType: "creator_asset", targetId: "00000000-0000-0000-0000-0000000000bb", platform: "instagram", format: "post", pricePaise: 250_000 } });
    const item = await prisma.campaignBookingItem.create({ data: { bookingId: booking.id, rateCardId: card.id, targetType: "creator_asset", targetId: card.targetId, platform: "instagram", format: "post", accountName: "Page", pricePaise: 250_000, status: "manual_pending" } });
    const offer = await prisma.creatorOffer.create({
      data: {
        bookingId: booking.id,
        bookingItemId: item.id,
        creatorId: creator.id,
        creatorAssetId: card.targetId,
        pageName: "Page",
        platform: "instagram",
        format: "post",
        status: "accepted",
        payoutPaise: 100_000,
        expiresAt: new Date(Date.now() + 86_400_000),
        linkUrl: "https://www.instagram.com/p/ABCsecret/",
        linkCanonicalKey: "ig:ABCsecretkey",
        linkSubmittedAt: new Date(),
        ownershipCheck: "unverifiable",
        ownershipDetail: "token_lapsed_internal_detail",
        ownershipCheckedById: "staff-who-ticked-id",
      },
    });
    const token = generateCreatorToken(creator.id, creator.email);
    vi.stubEnv("RAZORPAY_KEY_ID", "rzp_test_key"); // the offers routes also need Razorpay configured (marketplaceAvailable)
    vi.stubEnv("RAZORPAY_KEY_SECRET", "rzp_test_secret");
    try {
      for (const status of ["accepted", "completed"]) {
        await prisma.creatorOffer.update({ where: { id: offer.id }, data: { status, ...(status === "completed" ? { linkVerifiedAt: new Date(), linkVerifiedById: "staff-who-verified-id" } : {}) } });
        const res = await call("get", `/v1/creator/offers/${offer.id}`, token);
        expect(res.status, status).toBe(200);
        expect(Object.keys(res.body.data.link).sort(), status).toEqual(["check", "message", "submittedAt", "url", "verified"]);
        const text = JSON.stringify(res.body);
        for (const never of ["ig:ABCsecretkey", "linkCanonicalKey", "token_lapsed_internal_detail", "ownershipDetail", "staff-who-ticked-id", "staff-who-verified-id", "Iso Brand 2", "iso2@brand.test"]) expect(text, `${status}: ${never}`).not.toContain(never);
      }
      expect((await call("get", `/v1/creator/offers/${offer.id}`, token)).body.data).toMatchObject({ status: "completed", link: { verified: true }, actions: { submitLink: false } });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
