import { prisma } from "@dashmani/db";
import { getSupportedInsightPlatforms, isPlatformInsightSupported } from "@dashmani/shared";
import { createSingleFlightMemo } from "../utils/single-flight-memo";
import { withHeavyQuerySlot } from "../utils/heavy-query";

// 60s SINGLE-FLIGHT TTL cache + heavy-query bulkhead for the insights reads.
//
// The admin /reports and /dashboard pages fire getInsightsSummary + 4× per-platform
// getTopLinksByPlatform on every load and SWR revalidation, and several admins land
// at once after a deploy. The memo collapses REPEAT reads inside the TTL AND
// concurrent COLD reads for the same key into ONE compute — the previous value-only
// cache did not, so N cold callers each ran the query on its own pool connection
// (incident 2026-07-16, and again 2026-09-18 when the query got slow). The bulkhead
// (utils/heavy-query.ts) caps how many DISTINCT computes run at once, so analytics
// can never drain the 10-connection pool that login and HR submit share. Keyed by
// fn + window so ranges/employees don't collide. Tests MUST call
// invalidateInsightsCache() in beforeEach (module-level cache = the documented
// cross-test pollution class).
const INSIGHTS_TTL_MS = 60 * 1000;
const _insights = createSingleFlightMemo({ ttlMs: INSIGHTS_TTL_MS, maxEntries: 200 });
export function invalidateInsightsCache(): void { _insights.clear(); }
function memoInsights<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const label = `insights:${key.split(":")[0]}`;
  return _insights.memo(key, () => withHeavyQuerySlot(label, fn));
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

// Per-platform aggregate row of the SQL GROUP BY below. Sums come back as BigInt
// (::bigint) — converted with Number() (totals are ~10^10, far under 2^53).
interface PlatformAggRow {
  platform: string;
  link_count: bigint;
  views: bigint;
  likes: bigint;
  comments: bigint;
}

async function getInsightsSummaryUncached(
  startDate?: string,
  endDate?: string,
  employeeId?: string,
): Promise<InsightsSummary> {
  // Both reads come from link_metrics_latest — ONE row per (employee_id, url_normalized),
  // already the newest status='ok' snapshot (link-metrics-latest.service.ts; model
  // comment in schema.prisma). No DISTINCT ON, no LATERAL join-back, no scan of the
  // snapshot log.
  //
  // HISTORY, so nobody reintroduces the old shape: until 2026-09-18 these did
  // `SELECT DISTINCT ON (employee_id, url_normalized) … FROM link_metrics WHERE
  // status='ok' … ORDER BY …, fetched_at DESC`, i.e. O(all snapshots ever written).
  // Once the sweep started appending ~850k rows/day (3.99M → 14.6M rows / 10GB in six
  // weeks) the planner left the covering index for a parallel seq scan + disk sort,
  // each call took 5-10 MINUTES, six of them held the whole 10-connection pool, and
  // login + HR submit failed with P2024 ("An unexpected error occurred").
  // ⚠️ NEVER read engagement from link_metrics on a portal path again.
  //
  // Bounds are ALWAYS passed as concrete Dates (null-start → epoch, null-end → far
  // future) to keep these fully STATIC tagged templates — the repo's proven $queryRaw
  // pattern, no conditional Prisma.sql fragments. employeeId is optional: when absent
  // we bind a sentinel and the `(… IS NULL OR …)` makes the filter a no-op.
  const start = startDate ? new Date(startDate) : new Date("1970-01-01T00:00:00.000Z");
  const end = endDate ? new Date(endDate) : new Date("2999-12-31T00:00:00.000Z");
  const empFilter = employeeId ?? null;

  // Sequential on purpose: one pooled connection at a time per request.
  const agg = await prisma.$queryRaw<PlatformAggRow[]>`
    SELECT lower(platform) AS platform,
           count(*)::bigint AS link_count,
           sum(coalesce(views, 0))::bigint AS views,
           sum(coalesce(likes, 0))::bigint AS likes,
           sum(coalesce(comments, 0))::bigint AS comments
    FROM link_metrics_latest
    WHERE report_date >= ${start}
      AND report_date <= ${end}
      AND (${empFilter}::text IS NULL OR employee_id = ${empFilter})
    GROUP BY lower(platform)
    ORDER BY count(*) DESC
  `;

  // Top-20 by views. ORDER BY COALESCE(views, 0) DESC, fetched_at DESC is the same
  // tie-break the previous shape used (equal views → newer snapshot first).
  const topRows = await prisma.$queryRaw<InsightRow[]>`
    SELECT l.link_id, l.url_normalized, l.url, l.video_id, l.platform,
           l.employee_id, u.name AS employee_name, l.fetched_at,
           l.views, l.likes, l.comments
    FROM link_metrics_latest l
    JOIN users u ON u.id = l.employee_id
    WHERE l.report_date >= ${start}
      AND l.report_date <= ${end}
      AND (${empFilter}::text IS NULL OR l.employee_id = ${empFilter})
    ORDER BY COALESCE(l.views, 0) DESC, l.fetched_at DESC
    LIMIT 20
  `;

  let totalViews = 0;
  let totalLikes = 0;
  let totalComments = 0;
  const byPlatform: PlatformStat[] = agg.map((r) => {
    const stat: PlatformStat = {
      platform: r.platform,
      totalViews: Number(r.views),
      totalLikes: Number(r.likes),
      totalComments: Number(r.comments),
      linkCount: Number(r.link_count),
      supported: isPlatformInsightSupported(r.platform),
    };
    totalViews += stat.totalViews;
    totalLikes += stat.totalLikes;
    totalComments += stat.totalComments;
    return stat;
  });

  const topLinks: TopLink[] = topRows.map((s) => ({
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
    byPlatform,
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
  const { startDate, endDate } = params;
  // Clamp limit before it reaches the SQL LIMIT binding: routes do
  // `parseInt(query.limit)` with no guard, and a NaN/negative/huge value must
  // degrade to the default instead of a Postgres bind error (old code sliced in
  // JS, which tolerated NaN silently). 1..100, default 20.
  const rawLimit = params.limit;
  const limit =
    typeof rawLimit === "number" && Number.isFinite(rawLimit) && rawLimit >= 1
      ? Math.min(Math.floor(rawLimit), 100)
      : 20;
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
  // link_metrics_latest already holds exactly one (newest ok) row per link, so the
  // top-N is a filter + ORDER BY + LIMIT over ~150k rows, indexed by (platform,
  // report_date). See getInsightsSummaryUncached for why link_metrics itself must never
  // be read here again. Two static templates (one per sort metric) keep the repo's
  // no-conditional-fragments rule; the tie-break (score DESC, fetched_at DESC) is
  // byte-identical to the previous DISTINCT ON + LATERAL shape.
  const start = startDate ? new Date(startDate) : new Date("1970-01-01T00:00:00.000Z");
  const end = endDate ? new Date(endDate) : new Date("2999-12-31T00:00:00.000Z");

  const latest =
    sortBy === "views"
      ? await prisma.$queryRaw<InsightRow[]>`
    SELECT l.link_id, l.url_normalized, l.url, l.video_id, l.platform,
           l.employee_id, u.name AS employee_name, l.fetched_at,
           l.views, l.likes, l.comments
    FROM link_metrics_latest l
    JOIN users u ON u.id = l.employee_id
    WHERE l.platform = ${platform}
      AND l.report_date >= ${start}
      AND l.report_date <= ${end}
    ORDER BY COALESCE(l.views, 0) DESC, l.fetched_at DESC
    LIMIT ${limit}
  `
      : await prisma.$queryRaw<InsightRow[]>`
    SELECT l.link_id, l.url_normalized, l.url, l.video_id, l.platform,
           l.employee_id, u.name AS employee_name, l.fetched_at,
           l.views, l.likes, l.comments
    FROM link_metrics_latest l
    JOIN users u ON u.id = l.employee_id
    WHERE l.platform = ${platform}
      AND l.report_date >= ${start}
      AND l.report_date <= ${end}
    ORDER BY COALESCE(l.likes, 0) + COALESCE(l.comments, 0) DESC, l.fetched_at DESC
    LIMIT ${limit}
  `;

  return latest.map((s) => ({
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

  // Latest ok snapshot per url — ONE row per (employee, url) from link_metrics_latest.
  // (Until 2026-09-18 this hydrated EVERY ok snapshot the employee had in the window —
  // hundreds of thousands of rows for a heavy Instagram submitter — on every HR
  // /report page load, holding a pool connection for seconds each time.)
  const snapshots = await prisma.linkMetricLatest.findMany({
    where: {
      employeeId,
      reportDate: { gte: since },
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
