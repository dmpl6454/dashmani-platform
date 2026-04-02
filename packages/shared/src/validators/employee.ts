import { z } from "zod";

export const createEmployeeSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters").max(100),
  email: z.string().email("Invalid email format"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  phone: z.string().optional(),
  orgUnitId: z.string().uuid().optional(),
  roleIds: z.array(z.string().uuid()).min(1, "At least one role is required"),
});

export const updateEmployeeSchema = z.object({
  name: z.string().min(2).max(100).optional(),
  phone: z.string().optional(),
  orgUnitId: z.string().uuid().nullable().optional(),
  status: z.enum(["active", "inactive", "onboarding"]).optional(),
  roleIds: z.array(z.string().uuid()).min(1).optional(),
});
