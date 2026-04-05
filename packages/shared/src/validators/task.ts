import { z } from "zod";

export const createTaskSchema = z.object({
  title: z.string().min(2, "Title must be at least 2 characters").max(200),
  description: z.string().max(5000).optional(),
  priority: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]).optional(),
  assigneeId: z.string().uuid().optional(),
  accountId: z.string().uuid().optional(),
  dueDate: z.string().datetime({ offset: true }).or(z.string().date()).optional(),
  dependsOnId: z.string().uuid().optional(),
});

export const updateTaskSchema = z.object({
  title: z.string().min(2).max(200).optional(),
  description: z.string().max(5000).nullable().optional(),
  priority: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]).optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  accountId: z.string().uuid().nullable().optional(),
  dueDate: z.string().datetime({ offset: true }).or(z.string().date()).nullable().optional(),
  dependsOnId: z.string().uuid().nullable().optional(),
});

export const updateTaskStatusSchema = z.object({
  status: z.enum(["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE", "CANCELLED"]),
});

export const createTaskCommentSchema = z.object({
  body: z.string().min(1, "Comment cannot be empty").max(5000),
});
