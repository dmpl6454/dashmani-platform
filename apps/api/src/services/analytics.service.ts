import { prisma } from "@dashmani/db";
import { countTeams } from "./team.service";
import { todayIST, istMidnight, dateToIST } from "@dashmani/shared";

// ===== Date helpers =====
// All "today" computations use IST (UTC+5:30) so they remain correct between
// 12:00 AM and 5:30 AM IST (when UTC has already flipped to the next calendar day).
function startOfMonth(): Date {
  const [y, m] = todayIST().split("-").map(Number);
  return istMidnight(`${y}-${String(m).padStart(2, "0")}-01`);
}

function todayDate(): Date {
  return istMidnight(todayIST());
}

// ===== Overview Stats =====

export const employeeWhere = {
  status: "ACTIVE" as const,
  deletedAt: null,
  roles: { some: { role: { name: { notIn: ["Super Admin", "Admin"] } } } },
};

export async function getOverviewStats(linkStartDate?: string, linkEndDate?: string) {
  const monthStart = startOfMonth();
  const today = todayDate();
  // ISO week starts on Monday; getUTCDay() returns 0=Sun..6=Sat
  const dayOfWeek = today.getUTCDay();
  const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const weekStart = new Date(today.getTime() - daysToMonday * 24 * 60 * 60 * 1000);

  // For links bento: use custom range if provided, otherwise last 14 days
  const rangeStart = linkStartDate ? new Date(linkStartDate) : new Date(today.getTime() - 13 * 24 * 60 * 60 * 1000);
  const rangeEnd = linkEndDate ? new Date(linkEndDate) : today;
  // How many days in range (for trend array)
  const rangeDays = Math.max(1, Math.round((rangeEnd.getTime() - rangeStart.getTime()) / 86400000) + 1);
  // Cap at 60 days for trend display
  const trendDays = Math.min(rangeDays, 60);
  const trendStart = new Date(rangeEnd.getTime() - (trendDays - 1) * 86400000);

  const [
    totalEmployees,
    totalUsersCount,
    activeTeams,
    presentToday,
    tasksCompletedThisMonth,
    activeProjects,
    pendingDocuments,
    pendingProfilePictures,
    pendingLeaveRequests,
    pendingEmployees,
    contentPublishedThisMonth,
    contentScheduledUpcoming,
    linksToday,
    linksThisWeek,
    linksThisMonth,
    linksInRange,
    submittedTodayCount,
    submittedInRangeCount,
    trendReports,
  ] = await Promise.all([
    prisma.user.count({ where: employeeWhere }),
    // Count all non-deleted users (matches what the /employees page shows)
    prisma.user.count({ where: { deletedAt: null } }),
    // Count top-level teams only (matches what the /teams page shows)
    countTeams(),
    prisma.attendance.count({ where: { date: today, status: { in: ["PRESENT", "LATE", "HALF_DAY"] } } }),
    prisma.task.count({ where: { status: "DONE", completedAt: { gte: monthStart } } }),
    prisma.project.count({ where: { status: "ACTIVE" } }),
    // pendingApprovals = sum of the three queues that the /approvals page actually shows.
    // The legacy `Approval` table (project deliverables) is not surfaced on any admin page,
    // so counting it here caused dashboard total != approvals-page total.
    prisma.employeeDocument.count({ where: { status: "PENDING" } }),
    prisma.profilePictureRequest.count({ where: { status: "PENDING" } }),
    prisma.leaveRequest.count({ where: { status: "PENDING" } }),
    prisma.user.count({ where: { status: "ONBOARDING", deletedAt: null } }),
    safeContentCount({ status: "PUBLISHED", publishedAtGte: monthStart }),
    safeContentCount({ status: "SCHEDULED", scheduledAtGte: new Date() }),
    prisma.reportLink.count({ where: { report: { date: today } } }),
    prisma.reportLink.count({ where: { report: { date: { gte: weekStart } } } }),
    prisma.reportLink.count({ where: { report: { date: { gte: monthStart } } } }),
    prisma.reportLink.count({ where: { report: { date: { gte: rangeStart, lte: rangeEnd } } } }),
    prisma.dailyReport.count({ where: { date: today } }),
    prisma.dailyReport.count({ where: { date: { gte: rangeStart, lte: rangeEnd } } }),
    prisma.dailyReport.findMany({
      where: { date: { gte: trendStart, lte: rangeEnd } },
      select: { date: true, _count: { select: { links: true } } },
    }),
  ]);

  // Build trend with zeroes for missing days
  const trendMap: Record<string, number> = {};
  for (const r of trendReports) {
    const d = r.date instanceof Date ? dateToIST(r.date) : String(r.date);
    trendMap[d] = (trendMap[d] || 0) + r._count.links;
  }
  const linksTrend: { date: string; count: number }[] = [];
  for (let i = trendDays - 1; i >= 0; i--) {
    const d = dateToIST(new Date(rangeEnd.getTime() - i * 86400000));
    linksTrend.push({ date: d, count: trendMap[d] || 0 });
  }

  const submissionRateToday = totalEmployees > 0
    ? Math.round((submittedTodayCount / totalEmployees) * 100)
    : 0;

  const isCustomRange = !!(linkStartDate || linkEndDate);
  const pendingApprovals = pendingDocuments + pendingProfilePictures + pendingLeaveRequests;

  return {
    totalEmployees,
    totalUsersCount,
    activeTeams,
    presentToday,
    tasksCompletedThisMonth,
    activeProjects,
    pendingApprovals,
    pendingDocuments,
    pendingProfilePictures,
    pendingLeaveRequests,
    pendingEmployees,
    contentPublishedThisMonth,
    contentScheduledUpcoming,
    linksToday,
    linksThisWeek,
    linksThisMonth,
    linksInRange: isCustomRange ? linksInRange : null,
    submittedTodayCount,
    submittedInRange: isCustomRange ? submittedInRangeCount : null,
    submissionRateToday,
    linksTrend,
    rangeStart: dateToIST(rangeStart),
    rangeEnd: dateToIST(rangeEnd),
    isCustomRange,
  };
}

// ===== Safe ContentPost query (model may not exist if Phase 1D not complete) =====

async function safeContentCount(params: {
  status: string;
  publishedAtGte?: Date;
  scheduledAtGte?: Date;
  projectId?: string;
  accountId?: string;
}): Promise<number> {
  try {
    const where: any = { status: params.status };
    if (params.publishedAtGte) where.publishedAt = { gte: params.publishedAtGte };
    if (params.scheduledAtGte) where.scheduledAt = { gte: params.scheduledAtGte };
    if (params.projectId) where.projectId = params.projectId;
    if (params.accountId) where.accountId = params.accountId;
    return await (prisma as any).contentPost.count({ where });
  } catch {
    return 0;
  }
}

async function safeContentGroupBy(field: string): Promise<any[]> {
  try {
    const result = await (prisma as any).contentPost.groupBy({
      by: [field],
      _count: { _all: true },
    });
    return result.map((r: any) => ({
      [field]: r[field],
      _count: r._count._all,
    }));
  } catch {
    return [];
  }
}

// ===== Task Analytics =====

export async function getTaskAnalytics(params?: { projectId?: string }) {
  const monthStart = startOfMonth();
  const now = new Date();

  const projectFilter = params?.projectId
    ? { projectTasks: { some: { projectId: params.projectId } } }
    : {};

  const [
    totalTasks,
    byStatusRaw,
    byPriorityRaw,
    completedThisMonth,
    overdueCount,
    topAssigneesRaw,
  ] = await Promise.all([
    prisma.task.count({ where: projectFilter }),

    prisma.task.groupBy({
      by: ["status"],
      _count: { _all: true },
      where: projectFilter,
    }),

    prisma.task.groupBy({
      by: ["priority"],
      _count: { _all: true },
      where: projectFilter,
    }),

    prisma.task.count({
      where: {
        ...projectFilter,
        status: "DONE",
        completedAt: { gte: monthStart },
      },
    }),

    prisma.task.count({
      where: {
        ...projectFilter,
        status: { notIn: ["DONE", "CANCELLED"] },
        dueDate: { lt: now },
      },
    }),

    prisma.task.groupBy({
      by: ["assigneeId"],
      _count: { _all: true },
      where: {
        ...projectFilter,
        assigneeId: { not: null },
      },
    }),
  ]);

  // Sort by count desc and take top 10 in JS (Prisma groupBy orderBy _all not supported in all versions)
  const sortedAssigneesRaw = [...topAssigneesRaw]
    .sort((a: any, b: any) => b._count._all - a._count._all)
    .slice(0, 10);

  const assigneeIds = sortedAssigneesRaw
    .map((a: any) => a.assigneeId)
    .filter(Boolean) as string[];

  let assigneeNames: Record<string, string> = {};
  let assigneeDoneCounts: Record<string, number> = {};

  if (assigneeIds.length > 0) {
    const users = await prisma.user.findMany({
      where: { id: { in: assigneeIds } },
      select: { id: true, name: true },
    });
    assigneeNames = Object.fromEntries(users.map((u) => [u.id, u.name]));

    const doneCounts = await prisma.task.groupBy({
      by: ["assigneeId"],
      _count: { _all: true },
      where: {
        assigneeId: { in: assigneeIds },
        status: "DONE",
        ...projectFilter,
      },
    });
    assigneeDoneCounts = Object.fromEntries(
      doneCounts.map((d: any) => [d.assigneeId, d._count._all])
    );
  }

  const byStatus = byStatusRaw.map((r: any) => ({
    status: r.status as string,
    count: r._count._all as number,
  }));

  const byPriority = byPriorityRaw.map((r: any) => ({
    priority: r.priority as string,
    count: r._count._all as number,
  }));

  const doneCount = byStatus.find((s) => s.status === "DONE")?.count || 0;
  const completionRate = totalTasks > 0 ? Math.round((doneCount / totalTasks) * 100) : 0;

  const topAssignees = sortedAssigneesRaw.map((a: any) => ({
    assigneeId: a.assigneeId as string,
    assigneeName: assigneeNames[a.assigneeId] || "Unknown",
    total: a._count._all as number,
    done: assigneeDoneCounts[a.assigneeId] || 0,
  }));

  return {
    totalTasks,
    byStatus,
    byPriority,
    completionRate,
    topAssignees,
    completedThisMonth,
    overdueCount,
  };
}

// ===== Content Analytics =====

export async function getContentAnalytics() {
  const monthStart = startOfMonth();
  const now = new Date();

  let totalPosts = 0;
  let byStatus: { status: string; count: number }[] = [];
  let byPlatform: { platformName: string; count: number }[] = [];
  let publishedThisMonth = 0;
  let scheduledUpcoming = 0;

  try {
    totalPosts = await (prisma as any).contentPost.count();

    const statusGroups = await (prisma as any).contentPost.groupBy({
      by: ["status"],
      _count: { _all: true },
    });
    byStatus = statusGroups.map((r: any) => ({
      status: r.status,
      count: r._count._all,
    }));

    const accountGroups = await (prisma as any).contentPost.groupBy({
      by: ["accountId"],
      _count: { _all: true },
    });

    if (accountGroups.length > 0) {
      const accountIds = accountGroups.map((a: any) => a.accountId).filter(Boolean);
      const accounts = await prisma.socialAccount.findMany({
        where: { id: { in: accountIds } },
        select: { id: true, platform: { select: { name: true } } },
      });
      const accountPlatformMap = Object.fromEntries(
        accounts.map((a) => [a.id, a.platform.name])
      );

      const platformMap: Record<string, number> = {};
      for (const ag of accountGroups) {
        const platName = accountPlatformMap[ag.accountId] || "Unknown";
        platformMap[platName] = (platformMap[platName] || 0) + ag._count._all;
      }
      byPlatform = Object.entries(platformMap).map(([platformName, count]) => ({
        platformName,
        count,
      }));
    }

    publishedThisMonth = await (prisma as any).contentPost.count({
      where: { status: "PUBLISHED", publishedAt: { gte: monthStart } },
    });

    scheduledUpcoming = await (prisma as any).contentPost.count({
      where: { status: "SCHEDULED", scheduledAt: { gte: now } },
    });
  } catch {
    // ContentPost model doesn't exist yet — return zeroes
  }

  return {
    totalPosts,
    byStatus,
    byPlatform,
    publishedThisMonth,
    scheduledUpcoming,
  };
}

// ===== Project Analytics =====

export async function getProjectAnalytics(projectId?: string) {
  const where = projectId ? { id: projectId } : {};

  const projects = await prisma.project.findMany({
    where,
    select: {
      id: true,
      name: true,
      status: true,
      client: { select: { companyName: true } },
      tasks: { select: { task: { select: { status: true } } } },
      approvals: { where: { status: "PENDING" }, select: { id: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  const projectItems = projects.map((p) => {
    const totalTasks = p.tasks.length;
    const completedTasks = p.tasks.filter((t) => t.task.status === "DONE").length;
    return {
      projectId: p.id,
      projectName: p.name,
      clientName: p.client.companyName,
      status: p.status,
      totalTasks,
      completedTasks,
      pendingApprovals: p.approvals.length,
      taskCompletionPercent: totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0,
    };
  });

  return {
    totalProjects: projectId ? 1 : await prisma.project.count(),
    activeProjects: projectId
      ? (projects[0]?.status === "ACTIVE" ? 1 : 0)
      : await prisma.project.count({ where: { status: "ACTIVE" } }),
    projects: projectItems,
  };
}

// ===== Attendance Analytics =====

export async function getAttendanceAnalytics(params?: { startDate?: string; endDate?: string }) {
  const today = todayDate();
  const totalEmployees = await prisma.user.count({ where: employeeWhere });

  const todayRecords = await prisma.attendance.groupBy({
    by: ["status"],
    _count: { _all: true },
    where: { date: today },
  });

  const todayCounts: Record<string, number> = {};
  for (const r of todayRecords) {
    todayCounts[r.status] = r._count._all;
  }

  const presentToday = (todayCounts["PRESENT"] || 0) + (todayCounts["LATE"] || 0) + (todayCounts["HALF_DAY"] || 0);
  const absentToday = todayCounts["ABSENT"] || 0;
  const lateToday = todayCounts["LATE"] || 0;
  const onLeaveToday = todayCounts["LEAVE"] || 0;

  const attendanceRate = totalEmployees > 0
    ? Math.round((presentToday / totalEmployees) * 100)
    : 0;

  const rangeEnd = params?.endDate ? new Date(params.endDate) : today;
  const rangeStart = params?.startDate
    ? new Date(params.startDate)
    : new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000);

  const dailyRecords = await prisma.attendance.groupBy({
    by: ["date", "status"],
    _count: { _all: true },
    where: {
      date: { gte: rangeStart, lte: rangeEnd },
    },
    orderBy: { date: "asc" },
  });

  const dateMap: Record<string, { present: number; absent: number; late: number; leave: number }> = {};

  for (const r of dailyRecords) {
    const dateStr = dateToIST(new Date(r.date));
    if (!dateMap[dateStr]) {
      dateMap[dateStr] = { present: 0, absent: 0, late: 0, leave: 0 };
    }
    const counts = dateMap[dateStr];
    switch (r.status) {
      case "PRESENT":
      case "HALF_DAY":
        counts.present += r._count._all;
        break;
      case "ABSENT":
        counts.absent += r._count._all;
        break;
      case "LATE":
        counts.late += r._count._all;
        counts.present += r._count._all;
        break;
      case "LEAVE":
        counts.leave += r._count._all;
        break;
    }
  }

  const dailyBreakdown = Object.entries(dateMap).map(([date, counts]) => ({
    date,
    ...counts,
  }));

  return {
    totalEmployees,
    presentToday,
    absentToday,
    lateToday,
    onLeaveToday,
    attendanceRate,
    dailyBreakdown,
  };
}

// ===== Client Analytics =====
// (getClientAnalytics was removed 2026-07-20: its only caller was a SHADOWED
// duplicate GET /client/analytics in analytics.routes.ts — client.routes.ts
// mounts first and serves the live endpoint via getClientContentAnalytics
// below. The dead function carried a 2-queries-per-project N+1.)

// ===== Client Content Analytics =====

export async function getClientContentAnalytics(clientId: string) {
  const todayMid = todayDate();
  // getUTCDay() on the IST-midnight date gives us the correct IST day-of-week
  const weekStart = new Date(todayMid.getTime() - todayMid.getUTCDay() * 86400000);
  const weekEnd = new Date(weekStart.getTime() + 7 * 86400000);

  const thirtyDaysAgo = new Date(todayMid.getTime() - 30 * 86400000);

  // Build 5-week cadence buckets (oldest first)
  const fiveWeeksAgo = new Date(weekStart.getTime() - 28 * 86400000);

  const projectFilter = { project: { clientId } };

  const [
    totalPosts,
    statusGroups,
    formatGroups,
    scheduledThisWeek,
    liveThisWeek,
    projects,
    recentApproved,
    publishedLast5Weeks,
  ] = await Promise.all([
    prisma.contentPost.count({ where: projectFilter }),

    prisma.contentPost.groupBy({
      by: ["status"],
      _count: { _all: true },
      where: projectFilter,
    }),

    prisma.contentPost.groupBy({
      by: ["format"],
      _count: { _all: true },
      where: { ...projectFilter, format: { not: null } },
    }),

    prisma.contentPost.count({
      where: {
        ...projectFilter,
        status: "SCHEDULED",
        scheduledAt: { gte: weekStart, lt: weekEnd },
      },
    }),

    prisma.contentPost.count({
      where: {
        ...projectFilter,
        status: "PUBLISHED",
        publishedAt: { gte: weekStart, lt: weekEnd },
      },
    }),

    prisma.project.findMany({
      where: { clientId },
      select: {
        id: true,
        name: true,
        healthScore: true,
        contentPosts: {
          select: { id: true, status: true },
        },
      },
    }),

    prisma.contentPost.findMany({
      where: {
        ...projectFilter,
        status: "APPROVED",
        updatedAt: { gte: thirtyDaysAgo },
      },
      select: { createdAt: true, updatedAt: true },
      take: 100,
    }),

    prisma.contentPost.findMany({
      where: {
        ...projectFilter,
        status: "PUBLISHED",
        publishedAt: { gte: fiveWeeksAgo },
      },
      select: { publishedAt: true },
    }),
  ]);

  const postsByStatus: Record<string, number> = {};
  for (const r of statusGroups) {
    postsByStatus[r.status] = r._count._all;
  }

  const postsByFormat: Record<string, number> = {};
  for (const r of formatGroups) {
    if (r.format) postsByFormat[r.format] = r._count._all;
  }

  // Approximation: time from post creation to approval (updatedAt is the last state change,
  // not a dedicated approvedAt field — this is an approximation and may overcount if the post
  // was edited after creation before being submitted for approval).
  let approvalTurnaround = 0;
  if (recentApproved.length > 0) {
    const totalMs = recentApproved.reduce((sum, p) => {
      return sum + (p.updatedAt.getTime() - p.createdAt.getTime());
    }, 0);
    approvalTurnaround = Math.round(totalMs / recentApproved.length / (1000 * 60 * 60));
  }

  // Build weekly cadence buckets: 5 weeks ending with the current week
  const weeklyPosts: { label: string; value: number }[] = [];
  for (let i = 4; i >= 0; i--) {
    const wStart = new Date(weekStart);
    wStart.setDate(weekStart.getDate() - i * 7);
    const wEnd = new Date(wStart);
    wEnd.setDate(wStart.getDate() + 7);

    const count = publishedLast5Weeks.filter((p) => {
      const d = p.publishedAt ? new Date(p.publishedAt) : null;
      return d && d >= wStart && d < wEnd;
    }).length;

    // Label format: "May W3"
    const monthStr = wStart.toLocaleString("en-US", { month: "short" });
    const weekOfMonth = Math.ceil(wStart.getDate() / 7);
    weeklyPosts.push({ label: `${monthStr} W${weekOfMonth}`, value: count });
  }

  const projectSummaries = projects.map((p) => ({
    projectId: p.id,
    name: p.name,
    healthScore: p.healthScore,
    postCount: p.contentPosts.length,
    pendingCount: p.contentPosts.filter((c) => c.status === "PENDING_APPROVAL").length,
  }));

  return {
    totalPosts,
    postsByStatus,
    postsByFormat,
    approvalTurnaround,
    scheduledThisWeek,
    liveThisWeek,
    weeklyPosts,
    projectSummaries,
  };
}
