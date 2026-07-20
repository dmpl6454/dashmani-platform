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

  // ⚠️ MEMORY-SAFE SHAPE (2026-07-20). The old code did ONE findMany hydrating
  // EVERY report WITH every link + nested account + platform — the exact
  // unbounded-include class behind the 2026-07-09 kernel-OOM (getReportSummary).
  // For the heaviest employee that was ~14k nested link rows per request to
  // return a small aggregate. Now: reports WITHOUT links (a few hundred tiny
  // rows), per-report link counts/sums via ONE DB groupBy, the platform
  // breakdown via ONE SQL aggregation, and full link hydration ONLY for the 10
  // recent reports (bounded). Output is byte-identical. Do NOT reintroduce an
  // unbounded `include: { links: ... }` here — see the same rule in
  // daily-report.service.ts getReportSummary.
  const reports = await prisma.dailyReport.findMany({
    where: { employeeId },
    select: { id: true, date: true, notes: true },
    orderBy: { date: "desc" },
  });

  // Per-report link count + metric sums (replaces per-link JS accumulation).
  const perReport = await prisma.reportLink.groupBy({
    by: ["reportId"],
    where: { report: { employeeId } },
    _count: { _all: true },
    _sum: { likes: true, comments: true, shares: true, views: true },
  });
  const linkCountByReport = new Map<string, number>();
  let totalLinks = 0;
  let totalLikes = 0, totalComments = 0, totalShares = 0, totalViews = 0;
  for (const g of perReport) {
    linkCountByReport.set(g.reportId, g._count._all);
    totalLinks += g._count._all;
    totalLikes += g._sum.likes ?? 0;
    totalComments += g._sum.comments ?? 0;
    totalShares += g._sum.shares ?? 0;
    totalViews += g._sum.views ?? 0;
  }

  // Basic stats
  const totalReports = reports.length;

  // Platform breakdown — same fallback chain as the old per-link JS
  // (account.platform name/slug, else the free-text link platform, else Other),
  // aggregated in Postgres instead of over hydrated rows.
  const platformRows = await prisma.$queryRaw<
    Array<{ slug: string; name: string; links: bigint; engagement: bigint }>
  >`
    SELECT
      COALESCE(p.slug, LOWER(rl.platform), 'other') AS slug,
      COALESCE(p.name, rl.platform, 'Other') AS name,
      count(*)::bigint AS links,
      sum(coalesce(rl.likes, 0) + coalesce(rl.comments, 0) + coalesce(rl.shares, 0))::bigint AS engagement
    FROM report_links rl
    JOIN daily_reports dr ON dr.id = rl.report_id
    LEFT JOIN social_accounts sa ON sa.id = rl.account_id
    LEFT JOIN platforms p ON p.id = sa.platform_id
    WHERE dr.employee_id = ${employeeId}
    GROUP BY 1, 2
    ORDER BY count(*) DESC
  `;
  const platformMap = new Map<string, { name: string; links: number; engagement: number }>();
  for (const row of platformRows) {
    const existing = platformMap.get(row.slug);
    if (existing) {
      existing.links += Number(row.links);
      existing.engagement += Number(row.engagement);
    } else {
      platformMap.set(row.slug, { name: row.name, links: Number(row.links), engagement: Number(row.engagement) });
    }
  }

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
      links: weekReports.reduce((s, r) => s + (linkCountByReport.get(r.id) ?? 0), 0),
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
    reportDateMap.set(dateStr, linkCountByReport.get(r.id) ?? 0);
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

  // (Per-link totals + platform breakdown are computed in the DB above.)

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
    .reduce((s, r) => s + (linkCountByReport.get(r.id) ?? 0), 0);

  // Recent reports (last 10) — the ONLY place links are hydrated, bounded to 10
  // reports (the platforms list + per-report engagement need per-link rows).
  const recentWithLinks = await prisma.dailyReport.findMany({
    where: { employeeId },
    include: {
      links: {
        include: {
          account: { include: { platform: true } },
        },
      },
    },
    orderBy: { date: "desc" },
    take: 10,
  });
  const recentReports = recentWithLinks.map((r) => ({
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
