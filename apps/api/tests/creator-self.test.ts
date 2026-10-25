/**
 * creator-self.test.ts — a signed-in creator's own account (/v1/creator/me*), and the token
 * isolation between the creator portal and every other portal.
 *
 * Connections and pages are seeded straight into the database (the Meta connect flow has its
 * own tests); nothing here calls Meta.
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
import { notifyAdminByEmail } from "../src/services/email.service";
import { createTestUser, generateToken, generateClientToken, generateHrToken, generateCreatorToken } from "./helpers";

const notifyMock = vi.mocked(notifyAdminByEmail);
let n = 0;

async function seedCreator(over: Partial<{ status: string; verified: boolean; reviewNote: string }> = {}) {
  const email = `self-${Date.now()}-${++n}@creators.test`;
  const c = await prisma.creator.create({
    data: {
      email,
      passwordHash: await hash("Creator@123", 4),
      name: "Asha Iyer",
      country: "IN",
      phone: "+91 98100 00000",
      status: over.status ?? "draft",
      emailVerifiedAt: over.verified === false ? null : new Date(),
      termsAcceptedAt: new Date(),
      reviewNote: over.reviewNote ?? null,
    },
  });
  return { c, auth: `Bearer ${generateCreatorToken(c.id, c.email)}` };
}

async function seedConnection(creatorId: string) {
  return prisma.creatorConnection.create({
    data: {
      creatorId,
      metaUserId: `meta-${Date.now()}-${++n}`,
      metaUserName: "Asha",
      userTokenEnc: "enc:v1:secret-user-token",
      grantedScopes: "pages_show_list,pages_manage_posts",
    },
  });
}

async function seedAsset(
  creatorId: string,
  connectionId: string,
  over: Partial<{ canPublish: boolean; networkDuplicateOf: string | null; disconnectedAt: Date | null; enabled: boolean }> = {},
) {
  return prisma.creatorAsset.create({
    data: {
      creatorId,
      connectionId,
      kind: "facebook_page",
      metaId: `page-${Date.now()}-${++n}`,
      name: "Asha Eats",
      pageTokenEnc: "enc:v1:secret-page-token",
      canPublish: over.canPublish ?? true,
      networkDuplicateOf: over.networkDuplicateOf ?? null,
      disconnectedAt: over.disconnectedAt ?? null,
      enabled: over.enabled ?? false,
    },
  });
}

describe("Creator self API", () => {
  beforeEach(() => {
    vi.stubEnv("CREATORS_ENABLED", "1");
    notifyMock.mockClear();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  describe("GET /me", () => {
    it("returns CreatorMe with the onboarding checklist, and never a secret", async () => {
      const { c, auth } = await seedCreator({ verified: false });
      let res = await request(app).get("/v1/creator/me").set("Authorization", auth);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        id: c.id,
        email: c.email,
        name: "Asha Iyer",
        country: "IN",
        status: "draft",
        emailVerified: false,
        termsAccepted: true,
        checklist: { emailVerified: false, connected: false, publishablePages: 0, submitted: false },
      });

      const conn = await seedConnection(c.id);
      await seedAsset(c.id, conn.id);
      await seedAsset(c.id, conn.id, { canPublish: false });
      await seedAsset(c.id, conn.id, { networkDuplicateOf: "some-meta-asset-id" });
      await seedAsset(c.id, conn.id, { disconnectedAt: new Date() });
      res = await request(app).get("/v1/creator/me").set("Authorization", auth);
      expect(res.body.data.checklist).toEqual({ emailVerified: false, connected: true, publishablePages: 1, submitted: false });
      expect(JSON.stringify(res.body)).not.toMatch(/secret|passwordHash|Enc/);
    });

    it("shows the review note only while rejected or suspended", async () => {
      const rejected = await seedCreator({ status: "rejected", reviewNote: "Add a page with more posts" });
      expect((await request(app).get("/v1/creator/me").set("Authorization", rejected.auth)).body.data.reviewNote).toBe("Add a page with more posts");
      const approved = await seedCreator({ status: "approved", reviewNote: "internal remark" });
      const res = await request(app).get("/v1/creator/me").set("Authorization", approved.auth);
      expect(res.body.data.reviewNote).toBeNull();
      expect(res.body.data.checklist.submitted).toBe(true);
    });

    it("401 without a token, and for a closed account", async () => {
      expect((await request(app).get("/v1/creator/me")).status).toBe(401);
      const { auth } = await seedCreator({ status: "closed" });
      const res = await request(app).get("/v1/creator/me").set("Authorization", auth);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe("ACCOUNT_CLOSED");
    });

    it("503 while the portal is switched off", async () => {
      const { auth } = await seedCreator();
      vi.stubEnv("CREATORS_ENABLED", "0");
      expect((await request(app).get("/v1/creator/me").set("Authorization", auth)).status).toBe(503);
    });
  });

  describe("PUT /me", () => {
    it("updates only the fields sent, strips tags, upper-cases the country, and can clear phone", async () => {
      const { c, auth } = await seedCreator();
      let res = await request(app).put("/v1/creator/me").set("Authorization", auth).send({ name: "<i>Asha</i> R", country: "ae" });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ name: "Asha R", country: "AE", phone: "+91 98100 00000" });

      res = await request(app).put("/v1/creator/me").set("Authorization", auth).send({ phone: "" });
      expect(res.body.data).toMatchObject({ name: "Asha R", country: "AE", phone: null });
      expect((await prisma.creator.findUniqueOrThrow({ where: { id: c.id } })).phone).toBeNull();

      res = await request(app).put("/v1/creator/me").set("Authorization", auth).send({ country: "" });
      expect(res.body.data).toMatchObject({ name: "Asha R", country: null, phone: null });

      res = await request(app).put("/v1/creator/me").set("Authorization", auth).send({ country: "India" });
      expect(res.status).toBe(400);
    });

    it("a suspended creator can read but not change the profile", async () => {
      const { auth } = await seedCreator({ status: "suspended" });
      expect((await request(app).get("/v1/creator/me").set("Authorization", auth)).status).toBe(200);
      const res = await request(app).put("/v1/creator/me").set("Authorization", auth).send({ name: "New Name" });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("ACCOUNT_SUSPENDED");
    });
  });

  describe("PUT /me/password", () => {
    it("400 WRONG_PASSWORD for a wrong current password; otherwise changes it and ends other sessions", async () => {
      const { c, auth } = await seedCreator();
      const login = await request(app).post("/v1/creator/auth/login").send({ email: c.email, password: "Creator@123" });
      const otherDevice = login.body.data.refreshToken;

      let res = await request(app).put("/v1/creator/me/password").set("Authorization", auth).send({ currentPassword: "nope", newPassword: "Fresh@12345" });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("WRONG_PASSWORD");

      res = await request(app).put("/v1/creator/me/password").set("Authorization", auth).send({ currentPassword: "Creator@123", newPassword: "Fresh@12345" });
      expect(res.status).toBe(200);
      expect(res.body.data.changed).toBe(true);
      // This device gets a fresh session; every other session ends — refresh AND access tokens
      // (session_version moved on), including the token this request itself was made with.
      expect((await request(app).post("/v1/creator/auth/refresh").send({ refreshToken: otherDevice })).status).toBe(401);
      expect((await request(app).get("/v1/creator/me").set("Authorization", `Bearer ${login.body.data.accessToken}`)).status).toBe(401);
      expect((await request(app).get("/v1/creator/me").set("Authorization", auth)).status).toBe(401);
      expect((await request(app).get("/v1/creator/me").set("Authorization", `Bearer ${res.body.data.accessToken}`)).status).toBe(200);
      expect((await request(app).post("/v1/creator/auth/refresh").send({ refreshToken: res.body.data.refreshToken })).status).toBe(200);
      expect((await request(app).post("/v1/creator/auth/login").send({ email: c.email, password: "Fresh@12345" })).status).toBe(200);
    });
  });

  describe("POST /me/submit", () => {
    it("409 EMAIL_NOT_VERIFIED, then 409 NO_PUBLISHABLE_PAGE, then 200 → in_review with a staff alert", async () => {
      const { c, auth } = await seedCreator({ verified: false });
      let res = await request(app).post("/v1/creator/me/submit").set("Authorization", auth);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("EMAIL_NOT_VERIFIED");

      await prisma.creator.update({ where: { id: c.id }, data: { emailVerifiedAt: new Date() } });
      const conn = await seedConnection(c.id);
      // Pages that do not count: can't publish, already on our network, disconnected.
      await seedAsset(c.id, conn.id, { canPublish: false });
      await seedAsset(c.id, conn.id, { networkDuplicateOf: "meta-asset-1" });
      await seedAsset(c.id, conn.id, { disconnectedAt: new Date() });
      res = await request(app).post("/v1/creator/me/submit").set("Authorization", auth);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("NO_PUBLISHABLE_PAGE");

      await seedAsset(c.id, conn.id);
      res = await request(app).post("/v1/creator/me/submit").set("Authorization", auth);
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe("in_review");
      expect(res.body.data.submittedAt).toEqual(expect.any(String));
      expect(notifyMock).toHaveBeenCalledWith("Creator submitted for review", expect.any(Array), `/creators/${c.id}`);

      // Already in review → INVALID_STATE.
      res = await request(app).post("/v1/creator/me/submit").set("Authorization", auth);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("INVALID_STATE");
    });

    it("a rejected creator can resubmit; an approved one cannot; a double click moves it once", async () => {
      const rejected = await seedCreator({ status: "rejected" });
      const conn = await seedConnection(rejected.c.id);
      await seedAsset(rejected.c.id, conn.id);
      const [a, b] = await Promise.all([
        request(app).post("/v1/creator/me/submit").set("Authorization", rejected.auth),
        request(app).post("/v1/creator/me/submit").set("Authorization", rejected.auth),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      expect(notifyMock).toHaveBeenCalledTimes(1);

      const approved = await seedCreator({ status: "approved" });
      const res = await request(app).post("/v1/creator/me/submit").set("Authorization", approved.auth);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("INVALID_STATE");

      const suspended = await seedCreator({ status: "suspended" });
      expect((await request(app).post("/v1/creator/me/submit").set("Authorization", suspended.auth)).status).toBe(403);
    });
  });

  describe("DELETE /me", () => {
    it("closes the account: connections revoked with tokens nulled, pages disconnected and off, sessions ended", async () => {
      const { c, auth } = await seedCreator({ status: "approved" });
      const login = await request(app).post("/v1/creator/auth/login").send({ email: c.email, password: "Creator@123" });
      const conn = await seedConnection(c.id);
      await seedAsset(c.id, conn.id, { enabled: true });
      await seedAsset(c.id, conn.id, { disconnectedAt: new Date("2026-01-01T00:00:00Z") });
      const fetchSpy = vi.fn();
      vi.stubGlobal("fetch", fetchSpy);

      const res = await request(app).delete("/v1/creator/me").set("Authorization", auth);
      vi.unstubAllGlobals();
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ closed: true });
      // Local revoke only — Meta is never called.
      expect(fetchSpy).not.toHaveBeenCalled();

      const row = await prisma.creator.findUniqueOrThrow({ where: { id: c.id } });
      expect(row.status).toBe("closed");
      expect(row.closedAt).not.toBeNull();
      const connAfter = await prisma.creatorConnection.findUniqueOrThrow({ where: { id: conn.id } });
      expect(connAfter).toMatchObject({ status: "REVOKED", userTokenEnc: null });
      expect(connAfter.revokedAt).not.toBeNull();
      const assets = await prisma.creatorAsset.findMany({ where: { creatorId: c.id }, orderBy: { createdAt: "asc" } });
      for (const a of assets) {
        expect(a.enabled).toBe(false);
        expect(a.pageTokenEnc).toBeNull();
        expect(a.disconnectedAt).not.toBeNull();
      }
      // An earlier disconnect keeps its original time.
      expect(assets.some((a) => a.disconnectedAt?.toISOString() === "2026-01-01T00:00:00.000Z")).toBe(true);
      expect(await prisma.creatorRefreshToken.count({ where: { creatorId: c.id } })).toBe(0);

      // Everything stops working.
      expect((await request(app).get("/v1/creator/me").set("Authorization", auth)).status).toBe(401);
      expect((await request(app).post("/v1/creator/auth/refresh").send({ refreshToken: login.body.data.refreshToken })).status).toBe(401);
      const relogin = await request(app).post("/v1/creator/auth/login").send({ email: c.email, password: "Creator@123" });
      expect(relogin.body.error.code).toBe("ACCOUNT_CLOSED");
    });
  });

  describe("token isolation", () => {
    it("a creator token gets nothing from the staff, HR and client portals", async () => {
      const { auth } = await seedCreator({ status: "approved" });
      const probes = [
        request(app).get("/v1/admin/notifications/count").set("Authorization", auth),
        request(app).post("/v1/admin/ai/assist").set("Authorization", auth).send({ prompt: "hello" }),
        request(app).get("/v1/hr/profile").set("Authorization", auth),
        request(app).get("/v1/client/dashboard").set("Authorization", auth),
      ];
      for (const res of await Promise.all(probes)) {
        expect([401, 403]).toContain(res.status);
      }
    });

    it("staff, client and HR tokens get 401 on the creator routes", async () => {
      const user = await createTestUser();
      const tokens = [
        generateToken(user.id, user.email, ["Super Admin"]),
        generateHrToken(user.id, user.email),
        generateClientToken(user.id, user.email),
      ];
      for (const t of tokens) {
        const me = await request(app).get("/v1/creator/me").set("Authorization", `Bearer ${t}`);
        expect(me.status).toBe(401);
        const resend = await request(app).post("/v1/creator/auth/resend-verification").set("Authorization", `Bearer ${t}`);
        expect(resend.status).toBe(401);
      }
    });
  });
});
