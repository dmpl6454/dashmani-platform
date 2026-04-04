import { Request, Response, NextFunction } from "express";
import { prisma } from "@dashmani/db";
import { createAuditLog } from "../services/audit.service";

export function auditLog(resource: string, action: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Capture "before" state for update/delete operations
    let before: any = null;
    if (req.params.id && ["PUT", "PATCH", "DELETE"].includes(req.method)) {
      try {
        before = await (prisma as any)[resource === "teams" ? "orgUnit" : resource.slice(0, -1)]?.findUnique({
          where: { id: req.params.id },
        });
      } catch { /* resource model may not match — skip */ }
    }

    const originalJson = res.json.bind(res);
    res.json = function (body: any) {
      if (body?.success && req.user && ["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
        createAuditLog({
          userId: req.user.userId,
          action,
          resource,
          resourceId: req.params.id || body?.data?.id,
          before,
          after: req.body,
          ipAddress: req.ip,
        }).catch(console.error);
      }
      return originalJson(body);
    };
    next();
  };
}
