import useSWR from "swr";
import { apiFetch } from "@/lib/api";

export type SyncState = "LIVE" | "STALE" | "MANUAL";

export interface GrowthAccount {
  accountId: string;
  displayName: string;
  platform: string;
  latest: number | null;
  delta: number | null;
  deltaPct: number | null;
  /** Added when API ships the enriched response */
  syncState?: SyncState;
  lastSyncedAt?: string | null;
  /** Public profile URL for an open-channel link (optional; absent on older API responses) */
  profileUrl?: string | null;
}

export interface TopMover {
  accountId: string;
  displayName: string;
  platform: string;
  delta: number | null;
  deltaPct: number | null;
  /** Public profile URL (http(s), scheme-validated server-side) — optional on older responses */
  profileUrl?: string | null;
}

export interface GrowthOverviewData {
  totalFollowers: number;
  totalDelta: number;
  accountCount: number;
  accounts: GrowthAccount[];
  topMovers: TopMover[];
  /** The window (in days) the delta figures are measured over */
  days?: number;
  /** Per-platform top movers — optional; absent on older API responses */
  topMoversByPlatform?: Record<string, TopMover[]>;
  /** Coverage counts — optional so older API responses don't break */
  liveCount?: number;
  staleCount?: number;
  manualCount?: number;
  liveFollowers?: number;
  staleFollowers?: number;
  manualFollowers?: number;
}

export function useGrowthOverview(days = 30) {
  return useSWR(`/admin/growth?days=${days}`, (url) => apiFetch(url), {
    revalidateOnFocus: false,
    dedupingInterval: 300_000,
  });
}

export function useAccountGrowth(accountId: string | null, days = 30) {
  return useSWR(
    accountId ? `/admin/growth/${accountId}?days=${days}` : null,
    (url) => apiFetch(url),
    { revalidateOnFocus: false, dedupingInterval: 300_000 },
  );
}
