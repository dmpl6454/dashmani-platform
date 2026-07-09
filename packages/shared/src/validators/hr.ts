import { z } from "zod";
import { normalizedEmail } from "../utils/sanitize";

export const otpRequestSchema = z.object({
  identifier: z.string().trim().min(1, "Identifier (email or phone) is required"),
  channel: z.enum(["EMAIL", "SMS", "WHATSAPP"]),
});

export const otpVerifySchema = z.object({
  identifier: z.string().trim().min(1, "Identifier is required"),
  otp: z.string().length(6, "OTP must be 6 digits"),
});

export const registerEmployeeSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  email: normalizedEmail,
  phone: z.string().min(10, "Phone must be at least 10 digits").optional(),
  password: z.string().min(6, "Password must be at least 6 characters"),
});

export const passwordLoginSchema = z.object({
  identifier: z.string().trim().min(1, "Email or phone is required"),
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
  // .max(2048): a URL longer than the Postgres b-tree limit (2704 bytes) on
  // report_links_url_idx makes createMany throw an unhandled 54000 → a generic 500
  // (incident 2026-07-08). 2048 is well under that ceiling and far above any real
  // social-media URL (prod max is 719). Reject cleanly here as a 400 field error.
  url: z.string().url("Invalid URL").max(2048, "URL is too long (max 2048 characters)").optional().nullable(),
  platform: z.string().min(1, "Platform is required"),
  description: z.string().optional(),
  mediaUrl: z.string().url("Invalid media URL").optional(),
  likes: z.number().int().nonnegative().optional(),
  comments: z.number().int().nonnegative().optional(),
  shares: z.number().int().nonnegative().optional(),
  views: z.number().int().nonnegative().optional(),
  isScheduled: z.boolean().optional().default(false),
  scheduledFor: z.string().datetime().optional().nullable(),
}).refine(
  (data) => data.isScheduled || (data.url && data.url.length > 0),
  { message: "URL is required for live posts", path: ["url"] }
);

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
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
});
