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
        expect(Object.keys(p).sort()).toEqual(["createdAt", "isOwner", "memberAddedById", "role", "userId"]);
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
});
