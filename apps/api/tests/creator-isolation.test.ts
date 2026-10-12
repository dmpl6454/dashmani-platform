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
import { createTestRole, createTestUser, generateCreatorToken, generateToken } from "./helpers";
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
