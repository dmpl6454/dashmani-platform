import { z } from "zod";

export const otpRequestSchema = z.object({
  identifier: z.string().min(1, "Identifier (email or phone) is required"),
  channel: z.enum(["EMAIL", "SMS", "WHATSAPP"]),
});

export const otpVerifySchema = z.object({
  identifier: z.string().min(1, "Identifier is required"),
  otp: z.string().length(6, "OTP must be 6 digits"),
});

export const reportLinkSchema = z.object({
  accountId: z.string().uuid("Invalid account ID"),
  url: z.string().url("Invalid URL"),
  platform: z.string().min(1, "Platform is required"),
  description: z.string().optional(),
  mediaUrl: z.string().url("Invalid media URL").optional(),
  likes: z.number().int().nonnegative().optional(),
  comments: z.number().int().nonnegative().optional(),
  shares: z.number().int().nonnegative().optional(),
  views: z.number().int().nonnegative().optional(),
});

export const submitDailyReportSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format"),
  links: z.array(reportLinkSchema).min(1, "At least one link is required"),
  notes: z.string().optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
});

export const adminReportFilterSchema = z.object({
  employeeId: z.string().uuid().optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  accountId: z.string().uuid().optional(),
});
