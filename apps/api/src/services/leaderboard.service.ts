import { prisma } from "@dashmani/db";
import { calcStreaks } from "../utils/streak";
import { employeeWhere } from "./analytics.service";
import { todayIST, istMidnight } from "@dashmani/shared";

export async function getLeaderboard(startDate?: string, endDate?: string) {
  const where: any = {
    employee: employeeWhere,
  };
  if (startDate || endDate) {
    where.date = {};
    if (startDate) where.date.gte = new Date(startDate);
    if (endDate) where.date.lte = new Date(endDate);
  }

  const reports = await prisma.dailyReport.findMany({
    where,
    include: {
      links: true,
      employee: { select: { id: true, name: true, email: true, profileImageUrl: true } },
    },
    orderBy: { date: "asc" },
  });

  // Group by employee
  const employeeMap = new Map<
    string,
    {
      employee: { id: string; name: string; email: string; profileImageUrl: string | null };
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

  const result = Array.from(employeeMap.values()).map(({ employee, reportDates, totalLinks, totalEngagement }) => {
    const totalReports = reportDates.length;
    const { currentStreak, longestStreak } = calcStreaks(reportDates);
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

  // Sort by totalLinks desc, then totalReports desc, then currentStreak desc
  result.sort((a, b) => {
    if (b.totalLinks !== a.totalLinks) return b.totalLinks - a.totalLinks;
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

  const today = istMidnight(todayIST());

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
