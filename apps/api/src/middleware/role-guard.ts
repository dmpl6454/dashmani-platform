/**
 * Keeps the HR Manager role inside HR.
 *
 * The HR Manager role holds `employees.create/edit/delete` so it can run the
 * people side of the portal. Those same permissions gate the routes that set an
 * employee's roles (`POST /employees`, `PUT /employees/:id`, `/admin/users/create`,
 * `/admin/users/invite`), so on their own they would let an HR Manager hand out
 * Super Admin, or deactivate or demote an Admin. These guards close that:
 *
 *  - guardRoleAssignment: a non-admin may not grant a privileged role
 *    (Super Admin, Admin, HR Manager).
 *  - guardTargetUser: a non-admin may not change an account that holds one.
 *
 * Admin / Super Admin are unaffected. "Admin" is read from the DATABASE, not the
 * JWT: a demoted admin keeps the old role in their token for up to 4h, and that
 * must not keep this door open.
 */
import type { Request, Response, NextFunction } from "express";
import { prisma } from "@dashmani/db";
import { DEFAULT_ROLES, PRIVILEGED_ROLE_NAMES, HR_MANAGER_ROLE_NAME } from "@dashmani/shared";
import { asyncHandler } from "../utils/async-handler";
import { AppError } from "./error-handler";

const ADMIN_ROLE_NAMES = [DEFAULT_ROLES.SUPER_ADMIN.name, DEFAULT_ROLES.ADMIN.name];

export async function actorIsAdmin(userId: string): Promise<boolean> {
  const n = await prisma.userRole.count({
    where: { userId, role: { name: { in: ADMIN_ROLE_NAMES } } },
  });
  return n > 0;
}

/** Throws 403 when a non-admin tries to grant Super Admin, Admin or HR Manager. */
export async function assertAssignableRoles(actorId: string, roleIds: unknown): Promise<void> {
  if (!Array.isArray(roleIds) || roleIds.length === 0) return;
  const ids = roleIds.filter((r): r is string => typeof r === "string");
  if (ids.length === 0) return;
  if (await actorIsAdmin(actorId)) return;
  const privileged = await prisma.role.count({
    where: { id: { in: ids }, name: { in: [...PRIVILEGED_ROLE_NAMES] } },
  });
  if (privileged > 0) {
    throw new AppError(
      403,
      "ROLE_NOT_ASSIGNABLE",
      "Only an Admin can grant the Super Admin, Admin or HR Manager role",
    );
  }
}

/** Throws 403 when a non-admin tries to change an Admin, Super Admin or HR Manager account. */
export async function assertManageableUser(actorId: string, targetUserId: string): Promise<void> {
  if (await actorIsAdmin(actorId)) return;
  const privileged = await prisma.userRole.count({
    where: { userId: targetUserId, role: { name: { in: [...PRIVILEGED_ROLE_NAMES] } } },
  });
  if (privileged > 0) {
    throw new AppError(
      403,
      "PROTECTED_USER",
      "Only an Admin can change an Admin, Super Admin or HR Manager account",
    );
  }
}

/** Checks `req.body.roleIds`. Mount after `authenticate`. */
export const guardRoleAssignment = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  await assertAssignableRoles(req.user!.userId, req.body?.roleIds);
  next();
});

/** Checks the user named by a route param (default `:id`). Mount after `authenticate`. */
export function guardTargetUser(param = "id") {
  return asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
    await assertManageableUser(req.user!.userId, req.params[param]);
    next();
  });
}

/**
 * Role-name gate for HR-owned admin pages (announcements): Super Admin, Admin or
 * HR Manager. Same JWT-based shape as requireAdminRole.
 */
export function requireAdminOrHrRole(req: Request, res: Response, next: NextFunction) {
  const allowed = new Set([...ADMIN_ROLE_NAMES, HR_MANAGER_ROLE_NAME].map((r) => r.toLowerCase()));
  const roles: string[] = (req.user?.roles ?? []).map((r) => String(r).toLowerCase());
  if (roles.some((r) => allowed.has(r))) return next();
  return res.status(403).json({
    success: false,
    error: { code: "FORBIDDEN", message: "Admin or HR Manager role required" },
  });
}
