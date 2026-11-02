/**
 * sales-creators.test.ts — the creator review queue in the sales portal (/v1/sales/creators*).
 * It reuses creator-admin.service, so these tests cover the GATE (sales:view reads, sales:manage
 * decides; employees without sales, client and HR tokens refused) and that the shared rules hold
 * through the sales route: approve emails the creator, a network duplicate is never turned on.
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
import { createTestRole, createTestUser, generateToken, generateClientToken, generateHrToken } from "./helpers";

const sendMock = vi.mocked(sendEmail);
let n = 0;

async function seedCreator(status = "in_review") {
  return prisma.creator.create({
    data: {
      email: `sc-${Date.now()}-${++n}@creators.test`,
      passwordHash: "$2b$04$not-a-real-hash",
      name: "Asha Iyer",
      country: "IN",
      status,
      emailVerifiedAt: new Date(),
      termsAcceptedAt: new Date(),
      submittedAt: new Date(),
    },
  });
}

async function seedConnection(creatorId: string) {
  return prisma.creatorConnection.create({
    data: { creatorId, metaUserId: `meta-sc-${Date.now()}-${++n}`, metaUserName: "Asha", userTokenEnc: "enc:v1:secret-user-token", grantedScopes: "pages_show_list,pages_manage_posts" },
  });
}

async function seedAsset(creatorId: string, connectionId: string, over: { metaId?: string; networkDuplicateOf?: string | null } = {}) {
  return prisma.creatorAsset.create({
    data: {
      creatorId, connectionId, kind: "facebook_page", metaId: over.metaId ?? `page-sc-${Date.now()}-${++n}`, name: "Asha Eats",
      pageTokenEnc: "enc:v1:secret-page-token", tasks: ["CREATE_CONTENT"], canPublish: true, networkDuplicateOf: over.networkDuplicateOf ?? null, followerCount: 1000,
    },
  });
}

describe("Sales: creator review", () => {
  let sales: string;
  let viewer: string;
  let employee: string;
  let staff: { id: string; email: string };

  beforeEach(async () => {
    sendMock.mockClear();
    await createTestRole("Sales", ["view", "manage"].map((action) => ({ resource: "sales", action, scope: "global" })));
    await createTestRole("Sales Viewer", [{ resource: "sales", action: "view", scope: "global" }]);
    staff = await createTestUser({ name: "Sales Person", roleNames: ["Sales"] });
    sales = `Bearer ${generateToken(staff.id, staff.email, ["Sales"])}`;
    const v = await createTestUser({ name: "Sales Viewer", roleNames: ["Sales Viewer"] });
    viewer = `Bearer ${generateToken(v.id, v.email, ["Sales Viewer"])}`;
    const e = await createTestUser({ name: "Plain Employee", roleNames: ["Employee"] });
    employee = `Bearer ${generateToken(e.id, e.email, ["Employee"])}`;
  });

  it("lists the queue and approves through the shared service (the creator is emailed, the reviewer recorded)", async () => {
    const c = await seedCreator();
    await seedCreator("approved");
    const list = await request(app).get("/v1/sales/creators").set("Authorization", sales);
    expect(list.status).toBe(200);
    expect(list.body.data.creators[0]).toMatchObject({ id: c.id, status: "in_review" });
    expect(list.body.data.counts).toMatchObject({ in_review: 1, approved: 1 });
    expect(JSON.stringify(list.body)).not.toMatch(/Enc"|passwordHash/);

    const detail = await request(app).get(`/v1/sales/creators/${c.id}`).set("Authorization", viewer);
    expect(detail.status).toBe(200);
    expect(detail.body.data.creator).toMatchObject({ id: c.id, status: "in_review" });

    // sales:view alone cannot decide.
    expect((await request(app).post(`/v1/sales/creators/${c.id}/approve`).set("Authorization", viewer).send({})).status).toBe(403);

    const ok = await request(app).post(`/v1/sales/creators/${c.id}/approve`).set("Authorization", sales).send({ note: "Welcome" });
    expect(ok.status).toBe(200);
    const row = await prisma.creator.findUniqueOrThrow({ where: { id: c.id } });
    expect(row).toMatchObject({ status: "approved", reviewedById: staff.id, reviewNote: "Welcome" });
    expect(sendMock).toHaveBeenCalled();

    // The same state rules: approving twice is refused; reject needs a note.
    expect((await request(app).post(`/v1/sales/creators/${c.id}/approve`).set("Authorization", sales).send({})).status).toBe(409);
    const other = await seedCreator();
    expect((await request(app).post(`/v1/sales/creators/${other.id}/reject`).set("Authorization", sales).send({})).status).toBe(400);
  });

  it("refuses an employee without sales access and client / HR tokens", async () => {
    const c = await seedCreator();
    for (const p of ["/v1/sales/creators", `/v1/sales/creators/${c.id}`]) {
      expect((await request(app).get(p)).status).toBe(401);
      expect((await request(app).get(p).set("Authorization", employee)).status).toBe(403);
      expect((await request(app).get(p).set("Authorization", `Bearer ${generateClientToken(staff.id, staff.email)}`)).status).toBe(403);
      expect((await request(app).get(p).set("Authorization", `Bearer ${generateHrToken(staff.id, staff.email, ["Sales"])}`)).status).toBe(403);
    }
    expect((await request(app).post(`/v1/sales/creators/${c.id}/approve`).set("Authorization", employee).send({})).status).toBe(403);
    expect((await prisma.creator.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("in_review");
  });

  it("never turns on a page that is already on our network, and turns on a clean one", async () => {
    const metaConn = await prisma.metaConnection.create({ data: { metaUserId: `mu-sc-${Date.now()}`, connectedById: staff.id, status: "ACTIVE" } });
    const net = await prisma.metaAsset.create({ data: { connectionId: metaConn.id, kind: "FACEBOOK_PAGE", metaId: `fb-sc-net-${n}`, name: "Ours" } });
    const c = await seedCreator("approved");
    const conn = await seedConnection(c.id);
    const dup = await seedAsset(c.id, conn.id, { metaId: net.metaId, networkDuplicateOf: net.id });
    const clean = await seedAsset(c.id, conn.id);

    const refused = await request(app).put(`/v1/sales/creators/${c.id}/assets/${dup.id}`).set("Authorization", sales).send({ enabled: true });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("NOT_ENABLEABLE");
    expect(refused.body.error.details).toEqual([{ field: "reason", message: "network_duplicate" }]);
    expect((await prisma.creatorAsset.findUniqueOrThrow({ where: { id: dup.id } })).enabled).toBe(false);

    const on = await request(app).put(`/v1/sales/creators/${c.id}/assets/${clean.id}`).set("Authorization", sales).send({ enabled: true });
    expect(on.status).toBe(200);
    expect(on.body.data).toMatchObject({ id: clean.id, enabled: true });
    expect((await prisma.creatorAsset.findUniqueOrThrow({ where: { id: clean.id } })).enabledById).toBe(staff.id);
  });
});
