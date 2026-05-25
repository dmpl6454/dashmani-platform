import { prisma } from "@dashmani/db";
import { AppError } from "../middleware/error-handler";
import type { ReportLinkInput, DailyReportResponse, AdminReportFilters } from "@dashmani/shared";
import { calcStreaks } from "../utils/streak";

function formatReport(report: any) {
  return {
    id: report.id,
    employeeId: report.employeeId,
    employeeName: report.employee?.name ?? "",
    employee: report.employee ? { id: report.employee.id, name: report.employee.name, email: report.employee.email } : null,
    date: report.date instanceof Date
      ? report.date.toISOString().split("T")[0]
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
  employee: { select: { id: true, name: true, email: true } },
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

const MAX_LINKS_PER_DAY = 500;

export async function submitDailyReport(
  employeeId: string,
  date: string,
  links: ReportLinkInput[],
  notes?: string,
  latitude?: number,
  longitude?: number,
) {
  if (!links || links.length === 0) {
    throw new AppError(400, "VALIDATION_ERROR", "At least one link is required");
  }

  if (links.length > MAX_LINKS_PER_DAY) {
    throw new AppError(400, "VALIDATION_ERROR", `Maximum ${MAX_LINKS_PER_DAY} links per day allowed`);
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
    );
  }

  // Check for duplicate URLs across ALL this employee's previous reports (skip scheduled)
  const liveUrls = links.filter((l) => !l.isScheduled && l.url).map((l) => l.url!.trim());
  const existingLinks = liveUrls.length > 0 ? await prisma.reportLink.findMany({
    where: {
      url: { in: liveUrls },
      report: { employeeId },
    },
    select: { url: true, report: { select: { date: true } } },
  }) : [];

  const reportDate = new Date(date);

  // Filter out links from today's own report (allow re-submission/update for today)
  const trueDuplicates = existingLinks.filter((el) => {
    const elDate = new Date(el.report.date);
    return elDate.toISOString().split("T")[0] !== reportDate.toISOString().split("T")[0];
  });

  if (trueDuplicates.length > 0) {
    const dupUrls = [...new Set(trueDuplicates.map((d) => d.url))];
    throw new AppError(
      400,
      "DUPLICATE_LINKS",
      `These links were already submitted previously: ${dupUrls.slice(0, 5).join(", ")}${dupUrls.length > 5 ? ` and ${dupUrls.length - 5} more` : ""}`,
    );
  }

  // Upsert: find existing report for this employee+date or create new
  const existing = await prisma.dailyReport.findUnique({
    where: { employeeId_date: { employeeId, date: reportDate } },
  });

  let report;

  if (existing) {
    // Delete old links and recreate
    await prisma.reportLink.deleteMany({ where: { reportId: existing.id } });

    report = await prisma.dailyReport.update({
      where: { id: existing.id },
      data: {
        notes,
        latitude,
        longitude,
        submittedAt: new Date(),
        links: {
          create: links.map((l) => ({
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
          })),
        },
      },
      include: reportInclude,
    });
  } else {
    report = await prisma.dailyReport.create({
      data: {
        employeeId,
        date: reportDate,
        notes,
        latitude,
        longitude,
        links: {
          create: links.map((l) => ({
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
          })),
        },
      },
      include: reportInclude,
    });
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
  // Use YYYY-MM-DD string to construct a UTC midnight date — same approach as submitDailyReport
  const todayStr = new Date().toISOString().split("T")[0];
  const today = new Date(todayStr);

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
  const todayStr = new Date().toISOString().split("T")[0];
  const todayDate = new Date(todayStr);

  const [reports, todayReports] = await Promise.all([
    prisma.dailyReport.findMany({
      where,
      include: {
        employee: { select: { id: true, name: true, email: true } },
        links: true,
      },
      orderBy: { date: "asc" },
    }),
    prisma.dailyReport.findMany({
      where: { date: todayDate },
      select: { employeeId: true, _count: { select: { links: true } } },
    }),
  ]);

  // Build a map of employeeId → today's link count
  const todayLinksMap = new Map<string, number>();
  for (const r of todayReports) {
    todayLinksMap.set(r.employeeId, r._count.links);
  }

  // Group by employee
  const summaryMap = new Map<string, {
    id: string; name: string; email: string;
    reportCount: number; totalLinks: number;
    reportDates: Date[]; lastSubmittedAt: Date | null;
  }>();

  let totalReports = 0;
  let totalLinks = 0;

  for (const report of reports) {
    const key = report.employeeId;
    if (!summaryMap.has(key)) {
      summaryMap.set(key, {
        id: report.employeeId,
        name: report.employee.name,
        email: (report.employee as any).email ?? "",
        reportCount: 0,
        totalLinks: 0,
        reportDates: [],
        lastSubmittedAt: null,
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
  }

  const employees = Array.from(summaryMap.values()).map(({ reportDates, ...rest }) => {
    const { currentStreak } = calcStreaks(reportDates);
    const avgLinksPerDay = rest.reportCount > 0
      ? Math.round((rest.totalLinks / rest.reportCount) * 10) / 10
      : 0;
    return {
      ...rest,
      avgLinksPerDay,
      currentStreak,
      linksToday: todayLinksMap.get(rest.id) ?? 0,
      lastSubmittedAt: rest.lastSubmittedAt?.toISOString() ?? null,
    };
  });

  return {
    employeesReporting: summaryMap.size,
    totalReports,
    totalLinks,
    employees,
  };
}
