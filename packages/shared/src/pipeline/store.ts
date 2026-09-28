/**
 * Pure pipeline store reducer (spec §5, §9.3, §9.4). The HR provider holds one instance
 * per signed-in user (`<PipelineProvider key={user.id}>`); the SyncEngine and the write
 * paths dispatch into it. Everything here is a pure function of (state, action) so the
 * merge rules are unit-tested (apps/api/tests/pipeline/frontend-pure.test.ts):
 *
 *   - Merges are IDEMPOTENT: applying the same response twice gives an equal state.
 *   - A failed poll never clears anything; a null / empty field in a 200 means "unchanged".
 *   - A pending send resolves by (authorId = me, clientId).
 *   - A reply may arrive before its root (a delta page can split them): both are kept.
 *   - No thread cursor ever advances from a write response (§5.1).
 */
import { compareRank } from "./rank";
import type {
  PipelineBoardSnapshot,
  PipelineCan,
  PipelineCard,
  PipelineHeader,
  PipelineMe,
  PipelineMessage,
  PipelineMessagesPage,
  PipelineMineEntry,
  PipelineParticipant,
  PipelinePhase,
  PipelinePhaseCount,
  PipelineProjectDetail,
  PipelineProjectStatus,
  PipelineReactions,
  PipelineRepliesPage,
  PipelineSyncAck,
  PipelineSyncRequest,
  PipelineSyncResponse,
} from "../types/pipeline";
import type { PipelineReactionKey } from "./constants";

// ── State ───────────────────────────────────────────────────────────────────────────

export interface BoardState {
  v: number;
  phases: PipelinePhase[];
  cards: Record<string, PipelineCard>;
  perPhase: Record<string, PipelinePhaseCount>;
  receivedAt: number;
}

export interface ProjectState {
  id: string;
  status: PipelineProjectStatus;
  header: PipelineHeader | null;
  description: string;
  participants: PipelineParticipant[];
  me: PipelineMe | null;
  can: PipelineCan | null;
  /** Thread delta cursor. */
  rev: number;
  /** Header cursor. */
  hv: number;
  /** Top-level messages AND replies, by id. */
  messages: Record<string, PipelineMessage>;
  hasOlder: boolean;
  hasNewer: boolean;
  lastReadSeq: number;
  /** The "New messages" divider, fixed at the lastReadSeq the page opened with. */
  dividerSeq: number | null;
  /** Per reply thread: whether more replies exist beyond those loaded. */
  replyPages: Record<string, { hasMore: boolean }>;
  /** true when route 6 said the `around` target no longer exists. */
  aroundMissing: boolean;
}

export type PendingSendStatus =
  /** In flight, or about to be. */
  | "sending"
  /** 429: held; replays after retryAfterSec. */
  | "held"
  /** 5xx / network: auto-retrying with the SAME clientId. */
  | "retrying"
  /** A sync completed after the last attempt and still lacks the clientId. */
  | "failed"
  /** 409 PROJECT_ARCHIVED / MESSAGE_DELETED: kept for copying, never resent. */
  | "blocked";

export interface PendingSend {
  clientId: string;
  authorId: string;
  projectId: string;
  parentId: string | null;
  body: string;
  /** ms epoch. */
  createdAt: number;
  status: PendingSendStatus;
  attempts: number;
  /** ms epoch of the last attempt's end (for the "failed" rule). */
  lastAttemptEndedAt: number | null;
  /** Words for the user (never a raw server message). */
  note: string | null;
}

export interface PendingMove {
  opId: string;
  projectId: string;
  toPhaseId: string;
  basePhaseId: string;
  /** The optimistic local rank, or null to show it at the end. */
  rank: string | null;
  status: "inflight" | "checking";
  /** When the last attempt ended without an answer (status "checking"). */
  settledAt: number | null;
}

export interface PipelineNotice {
  id: number;
  kind: "move_failed" | "move_conflict";
  projectId: string;
  phaseId: string | null;
}

export interface PipelineState {
  meId: string;
  board: BoardState | null;
  mine: { h: string; entries: Record<string, PipelineMineEntry> } | null;
  projects: Record<string, ProjectState>;
  sends: Record<string, PendingSend>;
  moves: Record<string, PendingMove>;
  /** Optimistic reaction toggles: `${messageId}:${emoji}` → on. */
  reactions: Record<string, boolean>;
  notices: PipelineNotice[];
  nextNoticeId: number;
}

export function initialPipelineState(meId: string): PipelineState {
  return {
    meId,
    board: null,
    mine: null,
    projects: {},
    sends: {},
    moves: {},
    reactions: {},
    notices: [],
    nextNoticeId: 1,
  };
}

// ── Actions ─────────────────────────────────────────────────────────────────────────

export type PipelineAction =
  /** `now` = when the sync REQUEST was sent, so "a sync after the attempt" is exact. */
  | { type: "syncOk"; req: PipelineSyncRequest; res: PipelineSyncResponse; now: number }
  | { type: "syncFailed" }
  | { type: "boardSnapshot"; snapshot: PipelineBoardSnapshot; now: number }
  /**
   * Route 6. Default: REPLACE the project's rows (a fresh load or a deep-link jump).
   * `merge: true` (load newer, `around` = the last loaded message): merge the page and
   * KEEP the older cursor, so the next delta also refreshes rows loaded earlier.
   */
  | { type: "projectDetail"; detail: PipelineProjectDetail; now: number; merge?: boolean }
  | { type: "olderMessages"; projectId: string; page: PipelineMessagesPage }
  | { type: "repliesPage"; projectId: string; page: PipelineRepliesPage }
  | { type: "messageUpsert"; message: PipelineMessage; root?: PipelineMessage }
  | { type: "reactionResult"; projectId: string; messageId: string; reactions: PipelineReactions; rev: number }
  | { type: "headerUpsert"; header: PipelineHeader }
  | { type: "participantsUpsert"; projectId: string; participants: PipelineParticipant[] }
  | { type: "meUpsert"; projectId: string; me: Partial<PipelineMe> }
  | { type: "cardUpsert"; card: PipelineCard }
  | { type: "cardRemove"; projectId: string }
  | { type: "projectStatus"; projectId: string; status: PipelineProjectStatus }
  | { type: "sendAdd"; send: PendingSend }
  | { type: "sendUpdate"; clientId: string; patch: Partial<Omit<PendingSend, "clientId" | "authorId">> }
  | { type: "sendRemove"; clientId: string }
  | { type: "moveAdd"; move: PendingMove }
  | { type: "moveUpdate"; projectId: string; opId: string; patch: Partial<Omit<PendingMove, "opId" | "projectId">> }
  | { type: "moveRemove"; projectId: string; opId?: string }
  | { type: "reactionPending"; messageId: string; emoji: PipelineReactionKey; on: boolean | null }
  | { type: "noticeAdd"; kind: PipelineNotice["kind"]; projectId: string; phaseId: string | null }
  | { type: "noticeDismiss"; id: number };

// ── Merge helpers ───────────────────────────────────────────────────────────────────

/** Newer-or-equal `rev` wins; the viewer's own `clientId` is never lost. */
export function mergeMessage(existing: PipelineMessage | undefined, incoming: PipelineMessage): PipelineMessage {
  if (!existing) return incoming;
  if (incoming.rev < existing.rev) return existing;
  if (incoming.clientId === undefined && existing.clientId !== undefined) {
    return { ...incoming, clientId: existing.clientId };
  }
  return incoming;
}

function mergeMessages(
  map: Record<string, PipelineMessage>,
  incoming: readonly PipelineMessage[],
): Record<string, PipelineMessage> {
  if (incoming.length === 0) return map;
  let out: Record<string, PipelineMessage> | null = null;
  for (const m of incoming) {
    const cur = (out ?? map)[m.id];
    const next = mergeMessage(cur, m);
    if (next === cur) continue;
    if (!out) out = { ...map };
    out[m.id] = next;
  }
  return out ?? map;
}

/** Drop pending sends the server now holds: (authorId = me, clientId) found among `msgs`. */
function resolveSends(state: PipelineState, msgs: readonly PipelineMessage[]): PipelineState {
  if (msgs.length === 0) return state;
  let sends: Record<string, PendingSend> | null = null;
  for (const m of msgs) {
    if (!m.clientId || m.authorId !== state.meId) continue;
    const p = (sends ?? state.sends)[m.clientId];
    if (!p || p.authorId !== state.meId) continue;
    if (!sends) sends = { ...state.sends };
    delete sends[m.clientId];
  }
  return sends ? { ...state, sends } : state;
}

/**
 * A sync that found a pending send's clientId still missing AFTER that send's last
 * attempt ended marks it "failed" ("Couldn't send — Tap to retry, it won't post twice").
 */
function failUnresolvedSends(state: PipelineState, projectId: string, syncStartedAt: number): PipelineState {
  let sends: Record<string, PendingSend> | null = null;
  for (const p of Object.values(state.sends)) {
    if (p.projectId !== projectId || p.status !== "retrying") continue;
    if (p.lastAttemptEndedAt === null || p.lastAttemptEndedAt > syncStartedAt) continue;
    if (!sends) sends = { ...state.sends };
    sends[p.clientId] = { ...p, status: "failed" };
  }
  return sends ? { ...state, sends } : state;
}

function emptyProject(id: string): ProjectState {
  return {
    id,
    status: "ok",
    header: null,
    description: "",
    participants: [],
    me: null,
    can: null,
    rev: 0,
    hv: 0,
    messages: {},
    hasOlder: false,
    hasNewer: false,
    lastReadSeq: 0,
    dividerSeq: null,
    replyPages: {},
    aroundMissing: false,
  };
}

function setProject(state: PipelineState, p: ProjectState): PipelineState {
  return { ...state, projects: { ...state.projects, [p.id]: p } };
}

function toBoard(snapshot: PipelineBoardSnapshot, now: number): BoardState {
  const cards: Record<string, PipelineCard> = {};
  for (const c of snapshot.cards) cards[c.id] = c;
  return { v: snapshot.v, phases: snapshot.phases, cards, perPhase: snapshot.perPhase, receivedAt: now };
}

/**
 * Adopt a snapshot whenever its `v` differs in EITHER direction (a DB restore can move it
 * back), then settle pending moves against it.
 */
function adoptSnapshot(state: PipelineState, snapshot: PipelineBoardSnapshot, now: number): PipelineState {
  if (state.board && state.board.v === snapshot.v) return state;
  let next: PipelineState = { ...state, board: toBoard(snapshot, now) };
  const moveIds = Object.keys(next.moves);
  if (moveIds.length === 0) return next;
  const moves = { ...next.moves };
  const notices = [...next.notices];
  let nextNoticeId = next.nextNoticeId;
  for (const pid of moveIds) {
    const mv = moves[pid];
    const card = next.board!.cards[pid];
    if (!card) {
      delete moves[pid]; // archived or deleted meanwhile
      continue;
    }
    if (mv.status !== "checking") continue;
    if (card.phaseId === mv.toPhaseId) {
      delete moves[pid]; // the unanswered move did land
    } else if (mv.settledAt !== null && mv.settledAt <= now) {
      delete moves[pid]; // a sync after the attempt shows the old phase: it failed
      notices.push({ id: nextNoticeId++, kind: "move_failed", projectId: pid, phaseId: card.phaseId });
    }
  }
  next = { ...next, moves, notices, nextNoticeId };
  return next;
}

// ── Reducer ─────────────────────────────────────────────────────────────────────────

export function pipelineReducer(state: PipelineState, action: PipelineAction): PipelineState {
  switch (action.type) {
    case "syncFailed":
      // A failed poll never clears or changes anything.
      return state;

    case "syncOk": {
      const { req, res, now } = action;
      let next = state;
      if (res.board) next = adoptSnapshot(next, res.board, now);
      if (res.mine) {
        const entries: Record<string, PipelineMineEntry> = {};
        for (const e of res.mine) entries[e.projectId] = e;
        next = { ...next, mine: { h: res.mineH, entries } };
      }
      const rp = res.project;
      const qp = req.project;
      if (rp && qp && rp.id === qp.id && next.projects[rp.id]) {
        let p = next.projects[rp.id];
        const cursorMatches = p.rev === qp.rev;
        let merged: PipelineMessage[] = [];
        if (rp.status !== p.status) p = { ...p, status: rp.status };
        if (cursorMatches) {
          // Only a delta computed from OUR cursor may move it; a stale response (the
          // cursor moved underneath: a reload or an earlier merge) is dropped whole.
          const messages = mergeMessages(p.messages, rp.messages);
          if (messages !== p.messages || rp.rev !== p.rev) p = { ...p, messages, rev: Math.max(p.rev, rp.rev) };
          merged = rp.messages;
        }
        if (rp.header && p.hv === qp.hv) {
          p = {
            ...p,
            header: rp.header,
            description: rp.header.description,
            hv: rp.hv,
            participants: rp.participants ?? p.participants,
            me: rp.me ? rp.me : p.me,
          };
        }
        if (rp.lastReadSeq > p.lastReadSeq) {
          p = { ...p, lastReadSeq: rp.lastReadSeq, me: p.me ? { ...p.me, lastReadSeq: rp.lastReadSeq } : p.me };
        }
        if (p !== next.projects[rp.id]) next = setProject(next, p);
        next = resolveSends(next, merged);
        next = failUnresolvedSends(next, rp.id, now);
      }
      return next;
    }

    case "boardSnapshot":
      return adoptSnapshot(state, action.snapshot, action.now);

    case "projectDetail": {
      const d = action.detail;
      const id = d.header.id;
      const prev = state.projects[id];
      const merging = action.merge === true && !!prev?.header;
      let messages: Record<string, PipelineMessage> = {};
      if (merging) messages = mergeMessages(prev!.messages, d.messages);
      else for (const m of d.messages) messages[m.id] = mergeMessage(prev?.messages[m.id], m);
      const status: PipelineProjectStatus = d.header.deletedAt ? "deleted" : d.header.archivedAt ? "archived" : "ok";
      const p: ProjectState = {
        ...(prev ?? emptyProject(id)),
        status,
        header: d.header,
        description: d.description,
        participants: d.participants,
        me: d.me,
        can: d.can,
        rev: merging ? Math.min(prev!.rev, d.threadRev) : d.threadRev,
        hv: d.headerRev,
        messages,
        hasOlder: merging ? prev!.hasOlder : d.hasOlder,
        hasNewer: d.hasNewer,
        lastReadSeq: Math.max(prev?.lastReadSeq ?? 0, d.me.lastReadSeq),
        dividerSeq: prev?.dividerSeq ?? d.me.lastReadSeq,
        aroundMissing: d.aroundMissing === true,
      };
      return resolveSends(setProject(state, p), d.messages);
    }

    case "olderMessages": {
      const p = state.projects[action.projectId];
      if (!p) return state;
      const messages = mergeMessages(p.messages, action.page.messages);
      return resolveSends(setProject(state, { ...p, messages, hasOlder: action.page.hasOlder }), action.page.messages);
    }

    case "repliesPage": {
      const p = state.projects[action.projectId];
      if (!p) return state;
      const all = [action.page.root, ...action.page.replies];
      const messages = mergeMessages(p.messages, all);
      const replyPages = { ...p.replyPages, [action.page.root.id]: { hasMore: action.page.hasMore } };
      return resolveSends(setProject(state, { ...p, messages, replyPages }), all);
    }

    case "messageUpsert": {
      // A WRITE response: merge the rows, never touch the cursor.
      const p = state.projects[action.message.projectId];
      if (!p) return resolveSends(state, [action.message]);
      const all = action.root ? [action.message, action.root] : [action.message];
      const messages = mergeMessages(p.messages, all);
      const next = messages === p.messages ? state : setProject(state, { ...p, messages });
      return resolveSends(next, all);
    }

    case "reactionResult": {
      const p = state.projects[action.projectId];
      const m = p?.messages[action.messageId];
      if (!p || !m || action.rev < m.rev) return state;
      return setProject(state, {
        ...p,
        messages: { ...p.messages, [m.id]: { ...m, reactions: action.reactions, rev: action.rev } },
      });
    }

    case "headerUpsert": {
      const h = action.header;
      const prev = state.projects[h.id];
      if (!prev) return state;
      if (prev.header && h.headerRev < prev.header.headerRev) return state;
      // hv is NOT advanced (a write response): the next sync still fetches participants.
      const status: PipelineProjectStatus = h.deletedAt ? "deleted" : h.archivedAt ? "archived" : "ok";
      return setProject(state, { ...prev, header: h, description: h.description, status });
    }

    case "participantsUpsert": {
      const prev = state.projects[action.projectId];
      if (!prev) return state;
      return setProject(state, { ...prev, participants: action.participants });
    }

    case "meUpsert": {
      const prev = state.projects[action.projectId];
      if (!prev || !prev.me) return state;
      return setProject(state, { ...prev, me: { ...prev.me, ...action.me } });
    }

    case "cardUpsert": {
      if (!state.board) return state;
      const c = action.card;
      const live = !c.archivedAt && !c.deletedAt;
      const cards = { ...state.board.cards };
      if (live) cards[c.id] = c;
      else delete cards[c.id];
      return { ...state, board: { ...state.board, cards } };
    }

    case "cardRemove": {
      if (!state.board || !state.board.cards[action.projectId]) return state;
      const cards = { ...state.board.cards };
      delete cards[action.projectId];
      return { ...state, board: { ...state.board, cards } };
    }

    case "projectStatus": {
      const prev = state.projects[action.projectId];
      if (!prev || prev.status === action.status) return state;
      return setProject(state, { ...prev, status: action.status });
    }

    case "sendAdd":
      if (action.send.authorId !== state.meId) return state; // never post as someone else
      return { ...state, sends: { ...state.sends, [action.send.clientId]: action.send } };

    case "sendUpdate": {
      const cur = state.sends[action.clientId];
      if (!cur) return state;
      return { ...state, sends: { ...state.sends, [action.clientId]: { ...cur, ...action.patch } } };
    }

    case "sendRemove": {
      if (!state.sends[action.clientId]) return state;
      const sends = { ...state.sends };
      delete sends[action.clientId];
      return { ...state, sends };
    }

    case "moveAdd":
      return { ...state, moves: { ...state.moves, [action.move.projectId]: action.move } };

    case "moveUpdate": {
      const cur = state.moves[action.projectId];
      if (!cur || cur.opId !== action.opId) return state;
      return { ...state, moves: { ...state.moves, [action.projectId]: { ...cur, ...action.patch } } };
    }

    case "moveRemove": {
      const cur = state.moves[action.projectId];
      if (!cur || (action.opId && cur.opId !== action.opId)) return state;
      const moves = { ...state.moves };
      delete moves[action.projectId];
      return { ...state, moves };
    }

    case "reactionPending": {
      const key = `${action.messageId}:${action.emoji}`;
      const reactions = { ...state.reactions };
      if (action.on === null) delete reactions[key];
      else reactions[key] = action.on;
      return { ...state, reactions };
    }

    case "noticeAdd":
      return {
        ...state,
        notices: [...state.notices, { id: state.nextNoticeId, kind: action.kind, projectId: action.projectId, phaseId: action.phaseId }],
        nextNoticeId: state.nextNoticeId + 1,
      };

    case "noticeDismiss":
      return { ...state, notices: state.notices.filter((n) => n.id !== action.id) };
  }
}

// ── Selectors ───────────────────────────────────────────────────────────────────────

function byRank(a: PipelineCard, b: PipelineCard): number {
  return compareRank(a.rank, b.rank) || compareRank(a.id, b.id);
}

/**
 * Cards per phase with pending moves laid over them, each list sorted by rank. A card
 * with a pending move and no optimistic rank sorts last in its target phase.
 */
export function selectCardsByPhase(state: PipelineState): Record<string, PipelineCard[]> {
  const out: Record<string, PipelineCard[]> = {};
  if (!state.board) return out;
  for (const ph of state.board.phases) out[ph.id] = [];
  const tail: Record<string, PipelineCard[]> = {};
  for (const card of Object.values(state.board.cards)) {
    const mv = state.moves[card.id];
    const c = mv ? { ...card, phaseId: mv.toPhaseId, rank: mv.rank ?? card.rank } : card;
    const bucket = mv && mv.rank === null ? (tail[c.phaseId] ??= []) : (out[c.phaseId] ??= []);
    bucket.push(c);
  }
  for (const id of Object.keys(out)) {
    out[id].sort(byRank);
    if (tail[id]) out[id].push(...tail[id]);
  }
  for (const id of Object.keys(tail)) if (!out[id]) out[id] = tail[id];
  return out;
}

/** Top-level messages in seq order. */
export function selectTopLevel(p: ProjectState): PipelineMessage[] {
  return Object.values(p.messages)
    .filter((m) => m.parentId === null)
    .sort((a, b) => a.seq - b.seq);
}

/** A root's loaded replies in seq order. */
export function selectReplies(p: ProjectState, rootId: string): PipelineMessage[] {
  return Object.values(p.messages)
    .filter((m) => m.parentId === rootId)
    .sort((a, b) => a.seq - b.seq);
}

/** Pending sends for one conversation (main thread when parentId is null), oldest first. */
export function selectPendingSends(state: PipelineState, projectId: string, parentId: string | null): PendingSend[] {
  return Object.values(state.sends)
    .filter((s) => s.projectId === projectId && s.parentId === parentId && s.authorId === state.meId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Reactions with any optimistic toggle of mine laid over the server's. */
export function selectReactions(state: PipelineState, m: PipelineMessage): PipelineReactions {
  const out: PipelineReactions = {};
  for (const [k, ids] of Object.entries(m.reactions)) if (ids) out[k as PipelineReactionKey] = ids;
  const prefix = `${m.id}:`;
  for (const [key, on] of Object.entries(state.reactions)) {
    if (!key.startsWith(prefix)) continue;
    const emoji = key.slice(prefix.length) as PipelineReactionKey;
    const cur = out[emoji] ?? [];
    const has = cur.includes(state.meId);
    if (on && !has) out[emoji] = [...cur, state.meId];
    if (!on && has) {
      const rest = cur.filter((id) => id !== state.meId);
      if (rest.length) out[emoji] = rest;
      else delete out[emoji];
    }
  }
  return out;
}

export interface BuildSyncOptions {
  clientBuild: number;
  /** The board is mounted. */
  board: boolean;
  /** A project view is mounted (and its detail loaded). */
  projectId?: string | null;
  /** Sent only while the project view is visible. */
  ack?: PipelineSyncAck | null;
}

export function buildSyncRequest(state: PipelineState, o: BuildSyncOptions): PipelineSyncRequest {
  const req: PipelineSyncRequest = { clientBuild: o.clientBuild };
  if (o.board) req.board = { v: state.board ? state.board.v : -1 };
  if (state.mine) req.mineH = state.mine.h;
  const p = o.projectId ? state.projects[o.projectId] : undefined;
  if (p && p.header) {
    req.project = { id: p.id, rev: p.rev, hv: p.hv };
    if (o.ack) req.project.ack = o.ack;
  }
  return req;
}

/** A v4 UUID for idempotency keys: crypto.randomUUID, else getRandomValues. */
export function makeClientId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
