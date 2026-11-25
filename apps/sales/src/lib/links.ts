"use client";
import useSWR from "swr";
import { fetcher } from "./api";

// Link Analytics (/links) — wire types and SWR hooks over /v1/sales/links/*.
// Spec: docs/link-analytics/SPEC.md. A metric Meta doesn't publish is null → "—", never 0.

export type LinkStatus = "pending" | "verified" | "restricted" | "failed";

export interface BatchCounts {
  total: number; valid: number; invalid: number; unique: number; duplicate: number;
  pending: number; verified: number; restricted: number; failed: number;
}
export interface RunProgress {
  total: number; processed: number; succeeded: number; failed: number; pending: number;
  perMinute: number | null; etaSeconds: number | null;
}
export interface WorkerStatus {
  enabled: boolean; throttledUntil: string | null; throttleReason: string | null;
  callsLastHour: number; maxCallsPerHour: number; lastTickAt: string | null;
}
export interface Batch {
  id: string; name: string; notes: string | null; keepDuplicates: boolean; state: "idle" | "running" | "paused";
  runStartedAt: string | null; runFinishedAt: string | null;
  refreshEveryHours: number | null; scheduleEndsAt: string | null; nextRefreshAt: string | null;
  archivedAt: string | null; createdAt: string; updatedAt: string; createdBy?: string | null;
  counts: BatchCounts; progress?: RunProgress;
}
export interface LinkPost {
  id: string; postKey: string; platform: "instagram" | "facebook"; postType: string; canonicalUrl: string; externalId: string | null;
  accountName: string | null; username: string | null; followers: number | null; followersAt: string | null;
  caption: string | null; publishedAt: string | null; thumbnailUrl: string | null;
  views: number | null; reach: number | null; likes: number | null; comments: number | null; shares: number | null; saves: number | null;
  status: LinkStatus; access: "full" | "public" | "none" | null; statusReason: string | null; errorMessage: string | null;
  dataSource: string | null; metricsAt: string | null; lastCheckedAt: string | null; checkCount: number;
  refreshing: boolean; freshness: "live" | "cached" | null; nextAttemptAt: string | null; attempts: number;
}
export interface BatchItem {
  id: string; position: number; rawUrl: string; normalizedUrl: string | null; platform: string | null; postType: string | null;
  validity: "valid" | "invalid" | "duplicate"; invalidReason: string | null; duplicateOfId: string | null; usernameHint: string | null;
  post: LinkPost | null;
}
export interface Snapshot {
  checkedAt: string; status: string; dataSource: string | null; metricsAt: string | null;
  views: number | null; reach: number | null; likes: number | null; comments: number | null; shares: number | null; saves: number | null; followers: number | null;
}
export interface PostDetail {
  post: LinkPost; snapshots: Snapshot[];
  growth: null | { from: string; to: string; views: number | null; reach: number | null; likes: number | null; comments: number | null; shares: number | null; saves: number | null };
  batches: Array<{ id: string; name: string; rawUrl: string; usernameHint: string | null }>;
}
export interface Total { sum: number | null; reporting: number; of: number; avg: number | null }
export interface ReportPost {
  id: string; url: string; platform: string; postType: string; account: string | null; username: string | null; followers: number | null;
  publishedAt: string | null; caption: string | null;
  views: number | null; reach: number | null; likes: number | null; comments: number | null; shares: number | null; saves: number | null;
  engagement: number | null; engagementPartial: boolean; erFollowers: number | null; erReach: number | null;
  status: LinkStatus; access: string | null; reason: string | null; source: string | null; freshness: string | null;
  metricsAt: string | null; lastCheckedAt: string | null; error: string | null;
}
export interface EngagementSummary {
  actions: Total; partialPosts: number; weightedRateFollowers: number | null; weightedRateReach: number | null;
  avgRateFollowers: number | null; avgRateReach: number | null; postsWithFollowers: number; postsWithReach: number;
}
type Totals = Record<"views" | "reach" | "likes" | "comments" | "shares" | "saves", Total>;
export interface Report {
  generatedAt: string;
  batch: { id: string; name: string; notes: string | null; createdAt: string; runFinishedAt: string | null };
  counts: BatchCounts;
  executive: {
    kpis: {
      posts: { total: number; verified: number; restricted: number; failed: number; pending: number };
      views: Total; reach: Total; likes: Total; comments: Total; shares: Total; saves: Total;
      followers: { sum: number | null; accountsWithFollowers: number; accounts: number };
      engagement: EngagementSummary; lastCheckedAt: string | null; live: number; cached: number;
    };
    highlights: string[]; dataLimitations: string[];
  };
  posts: ReportPost[];
  platforms: Array<{ platform: string; posts: number; verified: number; restricted: number; failed: number; pending: number; totals: Totals; engagement: EngagementSummary; topPost: ReportPost | null }>;
  pages: Array<{ key: string; platform: string; account: string | null; username: string | null; followers: number | null; posts: number; verified: number; restricted: number; failed: number; totals: Totals; engagement: EngagementSummary; topPost: ReportPost | null }>;
  top: { byViews: ReportPost[]; byLikes: ReportPost[]; byComments: ReportPost[]; byShares: ReportPost[]; perPlatform: Record<string, ReportPost[]> };
  engagement: { formulas: string[]; summary: EngagementSummary; byPlatform: Array<EngagementSummary & { platform: string }>; topByRate: ReportPost[] };
}

const live = { revalidateOnFocus: true, keepPreviousData: true, dedupingInterval: 2_000 };

export const useBatches = (archived: boolean) =>
  useSWR<{ batches: Batch[]; worker: WorkerStatus }>(`/sales/links/batches${archived ? "?archived=1" : ""}`, fetcher, { ...live, refreshInterval: 15_000 });

/** Polls every 4 s while the batch runs, so progress is live; every 60 s otherwise. */
export const useBatch = (id: string | null, running: boolean) =>
  useSWR<Batch & { worker: WorkerStatus }>(id ? `/sales/links/batches/${id}` : null, fetcher, { ...live, refreshInterval: running ? 4_000 : 60_000 });

export const useBatchItems = (id: string | null, qs: string, running: boolean) =>
  useSWR<{ total: number; page: number; pageSize: number; rows: BatchItem[] }>(id ? `/sales/links/batches/${id}/items?${qs}` : null, fetcher, { ...live, refreshInterval: running ? 8_000 : 0 });

export const useReport = (id: string | null, running: boolean) =>
  useSWR<Report>(id ? `/sales/links/batches/${id}/report` : null, fetcher, { ...live, refreshInterval: running ? 20_000 : 0 });

export const usePostDetail = (postId: string | null) =>
  useSWR<PostDetail>(postId ? `/sales/links/posts/${postId}` : null, fetcher, live);

export const STATUS_LABEL: Record<LinkStatus, string> = { verified: "Verified", restricted: "Restricted", failed: "Failed", pending: "Pending" };
export const STATUS_TONE: Record<LinkStatus, string> = {
  verified: "border-success text-success",
  restricted: "border-attention text-attention",
  failed: "border-danger text-danger",
  pending: "border-border text-ink-3",
};

/** Mirrors RESTRICTED_REASON_TEXT in the API (services/link-analytics/types.ts). */
export const REASON_TEXT: Record<string, string> = {
  ig_no_username: "Not on an Instagram account we've connected, and the link has no @username. Add the account's username so Meta's business discovery can look it up.",
  ig_account_not_public: "Meta's business discovery can't see this account: it is a personal or private account, or the username is wrong. Only business and creator accounts are readable.",
  ig_post_not_in_recent_media: "Business discovery found the account, but this post is older than the newest posts it can page through.",
  fb_not_our_page: "This Facebook post is on a Page or profile we don't administer. Meta shares no metrics for it without Page Public Content Access, which our apps don't have.",
  fb_unresolvable_link: "This Facebook share link doesn't reveal which post it is. Open it and copy the post's own link.",
  no_meta_connection: "No Meta account is connected, so nothing can be read. An admin connects one on Account Growth in the staff portal.",
};

export const SOURCE_LABEL: Record<string, string> = {
  meta_graph: "Meta Graph API — our account",
  meta_business_discovery: "Meta business discovery — public counts",
  platform_sync: "Platform's Meta sync — cached",
  none: "Nothing readable",
};

export const ACCESS_LABEL: Record<string, string> = { full: "Full insights", public: "Public counts only", none: "No data" };

export const num = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString("en-IN"));
export const compactNum = (v: number | null | undefined) =>
  v == null ? "—" : v >= 1e7 ? `${(v / 1e7).toFixed(2)} Cr` : v >= 1e5 ? `${(v / 1e5).toFixed(1)} L` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : String(v);

/** "3 min ago" / "2 h ago" / "5 Nov" — fixed English, no locale surprises. */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = new Date(iso);
  return `${d.getDate()} ${MON[d.getMonth()]}`;
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "20 Nov 2026" — fixed English, never toLocale* (browser locales disagree). */
export function day(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()}`;
}
/** "20 Nov 2026, 3:30 pm" */
export function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const h = d.getHours();
  return `${day(iso)}, ${h % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

/** One-line reason for the table; the full sentence is in REASON_TEXT. */
export const REASON_SHORT: Record<string, string> = {
  ig_no_username: "Not our account — add its @username",
  ig_account_not_public: "Personal / private account",
  ig_post_not_in_recent_media: "Older than discovery can see",
  fb_not_our_page: "Not a Page we administer",
  fb_unresolvable_link: "Share link hides the post id",
  no_meta_connection: "No Meta connection",
};

export function duration(sec: number | null): string {
  if (sec == null) return "—";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  return `${Math.floor(sec / 3600)} h ${Math.round((sec % 3600) / 60)} min`;
}
