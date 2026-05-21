import { prisma } from "@dashmani/db";
import { AppError } from "../middleware/error-handler";
import type { Prisma } from "@dashmani/db";
import { sanitizeAccountHandle } from "@dashmani/shared";

const accountInclude = {
  platform: { select: { id: true, name: true, slug: true } },
  assignments: {
    where: { unassignedAt: null },
    include: {
      employee: { select: { id: true, name: true, email: true } },
    },
  },
  _count: { select: { tasks: true } },
};

export async function listPlatforms() {
  return prisma.platform.findMany({ orderBy: { name: "asc" } });
}

export async function listAccounts(params: {
  cursor?: string;
  limit: number;
  platformId?: string;
  status?: string;
  search?: string;
}) {
  const where: Prisma.SocialAccountWhereInput = {};
  if (params.platformId) where.platformId = params.platformId;
  if (params.status) where.status = params.status as any;
  if (params.search) {
    where.OR = [
      { handle: { contains: params.search, mode: "insensitive" } },
      { displayName: { contains: params.search, mode: "insensitive" } },
      { clientName: { contains: params.search, mode: "insensitive" } },
    ];
  }

  const accounts = await prisma.socialAccount.findMany({
    where,
    take: params.limit + 1,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    include: accountInclude,
    orderBy: { createdAt: "desc" },
  });

  const hasMore = accounts.length > params.limit;
  const items = hasMore ? accounts.slice(0, params.limit) : accounts;

  return {
    items,
    meta: {
      cursor: items.length > 0 ? items[items.length - 1].id : undefined,
      has_more: hasMore,
    },
  };
}

export async function getAccountById(id: string) {
  const account = await prisma.socialAccount.findUnique({
    where: { id },
    include: {
      ...accountInclude,
      assignments: {
        include: {
          employee: { select: { id: true, name: true, email: true } },
          assigner: { select: { id: true, name: true } },
        },
        orderBy: { assignedAt: "desc" },
      },
    },
  });
  if (!account) throw new AppError(404, "NOT_FOUND", "Social account not found");
  return account;
}

export async function createAccount(data: {
  handle: string;
  displayName: string;
  platformId: string;
  clientName?: string;
  profileUrl?: string;
}) {
  data = { ...data, handle: sanitizeAccountHandle(data.handle) };
  const platform = await prisma.platform.findUnique({ where: { id: data.platformId } });
  if (!platform) throw new AppError(404, "NOT_FOUND", "Platform not found");

  const existing = await prisma.socialAccount.findUnique({
    where: { handle_platformId: { handle: data.handle, platformId: data.platformId } },
  });
  if (existing) throw new AppError(409, "CONFLICT", "Account with this handle already exists on this platform");

  return prisma.socialAccount.create({
    data,
    include: accountInclude,
  });
}

export async function updateAccount(id: string, data: {
  handle?: string;
  displayName?: string;
  clientName?: string | null;
  profileUrl?: string | null;
  status?: string;
  followerCount?: number;
}) {
  if (data.handle) data = { ...data, handle: sanitizeAccountHandle(data.handle) };
  const account = await prisma.socialAccount.findUnique({ where: { id } });
  if (!account) throw new AppError(404, "NOT_FOUND", "Social account not found");

  return prisma.socialAccount.update({
    where: { id },
    data: data as any,
    include: accountInclude,
  });
}

export async function deleteAccount(id: string) {
  const account = await prisma.socialAccount.findUnique({
    where: { id },
    include: {
      _count: {
        select: { tasks: true, contentPosts: true, projectAccounts: true, reportLinks: true, growthSnapshots: true },
      },
    },
  });
  if (!account) throw new AppError(404, "NOT_FOUND", "Social account not found");

  const refs = account._count;
  const blocking = (refs.tasks || 0) + (refs.contentPosts || 0) + (refs.projectAccounts || 0) + (refs.reportLinks || 0) + (refs.growthSnapshots || 0);
  if (blocking > 0) {
    const parts: string[] = [];
    if (refs.tasks) parts.push(`${refs.tasks} task${refs.tasks > 1 ? "s" : ""}`);
    if (refs.contentPosts) parts.push(`${refs.contentPosts} content post${refs.contentPosts > 1 ? "s" : ""}`);
    if (refs.projectAccounts) parts.push(`${refs.projectAccounts} project link${refs.projectAccounts > 1 ? "s" : ""}`);
    if (refs.reportLinks) parts.push(`${refs.reportLinks} report link${refs.reportLinks > 1 ? "s" : ""}`);
    if (refs.growthSnapshots) parts.push(`${refs.growthSnapshots} growth snapshot${refs.growthSnapshots > 1 ? "s" : ""}`);
    throw new AppError(
      409,
      "HAS_REFERENCES",
      `Cannot delete account — it has ${parts.join(", ")}. Archive it instead to keep the history.`,
    );
  }

  // Assignments cascade automatically (onDelete: Cascade in schema)
  await prisma.socialAccount.delete({ where: { id } });
  return { id, deleted: true };
}

export async function assignEmployee(accountId: string, employeeId: string, assignedBy: string, reason?: string) {
  const account = await prisma.socialAccount.findUnique({ where: { id: accountId } });
  if (!account) throw new AppError(404, "NOT_FOUND", "Social account not found");

  const employee = await prisma.user.findFirst({ where: { id: employeeId, deletedAt: null } });
  if (!employee) throw new AppError(404, "NOT_FOUND", "Employee not found");

  const existing = await prisma.accountAssignment.findFirst({
    where: { accountId, employeeId, unassignedAt: null },
  });
  if (existing) throw new AppError(409, "ALREADY_ASSIGNED", "Employee already assigned to this account");

  return prisma.accountAssignment.create({
    data: { accountId, employeeId, assignedBy, reason },
    include: {
      employee: { select: { id: true, name: true, email: true } },
      account: { select: { id: true, handle: true, displayName: true } },
    },
  });
}

export async function unassignEmployee(accountId: string, employeeId: string) {
  const assignment = await prisma.accountAssignment.findFirst({
    where: { accountId, employeeId, unassignedAt: null },
  });
  if (!assignment) throw new AppError(404, "NOT_FOUND", "Active assignment not found");

  return prisma.accountAssignment.update({
    where: { id: assignment.id },
    data: { unassignedAt: new Date() },
  });
}

export async function getWorkloadMatrix() {
  const employees = await prisma.user.findMany({
    where: { status: "ACTIVE", deletedAt: null },
    select: {
      id: true,
      name: true,
      email: true,
      orgUnit: { select: { id: true, name: true } },
      assignedAccounts: {
        where: { unassignedAt: null },
        include: {
          account: {
            select: {
              id: true,
              handle: true,
              displayName: true,
              platform: { select: { name: true, slug: true } },
            },
          },
        },
      },
      assignedTasks: {
        where: { status: { in: ["TODO", "IN_PROGRESS", "IN_REVIEW"] } },
        select: { id: true, priority: true, status: true },
      },
    },
    orderBy: { name: "asc" },
  });

  return employees.map((emp) => ({
    id: emp.id,
    name: emp.name,
    email: emp.email,
    team: emp.orgUnit,
    accountCount: emp.assignedAccounts.length,
    accounts: emp.assignedAccounts.map((a) => ({
      id: a.account.id,
      handle: a.account.handle,
      displayName: a.account.displayName,
      platform: a.account.platform,
    })),
    openTaskCount: emp.assignedTasks.length,
    tasksByPriority: {
      critical: emp.assignedTasks.filter((t) => t.priority === "CRITICAL").length,
      high: emp.assignedTasks.filter((t) => t.priority === "HIGH").length,
      medium: emp.assignedTasks.filter((t) => t.priority === "MEDIUM").length,
      low: emp.assignedTasks.filter((t) => t.priority === "LOW").length,
    },
  }));
}
