import { Request, Response, NextFunction } from "express";
import { prisma } from "@dashmani/db";
import { error } from "../utils/response";
import { asyncHandler } from "../utils/async-handler";

export function requirePermission(resource: string, action: string) {
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

    const scopePriority = ["global", "department", "team", "own"];
    const highestScope = scopePriority.find((s) => scopes.includes(s)) || "own";

    (req as any).permissionScope = highestScope;
    next();
  });
}
