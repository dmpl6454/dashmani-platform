import { Router, Request, Response, NextFunction } from "express";
import { authenticateHr } from "../middleware/hr-auth";
import { validate } from "../middleware/validate";
import { submitDailyReportSchema, updateProfileSchema } from "@dashmani/shared";
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
import { getLeaderboard, getTeamDashboard } from "../services/leaderboard.service";
import { getProfile, updateProfile } from "../services/employee-profile.service";
import { success } from "../utils/response";

const router = Router();

// ===== Profile =====

// GET /hr/profile — get own profile
router.get("/hr/profile", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const profile = await getProfile(req.user!.userId);
    return success(res, profile);
  } catch (err) {
    next(err);
  }
});

// PUT /hr/profile — update own profile (bank details, ID proofs, family contacts)
router.put(
  "/hr/profile",
  authenticateHr,
  validate(updateProfileSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const profile = await updateProfile(req.user!.userId, req.body);
      return success(res, profile);
    } catch (err) {
      next(err);
    }
  },
);

// ===== Accounts =====

// GET /hr/accounts — assigned accounts for authenticated HR user
router.get("/hr/accounts", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const accounts = await getAssignedAccounts(req.user!.userId);
    return success(res, accounts);
  } catch (err) {
    next(err);
  }
});

// ===== Reports =====

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

// ===== Growth =====

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

// ===== Leaderboard & Team =====

// GET /hr/leaderboard — performance leaderboard
router.get("/hr/leaderboard", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { startDate, endDate } = req.query as { startDate?: string; endDate?: string };
    const leaderboard = await getLeaderboard(startDate, endDate);
    return success(res, leaderboard);
  } catch (err) {
    next(err);
  }
});

// GET /hr/team — team dashboard for current user
router.get("/hr/team", authenticateHr, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dashboard = await getTeamDashboard(req.user!.userId);
    return success(res, dashboard);
  } catch (err) {
    next(err);
  }
});

export default router;
