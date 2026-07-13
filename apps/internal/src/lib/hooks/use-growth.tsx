import useSWR from "swr";
import { apiFetch } from "@/lib/api";
import { TrendingUp, TrendingDown } from "lucide-react";

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
  /** Portfolio pulse — accounts that grew / declined over the window (optional) */
  gainers?: number;
  decliners?: number;
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

export function fmtCompact(n: number | null | undefined): string {
  if (n == null) return "—";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// Only render a safe http(s) href — never javascript:/data: (profile_url is admin-entered free text).
export function httpUrlOrNull(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Signed compact delta with directional icon + color, using this app's named tokens. */
export function DeltaBadge({ delta, deltaPct }: { delta: number | null | undefined; deltaPct?: number | null }) {
  const d = delta ?? 0;
  const up = d > 0;
  const down = d < 0;
  const color = up ? "text-success" : down ? "text-danger" : "text-ink-4";
  const sign = d > 0 ? "+" : "";
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-semibold ${color}`}>
      {up && <TrendingUp className="h-3 w-3 shrink-0" />}
      {down && <TrendingDown className="h-3 w-3 shrink-0" />}
      {sign}{fmtCompact(d)}
      {deltaPct != null && <span className="text-ink-4 font-normal">({sign}{deltaPct}%)</span>}
    </span>
  );
}
