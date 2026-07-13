"use client";
import Link from "next/link";
import useSWR from "swr";
import { useAuth } from "@/lib/auth";
import { apiFetch } from "@/lib/api";
import { useOverviewStats } from "@/lib/hooks/use-analytics";
import { useGrowthOverview, fmtCompact, httpUrlOrNull, DeltaBadge, type TopMover } from "@/lib/hooks/use-growth";
import { useLinksAnalytics, useTopLinks, usePlatformLeaderboards } from "@/lib/hooks/use-reports";
import {
  Users, Building2, Clock, CheckCircle, FolderOpen, FileCheck, Send,
  UserPlus, ArrowRight, Link2, Calendar, BarChart2, CalendarDays, X,
  Share2, Globe, ChevronDown, ExternalLink, Trophy, Eye,
} from "lucide-react";
import { useState } from "react";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";
import { Pill, PillGroup } from "./_pills";

// Each card links to the page that is the source of truth for the count it shows,
// so clicking "Pending: 5" lands on the page that actually displays those 5 items.
const statStrip: { key: string; label: string; icon: any; href: string }[] = [
  { key: "totalUsersCount",            label: "Employees",        icon: Users,        href: "/employees" },
  { key: "activeTeams",             label: "Teams",            icon: Building2,    href: "/teams" },
  { key: "pendingApprovals",        label: "Pending",          icon: FileCheck,    href: "/approvals" },
  { key: "linksToday",              label: "Links Today",      icon: Link2,        href: "/reports" },
  { key: "linksThisMonth",          label: "Links / Month",    icon: Calendar,     href: "/reports/links" },
  { key: "submittedTodayCount",     label: "Submitted Today",  icon: BarChart2,    href: "/reports" },
];

// Lower-signal counts — collapsed under "More metrics" by default.
const moreStats: { key: string; label: string; icon: any; href: string }[] = [
  { key: "pendingEmployees",        label: "New Joiners",      icon: UserPlus,     href: "/employees/pending" },
  { key: "contentPublishedThisMonth", label: "Published",      icon: Send,         href: "/content?status=PUBLISHED" },
  { key: "activeProjects",          label: "Projects",         icon: FolderOpen,   href: "/projects?status=ACTIVE" },
  { key: "tasksCompletedThisMonth", label: "Tasks Done",       icon: CheckCircle,  href: "/tasks" },
  { key: "presentToday",            label: "Present",          icon: Clock,        href: "/attendance" },
];

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-ink text-white text-xs rounded-lg px-3 py-2 shadow-lg">
      <p className="font-semibold mb-0.5">{label}</p>
      <p>{payload[0].value} link{payload[0].value !== 1 ? "s" : ""}</p>
    </div>
  );
}

const LINK_QUICK_RANGES = [
  { label: "14d",  days: 14 },
  { label: "30d",  days: 30 },
  { label: "90d",  days: 90 },
];

function toISO(d: Date) {
  // Use local date parts (browser IST) — not toISOString() which returns UTC
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

export default function DashboardPage() {
  usePageTitle("Dashboard");
  const { user } = useAuth();
  const firstName = user?.name?.split(" ")[0] || "";
  const today = new Date();

  // Links bento date range — default last 14 days
  const defaultStart = toISO(new Date(today.getTime() - 13 * 86400000));
  const defaultEnd = toISO(today);
  const [linkStart, setLinkStart] = useState(defaultStart);
  const [linkEnd, setLinkEnd] = useState(defaultEnd);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [moreMetricsOpen, setMoreMetricsOpen] = useState(false);

  const isCustomRange = linkStart !== defaultStart || linkEnd !== defaultEnd;
  const { data, isLoading } = useOverviewStats(linkStart, linkEnd, isCustomRange);
  const stats = (data as any)?.data || {};
  const pendingEmployees = stats?.pendingEmployees ?? 0;

  // Account Growth + Top Movers share a window pill (growthDays, re-fetches via
  // useGrowthOverview). Top Movers additionally has its own platform pill
  // (growthPlatform, a client-side filter of the same payload) that Account Growth
  // does not have. Both pills are independent, non-persisted.
  const GROWTH_WINDOWS = [
    { key: 7, label: "7d" },
    { key: 30, label: "30d" },
    { key: 90, label: "90d" },
  ];
  const [growthDays, setGrowthDays] = useState(30);
  const [growthPlatform, setGrowthPlatform] = useState("all"); // "all" | platform key
  const { data: growthData, isLoading: growthLoading } = useGrowthOverview(growthDays);
  const g = (growthData as any)?.data;
  const growthAccountCount: number = g?.accountCount ?? 0;
  const topMovers: TopMover[] = g?.topMovers ?? [];
  const topMoversByPlatform: Record<string, TopMover[]> = g?.topMoversByPlatform ?? {};

  // Platform options come from the payload's per-platform mover buckets (falls back to none).
  const growthPlatformOptions = Object.keys(topMoversByPlatform);

  // The mover list respects the platform pill: "all" uses combined topMovers,
  // a specific platform uses that bucket. Both are already abs(delta)-sorted server-side.
  const sortedTopMovers = (
    growthPlatform === "all" ? topMovers : (topMoversByPlatform[growthPlatform] ?? [])
  )
    .slice()
    .sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0))
    .slice(0, 5);

  const growthLive: number | undefined = g?.liveCount;
  const growthStale: number | undefined = g?.staleCount;
  const growthManual: number | undefined = g?.manualCount;

  // Per-platform follower split — summed client-side from accounts already in the payload
  // (each carries { platform, latest }). Pure arithmetic, no new fetch/query. Sorted desc.
  // `latest` is the account's current follower count; null-guarded to 0.
  const growthAccounts: { platform: string; latest: number | null }[] = g?.accounts ?? [];
  const growthByPlatform = (() => {
    const map = new Map<string, number>();
    for (const a of growthAccounts) {
      map.set(a.platform, (map.get(a.platform) ?? 0) + (a.latest ?? 0));
    }
    return [...map.entries()]
      .map(([platform, followers]) => ({ platform, followers }))
      .sort((x, y) => y.followers - x.followers);
  })();
  const growthByPlatformMax = growthByPlatform[0]?.followers ?? 0;

  // Top Performers + Top Links — fixed 30-day window (compact glance cards).
  const perfEnd = toISO(today);
  const perfStart = toISO(new Date(today.getTime() - 29 * 86400000));
  const { data: linksAnalyticsData, isLoading: topPerformersLoading } = useLinksAnalytics(perfStart, perfEnd);
  const topSubmitters: { employeeId: string; name: string; totalLinks: number; reportCount: number }[] =
    (linksAnalyticsData as any)?.data?.topSubmitters ?? [];

  // Top Performers metric pill — independent, non-persisted. Links & Engagement come from
  // the leaderboard/analytics payloads; the three platform tabs rank the SAME fair way as
  // /reports/leaderboard (YouTube/Facebook by views, Instagram by likes+comments).
  const PERF_METRICS = [
    { key: "links", label: "Links" },
    { key: "engagement", label: "Engagement" },
    { key: "youtube", label: "YouTube" },
    { key: "facebook", label: "Facebook" },
    { key: "instagram", label: "Instagram" },
  ];
  const [perfMetric, setPerfMetric] = useState("links");
  const { data: leaderboardData } = useSWR(
    `/admin/reports/leaderboard?startDate=${perfStart}&endDate=${perfEnd}`,
    (url: string) => apiFetch<any>(url),
    { revalidateOnFocus: false, dedupingInterval: 300_000 }
  );
  const leaderboardRows: any[] = (leaderboardData as any)?.data ?? [];

  // Per-platform boards (fetched once, cached 5 min). Keyed youtube/facebook/instagram.
  const { data: platformLbData } = usePlatformLeaderboards(perfStart, perfEnd);
  const platformBoards: Record<string, any[]> = (platformLbData as any)?.data ?? {};

  // Build the top-3 list for the selected metric. Each row normalizes to
  // { employeeId, name, primary (big colored number), secondary (grey badge) }.
  const topPerformers = (() => {
    if (perfMetric === "engagement") {
      return [...leaderboardRows]
        .sort((a, b) => (b.totalEngagement ?? 0) - (a.totalEngagement ?? 0))
        .slice(0, 3)
        .map((r) => ({
          employeeId: r.employee?.id ?? r.employeeId,
          name: r.employee?.name ?? r.name ?? "—",
          primary: `${fmtCompact(r.totalEngagement ?? 0)} eng`,
          secondary: `${r.totalLinks ?? 0} links`,
        }));
    }
    // Per-platform board (youtube | facebook | instagram): already ranked server-side.
    if (perfMetric === "youtube" || perfMetric === "facebook" || perfMetric === "instagram") {
      const board = platformBoards[perfMetric] ?? [];
      const isViews = perfMetric !== "instagram"; // YT/FB rank by views; IG by likes+comments
      return board.slice(0, 3).map((r: any) => ({
        employeeId: r.employee?.id ?? "—",
        name: r.employee?.name ?? "—",
        primary: isViews
          ? `${fmtCompact(r.views ?? 0)} views`
          : `${fmtCompact((r.likes ?? 0) + (r.comments ?? 0))} eng`,
        secondary: `${r.engagedLinkCount ?? 0} link${(r.engagedLinkCount ?? 0) !== 1 ? "s" : ""}`,
      }));
    }
    // links (default)
    return [...topSubmitters]
      .sort((a, b) => b.totalLinks - a.totalLinks)
      .slice(0, 3)
      .map((p) => ({
        employeeId: p.employeeId,
        name: p.name,
        primary: `${p.totalLinks} links`,
        secondary: `${p.reportCount} report${p.reportCount !== 1 ? "s" : ""}`,
      }));
  })();

  // Top Links platform pill — independent, non-persisted. YouTube ranks by views;
  // Instagram/Facebook rank by likes+comments (backend does this automatically).
  const TOP_LINK_PLATFORMS = [
    { key: "youtube", label: "YouTube", metric: "views" as const },
    { key: "instagram", label: "Instagram", metric: "engagement" as const },
    { key: "facebook", label: "Facebook", metric: "engagement" as const },
  ];
  const [topLinkPlatform, setTopLinkPlatform] = useState("youtube");
  const activeLinkPlatform = TOP_LINK_PLATFORMS.find((p) => p.key === topLinkPlatform) ?? TOP_LINK_PLATFORMS[0];
  const { data: topLinksData, isLoading: topLinksLoading } = useTopLinks(topLinkPlatform, perfStart, perfEnd, 3);
  const topLinksRows: {
    linkId: string | null; url: string; employeeName: string;
    views: number | null; likes: number | null; comments: number | null;
  }[] = (topLinksData as any)?.data ?? [];

  const linksTrend: { date: string; count: number }[] = stats.linksTrend ?? [];
  const trendData = linksTrend.map((d) => ({
    date: new Date(d.date).toLocaleDateString("en-IN", { day: "numeric", month: "short" }),
    links: d.count,
  }));

  // Second, deliberate useLinksAnalytics call — Links Activity's OWN date-range picker
  // (linkStart/linkEnd), NOT the fixed 30-day Top Performers window above (perfStart/perfEnd).
  // Do not consolidate — these are genuinely different ranges, SWR keys them independently.
  const { data: linkActivityAnalytics } = useLinksAnalytics(linkStart, linkEnd);
  const linksPlatformBreakdown: { platform: string; count: number }[] =
    (linkActivityAnalytics as any)?.data?.platformBreakdown ?? [];

  const totalEmployees = stats.totalUsersCount ?? 0;
  const submittedToday = stats.submittedTodayCount ?? 0;
  const submissionRate = stats.submissionRateToday ?? 0;

  function applyQuickRange(days: number) {
    setLinkStart(toISO(new Date(today.getTime() - (days - 1) * 86400000)));
    setLinkEnd(toISO(today));
  }

  const rangeLabel = !isCustomRange
    ? "Last 14 days"
    : `${new Date(linkStart).toLocaleDateString("en-IN", { day: "numeric", month: "short" })} – ${new Date(linkEnd).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`;

  function renderStatCard({ key, label, icon: Icon, href }: typeof statStrip[number], i: number) {
    const value = stats[key];
    const isPending = key === "pendingApprovals" || key === "pendingEmployees";
    const isLinks = key === "linksToday" || key === "linksThisMonth" || key === "submittedTodayCount";
    let subtitle: string | null = null;
    if (key === "submittedTodayCount") subtitle = `${submissionRate}% rate`;
    if (key === "pendingApprovals" && !isLoading) {
      const docs = stats.pendingDocuments ?? 0;
      const pics = stats.pendingProfilePictures ?? 0;
      const leaves = stats.pendingLeaveRequests ?? 0;
      const parts: string[] = [];
      if (docs)   parts.push(`${docs} doc${docs !== 1 ? "s" : ""}`);
      if (pics)   parts.push(`${pics} pic${pics !== 1 ? "s" : ""}`);
      if (leaves) parts.push(`${leaves} leave`);
      subtitle = parts.join(" · ") || null;
    }
    return (
      <Link
        key={key}
        href={href}
        className="v3-card-sm p-3 flex flex-col gap-1 v3-card-lift"
        style={{ animationDelay: `${i * 0.04}s` }}
      >
        <div className={`h-7 w-7 rounded-lg flex items-center justify-center ${
          isPending ? "bg-attention/10" : isLinks ? "bg-terra-soft" : "bg-indigo-soft"
        }`}>
          <Icon className={`h-3.5 w-3.5 ${
            isPending ? "text-attention" : isLinks ? "text-terra" : "text-indigo"
          }`} />
        </div>
        <p className="font-num text-xl font-semibold text-ink leading-none">
          {isLoading ? "—" : (value ?? 0)}
        </p>
        <p className="text-[10px] text-ink-4 font-medium leading-tight">{label}</p>
        {subtitle && !isLoading && (
          <p className={`text-[10px] font-semibold leading-tight ${isPending ? "text-attention" : "text-terra"}`}>{subtitle}</p>
        )}
      </Link>
    );
  }

  return (
    <div className="space-y-5 pop-in">
      {/* Page header */}
      <div>
        <p className="text-xs font-bold text-ink-4 uppercase tracking-widest mb-1">Management Portal</p>
        <h1 className="font-display text-3xl font-semibold text-ink leading-tight">
          Hello, {firstName} 👋
        </h1>
        <p className="text-sm text-ink-3 mt-0.5">Here's your organisation overview</p>
      </div>

      {/* Stat strip — promoted cards, always visible. Each card links to the page
          that is the source of truth for its count. */}
      <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-3 fade-up d2">
        {statStrip.map((card, i) => renderStatCard(card, i))}
      </div>

      {/* Bento grid */}
      <div className="bento grid-cols-1 lg:grid-cols-3 fade-up d3">

        {/* Quick nav cards */}
        <Link href="/employees" className="v3-card-sm p-5 flex items-center gap-4 v3-card-lift group">
          <div className="h-12 w-12 rounded-xl border-2 border-ink/12 bg-indigo-soft flex items-center justify-center">
            <Users className="h-6 w-6 text-indigo" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-bold text-ink">{isLoading ? "—" : (stats.totalUsersCount ?? 0)}</p>
            <p className="text-xs text-ink-4">Employees</p>
          </div>
          <ArrowRight className="h-4 w-4 text-ink-4 opacity-0 group-hover:opacity-100 transition-opacity" />
        </Link>

        {/* Accounts hub card */}
        <Link href="/accounts" className="v3-card-sm p-5 flex items-center gap-4 v3-card-lift group">
          <div className="h-12 w-12 rounded-xl border-2 border-ink/12 bg-indigo-soft flex items-center justify-center shrink-0">
            <Globe className="h-6 w-6 text-indigo" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-bold text-ink">Manage Accounts</p>
            <p className="text-xs text-ink-4">View, create & assign social accounts</p>
          </div>
          <ArrowRight className="h-4 w-4 text-ink-4 opacity-0 group-hover:opacity-100 transition-opacity" />
        </Link>

        {/* Assign Account shortcut */}
        <Link href="/accounts?tab=by-employee" className="v3-card-sm p-5 flex items-center gap-4 v3-card-lift group">
          <div className="h-12 w-12 rounded-xl border-2 border-ink/12 bg-sage-soft flex items-center justify-center shrink-0">
            <Share2 className="h-6 w-6 text-sage" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-bold text-ink">Assign Account</p>
            <p className="text-xs text-ink-4">Assign by employee — see who has what</p>
          </div>
          <ArrowRight className="h-4 w-4 text-ink-4 opacity-0 group-hover:opacity-100 transition-opacity" />
        </Link>

        {/* Pending employees alert */}
        {!isLoading && pendingEmployees > 0 && (
          <div className="lg:col-span-3 v3-card p-4 flex flex-wrap items-center justify-between gap-4 bg-attention/5 v3-card-lift">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-xl bg-attention/10 flex items-center justify-center">
                <UserPlus className="h-5 w-5 text-attention" />
              </div>
              <div>
                <p className="font-bold text-ink">
                  {pendingEmployees} employee{pendingEmployees !== 1 ? "s" : ""} awaiting approval
                </p>
                <p className="text-xs text-ink-4">Review and approve new team members</p>
              </div>
            </div>
            <Link
              href="/employees/pending"
              className="flex items-center gap-1.5 px-4 py-2 rounded-full bg-ink text-white text-sm font-bold btn-3d hover:bg-ink-2 transition-colors"
            >
              Review <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        )}

        {/* Links Activity bento — full width */}
        <div className="lg:col-span-3 v3-card p-5 space-y-4 v3-card-lift">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-xl bg-terra-soft flex items-center justify-center">
                <Link2 className="h-5 w-5 text-terra" />
              </div>
              <div>
                <p className="font-bold text-ink">Links Activity</p>
                <p className="text-xs text-ink-4">{rangeLabel}</p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
              {/* Quick range pills */}
              {LINK_QUICK_RANGES.map((r) => {
                const rStart = toISO(new Date(today.getTime() - (r.days - 1) * 86400000));
                const isActive = linkStart === rStart && linkEnd === toISO(today);
                return (
                  <button
                    key={r.label}
                    onClick={() => { applyQuickRange(r.days); setShowDatePicker(false); }}
                    className={`h-7 px-3 rounded-full text-xs font-semibold transition-all border-2 ${
                      isActive
                        ? "bg-terra text-white border-terra"
                        : "bg-surface text-ink-4 border-ink/12 hover:border-terra/30 hover:text-terra"
                    }`}
                  >
                    {r.label}
                  </button>
                );
              })}
              {/* Custom date range toggle */}
              <button
                onClick={() => setShowDatePicker((v) => !v)}
                className={`h-7 px-3 rounded-full text-xs font-semibold transition-all border-2 flex items-center gap-1.5 ${
                  showDatePicker
                    ? "bg-ink text-white border-ink"
                    : "bg-surface text-ink-4 border-ink/12 hover:border-ink/25 hover:text-ink"
                }`}
              >
                <CalendarDays className="h-3 w-3" /> Custom
              </button>
              {isCustomRange && (
                <button
                  onClick={() => { applyQuickRange(14); setShowDatePicker(false); }}
                  className="h-7 w-7 flex items-center justify-center rounded-full bg-surface text-ink-4 hover:text-danger border-2 border-ink/12 hover:border-danger/30 transition-colors"
                  title="Reset range"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          </div>

          {/* Custom date inputs — shown when toggled */}
          {showDatePicker && (
            <div className="flex items-center gap-3 flex-wrap p-3 bg-muted/50 rounded-xl">
              <div className="flex items-center gap-2">
                <label className="text-xs text-ink-4 font-medium">From</label>
                <input
                  type="date"
                  value={linkStart}
                  max={linkEnd}
                  onChange={(e) => setLinkStart(e.target.value)}
                  className="h-8 rounded-lg border-2 border-ink/15 bg-white text-xs px-2 focus:outline-none focus:border-indigo transition-colors"
                />
              </div>
              <div className="flex items-center gap-2">
                <label className="text-xs text-ink-4 font-medium">To</label>
                <input
                  type="date"
                  value={linkEnd}
                  min={linkStart}
                  max={toISO(today)}
                  onChange={(e) => setLinkEnd(e.target.value)}
                  className="h-8 rounded-lg border-2 border-ink/15 bg-white text-xs px-2 focus:outline-none focus:border-indigo transition-colors"
                />
              </div>
              <button
                onClick={() => setShowDatePicker(false)}
                className="h-8 px-3 rounded-lg bg-ink text-white text-xs font-semibold hover:bg-ink-2 transition-colors"
              >
                Apply
              </button>
            </div>
          )}

          {/* Stat chips */}
          <div className="flex items-center gap-4 text-center flex-wrap">
            <div>
              <p className="font-num text-lg font-semibold text-ink leading-none">{isLoading ? "—" : (stats.linksToday ?? 0)}</p>
              <p className="text-[10px] text-ink-4 mt-0.5">Today</p>
            </div>
            <div className="w-px h-8 bg-ink/10" />
            <div>
              <p className="font-num text-lg font-semibold text-ink leading-none">{isLoading ? "—" : (stats.linksThisWeek ?? 0)}</p>
              <p className="text-[10px] text-ink-4 mt-0.5">This Week</p>
            </div>
            <div className="w-px h-8 bg-ink/10" />
            <div>
              <p className="font-num text-lg font-semibold text-ink leading-none">{isLoading ? "—" : (stats.linksThisMonth ?? 0)}</p>
              <p className="text-[10px] text-ink-4 mt-0.5">This Month</p>
            </div>
            {stats.isCustomRange && stats.linksInRange !== null && (
              <>
                <div className="w-px h-8 bg-ink/10" />
                <div>
                  <p className="font-num text-lg font-semibold text-terra leading-none">{isLoading ? "—" : stats.linksInRange}</p>
                  <p className="text-[10px] text-terra mt-0.5">In Range</p>
                </div>
              </>
            )}
          </div>

          {/* Platform breakdown for the selected range */}
          {linksPlatformBreakdown.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              {linksPlatformBreakdown
                .slice()
                .sort((a, b) => b.count - a.count)
                .map((p) => (
                  <span
                    key={p.platform}
                    className="inline-flex items-center gap-1.5 text-[11px] font-medium text-ink-3 bg-muted rounded-full px-2.5 py-1"
                  >
                    <span className="capitalize">{p.platform}</span>
                    <span className="font-num font-semibold text-ink">{fmtCompact(p.count)}</span>
                  </span>
                ))}
            </div>
          )}

          {/* Submission rate bar */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <p className="text-xs text-ink-4">
                {isLoading ? "—" : submittedToday} / {isLoading ? "—" : totalEmployees} employees submitted today
              </p>
              <p className="text-xs font-semibold text-terra">{isLoading ? "—" : submissionRate}%</p>
            </div>
            <div className="h-1.5 rounded-full bg-ink/8 overflow-hidden">
              <div
                className="h-full rounded-full bg-terra transition-all duration-700"
                style={{ width: `${submissionRate}%` }}
              />
            </div>
          </div>

          {/* 14-day bar chart */}
          <div className="h-44">
            {isLoading ? (
              <div className="h-full flex items-center justify-center">
                <p className="text-xs text-ink-4">Loading chart…</p>
              </div>
            ) : trendData.length === 0 ? (
              <div className="h-full flex items-center justify-center">
                <p className="text-xs text-ink-4">No link data yet</p>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={trendData} barSize={18} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" vertical={false} />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 10, fill: "var(--color-ink-4, #888)" }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: "var(--color-ink-4, #888)" }}
                    axisLine={false}
                    tickLine={false}
                    allowDecimals={false}
                  />
                  <Tooltip content={<CustomTooltip />} cursor={{ fill: "rgba(0,0,0,0.04)" }} />
                  <Bar dataKey="links" fill="var(--color-terra, #c97c3a)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>

          <div className="flex justify-end">
            <Link
              href="/reports"
              className="flex items-center gap-1.5 text-xs font-semibold text-terra hover:underline"
            >
              View full reports <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>

        {/* Account Growth summary — left half */}
        <div className="lg:col-span-2 v3-card p-5 space-y-4 v3-card-lift">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-xl bg-indigo-soft flex items-center justify-center">
                <Users className="h-5 w-5 text-indigo" />
              </div>
              <div>
                <p className="font-bold text-ink">Account Growth</p>
                <p className="text-xs text-ink-4">Last {growthDays} days</p>
              </div>
            </div>
            <PillGroup>
              {GROWTH_WINDOWS.map((w) => (
                <Pill
                  key={w.key}
                  accent="indigo"
                  active={growthDays === w.key}
                  onClick={() => setGrowthDays(w.key)}
                >
                  {w.label}
                </Pill>
              ))}
            </PillGroup>
          </div>

          {growthLoading ? (
            <div className="space-y-3 animate-pulse">
              <div className="h-8 w-32 bg-muted rounded-lg" />
              <div className="h-4 w-40 bg-muted rounded-lg" />
              <div className="h-3 w-56 bg-muted rounded-lg" />
            </div>
          ) : growthAccountCount === 0 ? (
            <div className="py-6 text-center">
              <p className="text-sm text-ink-4">No follower data yet</p>
              <p className="text-xs text-ink-4 mt-1">Counts populate once accounts are tracked</p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-end gap-3 flex-wrap">
                <p className="font-num text-3xl font-semibold text-ink leading-none">
                  {fmtCompact(g?.totalFollowers)}
                </p>
                <DeltaBadge delta={g?.totalDelta} />
              </div>
              <p className="text-xs text-ink-4">{growthAccountCount} account{growthAccountCount !== 1 ? "s" : ""} tracked</p>
              {(growthLive !== undefined || growthStale !== undefined || growthManual !== undefined) && (
                <p className="text-[11px] text-ink-4">
                  {growthLive ?? 0} live · {growthStale ?? 0} stale · {growthManual ?? 0} manual
                </p>
              )}

              {/* Follower split by platform — fills the card, accurate (current-count sum). */}
              {growthByPlatform.length > 0 && growthByPlatformMax > 0 && (
                <div className="pt-1 space-y-2">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-4">Followers by platform</p>
                  {growthByPlatform.map((row) => (
                    <div key={row.platform} className="flex items-center gap-3">
                      <span className="text-xs text-ink-3 capitalize w-20 shrink-0 truncate" title={row.platform}>
                        {row.platform}
                      </span>
                      <div className="flex-1 h-2 rounded-full bg-ink/5 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-indigo/70 transition-all duration-500"
                          style={{ width: `${Math.max(2, Math.round((row.followers / growthByPlatformMax) * 100))}%` }}
                        />
                      </div>
                      <span className="font-num text-xs font-semibold text-ink w-14 text-right shrink-0">
                        {fmtCompact(row.followers)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="flex justify-end">
            <Link href="/accounts/growth" className="flex items-center gap-1.5 text-xs font-semibold text-indigo hover:underline">
              View all <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>

        {/* Top Movers — right half */}
        <div className="lg:col-span-1 v3-card p-5 space-y-4 v3-card-lift">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-indigo-soft flex items-center justify-center">
              <Trophy className="h-5 w-5 text-indigo" />
            </div>
            <div>
              <p className="font-bold text-ink">Top Movers</p>
              <p className="text-xs text-ink-4">Biggest {growthDays}-day change</p>
            </div>
          </div>
          {growthPlatformOptions.length > 0 && (
            <PillGroup>
              <Pill accent="indigo" active={growthPlatform === "all"} onClick={() => setGrowthPlatform("all")}>
                All
              </Pill>
              {growthPlatformOptions.map((plat) => (
                <Pill
                  key={plat}
                  accent="indigo"
                  active={growthPlatform === plat}
                  onClick={() => setGrowthPlatform(plat)}
                >
                  {plat.charAt(0).toUpperCase() + plat.slice(1)}
                </Pill>
              ))}
            </PillGroup>
          )}

          {growthLoading ? (
            <div className="space-y-2 animate-pulse">
              {[0, 1, 2].map((i) => <div key={i} className="h-8 bg-muted rounded-lg" />)}
            </div>
          ) : sortedTopMovers.length === 0 ? (
            <div className="py-6 text-center">
              <p className="text-sm text-ink-4">No movers yet</p>
            </div>
          ) : (
            <ul className="space-y-2.5">
              {sortedTopMovers.map((m, i) => {
                const safeUrl = httpUrlOrNull(m.profileUrl);
                return (
                  <li key={m.accountId} className="flex flex-col gap-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-xs font-bold text-ink-4 w-4 shrink-0">{i + 1}</span>
                      <Link
                        href={`/accounts/${m.accountId}`}
                        className="flex-1 min-w-0 text-xs font-semibold text-ink hover:underline truncate"
                        title={m.displayName}
                      >
                        {m.displayName}
                      </Link>
                      {safeUrl && (
                        <a
                          href={safeUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          title="Open channel in a new tab"
                          aria-label={`Open ${m.displayName} channel`}
                          className="shrink-0 text-ink-4 hover:text-indigo transition-colors"
                        >
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </div>
                    <div className="flex items-center gap-2 pl-6">
                      <span className="text-[10px] text-ink-4 bg-ink/5 rounded-full px-2 py-0.5 shrink-0">{m.platform}</span>
                      <DeltaBadge delta={m.delta} deltaPct={m.deltaPct} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="flex justify-end">
            <Link href="/accounts/growth" className="flex items-center gap-1.5 text-xs font-semibold text-indigo hover:underline">
              View all <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>

        {/* Top Performers — left half */}
        <div className="lg:col-span-2 v3-card p-5 space-y-4 v3-card-lift">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-xl bg-sage-soft flex items-center justify-center">
                <Trophy className="h-5 w-5 text-sage" />
              </div>
              <div>
                <p className="font-bold text-ink">Top Performers</p>
                <p className="text-xs text-ink-4">Last 30 days</p>
              </div>
            </div>
            <PillGroup>
              {PERF_METRICS.map((m) => (
                <Pill
                  key={m.key}
                  accent="sage"
                  active={perfMetric === m.key}
                  onClick={() => setPerfMetric(m.key)}
                >
                  {m.label}
                </Pill>
              ))}
            </PillGroup>
          </div>

          {topPerformersLoading ? (
            <div className="space-y-2 animate-pulse">
              {[0, 1, 2].map((i) => <div key={i} className="h-8 bg-muted rounded-lg" />)}
            </div>
          ) : topPerformers.length === 0 ? (
            <div className="py-6 text-center">
              <p className="text-sm text-ink-4">No data in the last 30 days</p>
            </div>
          ) : (
            <ul className="space-y-2">
              {topPerformers.map((p, i) => (
                <li key={p.employeeId} className="flex items-center gap-2">
                  <span className="text-xs font-bold text-ink-4 w-4 shrink-0">{i + 1}</span>
                  <Link
                    href={`/reports/${p.employeeId}`}
                    className="flex-1 min-w-0 text-xs font-semibold text-ink hover:underline truncate"
                  >
                    {p.name}
                  </Link>
                  <span className="text-[10px] text-ink-4 bg-ink/5 rounded-full px-2 py-0.5 shrink-0">
                    {p.secondary}
                  </span>
                  <span className="text-xs font-semibold text-sage shrink-0">{p.primary}</span>
                </li>
              ))}
            </ul>
          )}

          <div className="flex justify-end">
            <Link href="/reports/leaderboard" className="flex items-center gap-1.5 text-xs font-semibold text-sage hover:underline">
              View all <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>

        {/* Top Links — right half. Platform pill lets the user pick YouTube/Instagram/
            Facebook; YouTube ranks by views, Instagram/Facebook by likes+comments
            (backend sorts per-platform) — see /reports for the full breakdown. */}
        <div className="lg:col-span-1 v3-card p-5 space-y-4 v3-card-lift">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-xl bg-terra-soft flex items-center justify-center">
              <Eye className="h-5 w-5 text-terra" />
            </div>
            <div>
              <p className="font-bold text-ink">Top Links</p>
              <p className="text-xs text-ink-4">Last 30 days</p>
            </div>
          </div>
          <PillGroup>
            {TOP_LINK_PLATFORMS.map((p) => (
              <Pill
                key={p.key}
                accent="terra"
                active={topLinkPlatform === p.key}
                onClick={() => setTopLinkPlatform(p.key)}
              >
                {p.label}
              </Pill>
            ))}
          </PillGroup>

          {topLinksLoading ? (
            <div className="space-y-2 animate-pulse">
              {[0, 1, 2].map((i) => <div key={i} className="h-8 bg-muted rounded-lg" />)}
            </div>
          ) : topLinksRows.length === 0 ? (
            <div className="py-6 text-center">
              <p className="text-sm text-ink-4">No {activeLinkPlatform.label} links in the last 30 days</p>
            </div>
          ) : (
            <ul className="space-y-2">
              {topLinksRows.map((link, i) => {
                const safeLinkUrl = httpUrlOrNull(link.url);
                // YouTube ranks by views; IG/FB by likes+comments (no reliable views).
                const metricValue =
                  activeLinkPlatform.metric === "views"
                    ? link.views
                    : (link.likes ?? 0) + (link.comments ?? 0);
                return (
                  <li key={link.linkId ?? link.url} className="flex items-center gap-2">
                    <span className="text-xs font-bold text-ink-4 w-4 shrink-0">{i + 1}</span>
                    {safeLinkUrl ? (
                      <a
                        href={safeLinkUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex-1 min-w-0 text-xs font-semibold text-ink hover:underline truncate"
                        title={link.url}
                      >
                        {link.url}
                      </a>
                    ) : (
                      <span
                        className="flex-1 min-w-0 text-xs font-semibold text-ink truncate"
                        title={link.url}
                      >
                        {link.url}
                      </span>
                    )}
                    <span className="text-[10px] text-ink-4 truncate max-w-[5rem] shrink-0">{link.employeeName}</span>
                    <span className="text-xs font-semibold text-terra shrink-0">{fmtCompact(metricValue)}</span>
                  </li>
                );
              })}
            </ul>
          )}

          <p className="text-[10px] text-ink-4">
            {activeLinkPlatform.metric === "views"
              ? `${activeLinkPlatform.label} · by views`
              : `${activeLinkPlatform.label} · by likes + comments`}
          </p>

          <div className="flex justify-end">
            <Link href="/reports" className="flex items-center gap-1.5 text-xs font-semibold text-terra hover:underline">
              View all <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>

        {/* More metrics — collapsed by default, holds the lower-signal cards */}
        <div className="lg:col-span-3 v3-card p-5 v3-card-lift">
          <button
            onClick={() => setMoreMetricsOpen((v) => !v)}
            className="w-full flex items-center justify-between"
            aria-expanded={moreMetricsOpen}
          >
            <p className="font-bold text-ink">More metrics ({moreStats.length})</p>
            <ChevronDown
              className={`h-4 w-4 text-ink-4 transition-transform motion-reduce:transition-none ${moreMetricsOpen ? "rotate-180" : ""}`}
            />
          </button>
          {moreMetricsOpen && (
            <div className="fade-up grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-5 gap-3 mt-4">
              {moreStats.map((card, i) => renderStatCard(card, i))}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
