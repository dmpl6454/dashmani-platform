/**
 * Creator portal — Facebook Login, discovery, page stats and token health.
 *
 * The Graph API is a small in-memory fake behind a stubbed global fetch; Postgres is real.
 * What is locked here:
 *  • the creator authorize URL asks for the creator scopes on the creator redirect and NONE of
 *    the forbidden ones — and the ADMIN authorize URL still carries no publish scope;
 *  • state is single-use (expired / used / unknown all → ?error=expired);
 *  • a grant for another app, or a Facebook identity another creator holds, stores NOTHING;
 *  • discovery: CREATE_CONTENT gating, the Instagram publish probe, our-network duplicates,
 *    and another creator's page is never taken over;
 *  • no token ever reaches a response; DELETE /connection makes no Graph call;
 *  • metrics are NULL (never 0) on failure; token health rounds days UP and emails at 14/3.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import request from "supertest";
import { prisma } from "@dashmani/db";
import "./setup";

vi.mock("../src/services/email.service", async (orig) => {
  const actual = await orig<typeof import("../src/services/email.service")>();
  return { ...actual, sendEmail: vi.fn(async () => ({ messageId: "test" })), notifyAdminByEmail: vi.fn(async () => null) };
});

import app from "../src/app";
import { notifyAdminByEmail, sendEmail } from "../src/services/email.service";
import { decryptToken } from "../src/utils/token-crypto";
import { generateCreatorToken, createTestUser } from "./helpers";
import { CREATOR_FORBIDDEN_SCOPES, CREATOR_META_SCOPES } from "../src/services/creator/creator-meta-config";
import { startMetaOauth } from "../src/services/meta-oauth/meta-oauth.service";
import { discoverCreatorAssets } from "../src/services/creator/creator-discovery.service";
import { refreshCreatorMetrics } from "../src/services/creator/creator-metrics.service";
import { daysLeft, runCreatorTokenHealth } from "../src/cron/creator.cron";
import { resetCreatorRefreshThrottle } from "../src/routes/creator-meta.routes";
import { encryptToken } from "../src/utils/token-crypto";

// ── Fake Graph ─────────────────────────────────────────────────────────────────

const APP_ID = "298449321694397";
const META_USER = "10000000000000001";
const PAGE_PUBLISH = "200000000000001"; // CREATE_CONTENT
const PAGE_READONLY = "200000000000002"; // ANALYZE only
const IG_OK = "17841400000000011";
const IG_NOPROBE = "17841400000000012";

interface Call { path: string; query: URLSearchParams }
let calls: Call[] = [];
let graph: {
  appId: string;
  userId: string;
  scopes: string[];
  pages: Array<{ id: string; name: string; tasks: string[]; access_token: string; followers_count?: number }>;
  igNodes: Array<{ id: string; instagram_business_account?: { id: string } }>;
  probeFails: Set<string>;
  insightsFail: Set<string>;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const gErr = (code: number, message = "boom", status = 400) => json({ error: { code, message } }, status);

function defaultGraph() {
  graph = {
    appId: APP_ID,
    userId: META_USER,
    scopes: [...CREATOR_META_SCOPES],
    pages: [
      { id: PAGE_PUBLISH, name: "Publish Page", tasks: ["ANALYZE", "CREATE_CONTENT"], access_token: "EAApagetoken1aaaaaaaaaaaaaaaa", followers_count: 1200 },
      { id: PAGE_READONLY, name: "Read Page", tasks: ["ANALYZE"], access_token: "EAApagetoken2aaaaaaaaaaaaaaaa", followers_count: 50 },
    ],
    igNodes: [
      { id: PAGE_PUBLISH, instagram_business_account: { id: IG_OK } },
      { id: PAGE_READONLY, instagram_business_account: { id: IG_NOPROBE } },
    ],
    probeFails: new Set([IG_NOPROBE]),
    insightsFail: new Set(),
  };
}

function handle(c: Call): Response {
  const p = c.path;
  if (p === "/oauth/access_token") {
    if (c.query.get("code")) return json({ access_token: "EAAshortlivedtokenxxxxxxxxxxxx" });
    return json({ access_token: "EAAlonglivedtokenxxxxxxxxxxxxx", expires_in: 5_000_000 });
  }
  if (p === "/debug_token") {
    const now = Math.floor(Date.now() / 1000);
    return json({ data: { app_id: graph.appId, user_id: graph.userId, is_valid: true, scopes: graph.scopes,
      expires_at: now + 60 * 86400, data_access_expires_at: now + 90 * 86400 } });
  }
  if (p === "/me") return json({ id: graph.userId, name: "Creator Person" });
  if (p === "/me/accounts") {
    const fields = c.query.get("fields") ?? "";
    if (fields.includes("access_token")) return json({ data: graph.pages });
    return json({ data: graph.igNodes });
  }
  const m = p.match(/^\/(\d+)(?:\/(.+))?$/);
  if (m) {
    const [, id, edge] = m;
    if (edge === "content_publishing_limit") return graph.probeFails.has(id) ? gErr(10, "Application does not have permission") : json({ data: [{ quota_usage: 0 }] });
    if (edge === "insights") {
      if (graph.insightsFail.has(id)) return gErr(100, "insights unavailable");
      if (c.query.get("metric_type") === "total_value") {
        return json({ data: [{ name: "views", total_value: { value: 900 } }, { name: "total_interactions", total_value: { value: -1 } }] });
      }
      const closed = new Date(Date.now() - 3600_000).toISOString();
      const open = new Date(Date.now() + 3600_000).toISOString();
      return json({ data: [
        { name: "page_media_view", values: [{ value: 400, end_time: closed }, { value: 5, end_time: open }] },
        { name: "page_post_engagements", values: [{ value: 30, end_time: closed }, { value: 1, end_time: open }] },
      ] });
    }
    if (!edge) {
      if (id.startsWith("1784")) return json({ id, username: `user${id.slice(-2)}`, name: `IG ${id.slice(-2)}`, followers_count: 777, media_count: 12, profile_picture_url: "https://cdn.example/p.jpg" });
      return json({ id, followers_count: 1300 });
    }
  }
  return gErr(100, `unexpected path ${p}`);
}

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      const c: Call = { path: url.pathname.replace(/^\/v\d+\.\d+\//, "/"), query: url.searchParams };
      calls.push(c);
      return handle(c);
    }),
  );
}

// ── Env ────────────────────────────────────────────────────────────────────────

const ENV = {
  CREATORS_ENABLED: "1",
  CREATORS_APP_URL: "https://creators.example.com",
  META_OAUTH_APP_ID: APP_ID,
  META_OAUTH_APP_SECRET: "test-app-secret",
  META_CREATOR_REDIRECT_URI: "https://api.example.com/v1/creator/meta/oauth/callback",
  META_OAUTH_REDIRECT_URI: "https://api.example.com/v1/meta/oauth/callback",
  META_OAUTH_RETURN_ORIGIN: "https://portal.example.com",
};
const saved: Record<string, string | undefined> = {};

async function seedCreator(email: string, status = "draft") {
  return prisma.creator.create({ data: { email, passwordHash: "x", name: "Test Creator", status } });
}

/** Run the full OAuth round-trip through the routes; returns the callback's Location. */
async function connectVia(creator: { id: string; email: string }) {
  const token = generateCreatorToken(creator.id, creator.email);
  const start = await request(app).post("/v1/creator/meta/oauth/start").set("Authorization", `Bearer ${token}`).send({});
  expect(start.status).toBe(200);
  const state = new URL(start.body.data.authorizeUrl).searchParams.get("state")!;
  const cb = await request(app).get(`/v1/creator/meta/oauth/callback?code=abc&state=${encodeURIComponent(state)}`);
  expect(cb.status).toBe(302);
  return { location: cb.headers.location as string, state, token };
}

/** The callback fires discovery and does not wait; wait for it so no write outlives the test. */
async function settleDiscovery(creatorId: string) {
  for (let i = 0; i < 100; i++) {
    const c = await prisma.creatorConnection.findFirst({ where: { creatorId }, orderBy: { createdAt: "desc" } });
    if (!c || c.discoveryState === "done" || c.discoveryState === "failed") return c;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("discovery did not settle");
}

describe("creator Meta connect", () => {
  beforeEach(() => {
    for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
    calls = [];
    defaultGraph();
    installFetch();
    resetCreatorRefreshThrottle();
    vi.mocked(sendEmail).mockClear();
    vi.mocked(notifyAdminByEmail).mockClear();
  });

  afterEach(() => {
    for (const k of Object.keys(ENV)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.unstubAllGlobals();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  describe("authorize URL", () => {
    it("asks for the creator scopes on the creator redirect, and none of the forbidden ones", async () => {
      const c = await seedCreator("scopes@example.com");
      const res = await request(app)
        .post("/v1/creator/meta/oauth/start")
        .set("Authorization", `Bearer ${generateCreatorToken(c.id, c.email)}`)
        .send({ rerequest: true });
      expect(res.status).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      const url = new URL(res.body.data.authorizeUrl);
      expect(url.searchParams.get("client_id")).toBe(APP_ID);
      expect(url.searchParams.get("redirect_uri")).toBe(ENV.META_CREATOR_REDIRECT_URI);
      expect(url.searchParams.get("auth_type")).toBe("rerequest");
      const scopes = (url.searchParams.get("scope") ?? "").split(",");
      expect([...scopes].sort()).toEqual([...CREATOR_META_SCOPES].sort());
      for (const f of CREATOR_FORBIDDEN_SCOPES) expect(scopes).not.toContain(f);
      // The state row is the creator's and lives 60 minutes.
      const row = await prisma.creatorOauthState.findUnique({ where: { state: url.searchParams.get("state")! } });
      expect(row?.creatorId).toBe(c.id);
      expect(row!.expiresAt.getTime() - Date.now()).toBeGreaterThan(55 * 60_000);
    });

    it("leaves the ADMIN authorize URL read-only (no publish scope)", async () => {
      const user = await createTestUser();
      const { authorizeUrl } = await startMetaOauth({ userId: user.id });
      for (const s of ["pages_manage_posts", "instagram_content_publish", "publish_video"]) expect(authorizeUrl).not.toContain(s);
    });

    it("answers 503 META_NOT_CONFIGURED without the creator redirect URI, and writes no state", async () => {
      delete process.env.META_CREATOR_REDIRECT_URI;
      const c = await seedCreator("noconf@example.com");
      const res = await request(app)
        .post("/v1/creator/meta/oauth/start")
        .set("Authorization", `Bearer ${generateCreatorToken(c.id, c.email)}`)
        .send({});
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("META_NOT_CONFIGURED");
      expect(await prisma.creatorOauthState.count()).toBe(0);
    });

    it("refuses a suspended creator and a staff token", async () => {
      const c = await seedCreator("susp@example.com", "suspended");
      const res = await request(app)
        .post("/v1/creator/meta/oauth/start")
        .set("Authorization", `Bearer ${generateCreatorToken(c.id, c.email)}`)
        .send({});
      expect(res.status).toBe(403);
      const staff = await request(app).post("/v1/creator/meta/oauth/start").set("Authorization", "Bearer not-a-creator-token").send({});
      expect(staff.status).toBe(401);
    });
  });

  describe("callback", () => {
    it("connects: 302 ?connected=1, token encrypted at rest, discovery runs", async () => {
      const c = await seedCreator("ok@example.com");
      const { location } = await connectVia(c);
      expect(location).toBe("https://creators.example.com/connect?connected=1");
      const conn = await settleDiscovery(c.id);
      expect(conn?.status).toBe("ACTIVE");
      expect(conn?.discoveryState).toBe("done");
      expect(conn?.userTokenEnc?.startsWith("enc:v1:")).toBe(true);
      expect(decryptToken(conn!.userTokenEnc!)).toBe("EAAlonglivedtokenxxxxxxxxxxxxx");
      expect(conn?.dataAccessExpiresAt).not.toBeNull();
      expect(await prisma.creatorAsset.count({ where: { creatorId: c.id } })).toBe(4);
      // The exchange used the CREATOR redirect URI.
      const exchange = calls.find((x) => x.path === "/oauth/access_token" && x.query.get("code"));
      expect(exchange?.query.get("redirect_uri")).toBe(ENV.META_CREATOR_REDIRECT_URI);
    });

    it("state is single-use: used, expired and unknown all redirect ?error=expired", async () => {
      const c = await seedCreator("once@example.com");
      const { state } = await connectVia(c);
      await settleDiscovery(c.id);
      const again = await request(app).get(`/v1/creator/meta/oauth/callback?code=abc&state=${encodeURIComponent(state)}`);
      expect(again.headers.location).toBe("https://creators.example.com/connect?error=expired");

      await prisma.creatorOauthState.create({ data: { state: "expired-state-xyz", creatorId: c.id, expiresAt: new Date(Date.now() - 1000) } });
      const exp = await request(app).get("/v1/creator/meta/oauth/callback?code=abc&state=expired-state-xyz");
      expect(exp.headers.location).toBe("https://creators.example.com/connect?error=expired");

      const unknown = await request(app).get("/v1/creator/meta/oauth/callback?code=abc&state=never-issued");
      expect(unknown.status).toBe(302);
      expect(unknown.headers.location).toBe("https://creators.example.com/connect?error=expired");
      expect(unknown.headers["cache-control"]).toBe("no-store");
    });

    it("maps a declined consent to ?error=denied", async () => {
      const res = await request(app).get("/v1/creator/meta/oauth/callback?error=access_denied&error_reason=user_denied");
      expect(res.headers.location).toBe("https://creators.example.com/connect?error=denied");
    });

    it("refuses a grant issued to another app and stores nothing", async () => {
      graph.appId = "999999999999999";
      const c = await seedCreator("mismatch@example.com");
      const { location } = await connectVia(c);
      expect(location).toBe("https://creators.example.com/connect?error=app_mismatch");
      expect(await prisma.creatorConnection.count()).toBe(0);
      expect(calls.some((x) => x.path === "/me/accounts")).toBe(false);
    });

    it("refuses a Facebook identity another creator holds and stores nothing", async () => {
      const first = await seedCreator("first@example.com");
      await connectVia(first);
      const firstConn = await settleDiscovery(first.id);

      const second = await seedCreator("second@example.com");
      const { location } = await connectVia(second);
      expect(location).toBe("https://creators.example.com/connect?error=already_linked");
      expect(await prisma.creatorConnection.count({ where: { creatorId: second.id } })).toBe(0);
      expect(await prisma.creatorAsset.count({ where: { creatorId: second.id } })).toBe(0);
      const still = await prisma.creatorConnection.findUnique({ where: { id: firstConn!.id } });
      expect(still?.creatorId).toBe(first.id);
      expect(still?.userTokenEnc).toBe(firstConn!.userTokenEnc);
    });

    it("alerts staff when the identity also holds a staff Meta connection (and never writes it)", async () => {
      const admin = await createTestUser();
      await prisma.metaConnection.create({ data: { metaUserId: META_USER, connectedById: admin.id, status: "ACTIVE" } });
      const before = await prisma.metaConnection.findFirst({ where: { metaUserId: META_USER } });
      const c = await seedCreator("staffish@example.com");
      const { location } = await connectVia(c);
      expect(location).toBe("https://creators.example.com/connect?connected=1");
      await settleDiscovery(c.id);
      expect(vi.mocked(notifyAdminByEmail)).toHaveBeenCalled();
      const after = await prisma.metaConnection.findFirst({ where: { metaUserId: META_USER } });
      expect(after).toEqual(before);
    });

    it("answers ?error=disabled when the portal is dark", async () => {
      process.env.CREATORS_ENABLED = "0";
      const res = await request(app).get("/v1/creator/meta/oauth/callback?code=a&state=b");
      expect(res.headers.location).toBe("https://creators.example.com/connect?error=disabled");
    });
  });

  describe("discovery", () => {
    async function connectedCreator(email: string) {
      const c = await seedCreator(email);
      const conn = await prisma.creatorConnection.create({
        data: {
          creatorId: c.id,
          metaUserId: `${Date.now()}${Math.floor(Math.random() * 1000)}`,
          userTokenEnc: encryptToken("EAAusertokenxxxxxxxxxxxxxxxxxx"),
          grantedScopes: graph.scopes.join(","),
        },
      });
      return { c, conn };
    }

    it("gates Facebook publishing on CREATE_CONTENT and Instagram on the publish probe", async () => {
      const { c, conn } = await connectedCreator("gate@example.com");
      const out = await discoverCreatorAssets(conn.id);
      expect(out.state).toBe("done");
      const assets = await prisma.creatorAsset.findMany({ where: { creatorId: c.id } });
      const by = (id: string) => assets.find((a) => a.metaId === id)!;
      expect(by(PAGE_PUBLISH).canPublish).toBe(true);
      expect(by(PAGE_PUBLISH).pageTokenEnc?.startsWith("enc:v1:")).toBe(true);
      expect(by(PAGE_READONLY).canPublish).toBe(false);
      expect(by(PAGE_READONLY).publishProbeError).toMatch(/cannot create content/);
      expect(by(IG_OK).canPublish).toBe(true);
      expect(by(IG_OK).parentPageId).toBe(PAGE_PUBLISH);
      expect(by(IG_OK).pageTokenEnc).toBeNull();
      expect(by(IG_NOPROBE).canPublish).toBe(false);
      expect(by(IG_NOPROBE).publishProbeError).toMatch(/permission/i);
      // The IG node lookup used the BARE field.
      const igCall = calls.find((x) => x.path === "/me/accounts" && x.query.get("fields") === "instagram_business_account");
      expect(igCall).toBeTruthy();
      expect(calls.some((x) => (x.query.get("fields") ?? "").includes("instagram_business_account{"))).toBe(false);
    });

    it("without pages_manage_posts nothing on Facebook is publishable", async () => {
      graph.scopes = graph.scopes.filter((s) => s !== "pages_manage_posts" && s !== "instagram_content_publish");
      const { c, conn } = await connectedCreator("noscope@example.com");
      await discoverCreatorAssets(conn.id);
      const assets = await prisma.creatorAsset.findMany({ where: { creatorId: c.id } });
      expect(assets.every((a) => !a.canPublish)).toBe(true);
      // No probe without the scope.
      expect(calls.some((x) => x.path.endsWith("/content_publishing_limit"))).toBe(false);
    });

    it("flags a page already on our network as a duplicate", async () => {
      const admin = await createTestUser();
      const mc = await prisma.metaConnection.create({ data: { metaUserId: "staff-1", connectedById: admin.id, status: "ACTIVE" } });
      const ours = await prisma.metaAsset.create({ data: { connectionId: mc.id, kind: "FACEBOOK_PAGE", metaId: PAGE_PUBLISH, name: "Ours" } });
      await prisma.metaAsset.create({ data: { connectionId: mc.id, kind: "INSTAGRAM_ACCOUNT", metaId: IG_OK, name: "Ours IG", disconnectedAt: new Date() } });
      const { c, conn } = await connectedCreator("dupe@example.com");
      await discoverCreatorAssets(conn.id);
      const fb = await prisma.creatorAsset.findFirst({ where: { creatorId: c.id, metaId: PAGE_PUBLISH } });
      expect(fb?.networkDuplicateOf).toBe(ours.id);
      // A DISCONNECTED meta_assets row is not "live" and does not count.
      const ig = await prisma.creatorAsset.findFirst({ where: { creatorId: c.id, metaId: IG_OK } });
      expect(ig?.networkDuplicateOf).toBeNull();
    });

    it("never takes another creator's page; says so on the connection", async () => {
      const a = await connectedCreator("holder@example.com");
      await discoverCreatorAssets(a.conn.id);
      const held = await prisma.creatorAsset.findFirst({ where: { metaId: PAGE_PUBLISH } });

      const b = await connectedCreator("taker@example.com");
      const out = await discoverCreatorAssets(b.conn.id);
      expect(out.claimedElsewhere).toBe(4);
      const still = await prisma.creatorAsset.findFirst({ where: { metaId: PAGE_PUBLISH } });
      expect(still?.creatorId).toBe(a.c.id);
      expect(still?.connectionId).toBe(held?.connectionId);
      expect(still?.pageTokenEnc).toBe(held?.pageTokenEnc);
      const bConn = await prisma.creatorConnection.findUnique({ where: { id: b.conn.id } });
      expect(bConn?.lastError).toMatch(/4 pages are already connected to another creator account/);
    });

    it("marks pages that stop coming back as disconnected — only after a complete pass", async () => {
      const { c, conn } = await connectedCreator("gone@example.com");
      await discoverCreatorAssets(conn.id);
      await prisma.creatorAsset.updateMany({ where: { creatorId: c.id, metaId: PAGE_READONLY }, data: { enabled: true } });

      // A failing pass concludes nothing.
      graph.igNodes = [];
      const failing = graph.pages;
      graph.pages = [];
      vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
        const url = new URL(String(input));
        const path = url.pathname.replace(/^\/v\d+\.\d+\//, "/");
        if (path === "/me/accounts") return gErr(1, "unknown", 500);
        return handle({ path, query: url.searchParams });
      }));
      const bad = await discoverCreatorAssets(conn.id);
      expect(bad.state).toBe("failed");
      expect(await prisma.creatorAsset.count({ where: { creatorId: c.id, disconnectedAt: { not: null } } })).toBe(0);

      installFetch();
      graph.pages = failing.filter((p) => p.id === PAGE_PUBLISH);
      graph.igNodes = [{ id: PAGE_PUBLISH, instagram_business_account: { id: IG_OK } }];
      const good = await discoverCreatorAssets(conn.id);
      expect(good.state).toBe("done");
      expect(good.disconnected).toBe(2);
      const ro = await prisma.creatorAsset.findFirst({ where: { creatorId: c.id, metaId: PAGE_READONLY } });
      expect(ro?.disconnectedAt).not.toBeNull();
      expect(ro?.enabled).toBe(false);
      expect(ro?.pageTokenEnc).toBeNull();
    });
  });

  describe("connection routes", () => {
    it("GET /connection returns views with no token anywhere", async () => {
      const c = await seedCreator("view@example.com");
      const { token } = await connectVia(c);
      await settleDiscovery(c.id);
      const res = await request(app).get("/v1/creator/meta/connection").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      const text = JSON.stringify(res.body);
      expect(text).not.toMatch(/enc:v1|EAA|pageToken|userToken|networkDuplicateOf/);
      expect(res.body.data.connection.metaUserName).toBe("Creator Person");
      expect(res.body.data.connection.missingScopes).toEqual([]);
      expect(res.body.data.assets).toHaveLength(4);
      const fb = res.body.data.assets.find((a: { metaId: string }) => a.metaId === PAGE_PUBLISH);
      expect(fb).toMatchObject({ kind: "facebook_page", canPublish: true, profileUrl: `https://www.facebook.com/${PAGE_PUBLISH}`, networkDuplicate: false });
    });

    it("POST /refresh re-runs discovery once per 10 minutes", async () => {
      const c = await seedCreator("refresh@example.com");
      const { token } = await connectVia(c);
      await settleDiscovery(c.id);
      const first = await request(app).post("/v1/creator/meta/refresh").set("Authorization", `Bearer ${token}`);
      expect(first.status).toBe(200);
      expect(first.body.data.assets).toHaveLength(4);
      const second = await request(app).post("/v1/creator/meta/refresh").set("Authorization", `Bearer ${token}`);
      expect(second.status).toBe(429);
      expect(second.body.error.code).toBe("TOO_SOON");
    });

    it("DELETE /connection revokes locally and makes NO Graph call", async () => {
      const c = await seedCreator("bye@example.com");
      const { token } = await connectVia(c);
      await settleDiscovery(c.id);
      calls = [];
      const res = await request(app).delete("/v1/creator/meta/connection").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ disconnected: true });
      expect(calls).toHaveLength(0);
      const conn = await prisma.creatorConnection.findFirst({ where: { creatorId: c.id } });
      expect(conn).toMatchObject({ status: "REVOKED", userTokenEnc: null });
      const assets = await prisma.creatorAsset.findMany({ where: { creatorId: c.id } });
      expect(assets.every((a) => a.disconnectedAt && !a.enabled && a.pageTokenEnc === null)).toBe(true);
      const view = await request(app).get("/v1/creator/meta/connection").set("Authorization", `Bearer ${token}`);
      expect(view.body.data.connection).toBeNull();
      expect(view.body.data.assets.every((a: { disconnected: boolean }) => a.disconnected)).toBe(true);
    });
  });

  describe("metrics + token health", () => {
    it("reads FB rolling-28d from the last CLOSED point, IG from total_value; NULL (not 0) when withheld or failed", async () => {
      const c = await seedCreator("metrics@example.com");
      await connectVia(c);
      await settleDiscovery(c.id);
      graph.insightsFail.add(PAGE_READONLY);
      const out = await refreshCreatorMetrics();
      expect(out.rateLimited).toBe(false);
      const assets = await prisma.creatorAsset.findMany({ where: { creatorId: c.id } });
      const by = (id: string) => assets.find((a) => a.metaId === id)!;
      expect(Number(by(PAGE_PUBLISH).views28d)).toBe(400); // not 405: the open bucket is excluded
      expect(Number(by(PAGE_PUBLISH).engagements28d)).toBe(30);
      expect(by(PAGE_PUBLISH).followerCount).toBe(1300);
      expect(by(PAGE_READONLY).views28d).toBeNull();
      expect(by(PAGE_READONLY).metricsError).toMatch(/insights/);
      expect(Number(by(IG_OK).views28d)).toBe(900);
      expect(by(IG_OK).engagements28d).toBeNull(); // -1 sentinel
      expect(by(IG_OK).metricsFetchedAt).not.toBeNull();
      const igCall = calls.find((x) => x.path === `/${IG_OK}/insights`);
      const until = Number(igCall?.query.get("until"));
      expect(until % 86400).toBe(0); // a completed UTC day boundary
      expect(until - Number(igCall?.query.get("since"))).toBe(28 * 86400);
      const fbCall = calls.find((x) => x.path === `/${PAGE_PUBLISH}/insights`);
      expect(fbCall?.query.get("period")).toBe("days_28");
      expect(fbCall?.query.get("since")).toBeTruthy();
    });

    it("rounds days UP, flags both clocks, and emails only at 14 and 3 days", async () => {
      expect(daysLeft(new Date(Date.now() + 60_000), new Date())).toBe(1);
      expect(daysLeft(new Date(Date.now() - 60_000), new Date())).toBe(0);
      const now = new Date();
      const mk = async (email: string, tokenDays: number | null, dataDays: number | null) => {
        const c = await seedCreator(email);
        return prisma.creatorConnection.create({
          data: {
            creatorId: c.id,
            metaUserId: email,
            userTokenEnc: encryptToken("EAAxxxxxxxxxxxxxxxxxxxxxxxx"),
            tokenExpiresAt: tokenDays == null ? null : new Date(now.getTime() + tokenDays * 86_400_000 - 3_600_000),
            dataAccessExpiresAt: dataDays == null ? null : new Date(now.getTime() + dataDays * 86_400_000 - 3_600_000),
          },
        });
      };
      const fourteen = await mk("d14@example.com", 50, 14);
      const three = await mk("d3@example.com", 3, null);
      const ten = await mk("d10@example.com", 10, 80);
      const gone = await mk("d0@example.com", 0, 30);
      const fine = await mk("d40@example.com", 40, 60);
      const out = await runCreatorTokenHealth(now);
      expect(out.emailed).toBe(2);
      const to = vi.mocked(sendEmail).mock.calls.map((x) => (x[0] as { to: string }).to).sort();
      expect(to).toEqual(["d14@example.com", "d3@example.com"]);
      const status = async (id: string) => (await prisma.creatorConnection.findUnique({ where: { id } }))!.status;
      expect(await status(fourteen.id)).toBe("NEEDS_REAUTH_SOON");
      expect(await status(three.id)).toBe("NEEDS_REAUTH_SOON");
      expect(await status(ten.id)).toBe("NEEDS_REAUTH_SOON");
      expect(await status(gone.id)).toBe("NEEDS_REAUTH");
      expect(await status(fine.id)).toBe("ACTIVE");
    });
  });
});
