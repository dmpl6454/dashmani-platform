import { prisma } from "@dashmani/db";
import { AppError } from "../middleware/error-handler";
import { todayIST, istMidnight } from "@dashmani/shared";

export interface GrowthSnapshotInput {
  followerCount: number;
  followingCount?: number;
  postCount?: number;
  engagementRate?: number;
}

export async function recordGrowthSnapshot(accountId: string, data: GrowthSnapshotInput) {
  const today = istMidnight(todayIST());

  // Upsert snapshot for today
  const existing = await prisma.accountGrowthSnapshot.findUnique({
    where: { accountId_date: { accountId, date: today } },
  });

  if (existing) {
    return prisma.accountGrowthSnapshot.update({
      where: { id: existing.id },
      data: {
        followerCount: data.followerCount,
        followingCount: data.followingCount,
        postCount: data.postCount,
        engagementRate: data.engagementRate,
      },
    });
  }

  return prisma.accountGrowthSnapshot.create({
    data: {
      accountId,
      date: today,
      followerCount: data.followerCount,
      followingCount: data.followingCount,
      postCount: data.postCount,
      engagementRate: data.engagementRate,
    },
  });
}

export async function getAccountGrowth(accountId: string, days = 30) {
  const since = new Date(istMidnight(todayIST()).getTime() - days * 86400000);

  const account = await prisma.socialAccount.findUnique({
    where: { id: accountId },
    include: { platform: true },
  });

  if (!account) {
    throw new AppError(404, "NOT_FOUND", "Account not found");
  }

  const snapshots = await prisma.accountGrowthSnapshot.findMany({
    where: { accountId, date: { gte: since } },
    orderBy: { date: "asc" },
  });

  return {
    accountId,
    accountName: account.displayName,
    platform: account.platform.name,
    snapshots: snapshots.map((s) => ({
      date: s.date instanceof Date ? s.date.toISOString().split("T")[0] : String(s.date),
      followerCount: s.followerCount,
      followingCount: s.followingCount,
      postCount: s.postCount,
      engagementRate: s.engagementRate,
    })),
  };
}

export async function getGrowthForEmployee(employeeId: string, days = 30) {
  const assignments = await prisma.accountAssignment.findMany({
    where: { employeeId, unassignedAt: null },
    select: { accountId: true },
  });

  const accountIds = assignments.map((a) => a.accountId);

  return Promise.all(accountIds.map((id) => getAccountGrowth(id, days)));
}
