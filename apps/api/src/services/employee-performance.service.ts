import { prisma } from "@dashmani/db";

const DAY_MS = 86400000;

export async function getEmployeePerformance(employeeId: string) {
  const employee = await prisma.user.findUnique({
    where: { id: employeeId },
    select: {
      id: true,
      name: true,
      email: true,
      status: true,
      createdAt: true,
      orgUnit: { select: { name: true } },
      roles: { include: { role: { select: { name: true } } } },
      profile: { select: { designation: true } },
    },
  });

  if (!employee) {
    throw new Error("Employee not found");
  }

  // Fetch all reports with links
  const reports = await prisma.dailyReport.findMany({
    where: { employeeId },
    include: {
      links: {
        include: {
          account: { include: { platform: true } },
        },
      },
    },
    orderBy: { date: "desc" },
  });

  // Basic stats
  const totalReports = reports.length;
  const totalLinks = reports.reduce((sum, r) => sum + r.links.length, 0);
  let totalLikes = 0, totalComments = 0, totalShares = 0, totalViews = 0;

  // Platform breakdown
  const platformMap = new Map<string, { name: string; links: number; engagement: number }>();

  // Weekly trend (last 12 weeks)
  const weeklyTrend: { week: string; reports: number; links: number }[] = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const weekStart = new Date(now);
    weekStart.setDate(weekStart.getDate() - weekStart.getDay() - i * 7);
    weekStart.setHours(0, 0, 0, 0);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);

    const weekReports = reports.filter((r) => {
      const d = new Date(r.date);
      return d >= weekStart && d <= weekEnd;
    });

    const weekLabel = `${weekStart.toLocaleDateString("en-IN", { month: "short", day: "numeric" })}`;
    weeklyTrend.push({
      week: weekLabel,
      reports: weekReports.length,
      links: weekReports.reduce((s, r) => s + r.links.length, 0),
    });
  }

  // Report calendar (last 90 days) — { date: "YYYY-MM-DD", linkCount: number }
  const calendar: { date: string; linkCount: number }[] = [];
  const calendarStart = new Date();
  calendarStart.setDate(calendarStart.getDate() - 89);
  calendarStart.setHours(0, 0, 0, 0);

  const reportDateMap = new Map<string, number>();
  for (const r of reports) {
    const dateStr = r.date instanceof Date
      ? r.date.toISOString().split("T")[0]
      : String(r.date).split("T")[0];
    reportDateMap.set(dateStr, r.links.length);
  }

  for (let i = 0; i < 90; i++) {
    const d = new Date(calendarStart);
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().split("T")[0];
    calendar.push({
      date: dateStr,
      linkCount: reportDateMap.get(dateStr) ?? 0,
    });
  }

  // Process all links
  for (const report of reports) {
    for (const link of report.links) {
      totalLikes += link.likes ?? 0;
      totalComments += link.comments ?? 0;
      totalShares += link.shares ?? 0;
      totalViews += link.views ?? 0;

      const platformName = link.account?.platform?.name ?? link.platform ?? "Other";
      const platformSlug = link.account?.platform?.slug ?? link.platform?.toLowerCase() ?? "other";
      if (!platformMap.has(platformSlug)) {
        platformMap.set(platformSlug, { name: platformName, links: 0, engagement: 0 });
      }
      const p = platformMap.get(platformSlug)!;
      p.links += 1;
      p.engagement += (link.likes ?? 0) + (link.comments ?? 0) + (link.shares ?? 0);
    }
  }

  // Streaks
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const sortedDates = [...new Set(
    reports.map((r) => {
      const d = new Date(r.date);
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    })
  )].sort((a, b) => b - a);

  let currentStreak = 0;
  let cursor = today.getTime();
  for (const ts of sortedDates) {
    if (ts === cursor || ts === cursor - DAY_MS) {
      currentStreak++;
      cursor = ts - DAY_MS;
    } else if (ts < cursor - DAY_MS) {
      break;
    }
  }

  let longestStreak = 0;
  let runLength = 0;
  let prevTs: number | null = null;
  for (const ts of [...sortedDates].reverse()) {
    if (prevTs === null || ts === prevTs + DAY_MS) {
      runLength++;
    } else {
      runLength = 1;
    }
    longestStreak = Math.max(longestStreak, runLength);
    prevTs = ts;
  }

  const avgLinksPerDay = totalReports > 0 ? Math.round((totalLinks / totalReports) * 10) / 10 : 0;
  const totalEngagement = totalLikes + totalComments + totalShares;

  // This month stats
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const thisMonthReports = reports.filter((r) => new Date(r.date) >= monthStart).length;
  const thisMonthLinks = reports
    .filter((r) => new Date(r.date) >= monthStart)
    .reduce((s, r) => s + r.links.length, 0);

  // Recent reports (last 10)
  const recentReports = reports.slice(0, 10).map((r) => ({
    id: r.id,
    date: r.date instanceof Date ? r.date.toISOString().split("T")[0] : String(r.date).split("T")[0],
    notes: r.notes,
    linkCount: r.links.length,
    totalEngagement: r.links.reduce(
      (s, l) => s + (l.likes ?? 0) + (l.comments ?? 0) + (l.shares ?? 0),
      0,
    ),
    platforms: [...new Set(r.links.map((l) => l.account?.platform?.name ?? l.platform ?? "Other"))],
  }));

  // Assigned accounts
  const assignments = await prisma.accountAssignment.findMany({
    where: { employeeId, unassignedAt: null },
    include: {
      account: { include: { platform: true } },
    },
  });

  const assignedAccounts = assignments.map((a) => ({
    id: a.account.id,
    handle: a.account.handle,
    displayName: a.account.displayName,
    platform: a.account.platform.name,
    followerCount: a.account.followerCount,
  }));

  return {
    employee: {
      id: employee.id,
      name: employee.name,
      email: employee.email,
      status: employee.status,
      team: employee.orgUnit?.name ?? null,
      designation: employee.profile?.designation ?? null,
      roles: employee.roles.map((r) => r.role.name),
      joinedAt: employee.createdAt.toISOString(),
    },
    stats: {
      totalReports,
      totalLinks,
      avgLinksPerDay,
      currentStreak,
      longestStreak,
      totalEngagement,
      totalLikes,
      totalComments,
      totalShares,
      totalViews,
      thisMonthReports,
      thisMonthLinks,
    },
    platformBreakdown: Array.from(platformMap.entries())
      .map(([slug, data]) => ({ slug, ...data }))
      .sort((a, b) => b.links - a.links),
    weeklyTrend,
    calendar,
    recentReports,
    assignedAccounts,
  };
}
