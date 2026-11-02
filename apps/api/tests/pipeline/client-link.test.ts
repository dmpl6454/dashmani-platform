/**
 * pipeline/client-link.test.ts — a Pipeline project can name the client company it is for
 * (`pipeline_projects.linked_client_id`, ON DELETE SET NULL), and the sales portal lists a
 * client's projects (GET /v1/sales/clients/:id/projects).
 *
 * ⚠️ `clientId` on a create request is the idempotency key, NOT the client company —
 * the company is `linkedClientId`.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import fs from "fs";
import path from "path";
import { prisma } from "@dashmani/db";
import app from "../../src/app";
import { resetPipelineStateForTests } from "../../src/services/pipeline";
import { pipelineDb } from "../../src/services/pipeline/db";
import { getBoardSnapshot } from "../../src/services/pipeline/board";
import { hrToken, setPipelineSetting, clearPipelineSettings, createPipelineUser, seedPipelinePhases } from "./pipeline-helpers";
import { createTestRole, createTestUser, generateToken } from "../helpers";

const P = "/v1/pipeline/projects";
const uuid = () => crypto.randomUUID();
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function hrUser(name: string) {
  const u = await createPipelineUser({ name, tag: name.toLowerCase().replace(/\W+/g, "-") });
  return { ...u, token: hrToken(u.id) };
}

const newClient = (companyName: string) =>
  prisma.client.create({ data: { companyName, contactName: "X", email: `${uuid()}@client.test`, passwordHash: "x" } });

describe("pipeline project ↔ client link", () => {
  beforeEach(async () => {
    resetPipelineStateForTests();
    await clearPipelineSettings();
    await seedPipelinePhases();
    await setPipelineSetting("pipeline.mode", "on");
  });

  afterAll(async () => {
    await clearPipelineSettings();
    resetPipelineStateForTests();
    await pipelineDb.$disconnect();
  });

  it("creates a project for a client: card, board and detail all name the client", async () => {
    const me = await hrUser("Priya Sharma");
    const c = await newClient("Filmy Brands");
    const r = await request(app).post(P).set(auth(me.token)).send({ clientId: uuid(), title: "Diwali push", linkedClientId: c.id });
    expect(r.status).toBe(201);
    expect(r.body.data.card.linkedClient).toEqual({ id: c.id, companyName: "Filmy Brands" });
    const id = r.body.data.card.id as string;

    const v = (await prisma.pipelineBoardState.findUniqueOrThrow({ where: { id: 1 } })).seq;
    const snap = await getBoardSnapshot(v);
    expect(snap.cards.find((k) => k.id === id)?.linkedClient).toEqual({ id: c.id, companyName: "Filmy Brands" });

    const d = await request(app).get(`${P}/${id}`).set(auth(me.token));
    expect(d.status).toBe(200);
    expect(d.body.data.header.linkedClient).toEqual({ id: c.id, companyName: "Filmy Brands" });

    // The sync header (sent when header_rev moves) carries it too, so a poll never drops it.
    const s = await request(app).post("/v1/pipeline/sync").set(auth(me.token))
      .send({ clientBuild: 1, project: { id, rev: 0, hv: 0 } });
    expect(s.status).toBe(200);
    expect(s.body.data.project.header.linkedClient).toEqual({ id: c.id, companyName: "Filmy Brands" });

    // A project without a client says so (null), and the HR shape is otherwise unchanged.
    const plain = await request(app).post(P).set(auth(me.token)).send({ clientId: uuid(), title: "Internal" });
    expect(plain.status).toBe(201);
    expect(plain.body.data.card.linkedClient).toBeNull();
  });

  it("refuses an unknown client with 400 and creates nothing", async () => {
    const me = await hrUser("Aisha Khan");
    const r = await request(app).post(P).set(auth(me.token)).send({ clientId: uuid(), title: "Ghost", linkedClientId: uuid() });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("CLIENT_NOT_FOUND");
    expect(await prisma.pipelineProject.count({ where: { title: "Ghost" } })).toBe(0);
  });

  it("sets, changes and clears the client by edit; a stale base is a conflict", async () => {
    const me = await hrUser("Rahul Verma");
    const a = await newClient("Alpha Co");
    const b = await newClient("Beta Co");
    const created = await request(app).post(P).set(auth(me.token)).send({ clientId: uuid(), title: "Launch" });
    const id = created.body.data.card.id as string;

    const set = await request(app).patch(`${P}/${id}`).set(auth(me.token))
      .send({ changes: { linkedClientId: a.id }, base: { linkedClientId: null } });
    expect(set.status).toBe(200);
    expect(set.body.data.header.linkedClient).toEqual({ id: a.id, companyName: "Alpha Co" });

    const stale = await request(app).patch(`${P}/${id}`).set(auth(me.token))
      .send({ changes: { linkedClientId: b.id }, base: { linkedClientId: null } });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("EDIT_CONFLICT");

    const bad = await request(app).patch(`${P}/${id}`).set(auth(me.token))
      .send({ changes: { linkedClientId: uuid() }, base: { linkedClientId: a.id } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("CLIENT_NOT_FOUND");

    const cleared = await request(app).patch(`${P}/${id}`).set(auth(me.token))
      .send({ changes: { linkedClientId: null }, base: { linkedClientId: a.id } });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.header.linkedClient).toBeNull();
  });

  it("deleting the client clears the link and keeps the project", async () => {
    const me = await hrUser("Neha Rao");
    const c = await newClient("Gone Co");
    const r = await request(app).post(P).set(auth(me.token)).send({ clientId: uuid(), title: "Keeps going", linkedClientId: c.id });
    const id = r.body.data.card.id as string;
    await prisma.client.delete({ where: { id: c.id } });
    const p = await prisma.pipelineProject.findUniqueOrThrow({ where: { id } });
    expect(p.linkedClientId).toBeNull();
  });

  it("lists a client's projects for sales (live first, never deleted) and needs sales access", async () => {
    await createTestRole("Sales", ["view", "manage"].map((action) => ({ resource: "sales", action, scope: "global" })));
    const sales = await createTestUser({ roleNames: ["Sales"] });
    const salesToken = generateToken(sales.id, sales.email, ["Sales"]);
    const other = await createTestUser({ roleNames: [] });
    const otherToken = generateToken(other.id, other.email, []);

    const me = await hrUser("Kavya Iyer");
    const c = await newClient("Listed Co");
    const mk = async (title: string) =>
      (await request(app).post(P).set(auth(me.token)).send({ clientId: uuid(), title, linkedClientId: c.id })).body.data.card.id as string;
    const live = await mk("Live one");
    const archived = await mk("Archived one");
    const deleted = await mk("Deleted one");
    await request(app).post(`${P}/${archived}/archive`).set(auth(me.token)).send({});
    await prisma.pipelineProject.update({ where: { id: deleted }, data: { deletedAt: new Date() } });
    await request(app).post(P).set(auth(me.token)).send({ clientId: uuid(), title: "Not linked" });

    const res = await request(app).get(`/v1/sales/clients/${c.id}/projects`).set(auth(salesToken));
    expect(res.status).toBe(200);
    expect(res.body.data.map((x: { title: string }) => x.title)).toEqual(["Live one", "Archived one"]);
    expect(res.body.data[0]).toMatchObject({ id: live, phaseName: expect.any(String), archivedAt: null });
    expect(res.body.data[1].archivedAt).toEqual(expect.any(String));

    expect((await request(app).get(`/v1/sales/clients/${c.id}/projects`).set(auth(otherToken))).status).toBe(403);
    expect((await request(app).get(`/v1/sales/clients/${uuid()}/projects`).set(auth(salesToken))).status).toBe(404);
  });
});

describe("scripts/pipeline-client-ddl.sql (static)", () => {
  const sql = fs.readFileSync(path.resolve(__dirname, "../../../../scripts/pipeline-client-ddl.sql"), "utf8");
  const body = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");

  it("is one guarded, additive, re-runnable transaction", () => {
    expect(body).toMatch(/^BEGIN;/m);
    expect(body).toMatch(/^COMMIT;/m);
    expect(body).toMatch(/SET LOCAL lock_timeout = '3s'/);
    expect(body).toMatch(/SET LOCAL search_path = public/);
    expect(body).not.toMatch(/DROP|ALTER TABLE "(users|notifications|clients)"/);
    expect(body).toMatch(/ADD COLUMN IF NOT EXISTS "linked_client_id" TEXT/);
    expect(body).toMatch(/CREATE INDEX IF NOT EXISTS "pipeline_projects_linked_client_id_idx"/);
    expect(body).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname = 'pipeline_projects_linked_client_id_fkey'\)/);
    expect(body).toMatch(/ON DELETE SET NULL/);
  });
});
