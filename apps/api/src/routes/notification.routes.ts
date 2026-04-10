import { Router, Request, Response, NextFunction } from "express";
import { authenticateHr } from "../middleware/hr-auth";
import { authenticate } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";
import { success, error } from "../utils/response";
import {
  getUserNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  sendReportReminders,
  markMissedReports,
} from "../services/notification.service";

const router = Router();

// ===== Admin Notification Endpoints =====

// GET /admin/notifications — get notifications for authenticated admin user
router.get(
  "/admin/notifications",
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const unreadOnly = req.query.unreadOnly === "true";
      const notifications = await getUserNotifications(req.user!.userId, unreadOnly);
      return success(res, notifications);
    } catch (err) {
      next(err);
    }
  }
);

// GET /admin/notifications/count — unread count for admin
router.get(
  "/admin/notifications/count",
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const count = await getUnreadCount(req.user!.userId);
      return success(res, { count });
    } catch (err) {
      next(err);
    }
  }
);

// PUT /admin/notifications/read-all — mark all as read for admin
router.put(
  "/admin/notifications/read-all",
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await markAllAsRead(req.user!.userId);
      return success(res, result);
    } catch (err) {
      next(err);
    }
  }
);

// PUT /admin/notifications/:id/read — mark single as read for admin
router.put(
  "/admin/notifications/:id/read",
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await markAsRead(req.params.id, req.user!.userId);
      return success(res, result);
    } catch (err) {
      next(err);
    }
  }
);

// ===== HR Notification Endpoints =====

// GET /hr/notifications — get notifications for authenticated HR user
router.get(
  "/hr/notifications",
  authenticateHr,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const unreadOnly = req.query.unreadOnly === "true";
      const notifications = await getUserNotifications(req.user!.userId, unreadOnly);
      return success(res, notifications);
    } catch (err) {
      next(err);
    }
  }
);

// GET /hr/notifications/count — unread count
router.get(
  "/hr/notifications/count",
  authenticateHr,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const count = await getUnreadCount(req.user!.userId);
      return success(res, { count });
    } catch (err) {
      next(err);
    }
  }
);

// PUT /hr/notifications/read-all — mark all as read (must be before /:id/read)
router.put(
  "/hr/notifications/read-all",
  authenticateHr,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await markAllAsRead(req.user!.userId);
      return success(res, result);
    } catch (err) {
      next(err);
    }
  }
);

// PUT /hr/notifications/:id/read — mark single as read
router.put(
  "/hr/notifications/:id/read",
  authenticateHr,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await markAsRead(req.params.id, req.user!.userId);
      return success(res, result);
    } catch (err) {
      next(err);
    }
  }
);

// POST /admin/reports/send-reminders — trigger report reminders
router.post(
  "/admin/reports/send-reminders",
  authenticate,
  requirePermission("reports", "manage"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await sendReportReminders();
      return success(res, result);
    } catch (err) {
      next(err);
    }
  }
);

// POST /admin/reports/mark-missed — mark missed reports
router.post(
  "/admin/reports/mark-missed",
  authenticate,
  requirePermission("reports", "manage"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { date } = req.body;
      if (!date) {
        return error(res, "VALIDATION_ERROR", "date is required in request body", 400);
      }
      const result = await markMissedReports(date);
      return success(res, result);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
