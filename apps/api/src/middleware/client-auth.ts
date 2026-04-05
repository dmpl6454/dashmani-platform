import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { AppError } from "./error-handler";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";

export function authenticateClient(req: Request, _res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return next(new AppError(401, "NO_TOKEN", "Authentication required"));
  }

  try {
    const token = authHeader.split(" ")[1];
    const payload = jwt.verify(token, JWT_SECRET) as {
      userId: string;
      email: string;
      type: string;
    };

    if (payload.type !== "client") {
      return next(new AppError(403, "FORBIDDEN", "Client access required"));
    }

    (req as any).client = { id: payload.userId, email: payload.email };
    next();
  } catch {
    next(new AppError(401, "INVALID_TOKEN", "Invalid or expired token"));
  }
}
