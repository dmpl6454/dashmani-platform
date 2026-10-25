/**
 * Meta's Deauthorize / Data Deletion callbacks and the signed_request they carry.
 *
 * Locked here: only a correctly HMAC-SHA256-signed request with the right algorithm is
 * accepted; a creator's grant is revoked (deauthorize) or its Meta data deleted (deletion) while
 * the creator account stays; a staff grantor goes to NEEDS_REAUTH with a staff alert and is never
 * auto-deleted; an unknown user still gets a confirmation code; the public status lookup returns
 * the status and nothing that identifies anyone; only a hash of the Meta user id is stored.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { createHash, createHmac } from "crypto";
import { prisma } from "@dashmani/db";
import "./setup";

vi.mock("../src/services/email.service", async (orig) => {
  const actual = await orig<typeof import("../src/services/email.service")>();
  return { ...actual, sendEmail: vi.fn(async () => ({ messageId: "test" })), notifyAdminByEmail: vi.fn(async () => null) };
});

import app from "../src/app";
import { notifyAdminByEmail } from "../src/services/email.service";
import { parseSignedRequest, signRequestForTesting } from "../src/services/meta-oauth/signed-request";
import { encryptToken } from "../src/utils/token-crypto";
import { createTestUser } from "./helpers";

const SECRET = "test-app-secret";
const ENV = { META_OAUTH_APP_SECRET: SECRET, CREATORS_APP_URL: "https://creators.example.com" };
const saved: Record<string, string | undefined> = {};

const signed = (payload: Record<string, unknown>, secret = SECRET) => signRequestForTesting(payload, secret);
const body = (userId: string, extra: Record<string, unknown> = {}) =>
  `signed_request=${encodeURIComponent(signed({ algorithm: "HMAC-SHA256", user_id: userId, issued_at: 1_700_000_000, ...extra }))}`;

async function seedCreatorWithConnection(metaUserId: string) {
  const creator = await prisma.creator.create({ data: { email: `c${metaUserId}@example.com`, passwordHash: "x", name: "C", status: "approved" } });
  const conn = await prisma.creatorConnection.create({
    data: { creatorId: creator.id, metaUserId, userTokenEnc: encryptToken("EAAusertokenxxxxxxxxxxxxxxxxx"), status: "ACTIVE" },
  });
  await prisma.creatorAsset.create({
    data: { creatorId: creator.id, connectionId: conn.id, kind: "facebook_page", metaId: `p${metaUserId}`, name: "Page",
            pageTokenEnc: encryptToken("EAApagetokenxxxxxxxxxxxxxxxxx"), canPublish: true, enabled: true },
  });
  return { creator, conn };
}

describe("Meta platform callbacks", () => {
  beforeEach(() => {
    for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
    saved.CREATOR_META_APP_SECRET = process.env.CREATOR_META_APP_SECRET;
    delete process.env.CREATOR_META_APP_SECRET;
    vi.mocked(notifyAdminByEmail).mockClear();
  });

  afterEach(() => {
    for (const k of [...Object.keys(ENV), "CREATOR_META_APP_SECRET"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  describe("parseSignedRequest", () => {
    it("accepts a valid request and returns its payload", () => {
      const p = parseSignedRequest(signed({ algorithm: "HMAC-SHA256", user_id: "123" }), SECRET);
      expect(p).toMatchObject({ algorithm: "HMAC-SHA256", user_id: "123" });
    });

    it("refuses a tampered payload, a wrong secret, and garbage", () => {
      const good = signed({ algorithm: "HMAC-SHA256", user_id: "123" });
      const [sig] = good.split(".");
      const forged = Buffer.from(JSON.stringify({ algorithm: "HMAC-SHA256", user_id: "999" })).toString("base64url");
      expect(parseSignedRequest(`${sig}.${forged}`, SECRET)).toBeNull();
      expect(parseSignedRequest(good, "other-secret")).toBeNull();
      expect(parseSignedRequest("not-a-signed-request", SECRET)).toBeNull();
      expect(parseSignedRequest("a.b.c", SECRET)).toBeNull();
      expect(parseSignedRequest(undefined, SECRET)).toBeNull();
      expect(parseSignedRequest(good, "")).toBeNull();
    });

    it("refuses any algorithm other than HMAC-SHA256, even when correctly signed", () => {
      expect(parseSignedRequest(signed({ algorithm: "HMAC-SHA1", user_id: "1" }), SECRET)).toBeNull();
      expect(parseSignedRequest(signed({ algorithm: "none", user_id: "1" }), SECRET)).toBeNull();
      expect(parseSignedRequest(signed({ user_id: "1" }), SECRET)).toBeNull();
      // Meta's own lower-case spelling is fine.
      expect(parseSignedRequest(signed({ algorithm: "hmac-sha256", user_id: "1" }), SECRET)).not.toBeNull();
    });

    it("compares against the HMAC of the ENCODED payload (Meta's spec)", () => {
      const payload = Buffer.from(JSON.stringify({ algorithm: "HMAC-SHA256", user_id: "42" })).toString("base64url");
      const sig = createHmac("sha256", SECRET).update(payload).digest("base64url");
      expect(parseSignedRequest(`${sig}.${payload}`, SECRET)?.user_id).toBe("42");
    });
  });

  describe("POST /v1/meta/deauthorize", () => {
    it("400 BAD_SIGNATURE for a bad signature, and logs nothing", async () => {
      const res = await request(app)
        .post("/v1/meta/deauthorize")
        .type("form")
        .send(`signed_request=${encodeURIComponent(signed({ algorithm: "HMAC-SHA256", user_id: "1" }, "wrong"))}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("BAD_SIGNATURE");
      expect(await prisma.metaDeletionRequest.count()).toBe(0);
    });

    it("revokes a creator's connection and switches its pages off", async () => {
      const { creator, conn } = await seedCreatorWithConnection("111");
      const res = await request(app).post("/v1/meta/deauthorize").type("form").send(body("111"));
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ ok: true });
      const c = await prisma.creatorConnection.findUnique({ where: { id: conn.id } });
      expect(c).toMatchObject({ status: "REVOKED", userTokenEnc: null });
      expect(c?.revokedAt).not.toBeNull();
      const a = await prisma.creatorAsset.findFirst({ where: { connectionId: conn.id } });
      expect(a).toMatchObject({ enabled: false, pageTokenEnc: null });
      expect(a?.disconnectedAt).not.toBeNull();
      expect((await prisma.creator.findUnique({ where: { id: creator.id } }))?.status).toBe("approved");
      const log = await prisma.metaDeletionRequest.findFirst();
      expect(log).toMatchObject({ kind: "deauthorize", matched: "creator", status: "completed" });
      expect(log?.userHash).toBe(createHash("sha256").update("111").digest("hex"));
    });

    it("puts a staff grantor into NEEDS_REAUTH and alerts staff", async () => {
      const admin = await createTestUser();
      const mc = await prisma.metaConnection.create({ data: { metaUserId: "222", connectedById: admin.id, status: "ACTIVE" } });
      const res = await request(app).post("/v1/meta/deauthorize").type("form").send(body("222"));
      expect(res.status).toBe(200);
      expect((await prisma.metaConnection.findUnique({ where: { id: mc.id } }))?.status).toBe("NEEDS_REAUTH");
      expect(vi.mocked(notifyAdminByEmail)).toHaveBeenCalledTimes(1);
      expect((await prisma.metaDeletionRequest.findFirst())?.matched).toBe("staff_grant");
    });

    it("accepts an unknown user (logged as no_data)", async () => {
      const res = await request(app).post("/v1/meta/deauthorize").type("form").send(body("333"));
      expect(res.status).toBe(200);
      expect(await prisma.metaDeletionRequest.findFirst()).toMatchObject({ matched: "none", status: "no_data" });
    });
  });

  describe("POST /v1/meta/data-deletion + status", () => {
    it("returns a url + confirmation code for an UNKNOWN user too", async () => {
      const res = await request(app).post("/v1/meta/data-deletion").type("form").send(body("444"));
      expect(res.status).toBe(200);
      expect(res.body.confirmation_code).toMatch(/^[A-Z0-9]{10}$/);
      expect(res.body.url).toBe(`https://creators.example.com/data-deletion?code=${res.body.confirmation_code}`);
      const status = await request(app).get(`/v1/public/meta-data-deletion/${res.body.confirmation_code}`);
      expect(status.status).toBe(200);
      expect(Object.keys(status.body.data).sort()).toEqual(["code", "completedAt", "receivedAt", "status"]);
      expect(status.body.data.status).toBe("no_data");
    });

    it("deletes a creator's Meta data but keeps the creator account; status says completed with no PII", async () => {
      const { creator } = await seedCreatorWithConnection("555");
      const res = await request(app).post("/v1/meta/data-deletion").type("form").send(body("555"));
      expect(res.status).toBe(200);
      expect(await prisma.creatorConnection.count({ where: { creatorId: creator.id } })).toBe(0);
      expect(await prisma.creatorAsset.count({ where: { creatorId: creator.id } })).toBe(0);
      expect(await prisma.creator.findUnique({ where: { id: creator.id } })).not.toBeNull();
      const status = await request(app).get(`/v1/public/meta-data-deletion/${res.body.confirmation_code}`);
      expect(status.body.data.status).toBe("completed");
      expect(status.body.data.completedAt).not.toBeNull();
      const text = JSON.stringify(status.body);
      expect(text).not.toMatch(/555|@example\.com|creator|userHash|matched/i);
    });

    it("never auto-deletes a staff grant: it stays 'received' and staff are alerted", async () => {
      const admin = await createTestUser();
      await prisma.metaConnection.create({ data: { metaUserId: "666", connectedById: admin.id, status: "ACTIVE" } });
      const res = await request(app).post("/v1/meta/data-deletion").type("form").send(body("666"));
      expect(await prisma.metaConnection.count({ where: { metaUserId: "666" } })).toBe(1);
      expect(vi.mocked(notifyAdminByEmail)).toHaveBeenCalled();
      const status = await request(app).get(`/v1/public/meta-data-deletion/${res.body.confirmation_code}`);
      expect(status.body.data.status).toBe("received");
    });

    it("404 for an unknown code, a malformed code, and a deauthorize row's code", async () => {
      expect((await request(app).get("/v1/public/meta-data-deletion/ZZZZZZZZZZ")).status).toBe(404);
      expect((await request(app).get("/v1/public/meta-data-deletion/%27%20OR%201%3D1")).status).toBe(404);
      await request(app).post("/v1/meta/deauthorize").type("form").send(body("777"));
      const row = await prisma.metaDeletionRequest.findFirst({ where: { kind: "deauthorize" } });
      expect((await request(app).get(`/v1/public/meta-data-deletion/${row!.confirmationCode}`)).status).toBe(404);
    });

    it("400 BAD_SIGNATURE for a forged deletion request", async () => {
      const res = await request(app).post("/v1/meta/data-deletion").type("form").send("signed_request=abc.def");
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("BAD_SIGNATURE");
    });
  });
});
