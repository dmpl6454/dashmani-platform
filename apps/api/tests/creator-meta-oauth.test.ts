/**
 * Creator portal — Facebook Login, discovery, page stats and token health.
 *
 * The Graph API is a small in-memory fake behind a stubbed global fetch; Postgres is real.
 * What is locked here:
 *  • the creator authorize URL asks for the creator scopes on the creator redirect and NONE of
 *    the forbidden ones — and the ADMIN authorize URL still carries no publish scope;
 *  • the public callback exchanges NOTHING: it hands state + code to the creators app in a URL
 *    fragment, and only the creator who STARTED the flow can finish it (POST /oauth/complete) —
 *    another creator's token is refused and the state survives (review SEC-1);
 *  • state is single-use (expired / used / unknown all → expired);
 *  • a grant for another app, a Facebook identity another creator LIVE-holds, or a staff
 *    grantor's identity stores NOTHING; a revoked identity is released to the next creator;
 *  • discovery: CREATE_CONTENT gating, the Instagram publish probe (an inconclusive probe keeps
 *    the stored answer), our-network duplicates (any meta_assets row, re-checked daily), and
 *    another creator's live page is never taken over — unless its holder cannot publish there;
 *  • no token ever reaches a response; DELETE /connection makes no Graph call;
 *  • metrics are NULL (never 0) on failure, and a refused token marks the connection
 *    NEEDS_REAUTH; token health rounds days UP and emails once per stage (14, then 3).
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
import { discoverCreatorAssets, syncNetworkDuplicates } from "../src/services/creator/creator-discovery.service";
import { refreshCreatorMetrics } from "../src/services/creator/creator-metrics.service";
import { daysLeft, purgeCreatorPageData, runCreatorTokenHealth } from "../src/cron/creator.cron";
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
  /** Publish probe answers a 500 (inconclusive) for these. */
  probeServerError: Set<string>;
  insightsFail: Set<string>;
  /** Profile reads answer code 190 (token refused) for these. */
  authFail: Set<string>;
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
    probeServerError: new Set(),
    insightsFail: new Set(),
    authFail: new Set(),
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
    if (edge === "content_publishing_limit") {
      if (graph.probeServerError.has(id)) return gErr(1, "An unknown error occurred", 500);
      return graph.probeFails.has(id) ? gErr(10, "Application does not have permission") : json({ data: [{ quota_usage: 0 }] });
    }
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
      if (graph.authFail.has(id)) return gErr(190, "Error validating access token: The session has been invalidated");
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

/** POST /oauth/complete as `token`; "connected", or the lower-case error code. */
async function complete(token: string, state: string, code = "abc") {
  const res = await request(app).post("/v1/creator/meta/oauth/complete").set("Authorization", `Bearer ${token}`).send({ state, code });
  return { res, outcome: res.status === 200 ? "connected" : String(res.body.error?.code ?? res.status).toLowerCase() };
}

/**
 * Run the full round-trip through the routes: start → Meta's redirect to our callback (which
 * must hand state + code back in a fragment, exchanging nothing) → the creators app finishing it
 * with the creator's own token.
 */
async function connectVia(creator: { id: string; email: string }) {
  const token = generateCreatorToken(creator.id, creator.email);
  const start = await request(app).post("/v1/creator/meta/oauth/start").set("Authorization", `Bearer ${token}`).send({});
  expect(start.status).toBe(200);
  const state = new URL(start.body.data.authorizeUrl).searchParams.get("state")!;
  const cb = await request(app).get(`/v1/creator/meta/oauth/callback?code=abc&state=${encodeURIComponent(state)}`);
  expect(cb.status).toBe(302);
  const location = cb.headers.location as string;
  expect(location).toBe(`https://creators.example.com/connect#${new URLSearchParams({ state, code: "abc" }).toString()}`);
  const { res, outcome } = await complete(token, state);
  return { location, state, token, outcome, res };
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

  describe("callback + complete", () => {
    it("connects: the callback only relays (fragment, no exchange); complete stores the encrypted token; discovery runs", async () => {
      const c = await seedCreator("ok@example.com");
      const token = generateCreatorToken(c.id, c.email);
      const start = await request(app).post("/v1/creator/meta/oauth/start").set("Authorization", `Bearer ${token}`).send({});
      const state = new URL(start.body.data.authorizeUrl).searchParams.get("state")!;
      calls = [];
      const cb = await request(app).get(`/v1/creator/meta/oauth/callback?code=abc&state=${encodeURIComponent(state)}`);
      expect(cb.status).toBe(302);
      expect(cb.headers["cache-control"]).toBe("no-store");
      expect(cb.headers.location).toMatch(/^https:\/\/creators\.example\.com\/connect#state=.+&code=abc$/);
      // The public callback never exchanges the code and never consumes the state.
      expect(calls).toHaveLength(0);
      expect((await prisma.creatorOauthState.findUnique({ where: { state } }))?.usedAt).toBeNull();

      const { res, outcome } = await complete(token, state);
      expect(outcome).toBe("connected");
      expect(res.body.data).toEqual({ connected: true });
      expect(res.headers["cache-control"]).toBe("no-store");
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

    it("⚠️ only the creator who STARTED the flow can finish it — another creator is refused, stores nothing, and the state survives", async () => {
      const victim = await seedCreator("victim@example.com");
      const attacker = await seedCreator("attacker@example.com");
      const attackerToken = generateCreatorToken(attacker.id, attacker.email);
      const victimToken = generateCreatorToken(victim.id, victim.email);
      // The attacker starts a connect on their own account and sends the facebook.com link…
      const start = await request(app).post("/v1/creator/meta/oauth/start").set("Authorization", `Bearer ${attackerToken}`).send({});
      const state = new URL(start.body.data.authorizeUrl).searchParams.get("state")!;
      // …the victim approves it, and the callback hands the code to the victim's own browser,
      // which is signed in to the victim's account: refused, nothing exchanged or stored.
      calls = [];
      const { res, outcome } = await complete(victimToken, state);
      expect(res.status).toBe(403);
      expect(outcome).toBe("wrong_account");
      expect(calls.some((x) => x.path === "/oauth/access_token")).toBe(false);
      expect(await prisma.creatorConnection.count()).toBe(0);
      // Not consumed by the refusal.
      expect((await prisma.creatorOauthState.findUnique({ where: { state } }))?.usedAt).toBeNull();
      // An unauthenticated complete is a 401, never an exchange.
      const anon = await request(app).post("/v1/creator/meta/oauth/complete").send({ state, code: "abc" });
      expect(anon.status).toBe(401);
      expect(await prisma.creatorConnection.count()).toBe(0);
    });

    it("state is single-use: used, expired and unknown are all refused", async () => {
      const c = await seedCreator("once@example.com");
      const { state, token, outcome } = await connectVia(c);
      expect(outcome).toBe("connected");
      await settleDiscovery(c.id);
      const again = await request(app).get(`/v1/creator/meta/oauth/callback?code=abc&state=${encodeURIComponent(state)}`);
      expect(again.headers.location).toBe("https://creators.example.com/connect?error=expired");
      expect((await complete(token, state)).outcome).toBe("expired");

      await prisma.creatorOauthState.create({ data: { state: "expired-state-xyz", creatorId: c.id, expiresAt: new Date(Date.now() - 1000) } });
      const exp = await request(app).get("/v1/creator/meta/oauth/callback?code=abc&state=expired-state-xyz");
      expect(exp.headers.location).toBe("https://creators.example.com/connect?error=expired");
      expect((await complete(token, "expired-state-xyz")).outcome).toBe("expired");

      const unknown = await request(app).get("/v1/creator/meta/oauth/callback?code=abc&state=never-issued");
      expect(unknown.status).toBe(302);
      expect(unknown.headers.location).toBe("https://creators.example.com/connect?error=expired");
      expect(unknown.headers["cache-control"]).toBe("no-store");
      expect((await complete(token, "never-issued")).outcome).toBe("expired");
    });

    it("maps a declined consent to ?error=denied", async () => {
      const res = await request(app).get("/v1/creator/meta/oauth/callback?error=access_denied&error_reason=user_denied");
      expect(res.headers.location).toBe("https://creators.example.com/connect?error=denied");
    });

    it("refuses a grant issued to another app and stores nothing", async () => {
      graph.appId = "999999999999999";
      const c = await seedCreator("mismatch@example.com");
      const { outcome } = await connectVia(c);
      expect(outcome).toBe("app_mismatch");
      expect(await prisma.creatorConnection.count()).toBe(0);
      expect(calls.some((x) => x.path === "/me/accounts")).toBe(false);
    });

    it("refuses a Facebook identity another creator LIVE-holds and stores nothing", async () => {
      const first = await seedCreator("first@example.com");
      await connectVia(first);
      const firstConn = await settleDiscovery(first.id);

      const second = await seedCreator("second@example.com");
      const { outcome } = await connectVia(second);
      expect(outcome).toBe("already_linked");
      expect(await prisma.creatorConnection.count({ where: { creatorId: second.id } })).toBe(0);
      expect(await prisma.creatorAsset.count({ where: { creatorId: second.id } })).toBe(0);
      const still = await prisma.creatorConnection.findUnique({ where: { id: firstConn!.id } });
      expect(still?.creatorId).toBe(first.id);
      expect(still?.userTokenEnc).toBe(firstConn!.userTokenEnc);
    });

    it("releases an identity whose connection was revoked: the next creator can connect it", async () => {
      const first = await seedCreator("leaver@example.com");
      const { token } = await connectVia(first);
      await settleDiscovery(first.id);
      expect((await request(app).delete("/v1/creator/meta/connection").set("Authorization", `Bearer ${token}`)).status).toBe(200);

      const second = await seedCreator("newowner@example.com");
      const { outcome } = await connectVia(second);
      expect(outcome).toBe("connected");
      await settleDiscovery(second.id);
      expect(await prisma.creatorConnection.count({ where: { creatorId: first.id } })).toBe(0);
      const conn = await prisma.creatorConnection.findUnique({ where: { metaUserId: META_USER } });
      expect(conn?.creatorId).toBe(second.id);
      expect(await prisma.creatorAsset.count({ where: { creatorId: second.id } })).toBe(4);
    });

    it("⚠️ refuses a staff grantor's identity: nothing stored, staff alerted, meta_* untouched", async () => {
      const admin = await createTestUser();
      await prisma.metaConnection.create({ data: { metaUserId: META_USER, connectedById: admin.id, status: "ACTIVE" } });
      const before = await prisma.metaConnection.findFirst({ where: { metaUserId: META_USER } });
      const c = await seedCreator("staffish@example.com");
      const { outcome, res } = await connectVia(c);
      expect(res.status).toBe(409);
      expect(outcome).toBe("staff_account");
      expect(await prisma.creatorConnection.count()).toBe(0);
      expect(await prisma.creatorAsset.count()).toBe(0);
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

    it("flags a page that is or was on our network as a duplicate (a disconnected meta_assets row counts too)", async () => {
      const admin = await createTestUser();
      const mc = await prisma.metaConnection.create({ data: { metaUserId: "staff-1", connectedById: admin.id, status: "ACTIVE" } });
      const ours = await prisma.metaAsset.create({ data: { connectionId: mc.id, kind: "FACEBOOK_PAGE", metaId: PAGE_PUBLISH, name: "Ours" } });
      const oursIg = await prisma.metaAsset.create({ data: { connectionId: mc.id, kind: "INSTAGRAM_ACCOUNT", metaId: IG_OK, name: "Ours IG", disconnectedAt: new Date() } });
      const { c, conn } = await connectedCreator("dupe@example.com");
      await discoverCreatorAssets(conn.id);
      const fb = await prisma.creatorAsset.findFirst({ where: { creatorId: c.id, metaId: PAGE_PUBLISH } });
      expect(fb?.networkDuplicateOf).toBe(ours.id);
      // A briefly revoked staff connection must not let one of our pages through.
      const ig = await prisma.creatorAsset.findFirst({ where: { creatorId: c.id, metaId: IG_OK } });
      expect(ig?.networkDuplicateOf).toBe(oursIg.id);
    });

    it("re-checks duplicates later: a page staff connect AFTER the creator is flagged and switched off", async () => {
      const { c, conn } = await connectedCreator("later@example.com");
      await discoverCreatorAssets(conn.id);
      await prisma.creatorAsset.updateMany({ where: { creatorId: c.id, metaId: PAGE_PUBLISH }, data: { enabled: true } });
      const admin = await createTestUser();
      const mc = await prisma.metaConnection.create({ data: { metaUserId: "staff-2", connectedById: admin.id, status: "ACTIVE" } });
      const ours = await prisma.metaAsset.create({ data: { connectionId: mc.id, kind: "FACEBOOK_PAGE", metaId: PAGE_PUBLISH, name: "Ours now" } });
      calls = [];
      const r = await syncNetworkDuplicates();
      expect(r).toMatchObject({ flagged: 1, switchedOff: 1 });
      expect(calls).toHaveLength(0); // DB only
      const fb = await prisma.creatorAsset.findFirst({ where: { creatorId: c.id, metaId: PAGE_PUBLISH } });
      expect(fb).toMatchObject({ networkDuplicateOf: ours.id, enabled: false });
      expect((await syncNetworkDuplicates()).flagged).toBe(0); // idempotent
    });

    it("takes a page over from a holder who can no longer use it, or who cannot publish there", async () => {
      // A holds both pages with an ANALYZE-only role (cannot publish).
      graph.pages = graph.pages.map((p) => ({ ...p, tasks: ["ANALYZE"] }));
      graph.igNodes = [];
      const a = await connectedCreator("analyst@example.com");
      await discoverCreatorAssets(a.conn.id);
      await prisma.creatorAsset.updateMany({ where: { creatorId: a.c.id }, data: { enabled: true } });

      // B can publish to PAGE_PUBLISH: takes it over (staff switch reset); PAGE_READONLY stays A's.
      defaultGraph();
      graph.igNodes = [];
      const b = await connectedCreator("owner@example.com");
      const out = await discoverCreatorAssets(b.conn.id);
      expect(out.claimedElsewhere).toBe(1);
      const pub = await prisma.creatorAsset.findFirst({ where: { metaId: PAGE_PUBLISH } });
      expect(pub).toMatchObject({ creatorId: b.c.id, connectionId: b.conn.id, canPublish: true, enabled: false });
      const ro = await prisma.creatorAsset.findFirst({ where: { metaId: PAGE_READONLY } });
      expect(ro?.creatorId).toBe(a.c.id);

      // Once A is rejected, A's claim stops counting even against a non-publisher.
      await prisma.creator.update({ where: { id: a.c.id }, data: { status: "rejected" } });
      const again = await discoverCreatorAssets(b.conn.id);
      expect(again.claimedElsewhere).toBe(0);
      expect((await prisma.creatorAsset.findFirst({ where: { metaId: PAGE_READONLY } }))?.creatorId).toBe(b.c.id);
    });

    it("an inconclusive Instagram probe keeps the stored answer instead of flipping to 'can't publish'", async () => {
      const { c, conn } = await connectedCreator("flaky@example.com");
      await discoverCreatorAssets(conn.id);
      expect((await prisma.creatorAsset.findFirst({ where: { creatorId: c.id, metaId: IG_OK } }))?.canPublish).toBe(true);
      graph.probeServerError.add(IG_OK);
      await discoverCreatorAssets(conn.id);
      const ig = await prisma.creatorAsset.findFirst({ where: { creatorId: c.id, metaId: IG_OK } });
      expect(ig?.canPublish).toBe(true);
      expect(ig?.publishProbeError).toBeNull();
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
      // Still live: a merely withheld figure does not touch the connection.
      expect((await prisma.creatorConnection.findFirst({ where: { creatorId: c.id } }))?.status).toBe("ACTIVE");
      const igCall = calls.find((x) => x.path === `/${IG_OK}/insights`);
      const until = Number(igCall?.query.get("until"));
      expect(until % 86400).toBe(0); // a completed UTC day boundary
      expect(until - Number(igCall?.query.get("since"))).toBe(28 * 86400);
      const fbCall = calls.find((x) => x.path === `/${PAGE_PUBLISH}/insights`);
      expect(fbCall?.query.get("period")).toBe("days_28");
      expect(fbCall?.query.get("since")).toBeTruthy();
    });

    it("a token Meta refuses (190) marks the connection NEEDS_REAUTH and stops its pages", async () => {
      const c = await seedCreator("lapsed@example.com");
      await connectVia(c);
      await settleDiscovery(c.id);
      graph.authFail.add(IG_OK).add(IG_NOPROBE).add(PAGE_PUBLISH).add(PAGE_READONLY);
      calls = [];
      await refreshCreatorMetrics();
      const conn = await prisma.creatorConnection.findFirst({ where: { creatorId: c.id } });
      expect(conn?.status).toBe("NEEDS_REAUTH");
      expect(conn?.lastError).toMatch(/reconnect/);
      // Only the first page of that connection was tried (one profile read, no insights); the
      // rest were skipped.
      expect(calls).toHaveLength(1);
      // …and it can no longer be submitted (no live connection behind its pages).
      const token = generateCreatorToken(c.id, c.email);
      const me = await request(app).get("/v1/creator/me").set("Authorization", `Bearer ${token}`);
      expect(me.body.data.checklist.publishablePages).toBe(0);
    });

    it("purges page details 30 days after a disconnect, and revoked connections with them", async () => {
      const c = await seedCreator("purge@example.com");
      const { token } = await connectVia(c);
      await settleDiscovery(c.id);
      await request(app).delete("/v1/creator/meta/connection").set("Authorization", `Bearer ${token}`);
      expect(await purgeCreatorPageData(new Date(Date.now() + 29 * 86_400_000))).toEqual({ assets: 0, connections: 0 });
      expect(await purgeCreatorPageData(new Date(Date.now() + 31 * 86_400_000))).toEqual({ assets: 4, connections: 1 });
      expect(await prisma.creatorAsset.count()).toBe(0);
      expect(await prisma.creator.count({ where: { id: c.id } })).toBe(1);
    });

    it("rounds days UP, flags both clocks, and emails once per stage (≤14, then ≤3) — idempotent across runs", async () => {
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
      // d14 (≤14) and d3 (≤3), plus d10: ≤14 days and never warned (a missed day still mails).
      expect(out.emailed).toBe(3);
      const to = vi.mocked(sendEmail).mock.calls.map((x) => (x[0] as { to: string }).to).sort();
      expect(to).toEqual(["d10@example.com", "d14@example.com", "d3@example.com"]);

      const status = async (id: string) => (await prisma.creatorConnection.findUnique({ where: { id } }))!.status;
      expect(await status(fourteen.id)).toBe("NEEDS_REAUTH_SOON");
      expect(await status(three.id)).toBe("NEEDS_REAUTH_SOON");
      expect(await status(ten.id)).toBe("NEEDS_REAUTH_SOON");
      expect(await status(gone.id)).toBe("NEEDS_REAUTH");
      expect(await status(fine.id)).toBe("ACTIVE");
      // ⚠️ Idempotent across restarts: a second pass the same day mails nobody again.
      vi.mocked(sendEmail).mockClear();
      expect((await runCreatorTokenHealth(now)).emailed).toBe(0);
      // The 14-day stage moves on to the 3-day one when it arrives — once.
      expect((await runCreatorTokenHealth(new Date(now.getTime() + 11 * 86_400_000))).emailed).toBe(1);
      const warned = async (id: string) => (await prisma.creatorConnection.findUnique({ where: { id } }))!.expiryWarnedDays;
      expect(await warned(fourteen.id)).toBe(3);
      expect(await warned(fine.id)).toBeNull();
    });
  });
});
