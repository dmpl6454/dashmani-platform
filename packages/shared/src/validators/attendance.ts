import { z } from "zod";

export const checkInSchema = z.object({
  ipAddress: z.string().ip().optional(),
});

export const leaveRequestSchema = z.object({
  startDate: z.string().date("Invalid date format (YYYY-MM-DD)"),
  endDate: z.string().date("Invalid date format (YYYY-MM-DD)"),
  reason: z.string().min(5, "Reason must be at least 5 characters").max(500),
  type: z.enum(["CASUAL", "SICK", "EARNED", "UNPAID"]),
});

export const attendanceQuerySchema = z.object({
  employeeId: z.string().uuid().optional(),
  startDate: z.string().date().optional(),
  endDate: z.string().date().optional(),
  status: z.enum(["present", "absent", "late", "half_day", "leave"]).optional(),
});
