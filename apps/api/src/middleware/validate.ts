import { Request, Response, NextFunction } from "express";
import { ZodSchema, ZodError } from "zod";
import { error } from "../utils/response";

export function validate(schema: ZodSchema, source: "body" | "query" | "params" = "body") {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = schema.parse(req[source]);
      req[source] = parsed;
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        const details = err.errors.map((e) => ({
          field: e.path.join("."),
          message: e.message,
        }));
        return error(res, "VALIDATION_ERROR", "Invalid request data", 400, details);
      }
      next(err);
    }
  };
}
