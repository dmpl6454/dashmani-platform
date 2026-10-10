import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import app from "../src/app";
import { createTestUser, createTestRole } from "./helpers";
import { prisma } from "@dashmani/db";
import "./setup";

describe("HR Auth API", () => {
  beforeEach(async () => {
    await createTestRole("Employee", [
      { resource: "employees", action: "view", scope: "own" },
    ]);
  });

  // ── P0 (2026-09-26 pipeline spec §10): self-registration must never take over, promote
  // or overwrite an existing account. Before this fix, registering with the email or phone
  // of an admin-created ONBOARDING hire promoted that row to ACTIVE with the registrant's
  // password and replaced its roles — anyone who knew a pending hire's email could claim
  // the account. Owner decision: new sign-ups stay instant (ACTIVE); only the takeover
  // path closes.
  describe("POST /v1/hr/auth/register", () => {
    const REGISTER = "/v1/hr/auth/register";

    /** Everything registration could touch for one user, for byte-for-byte comparison. */
    async function snapshotAccount(userId: string) {
      const row = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      const roles = await prisma.userRole.findMany({
        where: { userId },
        orderBy: { roleId: "asc" },
      });
      const profile = await prisma.employeeProfile.findUnique({ where: { userId } });
      const refreshTokens = await prisma.refreshToken.count({ where: { userId } });
      return { row, roles, profile, refreshTokens };
    }

    /** An admin-created pending hire. createTestUser has no status option. */
    async function createPendingHire(overrides: { email: string; phone?: string }) {
      const u = await createTestUser({
        email: overrides.email,
        name: "Pending Hire",
        password: "OriginalPass123!",
        roleNames: ["Employee"],
      });
      return prisma.user.update({
        where: { id: u.id },
        data: { status: "ONBOARDING", ...(overrides.phone ? { phone: overrides.phone } : {}) },
      });
    }

    it("refuses an existing ONBOARDING email with 409 and leaves the row, roles and hash untouched", async () => {
      const hire = await createPendingHire({ email: "pending@test.com" });
      const before = await snapshotAccount(hire.id);

      const res = await request(app).post(REGISTER).send({
        name: "Someone Else",
        email: "pending@test.com",
        password: "AttackerPass123!",
      });

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe("ALREADY_EXISTS");

      const after = await snapshotAccount(hire.id);
      expect(after).toEqual(before);
      expect(after.row.status).toBe("ONBOARDING");
      expect(after.row.passwordHash).toBe(before.row.passwordHash);
      expect(after.row.name).toBe("Pending Hire");
      expect(await prisma.user.count()).toBe(1);
    });

    it("refuses an existing ONBOARDING phone (different email) with 409 and leaves the row untouched", async () => {
      const hire = await createPendingHire({ email: "pending.phone@test.com", phone: "+919800000001" });
      const before = await snapshotAccount(hire.id);

      const res = await request(app).post(REGISTER).send({
        name: "Someone Else",
        email: "different@test.com",
        phone: "+919800000001",
        password: "AttackerPass123!",
      });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("ALREADY_EXISTS");
      expect(await snapshotAccount(hire.id)).toEqual(before);
      expect(await prisma.user.count()).toBe(1);
    });

    it("refuses an ONBOARDING email stored in mixed case (case-insensitive match, no duplicate row)", async () => {
      // A row written before the 2026-05-21 email normalisation, or by any path that
      // skipped it. Postgres' unique index is case-SENSITIVE, so an exact-match lookup
      // would miss this row and create a second account under the same address.
      const row = await prisma.user.create({
        data: {
          name: "Legacy Pending",
          email: "Legacy.Pending@Test.com",
          passwordHash: "legacy-hash",
          status: "ONBOARDING",
        },
      });
      const before = await snapshotAccount(row.id);

      const res = await request(app).post(REGISTER).send({
        name: "Someone Else",
        email: "legacy.pending@test.com",
        password: "AttackerPass123!",
      });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("ALREADY_EXISTS");
      expect(await snapshotAccount(row.id)).toEqual(before);
      expect(await prisma.user.count()).toBe(1);
    });

    it.each(["ACTIVE", "INACTIVE"] as const)(
      "refuses an existing %s account with 409, as before",
      async (status) => {
        const u = await createTestUser({ email: `taken-${status.toLowerCase()}@test.com`, roleNames: ["Employee"] });
        if (status !== "ACTIVE") await prisma.user.update({ where: { id: u.id }, data: { status } });
        const before = await snapshotAccount(u.id);

        const res = await request(app).post(REGISTER).send({
          name: "Someone Else",
          email: `taken-${status.toLowerCase()}@test.com`,
          password: "AttackerPass123!",
        });

        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe("ALREADY_EXISTS");
        expect(await snapshotAccount(u.id)).toEqual(before);
      },
    );

    it("creates a brand-new account as ACTIVE with the Employee role, and it can log in", async () => {
      const res = await request(app).post(REGISTER).send({
        name: "New Starter",
        email: "New.Starter@Test.com",
        phone: "+919800000002",
        password: "StarterPass123!",
      });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.user.status).toBe("ACTIVE");
      expect(res.body.data.user.email).toBe("new.starter@test.com");

      const row = await prisma.user.findUniqueOrThrow({
        where: { email: "new.starter@test.com" },
        include: { roles: { include: { role: true } }, profile: true },
      });
      expect(row.status).toBe("ACTIVE");
      expect(row.roles.map((r) => r.role.name)).toEqual(["Employee"]);
      expect(row.profile).not.toBeNull();

      const login = await request(app)
        .post("/v1/hr/auth/login")
        .send({ identifier: "new.starter@test.com", password: "StarterPass123!" });
      expect(login.status).toBe(200);
      expect(login.body.data.accessToken).toBeDefined();
      expect(login.body.data.user.roles).toEqual(["Employee"]);
    });

    it("strips HTML from the name and bounds it to 120 characters", async () => {
      const ok = await request(app).post(REGISTER).send({
        name: "<b>Tagged</b> Name",
        email: "tagged@test.com",
        password: "TaggedPass123!",
      });
      expect(ok.status).toBe(201);
      expect(ok.body.data.user.name).toBe("Tagged Name");

      const tooLong = await request(app).post(REGISTER).send({
        name: "a".repeat(121),
        email: "toolong@test.com",
        password: "TooLongPass123!",
      });
      expect(tooLong.status).toBe(400);
      expect(tooLong.body.error.code).toBe("VALIDATION_ERROR");

      const onlyTags = await request(app).post(REGISTER).send({
        name: "<><>",
        email: "onlytags@test.com",
        password: "OnlyTagsPass123!",
      });
      expect(onlyTags.status).toBe(400);
      expect(await prisma.user.count()).toBe(1);
    });

    it("rejects a 1 MB name of '<' characters with 400 in under 50 ms", async () => {
      // Warm the route once so the timing below measures the request, not first-call setup.
      await request(app).post(REGISTER).send({ name: "x", email: "warm@test.com", password: "WarmPass123!" });

      const name = "<".repeat(1024 * 1024);
      const t0 = performance.now();
      const res = await request(app).post(REGISTER).send({
        name,
        email: "huge@test.com",
        password: "HugeNamePass123!",
      });
      const elapsed = performance.now() - t0;

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      expect(elapsed).toBeLessThan(50);
      expect(await prisma.user.count()).toBe(0);
    });

    it("gives the loser of two concurrent registrations for one email a clean 409, never a 500", async () => {
      const body = { name: "Double Click", email: "double@test.com", password: "DoublePass123!" };
      const [a, b] = await Promise.all([
        request(app).post(REGISTER).send(body),
        request(app).post(REGISTER).send(body),
      ]);

      expect([a.status, b.status].sort()).toEqual([201, 409]);
      const loser = a.status === 409 ? a : b;
      expect(loser.body.error.code).toBe("ALREADY_EXISTS");
      expect(await prisma.user.count({ where: { email: "double@test.com" } })).toBe(1);
    });

    // Prisma sends `equals` + `mode: "insensitive"` as `ILIKE $1` WITHOUT escaping, so an
    // unescaped '_' in the registrant's email matches ANY character of a stored address.
    // That made register a public enumeration oracle (probe `a_b@…`, `___@…` and read the
    // 409s) and refused real addresses that only resemble an existing one. zod's email
    // regex admits '_' in the local part ('%' and '\' are rejected), so '_' is the live case.
    it("treats '_' in a registrant's email literally, not as a LIKE wildcard", async () => {
      await createTestUser({ email: "axb@test.com", roleNames: ["Employee"] });

      const underscore = await request(app).post(REGISTER).send({
        name: "Real Underscore",
        email: "a_b@test.com",
        password: "UnderscorePass123!",
      });
      expect(underscore.status).toBe(201);

      const allWildcards = await request(app).post(REGISTER).send({
        name: "All Wildcards",
        email: "___@test.com",
        password: "WildcardPass123!",
      });
      expect(allWildcards.status).toBe(201);

      expect(await prisma.user.count()).toBe(3);
    });

    it("still refuses a stored email that contains a literal '_', case-insensitively", async () => {
      const row = await prisma.user.create({
        data: {
          name: "Legacy Underscore",
          email: "Real_Name@Test.com",
          passwordHash: "legacy-hash",
          status: "ONBOARDING",
        },
      });
      const before = await snapshotAccount(row.id);

      const res = await request(app).post(REGISTER).send({
        name: "Someone Else",
        email: "real_name@test.com",
        password: "AttackerPass123!",
      });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("ALREADY_EXISTS");
      expect(await snapshotAccount(row.id)).toEqual(before);
      expect(await prisma.user.count()).toBe(1);
    });

    // ⚠️ Every register field is length-bounded BEFORE trim/lowercase/regex or any DB use.
    // Without it: a >2.7 KB email reached `user.create`, failed the unique btree with
    // Postgres 54000 and surfaced as a generic 500 (after a full bcrypt); a multi-MB email
    // made the case-insensitive ILIKE lowercase the whole pattern once per users row while
    // holding a pool connection; and an unbounded phone was stored verbatim.
    it("rejects an over-long email, phone or password with 400 and creates nothing", async () => {
      const cases: Array<{ label: string; body: Record<string, string> }> = [
        { label: "255-char email", body: { email: `${"e".repeat(255 - "@test.com".length)}@test.com` } },
        { label: "3000-char email", body: { email: `${"e".repeat(3000)}@test.com` } },
        { label: "21-char phone", body: { phone: "9".repeat(21) } },
        { label: "200k-char phone", body: { phone: "9".repeat(200_000) } },
        { label: "129-char password", body: { password: "p".repeat(129) } },
      ];

      for (const c of cases) {
        const res = await request(app).post(REGISTER).send({
          name: "Bounded Field",
          email: "bounded@test.com",
          password: "BoundedPass123!",
          ...c.body,
        });
        expect(res.status, c.label).toBe(400);
        expect(res.body.error.code, c.label).toBe("VALIDATION_ERROR");
      }
      expect(await prisma.user.count()).toBe(0);
    });

    it("rejects a 9 MB email with 400 quickly, before any database work", async () => {
      const email = `${"e".repeat(9 * 1024 * 1024)}@test.com`;
      const t0 = performance.now();
      const res = await request(app).post(REGISTER).send({
        name: "Huge Email",
        email,
        password: "HugeEmailPass123!",
      });
      const elapsed = performance.now() - t0;

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
      // Generous: this bounds serialisation + body parsing, not the old failure mode, which
      // on prod-sized tables was a >10 s ILIKE holding a pool connection.
      expect(elapsed).toBeLessThan(2000);
      expect(await prisma.user.count()).toBe(0);
    });

    it("accepts fields exactly at their bounds (254-char email, 20-char phone, 128-char password)", async () => {
      const email = `${"e".repeat(254 - "@test.com".length)}@test.com`;
      expect(email.length).toBe(254);
      const password = `Aa1!${"p".repeat(124)}`;
      expect(password.length).toBe(128);

      const res = await request(app).post(REGISTER).send({
        name: "At The Bound",
        email,
        phone: "+91 98000 00003 0000",
        password,
      });
      expect(res.status).toBe(201);

      const login = await request(app).post("/v1/hr/auth/login").send({ identifier: email, password });
      expect(login.status).toBe(200);
    });
  });

  describe("POST /v1/hr/auth/request-otp", () => {
    it("sends OTP for valid email", async () => {
      await createTestUser({ email: "hr@digitalsukoon.com", roleNames: ["Employee"] });

      const res = await request(app)
        .post("/v1/hr/auth/request-otp")
        .send({ identifier: "hr@digitalsukoon.com", channel: "EMAIL" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.message).toMatch(/OTP sent/i);
    });

    it("sends OTP for valid phone", async () => {
      await prisma.user.create({
        data: {
          name: "Phone User",
          email: "phoneuser@digitalsukoon.com",
          passwordHash: "not-used",
          phone: "+919876543210",
          status: "ACTIVE",
        },
      });

      const res = await request(app)
        .post("/v1/hr/auth/request-otp")
        .send({ identifier: "+919876543210", channel: "SMS" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it("returns 404 for unknown identifier", async () => {
      const res = await request(app)
        .post("/v1/hr/auth/request-otp")
        .send({ identifier: "nobody@unknown.com", channel: "EMAIL" });

      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe("USER_NOT_FOUND");
    });

    it("returns 400 for missing channel", async () => {
      const res = await request(app)
        .post("/v1/hr/auth/request-otp")
        .send({ identifier: "hr@digitalsukoon.com" });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("POST /v1/hr/auth/verify-otp", () => {
    it("returns tokens for correct OTP", async () => {
      const user = await createTestUser({
        email: "verify@digitalsukoon.com",
        roleNames: ["Employee"],
      });

      // Plant an OTP directly
      await prisma.otpToken.create({
        data: {
          userId: user.id,
          otp: "123456",
          channel: "EMAIL",
          target: "verify@digitalsukoon.com",
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        },
      });

      const res = await request(app)
        .post("/v1/hr/auth/verify-otp")
        .send({ identifier: "verify@digitalsukoon.com", otp: "123456" });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.accessToken).toBeDefined();
      expect(res.body.data.refreshToken).toBeDefined();
      expect(res.body.data.user.email).toBe("verify@digitalsukoon.com");
    });

    it("rejects invalid OTP", async () => {
      await createTestUser({
        email: "verify2@digitalsukoon.com",
        roleNames: ["Employee"],
      });

      const res = await request(app)
        .post("/v1/hr/auth/verify-otp")
        .send({ identifier: "verify2@digitalsukoon.com", otp: "000000" });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("INVALID_OTP");
    });

    it("rejects expired OTP", async () => {
      const user = await createTestUser({
        email: "verify3@digitalsukoon.com",
        roleNames: ["Employee"],
      });

      await prisma.otpToken.create({
        data: {
          userId: user.id,
          otp: "654321",
          channel: "EMAIL",
          target: "verify3@digitalsukoon.com",
          expiresAt: new Date(Date.now() - 1000), // already expired
        },
      });

      const res = await request(app)
        .post("/v1/hr/auth/verify-otp")
        .send({ identifier: "verify3@digitalsukoon.com", otp: "654321" });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("INVALID_OTP");
    });
  });

  describe("POST /v1/hr/auth/refresh", () => {
    it("returns new tokens for valid refresh token", async () => {
      const user = await createTestUser({
        email: "refresh@digitalsukoon.com",
        roleNames: ["Employee"],
      });

      // Get tokens via OTP flow
      await prisma.otpToken.create({
        data: {
          userId: user.id,
          otp: "111111",
          channel: "EMAIL",
          target: "refresh@digitalsukoon.com",
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        },
      });

      const verifyRes = await request(app)
        .post("/v1/hr/auth/verify-otp")
        .send({ identifier: "refresh@digitalsukoon.com", otp: "111111" });

      expect(verifyRes.status).toBe(200);
      const { refreshToken } = verifyRes.body.data;

      const res = await request(app)
        .post("/v1/hr/auth/refresh")
        .send({ refreshToken });

      expect(res.status).toBe(200);
      expect(res.body.data.accessToken).toBeDefined();
      expect(res.body.data.refreshToken).toBeDefined();
    });

    it("returns 401 for invalid refresh token", async () => {
      const res = await request(app)
        .post("/v1/hr/auth/refresh")
        .send({ refreshToken: "invalid.token.value" });

      expect(res.status).toBe(401);
    });

    it("returns 400 for missing refresh token", async () => {
      const res = await request(app)
        .post("/v1/hr/auth/refresh")
        .send({});

      expect(res.status).toBe(400);
    });
  });
  describe("Sign in with Google", () => {
    const GOOGLE = "/v1/hr/auth/google";
    const CLIENT_ID = "123-test.apps.googleusercontent.com";
    const CREDENTIAL = "eyJhbGciOiJSUzI1NiJ9.test-credential-payload-that-is-long-enough.signature";
    const baseClaims = () => ({
      iss: "https://accounts.google.com",
      aud: CLIENT_ID,
      sub: "1029384756",
      email: "Priya@DigitalSukoon.test",
      email_verified: "true",
      name: "Priya Nair",
      given_name: "Priya",
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
      let res = await request(app).get("/v1/hr/auth/google/config");
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ enabled: true, clientId: CLIENT_ID });
      expect(res.headers["cache-control"]).toBe("no-store");
      vi.stubEnv("GOOGLE_CLIENT_ID", "");
      res = await request(app).get("/v1/hr/auth/google/config");
      expect(res.body.data).toEqual({ enabled: false, clientId: null });
    });

    it("is a clean 503 when not configured, and never calls Google", async () => {
      vi.stubEnv("GOOGLE_CLIENT_ID", "");
      const res = await request(app).post(GOOGLE).send({ credential: CREDENTIAL });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("GOOGLE_SIGNIN_DISABLED");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("signs an existing ACTIVE user in by verified email, in any casing, with an hr token and no new row", async () => {
      const existing = await createTestUser({ email: "priya@digitalsukoon.test", name: "Priya N", roleNames: ["Employee"] });
      const before = await prisma.user.findUniqueOrThrow({ where: { id: existing.id } });
      googleAnswers(200, baseClaims());
      const res = await request(app).post(GOOGLE).send({ credential: CREDENTIAL });
      expect(res.status).toBe(200);
      expect(res.body.data.created).toBe(false);
      expect(res.body.data.user).toMatchObject({ id: existing.id, name: "Priya N", roles: ["Employee"] });
      expect(await prisma.user.count()).toBe(1);
      // The row is untouched: Google sign-in never renames or re-passwords an account.
      expect(await prisma.user.findUniqueOrThrow({ where: { id: existing.id } })).toEqual(before);
      // The session works on an HR-gated route.
      const me = await request(app).get("/v1/hr/profile").set("Authorization", `Bearer ${res.body.data.accessToken}`);
      expect(me.status).toBe(200);
      expect(String(fetchMock.mock.calls[0][0])).toContain("oauth2.googleapis.com/tokeninfo?id_token=");
    });

    it("creates an ACTIVE Employee for an unknown email, with an unusable password and a profile", async () => {
      googleAnswers(200, baseClaims());
      const res = await request(app).post(GOOGLE).send({ credential: CREDENTIAL });
      expect(res.status).toBe(200);
      expect(res.body.data.created).toBe(true);
      expect(res.body.data.user).toMatchObject({ name: "Priya Nair", email: "priya@digitalsukoon.test", roles: ["Employee"] });
      const row = await prisma.user.findUnique({ where: { email: "priya@digitalsukoon.test" } });
      expect(row?.status).toBe("ACTIVE");
      expect(await prisma.employeeProfile.count({ where: { userId: row!.id } })).toBe(1);
      // Password login cannot guess its way in.
      const pw = await request(app).post("/v1/hr/auth/login").send({ identifier: "priya@digitalsukoon.test", password: "anything-at-all" });
      expect(pw.status).toBe(401);
      // A second Google sign-in is a plain sign-in, not a second account.
      googleAnswers(200, baseClaims());
      const again = await request(app).post(GOOGLE).send({ credential: CREDENTIAL });
      expect(again.status).toBe(200);
      expect(again.body.data.created).toBe(false);
      expect(await prisma.user.count()).toBe(1);
    });

    it("refuses an ONBOARDING or INACTIVE account like password login, without touching it", async () => {
      const u = await createTestUser({ email: "priya@digitalsukoon.test", roleNames: ["Employee"] });
      await prisma.user.update({ where: { id: u.id }, data: { status: "ONBOARDING" } });
      googleAnswers(200, baseClaims());
      let res = await request(app).post(GOOGLE).send({ credential: CREDENTIAL });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("PENDING_APPROVAL");
      expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).status).toBe("ONBOARDING");

      await prisma.user.update({ where: { id: u.id }, data: { status: "INACTIVE" } });
      googleAnswers(200, baseClaims());
      res = await request(app).post(GOOGLE).send({ credential: CREDENTIAL });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("ACCOUNT_INACTIVE");
      expect(await prisma.user.count()).toBe(1);
    });

    it("rejects a token for another audience, an unverified email, an expired one, a foreign issuer, or a Google 400 — and writes nothing", async () => {
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
      expect(await prisma.user.count()).toBe(0);
    });

    it("is a 503 when Google cannot be reached", async () => {
      fetchMock.mockRejectedValue(new Error("ECONNRESET"));
      const res = await request(app).post(GOOGLE).send({ credential: CREDENTIAL });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("GOOGLE_UNAVAILABLE");
    });
  });
});
