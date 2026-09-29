/**
 * pipeline/ack.test.ts — the ack (A1, spec §5.4) clears notifications by primary key.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "crypto";
import { prisma } from "@dashmani/db";
import app from "../../src/app";
import { resetPipelineStateForTests } from "../../src/services/pipeline";
import { pipelineDb } from "../../src/services/pipeline/db";
import { plnId } from "../../src/services/pipeline/notify";
import { ackStatement } from "../../src/services/pipeline/sync.service";
import { hrToken, setPipelineSetting, clearPipelineSettings, createPipelineUser, seedPipelinePhases } from "./pipeline-helpers";
import { createProjectFixture, phaseIdOf, mention } from "./fixtures-messages";

const auth = (userId: string) => ({ Authorization: `Bearer ${hrToken(userId)}` });

describe("pipeline ack clears notifications", () => {
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

  const post = (uid: string, pid: string, body: string, parentId?: string) =>
    request(app)
      .post(`/v1/pipeline/projects/${pid}/messages`)
      .set(auth(uid))
      .send({ clientId: randomUUID(), body, ...(parentId ? { parentId } : {}) });
  const sync = (uid: string, pid: string, ack: Record<string, unknown>) =>
    request(app).post("/v1/pipeline/sync").set(auth(uid)).send({ clientBuild: 1, project: { id: pid, rev: 0, hv: 0, ack } });
  const readOf = async (id: string) => (await prisma.notification.findUniqueOrThrow({ where: { id } })).read;

  async function direct(userId: string, id: string, kind: string, pid: string) {
    await prisma.notification.create({
      data: { id, userId, type: "PIPELINE", title: kind, message: kind, metadata: { v: 1, kind, pid } },
    });
  }

  it("the project-level ack clears grouped, added, moved and due rows, never mention or reply rows", async () => {
    const owner = await createPipelineUser({ name: "Owner", tag: "ack-o" });
    const bob = await createPipelineUser({ name: "Bob", tag: "ack-b" });
    const project = await createProjectFixture({ ownerId: owner.id, memberIds: [bob.id] });
    await pipelineDb.$executeRaw`UPDATE pipeline_projects SET due_date = DATE '2026-10-05' WHERE id = ${project.id}`;
    const root = await post(bob.id, project.id, "bob's root");
    const rootId = root.body.data.message.id;
    const m = await post(owner.id, project.id, `hi ${mention(bob.id)}`);
    const rep = await post(owner.id, project.id, "a reply", rootId);
    await post(owner.id, project.id, "plain");
    const mv = await request(app)
      .post(`/v1/pipeline/projects/${project.id}/move`)
      .set(auth(owner.id))
      .send({ toPhaseId: await phaseIdOf("planning"), afterId: null, basePhaseId: await phaseIdOf("brief") });
    expect(mv.status).toBe(200);
    const ids = {
      grouped: plnId("messages", project.id, bob.id),
      added: plnId("added", project.id, bob.id),
      moved: plnId("moved", project.id, bob.id, "1"),
      dueSoon: plnId("due_soon", project.id, bob.id, "2026-10-05"),
      overdue: plnId("overdue", project.id, bob.id, "2026-10-05"),
      mention: plnId("mention", m.body.data.message.id, bob.id),
      reply: plnId("reply", rep.body.data.message.id),
    };
    await direct(bob.id, ids.added, "added", project.id);
    await direct(bob.id, ids.dueSoon, "due_soon", project.id);
    await direct(bob.id, ids.overdue, "overdue", project.id);
    for (const id of Object.values(ids)) expect(await readOf(id)).toBe(false);

    const s = await sync(bob.id, project.id, { seq: 5, open: true });
    expect(s.status).toBe(200);
    for (const k of ["grouped", "added", "moved", "dueSoon", "overdue"] as const) expect(await readOf(ids[k])).toBe(true);
    expect(await readOf(ids.mention)).toBe(false);
    expect(await readOf(ids.reply)).toBe(false);

    // `seen` clears them — by id, and only mine.
    const s2 = await sync(bob.id, project.id, { seq: 5, seen: [m.body.data.message.id, rep.body.data.message.id] });
    expect(s2.status).toBe(200);
    expect(await readOf(ids.mention)).toBe(true);
    expect(await readOf(ids.reply)).toBe(true);
  });

  it("a grouped row newer than the ack stays unread", async () => {
    const owner = await createPipelineUser({ name: "Owner", tag: "ack-o2" });
    const bob = await createPipelineUser({ name: "Bob", tag: "ack-b2" });
    const project = await createProjectFixture({ ownerId: owner.id, memberIds: [bob.id] });
    await post(owner.id, project.id, "one");
    await post(owner.id, project.id, "two");
    expect((await sync(bob.id, project.id, { seq: 1 })).status).toBe(200);
    expect(await readOf(plnId("messages", project.id, bob.id))).toBe(false);
    expect((await sync(bob.id, project.id, { seq: 2 })).status).toBe(200);
    expect(await readOf(plnId("messages", project.id, bob.id))).toBe(true);
  });

  it("`seen` ids clear mention and reply rows for a non-participant", async () => {
    const owner = await createPipelineUser({ name: "Owner", tag: "ack-o3" });
    const zed = await createPipelineUser({ name: "Zed", tag: "ack-z" });
    const project = await createProjectFixture({ ownerId: owner.id });
    const msg = await post(owner.id, project.id, "hello");
    const mid = msg.body.data.message.id;
    await direct(zed.id, plnId("mention", mid, zed.id), "mention", project.id);
    await direct(zed.id, plnId("reply", mid), "reply", project.id);
    const s = await sync(zed.id, project.id, { seq: 1, seen: [mid] });
    expect(s.status).toBe(200);
    expect(await readOf(plnId("mention", mid, zed.id))).toBe(true);
    expect(await readOf(plnId("reply", mid))).toBe(true);
  });

  it("route #21 (POST /read) clears the project-level rows too", async () => {
    const owner = await createPipelineUser({ name: "Owner", tag: "ack-o4" });
    const bob = await createPipelineUser({ name: "Bob", tag: "ack-b4" });
    const project = await createProjectFixture({ ownerId: owner.id, memberIds: [bob.id] });
    await post(owner.id, project.id, "one");
    const r = await request(app).post(`/v1/pipeline/projects/${project.id}/read`).set(auth(bob.id)).send({ seq: 1 });
    expect(r.status).toBe(200);
    expect(await readOf(plnId("messages", project.id, bob.id))).toBe(true);
  });

  it("an admin with 5,000 unread GENERAL rows: EXPLAIN on A1 shows index/PK access only", async () => {
    const admin = await createPipelineUser({ name: "Ada", tag: "ack-adm", roleNames: ["Admin"] });
    const project = await createProjectFixture({ ownerId: admin.id });
    await pipelineDb.$executeRaw`
      INSERT INTO notifications (id, user_id, type, title, message, read, created_at)
      SELECT gen_random_uuid()::text, ${admin.id}, 'GENERAL'::"NotificationType", 't', 'm', false, timezone('utc', now())
        FROM generate_series(1, 5000)`;
    // Background volume from everyone else (production holds far more than this).
    const filler = await createPipelineUser({ name: "Filler", tag: "ack-fill" });
    await pipelineDb.$executeRaw`
      INSERT INTO notifications (id, user_id, type, title, message, read, created_at)
      SELECT gen_random_uuid()::text, ${filler.id}, 'GENERAL'::"NotificationType", 't', 'm', g % 2 = 0, timezone('utc', now())
        FROM generate_series(1, 45000) g`;
    await pipelineDb.$executeRawUnsafe(`ANALYZE notifications`);
    const seen = Array.from({ length: 50 }, () => randomUUID());
    const plan = await pipelineDb.$queryRaw<Array<{ "QUERY PLAN": string }>>(
      ackStatement({ projectId: project.id, userId: admin.id, seq: 1, leaving: false, seen }, "EXPLAIN"),
    );
    const text = plan.map((r) => r["QUERY PLAN"]).join("\n");
    expect(text).not.toMatch(/Seq Scan on notifications/);
    expect(text).toMatch(/notifications_pkey/);
  });
});
