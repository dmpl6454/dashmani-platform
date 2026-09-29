/**
 * pipeline/sync.test.ts — route #3, the consolidated poll (spec §5.2, §5.4).
 *
 * One request per tick answers: has the board changed (v), how many unread do I have per
 * project (the `mine` overlay, hashed so an unchanged overlay costs nothing on the wire),
 * and — for the open project — every message changed since my cursor, the header when
 * it changed, and my read marker. Projects are created by direct insert (PR 7 is parallel).
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "crypto";
import app from "../../src/app";
import { resetPipelineStateForTests } from "../../src/services/pipeline";
import { pipelineDb } from "../../src/services/pipeline/db";
import { __setSyncDeltaLimitForTests, setBoardSnapshotProvider } from "../../src/services/pipeline/sync.service";
import { hrToken, setPipelineSetting, clearPipelineSettings, createPipelineUser, seedPipelinePhases } from "./pipeline-helpers";
import { createProjectFixture, setProjectState, participantRow } from "./fixtures-messages";

const auth = (userId: string) => ({ Authorization: `Bearer ${hrToken(userId)}` });

describe("pipeline sync", () => {
  beforeEach(async () => {
    resetPipelineStateForTests();
    await clearPipelineSettings();
    await seedPipelinePhases();
    await setPipelineSetting("pipeline.mode", "on");
    // These tests drive the provider seam themselves; the real one is installed at load.
    setBoardSnapshotProvider(null);
  });

  afterEach(() => {
    __setSyncDeltaLimitForTests(null);
    setBoardSnapshotProvider(null);
  });

  afterAll(async () => {
    await clearPipelineSettings();
    resetPipelineStateForTests();
    await pipelineDb.$disconnect();
  });

  const sync = (userId: string, body: Record<string, unknown>) =>
    request(app).post("/v1/pipeline/sync").set(auth(userId)).send({ clientBuild: 1, ...body });
  const post = (userId: string, projectId: string, body: string) =>
    request(app)
      .post(`/v1/pipeline/projects/${projectId}/messages`)
      .set(auth(userId))
      .send({ clientId: randomUUID(), body });

  async function setup() {
    const owner = await createPipelineUser({ name: "Sync Owner", tag: "sync-owner" });
    const bob = await createPipelineUser({ name: "Sync Bob", tag: "sync-bob" });
    const project = await createProjectFixture({ ownerId: owner.id, memberIds: [bob.id], title: "Launch" });
    return { owner, bob, project };
  }

  it("an unchanged sync returns board:null, mine:null, no messages and the same rev/hv (no-store)", async () => {
    const { owner, project } = await setup();
    await post(owner.id, project.id, "hello");
    const first = await sync(owner.id, { board: { v: 0 }, project: { id: project.id, rev: 0, hv: 0 } });
    expect(first.status).toBe(200);
    expect(first.headers["cache-control"]).toBe("no-store");
    const a = first.body.data;
    expect(a.project.messages).toHaveLength(1);
    expect(a.project.header).not.toBeNull();

    const again = await sync(owner.id, {
      board: { v: a.v },
      mineH: a.mineH,
      project: { id: project.id, rev: a.project.rev, hv: a.project.hv },
    });
    const b = again.body.data;
    expect(b).toMatchObject({ v: a.v, board: null, mineH: a.mineH, mine: null, reload: false });
    expect(b.project).toMatchObject({
      id: project.id,
      status: "ok",
      rev: a.project.rev,
      hv: a.project.hv,
      header: null,
      participants: null,
      messages: [],
      hasMore: false,
    });
    expect(typeof b.pollMs).toBe("number");
  });

  it("a post committed between two syncs always appears", async () => {
    const { owner, bob, project } = await setup();
    const s1 = (await sync(bob.id, { project: { id: project.id, rev: 0, hv: 0 } })).body.data;
    const posted = (await post(owner.id, project.id, "between")).body.data.message;
    const s2 = (await sync(bob.id, { project: { id: project.id, rev: s1.project.rev, hv: s1.project.hv } })).body.data;
    expect(s2.project.messages.map((m: { id: string }) => m.id)).toEqual([posted.id]);
    expect(s2.project.rev).toBe(posted.rev);
    expect(s2.project.messages[0].clientId).toBeUndefined();
    expect(s2.project.messages[0].authorName).toBe("Sync Owner");
  });

  it("with a delta limit of 2 across 5 changes, all 5 arrive exactly once over 3 calls", async () => {
    const { owner, bob, project } = await setup();
    const posted: string[] = [];
    for (let i = 0; i < 5; i++) posted.push((await post(owner.id, project.id, `m${i}`)).body.data.message.id);
    __setSyncDeltaLimitForTests(2);
    const seen: string[] = [];
    let rev = 0;
    const more: boolean[] = [];
    for (let call = 0; call < 3; call++) {
      const d = (await sync(bob.id, { project: { id: project.id, rev, hv: 0 } })).body.data.project;
      seen.push(...d.messages.map((m: { id: string }) => m.id));
      more.push(d.hasMore);
      rev = d.rev;
    }
    expect(more).toEqual([true, true, false]);
    expect(seen).toEqual(posted);
    expect(new Set(seen).size).toBe(5);
  });

  it("edits, reactions, deletes and replies arrive as restamped rows (tombstones included)", async () => {
    const { owner, bob, project } = await setup();
    const m = (await post(owner.id, project.id, "root")).body.data.message;
    const s1 = (await sync(bob.id, { project: { id: project.id, rev: 0, hv: 0 } })).body.data.project;
    await request(app).put(`/v1/pipeline/messages/${m.id}/reactions/fire`).set(auth(bob.id)).send({ on: true });
    const reply = (
      await request(app)
        .post(`/v1/pipeline/projects/${project.id}/messages`)
        .set(auth(bob.id))
        .send({ clientId: randomUUID(), body: "r", parentId: m.id })
    ).body.data.message;
    await request(app).delete(`/v1/pipeline/messages/${reply.id}`).set(auth(bob.id));
    const s2 = (await sync(bob.id, { project: { id: project.id, rev: s1.rev, hv: s1.hv } })).body.data.project;
    const byId = new Map(s2.messages.map((x: { id: string }) => [x.id, x]));
    expect(byId.size).toBe(2);
    expect(byId.get(m.id)).toMatchObject({ reactions: { fire: [bob.id] }, replyCount: 0 });
    expect(byId.get(reply.id)).toMatchObject({ body: "", parentId: m.id });
    expect((byId.get(reply.id) as { deletedAt: string | null }).deletedAt).not.toBeNull();
    const revs = s2.messages.map((x: { rev: number }) => x.rev);
    expect(revs).toEqual([...revs].sort((a: number, b: number) => a - b));
  });

  it("a deleted or unknown project returns status:'deleted', never 404; archived is 'archived'", async () => {
    const { owner, project } = await setup();
    const archivedP = await createProjectFixture({ ownerId: owner.id });
    await setProjectState(archivedP.id, { archived: true });
    await setProjectState(project.id, { deleted: true });
    const d = await sync(owner.id, { project: { id: project.id, rev: 3, hv: 2 } });
    expect(d.status).toBe(200);
    expect(d.body.data.project).toMatchObject({ id: project.id, status: "deleted", rev: 3, hv: 2, messages: [], header: null });
    const unknown = await sync(owner.id, { project: { id: randomUUID(), rev: 0, hv: 0 } });
    expect(unknown.status).toBe(200);
    expect(unknown.body.data.project.status).toBe("deleted");
    const arch = await sync(owner.id, { project: { id: archivedP.id, rev: 0, hv: 0 } });
    expect(arch.body.data.project.status).toBe("archived");
    expect(arch.body.data.project.header).not.toBeNull();
  });

  it("clientBuild below pipeline.minClientBuild returns reload:true", async () => {
    const { owner } = await setup();
    await setPipelineSetting("pipeline.minClientBuild", "5");
    resetPipelineStateForTests();
    expect((await sync(owner.id, { clientBuild: 4 })).body.data.reload).toBe(true);
    expect((await sync(owner.id, { clientBuild: 5 })).body.data.reload).toBe(false);
  });

  it("the mine overlay: unread = last_message_seq − last_read_seq, omitted when mineH matches, live projects only", async () => {
    const { owner, bob, project } = await setup();
    const archivedP = await createProjectFixture({ ownerId: owner.id, memberIds: [bob.id] });
    await setProjectState(archivedP.id, { archived: true });
    for (let i = 0; i < 3; i++) await post(owner.id, project.id, `m${i}`);
    await pipelineDb.pipelineParticipant.update({
      where: { projectId_userId: { projectId: project.id, userId: bob.id } },
      data: { lastReadSeq: 1 },
    });
    const a = (await sync(bob.id, {})).body.data;
    expect(a.mine).toEqual([{ projectId: project.id, role: "MEMBER", notify: true, unread: 2 }]);
    expect(a.project).toBeNull();
    const b = (await sync(bob.id, { mineH: a.mineH })).body.data;
    expect(b.mine).toBeNull();
    expect(b.mineH).toBe(a.mineH);
    await post(owner.id, project.id, "one more");
    const c = (await sync(bob.id, { mineH: a.mineH })).body.data;
    expect(c.mine).toEqual([{ projectId: project.id, role: "MEMBER", notify: true, unread: 3 }]);
    expect(c.mineH).not.toBe(a.mineH);
  });

  it("the header is sent only when header_rev changed; other participants never carry read state", async () => {
    const { owner, bob, project } = await setup();
    const a = (await sync(bob.id, { project: { id: project.id, rev: 0, hv: 0 } })).body.data.project;
    expect(a.header).toMatchObject({ id: project.id, title: "Launch", ownerId: owner.id, memberCount: 2 });
    expect(typeof a.header.createdAt).toBe("string");
    expect(a.me).toEqual({ role: "MEMBER", notify: true, lastReadSeq: 0 });
    expect(a.participants).toHaveLength(2);
    for (const p of a.participants) {
      expect(Object.keys(p).sort()).toEqual(["createdAt", "isOwner", "memberAddedById", "role", "userId"]);
    }
    expect(a.participants.find((p: { userId: string }) => p.userId === owner.id).isOwner).toBe(true);
    const b = (await sync(bob.id, { project: { id: project.id, rev: a.rev, hv: a.hv } })).body.data.project;
    expect(b.header).toBeNull();
    expect(b.participants).toBeNull();
  });

  it("the ack advances last_read_seq (capped), stamps seen_at, and leaving nulls it", async () => {
    const { owner, bob, project } = await setup();
    for (let i = 0; i < 4; i++) await post(owner.id, project.id, `m${i}`);
    const a = (await sync(bob.id, { project: { id: project.id, rev: 0, hv: 0, ack: { seq: 3 } } })).body.data.project;
    expect(a.lastReadSeq).toBe(3);
    expect((await participantRow(project.id, bob.id))!.seenAt).not.toBeNull();
    const b = (await sync(bob.id, { project: { id: project.id, rev: a.rev, hv: a.hv, ack: { seq: 99, leaving: true } } }))
      .body.data.project;
    expect(b.lastReadSeq).toBe(4);
    expect((await participantRow(project.id, bob.id))!.seenAt).toBeNull();
    // A non-participant's ack writes nothing.
    const zed = await createPipelineUser({ name: "Sync Zed", tag: "sync-zed" });
    const z = (await sync(zed.id, { project: { id: project.id, rev: 0, hv: 0, ack: { seq: 4, open: true } } })).body.data.project;
    expect(z.lastReadSeq).toBe(0);
    expect(await participantRow(project.id, zed.id)).toBeNull();
  });

  it("board: a differing v gets the provider's snapshot; an equal v never calls it", async () => {
    const { owner } = await setup();
    const calls: number[] = [];
    setBoardSnapshotProvider(async (v) => {
      calls.push(v);
      return { v, phases: [], cards: [], perPhase: {} };
    });
    const a = (await sync(owner.id, { board: { v: -1 } })).body.data;
    expect(a.board).toEqual({ v: a.v, phases: [], cards: [], perPhase: {} });
    expect(calls).toEqual([a.v]);
    const b = (await sync(owner.id, { board: { v: a.v } })).body.data;
    expect(b.board).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("a board snapshot that cannot be built keeps the client's v (it asks again next tick)", async () => {
    const { owner } = await setup();
    setBoardSnapshotProvider(async () => {
      throw new Error("busy");
    });
    const r = await sync(owner.id, { board: { v: -1 } });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ v: -1, board: null });
  });

  it("rejects a malformed body with 400", async () => {
    const { owner } = await setup();
    const r = await request(app).post("/v1/pipeline/sync").set(auth(owner.id)).send({ project: { id: "nope" } });
    expect(r.status).toBe(400);
  });
});
