// Link Analytics — the six reports (docs/link-analytics/SPEC.md §6). Computed on demand from the
// batch's posts; nothing is stored. Every number says how many posts it covers ("N of M"), and an
// unknown value stays null — a sum never treats "Meta doesn't publish this" as 0.

import { prisma } from "@dashmani/db";
import { AppError } from "../../middleware/error-handler";
import { batchCounts, postShape, POST_SELECT } from "./batches.service";
import { RESTRICTED_REASON_TEXT, type RestrictedReason } from "./types";

export const METRICS = ["views", "reach", "likes", "comments", "shares", "saves"] as const;
export type Metric = (typeof METRICS)[number];

export const FORMULAS = [
  "Engagement actions = likes + comments + shares. Only the parts Meta published are added; a post missing any part is marked “partial”.",
  "Engagement rate (followers) = engagement actions ÷ the account's followers × 100, for each post where both are known.",
  "Engagement rate (reach) = engagement actions ÷ reach × 100, only where Meta published reach (our own accounts).",
  "Batch engagement rate = Σ engagement actions ÷ Σ followers (or Σ reach) × 100, over the posts that have both — a weighted rate, so big accounts count for more.",
  "Average engagement rate = the plain mean of the per-post rates.",
  "Followers = the sum over UNIQUE accounts (each account counted once), not once per post.",
  "Totals add only the posts that report the metric; each total says how many posts that is.",
];

export interface ReportPost {
  id: string;
  url: string;
  platform: string;
  postType: string;
  account: string | null;
  username: string | null;
  followers: number | null;
  publishedAt: Date | null;
  caption: string | null;
  views: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  engagement: number | null;
  engagementPartial: boolean;
  erFollowers: number | null;
  erReach: number | null;
  status: string;
  access: string | null;
  reason: string | null;
  source: string | null;
  freshness: string | null;
  metricsAt: Date | null;
  lastCheckedAt: Date | null;
  error: string | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function engagementOf(p: { likes: number | null; comments: number | null; shares: number | null }) {
  const parts = [p.likes, p.comments, p.shares].filter((v): v is number => v != null);
  return { engagement: parts.length ? parts.reduce((a, b) => a + b, 0) : null, partial: parts.length > 0 && parts.length < 3 };
}

export function toReportPost(p: ReturnType<typeof postShape>): ReportPost {
  const { engagement, partial } = engagementOf(p);
  return {
    id: p.id, url: p.canonicalUrl, platform: p.platform, postType: p.postType, account: p.accountName, username: p.username, followers: p.followers,
    publishedAt: p.publishedAt, caption: p.caption,
    views: p.views, reach: p.reach, likes: p.likes, comments: p.comments, shares: p.shares, saves: p.saves,
    engagement, engagementPartial: partial,
    erFollowers: engagement != null && p.followers ? round2((engagement / p.followers) * 100) : null,
    erReach: engagement != null && p.reach ? round2((engagement / p.reach) * 100) : null,
    status: p.status, access: p.access,
    reason: p.statusReason ? RESTRICTED_REASON_TEXT[p.statusReason as RestrictedReason] ?? p.statusReason : null,
    source: p.dataSource, freshness: p.freshness, metricsAt: p.metricsAt, lastCheckedAt: p.lastCheckedAt, error: p.errorMessage,
  };
}

export interface Total {
  sum: number | null;
  reporting: number;
  of: number;
  avg: number | null;
}

export function total(posts: ReportPost[], m: Metric | "engagement"): Total {
  const vals = posts.map((p) => p[m]).filter((v): v is number => v != null);
  const sum = vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  return { sum, reporting: vals.length, of: posts.length, avg: sum != null ? Math.round(sum / vals.length) : null };
}

const accountKey = (p: ReportPost) => (p.username ? `${p.platform}:@${p.username.toLowerCase()}` : p.account ? `${p.platform}:${p.account}` : null);

export function uniqueFollowers(posts: ReportPost[]) {
  const best = new Map<string, number>();
  for (const p of posts) {
    const k = accountKey(p);
    if (!k || p.followers == null) continue;
    best.set(k, Math.max(best.get(k) ?? 0, p.followers));
  }
  const accounts = new Set(posts.map(accountKey).filter(Boolean)).size;
  return { sum: best.size ? [...best.values()].reduce((a, b) => a + b, 0) : null, accountsWithFollowers: best.size, accounts };
}

export function engagementSummary(posts: ReportPost[]) {
  const withF = posts.filter((p) => p.engagement != null && p.followers);
  const withR = posts.filter((p) => p.engagement != null && p.reach);
  const sum = (xs: ReportPost[], k: "engagement" | "followers" | "reach") => xs.reduce((a, p) => a + (p[k] ?? 0), 0);
  const mean = (xs: number[]) => (xs.length ? round2(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  return {
    actions: total(posts, "engagement"),
    partialPosts: posts.filter((p) => p.engagementPartial).length,
    weightedRateFollowers: withF.length ? round2((sum(withF, "engagement") / sum(withF, "followers")) * 100) : null,
    weightedRateReach: withR.length ? round2((sum(withR, "engagement") / sum(withR, "reach")) * 100) : null,
    avgRateFollowers: mean(withF.map((p) => p.erFollowers!)),
    avgRateReach: mean(withR.map((p) => p.erReach!)),
    postsWithFollowers: withF.length,
    postsWithReach: withR.length,
  };
}

function topBy(posts: ReportPost[], m: Metric | "engagement", n: number) {
  return posts.filter((p) => p[m] != null).sort((a, b) => (b[m] as number) - (a[m] as number)).slice(0, n);
}

function groupSummary(posts: ReportPost[]) {
  const totals = Object.fromEntries(METRICS.map((m) => [m, total(posts, m)])) as Record<Metric, Total>;
  return {
    posts: posts.length,
    verified: posts.filter((p) => p.status === "verified").length,
    restricted: posts.filter((p) => p.status === "restricted").length,
    failed: posts.filter((p) => p.status === "failed").length,
    pending: posts.filter((p) => p.status === "pending").length,
    totals,
    engagement: engagementSummary(posts),
    topPost: topBy(posts, "views", 1)[0] ?? topBy(posts, "engagement", 1)[0] ?? null,
  };
}

export async function loadBatchPosts(batchId: string): Promise<ReportPost[]> {
  const rows = await prisma.$queryRaw<Array<{ post_id: string }>>`
    SELECT DISTINCT post_id FROM link_batch_items WHERE batch_id = ${batchId} AND validity = 'valid' AND post_id IS NOT NULL`;
  const ids = rows.map((r) => r.post_id);
  const out: ReportPost[] = [];
  for (let i = 0; i < ids.length; i += 2000) {
    const posts = await prisma.linkPost.findMany({ where: { id: { in: ids.slice(i, i + 2000) } }, select: POST_SELECT });
    out.push(...posts.map((p) => toReportPost(postShape(p))));
  }
  return out;
}

export function dataLimitations(posts: ReportPost[]): string[] {
  const n = (f: (p: ReportPost) => boolean) => posts.filter(f).length;
  const lines = [
    "All numbers come from Meta's official Graph API. Nothing is scraped, and nothing behind a login is read.",
    "Reach, saves and shares are private analytics: Meta gives them only to the account's own admins, so they exist for our connected accounts only.",
    "Facebook publishes no saves metric. Instagram publishes views on other accounts' posts for reels only.",
    "Meta's numbers can lag up to 48 hours, and Meta may revise them.",
    "A dash (—) means Meta does not publish that number for that post. It is never a zero.",
  ];
  const pub = n((p) => p.status === "restricted" && p.access === "public");
  const none = n((p) => p.status === "restricted" && p.access !== "public");
  const cached = n((p) => p.freshness === "cached");
  const failed = n((p) => p.status === "failed");
  const pending = n((p) => p.status === "pending");
  if (pub) lines.push(`${pub} post(s) are on Instagram business/creator accounts we don't administer: only public likes, comments, reel views and followers are available for them.`);
  if (none) lines.push(`${none} post(s) are restricted with no readable metrics (see each post's reason); they are excluded from every total.`);
  if (cached) lines.push(`${cached} post(s) show CACHED values from the platform's background Meta sync because the live read failed; their measured time is shown.`);
  if (failed) lines.push(`${failed} post(s) failed to load; they are listed under Failed links.`);
  if (pending) lines.push(`${pending} post(s) were still waiting to be checked when this report was generated.`);
  return lines;
}

export async function buildReport(batchId: string, now = new Date()) {
  const batch = await prisma.linkBatch.findUnique({ where: { id: batchId } });
  if (!batch) throw new AppError(404, "NOT_FOUND", "Batch not found");
  const posts = await loadBatchPosts(batchId);
  const counts = (await batchCounts([batchId])).get(batchId)!;
  const lastChecked = posts.reduce<Date | null>((m, p) => (p.lastCheckedAt && (!m || p.lastCheckedAt > m) ? p.lastCheckedAt : m), null);
  const followers = uniqueFollowers(posts);
  const engagement = engagementSummary(posts);
  const platforms = (["instagram", "facebook"] as const)
    .map((pl) => ({ platform: pl, ...groupSummary(posts.filter((p) => p.platform === pl)) }))
    .filter((g) => g.posts > 0);

  const pageMap = new Map<string, ReportPost[]>();
  for (const p of posts) {
    const k = accountKey(p) ?? `${p.platform}:(unknown account)`;
    pageMap.set(k, [...(pageMap.get(k) ?? []), p]);
  }
  const pages = [...pageMap.entries()].map(([k, ps]) => {
    const g = groupSummary(ps);
    const f = ps.find((p) => p.followers != null)?.followers ?? null;
    return {
      key: k, platform: ps[0].platform, account: ps[0].account, username: ps[0].username, followers: f,
      posts: g.posts, verified: g.verified, restricted: g.restricted, failed: g.failed,
      totals: g.totals, engagement: g.engagement, topPost: g.topPost,
    };
  }).sort((a, b) => (b.totals.views.sum ?? -1) - (a.totals.views.sum ?? -1) || b.posts - a.posts);

  const kpis = {
    posts: { total: posts.length, verified: counts.verified, restricted: counts.restricted, failed: counts.failed, pending: counts.pending },
    views: total(posts, "views"),
    reach: total(posts, "reach"),
    likes: total(posts, "likes"),
    comments: total(posts, "comments"),
    shares: total(posts, "shares"),
    saves: total(posts, "saves"),
    followers,
    engagement,
    lastCheckedAt: lastChecked,
    live: posts.filter((p) => p.freshness === "live").length,
    cached: posts.filter((p) => p.freshness === "cached").length,
  };

  const highlights: string[] = [];
  const topV = topBy(posts, "views", 1)[0];
  if (topV) highlights.push(`Top post by views: ${topV.account ?? topV.username ?? "unknown account"} — ${topV.views!.toLocaleString("en-IN")} views.`);
  if (engagement.weightedRateFollowers != null) highlights.push(`Engagement rate on followers: ${engagement.weightedRateFollowers}% across ${engagement.postsWithFollowers} post(s).`);
  if (platforms.length > 1) highlights.push(platforms.map((g) => `${g.platform === "instagram" ? "Instagram" : "Facebook"}: ${g.posts} post(s)`).join(" · "));

  return {
    generatedAt: now,
    batch: { id: batch.id, name: batch.name, notes: batch.notes, createdAt: batch.createdAt, runFinishedAt: batch.runFinishedAt },
    counts,
    executive: { kpis, highlights, dataLimitations: dataLimitations(posts) },
    posts,
    platforms,
    pages,
    top: {
      byViews: topBy(posts, "views", 10),
      byLikes: topBy(posts, "likes", 10),
      byComments: topBy(posts, "comments", 10),
      byShares: topBy(posts, "shares", 10),
      perPlatform: Object.fromEntries(platforms.map((g) => {
        const ps = posts.filter((p) => p.platform === g.platform);
        const byViews = topBy(ps, "views", 5);
        return [g.platform, byViews.length ? byViews : topBy(ps, "engagement", 5)];
      })),
    },
    engagement: {
      formulas: FORMULAS,
      summary: engagement,
      byPlatform: platforms.map((g) => ({ platform: g.platform, ...g.engagement })),
      topByRate: posts.filter((p) => p.erFollowers != null).sort((a, b) => b.erFollowers! - a.erFollowers!).slice(0, 10),
    },
  };
}

export type BatchReport = Awaited<ReturnType<typeof buildReport>>;

/** Invalid lines, failed posts and restricted posts with nothing readable — the Failed Links sheet. */
export async function failedLinks(batchId: string) {
  const items = await prisma.linkBatchItem.findMany({
    where: {
      batchId,
      OR: [
        { validity: "invalid" },
        { validity: "valid", post: { OR: [{ status: "failed" }, { status: "restricted", access: "none" }] } },
      ],
    },
    orderBy: { position: "asc" },
    take: 20000,
    select: { position: true, rawUrl: true, validity: true, invalidReason: true, post: { select: { status: true, statusReason: true, errorMessage: true } } },
  });
  return items.map((i) => ({
    line: i.position + 1,
    url: i.rawUrl,
    problem: i.validity === "invalid" ? "Invalid link" : i.post?.status === "failed" ? "Failed" : "Restricted",
    detail: i.validity === "invalid" ? i.invalidReason : i.post?.status === "failed" ? i.post.errorMessage : RESTRICTED_REASON_TEXT[i.post?.statusReason as RestrictedReason] ?? i.post?.statusReason ?? null,
  }));
}

/** Every stored check of the batch's posts (Extraction History sheet), oldest first, capped. */
export async function extractionHistory(batchId: string, cap = 50000) {
  return prisma.$queryRaw<Array<{ post_id: string; url: string; checked_at: Date; status: string; data_source: string | null; metrics_at: Date | null; views: number | null; reach: number | null; likes: number | null; comments: number | null; shares: number | null; saves: number | null; followers: number | null }>>`
    SELECT s.post_id, p.canonical_url AS url, s.checked_at, s.status, s.data_source, s.metrics_at, s.views, s.reach, s.likes, s.comments, s.shares, s.saves, s.followers
      FROM link_post_snapshots s JOIN link_posts p ON p.id = s.post_id
     WHERE s.post_id IN (SELECT DISTINCT post_id FROM link_batch_items WHERE batch_id = ${batchId} AND post_id IS NOT NULL)
     ORDER BY p.canonical_url, s.checked_at
     LIMIT ${cap}`;
}
