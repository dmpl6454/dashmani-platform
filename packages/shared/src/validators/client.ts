import { z } from "zod";

export const clientLoginSchema = z.object({
  email: z.string().email("Invalid email"),
  password: z.string().min(1, "Password is required"),
});

export const createClientSchema = z.object({
  companyName: z.string().min(2, "Company name must be at least 2 characters").max(200),
  contactName: z.string().min(2, "Contact name must be at least 2 characters").max(200),
  email: z.string().email("Invalid email"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  phone: z.string().max(20).optional(),
});

export const updateClientSchema = z.object({
  companyName: z.string().min(2).max(200).optional(),
  contactName: z.string().min(2).max(200).optional(),
  phone: z.string().max(20).nullable().optional(),
  status: z.enum(["ACTIVE", "INACTIVE", "ONBOARDING"]).optional(),
});

export const createProjectSchema = z.object({
  name: z.string().min(2, "Project name must be at least 2 characters").max(200),
  description: z.string().max(2000).optional(),
  clientId: z.string().uuid("Invalid client ID"),
  startDate: z.string().date().optional(),
  endDate: z.string().date().optional(),
  accountIds: z.array(z.string().uuid()).optional(),
});

export const updateProjectSchema = z.object({
  name: z.string().min(2).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
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
