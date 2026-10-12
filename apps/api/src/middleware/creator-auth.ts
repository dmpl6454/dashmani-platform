import { Request, Response, NextFunction } from "express";
import { prisma } from "@dashmani/db";
import { AppError } from "./error-handler";
import { asyncHandler } from "../utils/async-handler";
import { creatorConfig } from "../services/creator/creator-config";
import { verifyCreatorAccessToken } from "../services/creator/creator-jwt";

export interface CreatorRequestContext {
  id: string;
  email: string;
  status: string;
}

/** Every /v1/creator/* route sits behind this: the portal is dark unless CREATORS_ENABLED=1. */
export function requireCreatorsEnabled(_req: Request, _res: Response, next: NextFunction) {
  if (!creatorConfig.enabled()) return next(new AppError(503, "CREATORS_DISABLED", "The creator portal is not open yet."));
  next();
}

/**
 * A creator session: verified with the CREATOR secret (staff, HR and client tokens fail here),
 * and the creator row is re-read so a closed account — or a session ended by a password reset,
 * a password change or a Google claim (session_version moved on) — stops working at once.
 */
export const authenticateCreator = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw new AppError(401, "NO_TOKEN", "Authentication required");
  let creatorId: string;
  let sv: number;
  try {
    ({ creatorId, sv } = verifyCreatorAccessToken(header.slice(7)));
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(401, "INVALID_TOKEN", "Invalid or expired token");
  }
  const c = await prisma.creator.findUnique({
    where: { id: creatorId },
    select: { id: true, email: true, status: true, sessionVersion: true },
  });
  if (!c || c.status === "closed") throw new AppError(401, "ACCOUNT_CLOSED", "This account is closed.");
  if (c.sessionVersion !== sv) throw new AppError(401, "INVALID_TOKEN", "Your session has ended — please sign in again.");
  (req as Request & { creator?: CreatorRequestContext }).creator = { id: c.id, email: c.email, status: c.status };
  next();
});

/** Suspended creators can sign in and read, but change nothing. */
export function requireActiveCreator(req: Request, _res: Response, next: NextFunction) {
  const c = (req as Request & { creator?: CreatorRequestContext }).creator;
  if (c?.status === "suspended") return next(new AppError(403, "ACCOUNT_SUSPENDED", "Your account is suspended — email creators@digitalsukoon.com."));
  next();
}

export function creatorOf(req: Request): CreatorRequestContext {
  const c = (req as Request & { creator?: CreatorRequestContext }).creator;
  if (!c) throw new AppError(401, "NO_TOKEN", "Authentication required");
  return c;
}
