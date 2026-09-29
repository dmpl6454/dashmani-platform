/**
 * Skip-freedom proof for the sync delta cursor (spec §5.1, §11 "Concurrency suite").
 *
 * One poller per project calls POST /pipeline/sync every 20 ms, carrying its own
 * {rev, hv} cursor, while 200 mixed writes (top-level posts, replies, edits, reaction
 * toggles, reply deletes) race across 3 projects on the production-sized pipeline pool.
 * After the writers stop, each poller drains to the head. Then:
 *   - no (message id, rev) pair was delivered twice;
 *   - every message's FINAL state (its last rev) was delivered exactly once, and the
 *     delivered copy equals the row in the database.
 * Repeated CC_REPEATS times (default 20) in fresh data.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { startServer, stopServer, call, freshPipeline, users, createProject, randomUUID, prisma, sleep } from "./cc-helpers";
import { pipelineDb } from "../../src/services/pipeline/db";
import { __setSyncDeltaLimitForTests } from "../../src/services/pipeline/sync.service";

const REPEATS = Number(process.env.CC_REPEATS || 20);
const WRITES = 200;
const WRITERS = 6;
const EMOJI = ["thumbs_up", "heart", "laugh"];

interface Seen {
  body: string;
  deleted: boolean;
  reactions: Record<string, string[]>;
  replyCount: number;
}

function norm(r: Record<string, string[]> | null | undefined): string {
  const o: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(r ?? {})) if (v.length) o[k] = [...v].sort();
  return JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
}

async function oneRound(round: number) {
  const team = await users(4, `sf${round}`);
  const ids = team.map((u) => u.id);
  const projects = [];
  for (let i = 0; i < 3; i++) projects.push(await createProject(ids[0], `SF ${round}.${i}`, ids.slice(1)));

  // ── pollers ──
  const delivered = new Map<string, number>(); // `${id}@${rev}` → times
  const last = new Map<string, { rev: number; seen: Seen }>(); // id → highest rev seen
  const syncStatuses: number[] = [];
  let stop = false;
  const cursors = projects.map(() => ({ rev: 0, hv: 0 }));

  async function syncOnce(pi: number) {
    const c = cursors[pi];
    const r = await call("POST", "/pipeline/sync", ids[0], { clientBuild: 1, project: { id: projects[pi].id, rev: c.rev, hv: c.hv } });
    syncStatuses.push(r.status);
    if (r.status !== 200) return { hasMore: false };
    const p = r.body.data.project;
    for (const m of p.messages) {
      const key = `${m.id}@${m.rev}`;
      delivered.set(key, (delivered.get(key) ?? 0) + 1);
      const prev = last.get(m.id);
      if (!prev || m.rev > prev.rev) {
        last.set(m.id, {
          rev: m.rev,
          seen: { body: m.body, deleted: m.deletedAt !== null, reactions: m.reactions, replyCount: m.replyCount },
        });
      }
    }
    c.rev = p.rev;
    c.hv = p.hv;
    return { hasMore: p.hasMore as boolean };
  }

  const pollers = projects.map(async (_p, pi) => {
    while (!stop) {
      const t0 = Date.now();
      await syncOnce(pi);
      const wait = 20 - (Date.now() - t0);
      if (wait > 0) await sleep(wait);
    }
  });

  // ── writers ──
  type Msg = { id: string; projectId: string; author: string; parentId: string | null; deleted: boolean };
  const msgs: Msg[] = [];
  const writeStatuses: number[] = [];
  let remaining = WRITES;
  const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];

  async function writer() {
    while (remaining > 0) {
      remaining--;
      // Pace the writers (5–40 ms) so each round spans many 20 ms polls: the proof needs
      // commits landing BETWEEN polls, not 200 writes finishing before the second poll.
      await sleep(5 + Math.floor(Math.random() * 36));
      const pi = Math.floor(Math.random() * 3);
      const pid = projects[pi].id;
      const mine = msgs.filter((m) => m.projectId === pid && !m.deleted);
      const roll = Math.random();
      if (mine.length < 3 || roll < 0.35) {
        const author = pick(ids);
        const roots = mine.filter((m) => m.parentId === null);
        const parent = roots.length && Math.random() < 0.4 ? pick(roots) : null;
        const r = await call("POST", `/pipeline/projects/${pid}/messages`, author, {
          clientId: randomUUID(),
          body: `w${Math.random().toString(36).slice(2, 8)}`,
          ...(parent ? { parentId: parent.id } : {}),
        });
        writeStatuses.push(r.status);
        if (r.status === 201) msgs.push({ id: r.body.data.message.id, projectId: pid, author, parentId: parent ? parent.id : null, deleted: false });
      } else if (roll < 0.55) {
        const m = pick(mine);
        const r = await call("PATCH", `/pipeline/messages/${m.id}`, m.author, { body: `e${Math.random().toString(36).slice(2, 8)}` });
        writeStatuses.push(r.status);
      } else if (roll < 0.85) {
        const m = pick(mine);
        const r = await call("PUT", `/pipeline/messages/${m.id}/reactions/${pick(EMOJI)}`, pick(ids), { on: Math.random() < 0.7 });
        writeStatuses.push(r.status);
      } else {
        const replies = mine.filter((m) => m.parentId !== null);
        const m = replies.length ? pick(replies) : pick(mine);
        m.deleted = true;
        const r = await call("DELETE", `/pipeline/messages/${m.id}`, m.author);
        writeStatuses.push(r.status);
      }
    }
  }
  await Promise.all(Array.from({ length: WRITERS }, writer));

  // ── drain ──
  stop = true;
  await Promise.all(pollers);
  for (let pi = 0; pi < 3; pi++) {
    for (let guard = 0; guard < 100; guard++) {
      const { hasMore } = await syncOnce(pi);
      if (!hasMore) break;
    }
  }

  // ── assertions ──
  expect(writeStatuses.filter((s) => s >= 500)).toEqual([]);
  expect(syncStatuses.filter((s) => s !== 200)).toEqual([]);
  const dupes = [...delivered.entries()].filter(([, n]) => n > 1);
  expect(dupes).toEqual([]);

  const rows = await prisma.pipelineMessage.findMany({ where: { projectId: { in: projects.map((p) => p.id) } } });
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(delivered.get(`${row.id}@${row.rev}`), `final state of ${row.id} (rev ${row.rev})`).toBe(1);
    const seen = last.get(row.id)!;
    expect(seen.rev).toBe(row.rev);
    expect(seen.seen.deleted).toBe(row.deletedAt !== null);
    expect(seen.seen.body).toBe(row.body);
    expect(seen.seen.replyCount).toBe(row.replyCount);
    expect(norm(seen.seen.reactions)).toBe(norm(row.reactions as Record<string, string[]>));
  }
  for (let pi = 0; pi < 3; pi++) {
    const head = await prisma.pipelineProject.findUniqueOrThrow({ where: { id: projects[pi].id } });
    expect(cursors[pi].rev).toBe(head.threadRev);
  }
  return { writes: writeStatuses.length, syncs: syncStatuses.length, messages: rows.length };
}

describe("pipeline sync skip-freedom", () => {
  beforeAll(startServer);
  afterAll(async () => {
    await stopServer();
    await pipelineDb.$disconnect();
  });
  beforeEach(freshPipeline);

  it(`a 20 ms poller observes every final message state exactly once under 200 mixed writes (×${REPEATS})`, async () => {
    const stats = [];
    try {
      for (let i = 0; i < REPEATS; i++) {
        // Odd rounds page the delta 3 rows at a time, so the hasMore cursor (the page's
        // last rev, not the head) is exercised under the same race.
        __setSyncDeltaLimitForTests(i % 2 === 1 ? 3 : null);
        stats.push(await oneRound(i));
      }
    } finally {
      __setSyncDeltaLimitForTests(null);
    }
    const syncs = stats.reduce((a, s) => a + s.syncs, 0);
    const messages = stats.reduce((a, s) => a + s.messages, 0);
    console.log(`[skip-freedom] ${REPEATS} rounds: ${syncs} syncs, ${messages} messages checked, 0 skips, 0 duplicates`);
  });
});
