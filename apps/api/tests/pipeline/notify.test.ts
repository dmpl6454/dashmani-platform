/**
 * pipeline/notify.test.ts — the real notifier (spec §7.4–§7.7, §7.9, §7.11), driven
 * through the routes so every row is written inside the action's own transaction.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "crypto";
import { prisma } from "@dashmani/db";
import app from "../../src/app";
import { resetPipelineStateForTests } from "../../src/services/pipeline";
import { pipelineDb } from "../../src/services/pipeline/db";
import { plnId } from "../../src/services/pipeline/notify";
import { hrToken, tokenFor, setPipelineSetting, clearPipelineSettings, createPipelineUser, seedPipelinePhases } from "./pipeline-helpers";
import { createProjectFixture, addParticipantFixture, phaseIdOf, mention } from "./fixtures-messages";

const auth = (userId: string) => ({ Authorization: `Bearer ${hrToken(userId)}` });
type Meta = Record<string, unknown>;

async function rows(where: Record<string, unknown> = {}) {
  return prisma.notification.findMany({ where: { type: "PIPELINE", ...where }, orderBy: { createdAt: "asc" } });
}
const meta = (r: { metadata: unknown }) => (r.metadata ?? {}) as Meta;

describe("pipeline notifications", () => {
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
  const move = (uid: string, pid: string, toPhaseId: string, basePhaseId: string) =>
    request(app).post(`/v1/pipeline/projects/${pid}/move`).set(auth(uid)).send({ toPhaseId, afterId: null, basePhaseId });

  async function setup(extra: Array<{ name: string; status?: "INACTIVE"; deleted?: boolean }> = []) {
    const owner = await createPipelineUser({ name: "Priya Owner", tag: "n-owner" });
    const bob = await createPipelineUser({ name: "Bob Member", tag: "n-bob" });
    const others = [];
    for (const e of extra) others.push(await createPipelineUser({ name: e.name, tag: "n-x", status: e.status, deleted: e.deleted }));
    const project = await createProjectFixture({
      ownerId: owner.id,
      title: "Diwali campaign",
      memberIds: [bob.id, ...others.map((o) => o.id)],
    });
    return { owner, bob, others, project };
  }

  describe("grouped rows (§7.4)", () => {
    it("3 messages give one row with n=3; read it, post again, and n=1 is unread", async () => {
      const { owner, bob, project } = await setup();
      for (const t of ["one", "two", "three"]) expect((await post(owner.id, project.id, t)).status).toBe(201);
      let mine = await rows({ userId: bob.id });
      expect(mine).toHaveLength(1);
      expect(mine[0].id).toBe(plnId("messages", project.id, bob.id));
      expect(meta(mine[0])).toMatchObject({ v: 1, kind: "messages", pid: project.id, n: 3, seq: 3, app: "hr" });
      expect(mine[0].title).toBe("“Diwali campaign”: 3 new messages");
      expect(mine[0].message).toBe("Priya Owner: three");
      expect(String(meta(mine[0]).url)).toMatch(new RegExp(`/pipeline/${project.id}$`));
      // Nobody notifies themselves.
      expect(await rows({ userId: owner.id })).toHaveLength(0);

      await prisma.notification.update({ where: { id: mine[0].id }, data: { read: true } });
      expect((await post(owner.id, project.id, "four")).status).toBe(201);
      mine = await rows({ userId: bob.id });
      expect(mine).toHaveLength(1);
      expect(mine[0].read).toBe(false);
      expect(meta(mine[0]).n).toBe(1);
      expect(mine[0].title).toBe("“Diwali campaign”: 1 new message");
    });

    it("an active reader (seen_at < 45 s) is not bumped", async () => {
      const { owner, bob, project } = await setup();
      await pipelineDb.pipelineParticipant.update({
        where: { projectId_userId: { projectId: project.id, userId: bob.id } },
        data: { seenAt: new Date() },
      });
      expect((await post(owner.id, project.id, "hello")).status).toBe(201);
      expect(await rows({ userId: bob.id })).toHaveLength(0);
      await pipelineDb.pipelineParticipant.update({
        where: { projectId_userId: { projectId: project.id, userId: bob.id } },
        data: { seenAt: new Date(Date.now() - 60_000) },
      });
      expect((await post(owner.id, project.id, "again")).status).toBe(201);
      expect(await rows({ userId: bob.id })).toHaveLength(1);
    });
  });

  describe("mentions and replies (§7.5)", () => {
    it("a mention gets its own row and is excluded from the grouped row", async () => {
      const { owner, bob, others, project } = await setup([{ name: "Cara Third" }]);
      const cara = others[0];
      const r = await post(owner.id, project.id, `hey ${mention(bob.id)} look`);
      expect(r.status).toBe(201);
      const mid = r.body.data.message.id;
      const b = await rows({ userId: bob.id });
      expect(b.map((x) => x.id)).toEqual([plnId("mention", mid, bob.id)]);
      expect(b[0].title).toBe("Priya Owner mentioned you in “Diwali campaign”");
      expect(b[0].message).toBe("“hey @Bob Member look”");
      expect(meta(b[0])).toMatchObject({ kind: "mention", pid: project.id, mid, seq: 1 });
      expect(String(meta(b[0]).path)).toBe(`/pipeline/${project.id}?m=${mid}`);
      // Cara (not mentioned) gets the grouped row.
      expect((await rows({ userId: cara.id })).map((x) => x.id)).toEqual([plnId("messages", project.id, cara.id)]);
    });

    it("an explicit unfollow is kept, but a mention still notifies", async () => {
      const { owner, bob, project } = await setup();
      const f = await request(app).put(`/v1/pipeline/projects/${project.id}/follow`).set(auth(bob.id)).send({ following: false });
      expect(f.status).toBe(200);
      expect((await post(owner.id, project.id, "plain")).status).toBe(201);
      expect(await rows({ userId: bob.id })).toHaveLength(0);
      const r = await post(owner.id, project.id, `ping ${mention(bob.id)}`);
      expect(r.status).toBe(201);
      expect((await rows({ userId: bob.id })).map((x) => meta(x).kind)).toEqual(["mention"]);
      const part = await pipelineDb.pipelineParticipant.findUniqueOrThrow({
        where: { projectId_userId: { projectId: project.id, userId: bob.id } },
      });
      expect(part.notify).toBe(false);
    });

    it("a reply goes to the root author, except when the root author is the replier", async () => {
      const { owner, bob, project } = await setup();
      const root = await post(bob.id, project.id, "root by bob");
      const rootId = root.body.data.message.id;
      await prisma.notification.deleteMany({ where: { type: "PIPELINE" } });
      const reply = await post(owner.id, project.id, "reply by owner", rootId);
      expect(reply.status).toBe(201);
      const replyId = reply.body.data.message.id;
      const b = await rows({ userId: bob.id });
      expect(b.map((x) => x.id)).toEqual([plnId("reply", replyId)]);
      expect(b[0].title).toBe("Priya Owner replied to your message in “Diwali campaign”");
      expect(meta(b[0])).toMatchObject({ kind: "reply", mid: replyId, rid: rootId, seq: 2 });
      expect(String(meta(b[0]).path)).toBe(`/pipeline/${project.id}?m=${replyId}&t=${rootId}`);

      await prisma.notification.deleteMany({ where: { type: "PIPELINE" } });
      const self = await post(bob.id, project.id, "bob replies to himself", rootId);
      expect(self.status).toBe(201);
      expect(await rows({ userId: bob.id })).toHaveLength(0);
      expect((await rows({ userId: owner.id })).map((x) => meta(x).kind)).toEqual(["messages"]);
    });
  });

  describe("recipients (§7.3)", () => {
    it("exclude the actor, inactive and deleted users, and every non-participant admin", async () => {
      const { owner, bob, others, project } = await setup([
        { name: "Ina Inactive", status: "INACTIVE" },
        { name: "Del Deleted", deleted: true },
      ]);
      const admin = await createPipelineUser({ name: "Ada Admin", tag: "n-admin", roleNames: ["Admin"] });
      expect((await post(owner.id, project.id, "hello all")).status).toBe(201);
      const users = (await rows()).map((r) => r.userId);
      expect(users).toEqual([bob.id]);
      expect(users).not.toContain(admin.id);
      expect(users).not.toContain(others[0].id);
      expect(users).not.toContain(others[1].id);
    });

    it("exclude non-pilot users in pilot mode", async () => {
      const { owner, bob, others, project } = await setup([{ name: "Non Pilot" }]);
      await setPipelineSetting("pipeline.mode", "pilot");
      await setPipelineSetting("pipeline.pilotUserIds", JSON.stringify([owner.id, bob.id]));
      resetPipelineStateForTests();
      expect((await post(owner.id, project.id, "pilot only")).status).toBe(201);
      expect((await rows()).map((r) => r.userId)).toEqual([bob.id]);
      expect(await rows({ userId: others[0].id })).toHaveLength(0);
    });
  });

  describe("moves (§7.6)", () => {
    async function moveSetup() {
      const s = await setup();
      const brief = await phaseIdOf("brief");
      const planning = await phaseIdOf("planning");
      const review = await phaseIdOf("review");
      return { ...s, brief, planning, review };
    }
    const moved = (uid: string) => rows({ userId: uid });

    it("same actor under 2 minutes merges into one row; the text keeps the generation's origin", async () => {
      const { owner, bob, project, brief, planning, review } = await moveSetup();
      expect((await move(owner.id, project.id, planning, brief)).status).toBe(200);
      expect((await move(owner.id, project.id, review, planning)).status).toBe(200);
      const m = await moved(bob.id);
      expect(m).toHaveLength(1);
      expect(m[0].id).toBe(plnId("moved", project.id, bob.id, "1"));
      expect(m[0].title).toBe("Priya Owner moved “Diwali campaign” to Review");
      expect(m[0].message).toBe("From Brief → Review");
      expect(meta(m[0])).toMatchObject({ kind: "moved", pid: project.id });
    });

    it("a different actor starts a new generation", async () => {
      const { owner, bob, project, brief, planning, review } = await moveSetup();
      expect((await move(owner.id, project.id, planning, brief)).status).toBe(200);
      expect((await move(bob.id, project.id, review, planning)).status).toBe(200);
      expect((await moved(bob.id)).map((r) => r.id)).toEqual([plnId("moved", project.id, bob.id, "1")]);
      expect((await moved(owner.id)).map((r) => r.id)).toEqual([plnId("moved", project.id, owner.id, "2")]);
    });

    it("over 2 minutes idle, or past the 10-minute cap, starts a new generation", async () => {
      const { owner, bob, project, brief, planning, review } = await moveSetup();
      expect((await move(owner.id, project.id, planning, brief)).status).toBe(200);
      await pipelineDb.$executeRaw`UPDATE pipeline_projects SET move_last_at = move_last_at - interval '3 minutes' WHERE id = ${project.id}`;
      expect((await move(owner.id, project.id, review, planning)).status).toBe(200);
      expect(await moved(bob.id)).toHaveLength(2);
      await pipelineDb.$executeRaw`
        UPDATE pipeline_projects SET move_started_at = timezone('utc', now()) - interval '11 minutes',
               move_last_at = timezone('utc', now()) - interval '30 seconds' WHERE id = ${project.id}`;
      expect((await move(owner.id, project.id, planning, review)).status).toBe(200);
      expect((await moved(bob.id)).map((r) => r.id).sort()).toEqual(
        ["1", "2", "3"].map((g) => plnId("moved", project.id, bob.id, g)).sort(),
      );
    });

    it("a net-zero move deletes the unread row; a same-phase reorder sends nothing", async () => {
      const { owner, bob, project, brief, planning } = await moveSetup();
      expect((await move(owner.id, project.id, planning, brief)).status).toBe(200);
      expect(await moved(bob.id)).toHaveLength(1);
      expect((await move(owner.id, project.id, brief, planning)).status).toBe(200);
      expect(await moved(bob.id)).toHaveLength(0);
      const other = await createProjectFixture({ ownerId: owner.id, memberIds: [bob.id], phaseKey: "brief" });
      expect((await request(app)
        .post(`/v1/pipeline/projects/${project.id}/move`)
        .set(auth(owner.id))
        .send({ toPhaseId: brief, afterId: other.id, basePhaseId: brief })).status).toBe(200);
      expect(await rows()).toHaveLength(0);
    });
  });

  describe("added (§7.7)", () => {
    it("create notifies added members (never the creator); a re-add within 24 h does not re-notify", async () => {
      const owner = await createPipelineUser({ name: "Rahul Owner", tag: "a-owner" });
      const bob = await createPipelineUser({ name: "Bob Added", tag: "a-bob" });
      const planning = await phaseIdOf("planning");
      const c = await request(app).post("/v1/pipeline/projects").set(auth(owner.id)).send({
        clientId: randomUUID(),
        title: "Diwali campaign",
        phaseId: planning,
        dueDate: "2026-09-26",
        memberIds: [bob.id],
      });
      expect(c.status).toBe(201);
      const pid = c.body.data.card.id;
      const b = await rows({ userId: bob.id });
      expect(b.map((x) => x.id)).toEqual([plnId("added", pid, bob.id)]);
      expect(b[0].title).toBe("Rahul Owner added you to “Diwali campaign”");
      expect(b[0].message).toBe("Phase: Planning · due Sat 26 Sep");
      expect(await rows({ userId: owner.id })).toHaveLength(0);
      const createdAt = b[0].createdAt;

      await prisma.notification.update({ where: { id: b[0].id }, data: { read: true } });
      expect((await request(app).delete(`/v1/pipeline/projects/${pid}/members/${bob.id}`).set(auth(owner.id))).status).toBe(200);
      const re = await request(app).post(`/v1/pipeline/projects/${pid}/members`).set(auth(owner.id)).send({ userIds: [bob.id] });
      expect(re.status).toBe(200);
      const after = await rows({ userId: bob.id });
      expect(after).toHaveLength(1);
      expect(after[0].read).toBe(true);
      expect(after[0].createdAt.getTime()).toBe(createdAt.getTime());
    });
  });

  describe("redaction (§7.11) and text (§7.9)", () => {
    it("after a delete no notification row for any user contains the text; an edit rewrites snippets", async () => {
      const { owner, bob, others, project } = await setup([{ name: "Cara Third" }]);
      const cara = others[0];
      const root = await post(bob.id, project.id, "bob's root");
      const rootId = root.body.data.message.id;
      const r = await post(owner.id, project.id, `secret plan ${mention(cara.id)}`, rootId);
      expect(r.status).toBe(201);
      const mid = r.body.data.message.id;
      expect((await rows()).some((x) => x.message.includes("secret plan"))).toBe(true);

      const e = await request(app).patch(`/v1/pipeline/messages/${mid}`).set(auth(owner.id)).send({ body: `edited words ${mention(cara.id)}` });
      expect(e.status).toBe(200);
      let all = await rows();
      expect(all.some((x) => x.message.includes("secret plan"))).toBe(false);
      expect((await rows({ id: plnId("mention", mid, cara.id) }))[0].message).toContain("edited words");
      expect((await rows({ id: plnId("reply", mid) }))[0].message).toContain("edited words");

      const d = await request(app).delete(`/v1/pipeline/messages/${mid}`).set(auth(owner.id));
      expect(d.status).toBe(200);
      all = await rows();
      expect(all.some((x) => x.message.includes("edited words") || x.title.includes("edited words"))).toBe(false);
      expect(await rows({ userId: cara.id, id: plnId("mention", mid, cara.id) })).toHaveLength(0);
      expect(await rows({ id: plnId("reply", mid) })).toHaveLength(0);
    });

    it("an edit that drops a mention deletes that user's mention row (a later leave + delete can't strand it)", async () => {
      const { owner, others, project } = await setup([{ name: "Cara Third" }]);
      const cara = others[0];
      const r = await post(owner.id, project.id, `plan for ${mention(cara.id)}`);
      const mid = r.body.data.message.id;
      expect(await rows({ id: plnId("mention", mid, cara.id) })).toHaveLength(1);
      const e = await request(app).patch(`/v1/pipeline/messages/${mid}`).set(auth(owner.id)).send({ body: "plan for later" });
      expect(e.status).toBe(200);
      expect(await rows({ id: plnId("mention", mid, cara.id) })).toHaveLength(0);
    });

    it("leaving a project removes your grouped row, so its preview can't outlive a later delete", async () => {
      const { owner, bob, project } = await setup();
      const r = await post(owner.id, project.id, "private words");
      expect(r.status).toBe(201);
      expect(await rows({ id: plnId("messages", project.id, bob.id) })).toHaveLength(1);
      const left = await request(app).delete(`/v1/pipeline/projects/${project.id}/members/${bob.id}`).set(auth(bob.id));
      expect(left.status).toBe(200);
      expect(await rows({ userId: bob.id })).toHaveLength(0);
      expect((await request(app).delete(`/v1/pipeline/messages/${r.body.data.message.id}`).set(auth(owner.id))).status).toBe(200);
      expect((await rows({ userId: bob.id })).some((x) => x.message.includes("private words"))).toBe(false);
    });

    it("a grouped preview from a deleted message is rewritten; a project delete removes grouped rows", async () => {
      const { owner, bob, project } = await setup();
      const r = await post(owner.id, project.id, "to be deleted");
      const mid = r.body.data.message.id;
      expect((await request(app).delete(`/v1/pipeline/messages/${mid}`).set(auth(owner.id))).status).toBe(200);
      expect((await rows({ userId: bob.id }))[0].message).toBe("Priya Owner deleted a message");
      const del = await request(app).delete(`/v1/pipeline/projects/${project.id}`).set(auth(owner.id)).send({ confirmTitle: "Diwali campaign" });
      expect(del.status).toBe(200);
      expect(await rows({ userId: bob.id })).toHaveLength(0);
    });

    it("snippets never contain @{ or a lone surrogate", async () => {
      const { owner, bob, project } = await setup();
      const odd = `@{not-a-token} ${mention(bob.id)} \u202E flip ${"😀".repeat(80)}\uD83D`;
      expect((await post(owner.id, project.id, odd)).status).toBe(201);
      await addParticipantFixture(project.id, (await createPipelineUser({ name: "Zed", tag: "n-z" })).id);
      expect((await post(owner.id, project.id, odd)).status).toBe(201);
      const all = await rows();
      expect(all.length).toBeGreaterThan(0);
      for (const n of all) {
        for (const s of [n.title, n.message]) {
          expect(s).not.toContain("@{");
          expect(s).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
        }
        expect([...n.title].length).toBeLessThanOrEqual(120);
        expect([...n.message].length).toBeLessThanOrEqual(200);
      }
    });
  });

  describe("bell endpoints (§7.1: unchanged)", () => {
    it("the key sets of /hr/notifications and /admin/notifications are unchanged", async () => {
      const { owner, bob, project } = await setup();
      expect((await post(owner.id, project.id, "for the bell")).status).toBe(201);
      const hr = await request(app).get("/v1/hr/notifications").set(auth(bob.id));
      expect(hr.status).toBe(200);
      const list = hr.body.data;
      expect(Object.keys(hr.body).sort()).toMatchInlineSnapshot(`
        [
          "data",
          "success",
        ]
      `);
      expect(Object.keys(list[0]).sort()).toMatchInlineSnapshot(`
        [
          "createdAt",
          "id",
          "message",
          "metadata",
          "read",
          "title",
          "type",
          "userId",
        ]
      `);
      const adminUser = await createPipelineUser({ name: "Ada", tag: "n-adm", roleNames: ["Admin"] });
      await prisma.notification.create({ data: { userId: adminUser.id, type: "GENERAL", title: "t", message: "m" } });
      const admin = await request(app)
        .get("/v1/admin/notifications")
        .set({ Authorization: `Bearer ${tokenFor(adminUser.id, "employee", { roles: ["Admin"] })}` });
      expect(admin.status).toBe(200);
      expect(Object.keys(admin.body).sort()).toMatchInlineSnapshot(`
        [
          "data",
          "success",
        ]
      `);
      expect(Object.keys(admin.body.data[0]).sort()).toMatchInlineSnapshot(`
        [
          "createdAt",
          "id",
          "message",
          "metadata",
          "read",
          "title",
          "type",
          "userId",
        ]
      `);
    });
  });
});
