"use client";
import useSWR from "swr";
import { apiFetch } from "@/lib/api";
import type { OverviewPayload, OverviewPeriod, WidgetPeriod } from "./_types";

interface Envelope {
  success: boolean;
  data: OverviewPayload;
}

export function useOverview(days: OverviewPeriod, aud: WidgetPeriod, rev: WidgetPeriod, enabled = true) {
  return useSWR<Envelope>(
    enabled ? `/admin/overview?days=${days}&aud=${aud}&rev=${rev}` : null,
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
