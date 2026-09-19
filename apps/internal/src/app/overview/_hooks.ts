"use client";
import useSWR from "swr";
import { apiFetch } from "@/lib/api";
import type { OverviewPayload, OverviewPeriod, TopPostPeriod, TopPostPlatform, TopPostsPayload, WidgetPeriod } from "./_types";

interface Envelope {
  success: boolean;
  data: OverviewPayload;
}

export function useOverview(
  days: OverviewPeriod,
  aud: WidgetPeriod,
  rev: WidgetPeriod,
  vbc: WidgetPeriod,
  trac: WidgetPeriod,
  /** An explicit window that overrides `days`. null = a preset drives the page. */
  range?: { start: string; end: string } | null,
) {
  // ⚠️ The range is part of the SWR key as well as the server's memo key — otherwise two
  // different windows share one cache entry on either side of the wire.
  const rangeQs = range ? `&start=${range.start}&end=${range.end}` : "";
  return useSWR<Envelope>(
    `/admin/overview?days=${days}&aud=${aud}&rev=${rev}&vbc=${vbc}&trac=${trac}${rangeQs}`,
    (url: string) => apiFetch<Envelope>(url),
    {
      // The server memoises for 60 s; polling on the same cadence gives the
      // "live" feel the design asks for without extra load.
      refreshInterval: 60_000,
      revalidateOnFocus: false,
      dedupingInterval: 30_000,
      keepPreviousData: true,
    },
  );
}

interface TopPostsEnvelope {
  success: boolean;
  data: TopPostsPayload;
}

/**
 * Top Posts — its OWN request, deliberately.
 *
 * ⚠️ Keeping this off the main overview payload is what stops a heavier query (it reads
 * link_metrics_latest, a different and larger table than every other widget) from
 * delaying the KPI strip, and stops its 4 periods x 3 platforms from multiplying the
 * server's 60-entry payload cache key. It also gets its own error and loading state, so
 * a Top Posts failure shows on Top Posts and nowhere else.
 *
 * ⚠️ NO refreshInterval. The overview payload polls every 60s because it is the page's
 * live pulse; this card is a ranking over days and re-fetching it on a timer would buy
 * nothing and cost a query per viewer per minute. It revalidates when its own controls
 * change, and on an explicit retry.
 */
export function useTopPosts(platform: TopPostPlatform, days: TopPostPeriod) {
  return useSWR<TopPostsEnvelope>(
    `/admin/overview/top-posts?days=${days}&platform=${platform}`,
    (url: string) => apiFetch<TopPostsEnvelope>(url),
    {
      revalidateOnFocus: false,
      dedupingInterval: 60_000,
      keepPreviousData: true,
    },
  );
}
