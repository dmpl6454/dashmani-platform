/**
 * creator-admin.test.ts — the staff review queue for the creator portal (/v1/admin/creators*):
 * the gate, the list + counts + search, every review transition (and its 409 on the wrong
 * state), suspend switching pages off, the per-page switch and its refusals, and that no
 * response ever carries a token, a password hash or an encrypted column.
 *
 * Creators, connections and pages are seeded straight into the database; nothing calls Meta.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { prisma } from "@dashmani/db";
import "./setup";

vi.mock("../src/services/email.service", async (orig) => {
  const actual = await orig<typeof import("../src/services/email.service")>();
  return { ...actual, sendEmail: vi.fn(async () => ({ messageId: "test" })), notifyAdminByEmail: vi.fn(async () => null) };
});

import app from "../src/app";
import { sendEmail } from "../src/services/email.service";
import { createTestUser, generateToken, generateClientToken, generateHrToken, generateCreatorToken } from "./helpers";

const sendMock = vi.mocked(sendEmail);
let n = 0;

/** No secret can ever leave these endpoints. */
function expectNoSecrets(body: unknown) {
  const json = JSON.stringify(body);
  expect(json).not.toMatch(/Enc"/);
  expect(json).not.toContain("passwordHash");
  expect(json).not.toMatch(/token"/i);
  expect(json).not.toContain("secret-user-token");
  expect(json).not.toContain("secret-page-token");
  expect(json).not.toContain("payoutDetails");
}

async function seedCreator(over: Partial<{ name: string; email: string; status: string; reviewNote: string }> = {}) {
  return prisma.creator.create({
    data: {
      email: over.email ?? `adm-${Date.now()}-${++n}@creators.test`,
      passwordHash: "$2b$04$not-a-real-hash-but-a-secret-looking-value",
      name: over.name ?? "Asha Iyer",
      country: "IN",
      status: over.status ?? "in_review",
      emailVerifiedAt: new Date(),
      termsAcceptedAt: new Date(),
      submittedAt: over.status === "draft" ? null : new Date(),
      reviewNote: over.reviewNote ?? null,
      payoutDetailsEnc: "enc:v1:secret-payout",
    },
  });
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
  over: Partial<{ canPublish: boolean; networkDuplicateOf: string | null; disconnectedAt: Date | null; enabled: boolean; followerCount: number; metaId: string }> = {},
) {
  return prisma.creatorAsset.create({
    data: {
      creatorId,
      connectionId,
      kind: "facebook_page",
      metaId: over.metaId ?? `page-${Date.now()}-${++n}`,
      name: "Asha Eats",
      pageTokenEnc: "enc:v1:secret-page-token",
      tasks: ["CREATE_CONTENT", "ANALYZE"],
      canPublish: over.canPublish ?? true,
      networkDuplicateOf: over.networkDuplicateOf ?? null,
      disconnectedAt: over.disconnectedAt ?? null,
      enabled: over.enabled ?? false,
      followerCount: over.followerCount ?? 1000,
    },
  });
}

describe("Creator admin API", () => {
  let staff: { id: string; email: string };
  let admin: string;

  beforeEach(async () => {
    sendMock.mockClear();
    staff = await createTestUser({ name: "Review Staff" });
    admin = `Bearer ${generateToken(staff.id, staff.email, ["Admin"])}`;
  });

  // ── Gate ─────────────────────────────────────────────────────────────────────

  describe("gate", () => {
    it("refuses no token, a non-admin employee, and client / HR / creator tokens", async () => {
      const c = await seedCreator();
      const paths = ["/v1/admin/creators", `/v1/admin/creators/${c.id}`];
      for (const p of paths) {
        expect((await request(app).get(p)).status).toBe(401);
        const emp = await request(app).get(p).set("Authorization", `Bearer ${generateToken(staff.id, staff.email, ["Employee"])}`);
        expect(emp.status).toBe(403);
        const client = await request(app).get(p).set("Authorization", `Bearer ${generateClientToken(staff.id, staff.email)}`);
        expect(client.status).toBe(403);
        const hr = await request(app).get(p).set("Authorization", `Bearer ${generateHrToken(staff.id, staff.email, ["Admin"])}`);
        expect(hr.status).toBe(403);
        const creator = await request(app).get(p).set("Authorization", `Bearer ${generateCreatorToken(c.id, c.email)}`);
        expect([401, 403]).toContain(creator.status);
      }
      // Writes too.
      const w = await request(app).post(`/v1/admin/creators/${c.id}/approve`).set("Authorization", `Bearer ${generateToken(staff.id, staff.email, ["Employee"])}`).send({});
      expect(w.status).toBe(403);
      expect((await prisma.creator.findUnique({ where: { id: c.id } }))!.status).toBe("in_review");
    });
  });

  // ── List ─────────────────────────────────────────────────────────────────────

  describe("list", () => {
    it("lists the review queue first with counts per status and page totals", async () => {
      const old = await seedCreator({ name: "Old Approved", status: "approved" });
      const queued = await seedCreator({ name: "In Queue", status: "in_review" });
      await seedCreator({ name: "Newest Draft", status: "draft" });
      const conn = await seedConnection(queued.id);
      await seedAsset(queued.id, conn.id, { followerCount: 1500 });
      await seedAsset(queued.id, conn.id, { canPublish: false, followerCount: 500 });
      await seedAsset(queued.id, conn.id, { disconnectedAt: new Date(), followerCount: 99_999 });

      const res = await request(app).get("/v1/admin/creators").set("Authorization", admin);
      expect(res.status).toBe(200);
      expectNoSecrets(res.body);
      const { creators, counts } = res.body.data;
      expect(creators.map((c: { name: string }) => c.name)).toEqual(["In Queue", "Newest Draft", "Old Approved"]);
      expect(counts).toMatchObject({ draft: 1, in_review: 1, approved: 1, rejected: 0, suspended: 0, closed: 0 });
      const row = creators[0];
      expect(row).toMatchObject({ id: queued.id, pages: 2, publishablePages: 1, followers: 2000, connectionStatus: "ACTIVE", country: "IN" });
      expect(creators.find((c: { id: string }) => c.id === old.id).connectionStatus).toBeNull();
    });

    it("filters by status and searches name/email case-insensitively, treating _ and % literally", async () => {
      await seedCreator({ name: "Priya Sharma", email: "priya@creators.test", status: "in_review" });
      await seedCreator({ name: "Rahul Verma", email: "rahul_v@creators.test", status: "approved" });
      await seedCreator({ name: "Rahulx Verma", email: "rahulxv@creators.test", status: "approved" });

      const byStatus = await request(app).get("/v1/admin/creators?status=approved").set("Authorization", admin);
      expect(byStatus.body.data.creators).toHaveLength(2);
      expect(byStatus.body.data.counts.in_review).toBe(1);

      const byName = await request(app).get("/v1/admin/creators?q=PRIYA").set("Authorization", admin);
      expect(byName.body.data.creators.map((c: { name: string }) => c.name)).toEqual(["Priya Sharma"]);
      expect(byName.body.data.counts).toMatchObject({ in_review: 1, approved: 0 });

      // "_" must not match "x".
      const literal = await request(app).get("/v1/admin/creators?q=rahul_v").set("Authorization", admin);
      expect(literal.body.data.creators.map((c: { email: string }) => c.email)).toEqual(["rahul_v@creators.test"]);
      const pct = await request(app).get("/v1/admin/creators?q=%25").set("Authorization", admin);
      expect(pct.body.data.creators).toHaveLength(0);

      // An unknown status is ignored rather than 500ing.
      const junk = await request(app).get("/v1/admin/creators?status=nope").set("Authorization", admin);
      expect(junk.status).toBe(200);
      expect(junk.body.data.creators).toHaveLength(3);
    });
  });

  // ── Detail ───────────────────────────────────────────────────────────────────

  describe("detail", () => {
    it("returns the creator, connection health and admin asset views with no secrets", async () => {
      const c = await seedCreator();
      const conn = await seedConnection(c.id);
      const metaConn = await prisma.metaConnection.create({ data: { metaUserId: `mu-ca-${Date.now()}`, connectedById: staff.id, status: "ACTIVE" } });
      const net = await prisma.metaAsset.create({ data: { connectionId: metaConn.id, kind: "FACEBOOK_PAGE", metaId: `fb-net-${n}`, name: "Bollywood Network Page" } });
      await seedAsset(c.id, conn.id, { networkDuplicateOf: net.id });

      const res = await request(app).get(`/v1/admin/creators/${c.id}`).set("Authorization", admin);
      expect(res.status).toBe(200);
      expectNoSecrets(res.body);
      const { creator, connection, assets } = res.body.data;
      expect(creator).toMatchObject({ id: c.id, status: "in_review", payoutHint: null, reviewedAt: null, closedAt: null });
      expect(connection).toMatchObject({ status: "ACTIVE", metaUserName: "Asha" });
      expect(connection.missingScopes).toContain("instagram_content_publish");
      expect(assets).toHaveLength(1);
      expect(assets[0]).toMatchObject({ networkDuplicate: true, networkDuplicateOfName: "Bollywood Network Page", tasks: ["CREATE_CONTENT", "ANALYZE"] });
      expect(assets[0]).not.toHaveProperty("networkDuplicateOf");
    });

    it("404s an unknown creator", async () => {
      const res = await request(app).get("/v1/admin/creators/00000000-0000-0000-0000-000000000000").set("Authorization", admin);
      expect(res.status).toBe(404);
    });
  });

  // ── Transitions ──────────────────────────────────────────────────────────────

  describe("transitions", () => {
    it("approves a creator in review, records the reviewer and emails the creator", async () => {
      const c = await seedCreator({ name: "Asha <b>Iyer</b>" });
      const res = await request(app).post(`/v1/admin/creators/${c.id}/approve`).set("Authorization", admin).send({ note: "Welcome aboard" });
      expect(res.status).toBe(200);
      expectNoSecrets(res.body);
      expect(res.body.data.creator).toMatchObject({ status: "approved", reviewedById: staff.id, reviewedByName: "Review Staff", reviewNote: "Welcome aboard" });
      const row = await prisma.creator.findUnique({ where: { id: c.id } });
      expect(row!.reviewedAt).not.toBeNull();
      expect(sendMock).toHaveBeenCalledTimes(1);
      expect(res.body.data.emailSent).toBe(true);
      const mail = sendMock.mock.calls[0][0] as { to: string; html: string };
      expect(mail.to).toBe(c.email);
      expect(mail.html).toContain("Welcome aboard");
      // The creator's name is escaped into the email.
      expect(mail.html).not.toContain("<b>Iyer</b>");
    });

    it("approve without a body works; approving twice is 409 INVALID_STATE; an unsent email is reported, not claimed", async () => {
      const c = await seedCreator();
      sendMock.mockResolvedValueOnce(null as never); // no SMTP / Gmail refused
      const first = await request(app).post(`/v1/admin/creators/${c.id}/approve`).set("Authorization", admin);
      expect(first.status).toBe(200);
      expect(first.body.data.emailSent).toBe(false);
      expect(first.body.data.creator.status).toBe("approved");
      const again = await request(app).post(`/v1/admin/creators/${c.id}/approve`).set("Authorization", admin).send({});
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe("INVALID_STATE");
    });

    it("rejects with a required note (escaped in the email); 409 from the wrong state", async () => {
      const c = await seedCreator();
      const noNote = await request(app).post(`/v1/admin/creators/${c.id}/reject`).set("Authorization", admin).send({});
      expect(noNote.status).toBe(400);

      const res = await request(app).post(`/v1/admin/creators/${c.id}/reject`).set("Authorization", admin).send({ note: "Pages too small & new" });
      expect(res.status).toBe(200);
      expect(res.body.data.creator).toMatchObject({ status: "rejected", reviewNote: "Pages too small & new" });
      const mail = sendMock.mock.calls[0][0] as { html: string };
      expect(mail.html).toContain("Pages too small &amp; new");

      const draft = await seedCreator({ status: "draft" });
      const wrong = await request(app).post(`/v1/admin/creators/${draft.id}/reject`).set("Authorization", admin).send({ note: "No pages" });
      expect(wrong.status).toBe(409);
      expect(wrong.body.error.code).toBe("INVALID_STATE");
      expect((await prisma.creator.findUnique({ where: { id: draft.id } }))!.status).toBe("draft");
    });

    it("suspends an approved creator and switches every page off; reinstate does not switch them back on", async () => {
      const c = await seedCreator({ status: "approved" });
      const conn = await seedConnection(c.id);
      const a1 = await seedAsset(c.id, conn.id, { enabled: true });
      const a2 = await seedAsset(c.id, conn.id, { enabled: true });

      const inReview = await seedCreator();
      expect((await request(app).post(`/v1/admin/creators/${inReview.id}/suspend`).set("Authorization", admin).send({ note: "Spam" })).status).toBe(409);
      expect((await request(app).post(`/v1/admin/creators/${c.id}/suspend`).set("Authorization", admin).send({})).status).toBe(400);

      const res = await request(app).post(`/v1/admin/creators/${c.id}/suspend`).set("Authorization", admin).send({ note: "Copyright complaints" });
      expect(res.status).toBe(200);
      expect(res.body.data.creator.status).toBe("suspended");
      expect(res.body.data.assets.every((a: { enabled: boolean }) => !a.enabled)).toBe(true);
      const rows = await prisma.creatorAsset.findMany({ where: { id: { in: [a1.id, a2.id] } } });
      expect(rows.every((r) => !r.enabled && r.enabledAt == null)).toBe(true);

      const back = await request(app).post(`/v1/admin/creators/${c.id}/reinstate`).set("Authorization", admin).send({});
      expect(back.status).toBe(200);
      expect(back.body.data.creator.status).toBe("approved");
      expect(back.body.data.assets.every((a: { enabled: boolean }) => !a.enabled)).toBe(true);
      expect(sendMock).toHaveBeenCalledTimes(2);

      const again = await request(app).post(`/v1/admin/creators/${c.id}/reinstate`).set("Authorization", admin).send({});
      expect(again.status).toBe(409);
    });

    it("404s a transition on an unknown creator", async () => {
      const res = await request(app).post("/v1/admin/creators/00000000-0000-0000-0000-000000000000/approve").set("Authorization", admin).send({});
      expect(res.status).toBe(404);
    });

    it("a failing email does not undo the transition", async () => {
      const c = await seedCreator();
      sendMock.mockRejectedValueOnce(new Error("SMTP down access_token=abc"));
      const res = await request(app).post(`/v1/admin/creators/${c.id}/approve`).set("Authorization", admin).send({});
      expect(res.status).toBe(200);
      expect((await prisma.creator.findUnique({ where: { id: c.id } }))!.status).toBe("approved");
    });
  });

  // ── Page switch ──────────────────────────────────────────────────────────────

  describe("asset toggle", () => {
    it("enables a publishable page of an approved creator and records who did it", async () => {
      const c = await seedCreator({ status: "approved" });
      const conn = await seedConnection(c.id);
      const a = await seedAsset(c.id, conn.id);
      const res = await request(app).put(`/v1/admin/creators/${c.id}/assets/${a.id}`).set("Authorization", admin).send({ enabled: true });
      expect(res.status).toBe(200);
      expectNoSecrets(res.body);
      expect(res.body.data).toMatchObject({ id: a.id, enabled: true, tasks: ["CREATE_CONTENT", "ANALYZE"] });
      const row = await prisma.creatorAsset.findUnique({ where: { id: a.id } });
      expect(row).toMatchObject({ enabled: true, enabledById: staff.id });
      expect(row!.enabledAt).not.toBeNull();

      const off = await request(app).put(`/v1/admin/creators/${c.id}/assets/${a.id}`).set("Authorization", admin).send({ enabled: false });
      expect(off.status).toBe(200);
      expect(off.body.data.enabled).toBe(false);
    });

    it("refuses to enable with a reason: not approved, network duplicate, can't publish, disconnected, lapsed connection", async () => {
      const metaConn = await prisma.metaConnection.create({ data: { metaUserId: `mu-ca2-${Date.now()}`, connectedById: staff.id, status: "ACTIVE" } });
      const net = await prisma.metaAsset.create({ data: { connectionId: metaConn.id, kind: "FACEBOOK_PAGE", metaId: `fb-net2-${n}`, name: "Ours" } });

      const pending = await seedCreator({ status: "in_review" });
      const pConn = await seedConnection(pending.id);
      const pAsset = await seedAsset(pending.id, pConn.id);

      const c = await seedCreator({ status: "approved" });
      const conn = await seedConnection(c.id);
      const dup = await seedAsset(c.id, conn.id, { networkDuplicateOf: net.id, metaId: net.metaId });
      // Joined our network AFTER the creator's discovery: the stored flag is still null, the
      // live re-check at enable time must catch it.
      const net2 = await prisma.metaAsset.create({ data: { connectionId: metaConn.id, kind: "FACEBOOK_PAGE", metaId: `fb-net3-${n}`, name: "Ours later" } });
      const lateDup = await seedAsset(c.id, conn.id, { metaId: net2.metaId });
      const noPub = await seedAsset(c.id, conn.id, { canPublish: false });
      const gone = await seedAsset(c.id, conn.id, { disconnectedAt: new Date() });
      const lapsedConn = await seedConnection(c.id);
      await prisma.creatorConnection.update({ where: { id: lapsedConn.id }, data: { status: "NEEDS_REAUTH" } });
      const lapsed = await seedAsset(c.id, lapsedConn.id);

      const cases: Array<[string, string, string, RegExp]> = [
        [pending.id, pAsset.id, "creator_not_approved", /approved/],
        [c.id, dup.id, "network_duplicate", /already on our network/],
        [c.id, lateDup.id, "network_duplicate", /already on our network/],
        [c.id, lapsed.id, "connection_not_live", /reconnect/],
        [c.id, noPub.id, "cannot_publish", /can't publish/],
        [c.id, gone.id, "disconnected", /disconnected/],
      ];
      for (const [cid, aid, reason, msg] of cases) {
        const res = await request(app).put(`/v1/admin/creators/${cid}/assets/${aid}`).set("Authorization", admin).send({ enabled: true });
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe("NOT_ENABLEABLE");
        expect(res.body.error.message).toMatch(msg);
        expect(res.body.error.details).toEqual([{ field: "reason", message: reason }]);
        expect((await prisma.creatorAsset.findUnique({ where: { id: aid } }))!.enabled).toBe(false);
      }
    });

    it("404s a page that belongs to another creator, and validates the body", async () => {
      const c = await seedCreator({ status: "approved" });
      const other = await seedCreator({ status: "approved" });
      const conn = await seedConnection(other.id);
      const a = await seedAsset(other.id, conn.id);
      const res = await request(app).put(`/v1/admin/creators/${c.id}/assets/${a.id}`).set("Authorization", admin).send({ enabled: true });
      expect(res.status).toBe(404);
      const bad = await request(app).put(`/v1/admin/creators/${other.id}/assets/${a.id}`).set("Authorization", admin).send({ enabled: "yes" });
      expect(bad.status).toBe(400);
    });
  });
});
