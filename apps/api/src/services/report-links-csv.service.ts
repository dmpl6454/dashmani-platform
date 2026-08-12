// Reports → All-Links CSV export (STREAMED).
//
// Why a separate CSV, not a sheet in the .xlsx: a 108k+ row styled .xlsx needs
// ~1.5GB to build in memory and blows the 500MB pm2 RSS cap on the prod box
// (the 2026-07-22 export OOM). A CSV of the same links needs ~180MB built all at
// once, and — as done here — is STREAMED in keyset-paginated batches straight to
// the HTTP response, so peak memory is O(batch) regardless of total row count.
// This scales to any window ("Year"/all-time) and any employee, and never holds
// a single DB connection for a giant fetch (each batch is a fast, bounded query),
// which also avoids the connection-pool contention that broke the old export.
//
// One row per submitted link (the raw ledger the reports pages read from): the
// literal URL with its date + IST posting time + channel + who submitted it +
// engagement. Honors the same window + employee filter as the on-screen page.

import { prisma } from "@dashmani/db";
import { dateToIST, istTimeOfDay, istDateTime, canonicalKey } from "@dashmani/shared";
import { resolveWindow } from "./report-export.service";

export const CSV_HEADERS = [
  "Date",
  "Posting Time (IST)",
  "Channel",
  "Handle",
  "Platform",
  "Submitted By",
  "Link URL",
  "Likes",
  "Comments",
  "Views",
  "Report Submitted At (IST)",
  // How many DIFFERENT employees posted this same link (by canonicalKey) in the
  // window. 1 = only this person. ≥2 = a CROSS-EMPLOYEE duplicate (allowed, but
  // flagged here so every shared link is visible inline on the full ledger). This
  // is team-independent — it counts distinct employees, never team membership.
  "Shared By (employees)",
  // "Yes" when the row predates exact per-link timestamping (before 3 Jun 2026),
  // so its posting time is an approximation. Blank = exact.
  "Time Approx (pre-3 Jun)?",
] as const;

// Links first submitted on/after this IST date have a TRUE per-URL firstSeenAt;
// earlier rows were backfilled to createdAt (last-edit time). Mirrors the reports
// export's honesty flag so the CSV doesn't imply exact times for pre-cutover links.
const TRUE_TIME_SINCE = "2026-06-03";

/**
 * RFC-4180 cell escaping + spreadsheet formula-injection defense.
 * - Quotes when the value contains a comma/quote/newline (doubling inner quotes).
 * - A cell that BEGINS with = + - @ (or a control char) is executed as a formula by
 *   Excel/Sheets; prefix it with a single quote so it renders literally. Our columns
 *   (dates, times, names, handles, http URLs, numbers) never legitimately start with
 *   these, so this only ever fires on crafted input.
 */
export function csvCell(v: unknown): string {
  let s = v == null ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Title-case a platform name from any casing ("instagram" -> "Instagram"). */
function normalizePlatformName(name: string | null | undefined): string {
  const n = (name ?? "").trim();
  if (!n) return "Unknown";
  const lower = n.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

// The DB row shape we select per link (flat-ish; no unbounded hydration).
export interface CsvLinkRow {
  url: string | null;
  platform: string;
  firstSeenAt: Date;
  likes: number | null;
  comments: number | null;
  views: number | null;
  account: { displayName: string; handle: string; platform: { name: string } | null } | null;
  report: { date: Date; submittedAt: Date; employee: { name: string } | null };
}

/**
 * Pure: one DB link row → one CSV line (with trailing CRLF). Unit-tested.
 *
 * `sharedBy` is the number of DISTINCT employees who posted this same link (by
 * canonicalKey) across the window — 1 for a link only this person posted, ≥2 for a
 * cross-employee duplicate. It is computed by a bounded pre-pass (see
 * `buildSharedByMap`) and passed in so this function stays pure & streamable.
 */
export function toCsvLine(r: CsvLinkRow, sharedBy = 1): string {
  const dateKey = dateToIST(r.report.date instanceof Date ? r.report.date : new Date(r.report.date));
  return (
    [
      dateKey,
      istTimeOfDay(r.firstSeenAt instanceof Date ? r.firstSeenAt : new Date(r.firstSeenAt)),
      r.account?.displayName ?? "",
      r.account?.handle ?? "",
      normalizePlatformName(r.account?.platform?.name ?? r.platform),
      r.report.employee?.name ?? "",
      r.url ?? "",
      r.likes ?? "",
      r.comments ?? "",
      r.views ?? "",
      istDateTime(r.report.submittedAt instanceof Date ? r.report.submittedAt : new Date(r.report.submittedAt)),
      sharedBy,
      dateKey < TRUE_TIME_SINCE ? "Yes" : "",
    ]
      .map(csvCell)
      .join(",") + "\r\n"
  );
}

const CSV_BATCH = 5000;

/**
 * Bounded pre-pass: builds `canonicalKey → count of DISTINCT employees who posted
 * it` over the whole window, so the streamed body can flag each row as a
 * cross-employee duplicate WITHOUT holding the full ledger in memory.
 *
 * Memory-safe by construction: it selects only two tiny columns (`url` for
 * canonicalKey + `report.employeeId`), keyset-paginates in the same 5k batches,
 * and keeps only a `Map<string, Set<string>>` (a canonicalKey → employeeId-set).
 * For ~108k links / ~50k keys that's a few MB of short strings — nowhere near the
 * per-cell styled-object blow-up that OOM'd the .xlsx. Uses the SAME
 * `canonicalKey()` arbiter as the xlsx duplicate sheet, so the flag matches it
 * exactly (IG `?igsh=` tokens / FB trailing-slash variants collapse identically).
 *
 * Returns a plain count map (`canonicalKey → distinct-employee count`) so the hot
 * body loop does a single O(1) lookup per row.
 */
export async function buildSharedByMap(where: {
  report: { date: { gte: Date; lte: Date }; employeeId?: string };
}): Promise<Map<string, number>> {
  // NOTE: dup detection is inherently cross-employee, so the pre-pass is ALWAYS
  // team-wide for the window — even when the CSV body is scoped to one employee.
  // A link Anushka shares with Prashant must read "2" on Anushka's scoped export.
  const teamWide = { report: { date: where.report.date } };
  const keyToEmployees = new Map<string, Set<string>>();
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.reportLink.findMany({
      where: teamWide,
      select: { id: true, url: true, report: { select: { employeeId: true } } },
      orderBy: { id: "asc" },
      take: CSV_BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (rows.length === 0) break;
    for (const r of rows) {
      const key = canonicalKey(r.url);
      if (!key) continue;
      let set = keyToEmployees.get(key);
      if (!set) { set = new Set(); keyToEmployees.set(key, set); }
      set.add(r.report.employeeId);
    }
    cursor = rows[rows.length - 1].id;
    if (rows.length < CSV_BATCH) break;
  }
  // Collapse to counts and drop the (larger) Set map so only the small count map
  // is retained while the body streams.
  const counts = new Map<string, number>();
  for (const [k, set] of keyToEmployees) counts.set(k, set.size);
  return counts;
}

const linkCsvSelect = {
  id: true,
  url: true,
  platform: true,
  firstSeenAt: true,
  likes: true,
  comments: true,
  views: true,
  account: { select: { displayName: true, handle: true, platform: { select: { name: true } } } },
  report: { select: { date: true, submittedAt: true, employee: { select: { name: true } } } },
} as const;

/**
 * Streams the CSV to `write` in keyset-paginated batches. Returns the row count.
 * Emits a UTF-8 BOM + header first so Excel opens non-ASCII names/handles correctly.
 * `write` is called synchronously per batch — the caller pipes it to res.write().
 */
export async function streamReportLinksCsv(
  opts: { startDate?: string; endDate?: string; employeeId?: string },
  write: (chunk: string) => void,
): Promise<number> {
  const { start, end } = resolveWindow(opts.startDate, opts.endDate);
  const where = {
    report: {
      date: { gte: start, lte: end },
      ...(opts.employeeId ? { employeeId: opts.employeeId } : {}),
    },
  };

  // Bounded pre-pass BEFORE any bytes are sent: a first-pass failure surfaces as a
  // clean 500 (nothing written yet) rather than a truncated 200. Team-wide over the
  // window so the shared-by count is correct even on an employee-scoped export.
  const sharedByMap = await buildSharedByMap(where);

  let cursor: string | undefined;
  let count = 0;
  let headerWritten = false;
  for (;;) {
    const rows = await prisma.reportLink.findMany({
      where,
      select: linkCsvSelect,
      orderBy: { id: "asc" },
      take: CSV_BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    // Header is written only AFTER the first query succeeds, so a first-batch
    // failure reaches the route with no bytes sent → a clean 500, not an empty 200.
    if (!headerWritten) {
      write("\uFEFF" + CSV_HEADERS.map(csvCell).join(",") + "\r\n");
      headerWritten = true;
    }
    if (rows.length === 0) break;

    let chunk = "";
    for (const r of rows) {
      const key = canonicalKey((r as unknown as CsvLinkRow).url);
      const sharedBy = key ? sharedByMap.get(key) ?? 1 : 1;
      chunk += toCsvLine(r as unknown as CsvLinkRow, sharedBy);
    }
    write(chunk);

    count += rows.length;
    cursor = rows[rows.length - 1].id;
    if (rows.length < CSV_BATCH) break;
  }
  return count;
}

/** Resolves the download filename (slugs the employee name when scoped). */
export async function reportLinksCsvFilename(opts: {
  startDate?: string;
  endDate?: string;
  employeeId?: string;
}): Promise<string> {
  const { startKey, endKey } = resolveWindow(opts.startDate, opts.endDate);
  let empSlug = "";
  if (opts.employeeId) {
    const emp = await prisma.user.findUnique({
      where: { id: opts.employeeId },
      select: { name: true },
    });
    if (emp?.name) {
      empSlug =
        "-" +
        emp.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "");
    }
  }
  return `all-links${empSlug}-${startKey}_${endKey}.csv`;
}
