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

// ⚠️ Do NOT re-add a GET /client/analytics here. client.routes.ts mounts FIRST
// (see routes/index.ts) and serves /client/analytics via
// getClientContentAnalytics — a duplicate here is SHADOWED DEAD CODE (the same
// trap as the shadowed HR /hr/reports handlers removed in PR #33). The old
// duplicate that lived here called getClientAnalytics, which carried an
// unbounded 2-queries-per-project N+1 — both removed 2026-07-20.

export default router;
