import { prisma } from "@dashmani/db";
import { hashPassword } from "../utils/password";
import { AppError } from "../middleware/error-handler";
import type { Prisma } from "@dashmani/db";

export async function listEmployees(params: {
  cursor?: string;
  limit: number;
  status?: string;
  orgUnitId?: string;
  search?: string;
}) {
  const where: Prisma.UserWhereInput = { deletedAt: null };
  if (params.status) where.status = params.status as any;
  if (params.orgUnitId) where.orgUnitId = params.orgUnitId;
  if (params.search) {
    where.OR = [
      { name: { contains: params.search, mode: "insensitive" } },
      { email: { contains: params.search, mode: "insensitive" } },
    ];
  }

  const employees = await prisma.user.findMany({
    where,
    take: params.limit + 1,
    ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    include: {
      roles: { include: { role: { select: { id: true, name: true } } } },
      orgUnit: { select: { id: true, name: true, type: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  const hasMore = employees.length > params.limit;
  const items = hasMore ? employees.slice(0, params.limit) : employees;

  return {
    items: items.map((e) => ({
      id: e.id,
      name: e.name,
      email: e.email,
      phone: e.phone,
      status: e.status,
      profileImageUrl: e.profileImageUrl,
      orgUnit: e.orgUnit,
      roles: e.roles.map((r) => r.role),
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
    })),
    meta: {
      cursor: items.length > 0 ? items[items.length - 1].id : undefined,
      has_more: hasMore,
    },
  };
}

export async function getEmployeeById(id: string) {
  const employee = await prisma.user.findFirst({
    where: { id, deletedAt: null },
    include: {
      roles: { include: { role: { include: { permissions: true } } } },
      orgUnit: true,
    },
  });
  if (!employee) throw new AppError(404, "NOT_FOUND", "Employee not found");
  return employee;
}

export async function createEmployee(data: {
  name: string;
  email: string;
  password: string;
  phone?: string;
  orgUnitId?: string;
  roleIds: string[];
}) {
  const email = data.email.trim().toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw new AppError(409, "CONFLICT", "Email already in use");

  const passwordHash = await hashPassword(data.password);

  const employee = await prisma.user.create({
    data: {
      name: data.name,
      email,
      passwordHash,
      phone: data.phone,
      orgUnitId: data.orgUnitId,
      status: "ONBOARDING",
      roles: {
        create: data.roleIds.map((roleId) => ({ roleId })),
      },
    },
    include: {
      roles: { include: { role: { select: { id: true, name: true } } } },
      orgUnit: { select: { id: true, name: true } },
    },
  });

  return employee;
}

export async function updateEmployee(id: string, data: {
  name?: string;
  phone?: string;
  orgUnitId?: string | null;
  status?: string;
  roleIds?: string[];
}) {
  const employee = await prisma.user.findFirst({ where: { id, deletedAt: null } });
  if (!employee) throw new AppError(404, "NOT_FOUND", "Employee not found");

  const updateData: Prisma.UserUpdateInput = {};
  if (data.name) updateData.name = data.name;
  if (data.phone !== undefined) updateData.phone = data.phone;
  if (data.orgUnitId !== undefined) {
    updateData.orgUnit = data.orgUnitId ? { connect: { id: data.orgUnitId } } : { disconnect: true };
  }
  if (data.status) updateData.status = data.status as any;

  if (data.roleIds) {
    await prisma.userRole.deleteMany({ where: { userId: id } });
    await prisma.userRole.createMany({
      data: data.roleIds.map((roleId) => ({ userId: id, roleId })),
    });
  }

  return prisma.user.update({
    where: { id },
    data: updateData,
    include: {
      roles: { include: { role: { select: { id: true, name: true } } } },
      orgUnit: { select: { id: true, name: true } },
    },
  });
}

export async function getEmployeeAccounts(employeeId: string) {
  return prisma.accountAssignment.findMany({
    where: { employeeId, unassignedAt: null },
    include: {
      account: {
        include: { platform: { select: { id: true, name: true, slug: true, iconUrl: true } } },
      },
      assigner: { select: { id: true, name: true } },
    },
    orderBy: { assignedAt: "desc" },
  });
}

export async function softDeleteEmployee(id: string) {
  const employee = await prisma.user.findFirst({ where: { id, deletedAt: null } });
  if (!employee) throw new AppError(404, "NOT_FOUND", "Employee not found");

  return prisma.user.update({
    where: { id },
    data: { deletedAt: new Date(), status: "INACTIVE" },
  });
}
