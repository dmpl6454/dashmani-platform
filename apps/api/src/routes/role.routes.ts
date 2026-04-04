import { Router, Request, Response, NextFunction } from "express";
import { authenticate } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";
import { auditLog } from "../middleware/audit-log";
import * as roleService from "../services/role.service";
import { success } from "../utils/response";

const router = Router();

router.get("/roles", authenticate, requirePermission("roles", "view"), async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const roles = await roleService.listRoles();
    return success(res, roles);
  } catch (err) { next(err); }
});

router.get("/roles/:id", authenticate, requirePermission("roles", "view"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const role = await roleService.getRoleById(req.params.id);
    return success(res, role);
  } catch (err) { next(err); }
});

router.post("/roles", authenticate, requirePermission("roles", "create"), auditLog("roles", "create"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const role = await roleService.createRole(req.body);
    return success(res, role, undefined, 201);
  } catch (err) { next(err); }
});

router.put("/roles/:id/permissions", authenticate, requirePermission("roles", "edit"), auditLog("roles", "update_permissions"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const role = await roleService.updateRolePermissions(req.params.id, req.body.permissions);
    return success(res, role);
  } catch (err) { next(err); }
});

router.delete("/roles/:id", authenticate, requirePermission("roles", "delete"), auditLog("roles", "delete"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    await roleService.deleteRole(req.params.id);
    return success(res, { message: "Role deleted" });
  } catch (err) { next(err); }
});

export default router;
