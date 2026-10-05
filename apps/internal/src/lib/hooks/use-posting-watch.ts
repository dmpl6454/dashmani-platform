"use client";
/**
 * Posting watch — assigned channels whose connected Facebook Page / Instagram account has
 * gone 2h+ without a new post between 07:00 and 23:00 IST.
 * API: GET /admin/meta/posting-watch (apps/api/src/routes/posting-watch.routes.ts).
 */
import useSWR from "swr";
import { apiFetch } from "@/lib/api";

export type PostingWatchGroup = "quiet_today" | "no_post_today" | "inactive" | "cant_check";
export type PostingWatchErrorKind = "token" | "permission" | "not_found" | "rate_limited" | "unreachable" | "meta_error";

export interface PostingWatchPerson {
  id: string;
  name: string;
}

export interface PostingWatchChannel {
  key: string;
  platform: "facebook" | "instagram";
  name: string;
  href: string | null;
  pages: Array<{ metaId: string; name: string; href: string | null }>;
  assignees: PostingWatchPerson[];
  group: PostingWatchGroup;
  lastPostAt: string | null;
  lastPostUrl: string | null;
  silentSince: string | null;
  checkedAt: string | null;
  errorKind: PostingWatchErrorKind | null;
  errorDetail: string | null;
  errorSince: string | null;
}

export interface PostingWatchNotConnected {
  accountId: string;
  platform: "facebook" | "instagram";
  name: string;
  handle: string;
  /** no_page: nothing connected matches it; ambiguous: it matches Pages of several channels. */
  reason: "no_page" | "ambiguous";
  assignees: PostingWatchPerson[];
}

export interface PostingWatchPayload {
  status: "ok" | "off" | "paused" | "unavailable";
  reason: "disabled" | "switched_off" | "schema" | "db" | null;
  /** The server's current time — also on a stale payload. */
  now: string;
  /** When the channel data was read (older than `now` only when stale). */
  asOf: string;
  window: {
    start: string;
    end: string;
    active: boolean;
    nextStart: string;
    startMinute: number;
    endMinute: number;
    timeZone: "Asia/Kolkata";
  };
  thresholdMinutes: number;
  stale: boolean;
  monitor: {
    configured: boolean;
    pausedUntil: string | null;
    lastCheckAt: string | null;
    lastSuccessAt: string | null;
    verifyingSince: string | null;
  };
  counts: {
    monitored: number;
    onSchedule: number;
    verifying: number;
    quiet_today: number;
    no_post_today: number;
    inactive: number;
    cant_check: number;
    not_connected: number;
  };
  channels: PostingWatchChannel[];
  notConnected: PostingWatchNotConnected[];
}

type Envelope = { success: boolean; data: PostingWatchPayload };

/** The envelope plus the moment it arrived, so the card's clock runs from the server's
 *  `now` at that moment rather than from whenever the component happened to render. */
export type PostingWatchResponse = Envelope & { receivedAt: number };

/**
 * `enabled` must be false for non-admins: the endpoint is admin-only.
 *
 * Polls every 60 s to match the server's short memo; polling pauses on hidden tabs (SWR's
 * default). While a request is failing SWR stops polling, so a failure is retried once a
 * minute — never SWR's default exponential loop, and never given up on: a card that
 * stopped retrying would freeze while still saying it is retrying. The last good payload
 * stays on screen meanwhile.
 */
export function usePostingWatch(enabled: boolean) {
  return useSWR<PostingWatchResponse>(
    enabled ? "/admin/meta/posting-watch" : null,
    async (url: string) => ({ ...(await apiFetch<Envelope>(url)), receivedAt: Date.now() }),
    {
      refreshInterval: 60_000,
      revalidateOnFocus: true,
      dedupingInterval: 15_000,
      keepPreviousData: true,
      onErrorRetry: (_err, _key, _config, revalidate, opts) => {
        setTimeout(() => revalidate(opts), 60_000);
      },
    },
  );
}
