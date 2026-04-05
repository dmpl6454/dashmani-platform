import { Router, Request, Response, NextFunction } from "express";
import { authenticate } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit-log";
import { clientValidators } from "@dashmani/shared";
import * as projectService from "../services/project.service";
import * as approvalService from "../services/approval.service";
import { success } from "../utils/response";
import { parsePagination } from "../utils/pagination";

const router = Router();

router.get("/projects", authenticate, requirePermission("clients", "view"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pagination = parsePagination(req.query as any);
    const result = await projectService.listProjects({
      ...pagination,
      clientId: req.query.clientId as string,
      status: req.query.status as string,
      search: req.query.search as string,
    });
    return success(res, result.items, result.meta);
  } catch (err) { next(err); }
});

router.get("/projects/:id", authenticate, requirePermission("clients", "view"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const project = await projectService.getProjectById(req.params.id);
    return success(res, project);
  } catch (err) { next(err); }
});

router.post("/projects", authenticate, requirePermission("clients", "create"), validate(clientValidators.createProjectSchema), auditLog("clients", "create_project"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const project = await projectService.createProject(req.body);
    return success(res, project, undefined, 201);
  } catch (err) { next(err); }
});

router.put("/projects/:id", authenticate, requirePermission("clients", "edit"), validate(clientValidators.updateProjectSchema), auditLog("clients", "update_project"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const project = await projectService.updateProject(req.params.id, req.body);
    return success(res, project);
  } catch (err) { next(err); }
});

router.post("/projects/:id/accounts", authenticate, requirePermission("clients", "edit"), validate(clientValidators.addProjectAccountSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const link = await projectService.addAccountToProject(req.params.id, req.body.accountId);
    return success(res, link, undefined, 201);
  } catch (err) { next(err); }
});

router.delete("/projects/:id/accounts/:accountId", authenticate, requirePermission("clients", "edit"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await projectService.removeAccountFromProject(req.params.id, req.params.accountId);
    return success(res, { message: "Account removed from project" });
  } catch (err) { next(err); }
});

router.post("/projects/:id/tasks", authenticate, requirePermission("clients", "edit"), validate(clientValidators.addProjectTaskSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const link = await projectService.addTaskToProject(req.params.id, req.body.taskId);
    return success(res, link, undefined, 201);
  } catch (err) { next(err); }
});

router.delete("/projects/:id/tasks/:taskId", authenticate, requirePermission("clients", "edit"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await projectService.removeTaskFromProject(req.params.id, req.params.taskId);
    return success(res, { message: "Task removed from project" });
  } catch (err) { next(err); }
});

router.post("/projects/:id/approvals", authenticate, requirePermission("clients", "create"), validate(clientValidators.createApprovalSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const approval = await approvalService.createApproval(req.params.id, req.user!.userId, req.body);
    return success(res, approval, undefined, 201);
  } catch (err) { next(err); }
});

router.get("/projects/:id/approvals", authenticate, requirePermission("clients", "view"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pagination = parsePagination(req.query as any);
    const result = await approvalService.listApprovals({
      ...pagination,
      projectId: req.params.id,
      status: req.query.status as string,
    });
    return success(res, result.items, result.meta);
  } catch (err) { next(err); }
});

export default router;
