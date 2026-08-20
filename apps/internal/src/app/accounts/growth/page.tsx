"use client";
import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, TrendingUp, TrendingDown, Users, LineChart, Trophy, ExternalLink } from "lucide-react";
import {
  useGrowthOverview, fmtCompact, httpUrlOrNull, DeltaBadge,
  type SyncState, type GrowthAccount, type TopMover,
} from "@/lib/hooks/use-growth";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import { MetaPanel } from "./_meta-panel";

// Open-the-real-channel external link. Renders nothing if there's no safe http(s) URL.
// Used in All Accounts + both Top Movers lists. stopPropagation so it doesn't trigger
// any row-level nav.
function ChannelLink({ url, name }: { url: string | null | undefined; name: string }) {
  const safe = httpUrlOrNull(url);
  if (!safe) return null;
  return (
    <a
      href={safe}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      title="Open channel in a new tab"
      aria-label={`Open ${name} channel`}
      className="shrink-0 text-[#B0B0B0] hover:text-[#5B5BD6] transition-colors"
    >
      <ExternalLink className="h-3.5 w-3.5" />
    </a>
  );
}

const WINDOWS = [7, 30, 90];

function pillClass(active: boolean) {
  return `text-[11px] px-2.5 py-0.5 rounded-full border transition-colors ${
    active
      ? "bg-[#1A1A1A] text-white border-[#1A1A1A]"
      : "text-[#7A7A7A] border-[#E8E0D0] hover:border-[#1A1A1A]"
  }`;
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
 * MANUAL = grey  — hand-entered or platform with no public API (X, TikTok, LinkedIn, etc.)
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
    titleText = "Manual — this count is entered by hand; the platform has no public follower API (e.g. X / Twitter, TikTok, LinkedIn).";
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

/**
 * Where the follower number came from — a separate axis from SyncBadge's freshness.
 *
 *   API     = an official platform API (Meta Graph, YouTube Data API). Exact.
 *   Scraper = parsed from the public page. Accurate in practice, but best-effort.
 *   (null)  = never auto-synced; SyncBadge already says "Manual", so we render
 *             nothing rather than stack two greys saying the same thing.
 *
 * Deliberately styled as a soft FILLED chip while SyncBadge is an OUTLINED
 * dot-chip: two pills on one row need different silhouettes, or they read as one
 * control. Neither colour is a warning — a scraper number is not an error.
 */
function SourceBadge({ source }: { source: "api" | "scraper" | null | undefined }) {
  if (source !== "api" && source !== "scraper") return null;

  const isApi = source === "api";
  const label = isApi ? "API" : "Scraper";
  const cls = isApi
    ? "bg-[#EAF0FB] text-[#2F5FAE] border-[#CBDCF5]"
    : "bg-[#F3EEF8] text-[#6B4E9B] border-[#DFD2EC]";
  const titleText = isApi
    ? "API — read directly from the platform's official API (Meta Graph / YouTube Data API). Exact figure."
    : "Scraper — parsed from the account's public page because no API covers it. Accurate in practice, but best-effort and can break if the page changes.";

  return (
    <span
      title={titleText}
      className={`inline-flex items-center text-[10px] font-medium border rounded-full px-1.5 py-0.5 leading-none whitespace-nowrap ${cls}`}
    >
      {label}
    </span>
  );
}

export default function AccountGrowthPage() {
  usePageTitle("Account Growth");

  const [days, setDays] = useState(30);
  const { data, isLoading } = useGrowthOverview(days);
  const d = (data as any)?.data;

  // ── All-Accounts list controls (client-side; data already fetched) ──────────
  const [search, setSearch] = useState("");
  const [platformFilter, setPlatformFilter] = useState<string>("all");
  // Sort options for the All Accounts table.
  const [sortBy, setSortBy] = useState<"sync" | "followers" | "delta" | "deltaPct" | "name">("sync");

  const totalFollowers: number = d?.totalFollowers ?? 0;
  const totalDelta: number = d?.totalDelta ?? 0;
  const accountCount: number = d?.accountCount ?? 0;
  const accounts: GrowthAccount[] = d?.accounts ?? [];
  const topMovers: TopMover[] = d?.topMovers ?? [];
  // days from API (reflects actual window); fall back to the local pill value then 30
  const apiDays: number = d?.days ?? days ?? 30;
  const topMoversByPlatform: Record<string, TopMover[]> | undefined = d?.topMoversByPlatform;

  // Platforms present in the data (for the filter dropdown).
  const platformOptions = Array.from(new Set(accounts.map((a) => a.platform))).sort();

  // Filter (search + platform) then sort the All Accounts list. All client-side over
  // the already-fetched accounts — no extra requests.
  const SYNC_RANK: Record<string, number> = { LIVE: 0, STALE: 1, MANUAL: 2 };
  const q = search.trim().toLowerCase();
  const filteredAccounts = accounts.filter((a) => {
    if (platformFilter !== "all" && a.platform !== platformFilter) return false;
    if (q && !a.displayName.toLowerCase().includes(q)) return false;
    return true;
  });
  const sortedAccounts = [...filteredAccounts].sort((a, b) => {
    switch (sortBy) {
      case "followers":
        return (b.latest ?? 0) - (a.latest ?? 0);
      case "delta":
        return (b.delta ?? 0) - (a.delta ?? 0);
      case "deltaPct":
        return (b.deltaPct ?? 0) - (a.deltaPct ?? 0);
      case "name":
        return a.displayName.localeCompare(b.displayName);
      case "sync":
      default: {
        // LIVE → STALE → MANUAL → undefined, then by latest desc within group.
        const ra = a.syncState != null ? (SYNC_RANK[a.syncState] ?? 3) : 3;
        const rb = b.syncState != null ? (SYNC_RANK[b.syncState] ?? 3) : 3;
        if (ra !== rb) return ra - rb;
        return (b.latest ?? 0) - (a.latest ?? 0);
      }
    }
  });

  // Coverage counts — only present when API ships the enriched response
  const liveCount: number | undefined = d?.liveCount;
  const staleCount: number | undefined = d?.staleCount;
  // Undefined (not 0) when the API predates these fields, so an older response
  // renders the card exactly as before instead of claiming "0 API".
  const baselineFollowers: number | undefined = d?.baselineFollowers;
  const apiSourceCount: number | undefined = d?.apiSourceCount;
  const scraperSourceCount: number | undefined = d?.scraperSourceCount;
  const manualSourceCount: number | undefined = d?.manualSourceCount;
  const manualCount: number | undefined = d?.manualCount;
  const gainers: number | undefined = d?.gainers;
  const decliners: number | undefined = d?.decliners;

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
          <p className="text-xs text-[#B0B0B0] mt-1 max-w-2xl leading-snug">
            Counts refresh automatically <span className="font-medium text-[#7A7A7A]">every hour</span>.
            <span className="text-[#3E9B4F] font-medium"> Live</span> = synced within the last 48h ·
            <span className="text-[#C2861D] font-medium"> Stale</span> = synced longer ago (number may be out of date) ·
            <span className="text-[#7A7A7A] font-medium"> Manual</span> = entered by hand / no public API to sync from.
          </p>
          <p className="text-xs text-[#B0B0B0] mt-1 max-w-2xl leading-snug">
            The second pill says <span className="font-medium text-[#7A7A7A]">where the number came from</span>:
            <span className="text-[#2F5FAE] font-medium"> API</span> = read from the platform&apos;s official API (exact) ·
            <span className="text-[#6B4E9B] font-medium"> Scraper</span> = parsed from the public page because no API covers that account (accurate in practice, best-effort).
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {WINDOWS.map((w) => (
            <button key={w} onClick={() => setDays(w)} className={pillClass(days === w)}>
              {w}d
            </button>
          ))}
          {/* Custom day-range: type N days; clamped 1–365. Highlighted when active (not a preset). */}
          <div className={`flex items-center gap-1 rounded-full border px-2 py-1 ${!WINDOWS.includes(days) ? "border-[#1A1A1A] bg-[#1A1A1A] text-white" : "border-[#E8E0D0] text-[#7A7A7A]"}`}>
            <input
              type="number"
              min={1}
              max={365}
              value={days}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10);
                if (Number.isFinite(n)) setDays(Math.max(1, Math.min(365, n)));
              }}
              aria-label="Custom day range"
              className="w-10 bg-transparent text-[11px] text-center outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
            />
            <span className="text-[11px]">d</span>
          </div>
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
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="bg-white rounded-2xl border border-[#E8E0D0] shadow-[0_2px_16px_rgba(0,0,0,0.05)] p-5 space-y-1">
              <div className="h-7 w-7 rounded-lg bg-[#F0EEFF] flex items-center justify-center">
                <Users className="h-3.5 w-3.5 text-[#5B4BF5]" />
              </div>
              <p className="font-num text-2xl font-semibold text-[#1A1A1A] leading-none pt-1">{fmtCompact(totalFollowers)}</p>
              {/* The big number is CURRENT (window-invariant by definition — how many
                  followers we have is not a function of the chosen window). The
                  window is made visible by the "was X · N days ago" line below it,
                  so the card demonstrably responds to the filter instead of looking
                  frozen. */}
              <p className="text-xs text-[#7A7A7A]" title="Sum of every tracked account's most recent follower count — a current total. The 7d/30d/90d filter drives the 'was …' comparison below, plus Net Change, Gainers/Decliners and Top Movers.">
                Total Followers <span className="text-[#B0B0B0]">(current)</span>
              </p>
              {baselineFollowers !== undefined && baselineFollowers > 0 && (
                <p className="text-[10px] text-[#7A7A7A] leading-snug">
                  was {fmtCompact(baselineFollowers)} · {days}d ago
                  {totalFollowers !== baselineFollowers && (
                    <span className={totalFollowers > baselineFollowers ? "text-[#3E9B4F]" : "text-[#C0504D]"}>
                      {" "}({totalFollowers > baselineFollowers ? "+" : ""}
                      {fmtCompact(totalFollowers - baselineFollowers)})
                    </span>
                  )}
                </p>
              )}
              {liveCount !== undefined && (
                <p className="text-[10px] text-[#7A7A7A] leading-snug">
                  {liveCount} of {accountCount} live-synced
                  {staleCount ? ` · ${staleCount} stale` : ""}
                  {manualCount ? ` · ${manualCount} manual` : ""}
                </p>
              )}
              {apiSourceCount !== undefined && (
                <p className="text-[10px] text-[#B0B0B0] leading-snug">
                  Source: {apiSourceCount} API
                  {scraperSourceCount ? ` · ${scraperSourceCount} scraper` : ""}
                  {manualSourceCount ? ` · ${manualSourceCount} manual` : ""}
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
              <p className={`font-num text-2xl font-semibold leading-none pt-1 ${totalUp ? "text-[#3E9B4F]" : totalDown ? "text-[#D14343]" : "text-[#1A1A1A]"}`}>
                {totalDelta > 0 ? "+" : ""}{fmtCompact(totalDelta)}
              </p>
              <p className="text-xs text-[#7A7A7A]">Net Change · last {apiDays}d</p>
            </div>
            <div className="bg-white rounded-2xl border border-[#E8E0D0] shadow-[0_2px_16px_rgba(0,0,0,0.05)] p-5 space-y-1">
              <div className="h-7 w-7 rounded-lg bg-[#FFF3C4] flex items-center justify-center">
                <LineChart className="h-3.5 w-3.5 text-[#1A1A1A]" />
              </div>
              <p className="font-num text-2xl font-semibold text-[#1A1A1A] leading-none pt-1">{accountCount}</p>
              <p className="text-xs text-[#7A7A7A]">Accounts Tracked</p>
            </div>
            {/* Portfolio pulse: gainers vs decliners over the window */}
            {(gainers !== undefined || decliners !== undefined) && (
              <div className="bg-white rounded-2xl border border-[#E8E0D0] shadow-[0_2px_16px_rgba(0,0,0,0.05)] p-5 space-y-1">
                <div className="h-7 w-7 rounded-lg bg-[#E8F5EA] flex items-center justify-center">
                  <TrendingUp className="h-3.5 w-3.5 text-[#3E9B4F]" />
                </div>
                <p className="font-num text-2xl font-semibold leading-none pt-1">
                  <span className="text-[#3E9B4F]">{gainers ?? 0}</span>
                  <span className="text-[#B0B0B0] text-lg"> / </span>
                  <span className="text-[#D14343]">{decliners ?? 0}</span>
                </p>
                <p className="text-xs text-[#7A7A7A]">Gainers / Decliners · last {apiDays}d</p>
                <p className="text-[11px] text-[#9A9A9A] leading-snug">
                  Accounts that grew vs shrank over the window. The rest of the {accountCount} tracked
                  were flat or have no comparable history yet (manual / single snapshot).
                </p>
              </div>
            )}
          </div>

          {/* Facebook & Instagram, read through an admin's own Meta OAuth grant.
              Placed ABOVE Top Movers because it is now the authoritative source for
              Meta numbers; the follower-growth blocks below still cover YouTube,
              Snapchat and X, whose pipelines are unchanged by this work. */}
          <MetaPanel />

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
                    <ChannelLink url={m.profileUrl} name={m.displayName} />
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
                            <ChannelLink url={m.profileUrl} name={m.displayName} />
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
            <div className="px-6 py-4 border-b border-[#F0EAD8] flex items-center gap-2 flex-wrap">
              <h3 className="font-serif text-[#1A1A1A] font-medium">All Accounts</h3>
              <span className="text-[10px] text-[#B0B0B0]">
                {sortedAccounts.length === accounts.length
                  ? `${accounts.length} tracked`
                  : `${sortedAccounts.length} of ${accounts.length}`}
              </span>
              {/* Controls: search · platform filter · sort */}
              <div className="ml-auto flex items-center gap-2 flex-wrap">
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search channel…"
                  className="h-8 w-44 rounded-lg border border-[#E8E0D0] bg-[#FAFAF8] px-3 text-xs text-[#1A1A1A] placeholder:text-[#B0B0B0] focus:outline-none focus:border-[#1A1A1A]"
                />
                <select
                  value={platformFilter}
                  onChange={(e) => setPlatformFilter(e.target.value)}
                  aria-label="Filter by platform"
                  className="h-8 rounded-lg border border-[#E8E0D0] bg-[#FAFAF8] px-2 text-xs text-[#1A1A1A] focus:outline-none focus:border-[#1A1A1A]"
                >
                  <option value="all">All platforms</option>
                  {platformOptions.map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
                  aria-label="Sort by"
                  className="h-8 rounded-lg border border-[#E8E0D0] bg-[#FAFAF8] px-2 text-xs text-[#1A1A1A] focus:outline-none focus:border-[#1A1A1A]"
                >
                  <option value="sync">Sort: Freshness</option>
                  <option value="followers">Sort: Followers</option>
                  <option value="delta">Sort: Δ change</option>
                  <option value="deltaPct">Sort: Δ %</option>
                  <option value="name">Sort: Name (A–Z)</option>
                </select>
              </div>
            </div>
            {/* Column headers — hidden on phones where rows wrap to two lines */}
            <div className="hidden sm:grid px-6 py-2 grid-cols-[1fr_6rem_5rem_5rem_4rem] gap-3 text-[10px] font-medium text-[#B0B0B0] uppercase tracking-wide border-b border-[#F5F0E8]">
              <span>Account</span>
              <span>Platform</span>
              <span className="text-right">Followers</span>
              <span className="text-right">Δ {apiDays}d</span>
              <span className="text-right">Δ%</span>
            </div>
            <ul className="divide-y divide-[#F5F0E8]">
              {sortedAccounts.length === 0 && (
                <li className="px-6 py-8 text-center text-xs text-[#B0B0B0]">
                  No channels match {search.trim() ? `“${search.trim()}”` : "this filter"}.
                </li>
              )}
              {sortedAccounts.map((a: GrowthAccount) => {
                const up = (a.delta ?? 0) > 0;
                const down = (a.delta ?? 0) < 0;
                const color = up ? "text-[#3E9B4F]" : down ? "text-[#D14343]" : "text-[#7A7A7A]";
                const sign = (a.delta ?? 0) > 0 ? "+" : "";
                return (
                  /* phones: account on line 1, platform + numbers on line 2; sm+: original grid */
                  <li key={a.accountId} className="px-4 sm:px-6 py-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 sm:grid sm:grid-cols-[1fr_6rem_5rem_5rem_4rem] sm:gap-3">
                    <div className="min-w-0 space-y-0.5 basis-full sm:basis-auto">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <Link href={`/accounts/${a.accountId}`} className="text-sm font-medium text-[#1A1A1A] hover:underline truncate">
                          {a.displayName}
                        </Link>
                        <ChannelLink url={a.profileUrl} name={a.displayName} />
                      </div>
                      {/* Both pills live INSIDE the existing name cell — this <li>
                          is a fixed-track sm:grid, so a bare extra child would
                          shift every following cell one track right (PR #130). */}
                      <div className="flex flex-wrap items-center gap-1">
                        <SyncBadge state={a.syncState} lastSyncedAt={a.lastSyncedAt} />
                        <SourceBadge source={a.syncSource} />
                      </div>
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
