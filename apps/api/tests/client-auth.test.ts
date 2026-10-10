import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import app from "../src/app";
import { prisma } from "@dashmani/db";
import { hash } from "bcrypt";
import { createTestUser, createTestRole, generateToken } from "./helpers";
import "./setup";

describe("Client Auth API", () => {
  let clientId: string;

  beforeEach(async () => {
    const passwordHash = await hash("Client@123", 12);
    const client = await prisma.client.create({
      data: {
        companyName: "Test Corp",
        contactName: "Test Client",
        email: "client@test.com",
        passwordHash,
        status: "ACTIVE",
      },
    });
    clientId = client.id;
  });

  describe("POST /v1/client/auth/login", () => {
    it("logs in a client with valid credentials", async () => {
      const res = await request(app)
        .post("/v1/client/auth/login")
        .send({ email: "client@test.com", password: "Client@123" });

      expect(res.status).toBe(200);
      expect(res.body.data.accessToken).toBeDefined();
      expect(res.body.data.refreshToken).toBeDefined();
      expect(res.body.data.user.companyName).toBe("Test Corp");
    });

    it("rejects invalid credentials", async () => {
      const res = await request(app)
        .post("/v1/client/auth/login")
        .send({ email: "client@test.com", password: "wrong" });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
    });
  });

  describe("POST /v1/client/auth/signup (public self-signup)", () => {
    const body = { companyName: "Brand New Co", contactName: "Nina", email: "Nina@BrandNew.test", password: "Str0ng-pass!", phone: "+91 98765 43210" };

    it("creates an ACTIVE client with instant access and a normalised email", async () => {
      const res = await request(app).post("/v1/client/auth/signup").send(body);
      expect(res.status).toBe(201);
      expect(res.body.data.accessToken).toBeDefined();
      expect(res.body.data.user).toMatchObject({ companyName: "Brand New Co", name: "Nina", email: "nina@brandnew.test" });
      const row = await prisma.client.findUniqueOrThrow({ where: { email: "nina@brandnew.test" } });
      expect(row.status).toBe("ACTIVE");
      expect(row.phone).toBe("+91 98765 43210");
      // The token works on a client route straight away.
      const me = await request(app).get("/v1/client/campaigns").set("Authorization", `Bearer ${res.body.data.accessToken}`);
      expect(me.status).toBe(200);
      // And the account can sign in with the email in any casing.
      const login = await request(app).post("/v1/client/auth/login").send({ email: "NINA@brandnew.test", password: body.password });
      expect(login.status).toBe(200);
    });

    it("never takes over an existing account — any casing → 409, row untouched", async () => {
      const res = await request(app).post("/v1/client/auth/signup").send({ ...body, email: "CLIENT@test.com", password: "Hijack-pass1!" });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("EMAIL_EXISTS");
      const row = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
      expect(row.companyName).toBe("Test Corp");
      // The original password still works and the attempted one does not.
      expect((await request(app).post("/v1/client/auth/login").send({ email: "client@test.com", password: "Client@123" })).status).toBe(200);
      expect((await request(app).post("/v1/client/auth/login").send({ email: "client@test.com", password: "Hijack-pass1!" })).status).toBe(401);
    });

    it("consumes a pending invite for the same email so it cannot mint a second account", async () => {
      const invite = await prisma.clientInvite.create({ data: { email: "nina@brandnew.test", expiresAt: new Date(Date.now() + 86_400_000) } });
      expect((await request(app).post("/v1/client/auth/signup").send(body)).status).toBe(201);
      expect((await prisma.clientInvite.findUniqueOrThrow({ where: { id: invite.id } })).usedAt).not.toBeNull();
      const accept = await request(app).post("/v1/client/auth/register").send({ token: invite.token, password: "Another-pass1!" });
      expect(accept.status).toBe(400);
      expect(await prisma.client.count({ where: { email: "nina@brandnew.test" } })).toBe(1);
    });

    it("validates input and strips HTML from names", async () => {
      expect((await request(app).post("/v1/client/auth/signup").send({ ...body, password: "short" })).status).toBe(400);
      expect((await request(app).post("/v1/client/auth/signup").send({ ...body, email: "not-an-email" })).status).toBe(400);
      expect((await request(app).post("/v1/client/auth/signup").send({ contactName: "X", email: body.email, password: body.password })).status).toBe(400);
      const res = await request(app).post("/v1/client/auth/signup").send({ ...body, companyName: "<b>Acme</b> Ltd", phone: "" });
      expect(res.status).toBe(201);
      expect(res.body.data.user.companyName).toBe("Acme Ltd");
    });
  });

  describe("POST /v1/client/auth/refresh", () => {
    it("refreshes a client token", async () => {
      const loginRes = await request(app)
        .post("/v1/client/auth/login")
        .send({ email: "client@test.com", password: "Client@123" });

      const res = await request(app)
        .post("/v1/client/auth/refresh")
        .send({ refreshToken: loginRes.body.data.refreshToken });

      expect(res.status).toBe(200);
      expect(res.body.data.accessToken).toBeDefined();
    });
  });

  describe("GET /v1/clients (admin)", () => {
    it("lists clients for admin users", async () => {
      await createTestRole("Admin", [
        { resource: "clients", action: "view", scope: "global" },
        { resource: "clients", action: "create", scope: "global" },
      ]);
      const admin = await createTestUser({ roleNames: ["Admin"] });
      const token = generateToken(admin.id, admin.email, ["Admin"]);

      const res = await request(app)
        .get("/v1/clients")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(1);
      expect(res.body.data[0].companyName).toBe("Test Corp");
    });
  });

  describe("POST /v1/clients (admin)", () => {
    it("creates a new client", async () => {
      await createTestRole("Admin", [
        { resource: "clients", action: "view", scope: "global" },
        { resource: "clients", action: "create", scope: "global" },
      ]);
      const admin = await createTestUser({ roleNames: ["Admin"] });
      const token = generateToken(admin.id, admin.email, ["Admin"]);

      const res = await request(app)
        .post("/v1/clients")
        .set("Authorization", `Bearer ${token}`)
        .send({
          companyName: "New Client Co.",
          contactName: "Priya Patel",
          email: "priya@newclient.com",
          password: "NewClient@123",
        });

      expect(res.status).toBe(201);
      expect(res.body.data.companyName).toBe("New Client Co.");
    });
  });

  describe("Sign in with Google", () => {
    const CLIENT_ID = "123-test.apps.googleusercontent.com";
    const CREDENTIAL = "eyJhbGciOiJSUzI1NiJ9.test-credential-payload-that-is-long-enough.signature";
    const baseClaims = () => ({
      iss: "https://accounts.google.com",
      aud: CLIENT_ID,
      sub: "1029384756",
      email: "Nina@BrandNew.test",
      email_verified: "true",
      name: "Nina Rao",
      given_name: "Nina",
      exp: String(Math.floor(Date.now() / 1000) + 3600),
    });
    let fetchMock: ReturnType<typeof vi.fn>;
    // What Google's tokeninfo endpoint would answer for the next call.
    function googleAnswers(status: number, claims: Record<string, unknown>) {
      fetchMock.mockResolvedValue({ ok: status < 400, status, json: async () => claims });
    }

    beforeEach(() => {
      vi.stubEnv("GOOGLE_CLIENT_ID", CLIENT_ID);
      fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
    });
    // ⚠️ The suite runs every file in ONE fork — a leaked env or fetch stub breaks unrelated tests.
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    });

    it("config reports enabled with the client id, and disabled when the env is blank", async () => {
      let res = await request(app).get("/v1/client/auth/google/config");
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ enabled: true, clientId: CLIENT_ID });
      vi.stubEnv("GOOGLE_CLIENT_ID", "");
      res = await request(app).get("/v1/client/auth/google/config");
      expect(res.body.data).toEqual({ enabled: false, clientId: null });
    });

    it("is a clean 503 when not configured, and never calls Google", async () => {
      vi.stubEnv("GOOGLE_CLIENT_ID", "");
      const res = await request(app).post("/v1/client/auth/google").send({ credential: CREDENTIAL });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("GOOGLE_SIGNIN_DISABLED");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("signs an existing client in by verified email, in any casing, without creating a row", async () => {
      googleAnswers(200, { ...baseClaims(), email: "CLIENT@test.com" });
      const res = await request(app).post("/v1/client/auth/google").send({ credential: CREDENTIAL });
      expect(res.status).toBe(200);
      expect(res.body.data.accessToken).toBeDefined();
      expect(res.body.data.user.companyName).toBe("Test Corp");
      expect(await prisma.client.count()).toBe(1);
      // The token went to Google's tokeninfo endpoint, URL-encoded.
      expect(String(fetchMock.mock.calls[0][0])).toContain("oauth2.googleapis.com/tokeninfo?id_token=");
    });

    it("asks a first-time client for their company before creating anything", async () => {
      googleAnswers(200, baseClaims());
      const res = await request(app).post("/v1/client/auth/google").send({ credential: CREDENTIAL });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ needsProfile: true, email: "nina@brandnew.test", name: "Nina Rao" });
      expect(res.body.data.accessToken).toBeUndefined();
      expect(await prisma.client.count()).toBe(1);
    });

    it("creates an ACTIVE client on the second call, with an unusable password, and consumes a pending invite", async () => {
      await prisma.clientInvite.create({ data: { email: "nina@brandnew.test", expiresAt: new Date(Date.now() + 86_400_000) } });
      googleAnswers(200, baseClaims());
      const res = await request(app).post("/v1/client/auth/google").send({ credential: CREDENTIAL, companyName: "<b>Brand</b> New Co" });
      expect(res.status).toBe(200);
      expect(res.body.data.accessToken).toBeDefined();
      expect(res.body.data.user).toMatchObject({ companyName: "Brand New Co", name: "Nina Rao", email: "nina@brandnew.test" });
      const row = await prisma.client.findUnique({ where: { email: "nina@brandnew.test" } });
      expect(row?.status).toBe("ACTIVE");
      expect((await prisma.clientInvite.findFirst({ where: { email: "nina@brandnew.test" } }))?.usedAt).not.toBeNull();
      // Password login cannot guess its way in; "Forgot password" is the way to set one.
      const pw = await request(app).post("/v1/client/auth/login").send({ email: "nina@brandnew.test", password: "anything-at-all" });
      expect(pw.status).toBe(401);
      // A second Google sign-in is a plain sign-in, not a second account.
      googleAnswers(200, baseClaims());
      const again = await request(app).post("/v1/client/auth/google").send({ credential: CREDENTIAL });
      expect(again.status).toBe(200);
      expect(again.body.data.user.companyName).toBe("Brand New Co");
      expect(await prisma.client.count()).toBe(2);
    });

    it("refuses a token minted for another app, an unverified email, an expired token, and a non-Google issuer", async () => {
      googleAnswers(200, { ...baseClaims(), aud: "someone-else.apps.googleusercontent.com" });
      let res = await request(app).post("/v1/client/auth/google").send({ credential: CREDENTIAL });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("GOOGLE_TOKEN_INVALID");

      googleAnswers(200, { ...baseClaims(), email_verified: "false" });
      res = await request(app).post("/v1/client/auth/google").send({ credential: CREDENTIAL });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("GOOGLE_EMAIL_UNVERIFIED");

      googleAnswers(200, { ...baseClaims(), exp: String(Math.floor(Date.now() / 1000) - 5) });
      res = await request(app).post("/v1/client/auth/google").send({ credential: CREDENTIAL });
      expect(res.status).toBe(401);

      googleAnswers(200, { ...baseClaims(), iss: "https://evil.example" });
      res = await request(app).post("/v1/client/auth/google").send({ credential: CREDENTIAL });
      expect(res.status).toBe(401);

      // Google itself rejects the token (bad signature / garbage).
      googleAnswers(400, { error: "invalid_token" });
      res = await request(app).post("/v1/client/auth/google").send({ credential: CREDENTIAL });
      expect(res.status).toBe(401);
      expect(await prisma.client.count()).toBe(1);
    });

    it("refuses an inactive account and reports Google being down as a 503", async () => {
      await prisma.client.update({ where: { id: clientId }, data: { status: "INACTIVE" } });
      googleAnswers(200, { ...baseClaims(), email: "client@test.com" });
      let res = await request(app).post("/v1/client/auth/google").send({ credential: CREDENTIAL });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("ACCOUNT_INACTIVE");

      fetchMock.mockRejectedValue(new Error("ECONNRESET"));
      res = await request(app).post("/v1/client/auth/google").send({ credential: CREDENTIAL });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("GOOGLE_UNAVAILABLE");
    });
  });
});
