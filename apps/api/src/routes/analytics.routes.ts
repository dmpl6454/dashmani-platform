import { Router, Request, Response, NextFunction } from "express";
import { authenticate } from "../middleware/auth";
import { authenticateClient } from "../middleware/client-auth";
import { requirePermission } from "../middleware/rbac";
import * as analyticsService from "../services/analytics.service";
import { success } from "../utils/response";

const router = Router();

// ===== Internal Analytics Endpoints =====

router.get(
  "/analytics/overview",
  authenticate,
  requirePermission("analytics", "view"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const stats = await analyticsService.getOverviewStats(
        req.query.startDate as string | undefined,
        req.query.endDate as string | undefined,
      );
      return success(res, stats);
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/analytics/tasks",
  authenticate,
  requirePermission("analytics", "view"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const stats = await analyticsService.getTaskAnalytics({
        projectId: req.query.projectId as string,
      });
      return success(res, stats);
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/analytics/content",
  authenticate,
  requirePermission("analytics", "view"),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const stats = await analyticsService.getContentAnalytics();
      return success(res, stats);
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/analytics/projects",
  authenticate,
  requirePermission("analytics", "view"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const stats = await analyticsService.getProjectAnalytics(
        req.query.projectId as string
      );
      return success(res, stats);
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  "/analytics/attendance",
  authenticate,
  requirePermission("analytics", "view"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const stats = await analyticsService.getAttendanceAnalytics({
        startDate: req.query.startDate as string,
        endDate: req.query.endDate as string,
      });
      return success(res, stats);
    } catch (err) {
      next(err);
    }
  }
);

// ===== Client Analytics Endpoint =====

router.get(
  "/client/analytics",
  authenticateClient,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const clientId = (req as any).client.id;
      const stats = await analyticsService.getClientAnalytics(clientId);
      return success(res, stats);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
