import { prisma } from "@dashmani/db";
import { getSupportedInsightPlatforms, isPlatformInsightSupported } from "@dashmani/shared";

// Short TTL cache for the heavy insights reads. getInsightsSummary + getTopLinksByPlatform
// both recompute a DISTINCT ON over the link_metrics table (~2M+ rows); the admin /reports
// page fires getInsightsSummary + 4× per-platform getTopLinksByPlatform on every load and
// SWR revalidation. Without a cache those repeated calls each hold a pooled DB connection
// while the query runs and — under concurrent load with the 6h social-insights cron — drain
// the 10-connection pool, producing the P2024 "Timed out fetching a connection" errors that
// surfaced as intermittent "unexpected error" / "failed to fetch" across the portals
// (incident 2026-07-16). 60s is long enough to absorb a load/focus-revalidation storm, short
// enough that a fresh cron write shows within a minute. Keyed by fn + window so ranges/
// employees don't collide. Mirrors leaderboard.service.ts's _lbCache (same rationale).
const INSIGHTS_TTL_MS = 60 * 1000;
const _insightsCache = new Map<string, { value: unknown; builtAt: number }>();
export function invalidateInsightsCache(): void { _insightsCache.clear(); }
async function memoInsights<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = _insightsCache.get(key);
  const now = Date.now();
  if (hit && now - hit.builtAt < INSIGHTS_TTL_MS) return hit.value as T;
  const value = await fn();
  _insightsCache.set(key, { value, builtAt: now });
  return value;
}

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
  return memoInsights(
    `summary:${startDate ?? ""}:${endDate ?? ""}:${employeeId ?? ""}`,
    () => getInsightsSummaryUncached(startDate, endDate, employeeId),
  );
}

// Row shape of the DISTINCT ON query below — the exact fields the aggregation +
// topLinks mapping consume. `employee_name` is joined so we don't hydrate the whole
// User relation.
interface InsightRow {
  link_id: string | null;
  url_normalized: string;
  url: string;
  video_id: string | null;
  platform: string;
  employee_id: string;
  employee_name: string;
  fetched_at: Date;
  views: number | null;
  likes: number | null;
  comments: number | null;
}

async function getInsightsSummaryUncached(
  startDate?: string,
  endDate?: string,
  employeeId?: string,
): Promise<InsightsSummary> {
  // Latest snapshot per (employee_id, url_normalized) computed IN POSTGRES via DISTINCT ON.
  // This is byte-identical to the OLD JS dedup (findMany orderBy fetchedAt desc + a seen-Set
  // keyed on `${employeeId}::${urlNormalized}` keeping the first = newest per key) — same
  // key, same latest-by-fetchedAt winner — but returns ONLY the deduped set instead of
  // hydrating every ok row in the window into Node (~340k rows for 30d on prod: the OOM /
  // pool-exhaustion culprit). The outer ORDER BY fetched_at DESC reproduces the order the
  // old `latest[]` array had, so the downstream JS `.sort()` (stable in V8) sees inputs in
  // the SAME order and its tie-break is preserved exactly.
  //
  // Bounds are ALWAYS passed as concrete Dates (null-start → epoch, null-end → far future)
  // to keep this a fully STATIC tagged template — the repo's proven $queryRaw pattern
  // (leaderboard.service.ts / link-search.service.ts), no conditional Prisma.sql fragments.
  // employeeId is optional: when absent we bind a sentinel and the `(… OR ${bind} IS NULL)`
  // makes the filter a no-op (still fully static, still two-plus fixed bindings).
  const start = startDate ? new Date(startDate) : new Date("1970-01-01T00:00:00.000Z");
  const end = endDate ? new Date(endDate) : new Date("2999-12-31T00:00:00.000Z");
  const empFilter = employeeId ?? null;

  const latest = await prisma.$queryRaw<InsightRow[]>`
    SELECT link_id, url_normalized, url, video_id, platform, employee_id, employee_name,
           fetched_at, views, likes, comments
    FROM (
      SELECT DISTINCT ON (lm.employee_id, lm.url_normalized)
        lm.link_id, lm.url_normalized, lm.url, lm.video_id, lm.platform,
        lm.employee_id, u.name AS employee_name, lm.fetched_at,
        lm.views, lm.likes, lm.comments
      FROM link_metrics lm
      JOIN users u ON u.id = lm.employee_id
      WHERE lm.status = 'ok'
        AND lm.report_date >= ${start}
        AND lm.report_date <= ${end}
        AND (${empFilter}::text IS NULL OR lm.employee_id = ${empFilter})
      ORDER BY lm.employee_id, lm.url_normalized, lm.fetched_at DESC
    ) latest
    ORDER BY fetched_at DESC
  `;

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
      linkId: s.link_id,
      url: s.url,
      urlNormalized: s.url_normalized,
      videoId: s.video_id,
      platform: s.platform.toLowerCase(),
      employeeId: s.employee_id,
      employeeName: s.employee_name,
      views: s.views,
      likes: s.likes,
      comments: s.comments,
      fetchedAt: s.fetched_at,
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
  return memoInsights(
    `toplinks:${platform}:${startDate ?? ""}:${endDate ?? ""}:${limit}:${sortBy}`,
    () => getTopLinksByPlatformUncached(platform, sortBy, limit, startDate, endDate),
  );
}

async function getTopLinksByPlatformUncached(
  platform: string,
  sortBy: TopLinkSort,
  limit: number,
  startDate?: string,
  endDate?: string,
): Promise<TopLink[]> {
  // Latest snapshot per (employee_id, url_normalized) for ONE platform, computed IN
  // POSTGRES via DISTINCT ON — byte-identical to the OLD JS dedup (findMany orderBy
  // fetchedAt desc + seen-Set) but returns only the deduped set instead of hydrating
  // every ok row for the platform+window into Node (306k rows for yt/30d on prod — the
  // pool-exhaustion culprit that starved /hr/accounts, notifications, and RBAC). The
  // outer ORDER BY fetched_at DESC reproduces the old `latest[]` order, so the JS
  // `.sort()` below (stable in V8) preserves the exact same tie-break. The final sort +
  // slice stays in JS unchanged so the top-N ordering is IDENTICAL to today. Static
  // tagged template with concrete Date bounds (repo pattern; no Prisma.sql fragments).
  const start = startDate ? new Date(startDate) : new Date("1970-01-01T00:00:00.000Z");
  const end = endDate ? new Date(endDate) : new Date("2999-12-31T00:00:00.000Z");

  const latest = await prisma.$queryRaw<InsightRow[]>`
    SELECT link_id, url_normalized, url, video_id, platform, employee_id, employee_name,
           fetched_at, views, likes, comments
    FROM (
      SELECT DISTINCT ON (lm.employee_id, lm.url_normalized)
        lm.link_id, lm.url_normalized, lm.url, lm.video_id, lm.platform,
        lm.employee_id, u.name AS employee_name, lm.fetched_at,
        lm.views, lm.likes, lm.comments
      FROM link_metrics lm
      JOIN users u ON u.id = lm.employee_id
      WHERE lm.status = 'ok'
        AND lm.platform = ${platform}
        AND lm.report_date >= ${start}
        AND lm.report_date <= ${end}
      ORDER BY lm.employee_id, lm.url_normalized, lm.fetched_at DESC
    ) latest
    ORDER BY fetched_at DESC
  `;

  const score = (s: { views: number | null; likes: number | null; comments: number | null }) =>
    sortBy === "views" ? (s.views ?? 0) : (s.likes ?? 0) + (s.comments ?? 0);

  return latest
    .sort((a, b) => score(b) - score(a))
    .slice(0, limit)
    .map((s) => ({
      linkId: s.link_id,
      url: s.url,
      urlNormalized: s.url_normalized,
      videoId: s.video_id,
      platform,
      employeeId: s.employee_id,
      employeeName: s.employee_name,
      views: s.views,
      likes: s.likes,
      comments: s.comments,
      fetchedAt: s.fetched_at,
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
