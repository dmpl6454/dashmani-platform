/**
 * Pipeline date and time labels for the HR portal (owner request 2026-10-01: "accurate date
 * depicted e2e"), plus the bootstrap re-check decisions the gate needs at GA.
 *
 * Pure and dependency-free (types only), so the apps/api vitest suite tests every rule here
 * (apps/hr has no test runner — tests/pipeline/time.test.ts).
 *
 * ⚠️ BROWSER-LOCAL DAYS, BY CONVENTION. Day keys come from the browser's local getters
 * (getFullYear / getMonth / getDate): the repo's IST rule is that browser local time IS IST for
 * every user in India. Never `toISOString().slice(0, 10)` for a "today" — that is the UTC day,
 * wrong between 00:00 and 05:30 IST.
 *
 * ⚠️ "TODAY" IS ALWAYS PASSED IN, never read here. The client gets it from useLocalDayKey()
 * (re-armed at local midnight), so a memoised row re-renders exactly when the day changes and
 * never at any other time — and the tests are exact.
 *
 * ⚠️ DETERMINISTIC TEXT. A fixed English weekday/month table and a 12-hour lowercase "am/pm"
 * (the bells' en-IN style) — never toLocale* / Intl: the browser's locale and ICU version change
 * the words ("Sept" in en-IN, Devanagari in hi-IN) and the chips, threads and bells would
 * disagree. Calendar arithmetic on a key is done in UTC on purpose (a key is a calendar day,
 * not an instant).
 *
 * No regex lookbehind anywhere in this file (CI guard: it ships in the HR bundle).
 */
import type { PipelineBootstrap, PipelineDisabledReason } from "../types/pipeline";
import { PIPELINE_LIMITS, type PipelineMode } from "./constants";

/** The modes an enabled bootstrap (and a sync) can report — "off" never gets that far. */
type PipelineBootstrapMode = Exclude<PipelineMode, "off">;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const pad2 = (n: number) => String(n).padStart(2, "0");

interface DayParts {
  y: number;
  m: number;
  d: number;
}

/** `YYYY-MM-DD` → its parts, or null for anything that is not a real calendar day. */
function parseDayKey(key: string): DayParts | null {
  const hit = typeof key === "string" ? DAY_KEY.exec(key) : null;
  if (!hit) return null;
  const y = Number(hit[1]);
  const m = Number(hit[2]);
  const d = Number(hit[3]);
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return { y, m, d };
}

function keyOf(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${pad2(m)}-${pad2(d)}`;
}

/** The day key `n` calendar days after `key` (calendar arithmetic — no timezone), or null. */
function shiftDayKey(key: string, n: number): string | null {
  const p = parseDayKey(key);
  if (!p) return null;
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
  return keyOf(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** " 2027" when `y` is not the year of `todayKey`, else "" (and "" when today is unreadable). */
function yearSuffix(y: number, todayKey: string): string {
  const t = parseDayKey(todayKey);
  return t && t.y !== y ? ` ${y}` : "";
}

/** "Wed, 30 Sep" — or "Wed, 30 Sep 2025" in another year. */
function weekdayDayMonth(p: DayParts, todayKey: string): string {
  const wd = WEEKDAYS[new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()];
  return `${wd}, ${p.d} ${MONTHS[p.m - 1]}${yearSuffix(p.y, todayKey)}`;
}

function toDate(at: string | number | Date): Date {
  return at instanceof Date ? at : new Date(at);
}

// ── Days ─────────────────────────────────────────────────────────────────────────────

/** The browser-local `YYYY-MM-DD` of an instant (the repo's IST rule). */
export function localDayKey(d: Date): string {
  return keyOf(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

/** Milliseconds from `now` to the next LOCAL midnight (DST-safe: a local constructor). */
export function msUntilNextLocalMidnight(now: Date): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return Math.max(0, next.getTime() - now.getTime());
}

/** "30 Sep", or "30 Sep 2027" when the year is not today's. An unreadable key is shown as is. */
export function dayMonthShort(key: string, todayKey: string): string {
  const p = parseDayKey(key);
  return p ? `${p.d} ${MONTHS[p.m - 1]}${yearSuffix(p.y, todayKey)}` : key;
}

/** "Today", "Yesterday", or "Wed, 30 Sep" ("Wed, 30 Sep 2025" in another year). */
export function daySeparatorLabel(key: string, todayKey: string): string {
  if (key === todayKey) return "Today";
  if (key === shiftDayKey(todayKey, -1)) return "Yesterday";
  const p = parseDayKey(key);
  return p ? weekdayDayMonth(p, todayKey) : key;
}

/**
 * The day separator to draw before a row in a thread: its label when the row's local day
 * differs from the previous row's (or there is no previous row), else null. An unreadable
 * instant never draws one.
 */
export function daySeparatorBefore(
  prevAt: string | number | Date | null | undefined,
  at: string | number | Date,
  todayKey: string,
): string | null {
  const d = toDate(at);
  if (Number.isNaN(d.getTime())) return null;
  const key = localDayKey(d);
  if (prevAt !== null && prevAt !== undefined) {
    const p = toDate(prevAt);
    if (!Number.isNaN(p.getTime()) && localDayKey(p) === key) return null;
  }
  return daySeparatorLabel(key, todayKey);
}

// ── The board chip ───────────────────────────────────────────────────────────────────

export type DueState = "overdue" | "today" | "tomorrow" | "later" | null;

/**
 * The due chip for a card, against the browser-local `todayKey`. Terminal (Done) cards and
 * cards without a due date get none. "tomorrow" is the CALENDAR tomorrow (spec §9.5); the
 * bell's working-day wording ("due Monday") differs on purpose.
 */
export function dueState(dueDate: string | null, isTerminal: boolean, todayKey: string): DueState {
  if (!dueDate || isTerminal || !parseDayKey(dueDate)) return null;
  // Keys compare as strings, so an unreadable today ("garbage" > "2026-…") would invent a
  // red Overdue: show the neutral dated chip instead.
  if (!parseDayKey(todayKey)) return "later";
  if (dueDate < todayKey) return "overdue";
  if (dueDate === todayKey) return "today";
  if (dueDate === shiftDayKey(todayKey, 1)) return "tomorrow";
  return "later";
}

// ── Times ────────────────────────────────────────────────────────────────────────────

/** "10:05 am" — 12-hour, lowercase, the hour not padded (the bells' en-IN style). */
function clock12(d: Date): string {
  const h = d.getHours();
  return `${h % 12 === 0 ? 12 : h % 12}:${pad2(d.getMinutes())} ${h < 12 ? "am" : "pm"}`;
}

/**
 * An instant as the thread shows it, in browser-local time:
 *   - today → "10:05 am";
 *   - another day → "Wed, 30 Sep, 10:05 am";
 *   - another year → "Wed, 30 Sep 2025, 10:05 am".
 * "" for an unreadable instant (never a fabricated time).
 */
export function timeLabel(at: string | number | Date, todayKey: string): string {
  const d = toDate(at);
  if (Number.isNaN(d.getTime())) return "";
  const key = localDayKey(d);
  if (key === todayKey) return clock12(d);
  const p = parseDayKey(key);
  return p ? `${weekdayDayMonth(p, todayKey)}, ${clock12(d)}` : clock12(d);
}

/**
 * A short age, FLOORED at every step like both bells (round() overstated: 1 h 30 min read
 * "2h" in the thread and "1h ago" in the bell): "now" under a minute, then "1m"…"59m",
 * "1h"…"23h", "1d"… A negative age (the other clock is ahead) is "now"; an unknown one is "".
 */
export function relativeShort(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  if (ms < MINUTE_MS) return "now";
  if (ms < HOUR_MS) return `${Math.floor(ms / MINUTE_MS)}m`;
  if (ms < DAY_MS) return `${Math.floor(ms / HOUR_MS)}h`;
  return `${Math.floor(ms / DAY_MS)}d`;
}

/** The bells' words for an age: "just now", "5m ago", "2h ago", "3d ago" — "" when unknown. */
export function relativeAgo(ms: number): string {
  const s = relativeShort(ms);
  return s === "" ? "" : s === "now" ? "just now" : `${s} ago`;
}

/** The start of the minute containing `ms` (the shared relative-time clock ticks per minute). */
export function startOfMinute(ms: number): number {
  return ms - (((ms % MINUTE_MS) + MINUTE_MS) % MINUTE_MS);
}

/** Milliseconds until the next minute boundary after `ms` (a full minute on a boundary). */
export function msUntilNextMinute(ms: number): number {
  return startOfMinute(ms) + MINUTE_MS - ms;
}

// ── Threads ──────────────────────────────────────────────────────────────────────────

/** How close two messages by one author must be to share one header (spec §9.6). */
export const PIPELINE_GROUP_MS = 5 * MINUTE_MS;

interface GroupableMessage {
  authorId: string;
  createdAt: string;
  deletedAt?: string | null;
}

/**
 * True when `m` renders WITHOUT its own author and time, under `prev`'s: same author, `prev`
 * not a tombstone (a deleted row shows no author, so a grouped row after it would show none
 * either), 0 ≤ gap < 5 minutes, and the SAME local day — a 23:58 / 00:01 pair keeps both
 * times, so the second never looks like it belongs to the first one's day.
 */
export function groupsWithPrevious(prev: GroupableMessage | undefined | null, m: GroupableMessage): boolean {
  if (!prev || prev.deletedAt || prev.authorId !== m.authorId) return false;
  const a = new Date(prev.createdAt);
  const b = new Date(m.createdAt);
  const gap = b.getTime() - a.getTime();
  if (!Number.isFinite(gap) || gap < 0 || gap >= PIPELINE_GROUP_MS) return false;
  return localDayKey(a) === localDayKey(b);
}

// ── Members: the adder's undo ────────────────────────────────────────────────────────

/** The adder's undo window (spec §4.6), the same constant the server checks. */
export const PIPELINE_UNDO_ADD_MS = PIPELINE_LIMITS.undoAddMinutes * MINUTE_MS;

/** When the undo window opened at `addedAt` closes (epoch ms), or null when unknown. */
export function undoWindowEndsAt(addedAt: string | null | undefined, windowMs: number = PIPELINE_UNDO_ADD_MS): number | null {
  if (!addedAt) return null;
  const t = Date.parse(addedAt);
  return Number.isFinite(t) ? t + windowMs : null;
}

/** True while the window opened at `addedAt` (member_added_at) is still open at `nowMs`. */
export function isWithinUndoWindow(addedAt: string | null | undefined, nowMs: number, windowMs: number = PIPELINE_UNDO_ADD_MS): boolean {
  const end = undoWindowEndsAt(addedAt, windowMs);
  return end !== null && nowMs < end;
}

// ── The bootstrap gate (GA readiness) ────────────────────────────────────────────────

/**
 * G2: a cached "not enabled" bootstrap is re-fetched ONCE when the gate mounts (a forced,
 * non-deduped revalidate). Without it, a tab that cached `not_in_pilot` before the flip to
 * `on` shows "isn't available for your account yet" on an in-app link until "Check again".
 * Nothing cached → false: SWR fetches anyway.
 */
export function shouldRevalidateBootstrapOnMount(boot: PipelineBootstrap | null | undefined): boolean {
  return !!boot && boot.enabled === false;
}

/**
 * G2: the disabled reasons the gate re-checks on a timer (~3 min ± jitter, while visible):
 * paused (`off`, `paused`) resumes by itself, and `not_in_pilot` clears at GA. `inactive`
 * is not polled — only an admin changes it, and the screen offers "Check again".
 */
export function shouldRecheckBootstrapPeriodically(reason: PipelineDisabledReason | null | undefined): boolean {
  return reason === "off" || reason === "paused" || reason === "not_in_pilot";
}

/** How often a sync's mode mismatch may re-check bootstrap. */
export const PIPELINE_MODE_RECHECK_MS = 2 * MINUTE_MS;

/**
 * G3 (GA): every sync carries the server's `pipeline.mode`. When it differs from the mode
 * bootstrap gave this tab, re-check bootstrap — its new mode re-keys the directory, so a pilot
 * user's cached `pickable: false` entries refresh even in a tab that never loses focus (focus
 * is what revalidates bootstrap otherwise). At most once per PIPELINE_MODE_RECHECK_MS since
 * `lastRecheckAtMs`: a re-check that fails or lags must not turn every sync into a bootstrap
 * request. An older server sends no mode → never.
 */
export function shouldRecheckBootstrapForMode(
  bootMode: PipelineBootstrapMode,
  serverMode: PipelineBootstrapMode | null | undefined,
  lastRecheckAtMs: number,
  nowMs: number,
): boolean {
  if (!serverMode || serverMode === bootMode) return false;
  return nowMs - lastRecheckAtMs >= PIPELINE_MODE_RECHECK_MS;
}
