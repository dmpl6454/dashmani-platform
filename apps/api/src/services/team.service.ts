import { prisma } from "@dashmani/db";
import { AppError } from "../middleware/error-handler";

export async function countTeams() {
  return prisma.orgUnit.count({ where: { parentId: null } });
}

// Member selection now comes from the TeamMembership join table so a user shows
// under EVERY team they belong to, not only the one their primary orgUnitId points at.
const membershipInclude = {
  where: { user: { deletedAt: null } },
  select: {
    isPrimary: true,
    user: { select: { id: true, name: true, email: true, status: true, profileImageUrl: true } },
  },
  orderBy: { isPrimary: "desc" as const },
};

// Flatten { isPrimary, user } join rows into the { id, name, ... isPrimary } member
// shape the old code returned, so callers/UI don't need to reach through `.user`.
function flattenMembers(memberships: { isPrimary: boolean; user: any }[]) {
  return memberships.map((m) => ({ ...m.user, isPrimary: m.isPrimary }));
}

export async function listOrgUnits(parentId?: string) {
  const units = await prisma.orgUnit.findMany({
    where: parentId ? { parentId } : { parentId: null },
    include: {
      children: {
        include: {
          children: { include: { memberships: membershipInclude } },
          memberships: membershipInclude,
        },
      },
      memberships: membershipInclude,
    },
    orderBy: { name: "asc" },
  });

  // Map memberships → members on every level of the hierarchy.
  const mapUnit = (u: any): any => ({
    ...u,
    members: flattenMembers(u.memberships ?? []),
    _count: { members: (u.memberships ?? []).length },
    memberships: undefined,
    children: (u.children ?? []).map(mapUnit),
  });

  return units.map(mapUnit);
}

export async function getOrgUnitById(id: string) {
  const unit = await prisma.orgUnit.findUnique({
    where: { id },
    include: {
      parent: true,
      children: true,
      memberships: membershipInclude,
    },
  });
  if (!unit) throw new AppError(404, "NOT_FOUND", "Org unit not found");
  const { memberships, ...rest } = unit;
  return { ...rest, members: flattenMembers(memberships) };
}

/**
 * Add a user to a team. Creates a TeamMembership row (idempotent — re-adding an
 * existing member is a no-op). If the user has no primary team yet, this team
 * becomes their primary (keeps single-team read paths populated). A user can now
 * belong to multiple teams at once — this NEVER removes them from another team.
 */
export async function addMember(orgUnitId: string, userId: string) {
  const [unit, user] = await Promise.all([
    prisma.orgUnit.findUnique({ where: { id: orgUnitId } }),
    prisma.user.findUnique({ where: { id: userId }, select: { id: true } }),
  ]);
  if (!unit) throw new AppError(404, "NOT_FOUND", "Team not found");
  if (!user) throw new AppError(404, "NOT_FOUND", "Employee not found");

  await prisma.$transaction(async (tx) => {
    // Decide "make this the primary team" INSIDE the transaction so two
    // concurrent first-adds can't both observe orgUnitId=null and each claim
    // primary (which would leave two isPrimary=true rows). We gate on the
    // user's current primary AND on whether any membership is already primary.
    const current = await tx.user.findUnique({ where: { id: userId }, select: { orgUnitId: true } });
    const hasPrimaryMembership = await tx.teamMembership.count({ where: { userId, isPrimary: true } });
    const makePrimary = !current?.orgUnitId && hasPrimaryMembership === 0;

    await tx.teamMembership.upsert({
      where: { userId_orgUnitId: { userId, orgUnitId } },
      create: { userId, orgUnitId, isPrimary: makePrimary },
      update: {},
    });
    // Adopt this team as primary only if the user had none.
    if (makePrimary) {
      await tx.user.update({ where: { id: userId }, data: { orgUnitId } });
    }
  });

  return getOrgUnitById(orgUnitId);
}

/**
 * Remove a user from ONE team (deletes the single TeamMembership row). If the
 * removed team was the user's primary, re-point the primary at any remaining
 * membership (or null if none remain) so single-team read paths stay consistent.
 */
export async function removeMember(orgUnitId: string, userId: string) {
  await prisma.$transaction(async (tx) => {
    await tx.teamMembership.deleteMany({ where: { userId, orgUnitId } });

    const user = await tx.user.findUnique({ where: { id: userId }, select: { orgUnitId: true } });
    if (user?.orgUnitId === orgUnitId) {
      // Primary team was the one we just left — promote another membership, if any.
      const next = await tx.teamMembership.findFirst({
        where: { userId },
        orderBy: { createdAt: "asc" },
      });
      await tx.user.update({ where: { id: userId }, data: { orgUnitId: next?.orgUnitId ?? null } });
      if (next) {
        await tx.teamMembership.update({ where: { id: next.id }, data: { isPrimary: true } });
      }
    }
  });
}

export async function createOrgUnit(data: {
  name: string;
  type: "DEPARTMENT" | "TEAM" | "SUB_TEAM";
  parentId?: string;
  leadId?: string;
}) {
  const duplicate = await prisma.orgUnit.findFirst({
    where: { name: { equals: data.name, mode: "insensitive" }, type: data.type },
  });
  if (duplicate) throw new AppError(409, "DUPLICATE_NAME", `A ${data.type.toLowerCase().replace("_", "-")} named "${data.name}" already exists`);

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

// When a team is deleted, the cascade drops its team_memberships rows. But the
// User.orgUnit (primary) FK has no cascade, so any user whose PRIMARY team is in
// `deletedIds` must be re-pointed at a surviving membership (or null) BEFORE the
// teams are deleted — otherwise their primary points at a gone team.
async function repointPrimaries(tx: typeof prisma, deletedIds: string[]) {
  const affected = await tx.user.findMany({
    where: { orgUnitId: { in: deletedIds } },
    select: { id: true },
  });
  for (const u of affected) {
    const next = await tx.teamMembership.findFirst({
      where: { userId: u.id, orgUnitId: { notIn: deletedIds } },
      orderBy: { createdAt: "asc" },
    });
    await tx.user.update({ where: { id: u.id }, data: { orgUnitId: next?.orgUnitId ?? null } });
    if (next) {
      await tx.teamMembership.update({ where: { id: next.id }, data: { isPrimary: true } });
    }
  }
}

export async function deleteOrgUnit(id: string) {
  const unit = await prisma.orgUnit.findUnique({
    where: { id },
    include: { _count: { select: { children: true } } },
  });
  if (!unit) throw new AppError(404, "NOT_FOUND", "Org unit not found");
  if (unit._count.children > 0) throw new AppError(400, "HAS_CHILDREN", "Cannot delete org unit with sub-units. Delete or move sub-units first.");

  // Auto-unassign members instead of blocking (membership rows cascade-delete).
  await prisma.$transaction(async (tx) => {
    await repointPrimaries(tx as typeof prisma, [id]);
    await tx.orgUnit.delete({ where: { id } });
  });
}

export async function bulkDeleteOrgUnits(ids: string[]) {
  if (!ids.length) return;

  // Block if any unit has children
  const withChildren = await prisma.orgUnit.findMany({
    where: { id: { in: ids }, children: { some: {} } },
    select: { name: true },
  });
  if (withChildren.length > 0) {
    throw new AppError(400, "HAS_CHILDREN", `Cannot delete units with sub-units: ${withChildren.map((u) => u.name).join(", ")}`);
  }

  await prisma.$transaction(async (tx) => {
    await repointPrimaries(tx as typeof prisma, ids);
    await tx.orgUnit.deleteMany({ where: { id: { in: ids } } });
  });
}
