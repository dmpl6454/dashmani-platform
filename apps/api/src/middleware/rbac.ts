import { Request, Response, NextFunction } from "express";
import { prisma } from "@dashmani/db";
import { error } from "../utils/response";
import { asyncHandler } from "../utils/async-handler";

export type PermissionScope = "global" | "department" | "team" | "own";

/** Highest first. */
const SCOPE_PRIORITY: PermissionScope[] = ["global", "department", "team", "own"];

export interface PermissionOptions {
  /**
   * The narrowest scope that may call this route. A route that returns or changes
   * company-wide data (every employee, every channel, every report) must say
   * `minScope: "global"`: an "own" or "team" grant would otherwise read everything,
   * because the route does not filter by owner or team.
   */
  minScope?: PermissionScope;
  /**
   * Route param holding a user id. When it names the caller, a grant of any scope
   * passes (an employee may read their own record), even below `minScope`.
   */
  selfParam?: string;
}

/** For routes that return or change company-wide data. */
export const GLOBAL_ONLY: PermissionOptions = { minScope: "global" };

export function requirePermission(resource: string, action: string, opts: PermissionOptions = {}) {
  // asyncHandler forwards any DB rejection (e.g. a P2024 pool timeout) to next(err)
  // → the errorHandler returns a handled 500, instead of an unhandled rejection that
  // crashes the whole process. This one guard is what stops the crash-loop; the auth
  // middlewares are synchronous JWT-only and don't touch Prisma, so they need no guard.
  return asyncHandler(async (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return error(res, "UNAUTHORIZED", "Authentication required", 401);
    }

    const userRoles = await prisma.userRole.findMany({
      where: { userId: req.user.userId },
      include: {
        role: {
          include: {
            permissions: {
              where: { resource, action },
            },
          },
        },
      },
    });

    const hasPermission = userRoles.some(
      (ur) => ur.role.permissions.length > 0,
    );

    if (!hasPermission) {
      return error(res, "FORBIDDEN", `No permission: ${action} on ${resource}`, 403);
    }

    const scopes = userRoles
      .flatMap((ur) => ur.role.permissions)
      .map((p) => p.scope);

    const highestScope = SCOPE_PRIORITY.find((s) => scopes.includes(s)) || "own";

    if (opts.minScope) {
      const isSelf = !!opts.selfParam && req.params[opts.selfParam] === req.user.userId;
      const wide = SCOPE_PRIORITY.indexOf(highestScope) <= SCOPE_PRIORITY.indexOf(opts.minScope);
      if (!wide && !isSelf) {
        return error(res, "FORBIDDEN", `No permission: ${action} on ${resource} for everyone (your access covers ${highestScope} data only)`, 403);
      }
    }

    (req as any).permissionScope = highestScope;
    next();
  });
}
