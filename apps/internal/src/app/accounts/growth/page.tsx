"use client";
import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, TrendingUp, TrendingDown, Users, LineChart, Trophy, ExternalLink } from "lucide-react";
import { useGrowthOverview, type SyncState, type GrowthAccount, type TopMover } from "@/lib/hooks/use-growth";
import { usePageTitle } from "@/lib/hooks/use-page-title";

function fmtCompact(n: number | null | undefined): string {
  if (n == null) return "—";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

const WINDOWS = [7, 30, 90];

function pillClass(active: boolean) {
  return `text-[11px] px-2.5 py-0.5 rounded-full border transition-colors ${
    active
      ? "bg-[#1A1A1A] text-white border-[#1A1A1A]"
      : "text-[#7A7A7A] border-[#E8E0D0] hover:border-[#1A1A1A]"
  }`;
}

/** Signed compact delta with directional icon + color. */
function DeltaBadge({ delta, deltaPct }: { delta: number | null | undefined; deltaPct?: number | null }) {
  const d = delta ?? 0;
  const up = d > 0;
  const down = d < 0;
  const color = up ? "text-[#3E9B4F]" : down ? "text-[#D14343]" : "text-[#7A7A7A]";
  const sign = d > 0 ? "+" : "";
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-semibold ${color}`}>
      {up && <TrendingUp className="h-3.5 w-3.5 shrink-0" />}
      {down && <TrendingDown className="h-3.5 w-3.5 shrink-0" />}
      {sign}{fmtCompact(d)}
      {deltaPct != null && (
        <span className="text-[#B0B0B0] font-normal">({sign}{deltaPct}%)</span>
      )}
    </span>
  );
}

/** Returns a short relative time string like "2h ago", "5d ago", "just now". */
function relativeTime(isoString: string | null | undefined): string {
  if (!isoString) return "";
  const diff = Date.now() - new Date(isoString).getTime();
  if (diff < 0) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

/**
 * Small inline badge showing the sync freshness of an account.
 * LIVE  = green  — fetched from the platform within ~2 days
 * STALE = amber  — last sync older than 2 days (or sync failed)
 * MANUAL = grey  — hand-entered or platform with no public API (X, Snapchat, TikTok, etc.)
 */
function SyncBadge({
  state,
  lastSyncedAt,
}: {
  state: SyncState | undefined;
  lastSyncedAt: string | null | undefined;
}) {
  if (!state) return null;

  const ago = relativeTime(lastSyncedAt);

  let dot = "";
  let label = "";
  let titleText = "";
  let cls = "";

  if (state === "LIVE") {
    dot = "bg-[#3E9B4F]";
    label = ago ? `Live · ${ago}` : "Live";
    titleText = "Live — follower count fetched automatically from the platform within ~2 days.";
    cls = "text-[#3E9B4F] border-[#C6E8CB]";
  } else if (state === "STALE") {
    dot = "bg-[#C2861D]";
    label = ago ? `Stale · ${ago}` : "Stale";
    titleText = "Stale — last sync was more than 2 days ago; number may be out of date.";
    cls = "text-[#C2861D] border-[#F3D9A4]";
  } else {
    dot = "bg-[#7A7A7A]";
    label = "Manual";
    titleText = "Manual — this count is entered by hand; the platform has no public follower API (e.g. X / Twitter, Snapchat, TikTok, LinkedIn).";
    cls = "text-[#7A7A7A] border-[#DCDCDC]";
  }

  return (
    <span
      title={titleText}
      className={`inline-flex items-center gap-1 text-[10px] font-medium border rounded-full px-1.5 py-0.5 leading-none whitespace-nowrap ${cls}`}
    >
      <span className={`inline-block h-1.5 w-1.5 rounded-full shrink-0 ${dot}`} />
      {label}
    </span>
  );
}

export default function AccountGrowthPage() {
  usePageTitle("Account Growth");

  const [days, setDays] = useState(30);
  const { data, isLoading } = useGrowthOverview(days);
  const d = (data as any)?.data;

  const totalFollowers: number = d?.totalFollowers ?? 0;
  const totalDelta: number = d?.totalDelta ?? 0;
  const accountCount: number = d?.accountCount ?? 0;
  const accounts: GrowthAccount[] = d?.accounts ?? [];
  const topMovers: TopMover[] = d?.topMovers ?? [];
  // days from API (reflects actual window); fall back to the local pill value then 30
  const apiDays: number = d?.days ?? days ?? 30;
  const topMoversByPlatform: Record<string, TopMover[]> | undefined = d?.topMoversByPlatform;

  // Sort accounts: LIVE → STALE → MANUAL → undefined, then by latest desc within group
  const SYNC_RANK: Record<string, number> = { LIVE: 0, STALE: 1, MANUAL: 2 };
  const sortedAccounts = [...accounts].sort((a, b) => {
    const ra = a.syncState != null ? (SYNC_RANK[a.syncState] ?? 3) : 3;
    const rb = b.syncState != null ? (SYNC_RANK[b.syncState] ?? 3) : 3;
    if (ra !== rb) return ra - rb;
    return (b.latest ?? 0) - (a.latest ?? 0);
  });

  // Coverage counts — only present when API ships the enriched response
  const liveCount: number | undefined = d?.liveCount;
  const staleCount: number | undefined = d?.staleCount;
  const manualCount: number | undefined = d?.manualCount;

  const totalUp = totalDelta > 0;
  const totalDown = totalDelta < 0;

  return (
    <div className="space-y-6 pop-in">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/accounts" className="flex items-center gap-1 text-sm text-[#7A7A7A] hover:text-[#1A1A1A] transition-colors">
          <ArrowLeft className="h-4 w-4" /> Accounts
        </Link>
      </div>

      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h1 className="font-serif text-2xl font-medium text-[#1A1A1A]">Account Growth</h1>
          <p className="text-sm text-[#7A7A7A] mt-0.5">Follower &amp; subscriber growth across all tracked accounts</p>
        </div>
        <div className="flex items-center gap-1.5">
          {WINDOWS.map((w) => (
            <button key={w} onClick={() => setDays(w)} className={pillClass(days === w)}>
              {w}d
            </button>
          ))}
        </div>
      </div>

      {isLoading && !data ? (
        <div className="bg-white rounded-2xl border border-[#E8E0D0] shadow-[0_2px_16px_rgba(0,0,0,0.05)] px-6 py-10 text-center text-sm text-[#B0B0B0]">
          Loading…
        </div>
      ) : accountCount === 0 ? (
        <div className="bg-white rounded-2xl border border-[#E8E0D0] shadow-[0_2px_16px_rgba(0,0,0,0.05)] px-6 py-10 text-center space-y-1">
          <p className="text-sm text-[#7A7A7A]">No follower snapshots yet — counts populate from the hourly sync.</p>
          <p className="text-xs text-[#B0B0B0]">Check back after a couple of sync cycles.</p>
        </div>
      ) : (
        <>
          {/* Stat row */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="bg-white rounded-2xl border border-[#E8E0D0] shadow-[0_2px_16px_rgba(0,0,0,0.05)] p-5 space-y-1">
              <div className="h-7 w-7 rounded-lg bg-[#F0EEFF] flex items-center justify-center">
                <Users className="h-3.5 w-3.5 text-[#5B4BF5]" />
              </div>
              <p className="font-serif text-2xl font-medium text-[#1A1A1A] leading-none pt-1">{fmtCompact(totalFollowers)}</p>
              <p className="text-xs text-[#7A7A7A]">Total Followers</p>
              {liveCount !== undefined && (
                <p className="text-[10px] text-[#7A7A7A] leading-snug">
                  {liveCount} of {accountCount} live-synced
                  {staleCount ? ` · ${staleCount} stale` : ""}
                  {manualCount ? ` · ${manualCount} manual` : ""}
                </p>
              )}
            </div>
            <div className="bg-white rounded-2xl border border-[#E8E0D0] shadow-[0_2px_16px_rgba(0,0,0,0.05)] p-5 space-y-1">
              <div className={`h-7 w-7 rounded-lg flex items-center justify-center ${totalUp ? "bg-[#E8F5EA]" : totalDown ? "bg-[#FBE9E9]" : "bg-[#F2F2F2]"}`}>
                {totalUp
                  ? <TrendingUp className="h-3.5 w-3.5 text-[#3E9B4F]" />
                  : totalDown
                    ? <TrendingDown className="h-3.5 w-3.5 text-[#D14343]" />
                    : <TrendingUp className="h-3.5 w-3.5 text-[#7A7A7A]" />}
              </div>
              <p className={`font-serif text-2xl font-medium leading-none pt-1 ${totalUp ? "text-[#3E9B4F]" : totalDown ? "text-[#D14343]" : "text-[#1A1A1A]"}`}>
                {totalDelta > 0 ? "+" : ""}{fmtCompact(totalDelta)}
              </p>
              <p className="text-xs text-[#7A7A7A]">Net Change · last {apiDays}d</p>
            </div>
            <div className="bg-white rounded-2xl border border-[#E8E0D0] shadow-[0_2px_16px_rgba(0,0,0,0.05)] p-5 space-y-1">
              <div className="h-7 w-7 rounded-lg bg-[#FFF3C4] flex items-center justify-center">
                <LineChart className="h-3.5 w-3.5 text-[#1A1A1A]" />
              </div>
              <p className="font-serif text-2xl font-medium text-[#1A1A1A] leading-none pt-1">{accountCount}</p>
              <p className="text-xs text-[#7A7A7A]">Accounts Tracked</p>
            </div>
          </div>

          {/* Top Movers */}
          {topMovers.length > 0 && (
            <div className="bg-white rounded-2xl border border-[#E8E0D0] shadow-[0_2px_16px_rgba(0,0,0,0.05)]">
              <div className="px-6 py-4 border-b border-[#F0EAD8] flex items-center gap-2">
                <Trophy className="h-4 w-4 text-[#C99A2E]" />
                <h3 className="font-serif text-[#1A1A1A] font-medium">Top Movers</h3>
                <span className="ml-auto text-[10px] text-[#B0B0B0]">last {apiDays}d</span>
              </div>
              <ul className="divide-y divide-[#F5F0E8]">
                {topMovers.map((m: TopMover, i: number) => (
                  <li key={m.accountId} className="px-6 py-3 flex items-center gap-3">
                    <span className="text-xs font-bold text-[#B0B0B0] w-5 text-right shrink-0">{i + 1}</span>
                    <Link href={`/accounts/${m.accountId}`} className="text-sm font-medium text-[#1A1A1A] hover:underline truncate flex-1 min-w-0">
                      {m.displayName}
                    </Link>
                    <span className="text-[10px] text-[#7A7A7A] bg-[rgba(0,0,0,0.05)] rounded-full px-2 py-0.5 shrink-0">{m.platform}</span>
                    <DeltaBadge delta={m.delta} deltaPct={m.deltaPct} />
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Per-platform Top Movers — only rendered when API includes topMoversByPlatform */}
          {topMoversByPlatform && Object.keys(topMoversByPlatform).length > 0 && (
            <div className="bg-white rounded-2xl border border-[#E8E0D0] shadow-[0_2px_16px_rgba(0,0,0,0.05)]">
              <div className="px-6 py-4 border-b border-[#F0EAD8] flex items-center gap-2">
                <Trophy className="h-4 w-4 text-[#C99A2E]" />
                <h3 className="font-serif text-[#1A1A1A] font-medium">Top Movers by Platform</h3>
                <span className="ml-auto text-[10px] text-[#B0B0B0]">last {apiDays}d</span>
              </div>
              <div className="divide-y divide-[#F5F0E8]">
                {Object.entries(topMoversByPlatform).map(([platform, movers]) =>
                  movers.length === 0 ? null : (
                    <div key={platform}>
                      {/* Platform sub-header */}
                      <div className="px-6 py-2 flex items-center gap-2 bg-[#FAFAF8]">
                        <span className="text-[10px] font-medium text-[#7A7A7A] bg-[rgba(0,0,0,0.05)] rounded-full px-2 py-0.5">{platform}</span>
                      </div>
                      <ul className="divide-y divide-[#F5F0E8]">
                        {movers.map((m: TopMover, i: number) => (
                          <li key={m.accountId} className="px-6 py-2.5 flex items-center gap-3">
                            <span className="text-xs font-bold text-[#B0B0B0] w-5 text-right shrink-0">{i + 1}</span>
                            <Link href={`/accounts/${m.accountId}`} className="text-sm font-medium text-[#1A1A1A] hover:underline truncate flex-1 min-w-0">
                              {m.displayName}
                            </Link>
                            <DeltaBadge delta={m.delta} deltaPct={m.deltaPct} />
                          </li>
                        ))}
                      </ul>
                    </div>
                  )
                )}
              </div>
            </div>
          )}

          {/* All Accounts */}
          <div className="bg-white rounded-2xl border border-[#E8E0D0] shadow-[0_2px_16px_rgba(0,0,0,0.05)]">
            <div className="px-6 py-4 border-b border-[#F0EAD8] flex items-center gap-2">
              <h3 className="font-serif text-[#1A1A1A] font-medium">All Accounts</h3>
              <span className="ml-auto text-[10px] text-[#B0B0B0]">{accounts.length} tracked</span>
            </div>
            {/* Column headers */}
            <div className="px-6 py-2 grid grid-cols-[1fr_6rem_5rem_5rem_4rem] gap-3 text-[10px] font-medium text-[#B0B0B0] uppercase tracking-wide border-b border-[#F5F0E8]">
              <span>Account</span>
              <span>Platform</span>
              <span className="text-right">Followers</span>
              <span className="text-right">Δ {apiDays}d</span>
              <span className="text-right">Δ%</span>
            </div>
            <ul className="divide-y divide-[#F5F0E8]">
              {sortedAccounts.map((a: GrowthAccount) => {
                const up = (a.delta ?? 0) > 0;
                const down = (a.delta ?? 0) < 0;
                const color = up ? "text-[#3E9B4F]" : down ? "text-[#D14343]" : "text-[#7A7A7A]";
                const sign = (a.delta ?? 0) > 0 ? "+" : "";
                return (
                  <li key={a.accountId} className="px-6 py-3 grid grid-cols-[1fr_6rem_5rem_5rem_4rem] gap-3 items-center">
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <Link href={`/accounts/${a.accountId}`} className="text-sm font-medium text-[#1A1A1A] hover:underline truncate">
                          {a.displayName}
                        </Link>
                        {a.profileUrl && (
                          <a
                            href={a.profileUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            title="Open channel in a new tab"
                            aria-label={`Open ${a.displayName} channel`}
                            className="shrink-0 text-[#B0B0B0] hover:text-[#5B5BD6] transition-colors"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                        )}
                      </div>
                      <SyncBadge state={a.syncState} lastSyncedAt={a.lastSyncedAt} />
                    </div>
                    <span className="text-[10px] text-[#7A7A7A] bg-[rgba(0,0,0,0.05)] rounded-full px-2 py-0.5 w-fit truncate">{a.platform}</span>
                    <span className="text-xs font-semibold text-[#1A1A1A] text-right">{fmtCompact(a.latest)}</span>
                    <span className={`text-xs font-semibold text-right ${color}`}>{sign}{fmtCompact(a.delta)}</span>
                    <span className={`text-[11px] text-right ${color}`}>
                      {a.deltaPct == null ? "—" : `${sign}${a.deltaPct}%`}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
