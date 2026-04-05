import { Router, Request, Response, NextFunction } from "express";
import { authenticate } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit-log";
import { taskValidators } from "@dashmani/shared";
import * as taskService from "../services/task.service";
import { success } from "../utils/response";
import { parsePagination } from "../utils/pagination";

const router = Router();

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

router.get("/tasks/:id", authenticate, requirePermission("tasks", "view"), async (req: Request, res: Response, next: NextFunction) => {
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

router.put("/tasks/:id", authenticate, requirePermission("tasks", "edit"), validate(taskValidators.updateTaskSchema), auditLog("tasks", "update"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const task = await taskService.updateTask(req.params.id, req.body);
    return success(res, task);
  } catch (err) { next(err); }
});

router.put("/tasks/:id/status", authenticate, requirePermission("tasks", "edit"), validate(taskValidators.updateTaskStatusSchema), auditLog("tasks", "update_status"), async (req: Request, res: Response, next: NextFunction) => {
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

router.get("/tasks/:id/comments", authenticate, requirePermission("tasks", "view"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const comments = await taskService.listComments(req.params.id);
    return success(res, comments);
  } catch (err) { next(err); }
});

router.post("/tasks/:id/comments", authenticate, requirePermission("tasks", "edit"), validate(taskValidators.createTaskCommentSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const comment = await taskService.addComment(req.params.id, req.user!.userId, req.body.body);
    return success(res, comment, undefined, 201);
  } catch (err) { next(err); }
});

export default router;
