/**
 * Role-name gate: Super Admin / Admin only.
 *
 * ⚠️ WHY THIS EXISTS AS A SECOND GATE, ON TOP OF requirePermission.
 * rbac.ts computes hasPermission from `where: { resource, action }` and IGNORES
 * scope entirely (scope only lands in req.permissionScope, which almost nothing
 * reads). seed.ts grants the Employee role `reports.view` and `accounts.view`, so
 * a `view`-gated endpoint is readable by EVERY employee. The Meta endpoints expose
 * the connected Facebook account, the granted scope list, both token expiry
 * timestamps and org-wide post engagement — so they are gated on
 * `reports.manage` (Admin/Super-Admin-only per the seed, needing no new
 * role_permissions rows) AND this independent role-name check.
 *
 * ⚠️ KNOWN LIMITATION: roles are read off the 4h access-token JWT, so a role
 * change is stale for up to 4h. That is a pre-existing property of how this
 * codebase carries roles, not something introduced here.
 *
 * NOTE: `admin-features.routes.ts` has its own private copy of this function with
 * a delete-specific message. It is deliberately left untouched — refactoring a
 * live, load-bearing routes file was not worth the regression risk for this change.
 */

import type { Request, Response, NextFunction } from "express";

export function requireAdminRole(req: Request, res: Response, next: NextFunction) {
  const roles: string[] = (req.user?.roles ?? []).map(String);
  const normalized = roles.map((r) => r.toLowerCase());
  if (normalized.includes("super admin") || normalized.includes("admin")) return next();
  return res.status(403).json({
    success: false,
    error: { code: "FORBIDDEN", message: "Admin role required" },
  });
}
