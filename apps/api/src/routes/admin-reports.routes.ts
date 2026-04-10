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

// ===== Employee Approval =====

// GET /admin/employees/pending — list pending employee registrations
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

export default router;
