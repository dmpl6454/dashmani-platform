/**
 * pipeline/budget.test.ts — a project's budget (2026-11-26, `pipeline_projects.budget_inr`,
 * scripts/budget-quick-client-ddl.sql): set at create, carried on the board card, the project
 * detail and the sync header, and changed ONLY by the person who created the project.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { prisma } from "@dashmani/db";
import app from "../../src/app";
import { resetPipelineStateForTests } from "../../src/services/pipeline";
import { pipelineDb } from "../../src/services/pipeline/db";
import { getBoardSnapshot } from "../../src/services/pipeline/board";
import { hrToken, setPipelineSetting, clearPipelineSettings, createPipelineUser, seedPipelinePhases } from "./pipeline-helpers";

const P = "/v1/pipeline/projects";
const uuid = () => crypto.randomUUID();
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function hrUser(name: string) {
  const u = await createPipelineUser({ name, tag: name.toLowerCase().replace(/\W+/g, "-") });
  return { ...u, token: hrToken(u.id) };
}

const boardSeq = async () => (await prisma.pipelineBoardState.findUniqueOrThrow({ where: { id: 1 } })).seq;

describe("pipeline project budget", () => {
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

  it("a budget given at create shows on the card, the board, the detail and the sync header", async () => {
    const me = await hrUser("Priya Sharma");
    const r = await request(app).post(P).set(auth(me.token)).send({ clientId: uuid(), title: "Diwali push", budget: 500000 });
    expect(r.status).toBe(201);
    expect(r.body.data.card.budget).toBe(500000);
    const id = r.body.data.card.id as string;

    const snap = await getBoardSnapshot(await boardSeq());
    expect(snap.cards.find((k) => k.id === id)?.budget).toBe(500000);

    const d = await request(app).get(`${P}/${id}`).set(auth(me.token));
    expect(d.body.data.header.budget).toBe(500000);

    const s = await request(app).post("/v1/pipeline/sync").set(auth(me.token)).send({ clientBuild: 1, project: { id, rev: 0, hv: 0 } });
    expect(s.status).toBe(200);
    expect(s.body.data.project.header.budget).toBe(500000);

    // No budget = null everywhere.
    const plain = await request(app).post(P).set(auth(me.token)).send({ clientId: uuid(), title: "Internal" });
    expect(plain.body.data.card.budget).toBeNull();
  });

  it("refuses a negative, fractional or too-large budget", async () => {
    const me = await hrUser("Aisha Khan");
    for (const budget of [-1, 10.5, 2_000_000_000]) {
      const r = await request(app).post(P).set(auth(me.token)).send({ clientId: uuid(), title: `Bad ${budget}`, budget });
      expect(r.status).toBe(400);
    }
    expect(await prisma.pipelineProject.count({ where: { title: { startsWith: "Bad" } } })).toBe(0);
  });

  it("only the creator can change it — not another member, not the owner after a transfer", async () => {
    const creator = await hrUser("Rahul Verma");
    const other = await hrUser("Neha Gupta");
    const created = await request(app).post(P).set(auth(creator.token))
      .send({ clientId: uuid(), title: "Launch", budget: 100000, memberIds: [other.id] });
    const id = created.body.data.card.id as string;

    const refused = await request(app).patch(`${P}/${id}`).set(auth(other.token))
      .send({ changes: { budget: 999 }, base: { budget: 100000 } });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("BUDGET_CREATOR_ONLY");
    expect((await prisma.pipelineProject.findUniqueOrThrow({ where: { id } })).budgetInr).toBe(100000);

    // The same person can still edit the other fields.
    const title = await request(app).patch(`${P}/${id}`).set(auth(other.token))
      .send({ changes: { title: "Launch v2" }, base: { title: "Launch" } });
    expect(title.status).toBe(200);

    const before = await boardSeq();
    const ok = await request(app).patch(`${P}/${id}`).set(auth(creator.token))
      .send({ changes: { budget: 250000 }, base: { budget: 100000 } });
    expect(ok.status).toBe(200);
    expect(ok.body.data.header.budget).toBe(250000);
    expect(await boardSeq()).toBeGreaterThan(before); // the card shows the new figure

    // Ownership moves; the budget stays the creator's.
    await prisma.pipelineProject.update({ where: { id }, data: { ownerId: other.id } });
    const owner = await request(app).patch(`${P}/${id}`).set(auth(other.token))
      .send({ changes: { budget: null }, base: { budget: 250000 } });
    expect(owner.status).toBe(403);

    const cleared = await request(app).patch(`${P}/${id}`).set(auth(creator.token))
      .send({ changes: { budget: null }, base: { budget: 250000 } });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.header.budget).toBeNull();
  });

  it("a stale base is a conflict, and re-sending the current value is a no-op for anyone", async () => {
    const creator = await hrUser("Kabir Rao");
    const other = await hrUser("Meera Iyer");
    const created = await request(app).post(P).set(auth(creator.token)).send({ clientId: uuid(), title: "Promo", budget: 5000 });
    const id = created.body.data.card.id as string;

    const stale = await request(app).patch(`${P}/${id}`).set(auth(creator.token))
      .send({ changes: { budget: 7000 }, base: { budget: 1 } });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("EDIT_CONFLICT");

    // Unchanged value: nothing changes, so nothing to refuse.
    const same = await request(app).patch(`${P}/${id}`).set(auth(other.token))
      .send({ changes: { budget: 5000 }, base: { budget: 5000 } });
    expect(same.status).toBe(200);
  });
});
