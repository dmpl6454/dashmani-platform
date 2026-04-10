import { prisma } from "@dashmani/db";

// ===== Helper: Get start of current month =====

function startOfMonth(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

function todayDate(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

// ===== Overview Stats =====

export async function getOverviewStats() {
  const monthStart = startOfMonth();
  const today = todayDate();

  const [
    totalEmployees,
    activeTeams,
    presentToday,
    tasksCompletedThisMonth,
    activeProjects,
    pendingApprovals,
    pendingEmployees,
    contentPublishedThisMonth,
    contentScheduledUpcoming,
  ] = await Promise.all([
    prisma.user.count({
      where: { status: "ACTIVE", deletedAt: null },
    }),
    prisma.orgUnit.count({
      where: { type: "TEAM" },
    }),
    prisma.attendance.count({
      where: {
        date: today,
        status: { in: ["PRESENT", "LATE", "HALF_DAY"] },
      },
    }),
    prisma.task.count({
      where: {
        status: "DONE",
        completedAt: { gte: monthStart },
      },
    }),
    prisma.project.count({
      where: { status: "ACTIVE" },
    }),
    prisma.approval.count({
      where: { status: "PENDING" },
    }),
    prisma.user.count({
      where: { status: "ONBOARDING", deletedAt: null },
    }),
    safeContentCount({
      status: "PUBLISHED",
      publishedAtGte: monthStart,
    }),
    safeContentCount({
      status: "SCHEDULED",
      scheduledAtGte: new Date(),
    }),
  ]);

  return {
    totalEmployees,
    activeTeams,
    presentToday,
    tasksCompletedThisMonth,
    activeProjects,
    pendingApprovals,
    pendingEmployees,
    contentPublishedThisMonth,
    contentScheduledUpcoming,
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
  const totalEmployees = await prisma.user.count({
    where: { status: "ACTIVE", deletedAt: null },
  });

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
    const dateStr = new Date(r.date).toISOString().split("T")[0];
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

export async function getClientAnalytics(clientId: string) {
  const projects = await prisma.project.findMany({
    where: { clientId },
    select: {
      id: true,
      name: true,
      status: true,
      tasks: { select: { task: { select: { status: true } } } },
      approvals: { where: { status: "PENDING" }, select: { id: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  let totalTasks = 0;
  let completedTasks = 0;
  let pendingApprovals = 0;

  const projectItems = await Promise.all(
    projects.map(async (p) => {
      const pTotalTasks = p.tasks.length;
      const pCompletedTasks = p.tasks.filter((t) => t.task.status === "DONE").length;
      const pPendingApprovals = p.approvals.length;

      totalTasks += pTotalTasks;
      completedTasks += pCompletedTasks;
      pendingApprovals += pPendingApprovals;

      let totalContent = 0;
      let publishedContent = 0;
      try {
        totalContent = await (prisma as any).contentPost.count({
          where: { projectId: p.id },
        });
        publishedContent = await (prisma as any).contentPost.count({
          where: { projectId: p.id, status: "PUBLISHED" },
        });
      } catch {
        // ContentPost model doesn't exist yet
      }

      return {
        projectId: p.id,
        projectName: p.name,
        status: p.status,
        totalTasks: pTotalTasks,
        completedTasks: pCompletedTasks,
        pendingApprovals: pPendingApprovals,
        taskCompletionPercent: pTotalTasks > 0
          ? Math.round((pCompletedTasks / pTotalTasks) * 100)
          : 0,
        totalContent,
        publishedContent,
      };
    })
  );

  const activeProjects = projects.filter((p) => p.status === "ACTIVE").length;

  return {
    totalProjects: projects.length,
    activeProjects,
    totalTasks,
    completedTasks,
    pendingApprovals,
    overallCompletionPercent: totalTasks > 0
      ? Math.round((completedTasks / totalTasks) * 100)
      : 0,
    projects: projectItems,
  };
}
