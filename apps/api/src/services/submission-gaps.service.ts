import { createHash } from "crypto";
import { prisma, Prisma } from "@dashmani/db";
import {
  todayIST,
  dateToIST,
  GAP_EXACT_TIME_SINCE,
  GAP_MAX_RANGE_DAYS,
  GAP_DAYS_CSV_HEADERS,
  GAP_SEARCH_MAX_LENGTH,
  buildGapDaySeries,
  gapCsvPairInfo,
  gapDayStatus,
  gapDaysCsvRow,
  gapFileSlug,
  gapSpanDays,
  gapTimeIsApproximate,
  normalizeGapMinMissed,
  normalizeGapSearch,
  selectGapExportPairs,
  type GapDay,
  type GapEmployeeRow,
  type GapPairRow,
  type GapPostedDay,
  type GapTeam,
  type GapView,
  type SubmissionGapDaysResult,
  type SubmissionGapsResult,
} from "@dashmani/shared";
import { AppError } from "../middleware/error-handler";
import { withHeavyQuerySlot } from "../utils/heavy-query";
import { createSingleFlightMemo } from "../utils/single-flight-memo";
import { csvCell } from "./report-links-csv.service";

// The response shapes live in @dashmani/shared (one definition for the API, the panel and
// the shared filters); re-exported so existing importers of this module keep working.
export type { GapDay, GapEmployeeRow, GapPairRow, GapTeam, SubmissionGapDaysResult, SubmissionGapsResult };

/**
 * Submission gaps — who did NOT submit links for the channels assigned to them, on
 * which days, and when they did submit.
 *
 * THE COUNTING RULES (the UI discloses every one of them):
 *   • EVERY calendar day counts — 7 days a week. No weekends, holidays or leave are
 *     excluded; the owner asked for exactly this ("catch people who don't submit
 *     daily").
 *   • Days BEFORE the current assignment began are not counted (the assignment's
 *     assigned_at, converted to its IST calendar day).
 *   • TODAY (IST) is in progress: it is never counted as missed. It is reported
 *     separately as todayStatus "posted" / "not_yet".
 *   • Future days are never counted.
 *   • A submission is a report_links row with a non-blank url and is_scheduled=false,
 *     on a daily_reports row whose (IST) date falls in the window, for an
 *     (employee, account) pair that is a CURRENT assignment (unassigned_at IS NULL) of
 *     an ACTIVE channel held by an employee who passes the employeeWhere convention
 *     (ACTIVE, not deleted, at least one role other than Super Admin / Admin).
 *   • Posting time = report_links.first_seen_at. Before 2026-06-03 there was no exact
 *     per-link timestamp (those rows were backfilled to the link's last-edit time), so
 *     for report days before EXACT_TIME_SINCE the report's created_at — its first
 *     submission that day — is used instead and the value is flagged approximate. Same
 *     cut-over as the reports exports' "Time Approx (pre-3 Jun)" column.
 *
 * PERFORMANCE (the non-negotiables from the 2026-07 / 2026-09 incidents):
 *   • ONE SQL statement does all of the work — the day series, the gaps-and-islands
 *     for missed ranges and every GROUP BY — and returns one row of JSON: one entry
 *     per (employee, account) pair plus one per employee. report_links rows are never
 *     hydrated into Node; the only per-link work is the in-database GROUP BY.
 *   • The day series is bounded by MAX_RANGE_DAYS × current assignments, the output by
 *     MAX_ROWS, and each row's missed-range list by MAX_RANGES_PER_ROW.
 *   • It runs inside the heavy-query bulkhead (it is analytics — it must never be able
 *     to take the pool away from login/HR submit) behind a 60 s single-flight memo, so
 *     N concurrent cold loads share one compute and one connection.
 *   • The statement is a fully static tagged template (the repo's proven pattern):
 *     absent filters bind NULL and are tested with `IS NULL OR`, no conditional SQL.
 */

export const EXACT_TIME_SINCE = GAP_EXACT_TIME_SINCE;
export const MAX_RANGE_DAYS = GAP_MAX_RANGE_DAYS;
/**
 * Most recent missed ranges kept per row; the day-by-day endpoint has the rest. A
 * sporadic submitter produces one range per missed day, so this is what bounds the
 * payload (≈27 bytes a range) — 20 is more than the UI shows before "+N more".
 */
export const MAX_RANGES_PER_ROW = 20;
/** Output bound. One row per current assignment — hundreds on prod. */
export const MAX_ROWS = 5000;
const DEFAULT_RANGE_DAYS = 30;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_MAX = 64;
/**
 * The accepted calendar. A sanity bound, not a data bound (report data starts in 2025):
 * JavaScript happily parses year 0000, but Postgres rejects it (SQLSTATE 22008), and a
 * Prisma error there would surface as a generic 500. Every day that reaches SQL —
 * including a defaulted start — stays inside these edges.
 */
export const MIN_DAY = "2000-01-01";
export const MAX_DAY = "2100-12-31";
/**
 * People whose ONLY roles are these are not counted (the employeeWhere convention).
 * ⚠️ Must match the literal `r.name NOT IN ('Super Admin', 'Admin')` in the summary SQL.
 */
const ADMIN_ONLY_ROLES = ["Super Admin", "Admin"];

export interface SubmissionGapsParams {
  startDate: string;
  endDate: string;
  /** IST calendar day treated as "today". Always todayIST() on the route; tests pin it. */
  today: string;
  teamId: string | null;
  platform: string | null;
  employeeId: string | null;
}

export interface SubmissionGapDaysParams {
  employeeId: string;
  accountId: string;
  startDate: string;
  endDate: string;
  today: string;
}

/** GET /admin/reports/submission-gaps/days.csv — the summary's filters plus the panel's own. */
export interface SubmissionGapDaysCsvParams {
  startDate: string;
  endDate: string;
  today: string;
  teamId: string | null;
  platform: string | null;
  /** Person dropdown. */
  employeeId: string | null;
  /** Channel dropdown. */
  accountId: string | null;
  view: GapView;
  /** Normalised search text (normalizeGapSearch). */
  q: string;
  /** Normalised "at least N missed days" (normalizeGapMinMissed). */
  minMissed: number;
}

// ─── Parameter validation ────────────────────────────────────────────────────────

function badRequest(message: string, field?: string): AppError {
  return new AppError(400, "INVALID_PARAMS", message, field ? [{ field, message }] : undefined);
}

/** Days between two YYYY-MM-DD strings (b − a), computed on UTC midnights. */
function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export function shiftDay(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** A real calendar day in YYYY-MM-DD form (rejects 2026-02-30, 2026-13-01, …). */
function parseDay(raw: unknown, field: string): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string" || !DAY_RE.test(raw)) {
    throw badRequest(`${field} must be a date in YYYY-MM-DD format`, field);
  }
  const ms = Date.parse(`${raw}T00:00:00Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== raw) {
    throw badRequest(`${field} is not a real calendar date`, field);
  }
  if (raw < MIN_DAY || raw > MAX_DAY) {
    throw badRequest(`${field} must be between ${MIN_DAY} and ${MAX_DAY}`, field);
  }
  return raw;
}

function parseId(raw: unknown, field: string, required: boolean): string | null {
  if (raw === undefined || raw === null || raw === "") {
    if (required) throw badRequest(`${field} is required`, field);
    return null;
  }
  if (typeof raw !== "string" || raw.length > ID_MAX || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw badRequest(`${field} is not a valid id`, field);
  }
  return raw;
}

function parseRange(query: Record<string, unknown>, today: string): { startDate: string; endDate: string } {
  const endDate = parseDay(query.endDate, "endDate") ?? today;
  // A defaulted start is clamped, not rejected: the caller never sent it, so a 400
  // naming startDate would blame a parameter that is not in the request.
  const defaultStart = shiftDay(endDate, -(DEFAULT_RANGE_DAYS - 1));
  const startDate = parseDay(query.startDate, "startDate") ?? (defaultStart < MIN_DAY ? MIN_DAY : defaultStart);
  if (startDate > endDate) throw badRequest("startDate must be on or before endDate", "startDate");
  const span = dayDiff(startDate, endDate) + 1;
  if (span > MAX_RANGE_DAYS) {
    throw badRequest(`The range is ${span} days — at most ${MAX_RANGE_DAYS} days can be analysed at once`, "startDate");
  }
  return { startDate, endDate };
}

export function parseSubmissionGapsQuery(
  query: Record<string, unknown>,
  today: string = todayIST(),
): SubmissionGapsParams {
  const { startDate, endDate } = parseRange(query, today);
  let platform: string | null = null;
  if (query.platform !== undefined && query.platform !== null && query.platform !== "") {
    if (typeof query.platform !== "string" || !/^[a-z0-9_-]{1,32}$/.test(query.platform)) {
      throw badRequest("platform must be a platform slug such as instagram", "platform");
    }
    platform = query.platform;
  }
  return {
    startDate,
    endDate,
    today,
    platform,
    teamId: parseId(query.teamId, "teamId", false),
    employeeId: parseId(query.employeeId, "employeeId", false),
  };
}

export function parseSubmissionGapDaysQuery(
  query: Record<string, unknown>,
  today: string = todayIST(),
): SubmissionGapDaysParams {
  const employeeId = parseId(query.employeeId, "employeeId", true) as string;
  const accountId = parseId(query.accountId, "accountId", true) as string;
  const { startDate, endDate } = parseRange(query, today);
  return { employeeId, accountId, startDate, endDate, today };
}

/**
 * The all-rows day-by-day CSV takes the summary's filters (range, team, platform) plus
 * the panel's client-side ones (view, person, channel, search, minimum missed days), so
 * the file covers exactly the rows on screen. The search text and the threshold are
 * normalised with the SAME shared functions the panel filters with.
 */
export function parseSubmissionGapDaysCsvQuery(
  query: Record<string, unknown>,
  today: string = todayIST(),
): SubmissionGapDaysCsvParams {
  const base = parseSubmissionGapsQuery(query, today);
  let view: GapView = "channels";
  if (query.view !== undefined && query.view !== null && query.view !== "") {
    if (query.view !== "channels" && query.view !== "people") {
      throw badRequest("view must be channels or people", "view");
    }
    view = query.view;
  }
  let q = "";
  if (query.q !== undefined && query.q !== null && query.q !== "") {
    // An array (?q=a&q=b) or an over-long value is not a search box's input.
    if (typeof query.q !== "string" || query.q.length > GAP_SEARCH_MAX_LENGTH * 2) {
      throw badRequest(`q must be a search text of at most ${GAP_SEARCH_MAX_LENGTH} characters`, "q");
    }
    q = normalizeGapSearch(query.q);
  }
  let minMissed = 0;
  if (query.minMissed !== undefined && query.minMissed !== null && query.minMissed !== "") {
    if (typeof query.minMissed !== "string" || !/^\d{1,5}$/.test(query.minMissed)) {
      throw badRequest("minMissed must be a whole number of days", "minMissed");
    }
    minMissed = normalizeGapMinMissed(query.minMissed);
  }
  return {
    startDate: base.startDate,
    endDate: base.endDate,
    today,
    teamId: base.teamId,
    platform: base.platform,
    employeeId: base.employeeId,
    accountId: parseId(query.accountId, "accountId", false),
    view,
    q,
    minMissed,
  };
}

// ─── Summary ─────────────────────────────────────────────────────────────────────

// ⚠️ maxEntries is a MEMORY bound. One cached 90-day result retained 1.13 MB of heap
// (measured with --expose-gc: 453 assignments, 90 people), and the shared memo only
// sweeps expired entries when a new key arrives AT the cap — so stale keys (every
// window × team × platform, and every `today`) pile up to the cap: at 100 that is
// ~110 MB of API heap on the 2 GB box. A few admins cannot need more than ~20 live
// keys inside the 60 s TTL; hitting the cap costs one extra cold compute, nothing more.
const memo = createSingleFlightMemo({ ttlMs: 60_000, maxEntries: 20 });

/** Tests only (module-level caches — the documented cross-test pollution class). */
export function invalidateSubmissionGapsCache(): void {
  memo.clear();
  csvMemo.clear();
}

export function getSubmissionGaps(params: SubmissionGapsParams): Promise<SubmissionGapsResult> {
  // Every SQL-affecting input is in the key — including `today`, so a cached result
  // can never describe yesterday's "today" after midnight.
  const key = [
    params.startDate,
    params.endDate,
    params.today,
    params.teamId ?? "",
    params.platform ?? "",
    params.employeeId ?? "",
  ].join("|");
  return memo.memo(key, () => withHeavyQuerySlot("submission-gaps", () => computeSubmissionGaps(params)));
}

interface RawPair {
  employeeId: string;
  employeeName: string;
  teamId: string | null;
  teamName: string | null;
  accountId: string;
  handle: string;
  displayName: string;
  platform: string;
  platformName: string;
  assignedSince: string;
  countedFrom: string | null;
  countedThrough: string | null;
  countedDays: number;
  activeDays: number;
  linkCount: number;
  missedRangeCount: number;
  missedRanges: [string, string][] | null;
  longestGapDays: number | null;
  currentGapDays: number;
  currentGapOpenEnded: boolean;
  lastPostedAt: string | null;
  lastPostedIST: string | null;
  lastPostedDay: string | null;
  lastPostedApprox: boolean | null;
  todayLinks: number;
}

interface RawEmployee {
  employeeId: string;
  employeeName: string;
  teamId: string | null;
  teamName: string | null;
  accountCount: number;
  countedFrom: string | null;
  countedThrough: string | null;
  countedDays: number;
  activeDays: number;
  partialDays: number;
  missedChannelDays: number;
  linkCount: number;
  missedRangeCount: number;
  missedRanges: [string, string][] | null;
  longestGapDays: number | null;
  currentGapDays: number;
  currentGapOpenEnded: boolean;
  lastPostedAt: string | null;
  lastPostedIST: string | null;
  lastPostedDay: string | null;
  lastPostedApprox: boolean | null;
  todayPostedAccounts: number;
  todayLinks: number;
}

interface RawResult {
  pairs: RawPair[];
  employees: RawEmployee[];
  pair_total: number;
  inactive_assignments: number;
  teams: GapTeam[];
  platforms: { slug: string; name: string }[];
}

/**
 * The summary statement, as one static Prisma.sql template. Exported so the EXPLAIN
 * check (and anything else that must reason about the real plan) runs the exact SQL.
 *
 * ⚠️ THE SHAPE IS LOAD-BEARING. It is a LINEAR pipeline — day series → runs (gaps and
 * islands) → one GROUP BY per output row — and every intermediate CTE is MATERIALIZED.
 * The planner's row estimates for CTEs are ~1 row, so a CTE that Postgres inlines is
 * happily re-run inside a nested loop once per (employee, channel): the first draft of
 * this query recomputed its missed-range window 400 times and took 2.1 s on 90 days of
 * a 120-person estate (measured; the materialized form is the fix). Do not remove the
 * MATERIALIZED keywords or join the runs back to per-pair CTEs.
 */
export function submissionGapsSql(p: SubmissionGapsParams): Prisma.Sql {
  const { startDate: start, endDate: end, today, teamId, platform, employeeId } = p;
  const cutover = EXACT_TIME_SINCE;
  const maxRanges = MAX_RANGES_PER_ROW;
  const maxRows = MAX_ROWS;
  // The last countable day is the same for every pair: yesterday, or the window end.
  const yesterday = shiftDay(today, -1);
  const lastDay = end < yesterday ? end : yesterday;
  const postedThrough = end < today ? end : today;

  // ⚠️ Tagged template: every ${} is a bound parameter (no string splicing). Dates are
  // bound as text and cast with ::date, so no JS Date/timezone conversion is involved.
  // Timestamps are stored as UTC in `timestamp without time zone`; IST = + 330 minutes
  // (fixed offset, no DST). Times leave the database already formatted, with an
  // explicit "Z" on the ISO form so a browser can never read them as local time.
  return Prisma.sql`
    WITH emp AS MATERIALIZED (
      SELECT u.id, u.name,
             COALESCE(pu.id, fm.org_unit_id) AS team_id,
             COALESCE(pu.name, fm.name) AS team_name
      FROM users u
      LEFT JOIN org_units pu ON pu.id = u.org_unit_id
      LEFT JOIN LATERAL (
        SELECT tm.org_unit_id, ou.name
        FROM team_memberships tm
        JOIN org_units ou ON ou.id = tm.org_unit_id
        WHERE tm.user_id = u.id
        ORDER BY tm.is_primary DESC, ou.name ASC
        LIMIT 1
      ) fm ON TRUE
      WHERE u.status = 'ACTIVE'
        AND u.deleted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
          WHERE ur.user_id = u.id AND r.name NOT IN ('Super Admin', 'Admin')
        )
        AND (${employeeId}::text IS NULL OR u.id = ${employeeId}::text)
        AND (
          ${teamId}::text IS NULL
          OR u.org_unit_id = ${teamId}::text
          OR EXISTS (
            SELECT 1 FROM team_memberships tm2
            WHERE tm2.user_id = u.id AND tm2.org_unit_id = ${teamId}::text
          )
        )
    ),
    cur AS MATERIALIZED (
      SELECT aa.employee_id, aa.account_id, aa.assigned_at, (sa.status = 'ACTIVE') AS channel_active
      FROM account_assignments aa
      JOIN emp e ON e.id = aa.employee_id
      JOIN social_accounts sa ON sa.id = aa.account_id
      JOIN platforms pf ON pf.id = sa.platform_id
      WHERE aa.unassigned_at IS NULL
        AND (${platform}::text IS NULL OR pf.slug = ${platform}::text)
    ),
    win AS MATERIALIZED (
      SELECT employee_id, account_id,
             (MIN(assigned_at) + INTERVAL '330 minutes')::date AS assigned_day,
             GREATEST(${start}::date, (MIN(assigned_at) + INTERVAL '330 minutes')::date) AS from_day
      FROM cur
      WHERE channel_active
      GROUP BY employee_id, account_id
    ),
    emp_win AS MATERIALIZED (
      SELECT employee_id,
             COUNT(*)::int AS account_count,
             MIN(assigned_day) AS assigned_day,
             MIN(from_day) AS from_day
      FROM win
      GROUP BY employee_id
    ),
    -- Each report's links are read ONCE, and only through indexes. Per person (the
    -- LATERAL), that person's reports from their earliest counted day — the
    -- daily_reports (employee_id, date) index — and each report's links by report_id,
    -- grouped per (channel, day); then only the groups of their assigned channels
    -- from each assignment's own first counted day are kept.
    -- ⚠️ Two shapes measured and rejected (450-assignment, 90-person, 341k-link seed):
    --   • joining daily_reports per (employee, CHANNEL) re-reads every report's links
    --     once per channel the person holds — 31,857 index-scan loops for 6,880
    --     reports over 90 days;
    --   • a plain "employee_id IN (SELECT … FROM win)" filter lets the planner
    --     sequentially scan ALL of report_links (every link ever submitted) and filter
    --     afterwards — a read that grows with total history, not with the window.
    -- Same rows either way: win is unique per (employee, account), from_day ≥ start.
    posted AS MATERIALIZED (
      SELECT x.employee_id, x.account_id, x.day, x.n, x.last_at
      FROM emp_win ew
      CROSS JOIN LATERAL (
        SELECT dr.employee_id, rl.account_id, dr.date AS day,
               COUNT(*)::int AS n,
               MAX(CASE WHEN dr.date < ${cutover}::date THEN dr.created_at ELSE rl.first_seen_at END) AS last_at
        FROM daily_reports dr
        JOIN report_links rl ON rl.report_id = dr.id
        WHERE dr.employee_id = ew.employee_id
          AND dr.date >= ew.from_day
          AND dr.date <= ${postedThrough}::date
          AND rl.url IS NOT NULL
          AND btrim(rl.url) <> ''
          AND rl.is_scheduled = FALSE
        GROUP BY dr.employee_id, rl.account_id, dr.date
      ) x
      JOIN win w ON w.employee_id = x.employee_id AND w.account_id = x.account_id AND x.day >= w.from_day
    ),
    flags AS MATERIALIZED (
      SELECT w.employee_id, w.account_id, w.from_day, w.assigned_day,
             (w.from_day + g.i) AS day,
             COALESCE(p.n, 0) AS n
      FROM win w
      CROSS JOIN LATERAL generate_series(0, ${lastDay}::date - w.from_day) AS g(i)
      LEFT JOIN posted p
        ON p.employee_id = w.employee_id AND p.account_id = w.account_id AND p.day = w.from_day + g.i
    ),
    runs AS MATERIALIZED (
      SELECT employee_id, account_id, from_day, assigned_day,
             (n = 0) AS missed,
             MIN(day) AS s, MAX(day) AS e,
             COUNT(*)::int AS len,
             SUM(n)::int AS links
      FROM (
        SELECT f.*,
               f.day - (ROW_NUMBER() OVER (PARTITION BY f.employee_id, f.account_id, (f.n = 0) ORDER BY f.day))::int AS grp
        FROM flags f
      ) x
      GROUP BY employee_id, account_id, from_day, assigned_day, (n = 0), grp
    ),
    pair_agg AS MATERIALIZED (
      SELECT employee_id, account_id,
             SUM(len)::int AS counted_days,
             COALESCE(SUM(len) FILTER (WHERE NOT missed), 0)::int AS active_days,
             COALESCE(SUM(links), 0)::int AS link_count,
             (COUNT(*) FILTER (WHERE missed))::int AS range_count,
             MAX(len) FILTER (WHERE missed) AS longest,
             COALESCE(MAX(len) FILTER (WHERE missed AND e = ${lastDay}::date), 0)::int AS current_gap,
             COALESCE(BOOL_OR(missed AND e = ${lastDay}::date AND s = from_day AND from_day > assigned_day), FALSE)
               AS gap_open,
             json_agg(json_build_array(to_char(s, 'YYYY-MM-DD'), to_char(e, 'YYYY-MM-DD')) ORDER BY s)
               FILTER (WHERE missed AND rn <= ${maxRanges}) AS ranges
      FROM (
        SELECT r.*, ROW_NUMBER() OVER (PARTITION BY r.employee_id, r.account_id, r.missed ORDER BY r.s DESC) AS rn
        FROM runs r
      ) rr
      GROUP BY employee_id, account_id
    ),
    pair_last AS MATERIALIZED (
      SELECT employee_id, account_id,
             -- "Last posted" = the latest REPORT day with a link, and the last posting
             -- time ON THAT DAY. Not MAX(last_at): a report restored or submitted late
             -- can carry a later timestamp than a newer day's, which would name the wrong
             -- day as the last one posted.
             (ARRAY_AGG(last_at ORDER BY day DESC))[1] AS last_at,
             MAX(day) AS last_day,
             COALESCE(SUM(n) FILTER (WHERE day = ${today}::date), 0)::int AS today_links
      FROM posted
      GROUP BY employee_id, account_id
    ),
    emp_flags AS MATERIALIZED (
      SELECT employee_id, day,
             BOOL_OR(n > 0) AS any_posted,
             BOOL_AND(n > 0) AS all_posted
      FROM flags
      GROUP BY employee_id, day
    ),
    emp_runs AS MATERIALIZED (
      SELECT employee_id,
             (NOT any_posted) AS missed,
             MIN(day) AS s, MAX(day) AS e,
             COUNT(*)::int AS len,
             (COUNT(*) FILTER (WHERE any_posted AND NOT all_posted))::int AS partial
      FROM (
        SELECT ef.*,
               ef.day - (ROW_NUMBER() OVER (PARTITION BY ef.employee_id, ef.any_posted ORDER BY ef.day))::int AS grp
        FROM emp_flags ef
      ) x
      GROUP BY employee_id, any_posted, grp
    ),
    emp_agg AS MATERIALIZED (
      SELECT rr.employee_id,
             SUM(rr.len)::int AS counted_days,
             COALESCE(SUM(rr.len) FILTER (WHERE NOT rr.missed), 0)::int AS active_days,
             COALESCE(SUM(rr.partial), 0)::int AS partial_days,
             MIN(rr.s) AS first_day,
             MAX(rr.e) AS last_day,
             (COUNT(*) FILTER (WHERE rr.missed))::int AS range_count,
             MAX(rr.len) FILTER (WHERE rr.missed) AS longest,
             COALESCE(MAX(rr.len) FILTER (WHERE rr.missed AND rr.e = ${lastDay}::date), 0)::int AS current_gap,
             COALESCE(BOOL_OR(rr.missed AND rr.e = ${lastDay}::date AND rr.s = ew.from_day AND ew.from_day > ew.assigned_day), FALSE)
               AS gap_open,
             json_agg(json_build_array(to_char(rr.s, 'YYYY-MM-DD'), to_char(rr.e, 'YYYY-MM-DD')) ORDER BY rr.s)
               FILTER (WHERE rr.missed AND rr.rn <= ${maxRanges}) AS ranges
      FROM (
        SELECT er.*, ROW_NUMBER() OVER (PARTITION BY er.employee_id, er.missed ORDER BY er.s DESC) AS rn
        FROM emp_runs er
      ) rr
      JOIN emp_win ew ON ew.employee_id = rr.employee_id
      GROUP BY rr.employee_id
    ),
    emp_pair_sums AS MATERIALIZED (
      SELECT employee_id,
             SUM(counted_days - active_days)::int AS missed_channel_days,
             SUM(link_count)::int AS link_count
      FROM pair_agg
      GROUP BY employee_id
    ),
    emp_last AS MATERIALIZED (
      SELECT employee_id,
             (ARRAY_AGG(last_at ORDER BY last_day DESC, last_at DESC))[1] AS last_at,
             MAX(last_day) AS last_day,
             (COUNT(*) FILTER (WHERE today_links > 0))::int AS today_posted_accounts,
             SUM(today_links)::int AS today_links
      FROM pair_last
      GROUP BY employee_id
    )
    SELECT
      (
        SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json)
        FROM (
          SELECT w.employee_id AS "employeeId",
                 e.name AS "employeeName",
                 e.team_id AS "teamId",
                 e.team_name AS "teamName",
                 w.account_id AS "accountId",
                 sa.handle AS "handle",
                 sa.display_name AS "displayName",
                 pf.slug AS "platform",
                 pf.name AS "platformName",
                 to_char(w.assigned_day, 'YYYY-MM-DD') AS "assignedSince",
                 CASE WHEN w.from_day <= ${lastDay}::date THEN to_char(w.from_day, 'YYYY-MM-DD') END AS "countedFrom",
                 CASE WHEN w.from_day <= ${lastDay}::date THEN to_char(${lastDay}::date, 'YYYY-MM-DD') END AS "countedThrough",
                 COALESCE(pa.counted_days, 0) AS "countedDays",
                 COALESCE(pa.active_days, 0) AS "activeDays",
                 COALESCE(pa.link_count, 0) AS "linkCount",
                 COALESCE(pa.range_count, 0) AS "missedRangeCount",
                 pa.ranges AS "missedRanges",
                 pa.longest AS "longestGapDays",
                 COALESCE(pa.current_gap, 0) AS "currentGapDays",
                 COALESCE(pa.gap_open, FALSE) AS "currentGapOpenEnded",
                 to_char(pl.last_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastPostedAt",
                 to_char(pl.last_at + INTERVAL '330 minutes', 'YYYY-MM-DD HH24:MI') AS "lastPostedIST",
                 to_char(pl.last_day, 'YYYY-MM-DD') AS "lastPostedDay",
                 (pl.last_day < ${cutover}::date) AS "lastPostedApprox",
                 COALESCE(pl.today_links, 0) AS "todayLinks"
          FROM win w
          JOIN emp e ON e.id = w.employee_id
          JOIN social_accounts sa ON sa.id = w.account_id
          JOIN platforms pf ON pf.id = sa.platform_id
          LEFT JOIN pair_agg pa ON pa.employee_id = w.employee_id AND pa.account_id = w.account_id
          LEFT JOIN pair_last pl ON pl.employee_id = w.employee_id AND pl.account_id = w.account_id
          ORDER BY COALESCE(pa.counted_days - pa.active_days, 0) DESC, e.name, sa.display_name, w.account_id
          LIMIT ${maxRows}
        ) t
      ) AS pairs,
      (
        SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json)
        FROM (
          SELECT ew.employee_id AS "employeeId",
                 e.name AS "employeeName",
                 e.team_id AS "teamId",
                 e.team_name AS "teamName",
                 ew.account_count AS "accountCount",
                 to_char(ea.first_day, 'YYYY-MM-DD') AS "countedFrom",
                 to_char(ea.last_day, 'YYYY-MM-DD') AS "countedThrough",
                 COALESCE(ea.counted_days, 0) AS "countedDays",
                 COALESCE(ea.active_days, 0) AS "activeDays",
                 COALESCE(ea.partial_days, 0) AS "partialDays",
                 COALESCE(eps.missed_channel_days, 0) AS "missedChannelDays",
                 COALESCE(eps.link_count, 0) AS "linkCount",
                 COALESCE(ea.range_count, 0) AS "missedRangeCount",
                 ea.ranges AS "missedRanges",
                 ea.longest AS "longestGapDays",
                 COALESCE(ea.current_gap, 0) AS "currentGapDays",
                 COALESCE(ea.gap_open, FALSE) AS "currentGapOpenEnded",
                 to_char(el.last_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "lastPostedAt",
                 to_char(el.last_at + INTERVAL '330 minutes', 'YYYY-MM-DD HH24:MI') AS "lastPostedIST",
                 to_char(el.last_day, 'YYYY-MM-DD') AS "lastPostedDay",
                 (el.last_day < ${cutover}::date) AS "lastPostedApprox",
                 COALESCE(el.today_posted_accounts, 0) AS "todayPostedAccounts",
                 COALESCE(el.today_links, 0) AS "todayLinks"
          FROM emp_win ew
          JOIN emp e ON e.id = ew.employee_id
          LEFT JOIN emp_agg ea ON ea.employee_id = ew.employee_id
          LEFT JOIN emp_pair_sums eps ON eps.employee_id = ew.employee_id
          LEFT JOIN emp_last el ON el.employee_id = ew.employee_id
          ORDER BY e.name, ew.employee_id
          LIMIT ${maxRows}
        ) t
      ) AS employees,
      (SELECT COUNT(*)::int FROM win) AS pair_total,
      (
        SELECT COUNT(*)::int
        FROM (SELECT DISTINCT employee_id, account_id FROM cur WHERE NOT channel_active) x
      ) AS inactive_assignments,
      (
        SELECT COALESCE(json_agg(json_build_object('id', ou.id, 'name', ou.name) ORDER BY ou.name, ou.id), '[]'::json)
        FROM org_units ou
        WHERE ou.type IN ('TEAM', 'SUB_TEAM')
      ) AS teams,
      (
        SELECT COALESCE(json_agg(json_build_object('slug', pl.slug, 'name', pl.name) ORDER BY pl.name), '[]'::json)
        FROM platforms pl
      ) AS platforms
  `;
}

async function computeSubmissionGaps(p: SubmissionGapsParams): Promise<SubmissionGapsResult> {
  const { startDate: start, endDate: end, today } = p;
  const [raw] = await prisma.$queryRaw<RawResult[]>(submissionGapsSql(p));

  const includesToday = start <= today && today <= end;
  const yesterday = shiftDay(today, -1);
  const countedThrough = end < yesterday ? end : yesterday;

  const team = (id: string | null, name: string | null): GapTeam | null => (id && name ? { id, name } : null);
  const rate = (active: number, counted: number): number | null => (counted > 0 ? active / counted : null);

  const rows: GapPairRow[] = (raw?.pairs ?? []).map((r) => {
    const ranges = r.missedRanges ?? [];
    const assignedByToday = r.assignedSince <= today;
    return {
      employee: { id: r.employeeId, name: r.employeeName, team: team(r.teamId, r.teamName) },
      account: {
        id: r.accountId,
        handle: r.handle,
        displayName: r.displayName,
        platform: r.platform,
        platformName: r.platformName,
      },
      assignedSince: r.assignedSince,
      countedFrom: r.countedFrom,
      countedThrough: r.countedThrough,
      countedDays: r.countedDays,
      activeDays: r.activeDays,
      missedDays: r.countedDays - r.activeDays,
      activeRate: rate(r.activeDays, r.countedDays),
      missedRanges: ranges,
      missedRangeCount: r.missedRangeCount,
      missedRangesTruncated: r.missedRangeCount > ranges.length,
      longestGapDays: r.longestGapDays ?? 0,
      currentGapDays: r.currentGapDays,
      currentGapOpenEnded: r.currentGapOpenEnded,
      lastPostedDay: r.lastPostedDay,
      lastPostedAt: r.lastPostedAt,
      lastPostedIST: r.lastPostedIST,
      lastPostedApprox: r.lastPostedAt ? r.lastPostedApprox === true : false,
      linkCount: r.linkCount,
      todayStatus: includesToday && assignedByToday ? (r.todayLinks > 0 ? "posted" : "not_yet") : null,
      todayLinks: r.todayLinks,
    };
  });

  // Channels assigned by today, per employee — the denominator of the employee's
  // "today" status (an assignment dated in the future is not expected yet).
  const assignedTodayCount = new Map<string, number>();
  for (const r of rows) {
    if (r.assignedSince <= today) {
      assignedTodayCount.set(r.employee.id, (assignedTodayCount.get(r.employee.id) ?? 0) + 1);
    }
  }

  const employees: GapEmployeeRow[] = (raw?.employees ?? []).map((r) => {
    const ranges = r.missedRanges ?? [];
    const expected = assignedTodayCount.get(r.employeeId) ?? 0;
    let todayStatus: GapEmployeeRow["todayStatus"] = null;
    if (includesToday && expected > 0) {
      todayStatus =
        r.todayPostedAccounts === 0 ? "not_yet" : r.todayPostedAccounts < expected ? "partial" : "posted";
    }
    return {
      employee: { id: r.employeeId, name: r.employeeName, team: team(r.teamId, r.teamName) },
      accountCount: r.accountCount,
      countedFrom: r.countedFrom,
      countedThrough: r.countedThrough,
      countedDays: r.countedDays,
      activeDays: r.activeDays,
      missedDays: r.countedDays - r.activeDays,
      partialDays: r.partialDays,
      missedChannelDays: r.missedChannelDays,
      activeRate: rate(r.activeDays, r.countedDays),
      missedRanges: ranges,
      missedRangeCount: r.missedRangeCount,
      missedRangesTruncated: r.missedRangeCount > ranges.length,
      longestGapDays: r.longestGapDays ?? 0,
      currentGapDays: r.currentGapDays,
      currentGapOpenEnded: r.currentGapOpenEnded,
      lastPostedDay: r.lastPostedDay,
      lastPostedAt: r.lastPostedAt,
      lastPostedIST: r.lastPostedIST,
      lastPostedApprox: r.lastPostedAt ? r.lastPostedApprox === true : false,
      linkCount: r.linkCount,
      todayStatus,
      todayPostedAccounts: r.todayPostedAccounts,
      todayLinks: r.todayLinks,
    };
  });

  const pairTotal = raw?.pair_total ?? 0;
  return {
    range: {
      startDate: start,
      endDate: end,
      today,
      includesToday,
      countedThrough,
      exactTimesSince: EXACT_TIME_SINCE,
    },
    rows,
    employees,
    totals: {
      assignments: pairTotal,
      employees: employees.length,
      countedDays: rows.reduce((s, r) => s + r.countedDays, 0),
      missedDays: rows.reduce((s, r) => s + r.missedDays, 0),
      notYetToday: includesToday ? rows.filter((r) => r.todayStatus === "not_yet").length : null,
      truncated: pairTotal > rows.length,
    },
    excluded: { inactiveChannelAssignments: raw?.inactive_assignments ?? 0 },
    filters: { teams: raw?.teams ?? [], platforms: raw?.platforms ?? [] },
  };
}

// ─── Day-by-day drill-down for one (employee, account) ─────────────────────────────

interface RawDay {
  day: string;
  n: number;
  first_at: string | null;
  last_at: string | null;
  first_ist: string | null;
  last_ist: string | null;
}

export async function getSubmissionGapDays(p: SubmissionGapDaysParams): Promise<SubmissionGapDaysResult> {
  const { employeeId, accountId, startDate: start, endDate: end, today } = p;

  // The earliest CURRENT assignment row for the pair — the same rule the summary uses.
  const assignment = await prisma.accountAssignment.findFirst({
    where: { employeeId, accountId, unassignedAt: null },
    orderBy: { assignedAt: "asc" },
    select: {
      assignedAt: true,
      employee: {
        select: {
          id: true,
          name: true,
          status: true,
          deletedAt: true,
          // A person holds a handful of roles — bounded.
          roles: { select: { role: { select: { name: true } } } },
        },
      },
      account: {
        select: {
          id: true,
          handle: true,
          displayName: true,
          status: true,
          platform: { select: { slug: true, name: true } },
        },
      },
    },
  });
  if (!assignment) {
    throw new AppError(404, "NOT_FOUND", "This person is not currently assigned to this channel.");
  }
  // The summary's eligibility rules (emp / win CTEs), so a pair the summary hides has
  // no day-by-day view either. Distinct messages: the pair IS assigned, and a channel
  // paused (or a person deactivated) after the summary loaded must not read as "not
  // assigned".
  const emp = assignment.employee;
  const counted =
    emp.status === "ACTIVE" &&
    emp.deletedAt === null &&
    emp.roles.some((r) => !ADMIN_ONLY_ROLES.includes(r.role.name));
  if (!counted) {
    throw new AppError(
      404,
      "NOT_FOUND",
      "This person is not counted in submission gaps (inactive, removed, or an administrator only).",
    );
  }
  if (assignment.account.status !== "ACTIVE") {
    throw new AppError(404, "NOT_FOUND", "This channel is paused or archived, so it is not counted in submission gaps.");
  }

  const assignedSince = dateToIST(assignment.assignedAt);
  const cutover = EXACT_TIME_SINCE;
  const fromDay = start > assignedSince ? start : assignedSince;
  const toDay = end < today ? end : today;

  // Bounded by the range (≤ MAX_RANGE_DAYS rows) and by ONE employee's reports —
  // daily_reports(employee_id, date) index, then report_links(report_id).
  const days =
    fromDay > toDay
      ? []
      : await prisma.$queryRaw<RawDay[]>`
          WITH p AS (
            SELECT dr.date AS day,
                   COUNT(*)::int AS n,
                   MIN(CASE WHEN dr.date < ${cutover}::date THEN dr.created_at ELSE rl.first_seen_at END) AS first_at,
                   MAX(CASE WHEN dr.date < ${cutover}::date THEN dr.created_at ELSE rl.first_seen_at END) AS last_at
            FROM daily_reports dr
            JOIN report_links rl ON rl.report_id = dr.id
            WHERE dr.employee_id = ${employeeId}
              AND rl.account_id = ${accountId}
              AND dr.date >= ${fromDay}::date
              AND dr.date <= ${toDay}::date
              AND rl.url IS NOT NULL
              AND btrim(rl.url) <> ''
              AND rl.is_scheduled = FALSE
            GROUP BY dr.date
          )
          SELECT to_char(${fromDay}::date + g.i, 'YYYY-MM-DD') AS day,
                 COALESCE(p.n, 0)::int AS n,
                 to_char(p.first_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS first_at,
                 to_char(p.last_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_at,
                 to_char(p.first_at + INTERVAL '330 minutes', 'YYYY-MM-DD HH24:MI') AS first_ist,
                 to_char(p.last_at + INTERVAL '330 minutes', 'YYYY-MM-DD HH24:MI') AS last_ist
          FROM generate_series(0, ${toDay}::date - ${fromDay}::date) AS g(i)
          LEFT JOIN p ON p.day = ${fromDay}::date + g.i
          ORDER BY g.i DESC
        `;

  return {
    employee: { id: emp.id, name: emp.name },
    account: {
      id: assignment.account.id,
      handle: assignment.account.handle,
      displayName: assignment.account.displayName,
      platform: assignment.account.platform.slug,
      platformName: assignment.account.platform.name,
      status: assignment.account.status,
    },
    assignedSince,
    range: {
      startDate: start,
      endDate: end,
      today,
      includesToday: start <= today && today <= end,
      exactTimesSince: EXACT_TIME_SINCE,
    },
    // The status / approximate rules are the shared ones, so this view, the in-view CSV
    // and the all-rows CSV (buildGapDaySeries) can never classify a day differently.
    days: days.map((d) => ({
      date: d.day,
      status: gapDayStatus(d.day, d.n, today),
      linkCount: d.n,
      firstPostedAt: d.first_at,
      lastPostedAt: d.last_at,
      firstPostedIST: d.first_ist,
      lastPostedIST: d.last_ist,
      approximate: gapTimeIsApproximate(d.day, d.n),
    })),
  };
}

// ─── Day-by-day CSV for ALL rows on screen (GET /submission-gaps/days.csv) ─────────

/**
 * Output bound: rows = selected pairs × days in the window. 250k rows is ≈ 30 MB of CSV
 * and covers a full year for ~680 assignments (prod has ~450). Above it the request is a
 * clean 400 that says how to narrow it — never an unbounded read or response.
 */
export const MAX_CSV_DAY_ROWS = 250_000;

// ⚠️ maxEntries is a MEMORY bound. An entry holds only the POSTED days of the exported
// pairs, as one compact text value per pair (~46 bytes a posted day). Measured with
// --expose-gc on a 459-assignment, 90-person, 258k-link seed: the worst case — every
// row for 366 days (168k CSV lines, 19 MB) — retains 8.4 MB per entry (the summary it
// reads retains 3.4 MB in its own memo), and repeated exports do not grow the heap.
// 4 entries covers a double-click and a couple of admins exporting at once; a miss costs
// one bounded recompute (0.7 s for that worst case), nothing more.
const csvMemo = createSingleFlightMemo({ ttlMs: 60_000, maxEntries: 4 });

interface RawPostedPair {
  employeeId: string;
  accountId: string;
  /** "YYYY-MM-DD|n|first IST|last IST;…" for the days with links, chronological. */
  days: string;
}

const pairKey = (employeeId: string, accountId: string): string => `${employeeId}|${accountId}`;

/**
 * ONE statement for every exported pair: the days WITH links, grouped per (pair, day) in
 * the database — link rows never reach Node. It is the summary's `posted` shape (per
 * person, that person's reports from their earliest counted day through the
 * daily_reports (employee_id, date) index, then each report's links by report_id), with
 * the first AND the last posting time. The pairs arrive as three parallel arrays.
 * Exported so a plan check can run the exact SQL.
 */
export function submissionGapDaysCsvSql(
  sel: { employeeIds: string[]; accountIds: string[]; fromDays: string[] },
  toDay: string,
): Prisma.Sql {
  const cutover = EXACT_TIME_SINCE;
  return Prisma.sql`
    WITH sel AS MATERIALIZED (
      SELECT s.employee_id, s.account_id, s.from_day::date AS from_day
      FROM unnest(${sel.employeeIds}::text[], ${sel.accountIds}::text[], ${sel.fromDays}::text[])
        AS s(employee_id, account_id, from_day)
    ),
    emp AS MATERIALIZED (
      SELECT employee_id, MIN(from_day) AS from_day FROM sel GROUP BY employee_id
    ),
    posted AS MATERIALIZED (
      SELECT x.employee_id, x.account_id, x.day, x.n, x.first_at, x.last_at
      FROM emp e
      CROSS JOIN LATERAL (
        SELECT dr.employee_id, rl.account_id, dr.date AS day,
               COUNT(*)::int AS n,
               MIN(CASE WHEN dr.date < ${cutover}::date THEN dr.created_at ELSE rl.first_seen_at END) AS first_at,
               MAX(CASE WHEN dr.date < ${cutover}::date THEN dr.created_at ELSE rl.first_seen_at END) AS last_at
        FROM daily_reports dr
        JOIN report_links rl ON rl.report_id = dr.id
        WHERE dr.employee_id = e.employee_id
          AND dr.date >= e.from_day
          AND dr.date <= ${toDay}::date
          AND rl.url IS NOT NULL
          AND btrim(rl.url) <> ''
          AND rl.is_scheduled = FALSE
        GROUP BY dr.employee_id, rl.account_id, dr.date
      ) x
      JOIN sel s ON s.employee_id = x.employee_id AND s.account_id = x.account_id AND x.day >= s.from_day
    )
    SELECT employee_id AS "employeeId",
           account_id AS "accountId",
           string_agg(
             to_char(day, 'YYYY-MM-DD') || '|' || n::text || '|' ||
               COALESCE(to_char(first_at + INTERVAL '330 minutes', 'YYYY-MM-DD HH24:MI'), '') || '|' ||
               COALESCE(to_char(last_at + INTERVAL '330 minutes', 'YYYY-MM-DD HH24:MI'), ''),
             ';' ORDER BY day
           ) AS days
    FROM posted
    GROUP BY employee_id, account_id
  `;
}

function parsePostedDays(text: string | undefined): Map<string, GapPostedDay> {
  const m = new Map<string, GapPostedDay>();
  if (!text) return m;
  for (const item of text.split(";")) {
    const [date, n, first, last] = item.split("|");
    if (!date) continue;
    m.set(date, { linkCount: Number(n) || 0, firstPostedIST: first || null, lastPostedIST: last || null });
  }
  return m;
}

/** Long format sorts by person, then channel; days run oldest → newest within a pair. */
function byPersonThenChannel(a: GapPairRow, b: GapPairRow): number {
  return (
    a.employee.name.localeCompare(b.employee.name) ||
    a.employee.id.localeCompare(b.employee.id) ||
    a.account.displayName.localeCompare(b.account.displayName) ||
    a.account.id.localeCompare(b.account.id)
  );
}

export interface SubmissionGapDaysCsv {
  filename: string;
  /** Data rows (header excluded): pairs × days in the window. */
  rowCount: number;
  pairCount: number;
  /** The CSV, one chunk per pair (the first chunk is the BOM + header). Pure — no I/O. */
  chunks(): Generator<string>;
}

/**
 * Everything the export needs, computed BEFORE a byte is written — so a failure is a
 * clean JSON error, and no database connection is held while a slow client downloads.
 *
 *  1. The rows on screen: the same memoised summary the panel loaded (employeeId is left
 *     out of the key on purpose — the panel's request had none, so this is normally a
 *     cache hit), filtered by the SAME shared selection functions the panel uses.
 *  2. The output bound (MAX_CSV_DAY_ROWS) — checked before any aggregation runs.
 *  3. ONE aggregation of the posted days for exactly those pairs, inside the heavy-query
 *     bulkhead, behind a 60 s single-flight memo keyed by the exact pair set and window.
 *     ⚠️ The summary is fetched OUTSIDE this slot: holding one bulkhead slot while waiting
 *     for another (the summary takes its own) can deadlock the 2-slot gate.
 */
export async function buildSubmissionGapDaysCsv(
  p: SubmissionGapDaysCsvParams,
  opts: { maxRows?: number } = {},
): Promise<SubmissionGapDaysCsv> {
  const maxRows = opts.maxRows ?? MAX_CSV_DAY_ROWS;
  const summary = await getSubmissionGaps({
    startDate: p.startDate,
    endDate: p.endDate,
    today: p.today,
    teamId: p.teamId,
    platform: p.platform,
    employeeId: null,
  });
  const pairs = selectGapExportPairs(summary, p.view, {
    q: p.q,
    minMissed: p.minMissed,
    employeeId: p.employeeId,
    accountId: p.accountId,
  }).sort(byPersonThenChannel);

  // Every pair has a row for every day from the window start to min(end, today) —
  // including the days before its assignment ("Not assigned yet").
  const toDay = p.endDate < p.today ? p.endDate : p.today;
  const daysPerPair = Math.max(0, gapSpanDays(p.startDate, toDay));
  const rowCount = pairs.length * daysPerPair;
  if (rowCount > maxRows) {
    const nf = new Intl.NumberFormat("en-IN");
    throw new AppError(
      400,
      "EXPORT_TOO_LARGE",
      `This export would have ${nf.format(rowCount)} rows — at most ${nf.format(maxRows)} can be exported at once. ` +
        "Narrow the date range, or filter by team, platform, person or channel.",
    );
  }

  // Only pairs with a countable or reportable day in the window need the query: a pair
  // assigned after the window's last day is "Not assigned yet" throughout.
  const employeeIds: string[] = [];
  const accountIds: string[] = [];
  const fromDays: string[] = [];
  for (const r of pairs) {
    const from = r.assignedSince > p.startDate ? r.assignedSince : p.startDate;
    if (from > toDay) continue;
    employeeIds.push(r.employee.id);
    accountIds.push(r.account.id);
    fromDays.push(from);
  }

  let posted = new Map<string, string>();
  if (employeeIds.length > 0) {
    const digest = createHash("sha1")
      .update(employeeIds.map((e, i) => `${e}:${accountIds[i]}:${fromDays[i]}`).join(","))
      .digest("hex");
    const key = [p.startDate, toDay, p.today, digest].join("|");
    posted = await csvMemo.memo(key, () =>
      withHeavyQuerySlot("submission-gaps-days-csv", async () => {
        const rows = await prisma.$queryRaw<RawPostedPair[]>(
          submissionGapDaysCsvSql({ employeeIds, accountIds, fromDays }, toDay),
        );
        return new Map(rows.map((r) => [pairKey(r.employeeId, r.accountId), r.days]));
      }),
    );
  }

  const filename = daysCsvFilename(p, pairs);
  return {
    filename,
    rowCount,
    pairCount: pairs.length,
    *chunks() {
      yield "﻿" + GAP_DAYS_CSV_HEADERS.map(csvCell).join(",") + "\r\n";
      for (const r of pairs) {
        const cells = buildGapDaySeries({
          startDate: p.startDate,
          endDate: p.endDate,
          today: p.today,
          assignedSince: r.assignedSince,
          posted: parsePostedDays(posted.get(pairKey(r.employee.id, r.account.id))),
        });
        const info = gapCsvPairInfo(r);
        let out = "";
        // The series is newest-first (the on-screen order); a long-format file reads
        // oldest → newest.
        for (let i = cells.length - 1; i >= 0; i--) out += gapDaysCsvRow(info, cells[i]).map(csvCell).join(",") + "\r\n";
        yield out;
      }
    },
  };
}

/** submission-gaps-day-by-day-<start>_<end>[-<platform>][-<person>][-<channel>][-filtered].csv */
function daysCsvFilename(p: SubmissionGapDaysCsvParams, pairs: GapPairRow[]): string {
  const parts = ["submission-gaps-day-by-day", p.view === "people" ? "by-person" : "by-channel", `${p.startDate}_${p.endDate}`];
  if (p.platform) parts.push(gapFileSlug(p.platform));
  if (p.employeeId) {
    const r = pairs.find((x) => x.employee.id === p.employeeId);
    parts.push(r ? gapFileSlug(r.employee.name) || "person" : "person");
  }
  if (p.accountId) {
    const r = pairs.find((x) => x.account.id === p.accountId);
    parts.push(r ? gapFileSlug(r.account.displayName) || "channel" : "channel");
  }
  if (p.teamId || p.q || p.minMissed > 0) parts.push("filtered");
  return `${parts.filter(Boolean).join("-")}.csv`;
}
