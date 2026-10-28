// Pipeline — the HR portal's project board (hr.digitalsukoon.com/pipeline), for the app.
//
// Wire contract: packages/shared/src/types/pipeline.ts (additive-only; the app keeps the
// subset it reads). Every call uses the HR session — the API's requirePipelineToken accepts
// HR tokens only — so the board also works from the admin portal when the person has signed
// in to the employee portal too.
//
// ⚠️ Rules kept from the web client:
//  • ids are lowercase UUIDs; calendar days (`dueDate`) are IST "YYYY-MM-DD" days, shown as
//    absolute dates ("30 Oct") — a stored "tomorrow" would turn false.
//  • a field the server could not determine is null; never show it as 0 or "".
//  • 429 PIPELINE_RATE_LIMIT / 503 PIPELINE_BUSY: keep the last data and retry after the
//    server's retryAfterSec; 403 PIPELINE_DISABLED: "Pipeline is paused".
//  • ranks order only by plain string comparison (compareRank).
import { ApiError, apiFetchFor, hasSession } from "./api";
import { colors } from "./theme";

/** Bumped only when the app can no longer read the sync payload (server: pipeline.minClientBuild). */
export const PIPELINE_CLIENT_BUILD = 1;

export type ParticipantRole = "MEMBER" | "FOLLOWER";

export interface Phase {
  id: string;
  key: string;
  name: string;
  position: number;
  color: string;
  isTerminal: boolean;
}

export interface Card {
  id: string;
  phaseId: string;
  title: string;
  rank: string;
  ownerId: string;
  startDate: string | null;
  dueDate: string | null;
  memberCount: number;
  preview: string[];
}

export interface BoardSnapshot {
  v: number;
  phases: Phase[];
  cards: Card[];
  perPhase: Record<string, { shown: number; total: number; truncated: boolean }>;
}

export interface MineEntry {
  projectId: string;
  role: ParticipantRole;
  notify: boolean;
  unread: number;
}

export interface PollMs {
  project: number;
  projectBg: number;
  board: number;
  boardBg: number;
  idle: number;
}

export interface ReactionOption {
  key: string;
  emoji: string;
}

export type Bootstrap =
  | { enabled: false; reason: "off" | "paused" | "not_in_pilot" | "inactive" }
  | {
      enabled: true;
      mode: "pilot" | "on";
      navVisible: boolean;
      me: { id: string; name: string; isAdmin: boolean };
      phases: Phase[];
      pollMs: PollMs;
      reactions: ReactionOption[];
      limits: { bodyMax: number; titleMax: number; membersPerRequestMax: number; bodyCounterFrom: number };
      minClientBuild: number;
    };

export interface DirectoryEntry {
  id: string;
  name: string;
  initials: string;
  active: boolean;
  pickable: boolean;
  hint?: string;
}

export interface Header {
  id: string;
  title: string;
  description: string;
  phaseId: string;
  rank: string;
  ownerId: string;
  startDate: string | null;
  dueDate: string | null;
  memberCount: number;
  headerRev: number;
  threadRev: number;
  lastMessageSeq: number;
  archivedAt: string | null;
  deletedAt: string | null;
  phaseChangedAt: string | null;
  phaseChangedById: string | null;
}

export interface Participant {
  userId: string;
  role: ParticipantRole;
  isOwner: boolean;
}

export interface Me {
  role: ParticipantRole | null;
  notify: boolean;
  lastReadSeq: number;
}

export interface Message {
  id: string;
  clientId?: string;
  projectId: string;
  seq: number;
  rev: number;
  parentId: string | null;
  authorId: string;
  authorName: string;
  body: string;
  mentions: Array<{ id: string; name: string }>;
  reactions: Partial<Record<string, string[]>>;
  replyCount: number;
  lastReplyAt: string | null;
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
}

export interface ProjectDetail {
  header: Header;
  description: string;
  participants: Participant[];
  me: Me;
  messages: Message[];
  threadRev: number;
  headerRev: number;
  hasOlder: boolean;
}

export interface SyncProject {
  id: string;
  status: "ok" | "archived" | "deleted";
  rev: number;
  hv: number;
  header: Header | null;
  participants: Participant[] | null;
  me?: Me | null;
  messages: Message[];
  hasMore: boolean;
  lastReadSeq: number;
}

export interface SyncResponse {
  v: number;
  board: BoardSnapshot | null;
  mineH: string;
  mine: MineEntry[] | null;
  project: SyncProject | null;
  pollMs: PollMs;
  mode?: "pilot" | "on";
  reload: boolean;
  boardUnavailable?: true;
}

export const DEFAULT_POLL_MS: PollMs = { project: 10_000, projectBg: 20_000, board: 15_000, boardBg: 30_000, idle: 30_000 };

/** Every Pipeline call — always on the HR session. */
export function pipe<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  return apiFetchFor<T>("hr", `/pipeline${path}`, options);
}

export function compareRank(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** RFC 4122 v4, lowercase — the idempotency key of a create or a send. */
export function newClientId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID().toLowerCase();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ── Errors ───────────────────────────────────────────────────────────────────────────

export type PipelineFailure = "paused" | "busy" | "gone" | "other";

export function classify(e: unknown): { kind: PipelineFailure; retryAfterMs: number; message: string } {
  const err = e as ApiError;
  const code = err?.code ?? "";
  if (code === "PIPELINE_DISABLED" || code === "PIPELINE_NOT_IN_PILOT" || code === "ACCOUNT_INACTIVE") {
    return { kind: "paused", retryAfterMs: 120_000, message: "Pipeline is paused. It will come back on its own." };
  }
  if (code === "PIPELINE_RATE_LIMIT" || code === "PIPELINE_BUSY" || err?.status === 429 || err?.status === 503) {
    const sec = typeof err?.retryAfterSec === "number" ? err.retryAfterSec : 15;
    return { kind: "busy", retryAfterMs: Math.max(5, sec) * 1000, message: "Pipeline is busy — showing the last update, retrying shortly." };
  }
  if (code === "PROJECT_NOT_FOUND" || code === "PROJECT_DELETED" || code === "NOT_FOUND") {
    return { kind: "gone", retryAfterMs: 0, message: "This project was deleted or is no longer available." };
  }
  if (code === "NETWORK_ERROR") return { kind: "busy", retryAfterMs: 20_000, message: "Offline — showing the last update." };
  return { kind: "other", retryAfterMs: 30_000, message: err?.message || "Something went wrong." };
}

// ── Bootstrap + directory (memoised for the app session) ─────────────────────────────

let bootCache: { at: number; value: Bootstrap } | null = null;
const BOOT_TTL_MS = 60_000;

/** Bootstrap for the HR session, or null when there is no HR session at all. */
export async function getBootstrap(force = false): Promise<Bootstrap | null> {
  if (!(await hasSession("hr"))) return null;
  if (!force && bootCache && Date.now() - bootCache.at < BOOT_TTL_MS) return bootCache.value;
  const value = await pipe<Bootstrap>("/bootstrap");
  bootCache = { at: Date.now(), value };
  return value;
}

export interface Directory {
  at: number;
  byId: Map<string, DirectoryEntry>;
  list: DirectoryEntry[];
}

let dirCache: Directory | null = null;
const DIR_TTL_MS = 5 * 60_000;

export async function getDirectory(force = false): Promise<Directory> {
  if (!force && dirCache && Date.now() - dirCache.at < DIR_TTL_MS) return dirCache;
  const list = await pipe<DirectoryEntry[]>("/directory");
  dirCache = { at: Date.now(), list, byId: new Map(list.map((d) => [d.id, d])) };
  return dirCache;
}

// ── Days & due dates (IST calendar days, absolute labels) ────────────────────────────

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "30 Oct", or "30 Oct 2027" when the year differs from today's. */
export function dayLabel(day: string | null, todayKey: string): string {
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return "";
  const [y, m, d] = day.split("-").map(Number);
  return `${d} ${MON[m - 1]}${String(y) !== todayKey.slice(0, 4) ? ` ${y}` : ""}`;
}

export type DueState = "overdue" | "today" | "later" | null;

export function dueState(dueDate: string | null, isTerminal: boolean, todayKey: string): DueState {
  if (!dueDate || isTerminal) return null;
  if (dueDate < todayKey) return "overdue";
  if (dueDate === todayKey) return "today";
  return "later";
}

export function dueColors(state: DueState): { bg: string; fg: string } {
  if (state === "overdue") return { bg: colors.redSoft, fg: colors.red };
  if (state === "today") return { bg: colors.amberSoft, fg: colors.amber };
  return { bg: colors.cardHigh, fg: colors.sub };
}

/** Phase dot colour. The web's token names map onto the app palette; never purple. */
export function phaseColor(token: string): string {
  switch (token) {
    case "green":
    case "teal":
    case "sage":
      return colors.green;
    case "amber":
    case "yellow":
    case "orange":
      return colors.yellow;
    case "red":
    case "terra":
      return colors.red;
    case "blue":
    case "sky":
    case "cyan":
      return colors.blue;
    case "gray":
    case "grey":
    case "slate":
    case "ink":
      return colors.sub;
    default:
      return colors.pink; // indigo / violet / anything unknown → the brand pink, never purple
  }
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

/** "10:05 am" today, "30 Oct, 10:05 am" another day (device local time = IST for our users). */
export function timeLabel(iso: string, todayKey: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const h = d.getHours();
  const clock = `${h % 12 === 0 ? 12 : h % 12}:${String(d.getMinutes()).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return key === todayKey ? clock : `${dayLabel(key, todayKey)}, ${clock}`;
}

// ── Message bodies: `@{uuid}` mention tokens and links ───────────────────────────────

export type Segment = { kind: "text"; text: string } | { kind: "mention"; id: string; name: string } | { kind: "link"; url: string };

const MENTION_RE = /@\{([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}/g;
const URL_RE = /https?:\/\/[^\s<>"]{1,2048}/g;
const TRAILING_PUNCT = /[).,;:!?]+$/;

function linkSegments(t: string, out: Segment[]) {
  if (!t) return;
  let last = 0;
  for (const m of t.matchAll(URL_RE)) {
    const i = m.index ?? 0;
    const url = m[0].replace(TRAILING_PUNCT, "");
    if (i > last) out.push({ kind: "text", text: t.slice(last, i) });
    out.push({ kind: "link", url });
    last = i + url.length;
  }
  if (last < t.length) out.push({ kind: "text", text: t.slice(last) });
}

/** Linear tokenizer (bounded regexes, no lookbehind). Unknown mention ids show as "@someone". */
export function segmentsOf(body: string, nameOf: (id: string) => string | undefined): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of body.matchAll(MENTION_RE)) {
    const i = m.index ?? 0;
    linkSegments(body.slice(last, i), out);
    out.push({ kind: "mention", id: m[1], name: nameOf(m[1]) ?? "someone" });
    last = i + m[0].length;
  }
  linkSegments(body.slice(last), out);
  return out;
}

/**
 * The composer keeps picked mentions as display text ("@Riya Shah"); on send every picked
 * name still present becomes its `@{uuid}` token. A name the user edited stays plain text.
 */
export function serializeMentions(text: string, picked: Array<{ id: string; name: string }>): string {
  let out = text;
  for (const p of picked) {
    const label = `@${p.name}`;
    const at = out.indexOf(label);
    if (at >= 0) out = out.slice(0, at) + `@{${p.id}}` + out.slice(at + label.length);
  }
  return out;
}
