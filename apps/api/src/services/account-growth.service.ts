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

// Stringify a snapshot @db.Date the same way getAccountGrowth does.
function snapshotDateStr(date: Date | unknown): string {
  return date instanceof Date ? date.toISOString().split("T")[0] : String(date);
}

export interface GrowthOverviewAccount {
  accountId: string;
  displayName: string;
  platform: string;
  latest: number;
  first: number;
  delta: number;
  deltaPct: number | null;
  snapshots: Array<{ date: string; followerCount: number }>;
}

export interface GrowthOverview {
  totalFollowers: number;
  totalDelta: number;
  accountCount: number;
  accounts: GrowthOverviewAccount[];
  topMovers: Array<{
    accountId: string;
    displayName: string;
    platform: string;
    delta: number;
    deltaPct: number | null;
  }>;
}

const MAX_OVERVIEW_SNAPSHOTS = 60;

export async function getGrowthOverview(days = 30): Promise<GrowthOverview> {
  const since = new Date(istMidnight(todayIST()).getTime() - days * 86400000);

  // ACTIVE accounts only — SocialAccount has no deletedAt; it gates on status.
  const accounts = await prisma.socialAccount.findMany({
    where: { status: "ACTIVE" },
    include: {
      platform: true,
      growthSnapshots: {
        where: { date: { gte: since } },
        orderBy: { date: "asc" },
      },
    },
  });

  const overviewAccounts: GrowthOverviewAccount[] = accounts.map((account) => {
    const snaps = account.growthSnapshots; // already date-asc, windowed

    // first/latest fall back to the account's live followerCount when there are
    // no in-window snapshots.
    const first = snaps.length > 0 ? snaps[0].followerCount : account.followerCount;
    const latest = snaps.length > 0 ? snaps[snaps.length - 1].followerCount : account.followerCount;
    const delta = latest - first;
    const deltaPct = first > 0 ? Math.round((delta / first) * 100) : null;

    // Cap snapshot points to avoid huge payloads on long windows: stride-sample
    // down to ~MAX, always keeping the first and last point.
    let kept = snaps;
    if (snaps.length > MAX_OVERVIEW_SNAPSHOTS) {
      const stride = Math.ceil(snaps.length / MAX_OVERVIEW_SNAPSHOTS);
      kept = snaps.filter((_, i) => i % stride === 0);
      if (kept[kept.length - 1] !== snaps[snaps.length - 1]) kept.push(snaps[snaps.length - 1]);
    }

    return {
      accountId: account.id,
      displayName: account.displayName,
      platform: account.platform.name,
      latest,
      first,
      delta,
      deltaPct,
      snapshots: kept.map((s) => ({
        date: snapshotDateStr(s.date),
        followerCount: s.followerCount,
      })),
    };
  });

  const totalFollowers = overviewAccounts.reduce((sum, a) => sum + a.latest, 0);
  const totalDelta = overviewAccounts.reduce((sum, a) => sum + a.delta, 0);

  const topMovers = [...overviewAccounts]
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 5)
    .map((a) => ({
      accountId: a.accountId,
      displayName: a.displayName,
      platform: a.platform,
      delta: a.delta,
      deltaPct: a.deltaPct,
    }));

  return {
    totalFollowers,
    totalDelta,
    accountCount: overviewAccounts.length,
    accounts: overviewAccounts,
    topMovers,
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
