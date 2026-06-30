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

/**
 * profile_url is admin/employee-entered free text. Before exposing it as a clickable
 * href, allow ONLY http(s) — a `javascript:`/`data:` URI would be a stored-XSS vector
 * when rendered as <a href>. Returns the normalized URL, or null if absent/non-http(s)/
 * unparseable (the UI then simply omits the open-channel link). Belt-and-suspenders:
 * the client re-validates too, so bad data is blocked at both layers.
 */
function safeHttpUrl(url: string | null | undefined): string | null {
  if (!url || !url.trim()) return null;
  try {
    const u = new URL(url.trim());
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

// Normalize a profile URL into a DEDUP KEY so the SAME real page stored under two URL
// forms collapses to one account (F5, 2026-06-26 audit): e.g. facebook.com/paparazzziii
// and facebook.com/paparazzziii?mibextid=… are one 15M page counted twice, inflating
// totalFollowers (~6.5%) + Net Change (~11.8%) + showing as two Top Movers.
// Conservative: lowercase, strip scheme/www/trailing-slash, DROP only known tracking
// params (mibextid/igsh/si/ref/utm_*/fbclid), but KEEP profile.php?id=<n> distinct (the
// id IS the page identity). Returns null when there's no usable URL → such accounts are
// NEVER merged (we can't prove identity), each stays distinct.
const TRACKING_PARAMS = new Set(["mibextid", "igsh", "si", "ref", "fbclid", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"]);
function profileDedupKey(url: string | null | undefined): string | null {
  const safe = safeHttpUrl(url);
  if (!safe) return null;
  try {
    const u = new URL(safe);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    // Keep profile.php?id=<n> as its own identity (the id distinguishes real pages).
    const idParam = u.pathname.toLowerCase() === "/profile.php" ? u.searchParams.get("id") : null;
    const path = u.pathname.replace(/\/+$/, "").toLowerCase(); // strip trailing slashes
    return idParam ? `${host}${path}?id=${idParam}` : `${host}${path}`;
  } catch {
    return null;
  }
}

// Which of two same-page rows is the "better" survivor: prefer a real sync (LIVE>STALE>
// MANUAL by lastSyncedAt recency), then the higher follower count (more complete data).
function preferAccount<T extends { lastSyncedAt: Date | null; followerCount: number }>(a: T, b: T): T {
  const at = a.lastSyncedAt ? a.lastSyncedAt.getTime() : -1;
  const bt = b.lastSyncedAt ? b.lastSyncedAt.getTime() : -1;
  if (at !== bt) return at > bt ? a : b; // more recently synced wins
  return a.followerCount >= b.followerCount ? a : b;
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
  /** Accounts that grew over the window (delta > 0, excluding correction artifacts). */
  gainers: number;
  /** Accounts that declined over the window (delta < 0, excluding correction artifacts). */
  decliners: number;
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
    profileUrl: string | null;
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
      profileUrl: string | null;
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

  // ── DEDUP same-page accounts (F5) ────────────────────────────────────────────
  // Collapse accounts whose normalized profile URL is identical (same real page stored
  // under two URL forms) to a single survivor, so totals / Net Change / Top Movers / the
  // list don't double-count it. Accounts with no usable URL are kept distinct (key=null
  // → never merged). Survivor = the freshest-synced / most-complete row in the group.
  const dedupGroups = new Map<string, typeof accounts[number]>();
  const dedupedAccounts: typeof accounts = [];
  for (const account of accounts) {
    const key = profileDedupKey(account.profileUrl);
    if (key === null) {
      dedupedAccounts.push(account); // no URL → can't prove a dupe → keep distinct
      continue;
    }
    const existing = dedupGroups.get(key);
    if (!existing) {
      dedupGroups.set(key, account);
    } else {
      dedupGroups.set(key, preferAccount(existing, account)); // keep the better survivor
    }
  }
  for (const survivor of dedupGroups.values()) dedupedAccounts.push(survivor);

  const overviewAccounts: GrowthOverviewAccount[] = dedupedAccounts.map((account) => {
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
      profileUrl: safeHttpUrl(account.profileUrl),
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

  // A DATA-CORRECTION ARTIFACT: a never-live-synced account carried a stale value
  // (e.g. 1,040,000) then got its FIRST real sync to the true count (e.g. 10,900) →
  // an in-window delta that's a ≥90% collapse. That's a measurement correction, NOT
  // organic movement. Excluded from BOTH the headline Net Change AND Top Movers
  // (consistent), so the number reflects real follower change. The account's true
  // CURRENT value still counts toward totalFollowers — only its artifact DELTA is dropped.
  const isCorrectionArtifact = (a: GrowthOverviewAccount) => a.deltaPct != null && a.deltaPct <= -90;

  const totalFollowers = overviewAccounts.reduce((sum, a) => sum + a.latest, 0);
  // Net Change excludes correction artifacts (e.g. a stale 1.04M→real 10,900 first-sync
  // would otherwise drag the headline ~1M too low — verified live 2026-06-26).
  const totalDelta = overviewAccounts.reduce((sum, a) => sum + (isCorrectionArtifact(a) ? 0 : a.delta), 0);

  // Portfolio pulse: how many accounts grew vs declined over the window (excluding
  // correction artifacts + zero-change). A health signal beyond the single net number —
  // shows whether growth is broad or a few big accounts mask widespread decline.
  const realMovers = overviewAccounts.filter((a) => !isCorrectionArtifact(a));
  const gainers = realMovers.filter((a) => a.delta > 0).length;
  const decliners = realMovers.filter((a) => a.delta < 0).length;

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
    profileUrl: a.profileUrl, // already scheme-validated to http(s)|null
    delta: a.delta,
    deltaPct: a.deltaPct,
  });

  // Exclude DATA-CORRECTION ARTIFACTS from Top Movers (NOT from the full accounts list —
  // the data stays visible there). When a never-live-synced account carried a stale
  // manual value (e.g. a round 1,040,000) and then got its FIRST real sync to the true
  // count (e.g. 10,900), the in-window delta computes as a ~-99% "drop" and wrongly tops
  // the movers board (same isCorrectionArtifact predicate defined above — applied to
  // both Net Change and Top Movers so the artifact is suppressed consistently).
  // Positive swings are kept: a +Large% can be a genuinely small→viral account, and an
  // upward correction is far rarer + less misleading than a fake catastrophic drop.
  const topMovers = [...overviewAccounts]
    .filter((a) => !isCorrectionArtifact(a))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 5)
    .map(moverShape);

  // Group by platform → top-5 per platform.
  // Include all accounts (even zero-delta ones) so platforms whose follower counts are
  // manually entered (e.g. Snapchat) still appear — sorted by |delta| desc, then by
  // latest follower count desc as tiebreaker. Platforms where every account has delta=0
  // will show their top accounts by follower count rather than by movement.
  const platformGroups = new Map<string, GrowthOverviewAccount[]>();
  for (const acc of overviewAccounts) {
    if (isCorrectionArtifact(acc)) continue; // skip stale→live correction artifacts
    const group = platformGroups.get(acc.platform) ?? [];
    group.push(acc);
    platformGroups.set(acc.platform, group);
  }
  const topMoversByPlatform: GrowthOverview["topMoversByPlatform"] = {};
  for (const [platform, group] of platformGroups) {
    topMoversByPlatform[platform] = group
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || (b.latest ?? 0) - (a.latest ?? 0))
      .slice(0, 5)
      .map(moverShape);
  }

  return {
    days,
    totalFollowers,
    totalDelta,
    accountCount: overviewAccounts.length,
    gainers,
    decliners,
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
