"use client";

/**
 * SWR hooks for the Meta-connected surface on /accounts/growth.
 *
 * All of these are ADMIN-ONLY endpoints (reports.manage). A non-admin simply gets
 * 403s, which the page renders as "not connected" rather than an error wall — the
 * Meta panel is additive, and a Team Lead viewing the page should still see the
 * existing follower-growth content untouched.
 */

import useSWR from "swr";
import { apiFetch } from "@/lib/api";

export interface MetaConnection {
  id: string;
  metaUserId: string;
  metaUserName: string | null;
  connectedBy: { id: string; name: string } | null;
  status:
    | "ACTIVE"
    | "PARTIAL_SCOPE"
    | "NEEDS_REAUTH_SOON"
    | "NEEDS_REAUTH"
    | "RATE_LIMITED"
    | "REVOKED";
  grantedScopes: string[];
  missingScopes: string[];
  tokenExpiresAt: string | null;
  dataAccessExpiresAt: string | null;
  dataAccessDaysLeft: number | null;
  graphVersion: string;
  discoveryState: string;
  lastVerifiedAt: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  assetCount?: number;
  /**
   * The connection the page presents as "the" account. Any others exist as token
   * redundancy (a Facebook token expires and dies on password change) and are
   * kept out of the way rather than shown as separate accounts to manage.
   */
  primary?: boolean;
}

export interface MetaAsset {
  id: string;
  kind: "FACEBOOK_PAGE" | "INSTAGRAM_ACCOUNT";
  platform: "facebook" | "instagram";
  metaId: string;
  name: string;
  username: string | null;
  followerCount: number | null;
  postCount: number | null;
  pictureUrl: string | null;
  selected: boolean;
  socialAccountId: string | null;
  postCountStored: number;
  lastPostSyncAt: string | null;
  lastPostSyncStatus: string | null;
  lastPostSyncError: string | null;
}

export interface MetaPost {
  id: string;
  metaPostId: string;
  platform: "facebook" | "instagram";
  permalink: string | null;
  caption: string | null;
  mediaType: string | null;
  mediaProductType: string | null;
  postedAt: string | null;
  /** NULL means Meta publishes no such number for this post type. Render "—". */
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  reach: number | null;
  /** pending | ok | partial | unavailable | rate_limited | error */
  metricsStatus: string;
  metricsFetchedAt: string | null;
  asset: { id: string; name: string; username: string | null; kind: string };
}

/**
 * ⚠️ The internal portal's apiFetch<T> returns the FULL {success, data} envelope typed
 * as T — it does NOT unwrap like the client portal's does. So every call here types the
 * envelope and reads .data. Getting this wrong yields `undefined` at runtime rather than
 * a compile error, which is why it is spelled out.
 */
type Envelope<T> = { success: boolean; data: T };

const opts = { revalidateOnFocus: false, dedupingInterval: 30_000 } as const;

export function useMetaConnections() {
  const { data, error, isLoading, mutate } = useSWR(
    "/admin/meta/connections",
    (url: string) => apiFetch<Envelope<{ configured: boolean; missingEnv: string[]; connections: MetaConnection[] }>>(url).then((r) => r.data),
    opts,
  );
  return { data, error, isLoading, mutate };
}

export function useMetaAssets(params?: { kind?: "facebook" | "instagram"; q?: string }) {
  const qs = new URLSearchParams();
  if (params?.kind) qs.set("kind", params.kind);
  if (params?.q) qs.set("q", params.q);
  qs.set("limit", "100");
  const { data, error, isLoading, mutate } = useSWR(
    `/admin/meta/assets?${qs.toString()}`,
    (url: string) => apiFetch<Envelope<{ items: MetaAsset[]; total: number; hasMore: boolean }>>(url).then((r) => r.data),
    opts,
  );
  return { data, error, isLoading, mutate };
}

export function useMetaPosts(params?: {
  assetId?: string;
  kind?: "facebook" | "instagram";
  q?: string;
  cursor?: string | null;
}) {
  const qs = new URLSearchParams();
  if (params?.assetId) qs.set("assetId", params.assetId);
  if (params?.kind) qs.set("kind", params.kind);
  if (params?.q) qs.set("q", params.q);
  if (params?.cursor) qs.set("cursor", params.cursor);
  qs.set("limit", "25");
  const { data, error, isLoading, mutate } = useSWR(
    `/admin/meta/posts?${qs.toString()}`,
    (url: string) =>
      apiFetch<Envelope<{ items: MetaPost[]; nextCursor: string | null; pendingCount: number }>>(url).then((r) => r.data),
    opts,
  );
  return { data, error, isLoading, mutate };
}

export function useMetaPostsSummary() {
  const { data, error, isLoading, mutate } = useSWR(
    "/admin/meta/posts/summary",
    (url: string) =>
      apiFetch<Envelope<{
        postCount: number;
        totals: { views: number; likes: number; comments: number; shares: number };
        nullCounts: { views: number; likes: number };
        pendingCount: number;
      }>>(url).then((r) => r.data),
    opts,
  );
  return { data, error, isLoading, mutate };
}


/**
 * A CONNECTED CHANNEL — the primary row on Account Growth.
 *
 * ⚠️ Every metric is nullable on purpose. Availability differs per platform and per
 * account (Facebook publishes no whole-page unique reach at all), so a null means
 * "Meta does not publish this", NOT zero.
 */
export interface MetaChannel {
  id: string;
  platform: "facebook" | "instagram";
  metaId: string;
  name: string;
  username: string | null;
  pictureUrl: string | null;
  followers: number | null;
  /** Follower change across the selected period. null = no API history spans it yet. */
  followerDelta: number | null;
  /** Days the followerDelta actually spans — often SHORTER than the selected
   *  window, because API follower history only reaches back so far. Label the
   *  chip from THIS, never from the window. */
  followerDeltaDays?: number | null;
  /** Range mode only: days inside the selected range with stored history. */
  coveredDays?: number | null;
  /** Range mode only: total days in the selected range. */
  rangeDays?: number | null;
  /** Approximate earnings for the period, in cents. Facebook only; Instagram has no such metric. */
  earningsCents: number | null;
  /** Gross churn behind the net follower change. Both platforms. */
  follows: number | null;
  unfollows: number | null;
  /** Facebook only. */
  videoViewTimeMs: number | null;
  /** Instagram only — Facebook publishes no page-level equivalent. */
  saves: number | null;
  shares: number | null;
  accountsEngaged: number | null;
  posts: number | null;
  views28d: number | null;
  engagements28d: number | null;
  profileViews28d: number | null;
  reach28d: number | null;
  reactions28d: number | null;
  metricsFetchedAt: string | null;
  metricsError: string | null;
  selected: boolean;
  linkedToChannel: boolean;
  storedPosts: number;
}

/**
 * The time windows Meta can actually answer, with the labels we show.
 *
 * ⚠️ THIS LIST IS NOT EXTENSIBLE BY US. Facebook's `period` accepts only
 * day/week/days_28/month, and Instagram rejects any since/until span over 30
 * days outright. There is no 90-day option and one cannot be built by adding
 * shorter windows together, because reach counts UNIQUE people — summing two
 * 28-day reaches double-counts everyone who appears in both.
 */
export const CHANNEL_WINDOWS = [
  // ⚠️ "Yesterday", not "24h". Meta only publishes CLOSED periods, so the day
  // window has always been the last COMPLETED day — Facebook stamps it at the
  // Page's local midnight, Instagram at UTC midnight. Labelling it "24h"
  // implied a rolling last-24-hours it never was, and prompted "where is
  // yesterday's data?" — it was here all along, mislabelled.
  { key: "day", label: "Yesterday", suffix: "1d" },
  { key: "week", label: "7d", suffix: "7d" },
  { key: "days_28", label: "28d", suffix: "28d" },
] as const;

export type ChannelWindowKey = (typeof CHANNEL_WINDOWS)[number]["key"];

export function windowSuffix(key: ChannelWindowKey): string {
  return CHANNEL_WINDOWS.find((w) => w.key === key)?.suffix ?? "28d";
}

export function useMetaChannels(params?: {
  platform?: "facebook" | "instagram";
  q?: string;
  sort?: string;
  window?: ChannelWindowKey;
  /** Custom range (YYYY-MM-DD, inclusive). When set, figures come from stored
   *  daily history: exact sums for flow metrics, reach deliberately null. */
  start?: string;
  end?: string;
  /** List REMOVED channels (selected:false) instead of monitored ones. */
  hidden?: boolean;
} | null) {
  const qs = new URLSearchParams();
  if (params?.platform) qs.set("platform", params.platform);
  if (params?.q) qs.set("q", params.q);
  if (params?.sort) qs.set("sort", params.sort);
  if (params?.window) qs.set("window", params.window);
  if (params?.start) qs.set("start", params.start);
  if (params?.end) qs.set("end", params.end);
  if (params?.hidden) qs.set("hidden", "1");
  const { data, error, isLoading, mutate } = useSWR(
    params === null ? null : `/admin/meta/channels?${qs.toString()}`,
    (url: string) =>
      apiFetch<Envelope<{
        items: MetaChannel[];
        channelCount: number;
        /** Which window the figures describe — echoed so the UI can never mislabel them. */
        window: ChannelWindowKey | "custom";
        /** Present in range mode: the span the figures cover. */
        range?: { start: string; end: string; days: number };
        /** Newest moment Meta has published — Facebook closes periods at local midnight. */
        dataThrough: string | null;
        totals: { followers: number; views: number; engagements: number; reach: number; earningsCents: number };
        contributing: { views: number; engagements: number; reach: number; earnings: number };
        /** The equal-length span immediately before — the trend baseline. The UI
         *  must hide trend chips when coverageShare < ~0.95: a percentage against
         *  a half-covered baseline fabricates growth. */
        previousTotals?: {
          views: number; engagements: number; earningsCents: number;
          coverageShare: number;
          /** How many assets the baseline covers — the chip must hide when this
           *  is far below the current range's contributing count, or a 2-channel
           *  baseline gets compared against a 400-channel present. */
          assets?: number;
          start: string; end: string;
        } | null;
      }>>(url).then((r) => r.data),
    opts,
  );
  return { data, error, isLoading, mutate };
}

/** Start the consent flow. Returns the URL to send the browser to. */
export async function startMetaConnect(body?: { mode?: "connect" | "reconnect"; connectionId?: string; rerequest?: boolean }) {
  const res = await apiFetch<Envelope<{ authorizeUrl: string; state: string; expiresAt: string }>>(
    "/admin/meta/oauth/start",
    { method: "POST", body: JSON.stringify(body ?? {}) },
  );
  return res.data;
}

/**
 * Remove channels from monitoring (or restore them). Removal is selected:false —
 * the sync stops spending Graph calls on them, every view and total drops them,
 * history is kept, and Restore is one click. Never a delete.
 */
export async function setAssetsSelectedBulk(ids: string[], selected: boolean) {
  return apiFetch<Envelope<{ updated: number; selected: boolean }>>("/admin/meta/assets/bulk", {
    method: "PATCH",
    body: JSON.stringify({ ids, selected }),
  });
}

export async function triggerMetaDiscovery(connectionId: string) {
  return apiFetch(`/admin/meta/connections/${connectionId}/discover`, { method: "POST", body: "{}" });
}

export async function triggerMetaSync(body?: { assetId?: string; connectionId?: string }) {
  return apiFetch("/admin/meta/sync", { method: "POST", body: JSON.stringify(body ?? {}) });
}

export async function disconnectMeta(connectionId: string) {
  return apiFetch(`/admin/meta/connections/${connectionId}`, { method: "DELETE" });
}

export async function setAssetSelected(assetId: string, selected: boolean) {
  return apiFetch(`/admin/meta/assets/${assetId}`, {
    method: "PATCH",
    body: JSON.stringify({ selected }),
  });
}

/**
 * Compact number formatter that keeps "absent" distinguishable from zero.
 *
 * ⚠️ Returns "—" for null/undefined and NEVER 0. Rendering an absent metric as a
 * real 0 is the documented fabricated-zero bug (the Snapchat showLikes incident):
 * "0 likes" reads as a fact about the post, when the truth is Meta publishes no
 * number for it. A rendered 0 here always means loaded-and-truly-zero.
 */
/** Money, from integer cents. Never a bare 0 dressed up as "no data". */
export function fmtMoney(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return "—";
  const usd = cents / 100;
  if (Math.abs(usd) >= 1000) return `$${Math.round(usd).toLocaleString()}`;
  return `$${usd.toFixed(2)}`;
}

export interface MetaDemographics {
  supported: boolean;
  reason?: string;
  pending?: boolean;
  /** audience -> dimension -> buckets, already sorted value-desc by the API. */
  audiences: Record<string, Record<string, Array<{ bucket: string; value: number }>>>;
  fetchedAt: string | null;
}

/** Audience demographics for ONE channel. Only fetched when the row is expanded. */
export function useMetaDemographics(assetId: string | null) {
  const { data, error, isLoading } = useSWR(
    assetId ? `/admin/meta/channels/${assetId}/demographics` : null,
    (url: string) => apiFetch<Envelope<MetaDemographics>>(url).then((r) => r.data),
    opts,
  );
  return { data, error, isLoading };
}

/** Milliseconds of watch time as human hours. "—" when absent, never 0h for null. */
export function fmtWatchTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  const hours = ms / 3_600_000;
  if (hours >= 1000) return `${fmtMetric(Math.round(hours))} h`;
  if (hours >= 1) return `${hours.toFixed(1)} h`;
  return `${Math.round(ms / 60000)} min`;
}

export function fmtMetric(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}b`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
