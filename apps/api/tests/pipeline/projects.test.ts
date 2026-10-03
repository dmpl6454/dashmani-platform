/**
 * pipeline/projects.test.ts — routes #4–#14 (spec §3.4, §4, §5.3, §6).
 *
 * Projects and the board ship DARK (PR 7). Every write goes through pipelineWrite on the
 * pipeline pool, checks the actor and the project row it locked, and bumps the board only
 * after COMMIT. Notifications go through the injected notifier (a no-op until PR 9).
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { prisma } from "@dashmani/db";
import { compareRank } from "@dashmani/shared";
import app from "../../src/app";
import { resetPipelineStateForTests } from "../../src/services/pipeline";
import { pipelineDb } from "../../src/services/pipeline/db";
import { pipelineGate } from "../../src/services/pipeline/tx";
import { getBoardSnapshot } from "../../src/services/pipeline/board";
import { hrToken, setPipelineSetting, clearPipelineSettings, createPipelineUser, seedPipelinePhases } from "./pipeline-helpers";

const P = "/v1/pipeline/projects";

type Method = "get" | "post" | "patch" | "put" | "delete";
function call(method: Method, path: string, token: string, body?: unknown) {
  const r = request(app)[method](path).set("Authorization", `Bearer ${token}`);
  return body === undefined ? r : r.send(body as object);
}

const uuid = () => crypto.randomUUID();
const phase = (key: string) => prisma.pipelinePhase.findUniqueOrThrow({ where: { key } });
const boardSeq = async () => (await prisma.pipelineBoardState.findUniqueOrThrow({ where: { id: 1 } })).seq;

async function user(name: string, opts: Omit<Parameters<typeof createPipelineUser>[0], "name"> = {}) {
  const u = await createPipelineUser({ name, tag: name.toLowerCase().replace(/\W+/g, "-"), ...opts });
  return { ...u, token: hrToken(u.id) };
}

async function create(token: string, body: Record<string, unknown> = {}) {
  const r = await call("post", P, token, { clientId: uuid(), title: "Diwali campaign", ...body });
  if (r.status !== 201) throw new Error(`create failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data.card as { id: string; phaseId: string; rank: string; memberCount: number; preview: string[] };
}

/** Seed `n` top-level messages (seq/rev 1..n) and set the project's counters to match. */
async function seedMessages(projectId: string, authorId: string, n: number) {
  await prisma.pipelineMessage.createMany({
    data: Array.from({ length: n }, (_, i) => ({
      clientId: uuid(),
      projectId,
      seq: i + 1,
      rev: i + 1,
      authorId,
      body: `message ${i + 1}`,
    })),
  });
  await prisma.pipelineProject.update({ where: { id: projectId }, data: { lastMessageSeq: n, threadRev: n } });
  return prisma.pipelineMessage.findMany({ where: { projectId }, orderBy: { seq: "asc" } });
}

// ⚠️ Every hook that touches the DB lives inside this describe (tests/setup.ts TRUNCATEs in
// a top-level beforeEach, and same-level hooks run in parallel under vitest 1.x).
describe("pipeline projects", () => {
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

  // ── Task 7.1: create and list (routes #4–5) ───────────────────────────────────────
  describe("POST /pipeline/projects (create)", () => {
    it("201 {card, replayed:false}; the same clientId replays 200 with one row", async () => {
      const me = await user("Priya Sharma");
      const clientId = uuid();
      const body = { clientId, title: "Diwali campaign", startDate: "2026-10-01", dueDate: "2026-10-20" };
      const first = await call("post", P, me.token, body);
      expect(first.status).toBe(201);
      expect(first.headers["cache-control"]).toBe("no-store");
      expect(first.body.data.replayed).toBe(false);
      const card = first.body.data.card;
      const brief = await phase("brief");
      expect(card).toMatchObject({
        title: "Diwali campaign",
        phaseId: brief.id,
        ownerId: me.id,
        startDate: "2026-10-01",
        dueDate: "2026-10-20",
        memberCount: 1,
        preview: [me.id],
      });

      const again = await call("post", P, me.token, { ...body, title: "Changed title" });
      expect(again.status).toBe(200);
      expect(again.body.data.replayed).toBe(true);
      expect(again.body.data.card.id).toBe(card.id);
      expect(again.body.data.card.title).toBe("Diwali campaign");
      expect(await prisma.pipelineProject.count()).toBe(1);
    });

    it("memberIds [me, a, a] gives 2 participants and memberCount 2 (deduped, creator stripped)", async () => {
      const me = await user("Rahul Verma");
      const a = await user("Aisha Khan");
      const card = await create(me.token, { memberIds: [me.id, a.id, a.id] });
      expect(card.memberCount).toBe(2);
      expect(card.preview).toEqual([me.id, a.id]);
      const parts = await prisma.pipelineParticipant.findMany({ where: { projectId: card.id }, orderBy: { createdAt: "asc" } });
      expect(parts.map((p) => [p.userId, p.role, p.notify, p.memberAddedById])).toEqual([
        [me.id, "MEMBER", true, null],
        [a.id, "MEMBER", true, me.id],
      ]);
      const row = await prisma.pipelineProject.findUniqueOrThrow({ where: { id: card.id } });
      expect(row.memberCount).toBe(2);
    });

    it("an archived phase is 409 PHASE_ARCHIVED; an unknown phase is 404 PHASE_NOT_FOUND", async () => {
      const me = await user("Neha Gupta");
      const old = await prisma.pipelinePhase.create({ data: { key: "old", name: "Old", position: 99, archivedAt: new Date() } });
      const archived = await call("post", P, me.token, { clientId: uuid(), title: "X", phaseId: old.id });
      expect(archived.status).toBe(409);
      expect(archived.body.error.code).toBe("PHASE_ARCHIVED");
      const unknown = await call("post", P, me.token, { clientId: uuid(), title: "X", phaseId: uuid() });
      expect(unknown.status).toBe(404);
      expect(unknown.body.error.code).toBe("PHASE_NOT_FOUND");
      expect(await prisma.pipelineProject.count()).toBe(0);
    });

    it("an inactive or (in pilot) unlisted member is 409 MEMBER_NOT_PICKABLE and nothing is written", async () => {
      const me = await user("Kavya Iyer");
      const gone = await user("Gone User", { status: "INACTIVE" });
      const r1 = await call("post", P, me.token, { clientId: uuid(), title: "X", memberIds: [gone.id] });
      expect(r1.status).toBe(409);
      expect(r1.body.error.code).toBe("MEMBER_NOT_PICKABLE");

      const other = await user("Outside Pilot");
      await setPipelineSetting("pipeline.mode", "pilot");
      await setPipelineSetting("pipeline.pilotUserIds", JSON.stringify([me.id]));
      resetPipelineStateForTests();
      const r2 = await call("post", P, me.token, { clientId: uuid(), title: "X", memberIds: [other.id] });
      expect(r2.status).toBe(409);
      expect(r2.body.error.code).toBe("MEMBER_NOT_PICKABLE");
      expect(await prisma.pipelineProject.count()).toBe(0);
    });

    it("a new card gets the TOP rank in its phase, and the board is bumped after commit", async () => {
      const me = await user("Arjun Mehta");
      const first = await create(me.token, { title: "First" }); // also warms the boot self-check's bump
      const before = await boardSeq();
      const second = await create(me.token, { title: "Second" });
      expect(compareRank(second.rank, first.rank)).toBe(-1);
      expect(await boardSeq()).toBe(before + 1);
    });

    it("rejects a due date before the start date with 400 DATE_ORDER", async () => {
      const me = await user("Isha Rao");
      const r = await call("post", P, me.token, { clientId: uuid(), title: "X", startDate: "2026-10-20", dueDate: "2026-10-01" });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("DATE_ORDER");
    });
  });

  describe("GET /pipeline/projects (archived / deleted lists)", () => {
    it("?view=archived pages newest-archived first with an accurate nextCursor", async () => {
      const me = await user("Meera Nair");
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) ids.push((await create(me.token, { title: `P${i}` })).id);
      const base = Date.UTC(2026, 8, 1);
      for (let i = 0; i < 5; i++) {
        await prisma.pipelineProject.update({ where: { id: ids[i] }, data: { archivedAt: new Date(base + i * 60_000) } });
      }
      await create(me.token, { title: "Live one" });

      const page1 = await call("get", `${P}?view=archived&limit=2`, me.token);
      expect(page1.status).toBe(200);
      expect(page1.body.data.items.map((c: { id: string }) => c.id)).toEqual([ids[4], ids[3]]);
      expect(page1.body.data.items[0].archivedAt).toBe(new Date(base + 4 * 60_000).toISOString());
      expect(page1.body.data.nextCursor).toEqual(expect.any(String));

      const page2 = await call("get", `${P}?view=archived&limit=2&cursor=${encodeURIComponent(page1.body.data.nextCursor)}`, me.token);
      expect(page2.body.data.items.map((c: { id: string }) => c.id)).toEqual([ids[2], ids[1]]);
      const page3 = await call("get", `${P}?view=archived&limit=2&cursor=${encodeURIComponent(page2.body.data.nextCursor)}`, me.token);
      expect(page3.body.data.items.map((c: { id: string }) => c.id)).toEqual([ids[0]]);
      expect(page3.body.data.nextCursor).toBeNull();
    });

    it("?view=deleted shows only your own projects within 30 days, or everything for an admin", async () => {
      const me = await user("Sana Shaikh");
      const other = await user("Vikram Das");
      const admin = await user("Admin Ali", { roleNames: ["Admin"] });
      const mine = await create(me.token, { title: "Mine" });
      const theirs = await create(other.token, { title: "Theirs" });
      const ancient = await create(me.token, { title: "Ancient" });
      const now = Date.now();
      await prisma.pipelineProject.update({ where: { id: mine.id }, data: { deletedAt: new Date(now - 60_000) } });
      await prisma.pipelineProject.update({ where: { id: theirs.id }, data: { deletedAt: new Date(now - 120_000) } });
      await prisma.pipelineProject.update({ where: { id: ancient.id }, data: { deletedAt: new Date(now - 31 * 86_400_000) } });

      const mineList = await call("get", `${P}?view=deleted`, me.token);
      expect(mineList.status).toBe(200);
      expect(mineList.body.data.items.map((c: { id: string }) => c.id)).toEqual([mine.id]);
      expect(mineList.body.data.items[0].deletedAt).toEqual(expect.any(String));

      const adminList = await call("get", `${P}?view=deleted`, admin.token);
      expect(adminList.body.data.items.map((c: { id: string }) => c.id)).toEqual([mine.id, theirs.id]);
    });

    it("rejects a missing view or a malformed cursor with 400", async () => {
      const me = await user("Tara Singh");
      expect((await call("get", P, me.token)).status).toBe(400);
      expect((await call("get", `${P}?view=archived&cursor=garbage`, me.token)).status).toBe(400);
    });
  });

  // ── Task 7.2: detail (route #6) and the board snapshot (§5.3) ─────────────────────
  describe("GET /pipeline/projects/:id (detail)", () => {
    it("is ONE statement once the memos are warm", async () => {
      const me = await user("Dev Patel");
      const card = await create(me.token);
      await call("get", `${P}/${card.id}`, me.token); // warm gate memos + directory
      const granted = pipelineGate.stats().granted;
      const r = await call("get", `${P}/${card.id}`, me.token);
      expect(r.status).toBe(200);
      expect(pipelineGate.stats().granted - granted).toBe(1);
    });

    it("returns header, participants, me, can and the latest 30 top-level messages by default", async () => {
      const me = await user("Riya Sen");
      const a = await user("Kabir Roy");
      const card = await create(me.token, { memberIds: [a.id], description: "Brief text" });
      await seedMessages(card.id, a.id, 40);
      await prisma.pipelineParticipant.update({ where: { projectId_userId: { projectId: card.id, userId: me.id } }, data: { lastReadSeq: 40 } });
      const r = await call("get", `${P}/${card.id}`, me.token);
      expect(r.status).toBe(200);
      const d = r.body.data;
      expect(d.header).toMatchObject({ id: card.id, title: "Diwali campaign", ownerId: me.id, memberCount: 2, threadRev: 40 });
      expect(d.description).toBe("Brief text");
      expect(d.me).toEqual({ role: "MEMBER", notify: true, lastReadSeq: 40 });
      expect(d.can).toEqual({ archive: true, delete: true, restore: false, transferOwner: true, removeOthers: true });
      expect(d.messages.map((m: { seq: number }) => m.seq)).toEqual(Array.from({ length: 30 }, (_, i) => i + 11));
      expect(d.messages[0]).toMatchObject({ authorId: a.id, authorName: "Kabir Roy", body: "message 11", mentions: [], reactions: {} });
      expect(d.messages[0].clientId).toBeUndefined();
      expect(d).toMatchObject({ threadRev: 40, hasOlder: true, hasNewer: false });
    });

    it("other participants never carry notify, lastReadSeq or seenAt", async () => {
      const me = await user("Om Prakash");
      const a = await user("Leela Das");
      const card = await create(me.token, { memberIds: [a.id] });
      const r = await call("get", `${P}/${card.id}`, a.token);
      expect(r.body.data.participants).toHaveLength(2);
      for (const p of r.body.data.participants) {
        expect(Object.keys(p).sort()).toEqual(["createdAt", "isOwner", "memberAddedAt", "memberAddedById", "role", "userId"]);
      }
      expect(r.body.data.participants[0]).toMatchObject({ userId: me.id, isOwner: true, role: "MEMBER" });
      expect(r.body.data.can.archive).toBe(false);
    });

    it("loads around the first unread: 15 before + 15 from it", async () => {
      const me = await user("Nisha Jain");
      const card = await create(me.token);
      await seedMessages(card.id, me.id, 60);
      await prisma.pipelineParticipant.update({ where: { projectId_userId: { projectId: card.id, userId: me.id } }, data: { lastReadSeq: 20 } });
      const r = await call("get", `${P}/${card.id}`, me.token);
      const seqs = r.body.data.messages.map((m: { seq: number }) => m.seq);
      expect(seqs).toEqual(Array.from({ length: 30 }, (_, i) => i + 6));
      expect(r.body.data).toMatchObject({ hasOlder: true, hasNewer: true });
      expect(r.body.data.messages[0].clientId).toEqual(expect.any(String)); // my own messages carry it
    });

    it("?around= loads around that message; a missing one returns the latest page with aroundMissing; another project's is 404", async () => {
      const me = await user("Zoya Ali");
      const card = await create(me.token);
      const other = await create(me.token, { title: "Other" });
      const msgs = await seedMessages(card.id, me.id, 50);
      const foreign = await seedMessages(other.id, me.id, 1);

      const around = await call("get", `${P}/${card.id}?around=${msgs[9].id}`, me.token);
      expect(around.status).toBe(200);
      expect(around.body.data.messages.map((m: { seq: number }) => m.seq)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
      expect(around.body.data).toMatchObject({ hasOlder: false, hasNewer: true });

      const missing = await call("get", `${P}/${card.id}?around=${uuid()}`, me.token);
      expect(missing.status).toBe(200);
      expect(missing.body.data.aroundMissing).toBe(true);
      expect(missing.body.data.messages.at(-1).seq).toBe(50);

      const cross = await call("get", `${P}/${card.id}?around=${foreign[0].id}`, me.token);
      expect(cross.status).toBe(404);
    });

    it("404 PROJECT_NOT_FOUND for an unknown id and 404 PROJECT_DELETED for a soft-deleted one", async () => {
      const me = await user("Anil Kapoor");
      const card = await create(me.token);
      expect((await call("get", `${P}/${uuid()}`, me.token)).body.error.code).toBe("PROJECT_NOT_FOUND");
      await prisma.pipelineProject.update({ where: { id: card.id }, data: { deletedAt: new Date() } });
      const r = await call("get", `${P}/${card.id}`, me.token);
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe("PROJECT_DELETED");
    });
  });

  describe("getBoardSnapshot (§5.3)", () => {
    it("the label equals its rows; archived and deleted cards are excluded", async () => {
      const me = await user("Board One");
      const live = await create(me.token, { title: "Live" });
      const archived = await create(me.token, { title: "Archived" });
      const deleted = await create(me.token, { title: "Deleted" });
      await prisma.pipelineProject.update({ where: { id: archived.id }, data: { archivedAt: new Date() } });
      await prisma.pipelineProject.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } });
      const v = await boardSeq();
      const snap = await getBoardSnapshot(v);
      expect(snap.v).toBe(v);
      expect(snap.cards.map((c) => c.id)).toEqual([live.id]);
      expect(snap.cards[0]).toMatchObject({ title: "Live", memberCount: 1, preview: [me.id] });
      expect(snap.phases.map((p) => p.key)).toEqual(["brief", "planning", "in_production", "review", "approved", "live", "done"]);
      expect(snap.perPhase[live.phaseId]).toEqual({ shown: 1, total: 1, truncated: false });
    });

    it("caps each phase at 100 cards with an accurate total, in rank order", async () => {
      const me = await user("Board Cap");
      const planning = await phase("planning");
      await prisma.pipelineProject.createMany({
        data: Array.from({ length: 105 }, (_, i) => ({
          clientId: uuid(),
          title: `Card ${i}`,
          ownerId: me.id,
          createdById: me.id,
          phaseId: planning.id,
          rank: `a${String(i).padStart(3, "0")}`,
        })),
      });
      const snap = await getBoardSnapshot(await boardSeq());
      const inPlanning = snap.cards.filter((c) => c.phaseId === planning.id);
      expect(inPlanning).toHaveLength(100);
      expect(inPlanning[0].rank).toBe("a000");
      expect(inPlanning[99].rank).toBe("a099");
      expect(snap.perPhase[planning.id]).toEqual({ shown: 100, total: 105, truncated: true });
    });

    it("serves the cache only while cache.v === board_v; a new or regressed v rebuilds", async () => {
      const me = await user("Board Cache");
      await create(me.token, { title: "One" });
      const v = await boardSeq();
      const first = await getBoardSnapshot(v);
      const granted = pipelineGate.stats().granted;
      expect(await getBoardSnapshot(v)).toBe(first);
      expect(pipelineGate.stats().granted).toBe(granted); // zero statements on a hit

      await create(me.token, { title: "Two" }); // bumps the board
      const v2 = await boardSeq();
      const second = await getBoardSnapshot(v2);
      expect(second.v).toBe(v2);
      expect(second.cards).toHaveLength(2);

      await prisma.pipelineBoardState.update({ where: { id: 1 }, data: { seq: 1 } }); // e.g. a DB restore
      const regressed = await getBoardSnapshot(1);
      expect(regressed.v).toBe(1);
      expect(regressed).not.toBe(second);
    });
  });

  // ── Task 7.3: edit and move (routes #7–8) ─────────────────────────────────────────
  describe("PATCH /pipeline/projects/:id (edit)", () => {
    const patch = (id: string, token: string, changes: object, base: object) =>
      call("patch", `${P}/${id}`, token, { changes, base });

    it("edits to different fields both succeed; the same field is 409 EDIT_CONFLICT {current}", async () => {
      const a = await user("Edit Alpha");
      const b = await user("Edit Beta");
      const card = await create(a.token, { title: "Diwali campaign", dueDate: "2026-10-20" });
      const r1 = await patch(card.id, a.token, { title: "Diwali 2026" }, { title: "Diwali campaign" });
      expect(r1.status).toBe(200);
      expect(r1.body.data.header).toMatchObject({ title: "Diwali 2026", headerRev: 2 });
      const r2 = await patch(card.id, b.token, { dueDate: "2026-10-25" }, { dueDate: "2026-10-20" });
      expect(r2.status).toBe(200);
      expect(r2.body.data.header).toMatchObject({ title: "Diwali 2026", dueDate: "2026-10-25", headerRev: 3 });

      const clash = await patch(card.id, b.token, { title: "Holi" }, { title: "Diwali campaign" });
      expect(clash.status).toBe(409);
      expect(clash.body.error.code).toBe("EDIT_CONFLICT");
      expect(clash.body.error.current).toMatchObject({ id: card.id, title: "Diwali 2026" });
    });

    it("a retried edit (current already equals the change) is a 200 no-op without a header or board bump", async () => {
      const a = await user("Edit Retry");
      const card = await create(a.token, { title: "Old" });
      await patch(card.id, a.token, { title: "New" }, { title: "Old" });
      const v = await boardSeq();
      const again = await patch(card.id, a.token, { title: "New" }, { title: "Old" });
      expect(again.status).toBe(200);
      expect(again.body.data.header).toMatchObject({ title: "New", headerRev: 2 });
      expect(await boardSeq()).toBe(v);
    });

    it("due < start (against the stored start) is 400 DATE_ORDER; a description-only edit does not bump the board", async () => {
      const a = await user("Edit Dates");
      const card = await create(a.token, { startDate: "2026-10-10" });
      const bad = await patch(card.id, a.token, { dueDate: "2026-10-01" }, { dueDate: null });
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe("DATE_ORDER");
      const v = await boardSeq();
      const desc = await patch(card.id, a.token, { description: "New brief" }, { description: "" });
      expect(desc.status).toBe(200);
      expect(desc.body.data.header.description).toBe("New brief");
      expect(await boardSeq()).toBe(v);
    });

    it("an archived project is 409 PROJECT_ARCHIVED", async () => {
      const a = await user("Edit Archived");
      const card = await create(a.token);
      await prisma.pipelineProject.update({ where: { id: card.id }, data: { archivedAt: new Date() } });
      const r = await patch(card.id, a.token, { title: "X" }, { title: "Diwali campaign" });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe("PROJECT_ARCHIVED");
    });
  });

  describe("POST /pipeline/projects/:id/move", () => {
    const move = (id: string, token: string, body: object) => call("post", `${P}/${id}/move`, token, body);

    it("moves to the top of the target phase; a retry after success is a no-op 200", async () => {
      const a = await user("Move One");
      const brief = await phase("brief");
      const planning = await phase("planning");
      const existing = await create(a.token, { phaseId: planning.id, title: "Already there" });
      const card = await create(a.token);
      const r = await move(card.id, a.token, { toPhaseId: planning.id, afterId: null, basePhaseId: brief.id });
      expect(r.status).toBe(200);
      expect(r.body.data.placementAdjusted).toBe(false);
      expect(r.body.data.card.phaseId).toBe(planning.id);
      expect(compareRank(r.body.data.card.rank, existing.rank)).toBe(-1);
      const row = await prisma.pipelineProject.findUniqueOrThrow({ where: { id: card.id } });
      expect(row).toMatchObject({ phaseChangedById: a.id, moveGen: 1, moveActorId: a.id, moveFromPhaseId: brief.id, headerRev: 2 });

      const v = await boardSeq();
      const retry = await move(card.id, a.token, { toPhaseId: planning.id, afterId: null, basePhaseId: brief.id });
      expect(retry.status).toBe(200);
      expect(retry.body.data.card.rank).toBe(r.body.data.card.rank);
      expect((await prisma.pipelineProject.findUniqueOrThrow({ where: { id: card.id } })).headerRev).toBe(2);
      expect(await boardSeq()).toBe(v);
    });

    it("a move whose current phase is neither the base nor the target is 409 MOVE_CONFLICT {current}", async () => {
      const a = await user("Move Clash");
      const [brief, planning, review] = [await phase("brief"), await phase("planning"), await phase("review")];
      const card = await create(a.token);
      await move(card.id, a.token, { toPhaseId: planning.id, afterId: null, basePhaseId: brief.id });
      const r = await move(card.id, a.token, { toPhaseId: review.id, afterId: null, basePhaseId: brief.id });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe("MOVE_CONFLICT");
      expect(r.body.error.current).toMatchObject({ id: card.id, phaseId: planning.id });
    });

    it("someone else reordering the phase first is not a conflict", async () => {
      const a = await user("Move Reorder A");
      const b = await user("Move Reorder B");
      const brief = await phase("brief");
      const review = await phase("review");
      const c1 = await create(a.token, { title: "c1" });
      const c2 = await create(a.token, { title: "c2" }); // order: c2, c1
      const reorder = await move(c2.id, b.token, { toPhaseId: brief.id, afterId: c1.id, basePhaseId: brief.id });
      expect(reorder.status).toBe(200);
      expect(compareRank(c1.rank, reorder.body.data.card.rank)).toBe(-1);
      expect((await prisma.pipelineProject.findUniqueOrThrow({ where: { id: c2.id } })).moveGen).toBe(0); // a reorder is not a move
      const mine = await move(c1.id, a.token, { toPhaseId: review.id, afterId: null, basePhaseId: brief.id });
      expect(mine.status).toBe(200);
      expect(mine.body.data.card.phaseId).toBe(review.id);
    });

    it("an archived target phase is 409 PHASE_ARCHIVED; a vanished afterId places the card last", async () => {
      const a = await user("Move Phase");
      const brief = await phase("brief");
      const planning = await phase("planning");
      const old = await prisma.pipelinePhase.create({ data: { key: "old", name: "Old", position: 99, archivedAt: new Date() } });
      const card = await create(a.token);
      const r = await move(card.id, a.token, { toPhaseId: old.id, afterId: null, basePhaseId: brief.id });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe("PHASE_ARCHIVED");

      const other = await create(a.token, { phaseId: planning.id, title: "Other" });
      const adj = await move(card.id, a.token, { toPhaseId: planning.id, afterId: uuid(), basePhaseId: brief.id });
      expect(adj.status).toBe(200);
      expect(adj.body.data.placementAdjusted).toBe(true);
      expect(compareRank(other.rank, adj.body.data.card.rank)).toBe(-1);
    });

    it("same actor within 2 minutes keeps the generation; moving back to the origin is net-zero", async () => {
      const a = await user("Move Merge");
      const [brief, planning, review] = [await phase("brief"), await phase("planning"), await phase("review")];
      const card = await create(a.token);
      await move(card.id, a.token, { toPhaseId: planning.id, afterId: null, basePhaseId: brief.id });
      await move(card.id, a.token, { toPhaseId: review.id, afterId: null, basePhaseId: planning.id });
      let row = await prisma.pipelineProject.findUniqueOrThrow({ where: { id: card.id } });
      expect(row).toMatchObject({ moveGen: 1, moveFromPhaseId: brief.id, moveActorId: a.id });
      await move(card.id, a.token, { toPhaseId: brief.id, afterId: null, basePhaseId: review.id });
      row = await prisma.pipelineProject.findUniqueOrThrow({ where: { id: card.id } });
      expect(row).toMatchObject({ moveGen: 1, moveActorId: null, phaseId: brief.id });
    });

    it("a key over 64 characters triggers a locked rebalance that preserves the order", async () => {
      const a = await user("Move Rebalance");
      const planning = await phase("planning");
      const A = "a0" + "V".repeat(61); // 63 chars
      const B = A + "1"; // 64: keyBetween(A, B) needs 65
      const C = "a0" + "V".repeat(60) + "W";
      const seeded: string[] = [];
      for (const [title, rank] of [["A", A], ["B", B], ["C", C]]) {
        const row = await prisma.pipelineProject.create({
          data: { clientId: uuid(), title, ownerId: a.id, createdById: a.id, phaseId: planning.id, rank },
        });
        seeded.push(row.id);
      }
      const card = await create(a.token, { title: "X" });
      const r = await move(card.id, a.token, { toPhaseId: planning.id, afterId: seeded[0], basePhaseId: card.phaseId });
      expect(r.status).toBe(200);
      const rows = await prisma.pipelineProject.findMany({ where: { phaseId: planning.id } });
      const ordered = [...rows].sort((x, y) => compareRank(x.rank, y.rank) || (x.id < y.id ? -1 : 1));
      expect(ordered.map((x) => x.title)).toEqual(["A", "X", "B", "C"]);
      for (const x of rows) expect(x.rank.length).toBeLessThanOrEqual(8);
      expect(r.body.data.card.rank).toBe(ordered[1].rank);
    });
  });

  // ── Task 7.4: archive, unarchive, delete, restore, owner transfer (routes #9–11) ──
  describe("archive / unarchive / delete / restore / owner transfer", () => {
    const act = (id: string, token: string, what: "archive" | "unarchive" | "restore") => call("post", `${P}/${id}/${what}`, token, {});
    const del = (id: string, token: string, confirmTitle: string) => call("delete", `${P}/${id}`, token, { confirmTitle });

    it("a non-owner non-admin gets 403 NOT_OWNER_OR_ADMIN; archive is idempotent and bumps the board once", async () => {
      const owner = await user("Arch Owner");
      const other = await user("Arch Other");
      const card = await create(owner.token);
      const denied = await act(card.id, other.token, "archive");
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe("NOT_OWNER_OR_ADMIN");

      const v = await boardSeq();
      const r = await act(card.id, owner.token, "archive");
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({ card: { id: card.id }, phaseAdjusted: false });
      const again = await act(card.id, owner.token, "archive");
      expect(again.status).toBe(200);
      expect(await boardSeq()).toBe(v + 1);
      const row = await prisma.pipelineProject.findUniqueOrThrow({ where: { id: card.id } });
      expect(row).toMatchObject({ archivedById: owner.id, archivedByAdmin: false });
      expect(row.archivedAt).not.toBeNull();
    });

    it("admin status comes from the DB: empty JWT roles still admit an admin; JWT-only roles admit no one", async () => {
      const owner = await user("Roles Owner");
      const admin = await createPipelineUser({ name: "Roles Admin", tag: "roles-admin", roleNames: ["Admin"] });
      const pretender = await createPipelineUser({ name: "Roles Pretender", tag: "roles-pretender" });
      const card = await create(owner.token);
      const fake = await act(card.id, hrToken(pretender.id, { roles: ["Admin", "Super Admin"] }), "archive");
      expect(fake.status).toBe(403);
      const real = await act(card.id, hrToken(admin.id, { roles: [] }), "archive");
      expect(real.status).toBe(200);
      expect((await prisma.pipelineProject.findUniqueOrThrow({ where: { id: card.id } })).archivedByAdmin).toBe(true);
      const ownerUnarchive = await act(card.id, owner.token, "unarchive");
      expect(ownerUnarchive.status).toBe(403);
      expect(ownerUnarchive.body.error.code).toBe("REMOVED_BY_ADMIN");
    });

    it("after an admin delete, the owner's restore is 403 REMOVED_BY_ADMIN and the admin's is 200", async () => {
      const owner = await user("Del Owner");
      const admin = await user("Del Admin", { roleNames: ["Super Admin"] });
      const card = await create(owner.token, { title: "Launch plan" });
      const r = await del(card.id, admin.token, "Launch plan");
      expect(r.status).toBe(200);
      expect(r.body.data).toEqual({ deleted: true });
      expect((await del(card.id, admin.token, "Launch plan")).status).toBe(200); // idempotent
      expect((await call("get", `${P}/${card.id}`, owner.token)).body.error.code).toBe("PROJECT_DELETED");

      const byOwner = await act(card.id, owner.token, "restore");
      expect(byOwner.status).toBe(403);
      expect(byOwner.body.error.code).toBe("REMOVED_BY_ADMIN");
      const byAdmin = await act(card.id, admin.token, "restore");
      expect(byAdmin.status).toBe(200);
      const row = await prisma.pipelineProject.findUniqueOrThrow({ where: { id: card.id } });
      expect(row).toMatchObject({ deletedAt: null, deletedById: null, deletedByAdmin: false });
    });

    it("a restore after 30 days is 409 RESTORE_WINDOW_PASSED; a wrong confirmTitle is 409 CONFIRM_MISMATCH", async () => {
      const owner = await user("Win Owner");
      const card = await create(owner.token, { title: "Old campaign" });
      const wrong = await del(card.id, owner.token, "Old campaig");
      expect(wrong.status).toBe(409);
      expect(wrong.body.error.code).toBe("CONFIRM_MISMATCH");
      expect((await del(card.id, owner.token, "  Old campaign ")).status).toBe(200);
      await prisma.pipelineProject.update({ where: { id: card.id }, data: { deletedAt: new Date(Date.now() - 31 * 86_400_000) } });
      const late = await act(card.id, owner.token, "restore");
      expect(late.status).toBe(409);
      expect(late.body.error.code).toBe("RESTORE_WINDOW_PASSED");
    });

    it("unarchiving into an archived phase relocates the card to the first live phase at the top", async () => {
      const owner = await user("Reloc Owner");
      const old = await prisma.pipelinePhase.create({ data: { key: "old", name: "Old", position: 99 } });
      const brief = await phase("brief");
      const top = await create(owner.token, { title: "Top of Brief" });
      const card = await create(owner.token, { phaseId: old.id, title: "In old phase" });
      await act(card.id, owner.token, "archive");
      await prisma.pipelineProject.update({ where: { id: card.id }, data: { phaseId: old.id } });
      await prisma.pipelinePhase.update({ where: { id: old.id }, data: { archivedAt: new Date() } });
      const r = await act(card.id, owner.token, "unarchive");
      expect(r.status).toBe(200);
      expect(r.body.data.phaseAdjusted).toBe(true);
      expect(r.body.data.card.phaseId).toBe(brief.id);
      expect(compareRank(r.body.data.card.rank, top.rank)).toBe(-1);
      expect((await prisma.pipelineProject.findUniqueOrThrow({ where: { id: card.id } })).archivedAt).toBeNull();
    });

    it("a relocation (unarchive or restore out of an archived phase) records the phase change; a plain one leaves it alone", async () => {
      // The header reads "<when> · Moved to <phase> by <who>" from phase_changed_*: after a
      // relocation it must not pair the NEW phase with an OLD move's person and time.
      const owner = await user("Stamp Owner");
      const aisha = await user("Stamp Aisha");
      const old = await prisma.pipelinePhase.create({ data: { key: "old-stamp", name: "Legacy review", position: 98 } });
      const oldMove = { phaseChangedAt: new Date("2026-08-03T04:30:00.000Z"), phaseChangedById: aisha.id };
      const unarchived = await create(owner.token, { phaseId: old.id, title: "Unarchive me" });
      const restored = await create(owner.token, { phaseId: old.id, title: "Restore me" });
      const plain = await create(owner.token, { title: "Stays put" });
      for (const c of [unarchived, restored, plain]) {
        await prisma.pipelineProject.update({ where: { id: c.id }, data: oldMove });
      }
      await act(unarchived.id, owner.token, "archive");
      await act(plain.id, owner.token, "archive");
      expect((await del(restored.id, owner.token, "Restore me")).status).toBe(200);
      await prisma.pipelinePhase.update({ where: { id: old.id }, data: { archivedAt: new Date() } });

      for (const [c, what] of [[unarchived, "unarchive"], [restored, "restore"]] as const) {
        const r = await act(c.id, owner.token, what);
        expect(r.status).toBe(200);
        expect(r.body.data.phaseAdjusted).toBe(true);
        const row = await prisma.pipelineProject.findUniqueOrThrow({ where: { id: c.id } });
        expect(row.phaseChangedById).toBe(owner.id);
        expect(Math.abs(Date.now() - row.phaseChangedAt!.getTime())).toBeLessThan(60_000);
      }
      expect((await act(plain.id, owner.token, "unarchive")).body.data.phaseAdjusted).toBe(false);
      expect(await prisma.pipelineProject.findUniqueOrThrow({ where: { id: plain.id } })).toMatchObject(oldMove);
    });

    it("owner transfer sets owner_id, gives the new owner a MEMBER row with notify, and refuses an inactive target", async () => {
      const owner = await user("Xfer Owner");
      const next = await user("Xfer Next");
      const gone = await user("Xfer Gone", { status: "INACTIVE" });
      const stranger = await user("Xfer Stranger");
      const card = await create(owner.token);
      const denied = await call("put", `${P}/${card.id}/owner`, stranger.token, { userId: stranger.id });
      expect(denied.status).toBe(403);
      const inactive = await call("put", `${P}/${card.id}/owner`, owner.token, { userId: gone.id });
      expect(inactive.status).toBe(409);
      expect(inactive.body.error.code).toBe("USER_NOT_PICKABLE");

      const v = await boardSeq();
      const r = await call("put", `${P}/${card.id}/owner`, owner.token, { userId: next.id });
      expect(r.status).toBe(200);
      expect(r.body.data.header).toMatchObject({ ownerId: next.id, memberCount: 2 });
      expect(await boardSeq()).toBe(v + 1);
      const row = await prisma.pipelineParticipant.findUniqueOrThrow({ where: { projectId_userId: { projectId: card.id, userId: next.id } } });
      expect(row).toMatchObject({ role: "MEMBER", notify: true });
      // The old owner may no longer act as owner.
      expect((await act(card.id, owner.token, "archive")).status).toBe(403);
    });
  });

  // ── Task 7.5: members and follow (routes #12–14, §4.6) ────────────────────────────
  describe("members and follow", () => {
    const add = (id: string, token: string, userIds: string[]) => call("post", `${P}/${id}/members`, token, { userIds });
    const remove = (id: string, token: string, userId: string) => call("delete", `${P}/${id}/members/${userId}`, token);
    const follow = (id: string, token: string, following: boolean) => call("put", `${P}/${id}/follow`, token, { following });
    const part = (projectId: string, userId: string) =>
      prisma.pipelineParticipant.findUnique({ where: { projectId_userId: { projectId, userId } } });
    const project = (id: string) => prisma.pipelineProject.findUniqueOrThrow({ where: { id } });

    it("owner or admin: an engaged member is demoted, a never-engaged one is deleted", async () => {
      const owner = await user("Mem Owner");
      const admin = await user("Mem Admin", { roleNames: ["Admin"] });
      const [a, b, c] = [await user("Mem A"), await user("Mem B"), await user("Mem C")];
      const card = await create(owner.token, { memberIds: [a.id, b.id, c.id] });
      await prisma.pipelineParticipant.update({
        where: { projectId_userId: { projectId: card.id, userId: a.id } },
        data: { engagedAt: new Date(), notify: false, lastReadSeq: 7 },
      });
      const demoted = await remove(card.id, owner.token, a.id);
      expect(demoted.status).toBe(200);
      expect(demoted.body.data).toEqual({ result: "demoted" });
      expect(await part(card.id, a.id)).toMatchObject({ role: "FOLLOWER", notify: false, lastReadSeq: 7 });
      expect((await remove(card.id, owner.token, b.id)).body.data).toEqual({ result: "removed" });
      expect(await part(card.id, b.id)).toBeNull();
      expect((await remove(card.id, admin.token, c.id)).body.data).toEqual({ result: "removed" });
      expect((await remove(card.id, owner.token, c.id)).body.data).toEqual({ result: "none" });
      expect((await project(card.id)).memberCount).toBe(1);
    });

    it("the adder can undo within 10 minutes, only for rows they added", async () => {
      const owner = await user("Undo Owner");
      const adder = await user("Undo Adder");
      const [a, d, e] = [await user("Undo A"), await user("Undo D"), await user("Undo E")];
      const card = await create(owner.token, { memberIds: [a.id] });
      const r = await add(card.id, adder.token, [d.id, e.id]);
      expect(r.status).toBe(200);
      expect(r.body.data.added.sort()).toEqual([d.id, e.id].sort());
      expect((await remove(card.id, adder.token, d.id)).body.data).toEqual({ result: "removed" });
      const notMine = await remove(card.id, adder.token, a.id);
      expect(notMine.status).toBe(403);
      expect(notMine.body.error.code).toBe("CANNOT_REMOVE_MEMBER");
      await prisma.pipelineParticipant.update({
        where: { projectId_userId: { projectId: card.id, userId: e.id } },
        data: { memberAddedAt: new Date(Date.now() - 11 * 60_000) },
      });
      expect((await remove(card.id, adder.token, e.id)).status).toBe(403);
    });

    it("removing or leaving the owner is 409; anyone else may leave (deleting their own row)", async () => {
      const owner = await user("Own Owner");
      const admin = await user("Own Admin", { roleNames: ["Admin"] });
      const a = await user("Own A");
      const card = await create(owner.token, { memberIds: [a.id] });
      const byAdmin = await remove(card.id, admin.token, owner.id);
      expect(byAdmin.status).toBe(409);
      expect(byAdmin.body.error.code).toBe("OWNER_CANNOT_BE_REMOVED");
      expect((await remove(card.id, owner.token, owner.id)).body.error.code).toBe("OWNER_CANNOT_BE_REMOVED");
      await prisma.pipelineParticipant.update({ where: { projectId_userId: { projectId: card.id, userId: a.id } }, data: { engagedAt: new Date() } });
      expect((await remove(card.id, a.token, a.id)).body.data).toEqual({ result: "removed" });
      expect(await part(card.id, a.id)).toBeNull();
    });

    it("after a transfer the new owner cannot be removed, but the old one can", async () => {
      const owner = await user("Xo Owner");
      const next = await user("Xo Next");
      const card = await create(owner.token);
      await call("put", `${P}/${card.id}/owner`, owner.token, { userId: next.id });
      expect((await remove(card.id, next.token, next.id)).body.error.code).toBe("OWNER_CANNOT_BE_REMOVED");
      expect((await remove(card.id, next.token, owner.id)).body.data).toEqual({ result: "removed" });
      expect((await project(card.id)).memberCount).toBe(1);
    });

    it("adding never changes notify; [b, b] gives one row; a repeat add is a no-op", async () => {
      const owner = await user("Add Owner");
      const [b, f] = [await user("Add B"), await user("Add F")];
      const card = await create(owner.token);
      await prisma.pipelineParticipant.create({
        data: { projectId: card.id, userId: f.id, role: "FOLLOWER", notify: false, engagedAt: new Date() },
      });
      const r = await add(card.id, owner.token, [b.id, b.id, f.id]);
      expect(r.status).toBe(200);
      expect(r.body.data.added.sort()).toEqual([b.id, f.id].sort());
      expect(r.body.data.participants).toHaveLength(3);
      expect(await part(card.id, f.id)).toMatchObject({ role: "MEMBER", notify: false, memberAddedById: owner.id });
      expect(await prisma.pipelineParticipant.count({ where: { projectId: card.id, userId: b.id } })).toBe(1);
      const hv = (await project(card.id)).headerRev;
      const again = await add(card.id, owner.token, [b.id]);
      expect(again.body.data.added).toEqual([]);
      expect((await project(card.id)).headerRev).toBe(hv);
      expect((await project(card.id)).memberCount).toBe(3);
    });

    it("every route carries memberAddedAt: a promoted follower's undo window starts at the ADD, not the follow (B8)", async () => {
      const owner = await user("Wire Owner");
      const f = await user("Wire Follower");
      const card = await create(owner.token);
      const followedAt = new Date(Date.now() - 3 * 86_400_000);
      await prisma.pipelineParticipant.create({
        data: { projectId: card.id, userId: f.id, role: "FOLLOWER", notify: true, engagedAt: followedAt, createdAt: followedAt },
      });
      type Part = { userId: string; createdAt: string; memberAddedAt: string | null; memberAddedById: string | null };
      const r = await add(card.id, owner.token, [f.id]);
      expect(r.status).toBe(200);
      const viaAdd = (r.body.data.participants as Part[]).find((p) => p.userId === f.id)!;
      expect(viaAdd.createdAt).toBe(followedAt.toISOString()); // the follow, unchanged by the promotion
      expect(viaAdd.memberAddedById).toBe(owner.id);
      expect(Math.abs(Date.now() - Date.parse(viaAdd.memberAddedAt!))).toBeLessThan(60_000); // the add
      expect((r.body.data.participants as Part[]).find((p) => p.userId === owner.id)!.memberAddedAt).toBeNull();

      const detail = await call("get", `${P}/${card.id}`, owner.token);
      expect((detail.body.data.participants as Part[]).find((p) => p.userId === f.id)!.memberAddedAt).toBe(viaAdd.memberAddedAt);
      const s = await call("post", "/v1/pipeline/sync", owner.token, { clientBuild: 1, project: { id: card.id, rev: 0, hv: 0 } });
      expect((s.body.data.project.participants as Part[]).find((p) => p.userId === f.id)!.memberAddedAt).toBe(viaAdd.memberAddedAt);
    });

    it("refuses an archived project (409), an inactive user (409 MEMBER_NOT_PICKABLE) and a 201st participant (409 MEMBER_LIMIT)", async () => {
      const owner = await user("Lim Owner");
      const gone = await user("Lim Gone", { status: "INACTIVE" });
      const card = await create(owner.token);
      expect((await add(card.id, owner.token, [gone.id])).body.error.code).toBe("MEMBER_NOT_PICKABLE");
      await prisma.user.createMany({
        data: Array.from({ length: 200 }, (_, i) => ({ name: `Bulk ${i}`, email: `pl-bulk-${i}-${Date.now()}@test.com`, passwordHash: "x", status: "ACTIVE" })),
      });
      const bulk = await prisma.user.findMany({ where: { name: { startsWith: "Bulk " } }, select: { id: true }, orderBy: { id: "asc" } });
      await prisma.pipelineParticipant.createMany({
        data: bulk.slice(0, 199).map((u) => ({ projectId: card.id, userId: u.id, role: "FOLLOWER" })),
      });
      const over = await add(card.id, owner.token, [bulk[199].id]);
      expect(over.status).toBe(409);
      expect(over.body.error.code).toBe("MEMBER_LIMIT");
      await prisma.pipelineProject.update({ where: { id: card.id }, data: { archivedAt: new Date() } });
      expect((await add(card.id, owner.token, [bulk[0].id])).body.error.code).toBe("PROJECT_ARCHIVED");
    });

    it("every change bumps header_rev, and member_count stays exact under 10 parallel add/remove calls", async () => {
      const owner = await user("Par Owner");
      const people = [];
      for (let i = 0; i < 10; i++) people.push(await user(`Par P${i}`));
      const card = await create(owner.token, { memberIds: people.slice(5).map((p) => p.id) });
      const hv = (await project(card.id)).headerRev;
      const results = await Promise.allSettled([
        ...people.slice(0, 5).map((p) => add(card.id, owner.token, [p.id])),
        ...people.slice(5).map((p) => remove(card.id, owner.token, p.id)),
      ]);
      for (const r of results) {
        expect(r.status).toBe("fulfilled");
        if (r.status === "fulfilled") expect(r.value.status).toBe(200);
      }
      const row = await project(card.id);
      const members = await prisma.pipelineParticipant.count({ where: { projectId: card.id, role: "MEMBER" } });
      expect(members).toBe(6);
      expect(row.memberCount).toBe(6);
      expect(row.headerRev).toBe(hv + 10);
    });

    it("follow is self-only and idempotent; unfollow keeps the row and clears notify", async () => {
      const owner = await user("Fol Owner");
      const me = await user("Fol Me");
      const card = await create(owner.token);
      const on = await follow(card.id, me.token, true);
      expect(on.status).toBe(200);
      expect(on.body.data).toEqual({ role: "FOLLOWER", notify: true });
      const row = await part(card.id, me.id);
      expect(row?.engagedAt).not.toBeNull();
      const hv = (await project(card.id)).headerRev;
      expect((await follow(card.id, me.token, true)).body.data).toEqual({ role: "FOLLOWER", notify: true });
      expect((await project(card.id)).headerRev).toBe(hv);
      expect((await follow(card.id, me.token, false)).body.data).toEqual({ role: "FOLLOWER", notify: false });
      expect((await follow(card.id, me.token, false)).body.data).toEqual({ role: "FOLLOWER", notify: false });
      expect((await project(card.id)).headerRev).toBe(hv + 1);
      // The owner unfollowing stays a MEMBER.
      expect((await follow(card.id, owner.token, false)).body.data).toEqual({ role: "MEMBER", notify: false });
      // A non-participant unfollowing is a no-op.
      const stranger = await user("Fol Stranger");
      expect((await follow(card.id, stranger.token, false)).body.data).toEqual({ role: null, notify: false });
      expect((await project(card.id)).memberCount).toBe(1);
    });
  });
});
