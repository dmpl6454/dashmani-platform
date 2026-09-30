import type { GapDay, GapDayStatus, GapEmployeeRow, GapPairRow } from "../types/submission-gaps";

/**
 * Submission gaps — pure logic shared by the API and the internal portal's panel.
 *
 * WHY IT IS SHARED: the panel filters its rows client-side (person, channel, search,
 * minimum missed days), and the all-rows day-by-day CSV is built on the server. Both
 * call the SAME selection functions below, so the file can never list a row the screen
 * does not (or miss one it does). The in-view CSV (built in the browser) and the all-rows
 * CSV (built on the server) share the SAME day series and row format for the same reason.
 *
 * Every day key is an IST calendar day "YYYY-MM-DD". The arithmetic here works on those
 * strings through UTC midnights, so no device or server timezone can shift a day.
 */

// ─── Constants ───────────────────────────────────────────────────────────────────

/** Before this IST day only the report's first-submit time is known (approximate). */
export const GAP_EXACT_TIME_SINCE = "2026-06-03";
/** The API analyses at most this many days at once (inclusive span). */
export const GAP_MAX_RANGE_DAYS = 366;
/** The panel's earliest pickable day — there is no report data before 2025. */
export const GAP_EARLIEST_DAY = "2025-01-01";
/** Longest search text either side uses (longer input is cut, identically on both). */
export const GAP_SEARCH_MAX_LENGTH = 100;
/** Largest "at least N missed days" threshold; any higher value matches nothing anyway. */
export const GAP_MIN_MISSED_MAX = 9999;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ─── Calendar helpers ──────────────────────────────────────────────────────────────

/** A real calendar day in YYYY-MM-DD form (rejects "2026-02-30", "", partial input). */
export function isGapDayKey(value: unknown): value is string {
  if (typeof value !== "string" || !DAY_RE.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

/** The day key `delta` calendar days after `day`. */
export function gapShiftDay(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** Days in [start, end], inclusive (0 or less when end is before start). */
export function gapSpanDays(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
}

/** "YYYY-MM" of a day key. */
export function gapMonthOf(day: string): string {
  return day.slice(0, 7);
}

/** Shift a "YYYY-MM" month by `delta` months, across year boundaries. */
export function gapShiftMonth(month: string, delta: number): string {
  if (!MONTH_RE.test(month)) throw new Error(`not a month: ${month}`);
  const [y, m] = month.split("-").map(Number);
  const index = y * 12 + (m - 1) + delta;
  const year = Math.floor(index / 12);
  const mon = index - year * 12 + 1;
  return `${String(year).padStart(4, "0")}-${String(mon).padStart(2, "0")}`;
}

/** First calendar day of a "YYYY-MM" month. */
export function gapMonthStart(month: string): string {
  return `${month}-01`;
}

/** Last calendar day of a "YYYY-MM" month (28–31, leap years included). */
export function gapMonthEnd(month: string): string {
  return gapShiftDay(gapMonthStart(gapShiftMonth(month, 1)), -1);
}

/**
 * The window a calendar month covers, its end CLAMPED TO TODAY (a day view never shows
 * a future day). Null for a month that starts after today.
 */
export function gapMonthWindow(month: string, today: string): { startDate: string; endDate: string } | null {
  const startDate = gapMonthStart(month);
  if (startDate > today) return null;
  const end = gapMonthEnd(month);
  return { startDate, endDate: end < today ? end : today };
}

/**
 * Why a window cannot be shown, or null when it can. Mirrors the API's own validation
 * (real days, start ≤ end, at most GAP_MAX_RANGE_DAYS) plus the panel's rules (no report
 * data before 2025, no future days) — so an impossible window never becomes a request.
 */
export function gapRangeProblem(start: string, end: string, today: string): string | null {
  if (!isGapDayKey(start) || !isGapDayKey(end)) return "Pick a start and an end date.";
  if (start > end) return "The start date must be on or before the end date.";
  if (start < GAP_EARLIEST_DAY) return "Pick a start date in 2025 or later — there is no report data before that.";
  if (end > today) return "The end date can't be after today.";
  const span = gapSpanDays(start, end);
  if (span > GAP_MAX_RANGE_DAYS) {
    return `Pick a window of at most ${GAP_MAX_RANGE_DAYS} days — this one is ${span} days.`;
  }
  return null;
}

/** "Mon", "Tue", … for a day key. */
export function gapWeekday(day: string): string {
  return WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()] ?? "";
}

// ─── Day-by-day navigation window ────────────────────────────────────────────────

/**
 * Which days an expanded day-by-day view shows:
 *   • "report" — the panel's range (the default, and what "Reset" returns to);
 *   • "month"  — one calendar month, reached with the ◀ / ▶ arrows;
 *   • "custom" — a From/To the admin typed.
 */
export type GapDayWindow =
  | { mode: "report" }
  | { mode: "month"; month: string }
  | { mode: "custom"; startDate: string; endDate: string };

export interface GapWindowRange {
  startDate: string;
  endDate: string;
}

/** The concrete days a view shows. A month that is not allowed falls back to the report range. */
export function resolveGapDayWindow(w: GapDayWindow, report: GapWindowRange, today: string): GapWindowRange {
  if (w.mode === "month") return gapMonthWindow(w.month, today) ?? report;
  if (w.mode === "custom") return { startDate: w.startDate, endDate: w.endDate };
  return report;
}

/** A month the arrows may land on: not in the future, not entirely before 2025. */
export function gapMonthAllowed(month: string, today: string): boolean {
  return gapMonthStart(month) <= today && gapMonthEnd(month) >= GAP_EARLIEST_DAY;
}

/**
 * The calendar month before (delta −1) or after (+1) the current view, or null when the
 * arrow is disabled. The arrows step from the anchor month in month mode, else from the
 * month containing the view's END — so ◀ on "Last 30 days" ending 20 Sep opens August,
 * and ▶ stops at the current month (nothing after today exists yet).
 */
export function stepGapDayWindow(
  w: GapDayWindow,
  report: GapWindowRange,
  today: string,
  delta: -1 | 1,
): GapDayWindow | null {
  const base = w.mode === "month" ? w.month : gapMonthOf(resolveGapDayWindow(w, report, today).endDate);
  const target = gapShiftMonth(base, delta);
  return gapMonthAllowed(target, today) ? { mode: "month", month: target } : null;
}

// ─── Day series (what a day-by-day view shows, and what its CSV contains) ─────────

/** A day the server reports, plus the days before the assignment, which it never sends. */
export type GapDayCellStatus = GapDayStatus | "not_assigned";

export interface GapDayCell {
  date: string;
  status: GapDayCellStatus;
  /** null = not counted (before the assignment) — never a fabricated 0. */
  linkCount: number | null;
  /** IST "YYYY-MM-DD HH:MM" — the date part differs from `date` for a late submission. */
  firstPostedIST: string | null;
  lastPostedIST: string | null;
  approximate: boolean;
}

export interface GapPostedDay {
  linkCount: number;
  firstPostedIST: string | null;
  lastPostedIST: string | null;
}

/** Status of a counted day, or of today. The API's /days endpoint uses this too. */
export function gapDayStatus(date: string, linkCount: number, today: string): GapDayStatus {
  if (date === today) return linkCount > 0 ? "today_posted" : "today_pending";
  return linkCount > 0 ? "posted" : "missed";
}

/** A posting time before GAP_EXACT_TIME_SINCE is the report's first-submit time. */
export function gapTimeIsApproximate(date: string, linkCount: number): boolean {
  return linkCount > 0 && date < GAP_EXACT_TIME_SINCE;
}

/** The server's day rows (/days) as a lookup of the days that have links. */
export function gapPostedFromDays(days: readonly GapDay[]): Map<string, GapPostedDay> {
  const m = new Map<string, GapPostedDay>();
  for (const d of days) {
    if (d.linkCount > 0) {
      m.set(d.date, { linkCount: d.linkCount, firstPostedIST: d.firstPostedIST, lastPostedIST: d.lastPostedIST });
    }
  }
  return m;
}

/**
 * Every day of [startDate, min(endDate, today)], NEWEST FIRST:
 *   • before `assignedSince`       → "not_assigned" (never counted, never "missed");
 *   • today                        → "today_posted" / "today_pending" (never "missed");
 *   • any other day                → "posted" / "missed" from `posted`.
 * Future days are never produced. At most GAP_MAX_RANGE_DAYS days are produced (the
 * newest ones) — the callers pass validated windows; the clamp is the hard bound.
 */
export function buildGapDaySeries(input: {
  startDate: string;
  endDate: string;
  today: string;
  assignedSince: string;
  posted: ReadonlyMap<string, GapPostedDay>;
}): GapDayCell[] {
  const { startDate, today, assignedSince, posted } = input;
  const last = input.endDate < today ? input.endDate : today;
  const span = gapSpanDays(startDate, last);
  if (span <= 0) return [];
  const count = Math.min(span, GAP_MAX_RANGE_DAYS);
  const cells: GapDayCell[] = [];
  for (let i = 0; i < count; i++) {
    const date = gapShiftDay(last, -i);
    if (date < assignedSince) {
      cells.push({ date, status: "not_assigned", linkCount: null, firstPostedIST: null, lastPostedIST: null, approximate: false });
      continue;
    }
    const p = posted.get(date);
    const n = p?.linkCount ?? 0;
    cells.push({
      date,
      status: gapDayStatus(date, n, today),
      linkCount: n,
      firstPostedIST: p?.firstPostedIST ?? null,
      lastPostedIST: p?.lastPostedIST ?? null,
      approximate: gapTimeIsApproximate(date, n),
    });
  }
  return cells;
}

// ─── Day-by-day CSV rows (identical in the in-view and the all-rows export) ───────

export const GAP_DAYS_CSV_HEADERS = [
  "Person",
  "Team",
  "Channel",
  "Handle",
  "Platform",
  "Date (IST)",
  "Weekday",
  "Status",
  "Links",
  "First posted (IST)",
  "Last posted (IST)",
  "Time approx? (before 3 Jun 2026)",
] as const;

export interface GapCsvPairInfo {
  personName: string;
  teamName: string | null;
  channelName: string;
  handle: string;
  platformName: string;
}

export function gapDayStatusLabel(status: GapDayCellStatus): string {
  switch (status) {
    case "posted":
      return "Posted";
    case "missed":
      return "Missed";
    case "today_posted":
      return "Today (posted so far)";
    case "today_pending":
      return "Today (not yet)";
    case "not_assigned":
      return "Not assigned yet";
  }
}

/** The CSV identity of a pair row. */
export function gapCsvPairInfo(r: GapPairRow): GapCsvPairInfo {
  return {
    personName: r.employee.name,
    teamName: r.employee.team?.name ?? null,
    channelName: r.account.displayName,
    handle: r.account.handle,
    platformName: r.account.platformName,
  };
}

/**
 * One CSV row, as raw values — each side escapes them with its own csvCell (quoting and
 * the formula-injection guard). The handle loses a leading "@": "@" is a formula trigger,
 * and dropping the sigil removes it instead of leaving a stray apostrophe in every row.
 * Links / times are blank on a not-assigned day: it is not counted, so it has no count.
 */
export function gapDaysCsvRow(pair: GapCsvPairInfo, cell: GapDayCell): (string | number)[] {
  return [
    pair.personName,
    pair.teamName ?? "",
    pair.channelName,
    pair.handle.replace(/^@+/, ""),
    pair.platformName,
    cell.date,
    gapWeekday(cell.date),
    gapDayStatusLabel(cell.status),
    cell.linkCount ?? "",
    cell.firstPostedIST ?? "",
    cell.lastPostedIST ?? "",
    cell.approximate ? "Yes" : "",
  ];
}

/** A filename-safe fragment of a name ("" when nothing survives, e.g. a non-Latin name). */
export function gapFileSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

// ─── Row selection (the panel's client-side filters — and the all-rows CSV's) ─────

export type GapView = "channels" | "people";

export interface GapRowFilters {
  /** Normalised with normalizeGapSearch. */
  q: string;
  /** Normalised with normalizeGapMinMissed. */
  minMissed: number;
  /** Person dropdown. */
  employeeId: string | null;
  /** Channel dropdown. */
  accountId: string | null;
}

/**
 * ⚠️ Must be IDEMPOTENT: the panel filters with the normalised text and sends it, and the
 * server normalises it again. The final trim matters — a cut at GAP_SEARCH_MAX_LENGTH can
 * end on a space, which a second pass would trim, so the file would match rows the
 * screen does not.
 */
export function normalizeGapSearch(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim().toLowerCase().slice(0, GAP_SEARCH_MAX_LENGTH).trim();
}

/** "5" → 5; "", "abc", "-3" → 0; "5.7" → 5; capped at GAP_MIN_MISSED_MAX. */
export function normalizeGapMinMissed(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), GAP_MIN_MISSED_MAX);
}

/** By channel: a search matches the person, the channel name or its handle. */
export function gapPairMatchesSearch(r: GapPairRow, q: string): boolean {
  if (!q) return true;
  return (
    r.employee.name.toLowerCase().includes(q) ||
    r.account.displayName.toLowerCase().includes(q) ||
    r.account.handle.toLowerCase().includes(q)
  );
}

/** By channel: the rows on screen. */
export function filterGapPairs(rows: readonly GapPairRow[], f: GapRowFilters): GapPairRow[] {
  return rows.filter(
    (r) =>
      (!f.employeeId || r.employee.id === f.employeeId) &&
      (!f.accountId || r.account.id === f.accountId) &&
      r.missedDays >= f.minMissed &&
      gapPairMatchesSearch(r, f.q),
  );
}

/**
 * A person's row over ONE channel. Every field is exactly what the server's per-person
 * aggregate is when that channel is the only one in scope: "no link on any channel" over
 * one channel IS that channel's missed days, and a partial day needs two channels.
 */
export function gapPersonRowFromPair(r: GapPairRow): GapEmployeeRow {
  return {
    employee: r.employee,
    accountCount: 1,
    countedFrom: r.countedFrom,
    countedThrough: r.countedThrough,
    countedDays: r.countedDays,
    activeDays: r.activeDays,
    missedDays: r.missedDays,
    partialDays: 0,
    missedChannelDays: r.missedDays,
    activeRate: r.activeRate,
    missedRanges: r.missedRanges,
    missedRangeCount: r.missedRangeCount,
    missedRangesTruncated: r.missedRangesTruncated,
    longestGapDays: r.longestGapDays,
    currentGapDays: r.currentGapDays,
    currentGapOpenEnded: r.currentGapOpenEnded,
    lastPostedDay: r.lastPostedDay,
    lastPostedAt: r.lastPostedAt,
    lastPostedIST: r.lastPostedIST,
    lastPostedApprox: r.lastPostedApprox,
    linkCount: r.linkCount,
    todayStatus: r.todayStatus,
    todayPostedAccounts: r.todayLinks > 0 ? 1 : 0,
    todayLinks: r.todayLinks,
  };
}

/**
 * By person: the rows on screen. With a channel selected, each person's row is computed
 * over THAT channel alone (gapPersonRowFromPair) — their all-channel totals would describe
 * channels the filter hides. The search matches the person's name only.
 */
export function filterGapPeople(
  data: { rows: readonly GapPairRow[]; employees: readonly GapEmployeeRow[] },
  f: GapRowFilters,
): GapEmployeeRow[] {
  const base = f.accountId
    ? data.rows.filter((r) => r.account.id === f.accountId).map(gapPersonRowFromPair)
    : data.employees;
  return base.filter(
    (r) =>
      (!f.employeeId || r.employee.id === f.employeeId) &&
      r.missedDays >= f.minMissed &&
      (!f.q || r.employee.name.toLowerCase().includes(f.q)),
  );
}

/** The channels listed under one person's row (their pairs, narrowed by the channel filter). */
export function gapChannelsOfPerson(
  rows: readonly GapPairRow[],
  employeeId: string,
  accountId: string | null,
): GapPairRow[] {
  return rows.filter((r) => r.employee.id === employeeId && (!accountId || r.account.id === accountId));
}

/**
 * The (person, channel) pairs an all-rows export covers — exactly the rows on screen:
 * By channel, the filtered pairs; By person, every listed channel of every listed person.
 */
export function selectGapExportPairs(
  data: { rows: readonly GapPairRow[]; employees: readonly GapEmployeeRow[] },
  view: GapView,
  f: GapRowFilters,
): GapPairRow[] {
  if (view === "channels") return filterGapPairs(data.rows, f);
  const people = new Set(filterGapPeople(data, f).map((p) => p.employee.id));
  return data.rows.filter((r) => people.has(r.employee.id) && (!f.accountId || r.account.id === f.accountId));
}
