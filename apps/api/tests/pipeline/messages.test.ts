/**
 * pipeline/messages.test.ts — routes #15–20 (spec §3.4, §5.1 k-rule, §6 message rows).
 *
 * Projects are created by direct insert (fixtures-messages.ts): the project routes land
 * in a parallel PR.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "crypto";
import app from "../../src/app";
import { resetPipelineStateForTests } from "../../src/services/pipeline";
import { pipelineDb } from "../../src/services/pipeline/db";
import { hrToken, setPipelineSetting, clearPipelineSettings, createPipelineUser, seedPipelinePhases } from "./pipeline-helpers";
import {
  createProjectFixture,
  addParticipantFixture,
  setProjectState,
  projectRow,
  participantRow,
  messagesOf,
  mention,
} from "./fixtures-messages";

const auth = (userId: string) => ({ Authorization: `Bearer ${hrToken(userId)}` });

describe("pipeline messages", () => {
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

  const post = (userId: string, projectId: string, body: Record<string, unknown>) =>
    request(app).post(`/v1/pipeline/projects/${projectId}/messages`).set(auth(userId)).send(body);

  async function setup() {
    const owner = await createPipelineUser({ name: "Owner One", tag: "msg-owner" });
    const bob = await createPipelineUser({ name: "Bob Two", tag: "msg-bob" });
    const project = await createProjectFixture({ ownerId: owner.id, memberIds: [bob.id] });
    return { owner, bob, project };
  }

  describe("POST /projects/:id/messages (route #17)", () => {
    it("creates a message: 201, seq 1, rev = thread_rev, wire shape with names and clientId", async () => {
      const { owner, project } = await setup();
      const clientId = randomUUID();
      const r = await post(owner.id, project.id, { clientId, body: "  Hello team  " });
      expect(r.status).toBe(201);
      expect(r.headers["cache-control"]).toBe("no-store");
      const d = r.body.data;
      expect(d.replayed).toBe(false);
      expect(d.message).toMatchObject({
        clientId,
        projectId: project.id,
        seq: 1,
        rev: 1,
        parentId: null,
        authorId: owner.id,
        authorName: "Owner One",
        body: "Hello team",
        mentions: [],
        reactions: {},
        replyCount: 0,
        editedAt: null,
        deletedAt: null,
      });
      expect(typeof d.message.createdAt).toBe("string");
      const p = await projectRow(project.id);
      expect(p.lastMessageSeq).toBe(1);
      expect(p.threadRev).toBe(1);
      expect(p.lastMessageAt).not.toBeNull();
    });

    it("the same clientId twice gives one row and replayed:true", async () => {
      const { owner, project } = await setup();
      const clientId = randomUUID();
      const a = await post(owner.id, project.id, { clientId, body: "once" });
      const b = await post(owner.id, project.id, { clientId, body: "once" });
      expect(a.status).toBe(201);
      expect(b.status).toBe(200);
      expect(b.body.data.replayed).toBe(true);
      expect(b.body.data.message.id).toBe(a.body.data.message.id);
      expect(await messagesOf(project.id)).toHaveLength(1);
      expect((await projectRow(project.id)).threadRev).toBe(1);
    });

    it("the same key in another project gives 409 IDEMPOTENCY_KEY_REUSED", async () => {
      const { owner, project } = await setup();
      const other = await createProjectFixture({ ownerId: owner.id });
      const clientId = randomUUID();
      expect((await post(owner.id, project.id, { clientId, body: "x" })).status).toBe(201);
      const r = await post(owner.id, other.id, { clientId, body: "x" });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
      expect(await messagesOf(other.id)).toHaveLength(0);
    });

    it("post, then archive, then retry the same key gives 200 replayed", async () => {
      const { owner, project } = await setup();
      const clientId = randomUUID();
      expect((await post(owner.id, project.id, { clientId, body: "before archive" })).status).toBe(201);
      await setProjectState(project.id, { archived: true });
      const r = await post(owner.id, project.id, { clientId, body: "before archive" });
      expect(r.status).toBe(200);
      expect(r.body.data.replayed).toBe(true);
      // …while a NEW message on the archived project is refused.
      const n = await post(owner.id, project.id, { clientId: randomUUID(), body: "new" });
      expect(n.status).toBe(409);
      expect(n.body.error.code).toBe("PROJECT_ARCHIVED");
    });

    it("a reply increments the root's reply_count and bumps thread_rev by 2 with two distinct revs", async () => {
      const { owner, bob, project } = await setup();
      const root = (await post(owner.id, project.id, { clientId: randomUUID(), body: "root" })).body.data.message;
      const r = await post(bob.id, project.id, { clientId: randomUUID(), body: "reply", parentId: root.id });
      expect(r.status).toBe(201);
      const { message, root: updatedRoot } = r.body.data;
      expect(message.parentId).toBe(root.id);
      expect(message.seq).toBe(2);
      expect(updatedRoot).toMatchObject({ id: root.id, replyCount: 1 });
      expect(updatedRoot.lastReplyAt).not.toBeNull();
      // k = 2: the reply gets r−1, the root r (child first, root last).
      expect(message.rev).toBe(2);
      expect(updatedRoot.rev).toBe(3);
      expect((await projectRow(project.id)).threadRev).toBe(3);
    });

    it("a top-level send bumps thread_rev by 1", async () => {
      const { owner, project } = await setup();
      await post(owner.id, project.id, { clientId: randomUUID(), body: "one" });
      await post(owner.id, project.id, { clientId: randomUUID(), body: "two" });
      const p = await projectRow(project.id);
      expect(p.threadRev).toBe(2);
      expect(p.lastMessageSeq).toBe(2);
    });

    it("a reply to a reply is normalised to the root", async () => {
      const { owner, bob, project } = await setup();
      const root = (await post(owner.id, project.id, { clientId: randomUUID(), body: "root" })).body.data.message;
      const reply = (await post(bob.id, project.id, { clientId: randomUUID(), body: "r1", parentId: root.id })).body.data.message;
      const r = await post(owner.id, project.id, { clientId: randomUUID(), body: "r2", parentId: reply.id });
      expect(r.status).toBe(201);
      expect(r.body.data.message.parentId).toBe(root.id);
      expect(r.body.data.root).toMatchObject({ id: root.id, replyCount: 2 });
    });

    it("a reply to a deleted root gives 409 MESSAGE_DELETED; a parent in another project gives 404", async () => {
      const { owner, project } = await setup();
      const other = await createProjectFixture({ ownerId: owner.id });
      const foreign = (await post(owner.id, other.id, { clientId: randomUUID(), body: "elsewhere" })).body.data.message;
      const cross = await post(owner.id, project.id, { clientId: randomUUID(), body: "x", parentId: foreign.id });
      expect(cross.status).toBe(404);
      expect(cross.body.error.code).toBe("MESSAGE_NOT_FOUND");

      const root = (await post(owner.id, project.id, { clientId: randomUUID(), body: "root" })).body.data.message;
      expect((await request(app).delete(`/v1/pipeline/messages/${root.id}`).set(auth(owner.id))).status).toBe(200);
      const r = await post(owner.id, project.id, { clientId: randomUUID(), body: "late", parentId: root.id });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe("MESSAGE_DELETED");
    });

    it("a soft-deleted or unknown project gives 404", async () => {
      const { owner, project } = await setup();
      await setProjectState(project.id, { deleted: true });
      const r = await post(owner.id, project.id, { clientId: randomUUID(), body: "x" });
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe("PROJECT_NOT_FOUND");
      const u = await post(owner.id, randomUUID(), { clientId: randomUUID(), body: "x" });
      expect(u.status).toBe(404);
    });

    it("an empty body is 400 and more than 20 distinct mentions is 400 MENTION_LIMIT", async () => {
      const { owner, project } = await setup();
      const empty = await post(owner.id, project.id, { clientId: randomUUID(), body: "   " });
      expect(empty.status).toBe(400);
      const many = Array.from({ length: 21 }, () => mention(randomUUID())).join(" ");
      const r = await post(owner.id, project.id, { clientId: randomUUID(), body: many });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("MENTION_LIMIT");
    });

    it("a non-participant author is auto-followed as FOLLOWER, caught up, and header_rev moves", async () => {
      const { owner, project } = await setup();
      const carol = await createPipelineUser({ name: "Carol Three", tag: "msg-carol" });
      await post(owner.id, project.id, { clientId: randomUUID(), body: "first" });
      const before = await projectRow(project.id);
      await post(carol.id, project.id, { clientId: randomUUID(), body: "hi" });
      const row = await participantRow(project.id, carol.id);
      expect(row).toMatchObject({ role: "FOLLOWER", notify: true, lastReadSeq: 2 });
      expect(row!.engagedAt).not.toBeNull();
      const after = await projectRow(project.id);
      expect(after.headerRev).toBe(before.headerRev + 1);
      expect(after.memberCount).toBe(before.memberCount);
    });

    it("the author's marker advances only when they were caught up", async () => {
      const { owner, bob, project } = await setup();
      await post(owner.id, project.id, { clientId: randomUUID(), body: "1" });
      await post(owner.id, project.id, { clientId: randomUUID(), body: "2" });
      // bob has read nothing (0) → posting seq 3 leaves him at 0.
      await post(bob.id, project.id, { clientId: randomUUID(), body: "3" });
      expect((await participantRow(project.id, bob.id))!.lastReadSeq).toBe(0);
      // the owner was caught up through 2 (their own posts); once they have read 3,
      // their own post 4 advances them to 4.
      expect((await participantRow(project.id, owner.id))!.lastReadSeq).toBe(2);
      await pipelineDb.pipelineParticipant.update({
        where: { projectId_userId: { projectId: project.id, userId: owner.id } },
        data: { lastReadSeq: 3 },
      });
      await post(owner.id, project.id, { clientId: randomUUID(), body: "4" });
      expect((await participantRow(project.id, owner.id))!.lastReadSeq).toBe(4);
    });

    it("a posting follower who unfollowed is re-followed (notify=true)", async () => {
      const { owner, project } = await setup();
      const dan = await createPipelineUser({ name: "Dan Four", tag: "msg-dan" });
      await addParticipantFixture(project.id, dan.id, { role: "FOLLOWER", notify: false });
      await post(dan.id, project.id, { clientId: randomUUID(), body: "back" });
      expect(await participantRow(project.id, dan.id)).toMatchObject({ role: "FOLLOWER", notify: true });
      expect(owner).toBeTruthy();
    });
  });

  describe("mentions", () => {
    it("an inactive mention comes back in notNotified with reason inactive and is not stored", async () => {
      const { owner, bob, project } = await setup();
      const gone = await createPipelineUser({ name: "Gone User", tag: "msg-gone", status: "INACTIVE" });
      const r = await post(owner.id, project.id, {
        clientId: randomUUID(),
        body: `hey ${mention(bob.id)} and ${mention(gone.id)} and ${mention(randomUUID())}`,
      });
      expect(r.status).toBe(201);
      const d = r.body.data;
      expect(d.notified).toEqual([bob.id]);
      expect(d.notNotified).toEqual(
        expect.arrayContaining([
          { id: gone.id, reason: "inactive" },
          { id: expect.any(String), reason: "unknown" },
        ]),
      );
      expect(d.notNotified).toHaveLength(2);
      expect(d.message.mentions).toEqual([{ id: bob.id, name: "Bob Two" }]);
      const [stored] = await messagesOf(project.id);
      expect(stored.mentionIds).toEqual([bob.id]);
      expect(await participantRow(project.id, gone.id)).toBeNull();
    });

    it("pilot mode: a mention of someone outside the pilot is not_in_pilot", async () => {
      const { owner, bob, project } = await setup();
      await setPipelineSetting("pipeline.mode", "pilot");
      await setPipelineSetting("pipeline.pilotUserIds", JSON.stringify([owner.id]));
      resetPipelineStateForTests();
      const r = await post(owner.id, project.id, { clientId: randomUUID(), body: `${mention(bob.id)} look` });
      expect(r.status).toBe(201);
      expect(r.body.data.notNotified).toEqual([{ id: bob.id, reason: "not_in_pilot" }]);
      expect(r.body.data.notified).toEqual([]);
    });

    it("mentioned non-participants are auto-followed at seq − 1", async () => {
      const { owner, project } = await setup();
      const erin = await createPipelineUser({ name: "Erin Five", tag: "msg-erin" });
      await post(owner.id, project.id, { clientId: randomUUID(), body: "one" });
      await post(owner.id, project.id, { clientId: randomUUID(), body: `two ${mention(erin.id)}` });
      const row = await participantRow(project.id, erin.id);
      expect(row).toMatchObject({ role: "FOLLOWER", notify: true, lastReadSeq: 1 });
      expect(row!.engagedAt).not.toBeNull();
    });
  });

  describe("PATCH / DELETE /messages/:mid (routes #18–19)", () => {
    it("edit is author-only (403 NOT_AUTHOR) and restamps rev with k=1", async () => {
      const { owner, bob, project } = await setup();
      const m = (await post(owner.id, project.id, { clientId: randomUUID(), body: "draft" })).body.data.message;
      const denied = await request(app).patch(`/v1/pipeline/messages/${m.id}`).set(auth(bob.id)).send({ body: "hack" });
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe("NOT_AUTHOR");
      const r = await request(app).patch(`/v1/pipeline/messages/${m.id}`).set(auth(owner.id)).send({ body: `final ${mention(bob.id)}` });
      expect(r.status).toBe(200);
      expect(r.body.data.message).toMatchObject({ body: `final ${mention(bob.id)}`, rev: 2, seq: 1 });
      expect(r.body.data.message.editedAt).not.toBeNull();
      expect(r.body.data.message.mentions).toEqual([{ id: bob.id, name: "Bob Two" }]);
      expect(r.body.data.notNotified).toEqual([]);
      expect((await projectRow(project.id)).threadRev).toBe(2);
    });

    it("edit on an archived project is 409 PROJECT_ARCHIVED", async () => {
      const { owner, project } = await setup();
      const m = (await post(owner.id, project.id, { clientId: randomUUID(), body: "x" })).body.data.message;
      await setProjectState(project.id, { archived: true });
      const r = await request(app).patch(`/v1/pipeline/messages/${m.id}`).set(auth(owner.id)).send({ body: "y" });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe("PROJECT_ARCHIVED");
    });

    it("delete leaves a tombstone, is idempotent, and is allowed on an archived project", async () => {
      const { owner, bob, project } = await setup();
      const m = (await post(owner.id, project.id, { clientId: randomUUID(), body: `secret ${mention(bob.id)}` })).body.data.message;
      await request(app).put(`/v1/pipeline/messages/${m.id}/reactions/heart`).set(auth(bob.id)).send({ on: true });
      await setProjectState(project.id, { archived: true });
      const denied = await request(app).delete(`/v1/pipeline/messages/${m.id}`).set(auth(bob.id));
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe("NOT_AUTHOR");
      const r = await request(app).delete(`/v1/pipeline/messages/${m.id}`).set(auth(owner.id));
      expect(r.status).toBe(200);
      expect(r.body.data.message).toMatchObject({ body: "", mentions: [], reactions: {} });
      expect(r.body.data.message.deletedAt).not.toBeNull();
      const [stored] = await messagesOf(project.id);
      expect(stored).toMatchObject({ body: "", mentionIds: [], reactions: {} });
      const revAfter = (await projectRow(project.id)).threadRev;
      const again = await request(app).delete(`/v1/pipeline/messages/${m.id}`).set(auth(owner.id));
      expect(again.status).toBe(200);
      expect((await projectRow(project.id)).threadRev).toBe(revAfter);
    });

    it("deleting a reply decrements the root's reply_count with k=2", async () => {
      const { owner, bob, project } = await setup();
      const root = (await post(owner.id, project.id, { clientId: randomUUID(), body: "root" })).body.data.message;
      const reply = (await post(bob.id, project.id, { clientId: randomUUID(), body: "r", parentId: root.id })).body.data.message;
      const before = (await projectRow(project.id)).threadRev;
      const r = await request(app).delete(`/v1/pipeline/messages/${reply.id}`).set(auth(bob.id));
      expect(r.status).toBe(200);
      expect((await projectRow(project.id)).threadRev).toBe(before + 2);
      const rows = await messagesOf(project.id);
      const storedRoot = rows.find((x) => x.id === root.id)!;
      const storedReply = rows.find((x) => x.id === reply.id)!;
      expect(storedRoot.replyCount).toBe(0);
      expect(storedReply.rev).toBe(before + 1);
      expect(storedRoot.rev).toBe(before + 2);
    });

    it("deleting a reply recomputes the root's lastReplyAt from the LIVE replies — none left is null (B7)", async () => {
      const { owner, bob, project } = await setup();
      const root = (await post(owner.id, project.id, { clientId: randomUUID(), body: "root" })).body.data.message;
      const r1 = (await post(bob.id, project.id, { clientId: randomUUID(), body: "first", parentId: root.id })).body.data.message;
      const r2 = (await post(owner.id, project.id, { clientId: randomUUID(), body: "second", parentId: root.id })).body.data.message;
      const r3 = (await post(bob.id, project.id, { clientId: randomUUID(), body: "third", parentId: root.id })).body.data.message;
      // Distinct, ordered times: r1 30 min ago, r2 20 min ago, r3 10 min ago.
      const ago = (min: number) => new Date(Date.now() - min * 60_000);
      const [t1, t2, t3] = [ago(30), ago(20), ago(10)];
      await pipelineDb.pipelineMessage.update({ where: { id: r1.id }, data: { createdAt: t1 } });
      await pipelineDb.pipelineMessage.update({ where: { id: r2.id }, data: { createdAt: t2 } });
      await pipelineDb.pipelineMessage.update({ where: { id: r3.id }, data: { createdAt: t3 } });
      await pipelineDb.pipelineMessage.update({ where: { id: root.id }, data: { lastReplyAt: t3 } });
      const storedRoot = async () => (await messagesOf(project.id)).find((x) => x.id === root.id)!;
      const del = (uid: string, mid: string) => request(app).delete(`/v1/pipeline/messages/${mid}`).set(auth(uid));

      // An older reply goes: the latest live one still dates the root.
      expect((await del(bob.id, r1.id)).status).toBe(200);
      expect((await storedRoot()).lastReplyAt?.toISOString()).toBe(t3.toISOString());
      // The LATEST reply goes: the root now dates from r2, not from the deleted r3.
      expect((await del(bob.id, r3.id)).status).toBe(200);
      let rootNow = await storedRoot();
      expect(rootNow.replyCount).toBe(1);
      expect(rootNow.lastReplyAt?.toISOString()).toBe(t2.toISOString());
      // The wire agrees (what "1 reply · 20m" is computed from).
      const page = await request(app).get(`/v1/pipeline/messages/${root.id}/replies`).set(auth(owner.id));
      expect(page.body.data.root.lastReplyAt).toBe(t2.toISOString());
      // The last live reply goes: no reply, no time.
      expect((await del(owner.id, r2.id)).status).toBe(200);
      rootNow = await storedRoot();
      expect(rootNow.replyCount).toBe(0);
      expect(rootNow.lastReplyAt).toBeNull();
    });

    it("message routes on a soft-deleted project give 404", async () => {
      const { owner, project } = await setup();
      const m = (await post(owner.id, project.id, { clientId: randomUUID(), body: "x" })).body.data.message;
      await setProjectState(project.id, { deleted: true });
      for (const r of [
        await request(app).patch(`/v1/pipeline/messages/${m.id}`).set(auth(owner.id)).send({ body: "y" }),
        await request(app).delete(`/v1/pipeline/messages/${m.id}`).set(auth(owner.id)),
        await request(app).put(`/v1/pipeline/messages/${m.id}/reactions/heart`).set(auth(owner.id)).send({ on: true }),
        await request(app).get(`/v1/pipeline/messages/${m.id}/replies`).set(auth(owner.id)),
      ]) {
        expect(r.status).toBe(404);
      }
    });
  });

  /** n top-level messages by `authorId` inserted directly (seq = rev = 1..n), counters set. */
  async function seedTopLevel(projectId: string, authorId: string, n: number) {
    await pipelineDb.pipelineMessage.createMany({
      data: Array.from({ length: n }, (_, i) => ({
        clientId: randomUUID(),
        projectId,
        seq: i + 1,
        rev: i + 1,
        authorId,
        body: `m${i + 1}`,
      })),
    });
    await pipelineDb.pipelineProject.update({ where: { id: projectId }, data: { lastMessageSeq: n, threadRev: n } });
  }

  describe("GET /projects/:id/messages (route #15)", () => {
    const history = (userId: string, projectId: string, qs = "") =>
      request(app).get(`/v1/pipeline/projects/${projectId}/messages${qs}`).set(auth(userId));

    it("pages 30 at a time with ?before= and hasOlder, top-level only, oldest first", async () => {
      const { owner, bob, project } = await setup();
      await seedTopLevel(project.id, owner.id, 65);
      const reply = await post(bob.id, project.id, {
        clientId: randomUUID(),
        body: "a reply",
        parentId: (await messagesOf(project.id))[64].id,
      });
      expect(reply.status).toBe(201);

      const p1 = await history(bob.id, project.id);
      expect(p1.status).toBe(200);
      expect(p1.headers["cache-control"]).toBe("no-store");
      expect(p1.body.data.hasOlder).toBe(true);
      expect(p1.body.data.messages.map((m: { seq: number }) => m.seq)).toEqual(Array.from({ length: 30 }, (_, i) => 36 + i));
      const p2 = await history(bob.id, project.id, "?before=36");
      expect(p2.body.data.messages.map((m: { seq: number }) => m.seq)).toEqual(Array.from({ length: 30 }, (_, i) => 6 + i));
      expect(p2.body.data.hasOlder).toBe(true);
      const p3 = await history(bob.id, project.id, "?before=6");
      expect(p3.body.data.messages.map((m: { seq: number }) => m.seq)).toEqual([1, 2, 3, 4, 5]);
      expect(p3.body.data.hasOlder).toBe(false);
      // clientId only on the viewer's own messages.
      expect(p1.body.data.messages[0].clientId).toBeUndefined();
      expect((await history(owner.id, project.id)).body.data.messages[0].clientId).toEqual(expect.any(String));
    });

    it("honours ?limit (≤ 50) and 404s a deleted or unknown project", async () => {
      const { owner, project } = await setup();
      await seedTopLevel(project.id, owner.id, 3);
      const r = await history(owner.id, project.id, "?limit=2");
      expect(r.body.data.messages).toHaveLength(2);
      expect(r.body.data.hasOlder).toBe(true);
      expect((await history(owner.id, project.id, "?limit=51")).status).toBe(400);
      await setProjectState(project.id, { deleted: true });
      const gone = await history(owner.id, project.id);
      expect(gone.status).toBe(404);
      expect(gone.body.error.code).toBe("PROJECT_NOT_FOUND");
      expect((await history(owner.id, randomUUID())).status).toBe(404);
    });

    it("an archived project is still readable", async () => {
      const { owner, project } = await setup();
      await seedTopLevel(project.id, owner.id, 2);
      await setProjectState(project.id, { archived: true });
      const r = await history(owner.id, project.id);
      expect(r.status).toBe(200);
      expect(r.body.data.messages).toHaveLength(2);
    });
  });

  describe("GET /messages/:mid/replies (route #16)", () => {
    it("returns the root and pages replies with ?after=", async () => {
      const { owner, bob, project } = await setup();
      const root = (await post(owner.id, project.id, { clientId: randomUUID(), body: "root" })).body.data.message;
      const replies: string[] = [];
      for (let i = 0; i < 5; i++) {
        const r = await post(bob.id, project.id, { clientId: randomUUID(), body: `r${i}`, parentId: root.id });
        replies.push(r.body.data.message.id);
      }
      await post(owner.id, project.id, { clientId: randomUUID(), body: "unrelated top-level" });
      const get = (mid: string, qs = "") => request(app).get(`/v1/pipeline/messages/${mid}/replies${qs}`).set(auth(owner.id));
      const a = await get(root.id, "?limit=2");
      expect(a.status).toBe(200);
      expect(a.body.data.root).toMatchObject({ id: root.id, replyCount: 5 });
      expect(a.body.data.replies.map((m: { id: string }) => m.id)).toEqual(replies.slice(0, 2));
      expect(a.body.data.hasMore).toBe(true);
      const lastSeq = a.body.data.replies[1].seq;
      const b = await get(root.id, `?after=${lastSeq}&limit=10`);
      expect(b.body.data.replies.map((m: { id: string }) => m.id)).toEqual(replies.slice(2));
      expect(b.body.data.hasMore).toBe(false);
      // A reply id resolves to its root's thread.
      const c = await get(replies[0]);
      expect(c.body.data.root.id).toBe(root.id);
      expect(c.body.data.replies).toHaveLength(5);
      expect((await get(randomUUID())).status).toBe(404);
    });
  });

  describe("POST /projects/:id/read (route #21)", () => {
    const read = (userId: string, projectId: string, body: Record<string, unknown>) =>
      request(app).post(`/v1/pipeline/projects/${projectId}/read`).set(auth(userId)).send(body);

    it("advances last_read_seq monotonically, capped at last_message_seq; {leaving:true} nulls seen_at", async () => {
      const { owner, bob, project } = await setup();
      await seedTopLevel(project.id, owner.id, 10);
      const a = await read(bob.id, project.id, { seq: 4 });
      expect(a.status).toBe(200);
      expect(a.body.data).toEqual({ lastReadSeq: 4 });
      expect((await participantRow(project.id, bob.id))!.seenAt).not.toBeNull();
      expect((await read(bob.id, project.id, { seq: 2 })).body.data).toEqual({ lastReadSeq: 4 });
      expect((await read(bob.id, project.id, { seq: 999 })).body.data).toEqual({ lastReadSeq: 10 });
      const leave = await read(bob.id, project.id, { seq: 10, leaving: true });
      expect(leave.body.data).toEqual({ lastReadSeq: 10 });
      expect((await participantRow(project.id, bob.id))!.seenAt).toBeNull();
    });

    it("a non-participant gets lastReadSeq 0 and no row is created", async () => {
      const { owner, project } = await setup();
      const zed = await createPipelineUser({ name: "Zed Six", tag: "msg-zed" });
      await seedTopLevel(project.id, owner.id, 3);
      const r = await read(zed.id, project.id, { seq: 3 });
      expect(r.status).toBe(200);
      expect(r.body.data).toEqual({ lastReadSeq: 0 });
      expect(await participantRow(project.id, zed.id)).toBeNull();
    });
  });

  describe("PUT /messages/:mid/reactions/:emoji (route #20)", () => {
    it("{on:true} twice gives one entry and one rev bump; {on:false} removes it", async () => {
      const { owner, bob, project } = await setup();
      const m = (await post(owner.id, project.id, { clientId: randomUUID(), body: "react to me" })).body.data.message;
      const put = (on: boolean) =>
        request(app).put(`/v1/pipeline/messages/${m.id}/reactions/thumbs_up`).set(auth(bob.id)).send({ on });
      const a = await put(true);
      const b = await put(true);
      expect(a.status).toBe(200);
      expect(a.body.data).toEqual({ messageId: m.id, reactions: { thumbs_up: [bob.id] }, rev: 2 });
      expect(b.body.data).toEqual(a.body.data);
      expect((await projectRow(project.id)).threadRev).toBe(2);
      const off = await put(false);
      expect(off.body.data).toEqual({ messageId: m.id, reactions: {}, rev: 3 });
      const offAgain = await put(false);
      expect(offAgain.body.data.rev).toBe(3);
    });

    it("an emoji outside the allowlist is 400; a deleted message is 409 MESSAGE_DELETED", async () => {
      const { owner, project } = await setup();
      const m = (await post(owner.id, project.id, { clientId: randomUUID(), body: "x" })).body.data.message;
      const bad = await request(app).put(`/v1/pipeline/messages/${m.id}/reactions/skull`).set(auth(owner.id)).send({ on: true });
      expect(bad.status).toBe(400);
      await request(app).delete(`/v1/pipeline/messages/${m.id}`).set(auth(owner.id));
      const r = await request(app).put(`/v1/pipeline/messages/${m.id}/reactions/heart`).set(auth(owner.id)).send({ on: true });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe("MESSAGE_DELETED");
    });
  });
});
