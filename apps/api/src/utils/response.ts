import { Response } from "express";
import type { ApiSuccessResponse, ApiErrorResponse } from "@dashmani/shared";

export function success<T>(res: Response, data: T, meta?: ApiSuccessResponse<T>["meta"], status = 200) {
  const body: ApiSuccessResponse<T> = { success: true, data };
  if (meta) body.meta = meta;
  return res.status(status).json(body);
}

export function error(res: Response, code: string, message: string, status = 400, details?: ApiErrorResponse["error"]["details"]) {
  const body: ApiErrorResponse = {
    success: false,
    error: { code, message },
  };
  if (details) body.error.details = details;
  return res.status(status).json(body);
}
