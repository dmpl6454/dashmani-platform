import { prisma } from "@dashmani/db";

export async function getLeaderboard(startDate?: string, endDate?: string) {
  const where: any = {};
  if (startDate || endDate) {
    where.date = {};
    if (startDate) where.date.gte = new Date(startDate);
    if (endDate) where.date.lte = new Date(endDate);
  }

  const reports = await prisma.dailyReport.findMany({
    where,
    include: {
      links: true,
      employee: { select: { id: true, name: true, email: true } },
    },
    orderBy: { date: "asc" },
  });

  // Group by employee
  const employeeMap = new Map<
    string,
    {
      employee: { id: string; name: string; email: string };
      reportDates: Date[];
      totalLinks: number;
      totalEngagement: number;
    }
  >();

  for (const report of reports) {
    const empId = report.employeeId;
    if (!employeeMap.has(empId)) {
      employeeMap.set(empId, {
        employee: report.employee,
        reportDates: [],
        totalLinks: 0,
        totalEngagement: 0,
      });
    }
    const entry = employeeMap.get(empId)!;
    entry.reportDates.push(report.date);
    entry.totalLinks += report.links.length;
    for (const link of report.links) {
      entry.totalEngagement += (link.likes ?? 0) + (link.comments ?? 0) + (link.shares ?? 0);
    }
  }

  // Calculate streaks
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const result = Array.from(employeeMap.values()).map(({ employee, reportDates, totalLinks, totalEngagement }) => {
    const totalReports = reportDates.length;

    // Sort dates descending for streak calculation
    const sortedDates = [...reportDates]
      .map((d) => {
        const dt = new Date(d);
        dt.setHours(0, 0, 0, 0);
        return dt.getTime();
      })
      .sort((a, b) => b - a);

    const uniqueDates = Array.from(new Set(sortedDates));

    // Current streak: count consecutive days backwards from today
    let currentStreak = 0;
    let cursor = today.getTime();
    const DAY_MS = 86400000;
    for (const ts of uniqueDates) {
      if (ts === cursor || ts === cursor - DAY_MS) {
        currentStreak++;
        cursor = ts - DAY_MS;
      } else if (ts < cursor - DAY_MS) {
        break;
      }
    }

    // Longest streak: count longest run of consecutive days
    let longestStreak = 0;
    let runLength = 0;
    let prevTs: number | null = null;
    for (const ts of uniqueDates.reverse()) {
      if (prevTs === null || ts === prevTs + DAY_MS) {
        runLength++;
      } else if (ts > prevTs + DAY_MS) {
        runLength = 1;
      }
      longestStreak = Math.max(longestStreak, runLength);
      prevTs = ts;
    }

    // Days in range for avg calculation
    let rangeDays = totalReports;
    if (startDate && endDate) {
      const start = new Date(startDate).getTime();
      const end = new Date(endDate).getTime();
      rangeDays = Math.max(1, Math.round((end - start) / DAY_MS) + 1);
    } else if (uniqueDates.length > 1) {
      const minTs = Math.min(...uniqueDates);
      const maxTs = Math.max(...uniqueDates);
      rangeDays = Math.max(1, Math.round((maxTs - minTs) / DAY_MS) + 1);
    }

    const avgLinksPerDay = totalReports > 0 ? totalLinks / totalReports : 0;

    return {
      employee,
      totalReports,
      totalLinks,
      currentStreak,
      longestStreak,
      avgLinksPerDay: Math.round(avgLinksPerDay * 10) / 10,
      totalEngagement,
    };
  });

  // Sort by totalReports desc, then currentStreak desc
  result.sort((a, b) => {
    if (b.totalReports !== a.totalReports) return b.totalReports - a.totalReports;
    return b.currentStreak - a.currentStreak;
  });

  return result.map((entry, idx) => ({ rank: idx + 1, ...entry }));
}

export async function getTeamDashboard(teamLeadId: string) {
  // Find the user's orgUnit
  const user = await prisma.user.findUnique({
    where: { id: teamLeadId },
    select: { orgUnitId: true },
  });

  if (!user?.orgUnitId) {
    return { teamName: null, members: [], submissionRate: 0 };
  }

  const orgUnit = await prisma.orgUnit.findUnique({
    where: { id: user.orgUnitId },
    include: {
      members: {
        select: { id: true, name: true, email: true },
      },
    },
  });

  if (!orgUnit) {
    return { teamName: null, members: [], submissionRate: 0 };
  }

  const members = orgUnit.members;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Get today's submissions
  const todayReports = await prisma.dailyReport.findMany({
    where: {
      date: today,
      employeeId: { in: members.map((m) => m.id) },
    },
    select: { employeeId: true },
  });
  const submittedTodayIds = new Set(todayReports.map((r) => r.employeeId));

  // Get this week's reports
  const weekStart = new Date(today);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());

  const weekReports = await prisma.dailyReport.findMany({
    where: {
      date: { gte: weekStart, lte: today },
      employeeId: { in: members.map((m) => m.id) },
    },
    include: { links: { select: { id: true } } },
  });

  // Build per-member data
  const memberData = members.map((member) => {
    const myWeekReports = weekReports.filter((r) => r.employeeId === member.id);
    const weeklyReports = myWeekReports.length;
    const totalLinks = myWeekReports.reduce((sum, r) => sum + r.links.length, 0);
    const submittedToday = submittedTodayIds.has(member.id);

    return {
      id: member.id,
      name: member.name,
      email: member.email,
      submittedToday,
      weeklyReports,
      totalLinks,
    };
  });

  const submissionRate =
    members.length > 0
      ? Math.round((submittedTodayIds.size / members.length) * 100)
      : 0;

  return {
    teamName: orgUnit.name,
    memberCount: members.length,
    members: memberData,
    submissionRate,
  };
}
