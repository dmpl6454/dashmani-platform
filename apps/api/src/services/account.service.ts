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

// ─── Link statistics ────────────────────────────────────────────────────────

/**
 * Returns every social account that had at least one link submitted in the
 * given date range, ranked by total links descending.  Each entry includes a
 * per-employee breakdown so the caller can show "who submitted how many links
 * for this channel".
 */
export async function getAllAccountsLinkStats(startDate?: string, endDate?: string) {
  const now = new Date();
  const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = endDate ? new Date(endDate) : todayUTC;
  const start = startDate ? new Date(startDate) : new Date(todayUTC.getTime() - 29 * 86400000);

  const links = await prisma.reportLink.findMany({
    where: { report: { date: { gte: start, lte: end } } },
    select: {
      accountId: true,
      account: {
        select: {
          id: true,
          handle: true,
          displayName: true,
          platform: { select: { name: true, slug: true } },
        },
      },
      report: {
        select: {
          employeeId: true,
          employee: { select: { id: true, name: true } },
        },
      },
    },
  });

  // Aggregate by account then by employee
  const accountMap: Record<string, {
    account: any;
    employees: Record<string, { name: string; count: number }>;
  }> = {};

  for (const link of links) {
    if (!link.accountId) continue;
    const aId = link.accountId;
    if (!accountMap[aId]) accountMap[aId] = { account: link.account, employees: {} };
    const eId = link.report.employeeId;
    if (!accountMap[aId].employees[eId]) {
      accountMap[aId].employees[eId] = { name: link.report.employee.name, count: 0 };
    }
    accountMap[aId].employees[eId].count++;
  }

  return Object.entries(accountMap)
    .map(([accountId, data]) => {
      const empEntries = Object.entries(data.employees).sort(([, a], [, b]) => b.count - a.count);
      const totalLinks = empEntries.reduce((s, [, e]) => s + e.count, 0);
      return {
        accountId,
        handle: data.account?.handle ?? accountId,
        displayName: data.account?.displayName ?? accountId,
        platform: data.account?.platform?.name ?? "Unknown",
        platformSlug: data.account?.platform?.slug ?? "",
        totalLinks,
        employeeCount: empEntries.length,
        topEmployee: empEntries[0]
          ? { name: empEntries[0][1].name, totalLinks: empEntries[0][1].count }
          : null,
        employees: empEntries.map(([empId, e]) => ({
          employeeId: empId,
          name: e.name,
          totalLinks: e.count,
          pct: totalLinks > 0 ? Math.round((e.count / totalLinks) * 100) : 0,
        })),
      };
    })
    .sort((a, b) => b.totalLinks - a.totalLinks);
}

/**
 * Returns link statistics for a single account: daily trend + per-employee
 * breakdown for the given date range.
 */
export async function getAccountLinkStats(id: string, startDate?: string, endDate?: string) {
  const account = await prisma.socialAccount.findUnique({
    where: { id },
    select: {
      id: true,
      handle: true,
      displayName: true,
      platform: { select: { name: true, slug: true } },
    },
  });
  if (!account) throw new AppError(404, "NOT_FOUND", "Social account not found");

  const now = new Date();
  const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = endDate ? new Date(endDate) : todayUTC;
  const start = startDate ? new Date(startDate) : new Date(todayUTC.getTime() - 29 * 86400000);

  const links = await prisma.reportLink.findMany({
    where: { accountId: id, report: { date: { gte: start, lte: end } } },
    select: {
      report: {
        select: {
          date: true,
          employeeId: true,
          employee: { select: { id: true, name: true, email: true } },
        },
      },
    },
    orderBy: { report: { date: "asc" } },
  });

  const totalLinks = links.length;

  // Daily trend (filled with zeroes)
  const dailyMap: Record<string, number> = {};
  for (const link of links) {
    const d = new Date(link.report.date).toISOString().split("T")[0];
    dailyMap[d] = (dailyMap[d] || 0) + 1;
  }
  const dayCount = Math.ceil((end.getTime() - start.getTime()) / 86400000) + 1;
  const dailyTrend: { date: string; count: number }[] = [];
  for (let i = 0; i < dayCount; i++) {
    const d = new Date(start.getTime() + i * 86400000).toISOString().split("T")[0];
    dailyTrend.push({ date: d, count: dailyMap[d] || 0 });
  }

  // Per-employee breakdown
  const empMap: Record<string, { name: string; email: string; totalLinks: number; reportDates: Set<string> }> = {};
  for (const link of links) {
    const eId = link.report.employeeId;
    if (!empMap[eId]) {
      empMap[eId] = { name: link.report.employee.name, email: link.report.employee.email, totalLinks: 0, reportDates: new Set() };
    }
    empMap[eId].totalLinks++;
    empMap[eId].reportDates.add(new Date(link.report.date).toISOString().split("T")[0]);
  }

  const employeeBreakdown = Object.entries(empMap)
    .sort(([, a], [, b]) => b.totalLinks - a.totalLinks)
    .map(([employeeId, data]) => ({
      employeeId,
      name: data.name,
      email: data.email,
      totalLinks: data.totalLinks,
      reportCount: data.reportDates.size,
      pct: totalLinks > 0 ? Math.round((data.totalLinks / totalLinks) * 100) : 0,
    }));

  return {
    account,
    totalLinks,
    dateRange: { startDate: start.toISOString().split("T")[0], endDate: end.toISOString().split("T")[0] },
    dailyTrend,
    employeeBreakdown,
  };
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
