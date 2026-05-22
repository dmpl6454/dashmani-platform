import { z } from "zod";
import { safeString, normalizedEmail } from "../utils/sanitize";

export const createEmployeeSchema = z.object({
  name: safeString.pipe(z.string().min(2, "Name must be at least 2 characters").max(100)),
  email: normalizedEmail,
  password: z.string().min(8, "Password must be at least 8 characters"),
  phone: z.string().optional(),
  orgUnitId: z.string().uuid().optional(),
  roleIds: z.array(z.string().uuid()).min(1, "At least one role is required"),
  designation: safeString.pipe(z.string().max(100)).optional(),
  joinDate: z.string().optional(),
  salary: z.number().positive().optional(),
});

export const updateEmployeeSchema = z.object({
  name: safeString.pipe(z.string().min(2).max(100)).optional(),
  phone: z.string().optional(),
  orgUnitId: z.string().uuid().nullable().optional(),
  status: z.enum(["ACTIVE", "INACTIVE", "ONBOARDING"]).optional(),
  roleIds: z.array(z.string().uuid()).optional(),
});
