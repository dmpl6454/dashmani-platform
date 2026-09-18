"use client";
import useSWR from "swr";
import { apiFetch } from "@/lib/api";
import type { OverviewPayload, OverviewPeriod, WidgetPeriod } from "./_types";

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
