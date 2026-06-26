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

/** How trustworthy the follower number is for a given account. */
export type SyncState = "LIVE" | "STALE" | "MANUAL";

/**
 * An account is LIVE when its lastSyncedAt is within the last 48 hours.
 * We use a raw Date-diff here (not the IST date-key helpers) because this is a
 * duration check ("was this synced recently?"), not a calendar-day boundary
 * check. The IST helpers exist to avoid UTC-vs-IST day flips when comparing
 * YYYY-MM-DD date keys; a millisecond duration comparison is inherently
 * timezone-agnostic and is the correct tool for freshness windows.
 */
const LIVE_WINDOW_MS = 48 * 60 * 60 * 1000; // 48 hours

function computeSyncState(lastSyncedAt: Date | null): SyncState {
  if (lastSyncedAt === null) return "MANUAL";
  return Date.now() - lastSyncedAt.getTime() <= LIVE_WINDOW_MS ? "LIVE" : "STALE";
}

export interface GrowthOverviewAccount {
  accountId: string;
  displayName: string;
  platform: string;
  /** The account's public profile URL, for an open-channel link (null if not stored). */
  profileUrl: string | null;
  latest: number;
  first: number;
  delta: number;
  deltaPct: number | null;
  snapshots: Array<{ date: string; followerCount: number }>;
  /** ISO string of the last API sync, or null if never synced (manual entry). */
  lastSyncedAt: string | null;
  /** LIVE = synced within 48h; STALE = synced but older than 48h; MANUAL = never synced. */
  syncState: SyncState;
}

export interface GrowthOverview {
  /** The window (in days) used to compute deltas. Echoes the `days` param (default 30). */
  days: number;
  totalFollowers: number;
  totalDelta: number;
  accountCount: number;
  /** Accounts synced via API within the last 48 hours. */
  liveCount: number;
  /** Accounts synced via API but more than 48 hours ago. */
  staleCount: number;
  /** Accounts with no API sync record (manual entry or unsupported platform). */
  manualCount: number;
  /** Sum of latest follower counts for LIVE accounts. */
  liveFollowers: number;
  /** Sum of latest follower counts for STALE accounts. */
  staleFollowers: number;
  /** Sum of latest follower counts for MANUAL accounts. */
  manualFollowers: number;
  accounts: GrowthOverviewAccount[];
  topMovers: Array<{
    accountId: string;
    displayName: string;
    platform: string;
    delta: number;
    deltaPct: number | null;
  }>;
  /**
   * Top 5 movers per platform, keyed by platform name.
   * Only platforms with at least one account whose abs(delta) > 0 are included.
   * Within each group, sorted by abs(delta) desc (same ordering as topMovers).
   */
  topMoversByPlatform: Record<
    string,
    Array<{
      accountId: string;
      displayName: string;
      platform: string;
      delta: number;
      deltaPct: number | null;
    }>
  >;
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
      const lastIndex = snaps.length - 1;
      kept = snaps.filter((_, i) => i % stride === 0);
      // Always include the latest point. The stride filter only keeps indices
      // divisible by `stride`, so the last index is missing iff lastIndex % stride !== 0.
      // Index-based (not reference-identity) so this stays correct even if the
      // middle is ever cloned/mapped during sampling.
      if (lastIndex % stride !== 0) kept.push(snaps[lastIndex]);
    }

    const syncState = computeSyncState(account.lastSyncedAt);

    return {
      accountId: account.id,
      displayName: account.displayName,
      platform: account.platform.name,
      profileUrl: account.profileUrl && account.profileUrl.trim() ? account.profileUrl.trim() : null,
      latest,
      first,
      delta,
      deltaPct,
      snapshots: kept.map((s) => ({
        date: snapshotDateStr(s.date),
        followerCount: s.followerCount,
      })),
      lastSyncedAt: account.lastSyncedAt ? account.lastSyncedAt.toISOString() : null,
      syncState,
    };
  });

  const totalFollowers = overviewAccounts.reduce((sum, a) => sum + a.latest, 0);
  const totalDelta = overviewAccounts.reduce((sum, a) => sum + a.delta, 0);

  const liveCount = overviewAccounts.filter((a) => a.syncState === "LIVE").length;
  const staleCount = overviewAccounts.filter((a) => a.syncState === "STALE").length;
  const manualCount = overviewAccounts.filter((a) => a.syncState === "MANUAL").length;

  const liveFollowers = overviewAccounts
    .filter((a) => a.syncState === "LIVE")
    .reduce((sum, a) => sum + a.latest, 0);
  const staleFollowers = overviewAccounts
    .filter((a) => a.syncState === "STALE")
    .reduce((sum, a) => sum + a.latest, 0);
  const manualFollowers = overviewAccounts
    .filter((a) => a.syncState === "MANUAL")
    .reduce((sum, a) => sum + a.latest, 0);

  const moverShape = (a: GrowthOverviewAccount) => ({
    accountId: a.accountId,
    displayName: a.displayName,
    platform: a.platform,
    delta: a.delta,
    deltaPct: a.deltaPct,
  });

  const topMovers = [...overviewAccounts]
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 5)
    .map(moverShape);

  // Group by platform → top-5 per platform (only platforms with at least one non-zero delta).
  const platformGroups = new Map<string, GrowthOverviewAccount[]>();
  for (const acc of overviewAccounts) {
    if (acc.delta === 0) continue; // skip zero-delta accounts for per-platform grouping
    const group = platformGroups.get(acc.platform) ?? [];
    group.push(acc);
    platformGroups.set(acc.platform, group);
  }
  const topMoversByPlatform: GrowthOverview["topMoversByPlatform"] = {};
  for (const [platform, group] of platformGroups) {
    topMoversByPlatform[platform] = group
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, 5)
      .map(moverShape);
  }

  return {
    days,
    totalFollowers,
    totalDelta,
    accountCount: overviewAccounts.length,
    liveCount,
    staleCount,
    manualCount,
    liveFollowers,
    staleFollowers,
    manualFollowers,
    accounts: overviewAccounts,
    topMovers,
    topMoversByPlatform,
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
