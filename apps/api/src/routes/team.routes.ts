import { Router, Request, Response, NextFunction } from "express";
import { authenticate } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";
import { auditLog } from "../middleware/audit-log";
import * as teamService from "../services/team.service";
import { success } from "../utils/response";

const router = Router();

router.get("/teams", authenticate, requirePermission("teams", "view"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const units = await teamService.listOrgUnits(req.query.parentId as string);
    return success(res, units);
  } catch (err) { next(err); }
});

router.get("/teams/:id", authenticate, requirePermission("teams", "view"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const unit = await teamService.getOrgUnitById(req.params.id);
    return success(res, unit);
  } catch (err) { next(err); }
});

router.post("/teams", authenticate, requirePermission("teams", "create"), auditLog("teams", "create"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const unit = await teamService.createOrgUnit(req.body);
    return success(res, unit, undefined, 201);
  } catch (err) { next(err); }
});

router.put("/teams/:id", authenticate, requirePermission("teams", "edit"), auditLog("teams", "update"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const unit = await teamService.updateOrgUnit(req.params.id, req.body);
    return success(res, unit);
  } catch (err) { next(err); }
});

// Add a member to a team (does NOT remove them from any other team).
router.post("/teams/:id/members", authenticate, requirePermission("teams", "edit"), auditLog("teams", "add-member"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.body.userId as string;
    if (!userId || typeof userId !== "string") {
      return res.status(400).json({ success: false, error: { code: "VALIDATION_ERROR", message: "userId is required" } });
    }
    const unit = await teamService.addMember(req.params.id, userId);
    return success(res, unit);
  } catch (err) { next(err); }
});

// Remove a member from ONE team (other team memberships are untouched).
router.delete("/teams/:id/members/:userId", authenticate, requirePermission("teams", "edit"), auditLog("teams", "remove-member"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await teamService.removeMember(req.params.id, req.params.userId);
    return success(res, { message: "Member removed from team" });
  } catch (err) { next(err); }
});

router.delete("/teams/bulk", authenticate, requirePermission("teams", "delete"), auditLog("teams", "bulk-delete"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ids: string[] = req.body.ids;
    if (!Array.isArray(ids) || ids.length === 0) {
      return next(new Error("ids must be a non-empty array"));
    }
    await teamService.bulkDeleteOrgUnits(ids);
    return success(res, { message: `${ids.length} org unit(s) deleted` });
  } catch (err) { next(err); }
});

router.delete("/teams/:id", authenticate, requirePermission("teams", "delete"), auditLog("teams", "delete"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await teamService.deleteOrgUnit(req.params.id);
    return success(res, { message: "Org unit deleted" });
  } catch (err) { next(err); }
});

export default router;
