import { z } from "zod";

export const createContentPostSchema = z.object({
  title: z.string().min(2, "Title must be at least 2 characters").max(200),
  caption: z.string().max(5000).optional(),
  mediaUrls: z.array(z.string().url("Each media URL must be a valid URL")).max(10).optional(),
  projectId: z.string().uuid("Invalid project ID"),
  accountId: z.string().uuid("Invalid account ID").optional(),
  scheduledAt: z.string().datetime({ offset: true }).optional(),
});

export const updateContentPostSchema = z.object({
  title: z.string().min(2).max(200).optional(),
  caption: z.string().max(5000).nullable().optional(),
  mediaUrls: z.array(z.string().url()).max(10).optional(),
  projectId: z.string().uuid().optional(),
  accountId: z.string().uuid().nullable().optional(),
  scheduledAt: z.string().datetime({ offset: true }).nullable().optional(),
});

export const updateContentStatusSchema = z.object({
  status: z.enum([
    "DRAFT",
    "PENDING_APPROVAL",
    "APPROVED",
    "SCHEDULED",
    "PUBLISHED",
    "FAILED",
    "REJECTED",
  ]),
});

export const contentCalendarQuerySchema = z.object({
  year: z.coerce.number().int().min(2020).max(2100),
  month: z.coerce.number().int().min(1).max(12),
  projectId: z.string().uuid().optional(),
});

export const respondContentApprovalSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED"]),
  clientNote: z.string().max(2000).optional(),
});
