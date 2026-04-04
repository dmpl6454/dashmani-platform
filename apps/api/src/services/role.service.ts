import { prisma } from "@dashmani/db";
import { AppError } from "../middleware/error-handler";

export async function listRoles() {
  return prisma.role.findMany({
    include: { permissions: true },
    orderBy: { name: "asc" },
  });
}

export async function getRoleById(id: string) {
  const role = await prisma.role.findUnique({
    where: { id },
    include: { permissions: true },
  });
  if (!role) throw new AppError(404, "NOT_FOUND", "Role not found");
  return role;
}

export async function createRole(data: {
  name: string;
  description?: string;
  permissions: { resource: string; action: string; scope: string }[];
}) {
  return prisma.role.create({
    data: {
      name: data.name,
      description: data.description,
      permissions: { create: data.permissions },
    },
    include: { permissions: true },
  });
}

export async function updateRolePermissions(
  roleId: string,
  permissions: { resource: string; action: string; scope: string }[],
) {
  const role = await prisma.role.findUnique({ where: { id: roleId } });
  if (!role) throw new AppError(404, "NOT_FOUND", "Role not found");
  if (role.isSystemRole) throw new AppError(403, "FORBIDDEN", "Cannot modify system role permissions");

  await prisma.rolePermission.deleteMany({ where: { roleId } });

  return prisma.role.update({
    where: { id: roleId },
    data: {
      permissions: { create: permissions },
    },
    include: { permissions: true },
  });
}

export async function deleteRole(id: string) {
  const role = await prisma.role.findUnique({ where: { id } });
  if (!role) throw new AppError(404, "NOT_FOUND", "Role not found");
  if (role.isSystemRole) throw new AppError(403, "FORBIDDEN", "Cannot delete system role");

  await prisma.role.delete({ where: { id } });
}
