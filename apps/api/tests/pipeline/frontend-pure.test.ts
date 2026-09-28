/**
 * pipeline/frontend-pure.test.ts — the HR client's pure logic (spec §5.5, §9.3, §9.4).
 *
 *   sync-state.ts — intervals, back-off, 429 pause, response classification.
 *   store.ts      — idempotent merges, "a failed poll never clears state", pending sends
 *                   resolved by (authorId, clientId), replies arriving before their root.
 *
 * Pure functions only: no DB, no network. They live in @dashmani/shared because the HR
 * bundle runs them and this suite is the only test runner in the repo.
 */
import { describe, it, expect } from "vitest";
import {
  baseIntervalMs,
  nextTickMs,
  backoffMs,
  rateLimitPauseMs,
  onlineWakeDelayMs,
  shouldSyncOnWake,
  postWriteSyncAllowed,
  classifySyncResult,
  planAfterAttempt,
  connectionIndicator,
  planHasMore,
  initialSchedulerState,
  PIPELINE_DEFAULT_POLL_MS,
  initialPipelineState,
  pipelineReducer,
  selectCardsByPhase,
  selectTopLevel,
  selectReplies,
  selectPendingSends,
  selectReactions,
  buildSyncRequest,
  makeClientId,
  keyBetween,
  type IntervalContext,
  type PipelineState,
  type PipelineMessage,
  type PipelineCard,
  type PipelineBoardSnapshot,
  type PipelineProjectDetail,
  type PipelineSyncResponse,
  type PipelineSyncRequest,
  type PipelineHeader,
  type PendingSend,
} from "@dashmani/shared";

const POLL = { ...PIPELINE_DEFAULT_POLL_MS };
const mid = () => 0.5; // no jitter
const lo = () => 0; // −frac
const hi = () => 0.999999; // ≈ +frac

const ctx = (o: Partial<IntervalContext> = {}): IntervalContext => ({
  view: "project",
  visible: true,
  focused: true,
  idle: false,
  online: true,
  ...o,
});

describe("sync-state: intervals (§5.5)", () => {
  it("10 s focused project, 20 s visible-unfocused project", () => {
    expect(baseIntervalMs(ctx(), POLL)).toBe(10_000);
    expect(baseIntervalMs(ctx({ focused: false }), POLL)).toBe(20_000);
  });
  it("15 s focused board, 30 s unfocused board", () => {
    expect(baseIntervalMs(ctx({ view: "board" }), POLL)).toBe(15_000);
    expect(baseIntervalMs(ctx({ view: "board", focused: false }), POLL)).toBe(30_000);
  });
  it("30 s idle — and idle never makes polling faster", () => {
    expect(baseIntervalMs(ctx({ idle: true }), POLL)).toBe(30_000);
    expect(baseIntervalMs(ctx({ idle: true }), { ...POLL, projectBg: 45_000 })).toBe(30_000);
    expect(baseIntervalMs(ctx({ idle: true, focused: false }), { ...POLL, projectBg: 45_000 })).toBe(45_000);
  });
  it("paused (null) when hidden or offline", () => {
    expect(baseIntervalMs(ctx({ visible: false }), POLL)).toBeNull();
    expect(baseIntervalMs(ctx({ online: false }), POLL)).toBeNull();
    expect(nextTickMs(ctx({ visible: false }), POLL, mid)).toBeNull();
  });
  it("the next tick is jittered by ±20%", () => {
    expect(nextTickMs(ctx(), POLL, mid)).toBe(10_000);
    expect(nextTickMs(ctx(), POLL, lo)).toBe(8_000);
    expect(nextTickMs(ctx(), POLL, hi)).toBeGreaterThan(11_990);
    expect(nextTickMs(ctx(), POLL, hi)).toBeLessThanOrEqual(12_000);
  });
  it("wake-ups: ≥3 s gap, post-write ≤ once per 2 s, online after 2–3 s", () => {
    expect(shouldSyncOnWake(null, 1000)).toBe(true);
    expect(shouldSyncOnWake(1000, 3999)).toBe(false);
    expect(shouldSyncOnWake(1000, 4000)).toBe(true);
    expect(postWriteSyncAllowed(1000, 2999)).toBe(false);
    expect(postWriteSyncAllowed(1000, 3000)).toBe(true);
    expect(onlineWakeDelayMs(lo)).toBe(2000);
    expect(onlineWakeDelayMs(hi)).toBeLessThanOrEqual(3000);
  });
  it("hasMore chains 3 follow-ups, then reloads the thread", () => {
    expect([0, 1, 2, 3].map(planHasMore)).toEqual(["follow_up", "follow_up", "follow_up", "reload_thread"]);
  });
});

describe("sync-state: back-off and 429", () => {
  it("10, 20, 40 then capped at 60 s", () => {
    expect([1, 2, 3, 4, 5, 9].map((f) => backoffMs(f, mid))).toEqual([10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
  });
  it("±30% jitter on the back-off", () => {
    expect(backoffMs(1, lo)).toBe(7_000);
    expect(backoffMs(4, hi)).toBeLessThanOrEqual(78_000);
    expect(backoffMs(4, hi)).toBeGreaterThan(77_900);
  });
  it("429 pauses for retryAfterSec ±20% (30 s when absent)", () => {
    expect(rateLimitPauseMs(8, mid)).toBe(8_000);
    expect(rateLimitPauseMs(8, lo)).toBe(6_400);
    expect(rateLimitPauseMs(8, hi)).toBeLessThanOrEqual(9_600);
    expect(rateLimitPauseMs(undefined, mid)).toBe(30_000);
    const d = planAfterAttempt(initialSchedulerState, { kind: "rate_limited", retryAfterSec: 12 }, 1000, mid);
    expect(d.delayMs).toBe(12_000);
    expect(d.state.rateLimitedSince).toBe(1000);
  });
  it("a rate-limit streak shows the pill only after 2 minutes; reconnecting after 2 failures", () => {
    let s = planAfterAttempt(initialSchedulerState, { kind: "rate_limited" }, 0, mid).state;
    expect(connectionIndicator(s, 119_999)).toBe("live");
    expect(connectionIndicator(s, 120_000)).toBe("rate_limited");
    s = planAfterAttempt(initialSchedulerState, { kind: "transient" }, 0, mid).state;
    expect(connectionIndicator(s, 0)).toBe("live");
    s = planAfterAttempt(s, { kind: "transient" }, 0, mid).state;
    expect(connectionIndicator(s, 0)).toBe("reconnecting");
    s = planAfterAttempt(s, { kind: "ok" }, 5, mid).state;
    expect(s.failures).toBe(0);
    expect(connectionIndicator(s, 5)).toBe("live");
  });
});

describe("sync-state: response classification", () => {
  it("403 PIPELINE_DISABLED is NOT terminal — it re-checks bootstrap in ~3 min", () => {
    const o = classifySyncResult({ status: 403, code: "PIPELINE_DISABLED" });
    expect(o).toEqual({ kind: "disabled" });
    const d = planAfterAttempt(initialSchedulerState, o, 0, mid);
    expect(d.action).toBe("recheckBootstrap");
    expect(d.delayMs).toBe(180_000);
    expect(d.state.mode).toBe("disabled");
    // …and it resumes automatically on the next 200.
    expect(planAfterAttempt(d.state, { kind: "ok" }, 1, mid).state.mode).toBe("running");
  });
  it("403 NOT_IN_PILOT, ACCOUNT_INACTIVE and FORBIDDEN are terminal", () => {
    for (const code of ["PIPELINE_NOT_IN_PILOT", "ACCOUNT_INACTIVE", "FORBIDDEN"]) {
      const o = classifySyncResult({ status: 403, code });
      expect(o).toEqual({ kind: "terminal", code });
      const d = planAfterAttempt(initialSchedulerState, o, 0, mid);
      expect(d.action).toBe("stop");
      expect(d.delayMs).toBeNull();
      expect(connectionIndicator(d.state, 0)).toBe("unavailable");
    }
    expect(classifySyncResult({ status: 403 })).toEqual({ kind: "terminal", code: "FORBIDDEN" });
  });
  it("5xx, network (0) and a transient 401 back off; 429 pauses; other 4xx are unexpected", () => {
    for (const status of [0, 401, 500, 502, 503]) expect(classifySyncResult({ status }).kind).toBe("transient");
    expect(classifySyncResult({ status: 429, retryAfterSec: 5 })).toEqual({ kind: "rate_limited", retryAfterSec: 5 });
    for (const status of [400, 404, 409, 413]) expect(classifySyncResult({ status }).kind).toBe("unexpected");
    expect(classifySyncResult({ status: 200 }).kind).toBe("ok");
  });
  it("an unexpected 4xx backs off 60 s and reloads at most once per 10 minutes", () => {
    const a = planAfterAttempt(initialSchedulerState, { kind: "unexpected" }, 1_000, mid);
    expect(a.delayMs).toBe(60_000);
    expect(a.action).toBe("reload");
    const b = planAfterAttempt(a.state, { kind: "unexpected" }, 61_000, mid);
    expect(b.action).toBe("none");
    const c = planAfterAttempt(b.state, { kind: "unexpected" }, 601_000, mid);
    expect(c.action).toBe("reload");
  });
  it("reload:true on a 200 reloads once per 10 minutes", () => {
    const a = planAfterAttempt(initialSchedulerState, { kind: "ok" }, 0, mid, { reloadRequested: true });
    expect(a.action).toBe("reload");
    expect(planAfterAttempt(a.state, { kind: "ok" }, 5_000, mid, { reloadRequested: true }).action).toBe("none");
  });
});

// ── store fixtures ──────────────────────────────────────────────────────────────────

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const PID = "33333333-3333-4333-8333-333333333333";
const PH1 = "44444444-4444-4444-8444-444444444441";
const PH2 = "44444444-4444-4444-8444-444444444442";

function msg(o: Partial<PipelineMessage> & { id: string; seq: number; rev: number }): PipelineMessage {
  return {
    projectId: PID,
    parentId: null,
    authorId: OTHER,
    authorName: "Other",
    body: "hi",
    mentions: [],
    reactions: {},
    replyCount: 0,
    lastReplyAt: null,
    editedAt: null,
    deletedAt: null,
    createdAt: "2026-09-26T10:00:00.000Z",
    ...o,
  };
}

function header(o: Partial<PipelineHeader> = {}): PipelineHeader {
  return {
    id: PID,
    title: "Diwali campaign",
    description: "",
    phaseId: PH1,
    rank: "a0",
    ownerId: ME,
    createdById: ME,
    startDate: null,
    dueDate: null,
    memberCount: 1,
    headerRev: 1,
    threadRev: 2,
    lastMessageSeq: 2,
    lastMessageAt: null,
    phaseChangedAt: null,
    phaseChangedById: null,
    archivedAt: null,
    archivedById: null,
    archivedByAdmin: false,
    deletedAt: null,
    deletedById: null,
    deletedByAdmin: false,
    createdAt: "2026-09-26T09:00:00.000Z",
    updatedAt: "2026-09-26T09:00:00.000Z",
    ...o,
  };
}

function detail(messages: PipelineMessage[], o: Partial<PipelineProjectDetail> = {}): PipelineProjectDetail {
  return {
    header: header(),
    description: "",
    participants: [],
    me: { role: "MEMBER", notify: true, lastReadSeq: 1 },
    can: { archive: true, delete: true, restore: true, transferOwner: true, removeOthers: true },
    messages,
    threadRev: 2,
    headerRev: 1,
    hasOlder: false,
    hasNewer: false,
    ...o,
  };
}

function card(id: string, phaseId: string, rank: string): PipelineCard {
  return { id, phaseId, title: id, rank, ownerId: ME, startDate: null, dueDate: null, memberCount: 1, preview: [] };
}

function snapshot(v: number, cards: PipelineCard[]): PipelineBoardSnapshot {
  return {
    v,
    phases: [
      { id: PH1, key: "plan", name: "Planning", position: 1, color: "indigo", isTerminal: false },
      { id: PH2, key: "review", name: "Review", position: 2, color: "sage", isTerminal: false },
    ],
    cards,
    perPhase: {},
  };
}

function syncRes(o: Partial<PipelineSyncResponse> = {}): PipelineSyncResponse {
  return { v: 1, board: null, mineH: "h0", mine: null, project: null, pollMs: 10_000, reload: false, ...o };
}

function loaded(): PipelineState {
  let s = initialPipelineState(ME);
  s = pipelineReducer(s, { type: "projectDetail", detail: detail([msg({ id: "m1", seq: 1, rev: 1 }), msg({ id: "m2", seq: 2, rev: 2 })]), now: 0 });
  return s;
}

function delta(messages: PipelineMessage[], rev: number, fromRev = 2, hasMore = false): { req: PipelineSyncRequest; res: PipelineSyncResponse } {
  return {
    req: { clientBuild: 1, project: { id: PID, rev: fromRev, hv: 1 } },
    res: syncRes({
      project: { id: PID, status: "ok", rev, hv: 1, header: null, participants: null, messages, hasMore, lastReadSeq: 1 },
    }),
  };
}

describe("store: merges are idempotent and never destructive", () => {
  it("applying the same sync response twice gives an equal state", () => {
    const { req, res } = delta([msg({ id: "m3", seq: 3, rev: 3 }), msg({ id: "m1", seq: 1, rev: 4, body: "edited" })], 4);
    const once = pipelineReducer(loaded(), { type: "syncOk", req, res, now: 1 });
    const twice = pipelineReducer(once, { type: "syncOk", req, res, now: 1 });
    expect(twice).toEqual(once);
    expect(once.projects[PID].rev).toBe(4);
    expect(once.projects[PID].messages.m1.body).toBe("edited");
    expect(selectTopLevel(once.projects[PID]).map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("a failed poll never clears state (identity), and null / empty fields mean unchanged", () => {
    let s = pipelineReducer(loaded(), { type: "boardSnapshot", snapshot: snapshot(5, [card(PID, PH1, "a0")]), now: 0 });
    s = pipelineReducer(s, {
      type: "syncOk",
      req: { clientBuild: 1, board: { v: -1 } },
      res: syncRes({ v: 5, mine: [{ projectId: PID, role: "MEMBER", notify: true, unread: 2 }], mineH: "h1" }),
      now: 0,
    });
    expect(pipelineReducer(s, { type: "syncFailed" })).toBe(s);
    const { req, res } = delta([], 2);
    const after = pipelineReducer(s, { type: "syncOk", req, res: { ...res, board: null, mine: null, v: 5 }, now: 1 });
    expect(after.board).toBe(s.board);
    expect(after.mine).toEqual(s.mine);
    expect(Object.keys(after.projects[PID].messages)).toEqual(["m1", "m2"]);
    expect(after.projects[PID].header).toEqual(s.projects[PID].header);
  });

  it("a stale delta (the cursor moved underneath) is dropped, not merged", () => {
    const s = pipelineReducer(loaded(), { type: "syncOk", ...delta([msg({ id: "m3", seq: 3, rev: 3 })], 3), now: 1 });
    const stale = delta([msg({ id: "m1", seq: 1, rev: 3, body: "old view" })], 3, 2);
    const s2 = pipelineReducer(s, { type: "syncOk", ...stale, now: 2 });
    expect(s2.projects[PID].messages.m1.body).toBe("hi");
    expect(s2.projects[PID].rev).toBe(3);
  });

  it("an older rev never overwrites a newer row; a write response never moves the cursor", () => {
    let s = pipelineReducer(loaded(), { type: "messageUpsert", message: msg({ id: "m2", seq: 2, rev: 9, body: "mine, newer" }) });
    expect(s.projects[PID].rev).toBe(2); // cursor untouched
    s = pipelineReducer(s, { type: "syncOk", ...delta([msg({ id: "m2", seq: 2, rev: 5, body: "older" })], 5), now: 1 });
    expect(s.projects[PID].messages.m2.body).toBe("mine, newer");
    expect(s.projects[PID].rev).toBe(5);
  });

  it("projectDetail replaces by default; merge keeps earlier rows and the older cursor", () => {
    const base = loaded();
    const page = detail([msg({ id: "m2", seq: 2, rev: 2 }), msg({ id: "m3", seq: 3, rev: 5 })], { threadRev: 6, hasNewer: false });
    const replaced = pipelineReducer(base, { type: "projectDetail", detail: page, now: 1 });
    expect(Object.keys(replaced.projects[PID].messages).sort()).toEqual(["m2", "m3"]);
    expect(replaced.projects[PID].rev).toBe(6);
    const merged = pipelineReducer(base, { type: "projectDetail", detail: page, now: 1, merge: true });
    expect(Object.keys(merged.projects[PID].messages).sort()).toEqual(["m1", "m2", "m3"]);
    expect(merged.projects[PID].rev).toBe(2);
  });

  it("a reply arriving before its root is kept, and both show once the root lands", () => {
    const reply = msg({ id: "r1", seq: 4, rev: 3, parentId: "m9" });
    let s = pipelineReducer(loaded(), { type: "syncOk", ...delta([reply], 3, 2, true), now: 1 });
    expect(s.projects[PID].messages.r1).toBeDefined();
    expect(selectTopLevel(s.projects[PID]).map((m) => m.id)).toEqual(["m1", "m2"]);
    s = pipelineReducer(s, { type: "syncOk", ...delta([msg({ id: "m9", seq: 3, rev: 4, replyCount: 1 })], 4, 3), now: 2 });
    expect(selectTopLevel(s.projects[PID]).map((m) => m.id)).toEqual(["m1", "m2", "m9"]);
    expect(selectReplies(s.projects[PID], "m9").map((m) => m.id)).toEqual(["r1"]);
  });

  it("the header / participants apply only when hv matches the request", () => {
    const req: PipelineSyncRequest = { clientBuild: 1, project: { id: PID, rev: 2, hv: 1 } };
    const res = syncRes({
      project: {
        id: PID, status: "archived", rev: 2, hv: 3, header: header({ title: "Renamed", headerRev: 3, archivedAt: "2026-09-26T11:00:00.000Z" }),
        participants: [{ userId: OTHER, role: "MEMBER", isOwner: false, memberAddedById: ME, createdAt: "2026-09-26T09:00:00.000Z" }],
        me: { role: "MEMBER", notify: false, lastReadSeq: 2 }, messages: [], hasMore: false, lastReadSeq: 2,
      },
    });
    const s = pipelineReducer(loaded(), { type: "syncOk", req, res, now: 1 });
    const p = s.projects[PID];
    expect(p.header?.title).toBe("Renamed");
    expect(p.hv).toBe(3);
    expect(p.status).toBe("archived");
    expect(p.participants).toHaveLength(1);
    expect(p.lastReadSeq).toBe(2);
    expect(p.dividerSeq).toBe(1); // the divider stays where the page opened
    expect(pipelineReducer(s, { type: "syncOk", req, res, now: 1 })).toEqual(s);
  });
});

describe("store: pending sends", () => {
  const send = (o: Partial<PendingSend> = {}): PendingSend => ({
    clientId: "c1", authorId: ME, projectId: PID, parentId: null, body: "hello", createdAt: 10,
    status: "sending", attempts: 1, lastAttemptEndedAt: null, note: null, ...o,
  });

  it("resolves by (authorId = me, clientId) on a sync merge", () => {
    let s = pipelineReducer(loaded(), { type: "sendAdd", send: send() });
    expect(selectPendingSends(s, PID, null)).toHaveLength(1);
    s = pipelineReducer(s, { type: "syncOk", ...delta([msg({ id: "m3", seq: 3, rev: 3, authorId: ME, clientId: "c1" })], 3), now: 1 });
    expect(s.sends.c1).toBeUndefined();
  });

  it("does NOT resolve on the same clientId from another author", () => {
    let s = pipelineReducer(loaded(), { type: "sendAdd", send: send() });
    s = pipelineReducer(s, { type: "syncOk", ...delta([msg({ id: "m3", seq: 3, rev: 3, authorId: OTHER, clientId: "c1" })], 3), now: 1 });
    expect(s.sends.c1).toBeDefined();
  });

  it("refuses a pending send authored by someone else (never post as B)", () => {
    const s = pipelineReducer(loaded(), { type: "sendAdd", send: send({ authorId: OTHER }) });
    expect(s.sends.c1).toBeUndefined();
  });

  it("resolves from the POST response (messageUpsert) too", () => {
    let s = pipelineReducer(loaded(), { type: "sendAdd", send: send() });
    s = pipelineReducer(s, { type: "messageUpsert", message: msg({ id: "m3", seq: 3, rev: 3, authorId: ME, clientId: "c1" }) });
    expect(s.sends.c1).toBeUndefined();
  });

  it("a retrying send becomes 'failed' only after a sync that STARTED after its last attempt", () => {
    let s = pipelineReducer(loaded(), { type: "sendAdd", send: send({ status: "retrying", lastAttemptEndedAt: 100 }) });
    s = pipelineReducer(s, { type: "syncOk", ...delta([], 2), now: 50 });
    expect(s.sends.c1.status).toBe("retrying");
    s = pipelineReducer(s, { type: "syncOk", ...delta([], 2), now: 150 });
    expect(s.sends.c1.status).toBe("failed");
  });
});

describe("store: board, pending moves and reactions", () => {
  it("adopts a snapshot whenever v differs in either direction", () => {
    let s = pipelineReducer(initialPipelineState(ME), { type: "boardSnapshot", snapshot: snapshot(5, [card("a", PH1, "a0")]), now: 0 });
    const same = pipelineReducer(s, { type: "boardSnapshot", snapshot: snapshot(5, []), now: 1 });
    expect(same).toBe(s);
    s = pipelineReducer(s, { type: "boardSnapshot", snapshot: snapshot(3, [card("b", PH1, "a0")]), now: 2 });
    expect(Object.keys(s.board!.cards)).toEqual(["b"]);
  });

  it("orders by compareRank and lays a pending move over the server card", () => {
    const r1 = keyBetween(null, null);
    const r2 = keyBetween(r1, null);
    let s = pipelineReducer(initialPipelineState(ME), {
      type: "boardSnapshot", snapshot: snapshot(1, [card("b", PH1, r2), card("a", PH1, r1), card("c", PH2, r1)]), now: 0,
    });
    expect(selectCardsByPhase(s)[PH1].map((c) => c.id)).toEqual(["a", "b"]);
    s = pipelineReducer(s, { type: "moveAdd", move: { opId: "o1", projectId: "a", toPhaseId: PH2, basePhaseId: PH1, rank: keyBetween(r1, null), status: "inflight", settledAt: null } });
    const by = selectCardsByPhase(s);
    expect(by[PH1].map((c) => c.id)).toEqual(["b"]);
    expect(by[PH2].map((c) => c.id)).toEqual(["c", "a"]);
  });

  it("an unanswered ('checking') move settles on the next snapshot: landed, or failed with a notice", () => {
    const base = pipelineReducer(initialPipelineState(ME), { type: "boardSnapshot", snapshot: snapshot(1, [card("a", PH1, "a0")]), now: 0 });
    const checking = pipelineReducer(base, { type: "moveAdd", move: { opId: "o1", projectId: "a", toPhaseId: PH2, basePhaseId: PH1, rank: null, status: "checking", settledAt: 10 } });
    const landed = pipelineReducer(checking, { type: "boardSnapshot", snapshot: snapshot(2, [card("a", PH2, "a0")]), now: 20 });
    expect(landed.moves.a).toBeUndefined();
    expect(landed.notices).toHaveLength(0);
    const failed = pipelineReducer(checking, { type: "boardSnapshot", snapshot: snapshot(2, [card("a", PH1, "a0")]), now: 20 });
    expect(failed.moves.a).toBeUndefined();
    expect(failed.notices).toEqual([{ id: 1, kind: "move_failed", projectId: "a", phaseId: PH1 }]);
    // An in-flight move waits for its own response.
    const inflight = pipelineReducer(base, { type: "moveAdd", move: { opId: "o1", projectId: "a", toPhaseId: PH2, basePhaseId: PH1, rank: null, status: "inflight", settledAt: null } });
    expect(pipelineReducer(inflight, { type: "boardSnapshot", snapshot: snapshot(2, [card("a", PH1, "a0")]), now: 20 }).moves.a).toBeDefined();
  });

  it("an optimistic reaction overlays the server's and reconciles with the result", () => {
    let s = loaded();
    s = pipelineReducer(s, { type: "reactionPending", messageId: "m1", emoji: "heart", on: true });
    expect(selectReactions(s, s.projects[PID].messages.m1)).toEqual({ heart: [ME] });
    s = pipelineReducer(s, { type: "reactionResult", projectId: PID, messageId: "m1", reactions: { heart: [OTHER, ME] }, rev: 7 });
    s = pipelineReducer(s, { type: "reactionPending", messageId: "m1", emoji: "heart", on: null });
    expect(selectReactions(s, s.projects[PID].messages.m1)).toEqual({ heart: [OTHER, ME] });
    expect(s.projects[PID].rev).toBe(2);
  });

  it("buildSyncRequest: board v -1 until loaded, project only once its header is loaded", () => {
    const empty = initialPipelineState(ME);
    expect(buildSyncRequest(empty, { clientBuild: 1, board: true, projectId: PID })).toEqual({ clientBuild: 1, board: { v: -1 } });
    const s = loaded();
    expect(buildSyncRequest(s, { clientBuild: 1, board: false, projectId: PID, ack: { seq: 2 } })).toEqual({
      clientBuild: 1, project: { id: PID, rev: 2, hv: 1, ack: { seq: 2 } },
    });
  });

  it("makeClientId returns distinct v4 uuids", () => {
    const a = makeClientId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(makeClientId()).not.toBe(a);
  });
});
