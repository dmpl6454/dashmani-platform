import { prisma } from "@dashmani/db";
import { calcStreaks } from "../utils/streak";
import { employeeWhere } from "./analytics.service";
import { todayIST, istMidnight } from "@dashmani/shared";

// Short TTL cache for the heavy leaderboard reads. These recompute a DISTINCT ON over
// ~925k link_metrics rows + a report groupBy; without a cache, every SWR revalidation
// (esp. the leaderboard page's 3 concurrent, focus-revalidating calls) re-ran them and
// saturated the pool. 60s is long enough to absorb a focus/remount storm, short enough
// that a fresh cron write shows within a minute. Keyed by fn+window so ranges don't collide.
const LEADERBOARD_TTL_MS = 60 * 1000;
const _lbCache = new Map<string, { value: unknown; builtAt: number }>();
export function invalidateLeaderboardCache(): void { _lbCache.clear(); }
async function memo<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = _lbCache.get(key);
  const now = Date.now();
  if (hit && now - hit.builtAt < LEADERBOARD_TTL_MS) return hit.value as T;
  const value = await fn();
  _lbCache.set(key, { value, builtAt: now });
  return value;
}

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
// expose likes+comments (no reliable views); Snapchat Spotlight exposes reliable
// views+comments (no likes) via the __NEXT_DATA__ scrape — see platformOfUrl below
// and the per-platform Snapchat board in getPlatformLeaderboards. So engagement is a
// fair cross-platform signal (likes+comments work everywhere we have data) and now
// includes Snapchat views/comments on the platform-specific boards.
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
  // Latest snapshot per (employeeId, urlNormalized) done IN POSTGRES via DISTINCT ON
  // (byte-identical to the old JS seen-Set dedup: same key, same latest-by-fetchedAt).
  // Backed by the partial covering index (Task B1): Index Only Scan, no disk sort.
  //
  // ⚠️ NO 90-DAY DEFAULT: when no dates are passed this queries ALL-TIME, matching the
  // OLD behavior exactly. This is deliberate, not an oversight — prod EXPLAIN ANALYZE
  // with the tuned index shows ALL-TIME (763ms) is actually FASTER than a 90-day-windowed
  // query (834ms) at this row count, so narrowing the window bought nothing and would
  // have silently changed what several existing callers show (e.g. the HR portal's
  // /hr/leaderboard page, which never sends date params and previously showed all-time
  // engagement) without any UI indicating the narrower scope. The index alone is the
  // fix; do not reintroduce a silent default window here.
  //
  // ⚠️ FORWARD-LOOKING: this all-time/windowed cost comparison is a snapshot at today's
  // row count. An all-time DISTINCT ON's cost grows with total distinct (employee, url)
  // pairs ever recorded, while a windowed query's cost stays roughly flat as the table
  // ages. Re-measure this comparison if link_metrics grows materially past its current
  // size (e.g. 2-5x) — the all-time query may eventually become the slower option again.
  //
  // NOTE: both bounds are computed in JS and ALWAYS passed as concrete Dates (a null
  // start becomes the epoch, a null end becomes a far-future date). This keeps the
  // $queryRaw a fully STATIC tagged template — the repo's proven pattern
  // (link-search.service.ts) — with NO conditional `Prisma.sql`/`Prisma.empty` fragment
  // (that helper isn't used anywhere in this repo yet, so we don't introduce it). Two
  // fixed `${}` param bindings only.
  const start = startDate ? new Date(startDate) : new Date("1970-01-01T00:00:00.000Z");
  const end = endDate ? new Date(endDate) : new Date("2999-12-31T00:00:00.000Z");

  const rows = await prisma.$queryRaw<
    Array<{ employee_id: string; views: number | null; likes: number | null; comments: number | null }>
  >`
    SELECT employee_id, views, likes, comments
    FROM (
      SELECT DISTINCT ON (employee_id, url_normalized)
        employee_id, views, likes, comments
      FROM link_metrics
      WHERE status = 'ok'
        AND report_date >= ${start}
        AND report_date <= ${end}
      ORDER BY employee_id, url_normalized, fetched_at DESC
    ) latest
  `;

  const byEmployee = new Map<string, EngagementAgg>();
  for (const r of rows) {
    if (!r.employee_id) continue;
    let agg = byEmployee.get(r.employee_id);
    if (!agg) { agg = { views: 0, likes: 0, comments: 0, linkCount: 0 }; byEmployee.set(r.employee_id, agg); }
    agg.views += r.views ?? 0;
    agg.likes += r.likes ?? 0;
    agg.comments += r.comments ?? 0;
    agg.linkCount += 1;
  }
  return byEmployee;
}

// Classify a link's platform from its normalized URL (same host rules as everywhere else).
// Returns null for anything we don't rank per-platform (keeps unknown links out of the
// per-platform boards; they still count in the combined raw-volume board).
function platformOfUrl(url: string): "youtube" | "instagram" | "facebook" | "snapchat" | null {
  if (/youtube\.com|youtu\.be/i.test(url)) return "youtube";
  if (/instagram\.com/i.test(url)) return "instagram";
  if (/facebook\.com|fb\.watch|fb\.me/i.test(url)) return "facebook";
  if (/snapchat\.com/i.test(url)) return "snapchat";
  return null;
}

// Per-(employee, platform) engagement — latest snapshot per unique link, split by
// platform. Same dedup + latest-wins logic as getEngagementByEmployee, but keyed by
// (employee, platform) so we can build FAIR per-platform boards (each ranked by the
// metric that platform actually exposes — see getPlatformLeaderboards).
async function getEngagementByEmployeePlatform(
  startDate?: string,
  endDate?: string,
): Promise<Map<string, Map<"youtube" | "instagram" | "facebook" | "snapchat", EngagementAgg>>> {
  // No 90-day default here either — see the matching note in getEngagementByEmployee.
  // All-time is fast with the Task B1 index (763ms), so there's nothing to gain by
  // narrowing the window, and doing so would silently change existing callers' output.
  const start = startDate ? new Date(startDate) : new Date("1970-01-01T00:00:00.000Z");
  const end = endDate ? new Date(endDate) : new Date("2999-12-31T00:00:00.000Z");

  const rows = await prisma.$queryRaw<
    Array<{ employee_id: string; url_normalized: string | null; views: number | null; likes: number | null; comments: number | null }>
  >`
    SELECT employee_id, url_normalized, views, likes, comments
    FROM (
      SELECT DISTINCT ON (employee_id, url_normalized)
        employee_id, url_normalized, views, likes, comments
      FROM link_metrics
      WHERE status = 'ok'
        AND report_date >= ${start}
        AND report_date <= ${end}
      ORDER BY employee_id, url_normalized, fetched_at DESC
    ) latest
  `;

  const byEmp = new Map<string, Map<"youtube" | "instagram" | "facebook" | "snapchat", EngagementAgg>>();
  for (const r of rows) {
    if (!r.employee_id) continue;
    const plat = platformOfUrl(r.url_normalized ?? "");
    if (!plat) continue;
    let perPlat = byEmp.get(r.employee_id);
    if (!perPlat) { perPlat = new Map(); byEmp.set(r.employee_id, perPlat); }
    let agg = perPlat.get(plat);
    if (!agg) { agg = { views: 0, likes: 0, comments: 0, linkCount: 0 }; perPlat.set(plat, agg); }
    agg.views += r.views ?? 0;
    agg.likes += r.likes ?? 0;
    agg.comments += r.comments ?? 0;
    agg.linkCount += 1;
  }
  return byEmp;
}

export async function getLeaderboard(startDate?: string, endDate?: string) {
  return memo(`leaderboard:${startDate ?? ""}:${endDate ?? ""}`, () => getLeaderboardUncached(startDate, endDate));
}
async function getLeaderboardUncached(startDate?: string, endDate?: string) {
  const where: any = {
    employee: employeeWhere,
  };
  if (startDate || endDate) {
    where.date = {};
    if (startDate) where.date.gte = new Date(startDate);
    if (endDate) where.date.lte = new Date(endDate);
  }

  const [reports, linkCounts, engagementByEmployee] = await Promise.all([
    // Reports WITHOUT hydrating links — dates drive all-time streaks/counts (unchanged).
    prisma.dailyReport.findMany({
      where,
      select: {
        id: true,
        employeeId: true,
        date: true,
        employee: { select: { id: true, name: true, email: true, profileImageUrl: true } },
      },
      orderBy: { date: "asc" },
    }),
    // Per-report link count via groupBy — replaces the 92k-row include:{links} hydration.
    prisma.reportLink.groupBy({
      by: ["reportId"],
      where: { report: where },
      _count: { _all: true },
    }),
    getEngagementByEmployee(startDate, endDate),
  ]);
  const linkCountByReport = new Map(linkCounts.map((g) => [g.reportId, g._count._all]));

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
    entry.totalLinks += linkCountByReport.get(report.id) ?? 0;
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
//  - YouTube → reliable views; IG/FB → likes+comments (no reliable views); Snapchat →
//    views+comments (no likes — Spotlight exposes no public like metric). All are
//    summed into one engagement score so no platform is unfairly under- or
//    over-ranked by a metric it doesn't expose.
//  - Only links we've enriched have engagement; the same firehose/opaque-link limits
//    that cap Link Search coverage apply here (an employee's unreachable posts simply
//    don't contribute). The UI notes this so the ranking isn't read as "complete".
export async function getTopLinksLeaderboard(startDate?: string, endDate?: string) {
  return memo(`top-links-lb:${startDate ?? ""}:${endDate ?? ""}`, () => getTopLinksLeaderboardUncached(startDate, endDate));
}
async function getTopLinksLeaderboardUncached(startDate?: string, endDate?: string) {
  // Resolve employee identity for everyone who has engagement, scoped to real
  // employees (excludes pure-admin accounts), matching the main leaderboard's filter.
  // Also fetch each employee's TOTAL submitted (non-scheduled) link count for the
  // SAME window — the denominator of the "metrics on X of Y links" coverage note.
  // Metric coverage lags submission (the 6h cron is Meta-rate-limited, IG especially),
  // so engagedLinkCount is often << submitted. Surfacing both makes a partial row
  // (e.g. metrics on 350 of 2,171 IG links) visibly partial, not mistaken for complete.
  const reportWhere: any = { employee: employeeWhere };
  if (startDate || endDate) {
    reportWhere.date = {};
    if (startDate) reportWhere.date.gte = new Date(startDate);
    if (endDate) reportWhere.date.lte = new Date(endDate);
  }

  const [engagementByEmployee, employees, submittedGroups] = await Promise.all([
    getEngagementByEmployee(startDate, endDate),
    prisma.user.findMany({
      where: employeeWhere,
      select: { id: true, name: true, email: true, profileImageUrl: true },
    }),
    // Count non-scheduled links per employee in-window (the coverage denominator).
    prisma.reportLink.groupBy({
      by: ["reportId"],
      where: { isScheduled: false, report: reportWhere },
      _count: { _all: true },
    }),
  ]);

  const empById = new Map(employees.map((e) => [e.id, e]));

  // groupBy reportId → roll up to employee via the reports we just matched.
  const reportToEmp = new Map(
    (
      await prisma.dailyReport.findMany({
        where: reportWhere,
        select: { id: true, employeeId: true },
      })
    ).map((r) => [r.id, r.employeeId]),
  );
  const submittedByEmployee = new Map<string, number>();
  for (const g of submittedGroups) {
    const empId = reportToEmp.get(g.reportId);
    if (!empId) continue;
    submittedByEmployee.set(empId, (submittedByEmployee.get(empId) ?? 0) + g._count._all);
  }

  const rows = [...engagementByEmployee.entries()]
    .map(([employeeId, agg]) => {
      const employee = empById.get(employeeId);
      if (!employee) return null; // engagement from a non-employee account → skip
      const submittedLinkCount = submittedByEmployee.get(employeeId) ?? agg.linkCount;
      return {
        employee,
        totalEngagement: agg.views + agg.likes + agg.comments,
        views: agg.views,
        likes: agg.likes,
        comments: agg.comments,
        engagedLinkCount: agg.linkCount,
        // Denominator for the "metrics on X of Y links" coverage note. Clamp so
        // coverage can never read > 100% (a metric snapshot can outlive its report
        // edit; engagedLinkCount is the floor of what's truly covered).
        submittedLinkCount: Math.max(submittedLinkCount, agg.linkCount),
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

// ============ Leaderboard data-coverage dates ============
//
// The TRUE "how far back does the data go" for the leaderboard, so the UI can state it
// honestly instead of showing no coverage date at all. Two distinct sources:
//  - reportsSince = earliest daily_reports.date → how far back link VOLUME / reports go
//    (drives the main leaderboard: totalLinks, reports, streaks).
//  - metricsSince = earliest link_metrics.reportDate (status ok) → how far back ENGAGEMENT
//    data goes (drives the Top Links leaderboard: views/likes/comments). This is later
//    than reportsSince and only covers links that got enriched.
// Cheap: two indexed min() aggregates. Returns ISO date strings (YYYY-MM-DD) or null.
export async function getLeaderboardCoverage(): Promise<{
  reportsSince: string | null;
  metricsSince: string | null;
}> {
  const [reportMin, metricMin] = await Promise.all([
    prisma.dailyReport.aggregate({ _min: { date: true } }),
    prisma.linkMetric.aggregate({ where: { status: "ok" }, _min: { reportDate: true } }),
  ]);
  const toDay = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
  return {
    reportsSince: toDay(reportMin._min.date),
    metricsSince: toDay(metricMin._min.reportDate),
  };
}

// ============ Per-platform Top Links leaderboards (FAIR ranking) ============
//
// WHY: the combined Top Links board sums views+likes+comments across platforms, which is
// UNFAIR — the platforms don't expose the same metrics or scales (verified on prod):
//   - Instagram exposes NO views (0 of 11k rows) — only likes+comments.
//   - Facebook's raw numbers dwarf YouTube's (~30× views, ~190× likes on average).
// So a combined score structurally favors Facebook/YouTube over Instagram. The FAIR fix
// (no employee posts to all platforms; ≤2 platforms each, so fragmentation is mild) is a
// SEPARATE board per platform, each ranked by the metric that platform actually exposes:
//   - youtube  → ranked by VIEWS (likes/comments shown for context)
//   - facebook → ranked by VIEWS (FB has real views via the reel scraper; likes/comments shown)
//   - instagram→ ranked by LIKES+COMMENTS (no views exist — the UI omits a Views column)
//   - snapchat → ranked by VIEWS (Spotlight exposes views + comments + shares; NO likes)
// The combined board is KEPT but relabeled in the UI as raw cross-platform volume (not a
// fair ranking). Employees with zero engagement on a platform simply don't appear on it.
export type PlatformBoardKey = "youtube" | "facebook" | "instagram" | "snapchat";
export async function getPlatformLeaderboards(startDate?: string, endDate?: string): Promise<
  Record<PlatformBoardKey, Array<{
    rank: number;
    employee: { id: string; name: string; email: string; profileImageUrl: string | null };
    views: number; likes: number; comments: number; engagedLinkCount: number;
    rankMetric: number; // the value this board is ranked by (views, or likes+comments for IG)
  }>>
> {
  return memo(`platform-lb:${startDate ?? ""}:${endDate ?? ""}`, () => getPlatformLeaderboardsUncached(startDate, endDate));
}
async function getPlatformLeaderboardsUncached(startDate?: string, endDate?: string): Promise<
  Record<PlatformBoardKey, Array<{
    rank: number;
    employee: { id: string; name: string; email: string; profileImageUrl: string | null };
    views: number; likes: number; comments: number; engagedLinkCount: number;
    rankMetric: number;
  }>>
> {
  const [byEmpPlat, employees] = await Promise.all([
    getEngagementByEmployeePlatform(startDate, endDate),
    prisma.user.findMany({
      where: employeeWhere,
      select: { id: true, name: true, email: true, profileImageUrl: true },
    }),
  ]);
  const empById = new Map(employees.map((e) => [e.id, e]));

  const build = (plat: PlatformBoardKey, rankBy: (a: EngagementAgg) => number) => {
    const rows = [...byEmpPlat.entries()]
      .map(([empId, perPlat]) => {
        const agg = perPlat.get(plat);
        const employee = empById.get(empId);
        if (!agg || !employee || agg.linkCount === 0) return null;
        const rankMetric = rankBy(agg);
        if (rankMetric <= 0) return null; // no measurable engagement on this platform → omit
        return {
          employee,
          views: agg.views, likes: agg.likes, comments: agg.comments,
          engagedLinkCount: agg.linkCount, rankMetric,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => b.rankMetric - a.rankMetric || b.engagedLinkCount - a.engagedLinkCount);
    return rows.map((r, i) => ({ rank: i + 1, ...r }));
  };

  return {
    youtube: build("youtube", (a) => a.views),
    facebook: build("facebook", (a) => a.views),
    instagram: build("instagram", (a) => a.likes + a.comments), // IG has no views
    snapchat: build("snapchat", (a) => a.views), // Snapchat has views (no likes) — rank by views
  };
}
