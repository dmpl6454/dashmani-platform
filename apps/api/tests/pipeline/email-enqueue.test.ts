/**
 * pipeline/email-enqueue.test.ts — the enqueue half of pipeline email (owner request
 * 2026-09-30): which events write outbox rows, for whom, how they coalesce, and the new
 * in-portal `due_changed` bell row. Driven through the routes, so every row is written in
 * the action's own transaction.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import request from "supertest";
import { randomUUID } from "crypto";
import { prisma } from "@dashmani/db";
import app from "../../src/app";
import { resetPipelineStateForTests } from "../../src/services/pipeline";
import { pipelineDb, Prisma } from "../../src/services/pipeline/db";
import { plnId } from "../../src/services/pipeline/notify";
import { EMAIL_MENTION_IDS_MAX, mergePayloadSql, mergePayloadTs } from "../../src/services/pipeline/email-outbox";
import { __setPipelineEmailSchemaOkForTests } from "../../src/services/pipeline/self-check";
import { runPipelineDueTick } from "../../src/cron/pipeline-due.cron";
import {
  hrToken,
  setPipelineSetting,
  clearPipelineSettings,
  createPipelineUser,
  seedPipelinePhases,
  ensurePipelineEmailSchema,
} from "./pipeline-helpers";
import { createProjectFixture, addParticipantFixture, phaseIdOf, mention } from "./fixtures-messages";

const auth = (userId: string) => ({ Authorization: `Bearer ${hrToken(userId)}` });
type Json = Record<string, unknown>;

const outbox = (where: Record<string, unknown> = {}) =>
  prisma.pipelineEmailOutbox.findMany({ where, orderBy: [{ userId: "asc" }, { createdAt: "asc" }] });

describe("pipeline email — enqueue", () => {
  beforeAll(async () => {
    await ensurePipelineEmailSchema();
  });
  beforeEach(async () => {
    resetPipelineStateForTests();
    await clearPipelineSettings();
    await seedPipelinePhases();
    await setPipelineSetting("pipeline.mode", "on");
    await setPipelineSetting("pipeline.email", "on");
    vi.stubEnv("SMTP_USER", "pipeline-test@example.test");
    vi.stubEnv("SMTP_PASS", "not-a-real-password");
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await clearPipelineSettings();
    resetPipelineStateForTests();
    await pipelineDb.$disconnect();
  });

  const move = (uid: string, pid: string, toKey: string, fromKey: string) =>
    Promise.all([phaseIdOf(toKey), phaseIdOf(fromKey)]).then(([to, from]) =>
      request(app).post(`/v1/pipeline/projects/${pid}/move`).set(auth(uid)).send({ toPhaseId: to, afterId: null, basePhaseId: from }),
    );
  const post = (uid: string, pid: string, body: string) =>
    request(app).post(`/v1/pipeline/projects/${pid}/messages`).set(auth(uid)).send({ clientId: randomUUID(), body });
  const patchDue = (uid: string, pid: string, from: string | null, to: string | null) =>
    request(app)
      .patch(`/v1/pipeline/projects/${pid}`)
      .set(auth(uid))
      .send({ changes: { dueDate: to }, base: { dueDate: from } });

  async function team() {
    const priya = await createPipelineUser({ name: "Priya Owner", tag: "em-priya" });
    const bob = await createPipelineUser({ name: "Bob Member", tag: "em-bob" });
    const cara = await createPipelineUser({ name: "Cara Unfollowed", tag: "em-cara" });
    const dan = await createPipelineUser({ name: "Dan Inactive", tag: "em-dan" });
    const project = await createProjectFixture({ ownerId: priya.id, title: "Diwali campaign", memberIds: [bob.id, cara.id, dan.id] });
    await pipelineDb.pipelineParticipant.update({
      where: { projectId_userId: { projectId: project.id, userId: cara.id } },
      data: { notify: false },
    });
    await prisma.user.update({ where: { id: dan.id }, data: { status: "INACTIVE" } });
    return { priya, bob, cara, dan, project };
  }

  describe("moved (a)", () => {
    it("queues ONE row per notify=true, ACTIVE participant — never the actor — and 3 moves coalesce into it", async () => {
      const { priya, bob, project } = await team();
      expect((await move(priya.id, project.id, "planning", "brief")).status).toBe(200);
      let rows = await outbox();
      expect(rows.map((r) => [r.userId, r.kind, r.status])).toEqual([[bob.id, "moved", "pending"]]);
      const first = rows[0];
      expect(first.payload).toEqual({ fromPhaseId: await phaseIdOf("brief"), actorIds: [priya.id] });
      // Settles 3 minutes before it may be sent.
      expect(first.sendAfter.getTime() - first.createdAt.getTime()).toBe(3 * 60_000);

      expect((await move(priya.id, project.id, "review", "planning")).status).toBe(200);
      expect((await move(priya.id, project.id, "approved", "review")).status).toBe(200);
      rows = await outbox();
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(first.id);
      // The FIRST from-phase is kept (the email compares it with the phase at send time)
      // and send_after is NOT pushed back by the burst.
      expect((rows[0].payload as Json).fromPhaseId).toBe(await phaseIdOf("brief"));
      expect(rows[0].sendAfter.getTime()).toBe(first.sendAfter.getTime());
    });

    it("a reorder inside a phase queues nothing", async () => {
      const { priya, project } = await team();
      const brief = await phaseIdOf("brief");
      const r = await request(app)
        .post(`/v1/pipeline/projects/${project.id}/move`)
        .set(auth(priya.id))
        .send({ toPhaseId: brief, afterId: null, basePhaseId: brief });
      expect(r.status).toBe(200);
      expect(await outbox()).toHaveLength(0);
    });

    it("pilot mode: only allowlisted recipients", async () => {
      const { priya, bob, project } = await team();
      const eve = await createPipelineUser({ name: "Eve Outside", tag: "em-eve" });
      await addParticipantFixture(project.id, eve.id, { role: "MEMBER" });
      await setPipelineSetting("pipeline.mode", "pilot");
      await setPipelineSetting("pipeline.pilotUserIds", JSON.stringify([priya.id, bob.id]));
      resetPipelineStateForTests();
      expect((await move(priya.id, project.id, "planning", "brief")).status).toBe(200);
      expect((await outbox()).map((r) => r.userId)).toEqual([bob.id]);
    });

    it("the mover's own pending row is withdrawn when they move the card themselves", async () => {
      const { priya, bob, project } = await team();
      await move(priya.id, project.id, "planning", "brief");
      expect((await outbox()).map((r) => r.userId)).toEqual([bob.id]);
      await move(bob.id, project.id, "review", "planning");
      const rows = await outbox();
      expect(rows.map((r) => r.userId)).toEqual([priya.id]);
      expect(rows[0].payload).toEqual({ fromPhaseId: await phaseIdOf("planning"), actorIds: [bob.id] });
    });
  });

  describe("mention (b)", () => {
    it("the mentioned user gets a row even after an unfollow; mentions in one project coalesce", async () => {
      const { priya, cara, bob, project } = await team();
      const m1 = await post(priya.id, project.id, `please check ${mention(cara.id)}`);
      expect(m1.status).toBe(201);
      let rows = await outbox({ kind: "mention" });
      expect(rows.map((r) => r.userId)).toEqual([cara.id]);
      expect(rows[0].payload).toEqual({ messageIds: [m1.body.data.message.id] });
      expect(rows[0].sendAfter.getTime() - rows[0].createdAt.getTime()).toBe(2 * 60_000);
      const firstSendAfter = rows[0].sendAfter.getTime();

      const m2 = await post(bob.id, project.id, `${mention(cara.id)} and again`);
      expect(m2.status).toBe(201);
      rows = await outbox({ kind: "mention" });
      expect(rows).toHaveLength(1);
      expect((rows[0].payload as Json).messageIds).toEqual([m1.body.data.message.id, m2.body.data.message.id]);
      expect(rows[0].sendAfter.getTime()).toBe(firstSendAfter);
      // A plain message (no mention) emails nobody.
      await post(priya.id, project.id, "no mention here");
      expect(await outbox({ kind: "mention" })).toHaveLength(1);
      expect(await outbox({ kind: { not: "mention" } })).toHaveLength(0);
    });

    it("self-mentions, inactive users and non-pilot users get nothing", async () => {
      const { priya, dan, project } = await team();
      const r = await post(priya.id, project.id, `${mention(priya.id)} ${mention(dan.id)}`);
      expect(r.status).toBe(201);
      expect(await outbox()).toHaveLength(0);
    });

    it("an edit that ADDS a mention queues it; re-saving an unchanged mention does not duplicate", async () => {
      const { priya, bob, project } = await team();
      const r = await post(priya.id, project.id, "draft");
      const mid = r.body.data.message.id;
      expect(await outbox()).toHaveLength(0);
      expect((await request(app).patch(`/v1/pipeline/messages/${mid}`).set(auth(priya.id)).send({ body: `now ${mention(bob.id)}` })).status).toBe(200);
      let rows = await outbox({ kind: "mention" });
      expect(rows.map((x) => [x.userId, (x.payload as Json).messageIds])).toEqual([[bob.id, [mid]]]);
      expect((await request(app).patch(`/v1/pipeline/messages/${mid}`).set(auth(priya.id)).send({ body: `now ${mention(bob.id)}!` })).status).toBe(200);
      rows = await outbox({ kind: "mention" });
      expect(rows).toHaveLength(1);
      expect((rows[0].payload as Json).messageIds).toEqual([mid]);
    });

    it(`keeps the latest ${EMAIL_MENTION_IDS_MAX} message ids`, async () => {
      const { priya, bob, project } = await team();
      const ids: string[] = [];
      for (let i = 0; i < EMAIL_MENTION_IDS_MAX + 3; i++) {
        const r = await post(priya.id, project.id, `${mention(bob.id)} #${i}`);
        ids.push(r.body.data.message.id);
      }
      const [row] = await outbox({ kind: "mention" });
      expect((row.payload as Json).messageIds).toEqual(ids.slice(3));
    });
  });

  describe("due date changed (d) — in-portal row + email", () => {
    it("writes the bell row, re-arms it in place, clears it on project open, and coalesces the email keeping the first date", async () => {
      const { priya, bob, cara, project } = await team();
      expect((await patchDue(priya.id, project.id, null, "2026-09-28")).status).toBe(200);
      const rowId = plnId("due_changed", project.id, bob.id);
      let bell = await prisma.notification.findUnique({ where: { id: rowId } });
      expect(bell).toMatchObject({ userId: bob.id, type: "PIPELINE", read: false, message: "Phase: Brief" });
      expect(bell!.title).toBe("Priya Owner set the due date of “Diwali campaign” to Mon 28 Sep");
      expect(bell!.metadata).toMatchObject({ v: 1, kind: "due_changed", pid: project.id, from: null, to: "2026-09-28" });
      // Cara unfollowed, Dan is inactive, Priya acted: only Bob.
      expect((await prisma.notification.findMany({ where: { type: "PIPELINE" } })).map((n) => n.userId)).toEqual([bob.id]);
      expect(await prisma.notification.count({ where: { userId: cara.id } })).toBe(0);

      let mail = await outbox();
      expect(mail.map((r) => [r.userId, r.kind])).toEqual([[bob.id, "due_changed"]]);
      expect(mail[0].payload).toEqual({ fromDue: null, actorIds: [priya.id] });

      await prisma.notification.update({ where: { id: rowId }, data: { read: true } });
      expect((await patchDue(priya.id, project.id, "2026-09-28", "2026-10-03")).status).toBe(200);
      bell = await prisma.notification.findUnique({ where: { id: rowId } });
      expect(bell!.read).toBe(false); // re-armed in place
      expect(bell!.title).toBe("Priya Owner changed the due date of “Diwali campaign” to Sat 3 Oct (was Mon 28 Sep)");

      mail = await outbox();
      expect(mail).toHaveLength(1);
      expect((mail[0].payload as Json).fromDue).toBeNull(); // the FIRST from-date is kept

      expect((await patchDue(priya.id, project.id, "2026-10-03", null)).status).toBe(200);
      bell = await prisma.notification.findUnique({ where: { id: rowId } });
      expect(bell!.title).toBe("Priya Owner removed the due date of “Diwali campaign” (was Sat 3 Oct)");

      // Opening the project (the sync ack) clears it, like added / moved / due rows.
      const ack = await request(app)
        .post("/v1/pipeline/sync")
        .set(auth(bob.id))
        .send({ clientBuild: 1, project: { id: project.id, rev: 0, hv: 0, ack: { seq: 0, open: true } } });
      expect(ack.status).toBe(200);
      expect((await prisma.notification.findUnique({ where: { id: rowId } }))!.read).toBe(true);
    });

    it("a PATCH that does not touch the due date writes no due_changed row and queues nothing", async () => {
      const { priya, project } = await team();
      const r = await request(app)
        .patch(`/v1/pipeline/projects/${project.id}`)
        .set(auth(priya.id))
        .send({ changes: { title: "Renamed" }, base: { title: "Diwali campaign" } });
      expect(r.status).toBe(200);
      expect(await prisma.notification.count({ where: { type: "PIPELINE" } })).toBe(0);
      expect(await outbox()).toHaveLength(0);
    });

    it("keeps the dates visible when the names and title are long", async () => {
      const { dueChangedTitle } = await import("../../src/services/pipeline/notify");
      const t = dueChangedTitle("A".repeat(60), "T".repeat(120), "2026-09-28", "2026-10-03");
      expect(Array.from(t).length).toBeLessThanOrEqual(120);
      expect(t.endsWith("to Sat 3 Oct (was Mon 28 Sep)")).toBe(true);
    });
  });

  describe("due soon (c) — the due cron", () => {
    it("queues an immediate due_soon row per notify=true participant", async () => {
      const { priya, bob, project } = await team();
      await pipelineDb.$executeRaw`UPDATE pipeline_projects SET due_date = DATE '2026-09-30' WHERE id = ${project.id}`;
      const r = await runPipelineDueTick({ now: new Date("2026-09-29T10:00:00.000+05:30") });
      expect(r).toMatchObject({ status: "ran", dueSoon: 1 });
      const rows = await outbox();
      expect(rows.map((x) => [x.userId, x.kind])).toEqual([
        [priya.id, "due_soon"],
        [bob.id, "due_soon"],
      ].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
      for (const x of rows) {
        expect(x.payload).toEqual({ due: "2026-09-30" });
        expect(x.sendAfter.getTime()).toBe(x.createdAt.getTime());
      }
    });
  });

  describe("gating — email ships dark", () => {
    it("nothing is queued with pipeline.email absent, without SMTP, or without the email schema — and the action still succeeds", async () => {
      const { priya, bob, project } = await team();
      await prisma.systemSetting.deleteMany({ where: { key: "pipeline.email" } });
      resetPipelineStateForTests();
      expect((await move(priya.id, project.id, "planning", "brief")).status).toBe(200);
      expect(await outbox()).toHaveLength(0);

      await setPipelineSetting("pipeline.email", "on");
      resetPipelineStateForTests();
      vi.stubEnv("SMTP_PASS", "");
      expect((await move(priya.id, project.id, "review", "planning")).status).toBe(200);
      expect(await outbox()).toHaveLength(0);
      vi.stubEnv("SMTP_PASS", "not-a-real-password");

      // The self-check found no outbox/partial index: email off, board unaffected.
      resetPipelineStateForTests();
      await request(app).get("/v1/pipeline/bootstrap").set(auth(priya.id)); // runs the self-check
      __setPipelineEmailSchemaOkForTests(false);
      expect((await post(priya.id, project.id, `hi ${mention(bob.id)}`)).status).toBe(201);
      expect((await move(priya.id, project.id, "approved", "review")).status).toBe(200);
      expect(await outbox()).toHaveLength(0);
    });
  });

  describe("the payload merge", () => {
    const cases: Array<[Json, Json]> = [
      [{ fromPhaseId: "p1", actorIds: ["a"] }, { fromPhaseId: "p2", actorIds: ["b"] }],
      [{ fromPhaseId: "p1", actorIds: ["a", "b"] }, { fromPhaseId: "p3", actorIds: ["b", "c", "d", "e", "f"] }],
      [{ fromDue: null, actorIds: ["a"] }, { fromDue: "2026-10-01", actorIds: ["a"] }],
      [{ messageIds: ["m1", "m2"] }, { messageIds: ["m2", "m3"] }],
      [{ messageIds: Array.from({ length: 19 }, (_, i) => `m${i}`) }, { messageIds: ["x", "y", "m3"] }],
      [{ due: "2026-09-30" }, { due: "2026-10-01" }],
    ];
    it("SQL (enqueue ON CONFLICT, requeue) and TypeScript (worker pre-merge) agree", async () => {
      for (const [older, newer] of cases) {
        const [row] = await pipelineDb.$queryRaw<Array<{ merged: Json }>>`
          SELECT ${mergePayloadSql(Prisma.sql`${JSON.stringify(older)}::jsonb`, Prisma.sql`${JSON.stringify(newer)}::jsonb`)} AS merged`;
        expect(row.merged).toEqual(mergePayloadTs(older, newer));
      }
      // The first from-phase; the 5 most recent distinct actors, oldest first.
      expect(mergePayloadTs(cases[1][0], cases[1][1])).toEqual({ fromPhaseId: "p1", actorIds: ["b", "c", "d", "e", "f"] });
      expect(mergePayloadTs(cases[5][0], cases[5][1])).toEqual({ due: "2026-10-01" });
    });
  });
});
