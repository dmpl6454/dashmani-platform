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
  includeDeleted?: boolean;
}) {
  const where: Prisma.UserWhereInput = params.includeDeleted
    ? { deletedAt: { not: null } }
    : { deletedAt: null };
  if (params.status && !params.includeDeleted) where.status = params.status as any;
  if (params.orgUnitId) where.orgUnitId = params.orgUnitId;
  if (params.search) {
    where.OR = [
      { name: { contains: params.search, mode: "insensitive" } },
      { email: { contains: params.search, mode: "insensitive" } },
    ];
  }

  const [employees, total] = await Promise.all([
    prisma.user.findMany({
      where,
      take: params.limit + 1,
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
      include: {
        roles: { include: { role: { select: { id: true, name: true } } } },
        orgUnit: { select: { id: true, name: true, type: true } },
      },
      orderBy: [{ name: "asc" }, { createdAt: "desc" }],
    }),
    prisma.user.count({ where }),
  ]);

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
      total,
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
  designation?: string;
  department?: string;
  joinDate?: string;
  salary?: number;
}) {
  const email = data.email.trim().toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw new AppError(409, "CONFLICT", "Email already in use");

  const passwordHash = await hashPassword(data.password);
  const roleIds = await resolveRoleIds(data.roleIds);

  const employee = await prisma.user.create({
    data: {
      name: data.name,
      email,
      passwordHash,
      phone: data.phone,
      orgUnitId: data.orgUnitId,
      status: "ONBOARDING",
      roles: {
        create: roleIds.map((roleId) => ({ roleId })),
      },
      profile: (data.designation || data.salary != null || data.joinDate) ? {
        create: {
          designation: data.designation || null,
          salary: data.salary ?? null,
          joiningDate: data.joinDate ? new Date(data.joinDate) : null,
        },
      } : undefined,
    },
    include: {
      roles: { include: { role: { select: { id: true, name: true } } } },
      orgUnit: { select: { id: true, name: true } },
      profile: { select: { designation: true, salary: true, joiningDate: true } },
    },
  });

  return employee;
}

async function resolveRoleIds(roleIds: string[]): Promise<string[]> {
  if (roleIds.length > 0) return roleIds;
  const employeeRole = await prisma.role.findUnique({ where: { name: "Employee" } });
  return employeeRole ? [employeeRole.id] : [];
}

export async function updateEmployee(id: string, data: {
  name?: string;
  phone?: string;
  orgUnitId?: string | null;
  status?: string;
  roleIds?: string[];
}) {
  const employee = await prisma.user.findFirst({ where: { id } });
  if (!employee) throw new AppError(404, "NOT_FOUND", "Employee not found");

  const updateData: Prisma.UserUpdateInput = {};
  if (data.name) updateData.name = data.name;
  if (data.phone !== undefined) updateData.phone = data.phone;
  if (data.orgUnitId !== undefined) {
    updateData.orgUnit = data.orgUnitId ? { connect: { id: data.orgUnitId } } : { disconnect: true };
  }
  if (data.status) {
    if (data.status === "INACTIVE") {
      const activeAssignments = await prisma.accountAssignment.count({
        where: { employeeId: id, unassignedAt: null },
      });
      if (activeAssignments > 0) {
        throw new AppError(
          409,
          "ACTIVE_ASSIGNMENTS",
          `Remove all ${activeAssignments} assigned channel(s) before deactivating this employee.`
        );
      }
    }
    updateData.status = data.status as any;
    if (data.status === "ACTIVE") updateData.deletedAt = null;
  }

  if (data.roleIds) {
    if (data.roleIds.length === 0) {
      throw new AppError(400, "NO_ROLES", "Every employee must have at least one role. Assign the Employee role if no other role applies.");
    }
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

  const activeAssignments = await prisma.accountAssignment.count({
    where: { employeeId: id, unassignedAt: null },
  });
  if (activeAssignments > 0) {
    throw new AppError(
      409,
      "ACTIVE_ASSIGNMENTS",
      `Remove all ${activeAssignments} assigned channel(s) before archiving this employee.`
    );
  }

  return prisma.user.update({
    where: { id },
    data: { deletedAt: new Date(), status: "INACTIVE" },
  });
}
