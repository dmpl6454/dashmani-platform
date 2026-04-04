import { Request, Response, NextFunction } from "express";
import { prisma } from "@dashmani/db";
import { error } from "../utils/response";

export function requirePermission(resource: string, action: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
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
      (ur) => ur.role.permissions.length > 0
    );

    if (!hasPermission) {
      return error(res, "FORBIDDEN", `No permission: ${action} on ${resource}`, 403);
    }

    // Attach the highest scope for this permission to the request
    const scopes = userRoles
      .flatMap((ur) => ur.role.permissions)
      .map((p) => p.scope);

    const scopePriority = ["global", "department", "team", "own"];
    const highestScope = scopePriority.find((s) => scopes.includes(s)) || "own";

    (req as any).permissionScope = highestScope;
    next();
  };
}
