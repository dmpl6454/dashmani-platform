import { z } from "zod";
import { safeString } from "../utils/sanitize";

export const createAccountSchema = z.object({
  handle: safeString.pipe(z.string().min(1, "Handle is required").max(200)),
  displayName: safeString.pipe(z.string().min(1, "Display name is required").max(200)),
  platformId: z.string().uuid("Invalid platform ID"),
  clientName: safeString.pipe(z.string().max(200)).optional(),
  profileUrl: z.string().url().optional(),
});

export const updateAccountSchema = z.object({
  handle: safeString.pipe(z.string().min(1).max(200)).optional(),
  displayName: safeString.pipe(z.string().min(1).max(200)).optional(),
  clientName: safeString.pipe(z.string().max(200)).nullable().optional(),
  profileUrl: z.string().url().nullable().optional(),
  status: z.enum(["ACTIVE", "PAUSED", "ARCHIVED"]).optional(),
  followerCount: z.number().int().min(0).optional(),
});

export const assignAccountSchema = z.object({
  employeeId: z.string().uuid("Invalid employee ID"),
  reason: safeString.pipe(z.string().max(500)).optional(),
});
