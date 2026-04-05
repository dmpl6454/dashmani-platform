import { Request, Response, NextFunction } from "express";
import { verifyAccessToken } from "../utils/jwt";
import { error } from "../utils/response";

export function authenticateHr(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return error(res, "UNAUTHORIZED", "Missing or invalid authorization header", 401);
  }

  const token = authHeader.slice(7);
  try {
    const payload = verifyAccessToken(token);
    if (payload.type !== "hr") {
      return error(res, "FORBIDDEN", "HR access only", 403);
    }
    req.user = payload;
    next();
  } catch {
    return error(res, "UNAUTHORIZED", "Invalid or expired token", 401);
  }
}
