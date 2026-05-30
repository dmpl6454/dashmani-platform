import { Request, Response, NextFunction } from "express";
import { error } from "../utils/response";

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: Array<{ field: string; message: string }>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return error(res, err.code, err.message, err.statusCode, err.details);
  }
  console.error("Unhandled error:", err);
  return error(res, "INTERNAL_ERROR", "An unexpected error occurred", 500);
}
