import { prisma } from "@dashmani/db";
import { getSupportedInsightPlatforms, isPlatformInsightSupported } from "@dashmani/shared";

// ============ Types ============

export interface InsightSnapshot {
  id: string;
  linkId: string | null;
  platform: string;
  videoId: string | null;
  fetchedAt: Date;
  status: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  errorMessage: string | null;
}

export interface InsightsSummary {
  totalViews: number;
  totalLikes: number;
  totalComments: number;
  supportedPlatforms: readonly string[];
  topLinks: TopLink[];
  byPlatform: PlatformStat[];
}

export interface TopLink {
  linkId: string | null;
  url: string;
  urlNormalized: string;
  videoId: string | null;
  platform: string;
  employeeId: string;
  employeeName: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  fetchedAt: Date;
}

export interface PlatformStat {
  platform: string;
  totalViews: number;
  totalLikes: number;
  totalComments: number;
  linkCount: number;
  supported: boolean;
}

export interface MyLinkInsight {
  linkId: string | null;
  url: string;
  platform: string;
  supported: boolean;
  latest: {
    views: number | null;
    likes: number | null;
    comments: number | null;
    fetchedAt: Date;
  } | null;
}

// ============ getLinkMetricsHistory ============

export async function getLinkMetricsHistory(linkId: string): Promise<InsightSnapshot[]> {
  return prisma.linkMetric.findMany({
    where: { linkId },
    orderBy: { fetchedAt: "asc" },
    select: {
      id: true,
      linkId: true,
      platform: true,
      videoId: true,
      fetchedAt: true,
      status: true,
      views: true,
      likes: true,
      comments: true,
      shares: true,
      errorMessage: true,
    },
  });
}

// ============ getInsightsSummary ============

export async function getInsightsSummary(params: {
  startDate?: string;
  endDate?: string;
  employeeId?: string;
}): Promise<InsightsSummary> {
  const { startDate, endDate, employeeId } = params;

  const where: Record<string, unknown> = {
    status: "ok",
  };
  if (startDate) where.reportDate = { ...(where.reportDate as object | undefined), gte: new Date(startDate) };
  if (endDate) where.reportDate = { ...(where.reportDate as object | undefined), lte: new Date(endDate) };
  if (employeeId) where.employeeId = employeeId;

  // Get latest snapshot per (linkId, urlNormalized) — DISTINCT ON equivalent via group
  // We fetch all ok snapshots in window then aggregate in JS to get "latest per link"
  const snapshots = await prisma.linkMetric.findMany({
    where,
    orderBy: { fetchedAt: "desc" },
    select: {
      linkId: true,
      urlNormalized: true,
      url: true,
      videoId: true,
      platform: true,
      employeeId: true,
      fetchedAt: true,
      views: true,
      likes: true,
      comments: true,
      employee: { select: { id: true, name: true } },
    },
  });

  // Dedupe to latest snapshot per unique (employeeId + urlNormalized)
  const seen = new Set<string>();
  const latest: typeof snapshots = [];
  for (const s of snapshots) {
    const key = `${s.employeeId}::${s.urlNormalized}`;
    if (!seen.has(key)) {
      seen.add(key);
      latest.push(s);
    }
  }

  // Aggregate
  let totalViews = 0;
  let totalLikes = 0;
  let totalComments = 0;
  const platformMap = new Map<string, PlatformStat>();

  for (const s of latest) {
    totalViews += s.views ?? 0;
    totalLikes += s.likes ?? 0;
    totalComments += s.comments ?? 0;

    const p = s.platform.toLowerCase();
    if (!platformMap.has(p)) {
      platformMap.set(p, {
        platform: p,
        totalViews: 0,
        totalLikes: 0,
        totalComments: 0,
        linkCount: 0,
        supported: isPlatformInsightSupported(p),
      });
    }
    const ps = platformMap.get(p)!;
    ps.totalViews += s.views ?? 0;
    ps.totalLikes += s.likes ?? 0;
    ps.totalComments += s.comments ?? 0;
    ps.linkCount += 1;
  }

  const topLinks: TopLink[] = latest
    .sort((a, b) => (b.views ?? 0) - (a.views ?? 0))
    .slice(0, 20)
    .map((s) => ({
      linkId: s.linkId,
      url: s.url,
      urlNormalized: s.urlNormalized,
      videoId: s.videoId,
      platform: s.platform.toLowerCase(),
      employeeId: s.employeeId,
      employeeName: s.employee.name,
      views: s.views,
      likes: s.likes,
      comments: s.comments,
      fetchedAt: s.fetchedAt,
    }));

  return {
    totalViews,
    totalLikes,
    totalComments,
    supportedPlatforms: getSupportedInsightPlatforms(),
    topLinks,
    byPlatform: Array.from(platformMap.values()),
  };
}

// ============ getTopLinksByPlatform (generalized) ============
//
// Returns the top engagement links for ONE platform, newest-snapshot-per-link,
// sorted by the metric that platform actually exposes:
//   - youtube           → views (the YT Data API returns reliable view counts)
//   - instagram/facebook → likes + comments (IG reels don't expose a reliable
//     view count via the media list; FB likewise) — so views-sort would be all-zero.
// This is the single path behind every "Top <Platform> Links" panel. A platform
// with no enriched link_metric rows for the window naturally returns [] — the UI
// simply renders no rows rather than a fake-empty table. The same query fills the
// same panel for every supported platform with zero per-platform code.

export type TopLinkSort = "views" | "engagement";

export async function getTopLinksByPlatform(params: {
  platform: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
  sortBy?: TopLinkSort;
}): Promise<TopLink[]> {
  const platform = params.platform.toLowerCase();
  const { startDate, endDate, limit = 20 } = params;
  // Default sort: YouTube by views, everything else by engagement.
  const sortBy: TopLinkSort = params.sortBy ?? (platform === "youtube" ? "views" : "engagement");

  const where: Record<string, unknown> = { platform, status: "ok" };
  if (startDate) where.reportDate = { ...(where.reportDate as object | undefined), gte: new Date(startDate) };
  if (endDate) where.reportDate = { ...(where.reportDate as object | undefined), lte: new Date(endDate) };

  const snapshots = await prisma.linkMetric.findMany({
    where,
    orderBy: { fetchedAt: "desc" },
    select: {
      linkId: true,
      url: true,
      urlNormalized: true,
      videoId: true,
      platform: true,
      employeeId: true,
      fetchedAt: true,
      views: true,
      likes: true,
      comments: true,
      employee: { select: { id: true, name: true } },
    },
  });

  // Dedupe to latest per (employeeId + urlNormalized)
  const seen = new Set<string>();
  const latest: typeof snapshots = [];
  for (const s of snapshots) {
    const key = `${s.employeeId}::${s.urlNormalized}`;
    if (!seen.has(key)) {
      seen.add(key);
      latest.push(s);
    }
  }

  const score = (s: { views: number | null; likes: number | null; comments: number | null }) =>
    sortBy === "views" ? (s.views ?? 0) : (s.likes ?? 0) + (s.comments ?? 0);

  return latest
    .sort((a, b) => score(b) - score(a))
    .slice(0, limit)
    .map((s) => ({
      linkId: s.linkId,
      url: s.url,
      urlNormalized: s.urlNormalized,
      videoId: s.videoId,
      platform,
      employeeId: s.employeeId,
      employeeName: s.employee.name,
      views: s.views,
      likes: s.likes,
      comments: s.comments,
      fetchedAt: s.fetchedAt,
    }));
}

// ============ getTopYouTubeLinks (thin back-compat wrapper) ============

export async function getTopYouTubeLinks(params: {
  startDate?: string;
  endDate?: string;
  limit?: number;
}): Promise<TopLink[]> {
  return getTopLinksByPlatform({ ...params, platform: "youtube", sortBy: "views" });
}

// NOTE: A submission-count "Top Snapchat Links" function lived here and was removed
// (2026-06-30). Snapchat has no server-readable engagement (no public API; share-
// redirect links → client-rendered profile pages), so it can't have an engagement-
// ranked "Top Links" like YouTube/IG/FB. A submission-count ranking is a different,
// weaker signal that masqueraded as Top Links, so it was dropped. Snapchat follower
// counts (Account Growth) remain the only working Snapchat feature.

// ============ getMyLinkInsights (HR — self-scoped) ============

export async function getMyLinkInsights(
  employeeId: string,
  days = 30
): Promise<MyLinkInsight[]> {
  const since = new Date(Date.now() - days * 86_400_000);

  // Get all links the employee submitted in the window
  const links = await prisma.reportLink.findMany({
    where: {
      report: {
        employeeId,
        date: { gte: since },
      },
      url: { not: null },
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      url: true,
      platform: true,
    },
  });

  if (links.length === 0) return [];

  // Get latest ok snapshot per (employeeId + urlNormalized) in window
  const snapshots = await prisma.linkMetric.findMany({
    where: {
      employeeId,
      reportDate: { gte: since },
      status: "ok",
    },
    orderBy: { fetchedAt: "desc" },
    select: {
      linkId: true,
      urlNormalized: true,
      platform: true,
      fetchedAt: true,
      views: true,
      likes: true,
      comments: true,
    },
  });

  // Build map: urlNormalized → latest snapshot
  const latestByUrl = new Map<
    string,
    { views: number | null; likes: number | null; comments: number | null; fetchedAt: Date; linkId: string | null }
  >();
  for (const s of snapshots) {
    if (!latestByUrl.has(s.urlNormalized)) {
      latestByUrl.set(s.urlNormalized, {
        views: s.views,
        likes: s.likes,
        comments: s.comments,
        fetchedAt: s.fetchedAt,
        linkId: s.linkId,
      });
    }
  }

  // Dedupe links by url (employee may have submitted same URL in multiple reports)
  const seenUrls = new Set<string>();
  const result: MyLinkInsight[] = [];
  for (const link of links) {
    const norm = link.url!.trim().toLowerCase();
    if (seenUrls.has(norm)) continue;
    seenUrls.add(norm);

    const platform = link.platform.toLowerCase();
    const snap = latestByUrl.get(norm);
    result.push({
      linkId: link.id,
      url: link.url!,
      platform,
      supported: isPlatformInsightSupported(platform),
      latest: snap
        ? { views: snap.views, likes: snap.likes, comments: snap.comments, fetchedAt: snap.fetchedAt }
        : null,
    });
  }

  return result;
}
