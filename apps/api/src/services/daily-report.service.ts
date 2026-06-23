import { prisma } from "@dashmani/db";
import { AppError } from "../middleware/error-handler";
import type { ReportLinkInput, DailyReportResponse, AdminReportFilters } from "@dashmani/shared";
import { todayIST, istMidnight, dateToIST, canonicalKey } from "@dashmani/shared";
import { calcStreaks } from "../utils/streak";
import { resolveFacebookShareUrl } from "./social-insights/facebook.provider";

// ── Submit-time opaque-Facebook resolution (injectable for tests) ─────────────
//
// ~84% of our Facebook links are opaque `facebook.com/share/r/<code>` redirects
// that carry a share TOKEN, not a post id — the Graph API can't query them, so
// they're unsearchable forever once stored. The durable fix is PREVENTION: at
// submit time (when the link is fresh + cheap) we do ONE best-effort HEAD redirect
// to recover the clean numeric `/reel/<n>` URL and store THAT instead, so future
// FB links come in queryable. This stops FB coverage from bleeding going forward;
// the unrecoverable historical tail (pfbid redirects) is unchanged and the UI is
// honest about it.
//
// LOAD-BEARING SAFETY (the HR submit is the org's most-used path):
//   • ADDITIVE — only REPLACES an opaque url with a clean one; never drops,
//     reorders, or merges links. Dedupe runs on the cleaned set afterward.
//   • FAIL-OPEN — the whole pass is wrapped so any throw/timeout keeps the
//     ORIGINAL urls; resolution can never block, slow past a guard, or fail a
//     submit.
//   • OUTSIDE the $transaction — the network probe runs before any DB tx opens,
//     so a slow redirect never holds a transaction open.
//   • DARK-SAFE — with no META token / no network, resolveFacebookShareUrl
//     returns null and every url is left untouched.
const SHARE_URL_RE = /facebook\.com\/share\//i;
const MAX_OPAQUE_RESOLVES_PER_SUBMIT = 50; // a huge paste never stalls submit
const OPAQUE_RESOLVE_BUDGET_MS = 8_000; // overall wall-clock guard for the pass

// Injectable so unit tests can force fail-open / success without the network.
// Defaults to the real fail-open resolver (real fetch).
let resolveShareUrlImpl: typeof resolveFacebookShareUrl = resolveFacebookShareUrl;
export function __setShareResolverForTesting(fn: typeof resolveFacebookShareUrl | null): void {
  resolveShareUrlImpl = fn ?? resolveFacebookShareUrl;
}

// Best-effort, fail-open, additive replacement of opaque /share/ FB urls with
// their clean redirect target. Mutates url strings in place on a SHALLOW COPY of
// the input rows (callers pass the live links array); returns the same array so
// the caller can reassign. NEVER throws.
async function resolveOpaqueShareLinks(links: ReportLinkInput[]): Promise<ReportLinkInput[]> {
  try {
    // Index only the de-dupable opaque /share/ links; cap how many we resolve.
    const targets: Array<{ idx: number; url: string }> = [];
    for (let i = 0; i < links.length; i++) {
      const l = links[i];
      if (l.isScheduled || !l.url || !l.url.trim()) continue;
      if (SHARE_URL_RE.test(l.url) && targets.length < MAX_OPAQUE_RESOLVES_PER_SUBMIT) {
        targets.push({ idx: i, url: l.url.trim() });
      }
    }
    if (targets.length === 0) return links;

    // Overall wall-clock guard: if the batch outruns the budget, take whatever
    // resolved and keep originals for the rest.
    const deadline = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), OPAQUE_RESOLVE_BUDGET_MS),
    );
    const work = Promise.allSettled(
      targets.map((t) => resolveShareUrlImpl(t.url).then((clean) => ({ idx: t.idx, clean }))),
    );
    const outcome = await Promise.race([work, deadline]);
    if (outcome === "timeout") return links; // budget blown → keep all originals

    for (const settled of outcome) {
      if (settled.status === "fulfilled" && settled.value.clean) {
        // REPLACE only — never drop. The cleaned url dedupes better downstream.
        links[settled.value.idx] = { ...links[settled.value.idx], url: settled.value.clean };
      }
    }
    return links;
  } catch {
    // Belt-and-suspenders: any unexpected throw → original links, submit proceeds.
    return links;
  }
}

function formatReport(report: any) {
  return {
    id: report.id,
    employeeId: report.employeeId,
    employeeName: report.employee?.name ?? "",
    employee: report.employee ? { id: report.employee.id, name: report.employee.name, email: report.employee.email, profileImageUrl: report.employee.profileImageUrl ?? null } : null,
    date: report.date instanceof Date
      ? dateToIST(report.date)
      : String(report.date),
    notes: report.notes,
    latitude: report.latitude,
    longitude: report.longitude,
    submittedFrom: report.submittedFrom,
    submittedAt: report.submittedAt instanceof Date
      ? report.submittedAt.toISOString()
      : String(report.submittedAt),
    links: (report.links ?? []).map((link: any) => ({
      id: link.id,
      accountId: link.accountId,
      accountName: link.account?.displayName ?? "",
      accountHandle: link.account?.handle ?? "",
      platform: link.account?.platform?.name ?? link.platform ?? "",
      platformSlug: link.account?.platform?.slug ?? "",
      url: link.url,
      description: link.description,
      mediaUrl: link.mediaUrl,
      likes: link.likes,
      comments: link.comments,
      shares: link.shares,
      views: link.views,
      isScheduled: link.isScheduled ?? false,
      scheduledFor: link.scheduledFor instanceof Date ? link.scheduledFor.toISOString() : link.scheduledFor ?? null,
    })),
  };
}

const reportInclude = {
  employee: { select: { id: true, name: true, email: true, profileImageUrl: true } },
  links: {
    include: {
      account: {
        include: { platform: true },
      },
    },
  },
};

export async function getAssignedAccounts(employeeId: string) {
  const assignments = await prisma.accountAssignment.findMany({
    where: { employeeId, unassignedAt: null },
    include: {
      account: {
        include: { platform: true },
      },
    },
  });

  return assignments.map((a) => ({
    id: a.account.id,
    handle: a.account.handle,
    displayName: a.account.displayName,
    platform: a.account.platform.name,
    platformSlug: a.account.platform.slug,
    profileUrl: a.account.profileUrl,
    followerCount: a.account.followerCount,
    clientName: a.account.clientName,
  }));
}

export async function submitDailyReport(
  employeeId: string,
  date: string,
  linksInput: ReportLinkInput[],
  notes?: string,
  latitude?: number,
  longitude?: number,
) {
  let links = linksInput;
  if (!links || links.length === 0) {
    throw new AppError(400, "VALIDATION_ERROR", "At least one link is required");
  }

  // Submit-time opaque-Facebook resolution. Runs FIRST (before dedupe + outside
  // any DB transaction) so the cleaned urls flow through canonicalKey dedupe and
  // a network probe never holds a tx open. Fail-open + additive — see the helper's
  // header. This is intentionally awaited but cannot block submit beyond its own
  // wall-clock budget, and is a no-op for any submission with no /share/ links
  // (the overwhelmingly common case, e.g. all-Instagram or all-YouTube reports).
  links = await resolveOpaqueShareLinks(links);

  // Count of de-dupable rows (scheduled / no-URL rows are never merged, so they
  // never count toward a "skipped duplicate"). We snapshot this count before each
  // dedupe pass so we can report HOW MANY links were silently dropped and WHY.
  // This is purely observational — it changes no filter behaviour. The counts are
  // returned to the client so the submit screen can honestly explain a lower saved
  // count (e.g. "84 links saved · 2 duplicates skipped"), which is the #1 source of
  // "my links vanished" reports: the dupe-removal toast had already auto-dismissed
  // by the time the user clicked Update and noticed the count.
  const liveCount = (rows: ReportLinkInput[]) =>
    rows.filter((l) => !l.isScheduled && l.url && l.url.trim()).length;
  const liveBeforeDedupe = liveCount(links);

  // In-submission de-duplication: silently keep the FIRST occurrence of each
  // canonical key and drop later copies. Previously this threw a 400
  // DUPLICATE_LINKS, but the frontend already merges dupes silently, so a hard
  // reject only ever surfaced as a confusing blocked submit when the two
  // disagreed. Keep-first-merge mirrors the client and guarantees the submission
  // always goes through (defense-in-depth, never a blocker).
  // canonicalKey collapses tracking-token variants of the same post (e.g. the
  // same Instagram reel copied twice with different ?igsh= tokens).
  {
    const seenKeys = new Set<string>();
    links = links.filter((l) => {
      if (l.isScheduled || !l.url || !l.url.trim()) return true; // scheduled/no-url rows are never dup-merged
      const key = canonicalKey(l.url);
      if (seenKeys.has(key)) return false;
      seenKeys.add(key);
      return true;
    });
  }
  const liveAfterInSubmission = liveCount(links);

  // Silently drop links already submitted on a previous day for this employee.
  // The frontend auto-dedupe does this too, but may miss links pasted after the
  // initial dedupe pass runs. Server is the safety net — drop rather than hard-block
  // so the employee's submission always goes through.
  const reportDate = new Date(date);

  // We compare by canonicalKey, NOT by raw URL. The old code fetched prior rows
  // with `url: { in: liveUrls }` (exact string match) — but Instagram regenerates
  // the ?igsh= token on every copy, so a re-copied reel never matched yesterday's
  // stored URL and the cross-day net was a no-op for Instagram. An exact-match
  // fetch therefore CAN'T find the rows we need to compare. Instead we pull the
  // employee's recent live links over a bounded window and compare canonical keys
  // in memory. The window (90 days) matches the frontend my-link-urls horizon.
  const CROSS_DAY_WINDOW_DAYS = 90;
  const windowStart = new Date(reportDate.getTime() - CROSS_DAY_WINDOW_DAYS * 86400000);
  const priorRows = await prisma.reportLink.findMany({
    where: {
      url: { not: null },
      isScheduled: false,
      report: {
        employeeId,
        // Bound the scan; include reportDate itself so the IST-day filter below
        // can correctly EXCLUDE today's own links (a link on today's report must
        // never be treated as a cross-day duplicate of itself on resubmit).
        date: { gte: windowStart, lte: reportDate },
      },
    },
    select: { url: true, report: { select: { date: true } } },
  });

  // A canonical key is a cross-day duplicate only if it appears on a DIFFERENT
  // IST day. Comparing IST day strings (not raw Dates) makes the midnight
  // rollover correct.
  const reportDayIST = dateToIST(reportDate);
  const crossDayDupKeys = new Set(
    priorRows
      .filter((el) => dateToIST(new Date(el.report.date)) !== reportDayIST)
      .map((el) => canonicalKey(el.url))
      .filter((k) => !!k)
  );

  if (crossDayDupKeys.size > 0) {
    // Drop silently — same behaviour as the frontend auto-dedupe
    links = links.filter((l) => {
      if (!l.url || l.isScheduled) return true;
      return !crossDayDupKeys.has(canonicalKey(l.url));
    });
  }
  const liveAfterCrossDay = liveCount(links);

  // How many de-dupable links were silently dropped, split by reason. Used only
  // for the at-submit summary; never affects what is stored.
  const dedupe = {
    inSubmission: liveBeforeDedupe - liveAfterInSubmission,
    crossDay: liveAfterInSubmission - liveAfterCrossDay,
    total: liveBeforeDedupe - liveAfterCrossDay,
  };

  // After dropping cross-day dupes, re-check we still have at least one link
  if (links.filter((l) => l.isScheduled || l.url?.trim()).length === 0) {
    throw new AppError(400, "VALIDATION_ERROR", "At least one link is required");
  }

  // Upsert: find existing report for this employee+date or create new
  const existing = await prisma.dailyReport.findUnique({
    where: { employeeId_date: { employeeId, date: reportDate } },
  });

  let report;

  // firstSeenAt must survive the delete-and-recreate resubmit. Before wiping the
  // old link rows, capture each existing URL's original firstSeenAt so we can
  // carry it forward — a link that was first submitted at 10am keeps its 10am
  // time even when the report is edited (and new links added) later that day.
  // Keyed on canonicalKey to match how dedupe normalizes URLs (so a re-copied
  // reel with a fresh ?igsh= token still maps to its original firstSeenAt).
  // On key collision keep the EARLIEST timestamp — the true first-seen time.
  const priorFirstSeen = new Map<string, Date>();
  if (existing) {
    const prevLinks = await prisma.reportLink.findMany({
      where: { reportId: existing.id },
      select: { url: true, firstSeenAt: true },
    });
    for (const pl of prevLinks) {
      if (!pl.url) continue;
      const key = canonicalKey(pl.url);
      const prev = priorFirstSeen.get(key);
      if (!prev || pl.firstSeenAt < prev) priorFirstSeen.set(key, pl.firstSeenAt);
    }
  }

  const linkRows = (id: string, now: Date) =>
    links.map((l) => {
      const key = l.url ? canonicalKey(l.url) : null;
      // Reuse the original firstSeenAt for a URL already present in this report;
      // brand-new URLs (and scheduled/no-URL rows) get the current submit time.
      const firstSeenAt = (key && priorFirstSeen.get(key)) || now;
      return {
        reportId: id,
        accountId: l.accountId,
        url: l.url ? l.url.trim() : null,
        platform: l.platform,
        description: l.description,
        mediaUrl: l.mediaUrl,
        likes: l.likes,
        comments: l.comments,
        shares: l.shares,
        views: l.views,
        isScheduled: l.isScheduled ?? false,
        scheduledFor: l.scheduledFor ? new Date(l.scheduledFor) : null,
        firstSeenAt,
      };
    });

  if (existing) {
    // Single submit moment shared by the report row and all newly-inserted links.
    const submittedAt = new Date();
    // Atomic: delete old links + update report + bulk-insert new links in one transaction
    await prisma.$transaction([
      prisma.reportLink.deleteMany({ where: { reportId: existing.id } }),
      prisma.dailyReport.update({
        where: { id: existing.id },
        data: { notes, latitude, longitude, submittedAt },
      }),
      prisma.reportLink.createMany({
        data: linkRows(existing.id, submittedAt),
      }),
    ]);

    // createMany does not return rows — re-fetch with the include for the response.
    report = await prisma.dailyReport.findUnique({
      where: { id: existing.id },
      include: reportInclude,
    });
  } else {
    // Wrap create + createMany in a transaction so a mid-write crash never
    // leaves an empty DailyReport row with no links.
    const now = new Date();
    const createdId = await prisma.$transaction(async (tx) => {
      const created = await tx.dailyReport.create({
        data: { employeeId, date: reportDate, notes, latitude, longitude },
      });
      await tx.reportLink.createMany({ data: linkRows(created.id, now) });
      return created.id;
    });
    report = await prisma.dailyReport.findUnique({
      where: { id: createdId },
      include: reportInclude,
    });
  }

  if (!report) {
    throw new AppError(500, "INTERNAL_ERROR", "Report could not be loaded after save");
  }

  // `dedupe` rides along as an additive sibling field on the submit response only.
  // formatReport (used by every READ path + admin endpoints) is untouched, so no
  // other consumer sees a shape change.
  return { ...formatReport(report), dedupe };
}

export async function getMyReports(employeeId: string, startDate?: string, endDate?: string) {
  const where: any = { employeeId };

  if (startDate || endDate) {
    where.date = {};
    if (startDate) where.date.gte = new Date(startDate);
    if (endDate) where.date.lte = new Date(endDate);
  }

  const reports = await prisma.dailyReport.findMany({
    where,
    include: reportInclude,
    orderBy: { date: "desc" },
    take: 30,
  });

  return reports.map(formatReport);
}

export async function getTodayReport(employeeId: string) {
  const today = istMidnight(todayIST());

  const report = await prisma.dailyReport.findUnique({
    where: { employeeId_date: { employeeId, date: today } },
    include: reportInclude,
  });

  return report ? formatReport(report) : null;
}

export async function getReportById(reportId: string) {
  const report = await prisma.dailyReport.findUnique({
    where: { id: reportId },
    include: reportInclude,
  });

  if (!report) {
    throw new AppError(404, "NOT_FOUND", "Report not found");
  }

  return formatReport(report);
}

export async function getAllReports(filters: AdminReportFilters) {
  const where: any = {};

  if (filters.employeeId) where.employeeId = filters.employeeId;

  if (filters.startDate || filters.endDate) {
    where.date = {};
    if (filters.startDate) where.date.gte = new Date(filters.startDate);
    if (filters.endDate) where.date.lte = new Date(filters.endDate);
  }

  if (filters.accountId) {
    where.links = { some: { accountId: filters.accountId } };
  }

  const reports = await prisma.dailyReport.findMany({
    where,
    include: reportInclude,
    orderBy: { date: "desc" },
  });

  return reports.map(formatReport);
}

export async function getReportSummary(startDate?: string, endDate?: string) {
  const where: any = {};

  if (startDate || endDate) {
    where.date = {};
    if (startDate) where.date.gte = new Date(startDate);
    if (endDate) where.date.lte = new Date(endDate);
  }

  // Always fetch today's link counts independently of date range filter
  const todayDate = istMidnight(todayIST());

  const [reports, todayReports] = await Promise.all([
    prisma.dailyReport.findMany({
      where,
      include: {
        employee: { select: { id: true, name: true, email: true, profileImageUrl: true } },
        links: { select: { platform: true } },
      },
      orderBy: { date: "asc" },
    }),
    prisma.dailyReport.findMany({
      where: { date: todayDate },
      select: {
        employeeId: true,
        employee: { select: { id: true, name: true, email: true, profileImageUrl: true } },
        links: { select: { platform: true } },
      },
    }),
  ]);

  // Build maps of employeeId → today's link count and platform breakdown.
  // Today's data is fetched independently of the date-range filter so the
  // "Today" column stays real-time regardless of the selected window.
  const todayLinksMap = new Map<string, number>();
  const todayPlatformMap = new Map<string, Record<string, number>>();
  const todayEmployeeMap = new Map<string, { id: string; name: string; email: string; profileImageUrl: string | null }>();
  for (const r of todayReports) {
    todayLinksMap.set(r.employeeId, r.links.length);
    todayEmployeeMap.set(r.employeeId, {
      id: r.employeeId,
      name: r.employee.name,
      email: (r.employee as any).email ?? "",
      profileImageUrl: (r.employee as any).profileImageUrl ?? null,
    });
    const pMap: Record<string, number> = {};
    for (const link of r.links) {
      const p = ((link as any).platform || "unknown").toLowerCase();
      pMap[p] = (pMap[p] || 0) + 1;
    }
    todayPlatformMap.set(r.employeeId, pMap);
  }

  // Group by employee
  const summaryMap = new Map<string, {
    id: string; name: string; email: string; profileImageUrl: string | null;
    reportCount: number; totalLinks: number;
    reportDates: Date[]; lastSubmittedAt: Date | null;
    empPlatformMap: Record<string, number>;
    // empPlatformDailyMap[platform][dateStr] = count — powers the per-employee daily drill-down
    empPlatformDailyMap: Record<string, Record<string, number>>;
  }>();

  let totalReports = 0;
  let totalLinks = 0;
  const platformMap: Record<string, number> = {};
  // platformDailyMap[platform][dateStr] = count
  const platformDailyMap: Record<string, Record<string, number>> = {};

  for (const report of reports) {
    const key = report.employeeId;
    if (!summaryMap.has(key)) {
      summaryMap.set(key, {
        id: report.employeeId,
        name: report.employee.name,
        email: (report.employee as any).email ?? "",
        profileImageUrl: (report.employee as any).profileImageUrl ?? null,
        reportCount: 0,
        totalLinks: 0,
        reportDates: [],
        lastSubmittedAt: null,
        empPlatformMap: {},
        empPlatformDailyMap: {},
      });
    }
    const entry = summaryMap.get(key)!;
    entry.reportCount += 1;
    entry.totalLinks += report.links.length;
    entry.reportDates.push(report.date);
    if (!entry.lastSubmittedAt || report.date > entry.lastSubmittedAt) {
      entry.lastSubmittedAt = report.date;
    }
    totalReports += 1;
    totalLinks += report.links.length;
    const dateStr = dateToIST(new Date(report.date));
    for (const link of report.links) {
      const p = ((link as any).platform || "Unknown").toLowerCase();
      platformMap[p] = (platformMap[p] || 0) + 1;
      entry.empPlatformMap[p] = (entry.empPlatformMap[p] || 0) + 1;
      if (!platformDailyMap[p]) platformDailyMap[p] = {};
      platformDailyMap[p][dateStr] = (platformDailyMap[p][dateStr] || 0) + 1;
      if (!entry.empPlatformDailyMap[p]) entry.empPlatformDailyMap[p] = {};
      entry.empPlatformDailyMap[p][dateStr] = (entry.empPlatformDailyMap[p][dateStr] || 0) + 1;
    }
  }

  // Ensure anyone who submitted TODAY appears in the table even if today falls
  // outside the selected window — their windowed stats stay 0 but the Today
  // column shows their live count. Keeps the Today column truly filter-independent.
  for (const [empId, emp] of todayEmployeeMap) {
    if (!summaryMap.has(empId)) {
      summaryMap.set(empId, {
        id: empId,
        name: emp.name,
        email: emp.email,
        profileImageUrl: emp.profileImageUrl,
        reportCount: 0,
        totalLinks: 0,
        reportDates: [],
        lastSubmittedAt: null,
        empPlatformMap: {},
        empPlatformDailyMap: {},
      });
    }
  }

  const employees = Array.from(summaryMap.values()).map(({ reportDates, empPlatformMap, empPlatformDailyMap, ...rest }) => {
    const { currentStreak } = calcStreaks(reportDates);
    const avgLinksPerDay = rest.reportCount > 0
      ? Math.round((rest.totalLinks / rest.reportCount) * 10) / 10
      : 0;
    const platformBreakdown = Object.entries(empPlatformMap)
      .sort(([, a], [, b]) => b - a)
      .map(([platform, count]) => ({
        platform,
        count,
        dailyBreakdown: Object.entries(empPlatformDailyMap[platform] || {})
          .sort(([a], [b]) => b.localeCompare(a))
          .map(([date, count]) => ({ date, count })),
      }));
    const todayPlatformBreakdown = Object.entries(todayPlatformMap.get(rest.id) ?? {})
      .sort(([, a], [, b]) => b - a)
      .map(([platform, count]) => ({ platform, count }));
    return {
      ...rest,
      avgLinksPerDay,
      currentStreak,
      linksToday: todayLinksMap.get(rest.id) ?? 0,
      todayPlatformBreakdown,
      lastSubmittedAt: rest.lastSubmittedAt?.toISOString() ?? null,
      platformBreakdown,
    };
  });

  const platformBreakdown = Object.entries(platformMap)
    .sort(([, a], [, b]) => b - a)
    .map(([platform, count]) => ({
      platform,
      count,
      dailyBreakdown: Object.entries(platformDailyMap[platform] || {})
        .sort(([a], [b]) => b.localeCompare(a))
        .map(([date, count]) => ({ date, count })),
    }));

  return {
    // Count only employees who actually reported within the window (today-only
    // merges have reportCount 0 and must not inflate this stat).
    employeesReporting: employees.filter((e) => e.reportCount > 0).length,
    totalReports,
    totalLinks,
    platformBreakdown,
    employees,
  };
}
