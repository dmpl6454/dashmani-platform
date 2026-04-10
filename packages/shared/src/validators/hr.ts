import { z } from "zod";

export const otpRequestSchema = z.object({
  identifier: z.string().min(1, "Identifier (email or phone) is required"),
  channel: z.enum(["EMAIL", "SMS", "WHATSAPP"]),
});

export const otpVerifySchema = z.object({
  identifier: z.string().min(1, "Identifier is required"),
  otp: z.string().length(6, "OTP must be 6 digits"),
});

export const registerEmployeeSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  email: z.string().email("Invalid email address"),
  phone: z.string().min(10, "Phone must be at least 10 digits").optional(),
  password: z.string().min(6, "Password must be at least 6 characters"),
});

export const passwordLoginSchema = z.object({
  identifier: z.string().min(1, "Email or phone is required"),
  password: z.string().min(1, "Password is required"),
});

export const updateProfileSchema = z.object({
  bankAccountHolderName: z.string().optional().nullable(),
  bankAccountNumber: z.string().optional().nullable(),
  bankName: z.string().optional().nullable(),
  bankBranch: z.string().optional().nullable(),
  ifscCode: z.string().optional().nullable(),
  mailingAddress: z.string().optional().nullable(),
  aadhaarNumber: z.string().optional().nullable(),
  panNumber: z.string().optional().nullable(),
  familyContact1Name: z.string().optional().nullable(),
  familyContact1Phone: z.string().optional().nullable(),
  familyContact1Relation: z.string().optional().nullable(),
  familyContact2Name: z.string().optional().nullable(),
  familyContact2Phone: z.string().optional().nullable(),
  familyContact2Relation: z.string().optional().nullable(),
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
  links: z.array(reportLinkSchema).min(1, "At least one link is required").max(500, "Maximum 500 links per submission"),
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
