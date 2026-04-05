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

export default router;
