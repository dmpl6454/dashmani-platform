"use client";

/**
 * SWR hooks for the YouTube and Snapchat boards on /accounts/growth.
 *
 * These are SIBLINGS of `use-meta.tsx`, not an extension of it. The Meta tab speaks for
 * the channels the connected Meta account administers, read from Meta's own API; these
 * two tabs speak for a different estate with different provenance (YouTube's official
 * Data API, and a read of each public Snapchat profile page). Keeping them in separate
 * modules is what stops one platform's quirks leaking into the other's types.
 *
 * ⚠️ Same envelope trap as use-meta.tsx: the internal portal's apiFetch<T> returns the
 * FULL {success, data} envelope typed as T — it does NOT unwrap the way the client
 * portal's does. Getting this wrong yields `undefined` at runtime rather than a compile
 * error, so every call here types the envelope and reads `.data`.
 */

import useSWR from "swr";
import { apiFetch } from "@/lib/api";

export const CHANNEL_PLATFORMS = ["youtube", "snapchat"] as const;
export type ChannelPlatform = (typeof CHANNEL_PLATFORMS)[number];

/**
 * The windows the board serves. Unlike the Meta tab — whose window list is dictated by
 * what Meta's API will answer at all — these are our own spans measured from snapshots
 * we store, so plain day counts are both honest and comparable.
 */
export const CHANNEL_PERIODS = [7, 14, 30, 90] as const;
export type ChannelPeriod = (typeof CHANNEL_PERIODS)[number];
export const DEFAULT_CHANNEL_PERIOD: ChannelPeriod = 30;

/**
 * One tracked channel.
 *
 * ⚠️ Every metric is nullable ON PURPOSE, and a null is never a zero. YouTube publishes
 * no Spotlight figures, Snapchat publishes no lifetime view counter, and Snapchat
 * withholds the follower count on some profiles entirely. A rendered 0 must always mean
 * "loaded and truly zero" — the documented fabricated-zero class.
 */
export interface ChannelRow {
  id: string;
  handle: string;
  displayName: string;
  profileUrl: string | null;
  status: string;
  /** null = the platform published no follower count for this channel. NEVER 0-for-absent. */
  followers: number | null;
  /** The rounding step applied to `followers`, or null when the figure is exact. */
  followersPrecision: number | null;
  /** Change across the window, or null when unmeasurable OR below the rounding step. */
  followerDelta: number | null;
  /** The span the delta actually covers — often shorter than the window asked for. */
  followerDeltaDays: number | null;
  /** This row's change exceeds its own baseline — a series that jumped between two
   *  different channels, not growth. Shown, but must be visibly marked. Optional so an
   *  older cached response simply renders unmarked rather than crashing. */
  followerDeltaUnreliable?: boolean;
  /** "api" | "scraper" | null (hand-entered). */
  syncSource: string | null;
  lastSyncedAt: string | null;
  /** When we last successfully FETCHED the channel, even if it published no follower count. */
  metricsFetchedAt: string | null;
  metricsError: string | null;
  // ── YouTube ──
  /** LIFETIME views, exact. Never windowed. */
  totalViews: number | null;
  /** Exact lifetime-view growth across the window — the one trustworthy YouTube delta. */
  viewsDelta: number | null;
  viewsDeltaDays: number | null;
  videoCount: number | null;
  // ── Snapchat ──
  /** Summed views of the Spotlight posts that published one. Not a time window. */
  recentViews: number | null;
  recentViewsCovered: number | null;
  recentPostsSeen: number | null;
}

export interface ChannelBoard {
  platform: ChannelPlatform;
  days: number;
  rows: ChannelRow[];
  totals: {
    channels: number;
    /** Summed followers of channels that published one … */
    followers: number | null;
    /** … and how many channels that is, so the total is never mistaken for the estate. */
    followersReported: number;
    /** Channels whose follower count the platform withholds. */
    followersWithheld: number;
    totalViews: number | null;
    /** Channels with a delta spanning the whole window — the like-for-like denominator. */
    withHistory: number;
    /**
     * Period movement of the two summable tiles, summed ONLY over channels whose own
     * delta spans ~the whole window, with the contributing count beside it. null (never
     * 0) when no channel qualifies. ⚠️ All optional: an older cached API response has
     * none of these, and every reader must degrade to "no change line" rather than
     * rendering a confident 0.
     */
    followerDelta?: number | null;
    followerDeltaChannels?: number;
    /** Channels excluded because their movement was below the platform's rounding step. */
    followerDeltaSuppressed?: number;
    /** Channels whose in-window change exceeded their own baseline — a series that jumped
     *  between two different channels, not growth. Disclosed, never silently dropped. */
    followerDeltaExcluded?: number;
    /** ⚠️ The error bar on followerDelta: summed rounding steps of the full-span channels.
     *  The tile must not print a value smaller than this — see the service's note. */
    followerDeltaUncertainty?: number;
    viewsDelta?: number | null;
    viewsDeltaChannels?: number;
  };
  /** Earliest snapshot we hold for this platform, so the UI can say "collecting since". */
  historyFrom: string | null;
  generatedAt: string;
}

export interface RemovedChannel {
  id: string;
  handle: string;
  displayName: string;
  followerCount: number | null;
}

type Envelope<T> = { success: boolean; data: T };

/**
 * ⚠️ The SAME options object shape as use-meta.tsx, deliberately. No `refreshInterval`:
 * these boards are refreshed by a cron on the order of hours, so polling would spend a
 * user's rate-limit budget re-fetching a number that cannot have moved.
 */
const opts = { revalidateOnFocus: false, dedupingInterval: 30_000 } as const;

export function useChannelBoard(platform: ChannelPlatform, days: ChannelPeriod) {
  const { data, error, isLoading, mutate } = useSWR(
    `/admin/channels?platform=${platform}&days=${days}`,
    (url: string) => apiFetch<Envelope<ChannelBoard>>(url).then((r) => r.data),
    opts,
  );
  return { data, error, isLoading, mutate };
}

/**
 * Removed (soft-archived) channels for the restore list.
 *
 * ⚠️ A null SWR key skips the request entirely, so this costs nothing until the section
 * is actually opened — the same reason the page mounts only the visible tab.
 */
export function useRemovedChannels(platform: ChannelPlatform, enabled: boolean) {
  const { data, error, isLoading, mutate } = useSWR(
    enabled ? `/admin/channels/removed?platform=${platform}` : null,
    (url: string) => apiFetch<Envelope<{ rows: RemovedChannel[] }>>(url).then((r) => r.data),
    opts,
  );
  return { data, error, isLoading, mutate };
}

export interface AddedChannel {
  id: string;
  handle: string;
  displayName: string | null;
  profileUrl: string | null;
  followers: number | null;
  /** true when this handle was previously removed and has been restored rather than created. */
  restored: boolean;
}

/**
 * Add a channel. The server resolves the handle LIVE before storing anything, so a typo
 * comes back as a 400 whose `error.message` is a human sentence — surface it verbatim
 * rather than replacing it with a generic "could not add", which throws away the one
 * piece of information that tells the admin what to fix.
 */
export async function addChannel(platform: ChannelPlatform, handle: string) {
  const res = await apiFetch<Envelope<AddedChannel>>("/admin/channels", {
    method: "POST",
    body: JSON.stringify({ platform, handle }),
  });
  return res.data;
}

/** Remove from / restore to the board. A soft flag, never a delete — history is kept. */
export async function setChannelActive(id: string, active: boolean) {
  return apiFetch<Envelope<{ id: string; handle: string; status: string }>>(
    `/admin/channels/${id}`,
    { method: "PATCH", body: JSON.stringify({ active }) },
  );
}
