import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "@dashmani/db";
import { AppError } from "./error-handler";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";

export function authenticateClient(req: Request, _res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return next(new AppError(401, "NO_TOKEN", "Authentication required"));
  }

  let payload: { userId: string; email: string; type: string; memberId?: string; sv?: number };
  try {
    const token = authHeader.split(" ")[1];
    payload = jwt.verify(token, JWT_SECRET) as typeof payload;
  } catch {
    return next(new AppError(401, "INVALID_TOKEN", "Invalid or expired token"));
  }

  if (payload.type !== "client") {
    return next(new AppError(403, "FORBIDDEN", "Client access required"));
  }

  // The company's own login: no lookup, as before.
  if (!payload.memberId) {
    (req as any).client = { id: payload.userId, email: payload.email, memberId: null };
    return next();
  }

  // A team login: still active, same session version, same company. One indexed primary-key
  // read, so a disabled or removed login loses access on its next request — not 15 minutes later.
  prisma.clientUser
    .findFirst({
      where: { id: payload.memberId, clientId: payload.userId, status: "active", sessionVersion: payload.sv ?? 0 },
      select: { id: true, email: true },
    })
    .then((m) => {
      if (!m) return next(new AppError(401, "INVALID_TOKEN", "This login is no longer active"));
      (req as any).client = { id: payload.userId, email: m.email, memberId: m.id };
      next();
    })
    .catch(next);
}

/** Team management is the company owner's (a member token gets 403). */
export function requireClientOwner(req: Request, _res: Response, next: NextFunction) {
  if ((req as any).client?.memberId) return next(new AppError(403, "OWNER_ONLY", "Only the account owner can manage the team."));
  next();
}
