import { prisma } from "@dashmani/db";
import { AppError } from "../middleware/error-handler";

export async function listOrgUnits(parentId?: string) {
  return prisma.orgUnit.findMany({
    where: parentId ? { parentId } : { parentId: null },
    include: {
      children: {
        include: { children: true },
      },
      members: {
        where: { deletedAt: null },
        select: { id: true, name: true, email: true, status: true },
      },
      _count: { select: { members: { where: { deletedAt: null } } } },
    },
    orderBy: { name: "asc" },
  });
}

export async function getOrgUnitById(id: string) {
  const unit = await prisma.orgUnit.findUnique({
    where: { id },
    include: {
      parent: true,
      children: true,
      members: {
        where: { deletedAt: null },
        select: { id: true, name: true, email: true, status: true, profileImageUrl: true },
      },
    },
  });
  if (!unit) throw new AppError(404, "NOT_FOUND", "Org unit not found");
  return unit;
}

export async function createOrgUnit(data: {
  name: string;
  type: "DEPARTMENT" | "TEAM" | "SUB_TEAM";
  parentId?: string;
  leadId?: string;
}) {
  if (data.parentId) {
    const parent = await prisma.orgUnit.findUnique({ where: { id: data.parentId } });
    if (!parent) throw new AppError(404, "NOT_FOUND", "Parent org unit not found");
  }

  return prisma.orgUnit.create({
    data,
    include: { parent: true },
  });
}

export async function updateOrgUnit(id: string, data: {
  name?: string;
  leadId?: string | null;
  parentId?: string | null;
}) {
  const unit = await prisma.orgUnit.findUnique({ where: { id } });
  if (!unit) throw new AppError(404, "NOT_FOUND", "Org unit not found");

  return prisma.orgUnit.update({
    where: { id },
    data,
    include: { parent: true, children: true },
  });
}

export async function deleteOrgUnit(id: string) {
  const unit = await prisma.orgUnit.findUnique({
    where: { id },
    include: { _count: { select: { members: true, children: true } } },
  });
  if (!unit) throw new AppError(404, "NOT_FOUND", "Org unit not found");
  if (unit._count.members > 0) throw new AppError(400, "HAS_MEMBERS", "Cannot delete org unit with members. Reassign members first.");
  if (unit._count.children > 0) throw new AppError(400, "HAS_CHILDREN", "Cannot delete org unit with sub-units. Delete or move sub-units first.");

  await prisma.orgUnit.delete({ where: { id } });
}
