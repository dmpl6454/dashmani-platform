import { Router, Request, Response, NextFunction } from "express";
import { authenticateHr } from "../middleware/hr-auth";
import { validate } from "../middleware/validate";
import { submitDailyReportSchema } from "@dashmani/shared";
import {
  getAssignedAccounts,
  submitDailyReport,
  getMyReports,
  getTodayReport,
} from "../services/daily-report.service";
import {
  getGrowthForEmployee,
  getAccountGrowth,
} from "../services/account-growth.service";
import { success } from "../utils/response";

const router = Router();

// GET /hr/accounts — assigned accounts for authenticated HR user
router.get("/hr/accounts", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const accounts = await getAssignedAccounts(req.user!.userId);
    return success(res, accounts);
  } catch (err) {
    next(err);
  }
});

// GET /hr/reports/today
router.get("/hr/reports/today", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const report = await getTodayReport(req.user!.userId);
    return success(res, report);
  } catch (err) {
    next(err);
  }
});

// GET /hr/reports — history (last 30)
router.get("/hr/reports", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { startDate, endDate } = req.query as { startDate?: string; endDate?: string };
    const reports = await getMyReports(req.user!.userId, startDate, endDate);
    return success(res, reports);
  } catch (err) {
    next(err);
  }
});

// POST /hr/reports — submit daily report
router.post(
  "/hr/reports",
  authenticateHr,
  validate(submitDailyReportSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { date, links, notes, latitude, longitude } = req.body;
      const report = await submitDailyReport(
        req.user!.userId,
        date,
        links,
        notes,
        latitude,
        longitude,
      );
      return success(res, report, undefined, 201);
    } catch (err) {
      next(err);
    }
  },
);

// GET /hr/growth — all assigned accounts growth
router.get("/hr/growth", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const days = req.query.days ? parseInt(req.query.days as string) : 30;
    const growth = await getGrowthForEmployee(req.user!.userId, days);
    return success(res, growth);
  } catch (err) {
    next(err);
  }
});

// GET /hr/growth/:accountId — specific account growth
router.get("/hr/growth/:accountId", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const days = req.query.days ? parseInt(req.query.days as string) : 30;
    const growth = await getAccountGrowth(req.params.accountId, days);
    return success(res, growth);
  } catch (err) {
    next(err);
  }
});

export default router;
