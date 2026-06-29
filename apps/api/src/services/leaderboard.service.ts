import { prisma } from "@dashmani/db";
import { calcStreaks } from "../utils/streak";
import { employeeWhere } from "./analytics.service";
import { todayIST, istMidnight } from "@dashmani/shared";

// Real per-employee engagement, derived from the link_metrics snapshots (the SAME
// authoritative source as the Top Links panels / getInsightsSummary), NOT from
// report_links.likes/comments/shares — those columns are NEVER populated (verified
// 2026-06-29: all 66k report_links rows have likes/comments/shares = 0), which is
// why the leaderboard's Engagement column used to read a flat 0 for everyone.
//
// Returns, per employeeId: summed views + likes + comments over the LATEST snapshot
// per unique link (deduped by employeeId::urlNormalized, newest fetchedAt wins —
// exactly how getInsightsSummary aggregates), plus the count of links that have an
// engagement snapshot. OOM-safe: selects only the 5 columns needed, dedups in JS.
//
// ⚠️ Engagement coverage is platform-limited: YouTube exposes reliable views; IG/FB
// expose likes+comments (no reliable views). Snapchat exposes NOTHING via API
// (manual-only) — it contributes 0 engagement here, by design, and is surfaced as a
// "not counted yet" note in the UI. So engagement is a fair cross-platform signal
// (likes+comments work everywhere we have data) but is NOT a measure of Snapchat.
interface EngagementAgg {
  views: number;
  likes: number;
  comments: number;
  linkCount: number;
}
async function getEngagementByEmployee(
  startDate?: string,
  endDate?: string,
): Promise<Map<string, EngagementAgg>> {
  const where: Record<string, unknown> = { status: "ok" };
  if (startDate || endDate) {
    const range: Record<string, Date> = {};
    if (startDate) range.gte = new Date(startDate);
    if (endDate) range.lte = new Date(endDate);
    where.reportDate = range;
  }

  const snapshots = await prisma.linkMetric.findMany({
    where,
    orderBy: { fetchedAt: "desc" },
    select: { employeeId: true, urlNormalized: true, views: true, likes: true, comments: true },
  });

  // Latest snapshot per (employeeId, urlNormalized) — newest fetchedAt already first.
  const seen = new Set<string>();
  const byEmployee = new Map<string, EngagementAgg>();
  for (const s of snapshots) {
    if (!s.employeeId) continue;
    const key = `${s.employeeId}::${s.urlNormalized}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let agg = byEmployee.get(s.employeeId);
    if (!agg) {
      agg = { views: 0, likes: 0, comments: 0, linkCount: 0 };
      byEmployee.set(s.employeeId, agg);
    }
    agg.views += s.views ?? 0;
    agg.likes += s.likes ?? 0;
    agg.comments += s.comments ?? 0;
    agg.linkCount += 1;
  }
  return byEmployee;
}

export async function getLeaderboard(startDate?: string, endDate?: string) {
  const where: any = {
    employee: employeeWhere,
  };
  if (startDate || endDate) {
    where.date = {};
    if (startDate) where.date.gte = new Date(startDate);
    if (endDate) where.date.lte = new Date(endDate);
  }

  const [reports, engagementByEmployee] = await Promise.all([
    prisma.dailyReport.findMany({
      where,
      include: {
        links: true,
        employee: { select: { id: true, name: true, email: true, profileImageUrl: true } },
      },
      orderBy: { date: "asc" },
    }),
    getEngagementByEmployee(startDate, endDate),
  ]);

  // Group by employee
  const employeeMap = new Map<
    string,
    {
      employee: { id: string; name: string; email: string; profileImageUrl: string | null };
      reportDates: Date[];
      totalLinks: number;
    }
  >();

  for (const report of reports) {
    const empId = report.employeeId;
    if (!employeeMap.has(empId)) {
      employeeMap.set(empId, {
        employee: report.employee,
        reportDates: [],
        totalLinks: 0,
      });
    }
    const entry = employeeMap.get(empId)!;
    entry.reportDates.push(report.date);
    entry.totalLinks += report.links.length;
  }

  const result = Array.from(employeeMap.values()).map(({ employee, reportDates, totalLinks }) => {
    const totalReports = reportDates.length;
    const { currentStreak, longestStreak } = calcStreaks(reportDates);
    // avgLinksPerReport = links per REPORTING DAY (a day the employee submitted),
    // not per calendar day — relabeled honestly in the UI as "Avg/Report".
    const avgLinksPerReport = totalReports > 0 ? totalLinks / totalReports : 0;
    // Engagement = real views+likes+comments from link_metrics (latest per link).
    const eng = engagementByEmployee.get(employee.id);
    const totalEngagement = eng ? eng.views + eng.likes + eng.comments : 0;

    return {
      employee,
      totalReports,
      totalLinks,
      currentStreak,
      longestStreak,
      avgLinksPerReport: Math.round(avgLinksPerReport * 10) / 10,
      // Keep avgLinksPerDay as an alias for backward-compat with any cached UI; same value.
      avgLinksPerDay: Math.round(avgLinksPerReport * 10) / 10,
      totalEngagement,
      engagementViews: eng?.views ?? 0,
      engagementLikes: eng?.likes ?? 0,
      engagementComments: eng?.comments ?? 0,
      engagedLinkCount: eng?.linkCount ?? 0,
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

// ============ Top Links leaderboard (per-employee engagement ranking) ============
//
// A SEPARATE leaderboard ranking employees by the real engagement their submitted
// links earned (views + likes + comments), sourced from link_metrics — the same
// authoritative snapshots behind the Top Links panels. Distinct from the main
// leaderboard (which ranks by report consistency / link volume); this one answers
// "whose posts actually performed". Ranked by total engagement desc.
//
// ⚠️ Truthful coverage caveats surfaced to the UI:
//  - YouTube → reliable views; IG/FB → likes+comments (no reliable views); these are
//    summed into one engagement score so an IG/FB-heavy employee isn't unfairly
//    under-ranked by a views-only metric.
//  - Snapchat is NOT counted (no engagement API; manual-only) — to be added later.
//  - Only links we've enriched have engagement; the same firehose/opaque-link limits
//    that cap Link Search coverage apply here (an employee's unreachable posts simply
//    don't contribute). The UI notes this so the ranking isn't read as "complete".
export async function getTopLinksLeaderboard(startDate?: string, endDate?: string) {
  // Resolve employee identity for everyone who has engagement, scoped to real
  // employees (excludes pure-admin accounts), matching the main leaderboard's filter.
  const [engagementByEmployee, employees] = await Promise.all([
    getEngagementByEmployee(startDate, endDate),
    prisma.user.findMany({
      where: employeeWhere,
      select: { id: true, name: true, email: true, profileImageUrl: true },
    }),
  ]);

  const empById = new Map(employees.map((e) => [e.id, e]));

  const rows = [...engagementByEmployee.entries()]
    .map(([employeeId, agg]) => {
      const employee = empById.get(employeeId);
      if (!employee) return null; // engagement from a non-employee account → skip
      return {
        employee,
        totalEngagement: agg.views + agg.likes + agg.comments,
        views: agg.views,
        likes: agg.likes,
        comments: agg.comments,
        engagedLinkCount: agg.linkCount,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  rows.sort((a, b) => {
    if (b.totalEngagement !== a.totalEngagement) return b.totalEngagement - a.totalEngagement;
    if (b.views !== a.views) return b.views - a.views;
    return b.engagedLinkCount - a.engagedLinkCount;
  });

  return rows.map((r, idx) => ({ rank: idx + 1, ...r }));
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
