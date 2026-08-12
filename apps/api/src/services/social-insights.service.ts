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
  // Latest snapshot per (employee_id, url_normalized) via DISTINCT ON, but BOTH the
  // aggregation AND the top-20 selection now happen IN POSTGRES. The previous shape
  // deduped in SQL yet still returned the ENTIRE deduped set (~41k rows all-time) into
  // Node to sum + sort in JS — measured 14-16s per call on prod, dominated by a parallel
  // seq scan + a ~92MB on-disk merge sort, because selecting url/link_id/video_id per row
  // makes the covering index unusable. Split into two queries that each stay inside
  // link_metrics_emp_url_fetched_ok_v2_idx (employee_id, url_normalized, fetched_at DESC)
  // INCLUDE (views, likes, comments, report_date, platform) WHERE status='ok':
  //   1) aggregate: DISTINCT ON over covered columns only → GROUP BY platform (~1.3s
  //      index-only, measured live);
  //   2) top-20: DISTINCT ON over covered columns → ORDER BY views LIMIT 20, then a
  //      LATERAL join-back fetches the full row for ONLY the 20 winners (~0.5s live).
  // The LATERAL repeats the same status/window predicates so its winner is the SAME row
  // DISTINCT ON picked. ORDER BY COALESCE(views,0) DESC, fetched_at DESC reproduces the
  // old JS stable-sort tie-break (equal views → newer fetched_at first) exactly.
  //
  // Bounds are ALWAYS passed as concrete Dates (null-start → epoch, null-end → far future)
  // to keep these fully STATIC tagged templates — the repo's proven $queryRaw pattern
  // (leaderboard.service.ts / link-search.service.ts), no conditional Prisma.sql fragments.
  // employeeId is optional: when absent we bind a sentinel and the `(… OR ${bind} IS NULL)`
  // makes the filter a no-op (still fully static, still two-plus fixed bindings).
  const start = startDate ? new Date(startDate) : new Date("1970-01-01T00:00:00.000Z");
  const end = endDate ? new Date(endDate) : new Date("2999-12-31T00:00:00.000Z");
  const empFilter = employeeId ?? null;

  // Queries run sequentially on purpose: one pooled connection at a time, so a burst of
  // uncached windows can't hold two pool slots per request (the 2026-07-16 incident class).
  const agg = await prisma.$queryRaw<PlatformAggRow[]>`
    WITH latest AS (
      SELECT DISTINCT ON (lm.employee_id, lm.url_normalized)
        lm.platform, lm.views, lm.likes, lm.comments
      FROM link_metrics lm
      WHERE lm.status = 'ok'
        AND lm.report_date >= ${start}
        AND lm.report_date <= ${end}
        AND (${empFilter}::text IS NULL OR lm.employee_id = ${empFilter})
      ORDER BY lm.employee_id, lm.url_normalized, lm.fetched_at DESC
    )
    SELECT lower(platform) AS platform,
           count(*)::bigint AS link_count,
           sum(coalesce(views, 0))::bigint AS views,
           sum(coalesce(likes, 0))::bigint AS likes,
           sum(coalesce(comments, 0))::bigint AS comments
    FROM latest
    GROUP BY lower(platform)
    ORDER BY count(*) DESC
  `;

  const topRows = await prisma.$queryRaw<InsightRow[]>`
    WITH winners AS (
      SELECT DISTINCT ON (lm.employee_id, lm.url_normalized)
        lm.employee_id, lm.url_normalized, lm.fetched_at, lm.views
      FROM link_metrics lm
      WHERE lm.status = 'ok'
        AND lm.report_date >= ${start}
        AND lm.report_date <= ${end}
        AND (${empFilter}::text IS NULL OR lm.employee_id = ${empFilter})
      ORDER BY lm.employee_id, lm.url_normalized, lm.fetched_at DESC
    ),
    top_n AS (
      SELECT * FROM winners ORDER BY COALESCE(views, 0) DESC, fetched_at DESC LIMIT 20
    )
    SELECT f.link_id, f.url_normalized, f.url, f.video_id, f.platform,
           f.employee_id, u.name AS employee_name, f.fetched_at,
           f.views, f.likes, f.comments
    FROM top_n t
    JOIN LATERAL (
      SELECT lm2.link_id, lm2.url_normalized, lm2.url, lm2.video_id, lm2.platform,
             lm2.employee_id, lm2.fetched_at, lm2.views, lm2.likes, lm2.comments
      FROM link_metrics lm2
      WHERE lm2.employee_id = t.employee_id
        AND lm2.url_normalized = t.url_normalized
        AND lm2.status = 'ok'
        AND lm2.report_date >= ${start}
        AND lm2.report_date <= ${end}
      ORDER BY lm2.fetched_at DESC
      LIMIT 1
    ) f ON true
    JOIN users u ON u.id = f.employee_id
    ORDER BY COALESCE(f.views, 0) DESC, f.fetched_at DESC
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
  // Latest snapshot per (employee_id, url_normalized) for ONE platform via DISTINCT ON,
  // with the top-N selection ALSO in Postgres. The previous shape deduped in SQL but
  // returned the whole deduped platform set (~tens of thousands of rows all-time) into
  // Node to score + sort + slice in JS — measured 11-12s per call on prod (parallel seq
  // scan + on-disk sort; selecting url/link_id/video_id per row defeats the covering
  // index). Now: winners CTE over ONLY covered columns (index-only via
  // link_metrics_emp_url_fetched_ok_v2_idx — platform is in its INCLUDE list), scored +
  // LIMITed in SQL, then a LATERAL join-back fetches full rows for just the N winners.
  // The LATERAL repeats the same status/platform/window predicates so its winner is the
  // SAME row DISTINCT ON picked. ORDER BY score DESC, fetched_at DESC reproduces the old
  // JS stable-sort tie-break (equal score → newer fetched_at first) exactly. Two static
  // tagged templates (one per sort metric) keep the repo's no-conditional-fragments rule.
  const start = startDate ? new Date(startDate) : new Date("1970-01-01T00:00:00.000Z");
  const end = endDate ? new Date(endDate) : new Date("2999-12-31T00:00:00.000Z");

  const latest =
    sortBy === "views"
      ? await prisma.$queryRaw<InsightRow[]>`
    WITH winners AS (
      SELECT DISTINCT ON (lm.employee_id, lm.url_normalized)
        lm.employee_id, lm.url_normalized, lm.fetched_at, lm.views, lm.likes, lm.comments
      FROM link_metrics lm
      WHERE lm.status = 'ok'
        AND lm.platform = ${platform}
        AND lm.report_date >= ${start}
        AND lm.report_date <= ${end}
      ORDER BY lm.employee_id, lm.url_normalized, lm.fetched_at DESC
    ),
    top_n AS (
      SELECT * FROM winners ORDER BY COALESCE(views, 0) DESC, fetched_at DESC LIMIT ${limit}
    )
    SELECT f.link_id, f.url_normalized, f.url, f.video_id, f.platform,
           f.employee_id, u.name AS employee_name, f.fetched_at,
           f.views, f.likes, f.comments
    FROM top_n t
    JOIN LATERAL (
      SELECT lm2.link_id, lm2.url_normalized, lm2.url, lm2.video_id, lm2.platform,
             lm2.employee_id, lm2.fetched_at, lm2.views, lm2.likes, lm2.comments
      FROM link_metrics lm2
      WHERE lm2.employee_id = t.employee_id
        AND lm2.url_normalized = t.url_normalized
        AND lm2.status = 'ok'
        AND lm2.platform = ${platform}
        AND lm2.report_date >= ${start}
        AND lm2.report_date <= ${end}
      ORDER BY lm2.fetched_at DESC
      LIMIT 1
    ) f ON true
    JOIN users u ON u.id = f.employee_id
    ORDER BY COALESCE(f.views, 0) DESC, f.fetched_at DESC
  `
      : await prisma.$queryRaw<InsightRow[]>`
    WITH winners AS (
      SELECT DISTINCT ON (lm.employee_id, lm.url_normalized)
        lm.employee_id, lm.url_normalized, lm.fetched_at, lm.views, lm.likes, lm.comments
      FROM link_metrics lm
      WHERE lm.status = 'ok'
        AND lm.platform = ${platform}
        AND lm.report_date >= ${start}
        AND lm.report_date <= ${end}
      ORDER BY lm.employee_id, lm.url_normalized, lm.fetched_at DESC
    ),
    top_n AS (
      SELECT * FROM winners
      ORDER BY COALESCE(likes, 0) + COALESCE(comments, 0) DESC, fetched_at DESC
      LIMIT ${limit}
    )
    SELECT f.link_id, f.url_normalized, f.url, f.video_id, f.platform,
           f.employee_id, u.name AS employee_name, f.fetched_at,
           f.views, f.likes, f.comments
    FROM top_n t
    JOIN LATERAL (
      SELECT lm2.link_id, lm2.url_normalized, lm2.url, lm2.video_id, lm2.platform,
             lm2.employee_id, lm2.fetched_at, lm2.views, lm2.likes, lm2.comments
      FROM link_metrics lm2
      WHERE lm2.employee_id = t.employee_id
        AND lm2.url_normalized = t.url_normalized
        AND lm2.status = 'ok'
        AND lm2.platform = ${platform}
        AND lm2.report_date >= ${start}
        AND lm2.report_date <= ${end}
      ORDER BY lm2.fetched_at DESC
      LIMIT 1
    ) f ON true
    JOIN users u ON u.id = f.employee_id
    ORDER BY COALESCE(f.likes, 0) + COALESCE(f.comments, 0) DESC, f.fetched_at DESC
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
