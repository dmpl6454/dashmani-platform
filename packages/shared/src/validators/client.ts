import { z } from "zod";
import { safeString, normalizedEmail } from "../utils/sanitize";

export const clientLoginSchema = z.object({
  email: normalizedEmail,
  password: z.string().min(1, "Password is required"),
});

export const createClientSchema = z.object({
  companyName: safeString.pipe(z.string().min(2, "Company name must be at least 2 characters").max(200)),
  contactName: safeString.pipe(z.string().min(2, "Contact name must be at least 2 characters").max(200)),
  email: normalizedEmail,
  password: z.string().min(8, "Password must be at least 8 characters"),
  phone: z.string().max(20).optional(),
});

export const updateClientSchema = z.object({
  companyName: safeString.pipe(z.string().min(2).max(200)).optional(),
  contactName: safeString.pipe(z.string().min(2).max(200)).optional(),
  phone: z.string().max(20).nullable().optional(),
  status: z.enum(["ACTIVE", "INACTIVE", "ONBOARDING"]).optional(),
});

export const createProjectSchema = z.object({
  name: safeString.pipe(z.string().min(2, "Project name must be at least 2 characters").max(200)),
  description: safeString.pipe(z.string().max(2000)).optional(),
  clientId: z.string().uuid("Invalid client ID"),
  startDate: z.string().date().optional(),
  endDate: z.string().date().optional(),
  accountIds: z.array(z.string().uuid()).optional(),
});

export const updateProjectSchema = z.object({
  name: safeString.pipe(z.string().min(2).max(200)).optional(),
  description: safeString.pipe(z.string().max(2000)).nullable().optional(),
  status: z.enum(["ACTIVE", "PAUSED", "COMPLETED", "ARCHIVED"]).optional(),
  startDate: z.string().date().nullable().optional(),
  endDate: z.string().date().nullable().optional(),
});

export const createApprovalSchema = z.object({
  title: z.string().min(2, "Title is required").max(200),
  description: z.string().max(2000).optional(),
  fileUrl: z.string().url().optional(),
});

export const respondApprovalSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED", "REVISION_REQUESTED"]),
  clientNote: z.string().max(2000).optional(),
});

export const addProjectAccountSchema = z.object({
  accountId: z.string().uuid("Invalid account ID"),
});

export const addProjectTaskSchema = z.object({
  taskId: z.string().uuid("Invalid task ID"),
});

export const clientRegisterSchema = z.object({
  token:    z.string().uuid("Invalid invite token"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  contactName: z.string().min(2).max(200).optional(),
});

export const createInviteSchema = z.object({
  email: normalizedEmail,
});

export const createBriefSchema = z.object({
  projectId:    z.string().uuid("Invalid project ID"),
  title:        z.string().min(2, "Title must be at least 2 characters").max(200),
  description:  z.string().min(2, "Description must be at least 2 characters").max(4000),
  referenceUrl: z.string().url("Invalid URL").optional().or(z.literal("").transform(() => undefined)),
});
