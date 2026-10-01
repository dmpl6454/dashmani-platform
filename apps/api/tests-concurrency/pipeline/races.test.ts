/**
 * Pipeline concurrency races (spec §11 "Concurrency suite", plan Task 12.1).
 *
 * Every test fires genuinely concurrent requests at ONE listening server with the
 * pipeline pool at its production size (3), then asserts the invariant on the database
 * — the raceAssert shape: the right number of winners, every loser a CLEAN 200/409,
 * never a 5xx.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  startServer,
  stopServer,
  call,
  freshPipeline,
  users,
  createProject,
  phases,
  statusCounts,
  randomUUID,
  prisma,
  sleep,
} from "./cc-helpers";
import { pipelineDb } from "../../src/services/pipeline/db";
import { isBoardBumpPending } from "../../src/services/pipeline/board";
import { plnId } from "../../src/services/pipeline/notify";

const no5xx = (rs: Array<{ status: number }>) => {
  const bad = rs.filter((r) => r.status >= 500);
  expect(bad.map((r: any) => `${r.status} ${JSON.stringify(r.body)}`)).toEqual([]);
};

describe("pipeline concurrency", () => {
  beforeAll(startServer);
  afterAll(async () => {
    await stopServer();
    await pipelineDb.$disconnect();
  });
  beforeEach(freshPipeline);

  it("30 parallel posts in one project → seq 1..30, unique revs, exact last_message_seq", async () => {
    const [owner, ...rest] = await users(4, "posts");
    const p = await createProject(owner.id, "Posts race", rest.map((u) => u.id));
    const writers = [owner, ...rest];
    const rs = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        call("POST", `/pipeline/projects/${p.id}/messages`, writers[i % writers.length].id, { clientId: randomUUID(), body: `m${i}` }),
      ),
    );
    no5xx(rs);
    expect(statusCounts(rs)).toEqual({ 201: 30 });
    const msgs = await prisma.pipelineMessage.findMany({ where: { projectId: p.id }, orderBy: { seq: "asc" } });
    expect(msgs.map((m) => m.seq)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(new Set(msgs.map((m) => m.rev)).size).toBe(30);
    const proj = await prisma.pipelineProject.findUniqueOrThrow({ where: { id: p.id } });
    expect(proj.lastMessageSeq).toBe(30);
    expect(proj.threadRev).toBe(Math.max(...msgs.map((m) => m.rev)));
    // R1: times are taken at S3's start, after the project lock that assigns seq, so they
    // never go backwards in seq order (a transaction-start now() could: "11:00" then "10:59").
    for (let i = 1; i < msgs.length; i++) {
      expect(msgs[i].createdAt.getTime()).toBeGreaterThanOrEqual(msgs[i - 1].createdAt.getTime());
    }
    expect(proj.lastMessageAt?.getTime()).toBe(msgs[msgs.length - 1].createdAt.getTime());
  });

  it("8 parallel duplicate clientId posts → one message", async () => {
    const [owner] = await users(1, "dup");
    const p = await createProject(owner.id, "Dup race");
    const clientId = randomUUID();
    const rs = await Promise.all(
      Array.from({ length: 8 }, () => call("POST", `/pipeline/projects/${p.id}/messages`, owner.id, { clientId, body: "same" })),
    );
    no5xx(rs);
    for (const r of rs) expect([200, 201]).toContain(r.status);
    expect(rs.filter((r) => r.body.data?.replayed === false)).toHaveLength(1);
    expect(await prisma.pipelineMessage.count({ where: { projectId: p.id } })).toBe(1);
  });

  it("10 identical reaction PUTs → one entry", async () => {
    const [owner, bob] = await users(2, "react");
    const p = await createProject(owner.id, "React race", [bob.id]);
    const m = await call("POST", `/pipeline/projects/${p.id}/messages`, owner.id, { clientId: randomUUID(), body: "hi" });
    const mid = m.body.data.message.id;
    const rs = await Promise.all(
      Array.from({ length: 10 }, () => call("PUT", `/pipeline/messages/${mid}/reactions/heart`, bob.id, { on: true })),
    );
    no5xx(rs);
    expect(statusCounts(rs)).toEqual({ 200: 10 });
    const row = await prisma.pipelineMessage.findUniqueOrThrow({ where: { id: mid } });
    const heart = (row.reactions as Record<string, string[]>).heart ?? [];
    expect(heart.filter((u) => u === bob.id)).toHaveLength(1);
  });

  it("10 parallel adds of the same user → one row and one notification", async () => {
    const [owner, carol] = await users(2, "add");
    const p = await createProject(owner.id, "Add race");
    const rs = await Promise.all(
      Array.from({ length: 10 }, () => call("POST", `/pipeline/projects/${p.id}/members`, owner.id, { userIds: [carol.id] })),
    );
    no5xx(rs);
    for (const r of rs) expect([200, 409]).toContain(r.status);
    expect(await prisma.pipelineParticipant.count({ where: { projectId: p.id, userId: carol.id } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: carol.id, id: plnId("added", p.id, carol.id) } })).toBe(1);
    const proj = await prisma.pipelineProject.findUniqueOrThrow({ where: { id: p.id } });
    expect(proj.memberCount).toBe(await prisma.pipelineParticipant.count({ where: { projectId: p.id, role: "MEMBER" } }));
  });

  it("8 parallel moves of one card from the same base phase → 1 phase change, the rest 200/409, no 5xx", async () => {
    const [owner] = await users(1, "move");
    const ph = await phases();
    const base = ph[0];
    const card = await createProject(owner.id, "Move race");
    expect(card.phaseId).toBe(base.id);
    const before = await prisma.pipelineProject.findUniqueOrThrow({ where: { id: card.id } });
    const targets = [ph[1], ph[2], ph[3], ph[4], ph[5], ph[6], ph[1], ph[2]];
    const rs = await Promise.all(
      targets.map((t) => call("POST", `/pipeline/projects/${card.id}/move`, owner.id, { toPhaseId: t.id, afterId: null, basePhaseId: base.id })),
    );
    no5xx(rs);
    for (const r of rs) expect([200, 409]).toContain(r.status);
    const after = await prisma.pipelineProject.findUniqueOrThrow({ where: { id: card.id } });
    // Exactly one generation: one phase change happened.
    expect(after.moveGen).toBe(before.moveGen + 1);
    const winners = rs.map((r, i) => ({ r, t: targets[i] })).filter((x) => x.r.status === 200);
    expect(winners.length).toBeGreaterThanOrEqual(1);
    // Every 200 is either THE move or an idempotent repeat of it (same target).
    for (const w of winners) expect(w.t.id).toBe(after.phaseId);
    for (const r of rs.filter((x) => x.status === 409)) expect(r.body.error?.code).toBe("MOVE_CONFLICT");
  });

  it("12 cards dropped into one gap → all succeed, with a total order after the next move", async () => {
    const [owner] = await users(1, "gap");
    const ph = await phases();
    const [src, dst] = [ph[0], ph[1]];
    const x = await createProject(owner.id, "Anchor X", [], dst.id);
    const y = await createProject(owner.id, "Anchor Y", [], dst.id);
    // Order in dst after two top inserts: y, x.
    const cards = [];
    for (let i = 0; i < 12; i++) cards.push(await createProject(owner.id, `Gap ${i}`, [], src.id));
    const rs = await Promise.all(
      cards.map((c) => call("POST", `/pipeline/projects/${c.id}/move`, owner.id, { toPhaseId: dst.id, afterId: y.id, basePhaseId: src.id })),
    );
    no5xx(rs);
    expect(statusCounts(rs)).toEqual({ 200: 12 });
    const order = async () =>
      (
        await pipelineDb.$queryRaw<Array<{ id: string; rank: string }>>`
          SELECT id, rank FROM pipeline_projects WHERE phase_id = ${dst.id} AND archived_at IS NULL AND deleted_at IS NULL
           ORDER BY rank COLLATE "C", id`
      ).map((r) => r.id);
    const o1 = await order();
    expect(o1).toHaveLength(14);
    expect(o1[0]).toBe(y.id);
    expect(o1[o1.length - 1]).toBe(x.id);
    // The next move lands exactly where it asked, so the order is total again.
    const mover = cards[5];
    const r = await call("POST", `/pipeline/projects/${mover.id}/move`, owner.id, { toPhaseId: dst.id, afterId: x.id, basePhaseId: dst.id });
    expect(r.status).toBe(200);
    const o2 = await order();
    expect(o2).toHaveLength(14);
    expect(o2[o2.length - 1]).toBe(mover.id);
    expect(o2[o2.length - 2]).toBe(x.id);
    expect(new Set(o2).size).toBe(14);
  });

  it("a forced rebalance (keys at the column limit) under 5 concurrent same-phase moves → no deadlock, every move honoured", async () => {
    const [owner] = await users(1, "rebal");
    const ph = await phases();
    const phase = ph[2];
    const cards = [];
    for (let i = 0; i < 10; i++) cards.push(await createProject(owner.id, `Rebal ${i}`, [], phase.id));
    // Seed 64-character consecutive keys (63-char prefix + one digit): any insertion
    // between two neighbours needs a 65-character key, so every move below must take the
    // locked rebalance path.
    const prefix = "a0" + "0".repeat(61);
    for (let i = 0; i < cards.length; i++) {
      await pipelineDb.$executeRaw`UPDATE pipeline_projects SET rank = ${prefix + "123456789A"[i]} WHERE id = ${cards[i].id}`;
    }
    const k = (n: number) => cards[n - 1].id; // k(1)..k(10) in rank order
    const moves = [
      { card: k(10), after: k(1) },
      { card: k(9), after: k(3) },
      { card: k(8), after: k(5) },
      { card: k(2), after: k(6) },
      { card: k(4), after: k(7) },
    ];
    const rs = await Promise.all(
      moves.map((m) => call("POST", `/pipeline/projects/${m.card}/move`, owner.id, { toPhaseId: phase.id, afterId: m.after, basePhaseId: phase.id })),
    );
    no5xx(rs);
    expect(statusCounts(rs)).toEqual({ 200: 5 });
    const rows = await pipelineDb.$queryRaw<Array<{ id: string; rank: string }>>`
      SELECT id, rank FROM pipeline_projects WHERE phase_id = ${phase.id} ORDER BY rank COLLATE "C", id`;
    const order = rows.map((r) => r.id);
    expect(order).toHaveLength(10);
    expect(new Set(rows.map((r) => r.rank)).size).toBe(10);
    for (const r of rows) expect(r.rank.length).toBeLessThanOrEqual(64);
    // Anchors never move and cards are distinct, so every committed move's placement
    // survives the others in any commit order: each card sits directly after its anchor.
    for (const m of moves) expect(order[order.indexOf(m.after) + 1]).toBe(m.card);
  });

  it("fan-out vs ack vs mark-all-read interleaved 500 times → never an unread grouped row for a fully-read project, no 5xx", async () => {
    const [alice, bob] = await users(2, "fan");
    const p = await createProject(alice.id, "Fan race", [bob.id]);
    const groupedId = plnId("messages", p.id, bob.id);
    let lastSeq = 0;
    const statuses: Array<{ status: number; body: any }> = [];
    for (let i = 0; i < 500; i++) {
      const ackSeq = i % 3 === 0 ? lastSeq + 1 : lastSeq; // sometimes ahead of the post, sometimes behind
      const [post, ack, all] = await Promise.all([
        call("POST", `/pipeline/projects/${p.id}/messages`, alice.id, { clientId: randomUUID(), body: `f${i}` }),
        call("POST", `/pipeline/projects/${p.id}/read`, bob.id, { seq: ackSeq, leaving: true }),
        i % 2 === 0 ? call("PUT", "/hr/notifications/read-all", bob.id) : Promise.resolve({ status: 200, body: {} }),
      ]);
      statuses.push(post, ack, all as any);
      if (post.status === 201) lastSeq = post.body.data.message.seq;
      const proj = await prisma.pipelineProject.findUniqueOrThrow({ where: { id: p.id } });
      const me = await prisma.pipelineParticipant.findUniqueOrThrow({ where: { projectId_userId: { projectId: p.id, userId: bob.id } } });
      // Every unread PIPELINE "messages" row of Bob's for this project (the id is
      // deterministic, so a second row could only come from a different id scheme).
      const unread = await prisma.notification.findMany({
        where: { userId: bob.id, read: false, type: "PIPELINE", metadata: { path: ["pid"], equals: p.id } },
      });
      const grouped = unread.filter((n) => (n.metadata as any)?.kind === "messages");
      expect(grouped.every((n) => n.id === groupedId)).toBe(true);
      expect(grouped.length).toBeLessThanOrEqual(1);
      if (me.lastReadSeq >= proj.lastMessageSeq) expect(grouped).toHaveLength(0);
    }
    no5xx(statuses);
  });

  it("due-date edits vs acks interleaved 150 times → every edit lands, no superseded due row survives, an ack can only lose a lock race cleanly (D1)", async () => {
    // A due change writes FOUR of each participant's rows for the project (due-soon and
    // overdue withdrawn, "added" rewritten, due_changed upserted) while each viewer's ack marks
    // the same rows read in one statement that locks them in heap order. A rare overlap makes
    // one side wait out lock_timeout (55P03): the EDIT retries once (retryOnce) and must always
    // succeed; an ack may lose — it is idempotent and re-sent with the next poll — but only as a
    // clean 503 PIPELINE_BUSY, and only rarely.
    const [alice, bob, cara] = await users(3, "dlock");
    const p = await createProject(alice.id, "Due lock race", [bob.id, cara.id]); // "added" rows for Bob and Cara
    const days = ["2026-10-05", "2026-10-06"];
    let due = days[0];
    await pipelineDb.$executeRaw`UPDATE pipeline_projects SET due_date = ${due}::date WHERE id = ${p.id}`;
    const dueRowIds = (d: string) => [bob, cara].flatMap((u) => [plnId("due_soon", p.id, u.id, d), plnId("overdue", p.id, u.id, d)]);
    const seed = async (d: string) => {
      for (const u of [bob, cara]) {
        for (const kind of ["due_soon", "overdue"] as const) {
          const id = plnId(kind, p.id, u.id, d);
          await prisma.notification.upsert({
            where: { id },
            create: { id, userId: u.id, type: "PIPELINE", title: kind, message: "m", read: false, metadata: { v: 1, kind, pid: p.id, due: d } },
            update: { read: false },
          });
        }
      }
    };
    const statuses: Array<{ status: number; body: any }> = [];
    for (let i = 0; i < 150; i++) {
      await seed(due);
      const next = days[(i + 1) % 2];
      const [edit, ...acks] = await Promise.all([
        call("PATCH", `/pipeline/projects/${p.id}`, alice.id, { changes: { dueDate: next }, base: { dueDate: due } }),
        call("POST", `/pipeline/projects/${p.id}/read`, bob.id, { seq: 0, leaving: false }),
        call("POST", `/pipeline/projects/${p.id}/read`, cara.id, { seq: 0, leaving: false }),
        call("POST", "/pipeline/sync", cara.id, { clientBuild: 1, project: { id: p.id, rev: 0, hv: 0, ack: { seq: 0, open: true } } }),
      ]);
      statuses.push(edit, ...acks);
      expect(edit.status).toBe(200);
      const prev = due;
      due = next;
      expect(await prisma.notification.count({ where: { id: { in: dueRowIds(prev) } } })).toBe(0);
    }
    const lost = statuses.filter((r) => r.status >= 500);
    expect(lost.every((r) => r.status === 503 && r.body?.error?.code === "PIPELINE_BUSY")).toBe(true);
    expect(lost.length).toBeLessThanOrEqual(6); // ≤ ~1% of 600 requests; a systematic problem would be many
  });

  it("a post-commit board-bump failure (injected lock) → the next request heals it", async () => {
    const [owner] = await users(1, "bump");
    const ph = await phases();
    const card = await createProject(owner.id, "Bump card");
    const v0 = (await prisma.pipelineBoardState.findUniqueOrThrow({ where: { id: 1 } })).seq;
    // Hold the board row longer than the pipeline lock_timeout (1 s) while a move commits.
    const hold = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT seq FROM pipeline_board_state WHERE id = 1 FOR UPDATE`;
        await sleep(1800);
      },
      { timeout: 10_000 },
    );
    await sleep(100);
    const mv = await call("POST", `/pipeline/projects/${card.id}/move`, owner.id, { toPhaseId: ph[3].id, afterId: null, basePhaseId: ph[0].id });
    expect(mv.status).toBe(200);
    await hold;
    expect(isBoardBumpPending()).toBe(true);
    expect((await prisma.pipelineBoardState.findUniqueOrThrow({ where: { id: 1 } })).seq).toBe(v0);
    // Any gated pipeline request heals it; the snapshot then carries the moved card.
    const s = await call("POST", "/pipeline/sync", owner.id, { clientBuild: 1, board: { v: v0 } });
    expect(s.status).toBe(200);
    expect(isBoardBumpPending()).toBe(false);
    expect(s.body.data.v).toBeGreaterThan(v0);
    const c = s.body.data.board.cards.find((x: any) => x.id === card.id);
    expect(c.phaseId).toBe(ph[3].id);
  });
});
