import { Request, Response, NextFunction } from "express";
import multer from "multer";
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
  // Upload limits are the client's mistake, not a server fault.
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") return error(res, "FILE_TOO_LARGE", "The file is too large", 413);
    return error(res, "INVALID_UPLOAD", err.message, 400);
  }
  console.error("Unhandled error:", err);
  return error(res, "INTERNAL_ERROR", "An unexpected error occurred", 500);
}
