import { Request, Response, NextFunction } from "express";
import { error } from "../utils/response";

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return error(res, err.code, err.message, err.statusCode);
  }
  console.error("Unhandled error:", err);
  return error(res, "INTERNAL_ERROR", "An unexpected error occurred", 500);
}
