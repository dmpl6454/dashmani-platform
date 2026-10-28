import { Router, Request, Response, NextFunction } from "express";
import { authenticate } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit-log";
import { taskValidators } from "@dashmani/shared";
import * as taskService from "../services/task.service";
import { success } from "../utils/response";
import { parsePagination } from "../utils/pagination";
import { prisma } from "@dashmani/db";
import { asyncHandler } from "../utils/async-handler";
import { AppError } from "../middleware/error-handler";

const router = Router();

/**
 * Object-level check for /tasks/:id routes. rbac only proves the caller holds
 * tasks.view / tasks.edit; with "own" scope (the Employee role) that must also mean
 * "a task I am assigned to or created". Before the 2026-10-28 audit any employee could
 * read, reassign, close or comment on any task by id. An own-scope caller also may not
 * hand the task to somebody else. Answers 404, never 403, so ids are not confirmed.
 */
const requireTaskAccess = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const scope = (req as any).permissionScope;
  if (scope !== "own") return next();
  const userId = req.user!.userId;
  const task = await prisma.task.findUnique({
    where: { id: req.params.id },
    select: { assigneeId: true, createdById: true },
  });
  if (!task || (task.assigneeId !== userId && task.createdById !== userId)) {
    throw new AppError(404, "NOT_FOUND", "Task not found");
  }
  const reassignTo = req.body?.assigneeId;
  if (reassignTo !== undefined && reassignTo !== userId && reassignTo !== task.assigneeId) {
    throw new AppError(403, "FORBIDDEN", "You can only assign this task to yourself");
  }
  next();
});

router.get("/tasks", authenticate, requirePermission("tasks", "view"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pagination = parsePagination(req.query as any);
    const scope = (req as any).permissionScope;
    const result = await taskService.listTasks({
      ...pagination,
      status: req.query.status as string,
      priority: req.query.priority as string,
      assigneeId: scope === "own" ? req.user!.userId : (req.query.assigneeId as string),
      accountId: req.query.accountId as string,
      search: req.query.search as string,
    });
    return success(res, result.items, result.meta);
  } catch (err) { next(err); }
});

router.get("/tasks/:id", authenticate, requirePermission("tasks", "view"), requireTaskAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const task = await taskService.getTaskById(req.params.id);
    return success(res, task);
  } catch (err) { next(err); }
});

router.post("/tasks", authenticate, requirePermission("tasks", "create"), validate(taskValidators.createTaskSchema), auditLog("tasks", "create"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const task = await taskService.createTask({ ...req.body, createdById: req.user!.userId });
    return success(res, task, undefined, 201);
  } catch (err) { next(err); }
});

router.put("/tasks/:id", authenticate, requirePermission("tasks", "edit"), requireTaskAccess, validate(taskValidators.updateTaskSchema), auditLog("tasks", "update"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const task = await taskService.updateTask(req.params.id, req.body);
    return success(res, task);
  } catch (err) { next(err); }
});

router.put("/tasks/:id/status", authenticate, requirePermission("tasks", "edit"), requireTaskAccess, validate(taskValidators.updateTaskStatusSchema), auditLog("tasks", "update_status"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const task = await taskService.updateTaskStatus(req.params.id, req.body.status);
    return success(res, task);
  } catch (err) { next(err); }
});

router.delete("/tasks/:id", authenticate, requirePermission("tasks", "delete"), auditLog("tasks", "delete"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await taskService.deleteTask(req.params.id);
    return success(res, { message: "Task deleted" });
  } catch (err) { next(err); }
});

router.get("/tasks/:id/comments", authenticate, requirePermission("tasks", "view"), requireTaskAccess, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const comments = await taskService.listComments(req.params.id);
    return success(res, comments);
  } catch (err) { next(err); }
});

router.post("/tasks/:id/comments", authenticate, requirePermission("tasks", "edit"), requireTaskAccess, validate(taskValidators.createTaskCommentSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const comment = await taskService.addComment(req.params.id, req.user!.userId, req.body.body);
    return success(res, comment, undefined, 201);
  } catch (err) { next(err); }
});

export default router;
