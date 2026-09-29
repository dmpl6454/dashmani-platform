import { z } from "zod";
import { normalizedEmail, safeString } from "../utils/sanitize";

export const otpRequestSchema = z.object({
  identifier: z.string().trim().min(1, "Identifier (email or phone) is required"),
  channel: z.enum(["EMAIL", "SMS", "WHATSAPP"]),
});

export const otpVerifySchema = z.object({
  identifier: z.string().trim().min(1, "Identifier is required"),
  otp: z.string().length(6, "OTP must be 6 digits"),
});

export const registerEmployeeSchema = z.object({
  // ⚠️ The max(240) MUST come before safeString. Its /<[^>]*>/g strip is quadratic on a
  // run of '<' (measured: 40k chars = 757 ms, so 1 MB ≈ 8–9 minutes of main thread) and
  // this is a PUBLIC endpoint. 240 raw leaves room for tags around a 120-char name.
  name: z
    .string()
    .max(240, "Name is too long")
    .pipe(safeString)
    .pipe(
      z
        .string()
        .min(2, "Name must be at least 2 characters")
        .max(120, "Name must be at most 120 characters"),
    ),
  // ⚠️ Bound BEFORE normalizedEmail's trim/lowercase/regex, for the same reason as `name`.
  // 254 is the RFC 5321 maximum and sits far below the 2704-byte btree limit on
  // users_email_key (a longer email used to fail user.create with Postgres 54000, which
  // surfaced as a generic 500). It also keeps the service's case-insensitive ILIKE lookup,
  // which cannot use that index and lowercases the pattern once per users row, cheap.
  email: z.string().max(254, "Email is too long").pipe(normalizedEmail),
  // Stored verbatim (the service only trims), so an unbounded phone let one public request
  // write megabytes into users.phone. 20 covers "+91 98000 00001" and similar formatting.
  phone: z
    .string()
    .max(20, "Phone is too long")
    .min(10, "Phone must be at least 10 digits")
    .optional(),
  // bcrypt only reads the first 72 bytes; the bound just stops a multi-MB body.
  password: z
    .string()
    .max(128, "Password is too long")
    .min(6, "Password must be at least 6 characters"),
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
