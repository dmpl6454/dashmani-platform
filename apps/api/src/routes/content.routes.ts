import { Router, Request, Response, NextFunction } from "express";
import { authenticate } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit-log";
import { contentValidators } from "@dashmani/shared";
import * as contentService from "../services/content.service";
import { success } from "../utils/response";
import { parsePagination } from "../utils/pagination";

const router = Router();

// List content posts with filters
router.get(
  "/content",
  authenticate,
  requirePermission("content", "view"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const pagination = parsePagination(req.query as any);
      const result = await contentService.listContentPosts({
        ...pagination,
        projectId: req.query.projectId as string,
        accountId: req.query.accountId as string,
        status: req.query.status as string,
        search: req.query.search as string,
        dateFrom: req.query.dateFrom as string,
        dateTo: req.query.dateTo as string,
      });
      return success(res, result.items, result.meta);
    } catch (err) {
      next(err);
    }
  }
);

// Get calendar data for a given month
router.get(
  "/content/calendar",
  authenticate,
  requirePermission("content", "view"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const year = Number(req.query.year);
      const month = Number(req.query.month);
      if (!year || !month || month < 1 || month > 12) {
        return success(res, null, undefined, 400);
      }
      const data = await contentService.getCalendarData({
        year,
        month,
        projectId: req.query.projectId as string,
      });
      return success(res, data);
    } catch (err) {
      next(err);
    }
  }
);

// Get a single content post
router.get(
  "/content/:id",
  authenticate,
  requirePermission("content", "view"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const post = await contentService.getContentPostById(req.params.id);
      return success(res, post);
    } catch (err) {
      next(err);
    }
  }
);

// Create a content post
router.post(
  "/content",
  authenticate,
  requirePermission("content", "create"),
  validate(contentValidators.createContentPostSchema),
  auditLog("content", "create"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const post = await contentService.createContentPost({
        ...req.body,
        createdById: req.user!.userId,
      });
      return success(res, post, undefined, 201);
    } catch (err) {
      next(err);
    }
  }
);

// Update a content post
router.put(
  "/content/:id",
  authenticate,
  requirePermission("content", "edit"),
  validate(contentValidators.updateContentPostSchema),
  auditLog("content", "update"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const post = await contentService.updateContentPost(req.params.id, req.body);
      return success(res, post);
    } catch (err) {
      next(err);
    }
  }
);

// Update content status
router.put(
  "/content/:id/status",
  authenticate,
  requirePermission("content", "edit"),
  validate(contentValidators.updateContentStatusSchema),
  auditLog("content", "update_status"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const post = await contentService.updateContentStatus(req.params.id, req.body.status);
      return success(res, post);
    } catch (err) {
      next(err);
    }
  }
);

// Delete a content post
router.delete(
  "/content/:id",
  authenticate,
  requirePermission("content", "delete"),
  auditLog("content", "delete"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await contentService.deleteContentPost(req.params.id);
      return success(res, { message: "Content post deleted" });
    } catch (err) {
      next(err);
    }
  }
);

// GET /content/:id/comments — list comments on a post (admin view, no client scope)
router.get(
  "/content/:id/comments",
  authenticate,
  requirePermission("content", "view"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { prisma } = await import("@dashmani/db");
      const comments = await prisma.postComment.findMany({
        where: { postId: req.params.id },
        include: { author: { select: { id: true, name: true, email: true, profileImageUrl: true } } },
        orderBy: { createdAt: "asc" },
      });
      return success(res, comments);
    } catch (err) {
      next(err);
    }
  }
);

// POST /content/:id/comments — add a comment as the current admin user
router.post(
  "/content/:id/comments",
  authenticate,
  requirePermission("content", "edit"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { prisma } = await import("@dashmani/db");
      const { body } = req.body;
      if (!body || typeof body !== "string" || !body.trim()) {
        return res.status(400).json({ success: false, error: { message: "Comment body is required" } });
      }
      const post = await prisma.contentPost.findUnique({ where: { id: req.params.id }, select: { id: true } });
      if (!post) return res.status(404).json({ success: false, error: { message: "Content post not found" } });
      const comment = await prisma.postComment.create({
        data: { postId: req.params.id, authorId: req.user!.userId, body: body.trim() },
        include: { author: { select: { id: true, name: true, email: true, profileImageUrl: true } } },
      });
      return success(res, comment, undefined, 201);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
