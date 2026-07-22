// xlsx-js-style is a drop-in community fork of SheetJS that ALSO writes cell
// styling (fills, fonts, borders) — the plain `xlsx` community build silently
// drops styles. Same utils API. It ships no types, hence the require + any.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const XLSX = require("xlsx-js-style");
import { prisma } from "@dashmani/db";
import {
  todayIST,
  dateToIST,
  istMidnight,
  istTimeOfDay,
  istDateTime,
  avgIstTimeOfDay,
  formatStatus,
  canonicalKey,
} from "@dashmani/shared";

/**
 * Reports → Spreadsheet export.
 *
 * Produces a single .xlsx workbook with three sheets:
 *   1. "Channel Summary"   — one row per SocialAccount (incl. unassigned /
 *                            zero-activity channels). Per-channel rollups.
 *   2. "Day-wise Breakdown"— one row per individual posted link (the raw ledger).
 *   3. "About"             — window, generated-at, and the data-accuracy caveat.
 *
 * Accuracy rules (see .planning/REPORTS-EXTRACT-SPREADSHEET-PLAN.md):
 *   - All date/time math is IST (never UTC).
 *   - Platform names are lowercase-collapsed for grouping/display so mixed
 *     casing ("Instagram"/"instagram") never double-counts.
 *   - "Submit time" comes from ReportLink.firstSeenAt, which is preserved
 *     per-URL across resubmits. Rows whose report date predates the feature
 *     deploy carry a createdAt approximation — flagged in the breakdown sheet.
 *   - Numbers are derived from the same report_links rows the on-screen Reports
 *     pages read, so the export reconciles with the UI.
 */

// Links first submitted on/after this IST date have a TRUE firstSeenAt.
// Earlier rows were backfilled to createdAt (last-edit time) — see the
// backfill script. Used only to flag "Approx?" in the breakdown sheet.
const TRUE_TIME_SINCE = "2026-06-03";

// ---------- types ----------

export interface ExportLink {
  url: string | null;
  platformName: string; // normalized display name (e.g. "Instagram")
  firstSeenAt: Date;
  reportDateKey: string; // YYYY-MM-DD IST
  reportSubmittedAt: Date;
  accountId: string | null;
  employeeId: string;
  employeeName: string;
  likes: number | null;
  comments: number | null;
  views: number | null;
  // channel denorm for the breakdown sheet
  channelName: string;
  channelHandle: string;
}

export interface ExportAccount {
  id: string;
  displayName: string;
  handle: string;
  platformName: string;
  status: string; // AccountStatus
  followerCount: number;
  clientName: string | null;
  assignedEmployees: { id: string; name: string; phone: string | null; email: string }[];
}

export interface ExportInput {
  accounts: ExportAccount[];
  windowLinks: ExportLink[];
  todayLinks: ExportLink[]; // literal current IST day, computed independently of window
  startKey: string; // window start YYYY-MM-DD IST
  endKey: string; // window end YYYY-MM-DD IST
  // When set, the Channel Summary + Day-wise Breakdown are scoped to THIS employee
  // only (the Reports page's employee-filter dropdown). The Cross-Employee
  // Duplicates sheet still detects across all employees, then keeps only groups
  // that include this employee. Undefined = team-wide export (unchanged).
  employeeId?: string;
  employeeName?: string; // for the filename when scoped
}

export interface SummaryRow {
  channel: string;
  handle: string;
  platform: string;
  channelStatus: string;
  assignedEmployees: string;
  assignmentState: "Assigned" | "Unassigned";
  contact: string;
  employeesInvolved: string;
  numEmployeesInvolved: number;
  totalLinks: number;
  todaysLinks: number;
  avgLinksPerActiveDay: number;
  avgSubmitTime: string; // HH:MM IST, "" if no links
  distinctReportSubmits: number;
  lastActivity: string; // YYYY-MM-DD HH:MM IST, "" if none
  followers: number;
  client: string;
}

export interface BreakdownRow {
  date: string;
  submitTime: string;
  channel: string;
  handle: string;
  platform: string;
  employee: string;
  url: string;
  likes: number | "";
  comments: number | "";
  views: number | "";
  reportSubmittedAt: string;
  approx: string; // "Yes" | ""
}

// One row per submission of a link that ≥2 DIFFERENT employees posted in the
// window. Rows are grouped (contiguous) by `groupNo`.
export interface DuplicateRow {
  groupNo: number; // 1-based, most-shared group first
  employeesOnLink: number; // distinct employees who posted this same link
  employee: string; // who posted THIS submission
  submitTime: string; // HH:MM IST (firstSeenAt)
  date: string; // YYYY-MM-DD IST (report date)
  channel: string;
  platform: string;
  url: string;
  reportSubmittedAt: string; // YYYY-MM-DD HH:MM IST
}

// ---------- normalization helpers ----------

/** Title-case a platform name from any casing ("instagram" -> "Instagram"). */
function normalizePlatformName(name: string | null | undefined): string {
  const n = (name ?? "").trim();
  if (!n) return "Unknown";
  const lower = n.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

// ---------- pure aggregation (DB-free, unit-tested) ----------

/**
 * Builds the summary + breakdown rows from already-fetched data. Pure: no DB,
 * no clock — `todayLinks` is passed in so "today" is decided by the caller.
 */
export function buildExportRows(input: ExportInput): {
  summary: SummaryRow[];
  breakdown: BreakdownRow[];
  duplicates: DuplicateRow[];
} {
  // Cross-employee duplicates are detected over the FULL team-wide link set —
  // dup detection is inherently cross-employee, so it runs BEFORE any per-employee
  // scoping (scoping to one employee then only keeps groups that include them).
  const duplicates = buildDuplicateRows(input.windowLinks, input.employeeId);

  // Employee scoping: when the Reports page has an employee selected, the Channel
  // Summary + Day-wise Breakdown must contain ONLY that employee's activity. Team
  // view (no employeeId) is byte-for-byte unchanged.
  const scoped = !!input.employeeId;
  const windowLinks = scoped
    ? input.windowLinks.filter((l) => l.employeeId === input.employeeId)
    : input.windowLinks;
  const todayLinks = scoped
    ? input.todayLinks.filter((l) => l.employeeId === input.employeeId)
    : input.todayLinks;
  let accounts = input.accounts;
  if (scoped) {
    // Only channels this employee actually posted to (in the window OR today) —
    // a single-employee sheet listing all ~400 channels at zero is pure noise.
    const touched = new Set<string>();
    for (const l of windowLinks) if (l.accountId) touched.add(l.accountId);
    for (const l of todayLinks) if (l.accountId) touched.add(l.accountId);
    accounts = input.accounts.filter((a) => touched.has(a.id));
  }

  // Index window links by accountId.
  const linksByAccount = new Map<string, ExportLink[]>();
  for (const l of windowLinks) {
    if (!l.accountId) continue;
    const arr = linksByAccount.get(l.accountId) ?? [];
    arr.push(l);
    linksByAccount.set(l.accountId, arr);
  }

  // Count today's links per account (independent of the window).
  const todayCountByAccount = new Map<string, number>();
  for (const l of todayLinks) {
    if (!l.accountId) continue;
    todayCountByAccount.set(l.accountId, (todayCountByAccount.get(l.accountId) ?? 0) + 1);
  }

  // ----- Summary sheet: one row per account (ALL accounts) -----
  const summary: SummaryRow[] = accounts.map((acc) => {
    const links = linksByAccount.get(acc.id) ?? [];
    const totalLinks = links.length;

    // Employees who actually posted to this channel in the window.
    const involvedMap = new Map<string, string>();
    // Distinct (employee,day) reports that touched this channel.
    const reportKeys = new Set<string>();
    // Distinct active IST days with activity (for avg/active-day).
    const activeDays = new Set<string>();
    const firstSeenDates: Date[] = [];
    let lastActivity: Date | null = null;

    for (const l of links) {
      involvedMap.set(l.employeeId, l.employeeName);
      reportKeys.add(`${l.employeeId}|${l.reportDateKey}`);
      activeDays.add(l.reportDateKey);
      firstSeenDates.push(l.firstSeenAt);
      if (!lastActivity || l.firstSeenAt.getTime() > lastActivity.getTime()) {
        lastActivity = l.firstSeenAt;
      }
    }

    const assignedNames = acc.assignedEmployees.map((e) => e.name).join(", ");
    const contact = acc.assignedEmployees
      .map((e) => e.phone || e.email)
      .filter(Boolean)
      .join(", ");

    return {
      channel: acc.displayName,
      handle: acc.handle,
      platform: acc.platformName,
      channelStatus: formatStatus(acc.status),
      assignedEmployees: assignedNames,
      assignmentState: acc.assignedEmployees.length > 0 ? "Assigned" : "Unassigned",
      contact,
      employeesInvolved: Array.from(involvedMap.values()).join(", "),
      numEmployeesInvolved: involvedMap.size,
      totalLinks,
      todaysLinks: todayCountByAccount.get(acc.id) ?? 0,
      // Avg per ACTIVE day: total ÷ number of distinct IST days this channel had
      // activity. 0 when there was no activity (avoids dividing by 0).
      avgLinksPerActiveDay: activeDays.size > 0 ? round1(totalLinks / activeDays.size) : 0,
      // Per-link first-seen time, averaged. Now meaningful because firstSeenAt is
      // preserved per-URL across resubmits.
      avgSubmitTime: avgIstTimeOfDay(firstSeenDates),
      distinctReportSubmits: reportKeys.size,
      lastActivity: lastActivity ? istDateTime(lastActivity) : "",
      followers: acc.followerCount,
      client: acc.clientName ?? "",
    };
  });

  // Sort: most active channels first, then alphabetical. Zero-link & unassigned
  // channels naturally sink to the bottom but are always present.
  summary.sort(
    (a, b) => b.totalLinks - a.totalLinks || a.channel.localeCompare(b.channel),
  );

  // ----- Breakdown sheet: one row per link -----
  const breakdown: BreakdownRow[] = windowLinks
    .map((l) => ({
      date: l.reportDateKey,
      submitTime: istTimeOfDay(l.firstSeenAt),
      channel: l.channelName,
      handle: l.channelHandle,
      platform: l.platformName,
      employee: l.employeeName,
      url: l.url ?? "",
      likes: l.likes ?? ("" as const),
      comments: l.comments ?? ("" as const),
      views: l.views ?? ("" as const),
      reportSubmittedAt: istDateTime(l.reportSubmittedAt),
      // Approx if the report's day predates the true-time cutover.
      approx: l.reportDateKey < TRUE_TIME_SINCE ? "Yes" : "",
    }))
    .sort(
      (a, b) =>
        b.date.localeCompare(a.date) ||
        a.channel.localeCompare(b.channel) ||
        a.submitTime.localeCompare(b.submitTime),
    );

  return { summary, breakdown, duplicates };
}

/**
 * Cross-employee duplicate links: the SAME post (by canonicalKey) submitted by
 * TWO OR MORE DIFFERENT employees within the window. Cross-employee dupes are
 * ALLOWED by the platform (unlike same-employee cross-day dupes, which are
 * dropped at submit time), so this surfaces them for visibility — it is not an
 * error flag.
 *
 * Grouping uses `canonicalKey` — the exact same arbiter the submit-time dedupe
 * uses — so "same link" means what the system means (two IG reels differing only
 * by a `?igsh=` token are one link; opaque FB `/share/` links fall through to
 * their raw URL so distinct shares are never merged). Links with no URL are
 * skipped (nothing to key on).
 *
 * When `employeeId` is set, only groups that INCLUDE that employee are kept — each
 * retained group still lists the OTHER employees who shared the link (name + time),
 * which is the whole point of the sheet.
 *
 * Output: one row per submission, grouped contiguously by link with a 1-based
 * `groupNo` ordered by group size (most-shared first). Within a group, rows are
 * ordered by posting time ascending (first submitter first).
 */
export function buildDuplicateRows(
  allWindowLinks: ExportLink[],
  employeeId?: string,
): DuplicateRow[] {
  const groups = new Map<string, ExportLink[]>();
  for (const l of allWindowLinks) {
    const key = canonicalKey(l.url);
    if (!key) continue; // no/empty URL → cannot dedupe
    const arr = groups.get(key);
    if (arr) arr.push(l);
    else groups.set(key, [l]);
  }

  type Grp = { links: ExportLink[]; empCount: number; earliest: number };
  const qualifying: Grp[] = [];
  for (const links of groups.values()) {
    const emps = new Set<string>();
    for (const l of links) emps.add(l.employeeId);
    if (emps.size < 2) continue; // must be ≥2 DIFFERENT employees
    if (employeeId && !emps.has(employeeId)) continue; // scope to selected employee
    let earliest = Infinity;
    for (const l of links) earliest = Math.min(earliest, l.firstSeenAt.getTime());
    qualifying.push({ links, empCount: emps.size, earliest });
  }

  // Most-shared groups first; then most submissions; then earliest overall (stable).
  qualifying.sort(
    (a, b) =>
      b.empCount - a.empCount || b.links.length - a.links.length || a.earliest - b.earliest,
  );

  const rows: DuplicateRow[] = [];
  let groupNo = 0;
  for (const g of qualifying) {
    groupNo++;
    const ordered = [...g.links].sort(
      (a, b) => a.firstSeenAt.getTime() - b.firstSeenAt.getTime(),
    );
    for (const l of ordered) {
      rows.push({
        groupNo,
        employeesOnLink: g.empCount,
        employee: l.employeeName,
        submitTime: istTimeOfDay(l.firstSeenAt),
        date: l.reportDateKey,
        channel: l.channelName,
        platform: l.platformName,
        url: l.url ?? "",
        reportSubmittedAt: istDateTime(l.reportSubmittedAt),
      });
    }
  }
  return rows;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ---------- DB fetch ----------

/** Resolves the [start, end] IST window; defaults to the last 30 IST days. */
function resolveWindow(startDate?: string, endDate?: string): {
  start: Date;
  end: Date;
  startKey: string;
  endKey: string;
} {
  const endKey = endDate || todayIST();
  let startKey = startDate;
  if (!startKey) {
    // 29 days before end → 30-day inclusive window.
    const endMid = istMidnight(endKey);
    startKey = dateToIST(new Date(endMid.getTime() - 29 * 86400000));
  }
  // Inclusive of the whole end day: end-of-day boundary.
  const start = istMidnight(startKey);
  const end = new Date(istMidnight(endKey).getTime() + 86400000 - 1);
  return { start, end, startKey, endKey };
}

const linkSelect = {
  url: true,
  platform: true,
  firstSeenAt: true,
  likes: true,
  comments: true,
  views: true,
  accountId: true,
  account: {
    select: { displayName: true, handle: true, platform: { select: { name: true } } },
  },
  report: {
    select: {
      date: true,
      submittedAt: true,
      employeeId: true,
      employee: { select: { id: true, name: true } },
    },
  },
} as const;

function mapDbLink(l: any): ExportLink {
  const platformName = normalizePlatformName(l.account?.platform?.name ?? l.platform);
  return {
    url: l.url ?? null,
    platformName,
    firstSeenAt: l.firstSeenAt instanceof Date ? l.firstSeenAt : new Date(l.firstSeenAt),
    reportDateKey: dateToIST(l.report.date instanceof Date ? l.report.date : new Date(l.report.date)),
    reportSubmittedAt:
      l.report.submittedAt instanceof Date ? l.report.submittedAt : new Date(l.report.submittedAt),
    accountId: l.accountId ?? null,
    employeeId: l.report.employeeId,
    employeeName: l.report.employee?.name ?? "",
    likes: l.likes ?? null,
    comments: l.comments ?? null,
    views: l.views ?? null,
    channelName: l.account?.displayName ?? "",
    channelHandle: l.account?.handle ?? "",
  };
}

/**
 * Fetches everything the export needs from the DB for the given window.
 *
 * NOTE ON employeeId: the DB fetch stays TEAM-WIDE even when an employee is
 * selected. Cross-employee duplicate detection inherently needs every employee's
 * links, and this matches the pre-existing export cost exactly (it was always
 * team-wide). The per-employee scoping of the Summary/Breakdown sheets happens in
 * the pure `buildExportRows` (filtered in memory), so nothing here narrows the query.
 */
export async function gatherReportExportData(
  startDate?: string,
  endDate?: string,
  employeeId?: string,
): Promise<ExportInput> {
  const { start, end, startKey, endKey } = resolveWindow(startDate, endDate);

  const [accountsRaw, windowLinksRaw, todayLinksRaw] = await Promise.all([
    prisma.socialAccount.findMany({
      select: {
        id: true,
        displayName: true,
        handle: true,
        status: true,
        followerCount: true,
        clientName: true,
        platform: { select: { name: true } },
        assignments: {
          where: { unassignedAt: null },
          select: {
            employee: {
              select: { id: true, name: true, phone: true, email: true },
            },
          },
        },
      },
    }),
    prisma.reportLink.findMany({
      where: { report: { date: { gte: start, lte: end } } },
      select: linkSelect,
    }),
    // "Today" = literal current IST day, regardless of the selected window.
    prisma.reportLink.findMany({
      where: { report: { date: istMidnight(todayIST()) } },
      select: linkSelect,
    }),
  ]);

  const accounts: ExportAccount[] = accountsRaw.map((a) => ({
    id: a.id,
    displayName: a.displayName,
    handle: a.handle,
    platformName: normalizePlatformName(a.platform?.name),
    status: a.status,
    followerCount: a.followerCount,
    clientName: a.clientName,
    assignedEmployees: a.assignments
      .map((as) => as.employee)
      .filter((e): e is NonNullable<typeof e> => !!e)
      .map((e) => ({ id: e.id, name: e.name, phone: e.phone, email: e.email })),
  }));

  // Resolve the selected employee's name (for the filename) only when scoped.
  let employeeName: string | undefined;
  if (employeeId) {
    const emp = await prisma.user.findUnique({
      where: { id: employeeId },
      select: { name: true },
    });
    employeeName = emp?.name ?? undefined;
  }

  return {
    accounts,
    windowLinks: windowLinksRaw.map(mapDbLink),
    todayLinks: todayLinksRaw.map(mapDbLink),
    startKey,
    endKey,
    employeeId: employeeId || undefined,
    employeeName,
  };
}

// ---------- workbook ----------

const SUMMARY_HEADERS: { key: keyof SummaryRow; label: string }[] = [
  { key: "channel", label: "Channel" },
  { key: "handle", label: "Handle" },
  { key: "platform", label: "Platform" },
  { key: "channelStatus", label: "Channel Status" },
  { key: "assignmentState", label: "Assignment Status" },
  { key: "assignedEmployees", label: "Assigned To" },
  { key: "contact", label: "Contact" },
  { key: "employeesInvolved", label: "Who Posted" },
  { key: "numEmployeesInvolved", label: "No. of People Who Posted" },
  { key: "totalLinks", label: "Total Links" },
  { key: "todaysLinks", label: "Links Today" },
  { key: "avgLinksPerActiveDay", label: "Avg Links per Day" },
  { key: "avgSubmitTime", label: "Avg Posting Time (IST)" },
  { key: "distinctReportSubmits", label: "Report Submissions" },
  { key: "lastActivity", label: "Last Activity (IST)" },
  { key: "followers", label: "Followers" },
];

const BREAKDOWN_HEADERS: { key: keyof BreakdownRow; label: string }[] = [
  { key: "date", label: "Date" },
  { key: "submitTime", label: "Posting Time (IST)" },
  { key: "channel", label: "Channel" },
  { key: "handle", label: "Handle" },
  { key: "platform", label: "Platform" },
  { key: "employee", label: "Posted By" },
  { key: "url", label: "Link URL" },
  { key: "likes", label: "Likes" },
  { key: "comments", label: "Comments" },
  { key: "views", label: "Views" },
  { key: "reportSubmittedAt", label: "Report Submitted At (IST)" },
  { key: "approx", label: "Approx Time?" },
];

const DUPLICATE_HEADERS: { key: keyof DuplicateRow; label: string }[] = [
  { key: "groupNo", label: "Dup Group" },
  { key: "employeesOnLink", label: "Employees Sharing" },
  { key: "employee", label: "Posted By" },
  { key: "submitTime", label: "Posting Time (IST)" },
  { key: "date", label: "Date" },
  { key: "channel", label: "Channel" },
  { key: "platform", label: "Platform" },
  { key: "url", label: "Link URL" },
  { key: "reportSubmittedAt", label: "Report Submitted At (IST)" },
];

// ---------- styling palette ----------
// Dashmani report palette: deep ink header, warm cream banding, emerald accent.
const INK = "1A1A1A";
const CREAM = "FCF8EE"; // banded even rows
const WHITE = "FFFFFF";
const BORDER = "E6DFC9";
const HEADER_TEXT = "FFFFFF";
const UNASSIGNED_FILL = "FBE3D6"; // soft terracotta tint for unassigned channels
const UNASSIGNED_TEXT = "9A3412";

const thin = (color: string) => ({ style: "thin", color: { rgb: color } });
const allBorders = (color = BORDER) => ({
  top: thin(color),
  bottom: thin(color),
  left: thin(color),
  right: thin(color),
});

const headerStyle = {
  font: { bold: true, color: { rgb: HEADER_TEXT }, sz: 11 },
  fill: { patternType: "solid", fgColor: { rgb: INK } },
  alignment: { horizontal: "left", vertical: "center", wrapText: true },
  border: allBorders(INK),
};

function bodyStyle(opts: {
  even: boolean;
  align?: "left" | "center" | "right";
  fill?: string;
  text?: string;
  bold?: boolean;
}) {
  return {
    font: { sz: 10, color: { rgb: opts.text ?? INK }, bold: !!opts.bold },
    fill: { patternType: "solid", fgColor: { rgb: opts.fill ?? (opts.even ? CREAM : WHITE) } },
    alignment: { horizontal: opts.align ?? "left", vertical: "center" },
    border: allBorders(),
  };
}

// Columns that should be right-aligned (numbers) by header label.
const RIGHT_ALIGN = new Set([
  "No. of People Who Posted",
  "Total Links",
  "Links Today",
  "Avg Links per Day",
  "Report Submissions",
  "Followers",
  "Likes",
  "Comments",
  "Views",
  "Employees Sharing",
]);
const CENTER_ALIGN = new Set([
  "Platform",
  "Channel Status",
  "Assignment Status",
  "Posting Time (IST)",
  "Avg Posting Time (IST)",
  "Date",
  "Approx Time?",
  "Dup Group",
]);

/** Sensible per-column widths (in characters) keyed by header label. */
const COL_WIDTH: Record<string, number> = {
  // Channel Summary
  "Channel": 22,
  "Handle": 16,
  "Platform": 12,
  "Channel Status": 14,
  "Assignment Status": 16,
  "Assigned To": 24,
  "Contact": 22,
  "Who Posted": 28,
  "No. of People Who Posted": 12,
  "Total Links": 11,
  "Links Today": 11,
  "Avg Links per Day": 14,
  "Avg Posting Time (IST)": 16,
  "Report Submissions": 14,
  "Last Activity (IST)": 18,
  "Followers": 11,
  // Day-wise Breakdown
  "Date": 12,
  "Posting Time (IST)": 14,
  "Posted By": 20,
  "Link URL": 46,
  "Report Submitted At (IST)": 20,
  "Approx Time?": 12,
  // Cross-Employee Duplicates
  "Dup Group": 10,
  "Employees Sharing": 16,
};

/**
 * Builds a fully-styled worksheet from rows + a header map.
 * `flagUnassigned` (summary only) tints rows whose "Assignment Status" cell
 * reads "Unassigned" so they pop visually.
 */
function styledSheet<T>(
  rows: T[],
  headers: { key: keyof T; label: string }[],
  opts: { flagUnassigned?: boolean; bandKey?: keyof T } = {},
): any {
  const aoa: any[][] = [headers.map((h) => h.label)];
  for (const r of rows) aoa.push(headers.map((h) => r[h.key]));
  const ws = XLSX.utils.aoa_to_sheet(aoa);

  const nCols = headers.length;
  const nRows = rows.length;

  // Header row.
  for (let c = 0; c < nCols; c++) {
    const ref = XLSX.utils.encode_cell({ r: 0, c });
    if (ws[ref]) ws[ref].s = headerStyle;
  }

  // Body rows. With `bandKey`, band by GROUPS — flip the cream/white band each
  // time the key's value changes so grouped rows read as visual blocks; otherwise
  // band every other row.
  let bandParity = 0;
  let prevBandVal: unknown = undefined;
  for (let i = 0; i < nRows; i++) {
    const r = i + 1; // +1 for header
    const row = rows[i] as any;
    let even: boolean;
    if (opts.bandKey) {
      const v = row[opts.bandKey as string];
      if (i > 0 && v !== prevBandVal) bandParity ^= 1;
      prevBandVal = v;
      even = bandParity === 1;
    } else {
      even = i % 2 === 1; // band every other body row
    }
    const isUnassigned =
      opts.flagUnassigned && row.assignmentState === "Unassigned";
    for (let c = 0; c < nCols; c++) {
      const ref = XLSX.utils.encode_cell({ r, c });
      if (!ws[ref]) ws[ref] = { t: "s", v: "" };
      const label = headers[c].label;
      const align = RIGHT_ALIGN.has(label)
        ? "right"
        : CENTER_ALIGN.has(label)
        ? "center"
        : "left";
      ws[ref].s = bodyStyle({
        even,
        align,
        fill: isUnassigned ? UNASSIGNED_FILL : undefined,
        text: isUnassigned && label === "Assignment Status" ? UNASSIGNED_TEXT : undefined,
        bold: isUnassigned && label === "Assignment Status",
      });
    }
  }

  // Column widths so headers no longer truncate.
  ws["!cols"] = headers.map((h) => ({ wch: COL_WIDTH[h.label] ?? 16 }));
  // Slightly taller header row.
  ws["!rows"] = [{ hpt: 22 }];
  // Autofilter across the populated header range — gives sortable/filterable
  // column dropdowns in Excel, Google Sheets and Numbers. (Freeze-pane is not
  // supported by the community writer, so the bold dark header carries the row.)
  if (nRows > 0) {
    ws["!autofilter"] = {
      ref: `A1:${XLSX.utils.encode_cell({ r: nRows, c: nCols - 1 })}`,
    };
  }
  return ws;
}

/**
 * Builds the full .xlsx workbook as a Buffer. Two sheets: a per-channel
 * "Channel Summary" and a one-row-per-link "Day-wise Breakdown". `generatedAt`
 * is accepted (and currently unused) so the signature stays clock-injectable
 * and deterministic for tests.
 */
export function buildReportsWorkbook(
  input: ExportInput,
  _generatedAt: Date,
): Buffer {
  const { summary, breakdown, duplicates } = buildExportRows(input);

  const wb = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(
    wb,
    styledSheet(summary, SUMMARY_HEADERS, { flagUnassigned: true }),
    "Channel Summary",
  );
  XLSX.utils.book_append_sheet(
    wb,
    styledSheet(breakdown, BREAKDOWN_HEADERS),
    "Day-wise Breakdown",
  );
  // Always present (even with zero rows → an empty sheet is itself the answer:
  // "no cross-employee duplicates in this window"). Banded per dup group.
  XLSX.utils.book_append_sheet(
    wb,
    styledSheet(duplicates, DUPLICATE_HEADERS, { bandKey: "groupNo" }),
    "Cross-Employee Duplicates",
  );

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

/** Convenience: fetch + build in one call. Returns the .xlsx Buffer + filename. */
export async function generateReportsExport(
  startDate?: string,
  endDate?: string,
  employeeId?: string,
): Promise<{ buffer: Buffer; filename: string; startKey: string; endKey: string }> {
  const input = await gatherReportExportData(startDate, endDate, employeeId);
  const buffer = buildReportsWorkbook(input, new Date());
  // Slug the employee name into the filename when the export is scoped, so the
  // download is self-identifying (e.g. reports-export-kajal-yadav-2026-06-22_2026-07-22.xlsx).
  const empSlug = input.employeeName
    ? "-" +
      input.employeeName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
    : "";
  const filename = `reports-export${empSlug}-${input.startKey}_${input.endKey}.xlsx`;
  return { buffer, filename, startKey: input.startKey, endKey: input.endKey };
}