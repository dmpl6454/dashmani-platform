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
} {
  const { accounts, windowLinks, todayLinks } = input;

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

  return { summary, breakdown };
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

/** Fetches everything the export needs from the DB for the given window. */
export async function gatherReportExportData(
  startDate?: string,
  endDate?: string,
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

  return {
    accounts,
    windowLinks: windowLinksRaw.map(mapDbLink),
    todayLinks: todayLinksRaw.map(mapDbLink),
    startKey,
    endKey,
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
]);
const CENTER_ALIGN = new Set([
  "Platform",
  "Channel Status",
  "Assignment Status",
  "Posting Time (IST)",
  "Avg Posting Time (IST)",
  "Date",
  "Approx Time?",
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
};

/**
 * Builds a fully-styled worksheet from rows + a header map.
 * `flagUnassigned` (summary only) tints rows whose "Assignment Status" cell
 * reads "Unassigned" so they pop visually.
 */
function styledSheet<T>(
  rows: T[],
  headers: { key: keyof T; label: string }[],
  opts: { flagUnassigned?: boolean } = {},
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

  // Body rows.
  for (let i = 0; i < nRows; i++) {
    const r = i + 1; // +1 for header
    const even = i % 2 === 1; // band every other body row
    const row = rows[i] as any;
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
  const { summary, breakdown } = buildExportRows(input);

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

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

/** Convenience: fetch + build in one call. Returns the .xlsx Buffer + filename. */
export async function generateReportsExport(
  startDate?: string,
  endDate?: string,
): Promise<{ buffer: Buffer; filename: string; startKey: string; endKey: string }> {
  const input = await gatherReportExportData(startDate, endDate);
  const buffer = buildReportsWorkbook(input, new Date());
  const filename = `reports-export-${input.startKey}_${input.endKey}.xlsx`;
  return { buffer, filename, startKey: input.startKey, endKey: input.endKey };
}