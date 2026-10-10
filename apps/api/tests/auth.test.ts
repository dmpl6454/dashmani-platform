import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import app from "../src/app";
import { createTestUser, createTestRole } from "./helpers";
import { prisma } from "@dashmani/db";
import "./setup";

describe("Auth API", () => {
  beforeEach(async () => {
    await createTestRole("Employee", [
      { resource: "employees", action: "view", scope: "own" },
    ]);
  });

  describe("POST /v1/auth/login", () => {
    it("returns tokens for valid credentials", async () => {
      await createTestUser({ email: "test@digitalsukoon.com", password: "TestPass123!", roleNames: ["Employee"] });

      const res = await request(app)
        .post("/v1/auth/login")
        .send({ email: "test@digitalsukoon.com", password: "TestPass123!" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.accessToken).toBeDefined();
      expect(res.body.data.refreshToken).toBeDefined();
      expect(res.body.data.user.email).toBe("test@digitalsukoon.com");
      expect(res.body.data.user.roles).toContain("Employee");
    });

    it("returns 401 for wrong password", async () => {
      await createTestUser({ email: "test@digitalsukoon.com", password: "TestPass123!", roleNames: ["Employee"] });

      const res = await request(app)
        .post("/v1/auth/login")
        .send({ email: "test@digitalsukoon.com", password: "WrongPass!" });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
    });

    it("returns 401 for non-existent user", async () => {
      const res = await request(app)
        .post("/v1/auth/login")
        .send({ email: "nobody@test.com", password: "TestPass123!" });

      expect(res.status).toBe(401);
    });

    it("returns 400 for invalid email format", async () => {
      const res = await request(app)
        .post("/v1/auth/login")
        .send({ email: "not-an-email", password: "TestPass123!" });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("returns 403 for inactive user", async () => {
      const { prisma } = await import("@dashmani/db");
      const user = await createTestUser({ email: "inactive@test.com", password: "TestPass123!", roleNames: ["Employee"] });
      await prisma.user.update({ where: { id: user.id }, data: { status: "INACTIVE" } });

      const res = await request(app)
        .post("/v1/auth/login")
        .send({ email: "inactive@test.com", password: "TestPass123!" });

      expect(res.status).toBe(403);
    });
  });

  describe("POST /v1/auth/refresh", () => {
    it("returns new tokens for valid refresh token", async () => {
      await createTestUser({ email: "test@digitalsukoon.com", password: "TestPass123!", roleNames: ["Employee"] });

      const loginRes = await request(app)
        .post("/v1/auth/login")
        .send({ email: "test@digitalsukoon.com", password: "TestPass123!" });

      const res = await request(app)
        .post("/v1/auth/refresh")
        .send({ refreshToken: loginRes.body.data.refreshToken });

      expect(res.status).toBe(200);
      expect(res.body.data.accessToken).toBeDefined();
      expect(res.body.data.refreshToken).toBeDefined();
    });
  });

  describe("POST /v1/auth/logout", () => {
    it("clears refresh tokens for authenticated user", async () => {
      await createTestUser({ email: "test@digitalsukoon.com", password: "TestPass123!", roleNames: ["Employee"] });

      const loginRes = await request(app)
        .post("/v1/auth/login")
        .send({ email: "test@digitalsukoon.com", password: "TestPass123!" });

      const res = await request(app)
        .post("/v1/auth/logout")
        .set("Authorization", `Bearer ${loginRes.body.data.accessToken}`);

      expect(res.status).toBe(200);
    });

    it("returns 401 without token", async () => {
      const res = await request(app).post("/v1/auth/logout");
      expect(res.status).toBe(401);
    });
  });
  describe("Sign in with Google (invite-only: never creates an account)", () => {
    const GOOGLE = "/v1/auth/google";
    const CLIENT_ID = "123-test.apps.googleusercontent.com";
    const CREDENTIAL = "eyJhbGciOiJSUzI1NiJ9.test-credential-payload-that-is-long-enough.signature";
    const baseClaims = () => ({
      iss: "https://accounts.google.com",
      aud: CLIENT_ID,
      sub: "1029384756",
      email: "Asha@DigitalSukoon.test",
      email_verified: "true",
      name: "Asha Rao",
      exp: String(Math.floor(Date.now() / 1000) + 3600),
    });
    let fetchMock: ReturnType<typeof vi.fn>;
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
      let res = await request(app).get("/v1/auth/google/config");
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ enabled: true, clientId: CLIENT_ID });
      expect(res.headers["cache-control"]).toBe("no-store");
      vi.stubEnv("GOOGLE_CLIENT_ID", "");
      res = await request(app).get("/v1/auth/google/config");
      expect(res.body.data).toEqual({ enabled: false, clientId: null });
    });

    it("is a clean 503 when not configured, and never calls Google", async () => {
      vi.stubEnv("GOOGLE_CLIENT_ID", "");
      const res = await request(app).post(GOOGLE).send({ credential: CREDENTIAL });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("GOOGLE_SIGNIN_DISABLED");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("signs an existing ACTIVE user in by verified email in any casing, with an employee token that works on an internal route", async () => {
      const u = await createTestUser({ email: "asha@digitalsukoon.test", name: "Asha R", roleNames: ["Employee"] });
      const before = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
      googleAnswers(200, baseClaims());
      const res = await request(app).post(GOOGLE).send({ credential: CREDENTIAL });
      expect(res.status).toBe(200);
      expect(res.body.data.user).toMatchObject({ id: u.id, name: "Asha R", roles: ["Employee"] });
      expect(await prisma.user.count()).toBe(1);
      expect(await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).toEqual(before);
      const me = await request(app).post("/v1/auth/logout").set("Authorization", `Bearer ${res.body.data.accessToken}`);
      expect(me.status).toBe(200);
      expect(String(fetchMock.mock.calls[0][0])).toContain("oauth2.googleapis.com/tokeninfo?id_token=");
    });

    it("rememberMe stretches the refresh token to 30 days, the same as password login", async () => {
      await createTestUser({ email: "asha@digitalsukoon.test", roleNames: ["Employee"] });
      googleAnswers(200, baseClaims());
      await request(app).post(GOOGLE).send({ credential: CREDENTIAL, rememberMe: true });
      const row = await prisma.refreshToken.findFirstOrThrow();
      const days = (row.expiresAt.getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(29);
      expect(days).toBeLessThan(31);
    });

    it("NEVER creates an account: an unknown verified email is refused with an honest 403", async () => {
      googleAnswers(200, baseClaims());
      const res = await request(app).post(GOOGLE).send({ credential: CREDENTIAL });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("GOOGLE_NO_ACCOUNT");
      expect(res.body.data).toBeUndefined();
      expect(await prisma.user.count()).toBe(0);
      expect(await prisma.refreshToken.count()).toBe(0);
    });

    it("refuses INACTIVE, ONBOARDING and archived users like password login, without touching them", async () => {
      const u = await createTestUser({ email: "asha@digitalsukoon.test", roleNames: ["Employee"] });
      for (const status of ["INACTIVE", "ONBOARDING"] as const) {
        await prisma.user.update({ where: { id: u.id }, data: { status } });
        googleAnswers(200, baseClaims());
        const res = await request(app).post(GOOGLE).send({ credential: CREDENTIAL });
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe("ACCOUNT_INACTIVE");
        expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).status).toBe(status);
      }
      await prisma.user.update({ where: { id: u.id }, data: { status: "ACTIVE", deletedAt: new Date() } });
      googleAnswers(200, baseClaims());
      const gone = await request(app).post(GOOGLE).send({ credential: CREDENTIAL });
      expect(gone.status).toBe(403);
      expect(gone.body.error.code).toBe("GOOGLE_NO_ACCOUNT");
      expect(await prisma.refreshToken.count()).toBe(0);
    });

    it("a '_' in the Google email cannot match a different user (ILIKE wildcard escaped)", async () => {
      await createTestUser({ email: "axsha@digitalsukoon.test", roleNames: ["Employee"] });
      googleAnswers(200, { ...baseClaims(), email: "a_sha@digitalsukoon.test" });
      const res = await request(app).post(GOOGLE).send({ credential: CREDENTIAL });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("GOOGLE_NO_ACCOUNT");
    });

    it("rejects a token for another audience, an unverified email, an expired one, a foreign issuer, or a Google 400", async () => {
      await createTestUser({ email: "asha@digitalsukoon.test", roleNames: ["Employee"] });
      const cases: Array<Record<string, unknown> | null> = [
        { ...baseClaims(), aud: "someone-else.apps.googleusercontent.com" },
        { ...baseClaims(), email_verified: "false" },
        { ...baseClaims(), exp: String(Math.floor(Date.now() / 1000) - 10) },
        { ...baseClaims(), iss: "https://evil.example" },
        null,
      ];
      for (const claims of cases) {
        if (claims) googleAnswers(200, claims);
        else googleAnswers(400, { error_description: "Invalid Value" });
        const res = await request(app).post(GOOGLE).send({ credential: CREDENTIAL });
        expect(res.status).toBe(401);
      }
      expect(await prisma.refreshToken.count()).toBe(0);
    });

    it("is a 503 when Google cannot be reached", async () => {
      fetchMock.mockRejectedValue(new Error("ECONNRESET"));
      const res = await request(app).post(GOOGLE).send({ credential: CREDENTIAL });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("GOOGLE_UNAVAILABLE");
    });
  });
});
