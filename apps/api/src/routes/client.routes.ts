import { Router, Request, Response, NextFunction } from "express";
import { authenticate } from "../middleware/auth";
import { authenticateClient } from "../middleware/client-auth";
import { requirePermission } from "../middleware/rbac";
import { validate } from "../middleware/validate";
import { auditLog } from "../middleware/audit-log";
import { clientValidators, contentValidators } from "@dashmani/shared";
import * as clientAuthService from "../services/client-auth.service";
import * as projectService from "../services/project.service";
import * as approvalService from "../services/approval.service";
import * as contentService from "../services/content.service";
import * as clientService from "../services/client.service";
import * as analyticsService from "../services/analytics.service";
import { success } from "../utils/response";
import { parsePagination } from "../utils/pagination";
import { prisma } from "@dashmani/db";
import { AppError } from "../middleware/error-handler";

const router = Router();

// ===== CLIENT AUTH =====

router.post("/client/auth/login", validate(clientValidators.clientLoginSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await clientAuthService.clientLogin(req.body.email, req.body.password);
    return success(res, result);
  } catch (err) { next(err); }
});

router.post("/client/auth/refresh", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await clientAuthService.clientRefresh(req.body.refreshToken);
    return success(res, result);
  } catch (err) { next(err); }
});

router.post("/client/auth/logout", authenticateClient, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await clientAuthService.clientLogout((req as any).client.id);
    return success(res, { message: "Logged out" });
  } catch (err) { next(err); }
});

// ===== CLIENT PORTAL ENDPOINTS (client-authenticated) =====

router.get("/client/dashboard", authenticateClient, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clientId = (req as any).client.id;
    const client = await clientAuthService.getClientById(clientId);
    const projects = await projectService.listProjects({ clientId, limit: 10 });
    const approvals = await approvalService.listApprovals({ clientId, status: "PENDING", limit: 10 });
    return success(res, { client, projects: projects.items, pendingApprovals: approvals.items });
  } catch (err) { next(err); }
});

router.get("/client/projects", authenticateClient, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clientId = (req as any).client.id;
    const pagination = parsePagination(req.query as any);
    const result = await projectService.listProjects({
      ...pagination,
      clientId,
      status: req.query.status as string,
      search: req.query.search as string,
    });
    return success(res, result.items, result.meta);
  } catch (err) { next(err); }
});

router.get("/client/projects/:id", authenticateClient, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const project = await projectService.getProjectById(req.params.id);
    if (project.client.id !== (req as any).client.id) {
      return success(res, null, undefined, 403);
    }
    return success(res, project);
  } catch (err) { next(err); }
});

// POST /v1/client/content/brief  — client-initiated content request (creates a DRAFT ContentPost)
router.post(
  "/client/content/brief",
  authenticateClient,
  validate(clientValidators.createBriefSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const clientId = (req as any).client.id;
      const post = await contentService.createClientBrief(clientId, req.body);
      return success(res, post, undefined, 201);
    } catch (err) { next(err); }
  }
);

// LEGACY: returns the separate `Approval` model. Not consumed by the client portal UI
// (the client portal Approvals page reads `ContentPost` rows with status=PENDING_APPROVAL).
// Retained for admin/internal tooling.
router.get("/client/approvals", authenticateClient, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clientId = (req as any).client.id;
    const pagination = parsePagination(req.query as any);
    const result = await approvalService.listApprovals({
      ...pagination,
      clientId,
      status: req.query.status as string,
    });
    return success(res, result.items, result.meta);
  } catch (err) { next(err); }
});

router.put("/client/approvals/:id/respond", authenticateClient, validate(clientValidators.respondApprovalSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clientId = (req as any).client.id;
    const approvalRecord = await prisma.approval.findFirst({
      where: { id: req.params.id },
      select: { project: { select: { clientId: true } } },
    });
    if (!approvalRecord || approvalRecord.project.clientId !== clientId) {
      return next(new AppError(403, "FORBIDDEN", "Access denied"));
    }
    const approval = await approvalService.respondToApproval(req.params.id, req.body.status, req.body.clientNote);
    return success(res, approval);
  } catch (err) { next(err); }
});

// ===== CLIENT CONTENT ENDPOINTS =====

router.get("/client/content", authenticateClient, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clientId = (req as any).client.id;
    const pagination = parsePagination(req.query as any);
    const result = await contentService.listContentPosts({
      ...pagination,
      clientId,
      projectId: req.query.projectId as string,
      status: req.query.status as string,
      search: req.query.search as string,
    });
    return success(res, result.items, result.meta);
  } catch (err) { next(err); }
});

router.get("/client/content/calendar", authenticateClient, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clientId = (req as any).client.id;
    const year = Number(req.query.year);
    const month = Number(req.query.month);
    if (!year || !month || month < 1 || month > 12) {
      return success(res, null, undefined, 400);
    }
    const data = await contentService.getCalendarData({
      year,
      month,
      clientId,
      projectId: req.query.projectId as string,
    });
    return success(res, data);
  } catch (err) { next(err); }
});

router.get("/client/content/:id", authenticateClient, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const post = await contentService.getContentPostById(req.params.id);
    if ((post.project as any).client.id !== (req as any).client.id) {
      return success(res, null, undefined, 403);
    }
    return success(res, post);
  } catch (err) { next(err); }
});

router.put("/client/content/:id/respond", authenticateClient, validate(contentValidators.respondContentApprovalSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clientId = (req as any).client.id;
    const post = await contentService.respondToContentApproval(req.params.id, clientId, req.body.status);
    return success(res, post);
  } catch (err) { next(err); }
});

// GET /v1/client/content/:id/comments
router.get("/client/content/:id/comments", authenticateClient, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clientId = (req as any).client.id;
    const comments = await contentService.getPostComments(req.params.id, clientId);
    return success(res, comments);
  } catch (err) { next(err); }
});

// POST /v1/client/content/:id/comments
router.post(
  "/client/content/:id/comments",
  authenticateClient,
  validate(contentValidators.addPostCommentSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const clientId = (req as any).client.id;
      const comment = await contentService.addPostComment(req.params.id, clientId, req.body.body);
      return success(res, comment, undefined, 201);
    } catch (err) { next(err); }
  }
);

// GET /v1/client/files
router.get("/client/files", authenticateClient, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clientId = (req as any).client.id;
    const files = await clientService.getClientFiles(clientId, {
      projectId: req.query.projectId as string | undefined,
      search: req.query.search as string | undefined,
    });
    return success(res, files);
  } catch (err) { next(err); }
});

// POST /v1/client/auth/invite-request  (admin only: create an invite for an email)
router.post(
  "/client/auth/invite-request",
  authenticate,
  requirePermission("clients", "create"),
  validate(clientValidators.createInviteSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const invite = await clientAuthService.createInvite(req.body.email);
      return success(res, invite, undefined, 201);
    } catch (err) { next(err); }
  }
);

// POST /v1/client/auth/register  (public: accept invite and set password)
router.post(
  "/client/auth/register",
  validate(clientValidators.clientRegisterSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await clientAuthService.acceptInvite(
        req.body.token,
        req.body.password,
        req.body.contactName
      );
      return success(res, result, undefined, 201);
    } catch (err) { next(err); }
  }
);

// GET /v1/client/analytics
router.get("/client/analytics", authenticateClient, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clientId = (req as any).client.id;
    const data = await analyticsService.getClientContentAnalytics(clientId);
    return success(res, data);
  } catch (err) { next(err); }
});

// ===== ADMIN CLIENT MANAGEMENT (employee-authenticated) =====

router.get("/clients", authenticate, requirePermission("clients", "view"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pagination = parsePagination(req.query as any);
    const result = await clientAuthService.listClients({
      ...pagination,
      search: req.query.search as string,
      status: req.query.status as string,
    });
    return success(res, result.items, result.meta);
  } catch (err) { next(err); }
});

router.get("/clients/:id", authenticate, requirePermission("clients", "view"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const client = await clientAuthService.getClientById(req.params.id);
    return success(res, client);
  } catch (err) { next(err); }
});

router.post("/clients", authenticate, requirePermission("clients", "create"), validate(clientValidators.createClientSchema), auditLog("clients", "create"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const client = await clientAuthService.createClient(req.body);
    return success(res, client, undefined, 201);
  } catch (err) { next(err); }
});

router.put("/clients/:id", authenticate, requirePermission("clients", "edit"), validate(clientValidators.updateClientSchema), auditLog("clients", "update"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const client = await clientAuthService.updateClient(req.params.id, req.body);
    return success(res, client);
  } catch (err) { next(err); }
});

export default router;
