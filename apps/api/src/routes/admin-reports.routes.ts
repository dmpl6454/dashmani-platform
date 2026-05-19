import { Router, Request, Response, NextFunction } from "express";
import { authenticate } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";
import { validate } from "../middleware/validate";
import { adminReportFilterSchema } from "@dashmani/shared";
import {
  getAllReports,
  getReportById,
  getReportSummary,
} from "../services/daily-report.service";
import { recordGrowthSnapshot } from "../services/account-growth.service";
import { getLeaderboard } from "../services/leaderboard.service";
import {
  getPendingEmployees,
  approveEmployee,
  rejectEmployee,
  adminUpdateProfile,
} from "../services/employee-profile.service";
import { getEmployeePerformance } from "../services/employee-performance.service";
import { success } from "../utils/response";
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
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 29);
      thirtyDaysAgo.setHours(0, 0, 0, 0);
      const twelveWeeksAgo = new Date();
      twelveWeeksAgo.setDate(twelveWeeksAgo.getDate() - 83);
      twelveWeeksAgo.setHours(0, 0, 0, 0);

      const [allReports, recentLinks] = await Promise.all([
        prisma.dailyReport.findMany({
          where: { employeeId },
          select: { date: true, _count: { select: { links: true } } },
          orderBy: { date: "asc" },
        }),
        prisma.reportLink.findMany({
          where: { report: { employeeId, date: { gte: thirtyDaysAgo } } },
          select: { platform: true, createdAt: true, report: { select: { date: true } } },
        }),
      ]);

      const totalReports = allReports.length;
      const totalLinks = allReports.reduce((s, r) => s + r._count.links, 0);
      const { currentStreak, longestStreak } = calcStreaks(allReports.map((r) => r.date));
      const avgLinksPerDay = totalReports > 0 ? Math.round((totalLinks / totalReports) * 10) / 10 : 0;

      // Days since first report for submission rate
      const firstReport = allReports[0];
      let submissionRate = 0;
      if (firstReport) {
        const daysSince = Math.max(1, Math.ceil((Date.now() - new Date(firstReport.date).getTime()) / 86400000));
        submissionRate = Math.round((totalReports / daysSince) * 100);
      }

      // 30-day daily trend
      const dailyMap: Record<string, number> = {};
      for (const r of allReports.filter((r) => new Date(r.date) >= thirtyDaysAgo)) {
        const d = new Date(r.date).toISOString().split("T")[0];
        dailyMap[d] = (dailyMap[d] || 0) + r._count.links;
      }
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const dailyTrend: { date: string; linkCount: number }[] = [];
      for (let i = 29; i >= 0; i--) {
        const d = new Date(today.getTime() - i * 86400000).toISOString().split("T")[0];
        dailyTrend.push({ date: d, linkCount: dailyMap[d] || 0 });
      }

      // 12-week weekly trend
      const weeklyMap: Record<string, number> = {};
      for (const r of allReports.filter((r) => new Date(r.date) >= twelveWeeksAgo)) {
        const d = new Date(r.date);
        d.setHours(0, 0, 0, 0);
        const dayOfWeek = d.getDay();
        const weekStart = new Date(d.getTime() - dayOfWeek * 86400000).toISOString().split("T")[0];
        weeklyMap[weekStart] = (weeklyMap[weekStart] || 0) + r._count.links;
      }
      const weeklyTrend = Object.entries(weeklyMap)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([week, linkCount]) => ({ week, linkCount }));

      // Platform breakdown
      const platformMap: Record<string, number> = {};
      for (const link of recentLinks) {
        const p = link.platform || "Unknown";
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
      const now = new Date();
      const end = endDate ? new Date(endDate) : now;
      end.setHours(23, 59, 59, 999);
      const start = startDate ? new Date(startDate) : new Date(now.getTime() - 29 * 86400000);
      start.setHours(0, 0, 0, 0);

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
        prisma.user.findMany({ where: { status: "ACTIVE", deletedAt: null }, select: { id: true, name: true, orgUnitId: true } }),
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
          const p = link.platform || "Unknown";
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
        const d = new Date(start.getTime() + i * 86400000).toISOString().split("T")[0];
        dailyTrend.push({ date: d, ...(dailyMap[d] || { linkCount: 0, reportCount: 0 }) });
      }

      // Weekly trend
      const weeklyMap: Record<string, number> = {};
      for (const { date, linkCount } of dailyTrend) {
        const d = new Date(date);
        const dayOfWeek = d.getDay();
        const weekStart = new Date(d.getTime() - dayOfWeek * 86400000).toISOString().split("T")[0];
        weeklyMap[weekStart] = (weeklyMap[weekStart] || 0) + linkCount;
      }
      const weeklyTrend = Object.entries(weeklyMap)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([weekStart, linkCount]) => ({ weekStart, linkCount }));

      // Growth rate
      const currentTotal = dailyTrend.reduce((s, d) => s + d.linkCount, 0);
      const growthRate = prevLinks > 0 ? Math.round(((currentTotal - prevLinks) / prevLinks) * 100) : null;
      const avgLinksPerDay = dayCount > 0 ? Math.round((currentTotal / dayCount) * 10) / 10 : 0;

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
