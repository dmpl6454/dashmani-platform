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
  { key: "day", label: "24h", suffix: "24h" },
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
}) {
  const qs = new URLSearchParams();
  if (params?.platform) qs.set("platform", params.platform);
  if (params?.q) qs.set("q", params.q);
  if (params?.sort) qs.set("sort", params.sort);
  if (params?.window) qs.set("window", params.window);
  const { data, error, isLoading, mutate } = useSWR(
    `/admin/meta/channels?${qs.toString()}`,
    (url: string) =>
      apiFetch<Envelope<{
        items: MetaChannel[];
        channelCount: number;
        /** Which window the figures describe — echoed so the UI can never mislabel them. */
        window: ChannelWindowKey;
        totals: { followers: number; views: number; engagements: number; reach: number };
        contributing: { views: number; engagements: number; reach: number };
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
export function fmtMetric(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}b`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
