import { prisma } from "@dashmani/db";
import { AppError } from "../middleware/error-handler";
import type { Prisma } from "@dashmani/db";
import { dispatchNotification } from "./notification.service";

const taskInclude = {
  assignee: { select: { id: true, name: true, email: true } },
  createdBy: { select: { id: true, name: true, email: true } },
  account: { select: { id: true, handle: true, displayName: true, platform: { select: { name: true, slug: true } } } },
  dependsOn: { select: { id: true, title: true, status: true } },
  _count: { select: { comments: true } },
};

export async function listTasks(params: {
  cursor?: string;
  limit: number;
  status?: string;
  priority?: string;
  assigneeId?: string;
  accountId?: string;
  search?: string;
}) {
  const where: Prisma.TaskWhereInput = {};
  if (params.status) where.status = params.status as any;
  if (params.priority) where.priority = params.priority as any;
  if (params.assigneeId) where.assigneeId = params.assigneeId;
  if (params.accountId) where.accountId = params.accountId;
  if (params.search) {
    where.OR = [
      { title: { contains: params.search, mode: "insensitive" } },
      { description: { contains: params.search, mode: "insensitive" } },
    ];
  }

  const tasks = await prisma.task.findMany({
    where,
    take: params.limit + 1,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    include: taskInclude,
    orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
  });

  const hasMore = tasks.length > params.limit;
  const items = hasMore ? tasks.slice(0, params.limit) : tasks;

  return {
    items,
    meta: {
      cursor: items.length > 0 ? items[items.length - 1].id : undefined,
      has_more: hasMore,
    },
  };
}

export async function getTaskById(id: string) {
  const task = await prisma.task.findUnique({
    where: { id },
    include: {
      ...taskInclude,
      comments: {
        include: { author: { select: { id: true, name: true } } },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!task) throw new AppError(404, "NOT_FOUND", "Task not found");
  return task;
}

export async function createTask(data: {
  title: string;
  description?: string;
  priority?: string;
  assigneeId?: string;
  accountId?: string;
  dueDate?: string;
  dependsOnId?: string;
  createdById: string;
}) {
  if (data.dependsOnId) {
    const dep = await prisma.task.findUnique({ where: { id: data.dependsOnId } });
    if (!dep) throw new AppError(404, "NOT_FOUND", "Dependency task not found");
  }

  const task = await prisma.task.create({
    data: {
      title: data.title,
      description: data.description,
      priority: (data.priority as any) || "MEDIUM",
      assigneeId: data.assigneeId,
      createdById: data.createdById,
      accountId: data.accountId,
      dueDate: data.dueDate ? new Date(data.dueDate) : undefined,
      dependsOnId: data.dependsOnId,
    },
    include: taskInclude,
  });

  if (data.assigneeId) {
    dispatchNotification({
      type: "TASK_ASSIGNED",
      recipientUserId: data.assigneeId,
      title: `New task assigned: ${task.title}`,
      message: `You've been assigned a new task${task.dueDate ? ` due ${new Date(task.dueDate).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}` : ""}.`,
    }).catch(() => {});
  }

  return task;
}

export async function updateTask(id: string, data: {
  title?: string;
  description?: string | null;
  priority?: string;
  assigneeId?: string | null;
  accountId?: string | null;
  dueDate?: string | null;
  dependsOnId?: string | null;
}) {
  const task = await prisma.task.findUnique({ where: { id } });
  if (!task) throw new AppError(404, "NOT_FOUND", "Task not found");

  const previousAssigneeId = task.assigneeId;

  const updateData: Prisma.TaskUpdateInput = {};
  if (data.title !== undefined) updateData.title = data.title;
  if (data.description !== undefined) updateData.description = data.description;
  if (data.priority !== undefined) updateData.priority = data.priority as any;
  if (data.dueDate !== undefined) updateData.dueDate = data.dueDate ? new Date(data.dueDate) : null;

  if (data.assigneeId !== undefined) {
    updateData.assignee = data.assigneeId ? { connect: { id: data.assigneeId } } : { disconnect: true };
  }
  if (data.accountId !== undefined) {
    updateData.account = data.accountId ? { connect: { id: data.accountId } } : { disconnect: true };
  }
  if (data.dependsOnId !== undefined) {
    updateData.dependsOn = data.dependsOnId ? { connect: { id: data.dependsOnId } } : { disconnect: true };
  }

  const updated = await prisma.task.update({
    where: { id },
    data: updateData,
    include: taskInclude,
  });

  // Notify newly assigned employee (skip if same person was already assigned)
  if (data.assigneeId && data.assigneeId !== previousAssigneeId) {
    dispatchNotification({
      type: "TASK_ASSIGNED",
      recipientUserId: data.assigneeId,
      title: `New task assigned: ${updated.title}`,
      message: `You've been assigned a new task${updated.dueDate ? ` due ${new Date(updated.dueDate).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}` : ""}.`,
    }).catch(() => {});
  }

  return updated;
}

export async function updateTaskStatus(id: string, status: string) {
  const task = await prisma.task.findUnique({
    where: { id },
    include: { dependsOn: { select: { id: true, status: true } } },
  });
  if (!task) throw new AppError(404, "NOT_FOUND", "Task not found");

  if (status === "IN_PROGRESS" && task.dependsOn && task.dependsOn.status !== "DONE") {
    throw new AppError(400, "DEPENDENCY_NOT_DONE", `Blocked by task "${task.dependsOn.id}" which is ${task.dependsOn.status}`);
  }

  const completedAt = status === "DONE" ? new Date() : null;

  return prisma.task.update({
    where: { id },
    data: { status: status as any, completedAt },
    include: taskInclude,
  });
}

export async function deleteTask(id: string) {
  const task = await prisma.task.findUnique({ where: { id } });
  if (!task) throw new AppError(404, "NOT_FOUND", "Task not found");

  const dependents = await prisma.task.count({ where: { dependsOnId: id } });
  if (dependents > 0) throw new AppError(400, "HAS_DEPENDENTS", "Cannot delete task that other tasks depend on");

  await prisma.task.delete({ where: { id } });
}

export async function addComment(taskId: string, authorId: string, body: string) {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) throw new AppError(404, "NOT_FOUND", "Task not found");

  return prisma.taskComment.create({
    data: { taskId, authorId, body },
    include: { author: { select: { id: true, name: true } } },
  });
}

export async function listComments(taskId: string) {
  return prisma.taskComment.findMany({
    where: { taskId },
    include: { author: { select: { id: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });
}
