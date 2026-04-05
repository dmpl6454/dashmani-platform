import { prisma } from "@dashmani/db";
import { AppError } from "../middleware/error-handler";
import type { Prisma } from "@dashmani/db";

const projectInclude = {
  client: { select: { id: true, companyName: true } },
  accounts: {
    include: {
      account: {
        select: { id: true, handle: true, displayName: true, platform: { select: { name: true, slug: true } } },
      },
    },
  },
  _count: { select: { tasks: true, files: true, approvals: true } },
};

export async function listProjects(params: {
  cursor?: string;
  limit: number;
  clientId?: string;
  status?: string;
  search?: string;
}) {
  const where: Prisma.ProjectWhereInput = {};
  if (params.clientId) where.clientId = params.clientId;
  if (params.status) where.status = params.status as any;
  if (params.search) {
    where.OR = [
      { name: { contains: params.search, mode: "insensitive" } },
      { description: { contains: params.search, mode: "insensitive" } },
    ];
  }

  const projects = await prisma.project.findMany({
    where,
    take: params.limit + 1,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    include: projectInclude,
    orderBy: { createdAt: "desc" },
  });

  const hasMore = projects.length > params.limit;
  const items = hasMore ? projects.slice(0, params.limit) : projects;

  return {
    items,
    meta: { cursor: items.length > 0 ? items[items.length - 1].id : undefined, has_more: hasMore },
  };
}

export async function getProjectById(id: string) {
  const project = await prisma.project.findUnique({
    where: { id },
    include: {
      ...projectInclude,
      tasks: {
        include: {
          task: {
            select: { id: true, title: true, status: true, priority: true, dueDate: true,
              assignee: { select: { id: true, name: true } } },
          },
        },
      },
      files: {
        include: { uploadedBy: { select: { id: true, name: true } } },
        orderBy: { createdAt: "desc" },
      },
      approvals: {
        include: { requestedBy: { select: { id: true, name: true } } },
        orderBy: { createdAt: "desc" },
      },
    },
  });
  if (!project) throw new AppError(404, "NOT_FOUND", "Project not found");
  return project;
}

export async function createProject(data: {
  name: string;
  description?: string;
  clientId: string;
  startDate?: string;
  endDate?: string;
  accountIds?: string[];
}) {
  const client = await prisma.client.findUnique({ where: { id: data.clientId } });
  if (!client) throw new AppError(404, "NOT_FOUND", "Client not found");

  return prisma.project.create({
    data: {
      name: data.name,
      description: data.description,
      clientId: data.clientId,
      startDate: data.startDate ? new Date(data.startDate) : undefined,
      endDate: data.endDate ? new Date(data.endDate) : undefined,
      accounts: data.accountIds
        ? { create: data.accountIds.map((accountId) => ({ accountId })) }
        : undefined,
    },
    include: projectInclude,
  });
}

export async function updateProject(id: string, data: {
  name?: string;
  description?: string | null;
  status?: string;
  startDate?: string | null;
  endDate?: string | null;
}) {
  const project = await prisma.project.findUnique({ where: { id } });
  if (!project) throw new AppError(404, "NOT_FOUND", "Project not found");

  const updateData: any = {};
  if (data.name !== undefined) updateData.name = data.name;
  if (data.description !== undefined) updateData.description = data.description;
  if (data.status !== undefined) updateData.status = data.status;
  if (data.startDate !== undefined) updateData.startDate = data.startDate ? new Date(data.startDate) : null;
  if (data.endDate !== undefined) updateData.endDate = data.endDate ? new Date(data.endDate) : null;

  return prisma.project.update({ where: { id }, data: updateData, include: projectInclude });
}

export async function addAccountToProject(projectId: string, accountId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw new AppError(404, "NOT_FOUND", "Project not found");

  const existing = await prisma.projectAccount.findUnique({
    where: { projectId_accountId: { projectId, accountId } },
  });
  if (existing) throw new AppError(409, "ALREADY_LINKED", "Account already linked to this project");

  return prisma.projectAccount.create({ data: { projectId, accountId } });
}

export async function removeAccountFromProject(projectId: string, accountId: string) {
  const link = await prisma.projectAccount.findUnique({
    where: { projectId_accountId: { projectId, accountId } },
  });
  if (!link) throw new AppError(404, "NOT_FOUND", "Account not linked to this project");

  await prisma.projectAccount.delete({ where: { id: link.id } });
}

export async function addTaskToProject(projectId: string, taskId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw new AppError(404, "NOT_FOUND", "Project not found");

  const existing = await prisma.projectTask.findUnique({
    where: { projectId_taskId: { projectId, taskId } },
  });
  if (existing) throw new AppError(409, "ALREADY_LINKED", "Task already linked to this project");

  return prisma.projectTask.create({ data: { projectId, taskId } });
}

export async function removeTaskFromProject(projectId: string, taskId: string) {
  const link = await prisma.projectTask.findUnique({
    where: { projectId_taskId: { projectId, taskId } },
  });
  if (!link) throw new AppError(404, "NOT_FOUND", "Task not linked to this project");

  await prisma.projectTask.delete({ where: { id: link.id } });
}

export async function addFile(projectId: string, uploadedById: string, data: { name: string; url: string; size: number; mimeType?: string }) {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw new AppError(404, "NOT_FOUND", "Project not found");

  return prisma.projectFile.create({
    data: { projectId, uploadedById, ...data },
    include: { uploadedBy: { select: { id: true, name: true } } },
  });
}

export async function deleteFile(fileId: string) {
  const file = await prisma.projectFile.findUnique({ where: { id: fileId } });
  if (!file) throw new AppError(404, "NOT_FOUND", "File not found");

  await prisma.projectFile.delete({ where: { id: fileId } });
}
