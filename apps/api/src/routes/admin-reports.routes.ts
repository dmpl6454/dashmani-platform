import { Router, Request, Response, NextFunction } from "express";
import { authenticate } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";
import { validate } from "../middleware/validate";
import { adminReportFilterSchema, todayIST, istMidnight, dateToIST } from "@dashmani/shared";
import {
  getAllReports,
  getReportById,
  getReportSummary,
} from "../services/daily-report.service";
import { recordGrowthSnapshot, getGrowthOverview, getAccountGrowth } from "../services/account-growth.service";
import { getAllAccountsLinkStats } from "../services/account.service";
import { generateReportsExport } from "../services/report-export.service";
import { getLeaderboard } from "../services/leaderboard.service";
import {
  getPendingEmployees,
  approveEmployee,
  rejectEmployee,
  adminUpdateProfile,
} from "../services/employee-profile.service";
import { getEmployeePerformance } from "../services/employee-performance.service";
import { success, error } from "../utils/response";
import { calcStreaks } from "../utils/streak";
import { prisma } from "@dashmani/db";

const router = Router();

// GET /admin/reports — filtered reports
router.get(
  "/admin/reports",
  authenticate,
  requirePermission("reports", "view"),
  validate(adminReportFilterSchema, "query"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const filters = req.query as any;
      const reports = await getAllReports(filters);
      return success(res, reports);
    } catch (err) {
      next(err);
    }
  },
);

// GET /admin/reports/summary — per-employee summary
router.get(
  "/admin/reports/summary",
  authenticate,
  requirePermission("reports", "view"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { startDate, endDate } = req.query as { startDate?: string; endDate?: string };
      const summary = await getReportSummary(startDate, endDate);
      return success(res, summary);
    } catch (err) {
      next(err);
    }
  },
);

// GET /admin/reports/employee-stats/:employeeId — per-employee analytics
router.get(
  "/admin/reports/employee-stats/:employeeId",
  authenticate,
  requirePermission("reports", "view"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { employeeId } = req.params;
      const { startDate, endDate } = req.query as { startDate?: string; endDate?: string };
      const todayDate = istMidnight(todayIST());

      // Window: defaults to last 30 days when no range is supplied.
      const end = endDate ? new Date(endDate) : todayDate;
      const start = startDate ? new Date(startDate) : new Date(todayDate.getTime() - 29 * 86400000);
      const rangeMs = end.getTime() - start.getTime();
      const windowDays = Math.max(1, Math.ceil(rangeMs / 86400000) + 1);

      // allReports: lifetime, used for streaks (an inherently all-time concept).
      // windowReports: scoped to [start, end], drives every windowed stat below.
      const [allReports, windowLinks] = await Promise.all([
        prisma.dailyReport.findMany({
          where: { employeeId },
          select: { date: true, _count: { select: { links: true } } },
          orderBy: { date: "asc" },
        }),
        prisma.reportLink.findMany({
          where: { report: { employeeId, date: { gte: start, lte: end } } },
          select: { platform: true, report: { select: { date: true } } },
        }),
      ]);

      const windowReports = allReports.filter((r) => {
        const t = new Date(r.date).getTime();
        return t >= start.getTime() && t <= end.getTime();
      });

      const totalReports = windowReports.length;
      const totalLinks = windowReports.reduce((s, r) => s + r._count.links, 0);
      // Streaks remain all-time — a current streak is meaningless when scoped to a window.
      const { currentStreak, longestStreak } = calcStreaks(allReports.map((r) => r.date));
      const avgLinksPerDay = totalReports > 0 ? Math.round((totalLinks / totalReports) * 10) / 10 : 0;

      // Submission rate = reporting days / window days (capped at 100%).
      const submissionRate = windowDays > 0 ? Math.min(100, Math.round((totalReports / windowDays) * 100)) : 0;

      // Daily trend across the full window (zero-filled).
      const dailyMap: Record<string, number> = {};
      for (const r of windowReports) {
        const d = dateToIST(new Date(r.date));
        dailyMap[d] = (dailyMap[d] || 0) + r._count.links;
      }
      const dailyTrend: { date: string; linkCount: number }[] = [];
      // Cap zero-fill to a sane number of buckets so a "Year" range doesn't return 365 points.
      const fillDays = Math.min(windowDays, 90);
      for (let i = fillDays - 1; i >= 0; i--) {
        const d = dateToIST(new Date(end.getTime() - i * 86400000));
        dailyTrend.push({ date: d, linkCount: dailyMap[d] || 0 });
      }

      // Weekly trend across the window.
      const weeklyMap: Record<string, number> = {};
      for (const r of windowReports) {
        const d = new Date(r.date);
        const dayOfWeek = d.getUTCDay();
        const weekStart = dateToIST(new Date(d.getTime() - dayOfWeek * 86400000));
        weeklyMap[weekStart] = (weeklyMap[weekStart] || 0) + r._count.links;
      }
      const weeklyTrend = Object.entries(weeklyMap)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([week, linkCount]) => ({ week, linkCount }));

      // Platform breakdown (windowed). Lowercase so "Instagram" and "instagram"
      // (mixed-case rows in report_links.platform) collapse into one bucket.
      const platformMap: Record<string, number> = {};
      for (const link of windowLinks) {
        const p = (link.platform || "Unknown").toLowerCase();
        platformMap[p] = (platformMap[p] || 0) + 1;
      }
      const platformBreakdown = Object.entries(platformMap)
        .sort(([, a], [, b]) => b - a)
        .map(([platform, count]) => ({ platform, count }));

      const bestChannel = platformBreakdown[0] || null;
      const worstChannel = platformBreakdown.length > 1 ? platformBreakdown[platformBreakdown.length - 1] : null;

      return success(res, {
        totalReports, totalLinks, currentStreak, longestStreak,
        avgLinksPerDay, submissionRate,
        dailyTrend, weeklyTrend, platformBreakdown, bestChannel, worstChannel,
        windowDays,
      });
    } catch (err) { next(err); }
  },
);

// GET /admin/reports/links-analytics — org-wide links analytics
router.get(
  "/admin/reports/links-analytics",
  authenticate,
  requirePermission("reports", "view"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { startDate, endDate } = req.query as { startDate?: string; endDate?: string };
      const todayL = istMidnight(todayIST());
      const end = endDate ? new Date(endDate) : todayL;
      const start = startDate ? new Date(startDate) : new Date(todayL.getTime() - 29 * 86400000);

      const rangeMs = end.getTime() - start.getTime();
      const prevEnd = new Date(start.getTime() - 1);
      const prevStart = new Date(start.getTime() - rangeMs - 86400000);

      const [reports, prevLinks, activeEmployees, teams] = await Promise.all([
        prisma.dailyReport.findMany({
          where: { date: { gte: start, lte: end } },
          select: {
            date: true,
            employeeId: true,
            employee: { select: { id: true, name: true, orgUnitId: true } },
            links: { select: { id: true, platform: true } },
          },
          orderBy: { date: "asc" },
        }),
        prisma.reportLink.count({ where: { report: { date: { gte: prevStart, lte: prevEnd } } } }),
        prisma.user.findMany({
          where: {
            status: "ACTIVE",
            deletedAt: null,
            roles: {
              some: { role: { name: { notIn: ["Super Admin", "Admin"] } } },
            },
          },
          select: { id: true, name: true, orgUnitId: true },
        }),
        prisma.orgUnit.findMany({ where: { type: "TEAM" }, select: { id: true, name: true, _count: { select: { members: true } } } }),
      ]);

      // Daily trend
      const dailyMap: Record<string, { linkCount: number; reportCount: number }> = {};
      const employeeLinkMap: Record<string, { name: string; totalLinks: number; reportCount: number }> = {};
      const platformMap: Record<string, number> = {};
      const teamLinkMap: Record<string, number> = {};

      for (const report of reports) {
        const d = new Date(report.date).toISOString().split("T")[0];
        if (!dailyMap[d]) dailyMap[d] = { linkCount: 0, reportCount: 0 };
        dailyMap[d].linkCount += report.links.length;
        dailyMap[d].reportCount += 1;

        if (!employeeLinkMap[report.employeeId]) {
          employeeLinkMap[report.employeeId] = { name: report.employee.name, totalLinks: 0, reportCount: 0 };
        }
        employeeLinkMap[report.employeeId].totalLinks += report.links.length;
        employeeLinkMap[report.employeeId].reportCount += 1;

        for (const link of report.links) {
          const p = (link.platform || "Unknown").toLowerCase();
          platformMap[p] = (platformMap[p] || 0) + 1;
          if (report.employee.orgUnitId) {
            teamLinkMap[report.employee.orgUnitId] = (teamLinkMap[report.employee.orgUnitId] || 0) + 1;
          }
        }
      }

      // Fill daily trend with zeroes
      const dailyTrend: { date: string; linkCount: number; reportCount: number }[] = [];
      const dayCount = Math.ceil(rangeMs / 86400000) + 1;
      for (let i = 0; i < dayCount; i++) {
        const d = dateToIST(new Date(start.getTime() + i * 86400000));
        dailyTrend.push({ date: d, ...(dailyMap[d] || { linkCount: 0, reportCount: 0 }) });
      }

      // Weekly trend
      const weeklyMap: Record<string, number> = {};
      for (const { date, linkCount } of dailyTrend) {
        const d = new Date(date);
        const dayOfWeek = d.getUTCDay();
        const weekStart = dateToIST(new Date(d.getTime() - dayOfWeek * 86400000));
        weeklyMap[weekStart] = (weeklyMap[weekStart] || 0) + linkCount;
      }
      const weeklyTrend = Object.entries(weeklyMap)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([weekStart, linkCount]) => ({ weekStart, linkCount }));

      // Growth rate
      const currentTotal = dailyTrend.reduce((s, d) => s + d.linkCount, 0);
      const growthRate = prevLinks > 0 ? Math.round(((currentTotal - prevLinks) / prevLinks) * 100) : null;
      const activeDays = dailyTrend.filter((d) => d.reportCount > 0).length;
      const avgLinksPerDay = activeDays > 0 ? Math.round((currentTotal / activeDays) * 10) / 10 : 0;

      // Platform breakdown
      const totalPlatformLinks = Object.values(platformMap).reduce((s, v) => s + v, 0);
      const platformBreakdown = Object.entries(platformMap)
        .sort(([, a], [, b]) => b - a)
        .map(([platform, count]) => ({ platform, count, pct: totalPlatformLinks > 0 ? Math.round((count / totalPlatformLinks) * 100) : 0 }));
      const bestChannel = platformBreakdown[0] || null;
      const worstChannel = platformBreakdown.length > 1 ? platformBreakdown[platformBreakdown.length - 1] : null;

      // Team ranks
      const teamRanks = teams
        .map((t) => ({
          teamId: t.id,
          teamName: t.name,
          memberCount: t._count.members,
          totalLinks: teamLinkMap[t.id] || 0,
          avgLinksPerMember: t._count.members > 0 ? Math.round(((teamLinkMap[t.id] || 0) / t._count.members) * 10) / 10 : 0,
        }))
        .sort((a, b) => b.totalLinks - a.totalLinks);

      // Top submitters
      const topSubmitters = Object.entries(employeeLinkMap)
        .sort(([, a], [, b]) => b.totalLinks - a.totalLinks)
        .slice(0, 10)
        .map(([employeeId, data]) => ({ employeeId, name: data.name, totalLinks: data.totalLinks, reportCount: data.reportCount }));

      // Non-submitters
      const submittedIds = new Set(Object.keys(employeeLinkMap));
      const nonSubmitters = activeEmployees
        .filter((e) => !submittedIds.has(e.id))
        .map((e) => ({ employeeId: e.id, name: e.name }));

      return success(res, {
        dailyTrend, weeklyTrend, growthRate, avgLinksPerDay,
        platformBreakdown, bestChannel, worstChannel,
        teamRanks, topSubmitters, nonSubmitters,
        totalLinks: currentTotal,
      });
    } catch (err) { next(err); }
  },
);

// GET /admin/reports/links-by-account — all accounts ranked by links, with per-employee breakdown
router.get(
  "/admin/reports/links-by-account",
  authenticate,
  requirePermission("reports", "view"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { startDate, endDate } = req.query as { startDate?: string; endDate?: string };
      const stats = await getAllAccountsLinkStats(startDate, endDate);
      return success(res, stats);
    } catch (err) { next(err); }
  },
);

// GET /admin/reports/export.xlsx — two-sheet workbook (Channel Summary + Day-wise
// Breakdown) for the selected window. Returns a binary .xlsx download, NOT the
// JSON envelope. MUST be declared before /:reportId or Express captures it.
router.get(
  "/admin/reports/export.xlsx",
  authenticate,
  requirePermission("reports", "view"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { startDate, endDate } = req.query as { startDate?: string; endDate?: string };
      const { buffer, filename } = await generateReportsExport(startDate, endDate);
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      // Expose the filename header to the browser fetch so the client can read it.
      res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
      res.setHeader("Content-Length", String(buffer.length));
      return res.status(200).send(buffer);
    } catch (err) {
      next(err);
    }
  },
);

// GET /admin/reports/leaderboard — MUST be before /:reportId
router.get(
  "/admin/reports/leaderboard",
  authenticate,
  requirePermission("reports", "view"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { startDate, endDate } = req.query as { startDate?: string; endDate?: string };
      const leaderboard = await getLeaderboard(startDate, endDate);
      return success(res, leaderboard);
    } catch (err) {
      next(err);
    }
  },
);

// ===== Social Insights — MUST be before /:reportId and links/:linkId =====

// GET /admin/reports/insights-summary?startDate&endDate&employeeId — aggregated engagement metrics
router.get(
  "/admin/reports/insights-summary",
  authenticate,
  requirePermission("reports", "view"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { startDate, endDate, employeeId } = req.query as Record<string, string | undefined>;
      const { getInsightsSummary } = await import("../services/social-insights.service");
      const summary = await getInsightsSummary({ startDate, endDate, employeeId });
      return success(res, summary);
    } catch (err) {
      next(err);
    }
  },
);

// GET /admin/reports/top-youtube-links?startDate&endDate&limit — top YouTube links by views
router.get(
  "/admin/reports/top-youtube-links",
  authenticate,
  requirePermission("reports", "view"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { startDate, endDate, limit } = req.query as Record<string, string | undefined>;
      const { getTopYouTubeLinks } = await import("../services/social-insights.service");
      const links = await getTopYouTubeLinks({
        startDate,
        endDate,
        limit: limit ? parseInt(limit, 10) : 20,
      });
      return success(res, links);
    } catch (err) {
      next(err);
    }
  },
);

// GET /admin/reports/top-links?platform&startDate&endDate&limit — top links for ANY
// supported platform (youtube=by views, instagram/facebook=by likes+comments).
// One endpoint behind every "Top <Platform> Links" panel. A platform with no
// enriched metrics for the window returns [] and the UI simply shows no rows.
router.get(
  "/admin/reports/top-links",
  authenticate,
  requirePermission("reports", "view"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { platform, startDate, endDate, limit } = req.query as Record<string, string | undefined>;
      if (!platform) {
        return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: "platform is required" } });
      }
      const { getTopLinksByPlatform } = await import("../services/social-insights.service");
      const links = await getTopLinksByPlatform({
        platform,
        startDate,
        endDate,
        limit: limit ? parseInt(limit, 10) : 20,
      });
      return success(res, links);
    } catch (err) {
      next(err);
    }
  },
);

// ===== Link entity search (Stage 3) =====
// Grouped here by convention with the other admin search/report routes for
// readability. The 2nd path segment ("link-search" / "entities") differs from
// "reports/:reportId", so route order relative to /:reportId is irrelevant to
// matching — /:reportId can never capture these regardless of placement.

// GET /admin/link-search?q&from&to&platform — search uploaded links by entity
// (person/topic). Reports same-vs-unique counts; never dedupes rows away.
router.get(
  "/admin/link-search",
  authenticate,
  requirePermission("reports", "view"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { q, from, to, platform } = req.query as Record<string, string | undefined>;
      const { searchLinksByEntity } = await import("../services/link-search.service");
      if (!q || !q.trim()) {
        // An empty query is NOT an error — still return coverage so the UI can
        // explain an empty result ("0 — but only N of M enriched").
        return success(res, await searchLinksByEntity({ q: "" }));
      }
      return success(res, await searchLinksByEntity({ q, from, to, platform }));
    } catch (err) {
      next(err);
    }
  },
);

// GET /admin/entities?q — entity autocomplete for the search typeahead.
router.get(
  "/admin/entities",
  authenticate,
  requirePermission("reports", "view"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const q = ((req.query.q as string) || "").trim();
      // Autocomplete with no query is a genuine bad request (nothing to match),
      // unlike /admin/link-search whose empty-q still returns coverage.
      if (!q) {
        return error(res, "VALIDATION_ERROR", "Query parameter 'q' is required", 400);
      }
      const { listEntities } = await import("../services/link-search.service");
      return success(res, await listEntities(q));
    } catch (err) {
      next(err);
    }
  },
);

// POST /admin/insights/refresh — trigger an on-demand enrichment pass (harvest + extract).
// Returns 202 when a new run is started, 200 when one is already in flight.
router.post(
  "/admin/insights/refresh",
  authenticate,
  requirePermission("reports", "view"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { triggerInsightsRun, getInsightsRunState } = await import("../services/insights-runner");
      const result = triggerInsightsRun("manual");
      return success(res, { ...result, state: getInsightsRunState() }, undefined, result.started ? 202 : 200);
    } catch (err) {
      next(err);
    }
  },
);

// GET /admin/insights/status — poll the current enrichment run state.
router.get(
  "/admin/insights/status",
  authenticate,
  requirePermission("reports", "view"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { getInsightsRunState } = await import("../services/insights-runner");
      return success(res, getInsightsRunState());
    } catch (err) {
      next(err);
    }
  },
);

// GET /admin/reports/:reportId
router.get(
  "/admin/reports/:reportId",
  authenticate,
  requirePermission("reports", "view"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const report = await getReportById(req.params.reportId);
      return success(res, report);
    } catch (err) {
      next(err);
    }
  },
);

// GET /admin/reports/links/:linkId/metrics — MUST be before DELETE links/:linkId
router.get(
  "/admin/reports/links/:linkId/metrics",
  authenticate,
  requirePermission("reports", "view"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { getLinkMetricsHistory } = await import("../services/social-insights.service");
      const history = await getLinkMetricsHistory(req.params.linkId);
      return success(res, history);
    } catch (err) {
      next(err);
    }
  },
);

// DELETE /admin/reports/links/:linkId — admin/super admin only
router.delete(
  "/admin/reports/links/:linkId",
  authenticate,
  requirePermission("reports", "manage"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { linkId } = req.params;

      const link = await prisma.reportLink.findUnique({
        where: { id: linkId },
        select: { id: true, reportId: true },
      });
      if (!link) {
        return res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Link not found" } });
      }

      await prisma.reportLink.delete({ where: { id: linkId } });

      // If the report is now empty, delete it too so it doesn't ghost the employee's record
      const remaining = await prisma.reportLink.count({ where: { reportId: link.reportId } });
      if (remaining === 0) {
        await prisma.dailyReport.delete({ where: { id: link.reportId } });
      }

      return success(res, { deleted: true, reportDeleted: remaining === 0 });
    } catch (err) {
      next(err);
    }
  },
);

// GET /admin/link-preview?url=... — fetch OG metadata for link preview
router.get(
  "/admin/link-preview",
  authenticate,
  async (req: Request, res: Response) => {
    const url = req.query.url as string;
    if (!url) return res.status(400).json({ success: false, error: { message: "url is required" } });

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; LinkPreview/1.0)",
          "Accept": "text/html",
        },
        redirect: "follow",
      });
      clearTimeout(timeout);

      const html = await response.text();
      const slice = html.slice(0, 50000); // Only parse head section

      const ogImage = slice.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i)?.[1]
        || slice.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i)?.[1];
      const ogTitle = slice.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i)?.[1]
        || slice.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:title["']/i)?.[1];
      const ogDesc = slice.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i)?.[1]
        || slice.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:description["']/i)?.[1];

      res.setHeader("Cache-Control", "public, max-age=86400");
      return res.json({ success: true, data: { image: ogImage || null, title: ogTitle || null, description: ogDesc || null } });
    } catch {
      return res.json({ success: true, data: { image: null, title: null, description: null } });
    }
  },
);

// ===== Follower growth =====

// GET /admin/growth?days=30 — org-wide follower-growth overview.
// Declared before /admin/growth/:accountId, but they can't collide anyway
// ("record" is a POST; this is a fixed path, the dynamic one is a separate GET).
router.get(
  "/admin/growth",
  authenticate,
  requirePermission("reports", "view"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = req.query.days ? parseInt(String(req.query.days), 10) : 30;
      const days = Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
      const overview = await getGrowthOverview(days);
      return success(res, overview);
    } catch (err) {
      next(err);
    }
  },
);

// GET /admin/growth/:accountId?days=30 — per-account follower trend.
router.get(
  "/admin/growth/:accountId",
  authenticate,
  requirePermission("reports", "view"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = req.query.days ? parseInt(String(req.query.days), 10) : 30;
      const days = Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
      const growth = await getAccountGrowth(req.params.accountId, days);
      return success(res, growth);
    } catch (err) {
      next(err);
    }
  },
);

// POST /admin/growth/record
router.post(
  "/admin/growth/record",
  authenticate,
  requirePermission("reports", "manage"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { accountId, ...data } = req.body;
      if (!accountId) {
        return res.status(400).json({
          success: false,
          error: { code: "VALIDATION_ERROR", message: "accountId is required" },
        });
      }
      const snapshot = await recordGrowthSnapshot(accountId, data);
      return success(res, snapshot, undefined, 201);
    } catch (err) {
      next(err);
    }
  },
);

// ===== Employee Approval =====

// GET /admin/employees/pending — MUST be before /:employeeId/performance to avoid param shadowing
router.get(
  "/admin/employees/pending",
  authenticate,
  requirePermission("employees", "edit"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const employees = await getPendingEmployees();
      return success(res, employees);
    } catch (err) {
      next(err);
    }
  },
);

// GET /admin/employees/:employeeId/performance — comprehensive performance data
router.get(
  "/admin/employees/:employeeId/performance",
  authenticate,
  requirePermission("reports", "view"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = await getEmployeePerformance(req.params.employeeId);
      return success(res, data);
    } catch (err) {
      next(err);
    }
  },
);

// PUT /admin/employees/:userId/approve — approve an employee
router.put(
  "/admin/employees/:userId/approve",
  authenticate,
  requirePermission("employees", "edit"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await approveEmployee(req.params.userId);
      return success(res, result);
    } catch (err) {
      next(err);
    }
  },
);

// PUT /admin/employees/:userId/reject — reject an employee
router.put(
  "/admin/employees/:userId/reject",
  authenticate,
  requirePermission("employees", "edit"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await rejectEmployee(req.params.userId);
      return success(res, result);
    } catch (err) {
      next(err);
    }
  },
);

// PUT /admin/employees/:userId/profile — admin update employee profile (designation, salary, etc.)
router.put(
  "/admin/employees/:userId/profile",
  authenticate,
  requirePermission("employees", "edit"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await adminUpdateProfile(req.params.userId, req.body);
      return success(res, result);
    } catch (err) {
      next(err);
    }
  },
);

// PUT /admin/employees/:userId/profile-data — admin update employee submitted data (bank, ID, contacts)
router.put(
  "/admin/employees/:userId/profile-data",
  authenticate,
  requirePermission("employees", "edit"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const allowed = [
        "bankName", "bankAccountNumber", "bankAccountHolderName", "bankBranch", "ifscCode",
        "panNumber", "aadhaarNumber", "mailingAddress",
        "familyContact1Name", "familyContact1Phone", "familyContact1Relation",
        "familyContact2Name", "familyContact2Phone", "familyContact2Relation",
      ];
      const data: Record<string, any> = {};
      for (const key of allowed) {
        if (req.body[key] !== undefined) data[key] = req.body[key];
      }
      const result = await adminUpdateProfile(req.params.userId, data);
      return success(res, result);
    } catch (err) {
      next(err);
    }
  },
);

export default router;
