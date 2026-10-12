/**
 * creator-auth.test.ts — creator portal accounts and sessions (/v1/creator/auth/*).
 *
 * Emails are captured through a mocked email.service (the raw verify / reset tokens exist
 * only in the email — the database keeps their SHA-256). Google's tokeninfo endpoint is a
 * stubbed global fetch. Every test uses fresh email addresses: the login limiter (20 per
 * (ip, account) per 15 min) lives for the whole file.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { prisma } from "@dashmani/db";
import { hash } from "bcrypt";
import "./setup";

vi.mock("../src/services/email.service", async (orig) => {
  const actual = await orig<typeof import("../src/services/email.service")>();
  return { ...actual, sendEmail: vi.fn(async () => ({ messageId: "test" })), notifyAdminByEmail: vi.fn(async () => null) };
});

import app from "../src/app";
import { sendEmail, notifyAdminByEmail } from "../src/services/email.service";
import { hashToken } from "../src/services/creator/creator-jwt";

const sendEmailMock = vi.mocked(sendEmail);
const notifyMock = vi.mocked(notifyAdminByEmail);

let n = 0;
const uniqEmail = (tag = "c") => `${tag}-${Date.now()}-${++n}@creators.test`;

const signupBody = (email: string, extra: Record<string, unknown> = {}) => ({
  name: "Riya Sen",
  email,
  password: "Creator@123",
  country: "in",
  acceptTerms: true,
  confirmAdult: true,
  ...extra,
});

async function seedCreator(over: Partial<{ email: string; password: string; status: string; emailVerifiedAt: Date | null; name: string }> = {}) {
  return prisma.creator.create({
    data: {
      email: over.email ?? uniqEmail("seed"),
      passwordHash: await hash(over.password ?? "Creator@123", 4),
      name: over.name ?? "Seeded Creator",
      status: over.status ?? "draft",
      emailVerifiedAt: over.emailVerifiedAt === undefined ? null : over.emailVerifiedAt,
    },
  });
}

/** The raw token from the newest email whose link contains `path`. */
async function tokenFromEmail(to: string, path: "verify-email" | "reset-password"): Promise<string> {
  let token = "";
  await vi.waitFor(() => {
    const call = [...sendEmailMock.mock.calls].reverse().find((c) => c[0].to === to && c[0].html.includes(`/${path}?token=`));
    expect(call).toBeDefined();
    token = call![0].html.match(new RegExp(`/${path}\\?token=([A-Za-z0-9_-]+)`))![1];
  });
  return token;
}

describe("Creator auth API", () => {
  beforeEach(() => {
    vi.stubEnv("CREATORS_ENABLED", "1");
    sendEmailMock.mockClear();
    notifyMock.mockClear();
  });
  // The suite runs every file in ONE fork: a leaked env or fetch stub breaks other files.
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("answers 503 everywhere while CREATORS_ENABLED is off", async () => {
    vi.stubEnv("CREATORS_ENABLED", "0");
    const email = uniqEmail();
    const res = await request(app).post("/v1/creator/auth/signup").send(signupBody(email));
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("CREATORS_DISABLED");
    expect((await request(app).post("/v1/creator/auth/login").send({ email, password: "x" })).status).toBe(503);
    expect((await request(app).get("/v1/creator/auth/google/config")).status).toBe(503);
    expect(await prisma.creator.count()).toBe(0);
  });

  describe("POST /signup", () => {
    it("creates a draft creator, returns a session, emails a verify link and alerts staff", async () => {
      const email = uniqEmail("new");
      const res = await request(app).post("/v1/creator/auth/signup").send(signupBody(email.toUpperCase()));
      expect(res.status).toBe(201);
      const { accessToken, refreshToken, creator } = res.body.data;
      expect(accessToken).toEqual(expect.any(String));
      expect(refreshToken).toEqual(expect.any(String));
      expect(creator).toMatchObject({ email, name: "Riya Sen", country: "IN", status: "draft", emailVerified: false, termsAccepted: true, reviewNote: null });
      // Never a hash or token column in the payload.
      expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|password_hash|Enc"/);

      const row = await prisma.creator.findUniqueOrThrow({ where: { email } });
      expect(row.termsAcceptedAt).not.toBeNull();
      expect(row.adultConfirmedAt).not.toBeNull();
      expect(row.termsVersion).toBeTruthy();

      const token = await tokenFromEmail(email, "verify-email");
      expect(token.length).toBeGreaterThanOrEqual(40);
      // Only the hash is stored.
      const stored = await prisma.creatorToken.findFirstOrThrow({ where: { creatorId: row.id } });
      expect(stored.purpose).toBe("verify_email");
      expect(stored.tokenHash).toBe(hashToken(token));
      expect(stored.tokenHash).not.toBe(token);
      await vi.waitFor(() => expect(notifyMock).toHaveBeenCalledWith("New creator signed up", expect.any(Array), `/creators/${row.id}`));
    });

    it("is a 409 for an existing email in another casing — and the existing row is untouched", async () => {
      const existing = await seedCreator({ email: uniqEmail("taken"), status: "approved", name: "Original" });
      const before = await prisma.creator.findUniqueOrThrow({ where: { id: existing.id } });
      const res = await request(app)
        .post("/v1/creator/auth/signup")
        .send(signupBody(existing.email.toUpperCase(), { name: "Attacker", password: "Different@123" }));
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("EMAIL_EXISTS");
      const after = await prisma.creator.findUniqueOrThrow({ where: { id: existing.id } });
      expect(after).toEqual(before);
      expect(await prisma.creator.count()).toBe(1);
      expect(await prisma.creatorToken.count()).toBe(0);
    });

    it("treats `_` and `%` in an email literally (no wildcard match onto another account)", async () => {
      await seedCreator({ email: "axb@wild.test" });
      const res = await request(app).post("/v1/creator/auth/signup").send(signupBody("a_b@wild.test"));
      expect(res.status).toBe(201);
    });

    it("requires the terms and the 18+ confirmation", async () => {
      const email = uniqEmail();
      let res = await request(app).post("/v1/creator/auth/signup").send(signupBody(email, { acceptTerms: false }));
      expect(res.status).toBe(400);
      res = await request(app).post("/v1/creator/auth/signup").send(signupBody(email, { confirmAdult: undefined }));
      expect(res.status).toBe(400);
      expect(res.body.error.details.map((d: { field: string }) => d.field)).toContain("confirmAdult");
      expect(await prisma.creator.count()).toBe(0);
    });
  });

  describe("daily creator email cap", () => {
    it("past the cap: sign-up still succeeds without its email, resend is 503 EMAIL_BUSY, forgot sends nothing", async () => {
      vi.stubEnv("CREATOR_EMAIL_DAILY_CAP", "1");
      try {
        const first = uniqEmail("cap1");
        expect((await request(app).post("/v1/creator/auth/signup").send(signupBody(first))).status).toBe(201);
        await tokenFromEmail(first, "verify-email"); // the first one goes out

        sendEmailMock.mockClear();
        const second = uniqEmail("cap2");
        const res = await request(app).post("/v1/creator/auth/signup").send(signupBody(second));
        expect(res.status).toBe(201);
        const c2 = await prisma.creator.findFirstOrThrow({ where: { email: second } });
        expect(await prisma.creatorToken.count({ where: { creatorId: c2.id } })).toBe(0);

        const resend = await request(app)
          .post("/v1/creator/auth/resend-verification")
          .set("Authorization", `Bearer ${res.body.data.accessToken}`);
        expect(resend.status).toBe(503);
        expect(resend.body.error.code).toBe("EMAIL_BUSY");

        expect((await request(app).post("/v1/creator/auth/forgot-password").send({ email: first })).status).toBe(200);
        await new Promise((r) => setTimeout(r, 50));
        expect(sendEmailMock.mock.calls.filter((c) => (c[0] as { to: string }).to === first || (c[0] as { to: string }).to === second)).toHaveLength(0);
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  describe("POST /login", () => {
    it("signs in with the right password, any email casing", async () => {
      const c = await seedCreator();
      const res = await request(app).post("/v1/creator/auth/login").send({ email: c.email.toUpperCase(), password: "Creator@123" });
      expect(res.status).toBe(200);
      expect(res.body.data.creator.id).toBe(c.id);
      expect(await prisma.creatorRefreshToken.count({ where: { creatorId: c.id } })).toBe(1);
    });

    it("is 401 INVALID_CREDENTIALS for an unknown email and for a wrong password", async () => {
      const c = await seedCreator();
      let res = await request(app).post("/v1/creator/auth/login").send({ email: uniqEmail("nobody"), password: "Creator@123" });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
      res = await request(app).post("/v1/creator/auth/login").send({ email: c.email, password: "Wrong@1234" });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
    });

    it("refuses a closed account (only after the right password) with 401 ACCOUNT_CLOSED", async () => {
      const c = await seedCreator({ status: "closed" });
      let res = await request(app).post("/v1/creator/auth/login").send({ email: c.email, password: "Wrong@1234" });
      expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
      res = await request(app).post("/v1/creator/auth/login").send({ email: c.email, password: "Creator@123" });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("ACCOUNT_CLOSED");
    });
  });

  describe("refresh / logout", () => {
    async function login() {
      const c = await seedCreator();
      const res = await request(app).post("/v1/creator/auth/login").send({ email: c.email, password: "Creator@123" });
      return { c, refreshToken: res.body.data.refreshToken as string };
    }

    it("rotates a refresh token exactly once, even when two refreshes race", async () => {
      const { c, refreshToken } = await login();
      const [a, b] = await Promise.all([
        request(app).post("/v1/creator/auth/refresh").send({ refreshToken }),
        request(app).post("/v1/creator/auth/refresh").send({ refreshToken }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 401]);
      const winner = a.status === 200 ? a : b;
      expect(Object.keys(winner.body.data).sort()).toEqual(["accessToken", "refreshToken"]);
      // The old one is gone, the new one is the only one stored.
      expect(await prisma.creatorRefreshToken.count({ where: { creatorId: c.id } })).toBe(1);
      const again = await request(app).post("/v1/creator/auth/refresh").send({ refreshToken });
      expect(again.status).toBe(401);
      expect(again.body.error.code).toBe("INVALID_TOKEN");
      const next = await request(app).post("/v1/creator/auth/refresh").send({ refreshToken: winner.body.data.refreshToken });
      expect(next.status).toBe(200);
    });

    it("rejects a garbage token, and a refresh for a closed account", async () => {
      let res = await request(app).post("/v1/creator/auth/refresh").send({ refreshToken: "x".repeat(40) });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("INVALID_TOKEN");
      const { c, refreshToken } = await login();
      await prisma.creator.update({ where: { id: c.id }, data: { status: "closed" } });
      res = await request(app).post("/v1/creator/auth/refresh").send({ refreshToken });
      expect(res.status).toBe(401);
    });

    it("logout ends that refresh token", async () => {
      const { refreshToken } = await login();
      const out = await request(app).post("/v1/creator/auth/logout").send({ refreshToken });
      expect(out.status).toBe(200);
      expect(out.body.data).toEqual({ loggedOut: true });
      expect((await request(app).post("/v1/creator/auth/refresh").send({ refreshToken })).status).toBe(401);
    });
  });

  describe("forgot / reset password", () => {
    it("is opaque for an unknown email (and sends nothing)", async () => {
      const res = await request(app).post("/v1/creator/auth/forgot-password").send({ email: uniqEmail("ghost") });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ sent: true });
      expect(await prisma.creatorToken.count()).toBe(0);
      expect(sendEmailMock).not.toHaveBeenCalled();
    });

    it("emails a reset link that works once, ends every session, and verifies the email", async () => {
      const c = await seedCreator();
      const login = await request(app).post("/v1/creator/auth/login").send({ email: c.email, password: "Creator@123" });
      const oldRefresh = login.body.data.refreshToken;

      const res = await request(app).post("/v1/creator/auth/forgot-password").send({ email: c.email.toUpperCase() });
      expect(res.body.data).toEqual({ sent: true });
      const token = await tokenFromEmail(c.email, "reset-password");
      const html = sendEmailMock.mock.calls.at(-1)![0].html;
      expect(html).toContain("http://localhost:3005/reset-password?token=");

      const reset = await request(app).post("/v1/creator/auth/reset-password").send({ token, newPassword: "Brand-New@1" });
      expect(reset.status).toBe(200);
      expect(reset.body.data).toEqual({ reset: true });

      // Single use.
      const twice = await request(app).post("/v1/creator/auth/reset-password").send({ token, newPassword: "Another@123" });
      expect(twice.status).toBe(400);
      expect(twice.body.error.code).toBe("INVALID_TOKEN");

      // Every refresh token is gone; the new password works, the old one does not.
      expect((await request(app).post("/v1/creator/auth/refresh").send({ refreshToken: oldRefresh })).status).toBe(401);
      expect((await request(app).post("/v1/creator/auth/login").send({ email: c.email, password: "Creator@123" })).status).toBe(401);
      expect((await request(app).post("/v1/creator/auth/login").send({ email: c.email, password: "Brand-New@1" })).status).toBe(200);
      expect((await prisma.creator.findUniqueOrThrow({ where: { id: c.id } })).emailVerifiedAt).not.toBeNull();
    });

    it("refuses an expired link, and only the newest link works", async () => {
      const c = await seedCreator();
      await request(app).post("/v1/creator/auth/forgot-password").send({ email: c.email });
      const first = await tokenFromEmail(c.email, "reset-password");
      sendEmailMock.mockClear();
      await request(app).post("/v1/creator/auth/forgot-password").send({ email: c.email });
      const second = await tokenFromEmail(c.email, "reset-password");
      expect(second).not.toBe(first);
      expect((await request(app).post("/v1/creator/auth/reset-password").send({ token: first, newPassword: "Brand-New@1" })).status).toBe(400);

      await prisma.creatorToken.updateMany({ where: { tokenHash: hashToken(second) }, data: { expiresAt: new Date(Date.now() - 1000) } });
      expect((await request(app).post("/v1/creator/auth/reset-password").send({ token: second, newPassword: "Brand-New@1" })).status).toBe(400);
    });

    it("does not let a verify-email token reset a password", async () => {
      const email = uniqEmail();
      await request(app).post("/v1/creator/auth/signup").send(signupBody(email));
      const verify = await tokenFromEmail(email, "verify-email");
      const res = await request(app).post("/v1/creator/auth/reset-password").send({ token: verify, newPassword: "Brand-New@1" });
      expect(res.status).toBe(400);
    });
  });

  describe("email verification", () => {
    it("verifies once; a repeat of the used link still reads verified; an unknown link is 400", async () => {
      const email = uniqEmail();
      const signup = await request(app).post("/v1/creator/auth/signup").send(signupBody(email));
      const token = await tokenFromEmail(email, "verify-email");

      const res = await request(app).post("/v1/creator/auth/verify-email").send({ token });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ verified: true });
      const row = await prisma.creator.findUniqueOrThrow({ where: { email } });
      expect(row.emailVerifiedAt).not.toBeNull();
      const tok = await prisma.creatorToken.findFirstOrThrow({ where: { creatorId: row.id } });
      expect(tok.usedAt).not.toBeNull();

      const repeat = await request(app).post("/v1/creator/auth/verify-email").send({ token });
      expect(repeat.status).toBe(200);
      // The repeat does not move the verified timestamp.
      expect((await prisma.creator.findUniqueOrThrow({ where: { email } })).emailVerifiedAt).toEqual(row.emailVerifiedAt);

      const bad = await request(app).post("/v1/creator/auth/verify-email").send({ token: "A".repeat(43) });
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe("INVALID_TOKEN");

      const me = await request(app).get("/v1/creator/me").set("Authorization", `Bearer ${signup.body.data.accessToken}`);
      expect(me.body.data.emailVerified).toBe(true);
    });

    it("a superseded or expired link does not verify", async () => {
      const email = uniqEmail();
      await request(app).post("/v1/creator/auth/signup").send(signupBody(email));
      const token = await tokenFromEmail(email, "verify-email");
      await prisma.creatorToken.updateMany({ where: { tokenHash: hashToken(token) }, data: { expiresAt: new Date(Date.now() - 1000) } });
      const res = await request(app).post("/v1/creator/auth/verify-email").send({ token });
      expect(res.status).toBe(400);
      expect((await prisma.creator.findUniqueOrThrow({ where: { email } })).emailVerifiedAt).toBeNull();
    });

    it("resend: at most once per 2 minutes, then a fresh link; nothing to send once verified", async () => {
      const email = uniqEmail();
      const signup = await request(app).post("/v1/creator/auth/signup").send(signupBody(email));
      const auth = `Bearer ${signup.body.data.accessToken}`;
      const first = await tokenFromEmail(email, "verify-email");

      const tooSoon = await request(app).post("/v1/creator/auth/resend-verification").set("Authorization", auth);
      expect(tooSoon.status).toBe(429);
      expect(tooSoon.body.error.code).toBe("TOO_SOON");

      // Age the signup link past the cooldown.
      await prisma.creatorToken.updateMany({ where: { tokenHash: hashToken(first) }, data: { createdAt: new Date(Date.now() - 3 * 60 * 1000) } });
      sendEmailMock.mockClear();
      const ok = await request(app).post("/v1/creator/auth/resend-verification").set("Authorization", auth);
      expect(ok.status).toBe(200);
      expect(ok.body.data).toEqual({ sent: true });
      const second = await tokenFromEmail(email, "verify-email");
      expect(second).not.toBe(first);
      // The older link is retired, the new one verifies.
      expect((await request(app).post("/v1/creator/auth/verify-email").send({ token: first })).status).toBe(400);
      expect((await request(app).post("/v1/creator/auth/verify-email").send({ token: second })).status).toBe(200);

      const done = await request(app).post("/v1/creator/auth/resend-verification").set("Authorization", auth);
      expect(done.status).toBe(200);
      expect(done.body.data).toEqual({ sent: false, alreadyVerified: true });

      expect((await request(app).post("/v1/creator/auth/resend-verification")).status).toBe(401);
    });
  });

  describe("Continue with Google", () => {
    const CLIENT_ID = "123-test.apps.googleusercontent.com";
    const CREDENTIAL = "eyJhbGciOiJSUzI1NiJ9.creator-credential-payload-long-enough.signature";
    let fetchMock: ReturnType<typeof vi.fn>;
    const claims = (email: string, over: Record<string, unknown> = {}) => ({
      iss: "https://accounts.google.com",
      aud: CLIENT_ID,
      sub: `sub-${email}`,
      email,
      email_verified: "true",
      name: "Kabir <b>Rao</b>",
      exp: String(Math.floor(Date.now() / 1000) + 3600),
      ...over,
    });
    const googleAnswers = (status: number, body: Record<string, unknown>) =>
      fetchMock.mockResolvedValue({ ok: status < 400, status, json: async () => body });

    beforeEach(() => {
      vi.stubEnv("GOOGLE_CLIENT_ID", CLIENT_ID);
      fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
    });

    it("serves the config without caching, and enabled=false when unset", async () => {
      let res = await request(app).get("/v1/creator/auth/google/config");
      expect(res.body.data).toEqual({ enabled: true, clientId: CLIENT_ID });
      expect(res.headers["cache-control"]).toBe("no-store");
      vi.stubEnv("GOOGLE_CLIENT_ID", "");
      res = await request(app).get("/v1/creator/auth/google/config");
      expect(res.body.data).toEqual({ enabled: false, clientId: null });
    });

    it("signs an existing creator in (any casing) and marks the email verified", async () => {
      const c = await seedCreator();
      googleAnswers(200, claims(c.email.toUpperCase()));
      const res = await request(app).post("/v1/creator/auth/google").send({ credential: CREDENTIAL });
      expect(res.status).toBe(200);
      expect(res.body.data.creator.id).toBe(c.id);
      expect(res.body.data.creator.emailVerified).toBe(true);
      expect(String(fetchMock.mock.calls[0][0])).toContain("oauth2.googleapis.com/tokeninfo?id_token=");
      expect(await prisma.creator.count()).toBe(1);
    });

    it("unknown email: needsProfile and NOTHING written; the second call creates a verified creator", async () => {
      const email = uniqEmail("google");
      googleAnswers(200, claims(email));
      const first = await request(app).post("/v1/creator/auth/google").send({ credential: CREDENTIAL });
      expect(first.status).toBe(200);
      expect(first.body.data).toEqual({ needsProfile: true, email, name: "Kabir Rao" });
      expect(await prisma.creator.count()).toBe(0);

      // Only one confirmation → still needsProfile.
      const half = await request(app).post("/v1/creator/auth/google").send({ credential: CREDENTIAL, acceptTerms: true });
      expect(half.body.data.needsProfile).toBe(true);
      expect(await prisma.creator.count()).toBe(0);

      const second = await request(app)
        .post("/v1/creator/auth/google")
        .send({ credential: CREDENTIAL, acceptTerms: true, confirmAdult: true, country: "ae" });
      expect(second.status).toBe(201);
      expect(second.body.data.creator).toMatchObject({ email, name: "Kabir Rao", country: "AE", emailVerified: true, termsAccepted: true, status: "draft" });
      const row = await prisma.creator.findUniqueOrThrow({ where: { email } });
      expect(row.adultConfirmedAt).not.toBeNull();
      // Unusable random password: password login is refused.
      expect((await request(app).post("/v1/creator/auth/login").send({ email, password: "Creator@123" })).status).toBe(401);
      await vi.waitFor(() => expect(notifyMock).toHaveBeenCalledWith("New creator signed up", expect.any(Array), `/creators/${row.id}`));

      // A later Google sign-in is a plain sign-in.
      const again = await request(app).post("/v1/creator/auth/google").send({ credential: CREDENTIAL });
      expect(again.status).toBe(200);
      expect(await prisma.creator.count()).toBe(1);
    });

    it("⚠️ pre-account hijack: Google on an UNVERIFIED account ends the pre-registrant's password, sessions and pending links", async () => {
      // Someone signs up with the owner's address and a password of their own, and keeps a session.
      const email = uniqEmail("prereg");
      const squat = await request(app).post("/v1/creator/auth/signup").send(signupBody(email, { password: "Squatter@123" }));
      expect(squat.status).toBe(201);
      const squatRefresh = squat.body.data.refreshToken as string;
      const c = await prisma.creator.findFirstOrThrow({ where: { email } });

      // The real owner then uses Google.
      googleAnswers(200, claims(email));
      const owner = await request(app).post("/v1/creator/auth/google").send({ credential: CREDENTIAL });
      expect(owner.status).toBe(200);
      expect(owner.body.data.creator.id).toBe(c.id);
      expect(owner.body.data.creator.emailVerified).toBe(true);

      // The squatter's password no longer works, their refresh token is dead, their emailed link is spent…
      const login = await request(app).post("/v1/creator/auth/login").send({ email, password: "Squatter@123" });
      expect(login.status).toBe(401);
      const refresh = await request(app).post("/v1/creator/auth/refresh").send({ refreshToken: squatRefresh });
      expect(refresh.status).toBe(401);
      expect(await prisma.creatorToken.count({ where: { creatorId: c.id, usedAt: null } })).toBe(0);
      // …while the owner's own new session works.
      const ownerRefresh = await request(app).post("/v1/creator/auth/refresh").send({ refreshToken: owner.body.data.refreshToken });
      expect(ownerRefresh.status).toBe(200);

      // A VERIFIED account signing in with Google keeps its password and other sessions.
      const verified = await seedCreator({ emailVerifiedAt: new Date() });
      const keep = await request(app).post("/v1/creator/auth/login").send({ email: verified.email, password: "Creator@123" });
      googleAnswers(200, claims(verified.email));
      expect((await request(app).post("/v1/creator/auth/google").send({ credential: CREDENTIAL })).status).toBe(200);
      expect((await request(app).post("/v1/creator/auth/login").send({ email: verified.email, password: "Creator@123" })).status).toBe(200);
      expect((await request(app).post("/v1/creator/auth/refresh").send({ refreshToken: keep.body.data.refreshToken })).status).toBe(200);
    });

    it("refuses a closed account, a token for another app, and an unverified email", async () => {
      const c = await seedCreator({ status: "closed" });
      googleAnswers(200, claims(c.email));
      let res = await request(app).post("/v1/creator/auth/google").send({ credential: CREDENTIAL });
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("ACCOUNT_CLOSED");

      googleAnswers(200, claims(uniqEmail(), { aud: "someone-else.apps.googleusercontent.com" }));
      res = await request(app).post("/v1/creator/auth/google").send({ credential: CREDENTIAL, acceptTerms: true, confirmAdult: true });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("GOOGLE_INVALID");

      googleAnswers(200, claims(uniqEmail(), { email_verified: "false" }));
      res = await request(app).post("/v1/creator/auth/google").send({ credential: CREDENTIAL, acceptTerms: true, confirmAdult: true });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("GOOGLE_INVALID");
      expect(await prisma.creator.count()).toBe(1);
    });
  });
});
