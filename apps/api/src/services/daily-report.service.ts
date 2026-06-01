import { prisma } from "@dashmani/db";
import { AppError } from "../middleware/error-handler";
import type { ReportLinkInput, DailyReportResponse, AdminReportFilters } from "@dashmani/shared";
import { todayIST, istMidnight, dateToIST } from "@dashmani/shared";
import { calcStreaks } from "../utils/streak";

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

  // Check for duplicate URLs within the submission (skip scheduled posts with no URL)
  const urlSet = new Set<string>();
  const duplicatesInSubmission: string[] = [];
  for (const link of links) {
    if (!link.url || link.isScheduled) continue;
    const normalizedUrl = link.url.trim().toLowerCase();
    if (urlSet.has(normalizedUrl)) {
      duplicatesInSubmission.push(link.url);
    }
    urlSet.add(normalizedUrl);
  }

  if (duplicatesInSubmission.length > 0) {
    throw new AppError(
      400,
      "DUPLICATE_LINKS",
      `Duplicate links found in submission: ${duplicatesInSubmission.slice(0, 5).join(", ")}${duplicatesInSubmission.length > 5 ? ` and ${duplicatesInSubmission.length - 5} more` : ""}`,
      duplicatesInSubmission.map((url) => ({ field: "links.url", message: url })),
    );
  }

  // Silently drop links already submitted on a previous day for this employee.
  // The frontend auto-dedupe does this too, but may miss links pasted after the
  // initial dedupe pass runs. Server is the safety net — drop rather than hard-block
  // so the employee's submission always goes through.
  const reportDate = new Date(date);
  const liveUrls = links.filter((l) => !l.isScheduled && l.url).map((l) => l.url!.trim());

  // Look up prior submissions of these URLs in CHUNKS so an unbounded link count
  // never blows past Postgres's bind-parameter limit (each URL is one param).
  const CHUNK = 1000;
  const existingLinks: { url: string | null; report: { date: Date } }[] = [];
  for (let i = 0; i < liveUrls.length; i += CHUNK) {
    const slice = liveUrls.slice(i, i + CHUNK);
    const rows = await prisma.reportLink.findMany({
      where: {
        url: { in: slice },
        report: { employeeId },
      },
      select: { url: true, report: { select: { date: true } } },
    });
    existingLinks.push(...rows);
  }

  // A URL is a cross-day duplicate only if it exists on a DIFFERENT IST day.
  // Comparing IST day strings (not raw Dates) is what makes the midnight rollover correct.
  const crossDayDupUrls = new Set(
    existingLinks
      .filter((el) => dateToIST(new Date(el.report.date)) !== dateToIST(reportDate))
      .map((el) => el.url?.trim().toLowerCase())
      .filter((u): u is string => !!u)
  );

  if (crossDayDupUrls.size > 0) {
    // Drop silently — same behaviour as the frontend auto-dedupe
    links = links.filter((l) => {
      if (!l.url || l.isScheduled) return true;
      return !crossDayDupUrls.has(l.url.trim().toLowerCase());
    });
  }

  // After dropping cross-day dupes, re-check we still have at least one link
  if (links.filter((l) => l.isScheduled || l.url?.trim()).length === 0) {
    throw new AppError(400, "VALIDATION_ERROR", "At least one link is required");
  }

  // Upsert: find existing report for this employee+date or create new
  const existing = await prisma.dailyReport.findUnique({
    where: { employeeId_date: { employeeId, date: reportDate } },
  });

  let report;

  const linkRows = (id: string) =>
    links.map((l) => ({
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
    }));

  if (existing) {
    // Atomic: delete old links + update report + bulk-insert new links in one transaction
    await prisma.$transaction([
      prisma.reportLink.deleteMany({ where: { reportId: existing.id } }),
      prisma.dailyReport.update({
        where: { id: existing.id },
        data: { notes, latitude, longitude, submittedAt: new Date() },
      }),
      prisma.reportLink.createMany({
        data: linkRows(existing.id),
      }),
    ]);

    // createMany does not return rows — re-fetch with the include for the response.
    report = await prisma.dailyReport.findUnique({
      where: { id: existing.id },
      include: reportInclude,
    });
  } else {
    const created = await prisma.dailyReport.create({
      data: { employeeId, date: reportDate, notes, latitude, longitude },
    });
    await prisma.reportLink.createMany({
      data: linkRows(created.id),
    });
    report = await prisma.dailyReport.findUnique({
      where: { id: created.id },
      include: reportInclude,
    });
  }

  if (!report) {
    throw new AppError(500, "INTERNAL_ERROR", "Report could not be loaded after save");
  }

  return formatReport(report);
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
