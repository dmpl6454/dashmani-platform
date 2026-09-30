import { prisma, Prisma } from "@dashmani/db";
import { todayIST, dateToIST } from "@dashmani/shared";
import { AppError } from "../middleware/error-handler";
import { withHeavyQuerySlot } from "../utils/heavy-query";
import { createSingleFlightMemo } from "../utils/single-flight-memo";

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

export const EXACT_TIME_SINCE = "2026-06-03";
export const MAX_RANGE_DAYS = 366;
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

export interface GapTeam {
  id: string;
  name: string;
}

export interface GapPairRow {
  employee: { id: string; name: string; team: GapTeam | null };
  account: { id: string; handle: string; displayName: string; platform: string; platformName: string };
  /** IST day the current assignment began. */
  assignedSince: string;
  /** First / last counted day; null when nothing in the window is countable yet. */
  countedFrom: string | null;
  countedThrough: string | null;
  countedDays: number;
  activeDays: number;
  missedDays: number;
  /** activeDays / countedDays, or null when countedDays is 0. */
  activeRate: number | null;
  /** Missed runs as [first, last] IST days, chronological; the newest MAX_RANGES_PER_ROW. */
  missedRanges: [string, string][];
  missedRangeCount: number;
  missedRangesTruncated: boolean;
  longestGapDays: number;
  /** Consecutive missed days ending on the last counted day (yesterday for a window ending today). */
  currentGapDays: number;
  /** The current gap runs back to the window start while the assignment is older — it may be longer. */
  currentGapOpenEnded: boolean;
  /** Latest report day (IST) with a link on counted days or today, and the last posting time that day. */
  lastPostedDay: string | null;
  lastPostedAt: string | null;
  lastPostedIST: string | null;
  lastPostedApprox: boolean;
  /** Links on counted days (today excluded). */
  linkCount: number;
  todayStatus: "posted" | "not_yet" | null;
  todayLinks: number;
}

export interface GapEmployeeRow {
  employee: { id: string; name: string; team: GapTeam | null };
  accountCount: number;
  countedFrom: string | null;
  countedThrough: string | null;
  /** Days on which at least one assigned channel was being counted. */
  countedDays: number;
  /** Days with a link on at least one assigned channel. */
  activeDays: number;
  /** Days with NO link on ANY assigned channel. */
  missedDays: number;
  /** Days with links on some, but not all, of the channels being counted that day. */
  partialDays: number;
  /** Sum of the per-channel missed days. */
  missedChannelDays: number;
  activeRate: number | null;
  missedRanges: [string, string][];
  missedRangeCount: number;
  missedRangesTruncated: boolean;
  longestGapDays: number;
  currentGapDays: number;
  currentGapOpenEnded: boolean;
  /** Latest report day (IST) with a link on counted days or today, and the last posting time that day. */
  lastPostedDay: string | null;
  lastPostedAt: string | null;
  lastPostedIST: string | null;
  lastPostedApprox: boolean;
  linkCount: number;
  todayStatus: "posted" | "partial" | "not_yet" | null;
  todayPostedAccounts: number;
  todayLinks: number;
}

export interface SubmissionGapsResult {
  range: {
    startDate: string;
    endDate: string;
    today: string;
    includesToday: boolean;
    /** The last day that can be counted in this window (min(endDate, yesterday)). */
    countedThrough: string;
    exactTimesSince: string;
  };
  rows: GapPairRow[];
  employees: GapEmployeeRow[];
  totals: {
    assignments: number;
    employees: number;
    countedDays: number;
    missedDays: number;
    /** Pairs not yet posted today, or null when the window does not include today. */
    notYetToday: number | null;
    truncated: boolean;
  };
  excluded: {
    /** Current assignments to PAUSED / ARCHIVED channels — nobody is expected to post there. */
    inactiveChannelAssignments: number;
  };
  filters: { teams: GapTeam[]; platforms: { slug: string; name: string }[] };
}

export interface GapDay {
  date: string;
  status: "posted" | "missed" | "today_posted" | "today_pending";
  linkCount: number;
  firstPostedAt: string | null;
  lastPostedAt: string | null;
  firstPostedIST: string | null;
  lastPostedIST: string | null;
  approximate: boolean;
}

export interface SubmissionGapDaysResult {
  employee: { id: string; name: string };
  account: { id: string; handle: string; displayName: string; platform: string; platformName: string; status: string };
  assignedSince: string;
  range: { startDate: string; endDate: string; today: string; includesToday: boolean; exactTimesSince: string };
  /** Newest first, from max(startDate, assignedSince) to min(endDate, today). */
  days: GapDay[];
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

// ─── Summary ─────────────────────────────────────────────────────────────────────

const memo = createSingleFlightMemo({ ttlMs: 60_000, maxEntries: 100 });

/** Tests only (module-level cache — the documented cross-test pollution class). */
export function invalidateSubmissionGapsCache(): void {
  memo.clear();
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
    posted AS MATERIALIZED (
      SELECT dr.employee_id, rl.account_id, dr.date AS day,
             COUNT(*)::int AS n,
             MAX(CASE WHEN dr.date < ${cutover}::date THEN dr.created_at ELSE rl.first_seen_at END) AS last_at
      FROM win w
      JOIN daily_reports dr
        ON dr.employee_id = w.employee_id
       AND dr.date >= w.from_day
       AND dr.date >= ${start}::date
       AND dr.date <= ${postedThrough}::date
      JOIN report_links rl ON rl.report_id = dr.id AND rl.account_id = w.account_id
      WHERE rl.url IS NOT NULL
        AND btrim(rl.url) <> ''
        AND rl.is_scheduled = FALSE
      GROUP BY dr.employee_id, rl.account_id, dr.date
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
    emp_win AS MATERIALIZED (
      SELECT employee_id,
             COUNT(*)::int AS account_count,
             MIN(assigned_day) AS assigned_day,
             MIN(from_day) AS from_day
      FROM win
      GROUP BY employee_id
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
    days: days.map((d) => {
      const isToday = d.day === today;
      return {
        date: d.day,
        status: isToday ? (d.n > 0 ? "today_posted" : "today_pending") : d.n > 0 ? "posted" : "missed",
        linkCount: d.n,
        firstPostedAt: d.first_at,
        lastPostedAt: d.last_at,
        firstPostedIST: d.first_ist,
        lastPostedIST: d.last_ist,
        approximate: d.n > 0 && d.day < EXACT_TIME_SINCE,
      };
    }),
  };
}
