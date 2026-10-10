"use client";
// Dashboard — premium dark redesign ("ds"), built to the Dashboard.dc.html mockup.
// UI only: every figure comes from existing endpoints; nothing here is mock data.
// Trends and sparklines are computed from real series the API already returns
// (daily link/submission counts, join/creation dates, the previous-period figures).
// Where no real series exists (pending approvals history), the slot is left out.
import Link from "next/link";
import useSWR from "swr";
import { useEffect, useMemo, useState } from "react";
import {
  Users, Building2, FileCheck, Link2, Calendar, BarChart2, UserPlus, Send, FolderOpen,
  CheckCircle, Clock, Globe, Share2, CalendarDays, X, ExternalLink,
} from "lucide-react";
import { useAuth } from "@/lib/auth";
import { apiFetch } from "@/lib/api";
import { useOverviewStats } from "@/lib/hooks/use-analytics";
import { useGrowthOverview, httpUrlOrNull, type TopMover } from "@/lib/hooks/use-growth";
import { useLinksAnalytics, useTopLinks, usePlatformLeaderboards, useInsightsSummary } from "@/lib/hooks/use-reports";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import { PostingWatchCard } from "./_posting-watch";

/* ── Palette (design tokens) ── */
const C = {
  teal: "var(--hx-00D7A0)", blue: "var(--hx-238BFF)", gold: "var(--hx-E9BD62)", purple: "var(--hx-A849F5)",
  green: "var(--hx-20C46E)", pink: "var(--hx-EC42B7)", red: "var(--hx-E52D47)",
};
const PLATFORM_COLOR: Record<string, string> = {
  facebook: "var(--hx-2F86F0)", instagram: "var(--hx-DD3FAF)", youtube: "var(--hx-E52D47)", snapchat: "var(--hx-E9BD62)",
};
const PLATFORM_ABBR: Record<string, string> = {
  facebook: "FB", instagram: "IG", youtube: "YT", snapchat: "SC", twitter: "X", linkedin: "IN", tiktok: "TT",
};
const PLATFORM_TILE: Record<string, string> = {
  youtube: "linear-gradient(135deg,var(--hx-E52D47),var(--hx-7A1424))",
  instagram: "linear-gradient(135deg,var(--hx-F0803C),var(--hx-EC42B7))",
  facebook: "linear-gradient(135deg,var(--hx-1877F2),var(--hx-0B45BB))",
  snapchat: "linear-gradient(135deg,var(--hx-F4D58C),var(--hx-B4872A))",
};
const AVATAR = ["var(--hx-238BFF)", "var(--hx-A849F5)", "var(--hx-16AD85)", "var(--hx-D9632A)", "var(--hx-DD3FAF)", "var(--hx-B4872A)"];
const PLATFORM_NAME: Record<string, string> = { facebook: "Facebook", instagram: "Instagram", youtube: "YouTube", snapchat: "Snapchat" };
const platName = (p: string) => PLATFORM_NAME[p.toLowerCase()] ?? p.charAt(0).toUpperCase() + p.slice(1);
const platColor = (p: string) => PLATFORM_COLOR[p.toLowerCase()] ?? "var(--hx-738395)";
const platAbbr = (p: string) => PLATFORM_ABBR[p.toLowerCase()] ?? p.slice(0, 2).toUpperCase();
const fmtInt = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString("en-IN"));
const initialsOf = (name: string) => name.split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
const DAY = 86_400_000;

/** Mockup number style: 1,284 · 24.8K · 350M · 13.4B (one decimal, uppercase units). */
function fmtCompact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const a = Math.abs(n), sign = n < 0 ? "-" : "";
  const unit = (v: number, u: string) => `${sign}${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/.0$/, "")}${u}`;
  if (a >= 1e9) return unit(a / 1e9, "B");
  if (a >= 1e6) return unit(a / 1e6, "M");
  if (a >= 1e4) return unit(a / 1e3, "K");
  return `${sign}${Math.round(a).toLocaleString("en-IN")}`;
}

function toISO(d: Date) {
  // Local date parts (browser IST) — never toISOString(), which is the UTC date.
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const fmtDay = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** % change, or null when there is no baseline to compare against. */
function pctChange(cur: number | null | undefined, prev: number | null | undefined): number | null {
  if (cur == null || prev == null || prev <= 0) return null;
  return ((cur - prev) / prev) * 100;
}
function Trend({ pct, digits = 0 }: { pct: number | null; digits?: number }) {
  if (pct == null || !Number.isFinite(pct)) return null;
  const down = pct < 0;
  return (
    <span className={`text-[10.5px] font-semibold ${down ? "text-ds-red" : "text-ds-teal"}`}>
      {down ? "↓" : "↑"} {Math.abs(pct).toFixed(digits)}%
    </span>
  );
}

/* ── Small building blocks ── */
function Card({ className = "", children }: { className?: string; children: React.ReactNode }) {
  return <section className={`rounded-[6px] bg-ds-card border border-ds-line px-4 py-3.5 flex flex-col min-w-0 ${className}`}>{children}</section>;
}
function CardHead({ title, right, extra }: { title: string; right?: React.ReactNode; extra?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 flex-wrap">
      <div className="flex items-center gap-2.5 min-w-0">
        <h2 className="m-0 text-[13px] font-semibold text-ds-text">{title}</h2>
        {extra}
      </div>
      {right}
    </div>
  );
}
function ViewAll({ href }: { href: string }) {
  return <Link href={href} className="text-[10.5px] text-ds-t2 whitespace-nowrap hover:text-ds-text">View All →</Link>;
}
function Chip({ children }: { children: React.ReactNode }) {
  return <span className="inline-flex items-center h-[22px] px-2 rounded-[5px] bg-ds-inset border border-ds-line2 text-ds-t2 text-[10.5px] whitespace-nowrap">{children}</span>;
}
function Seg<T extends string | number>({ options, value, onChange, stretch }: {
  options: { key: T; label: string }[]; value: T; onChange: (k: T) => void; stretch?: boolean;
}) {
  return (
    <div className={`flex gap-0.5 p-0.5 rounded-[14px] bg-ds-inset border border-ds-line ${stretch ? "w-full" : ""}`} role="group">
      {options.map((o) => {
        const on = o.key === value;
        return (
          <button
            key={String(o.key)}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.key)}
            className={`${stretch ? "flex-1 px-0.5" : "px-3"} h-[22px] rounded-[11px] text-[10.5px] font-medium whitespace-nowrap transition-colors ${on ? "bg-ds-blue text-white" : "text-ds-t2 hover:text-ds-text"}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
function Skeleton({ rows = 3, h = "h-7" }: { rows?: number; h?: string }) {
  return (
    <div className="space-y-2 mt-3" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => <div key={i} className={`${h} rounded-[4px] bg-ds-hover motion-safe:animate-pulse`} />)}
    </div>
  );
}
function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-[11.5px] text-ds-t3">{children}</p>;
}

/** Line + area paths over a real series, scaled into a w×h viewBox. */
function seriesPaths(vals: number[], w: number, h: number) {
  if (vals.length < 2) return null;
  const mn = Math.min(...vals), mx = Math.max(...vals), sp = mx - mn || 1;
  const line = vals
    .map((v, i) => `${i ? "L" : "M"}${((i / (vals.length - 1)) * w).toFixed(1)} ${(h - ((v - mn) / sp) * h * 0.9 - h * 0.05).toFixed(1)}`)
    .join(" ");
  return { line, area: `${line} L${w} ${h} L0 ${h} Z` };
}

const moreStats = [
  { key: "pendingEmployees", label: "New Joiners", note: "awaiting review", icon: UserPlus, href: "/employees/pending", color: C.pink },
  { key: "contentPublishedThisMonth", label: "Published", note: "this month", icon: Send, href: "/content?status=PUBLISHED", color: C.blue },
  { key: "activeProjects", label: "Projects", note: "active", icon: FolderOpen, href: "/projects?status=ACTIVE", color: C.purple },
  { key: "tasksCompletedThisMonth", label: "Tasks Done", note: "this month", icon: CheckCircle, href: "/tasks", color: C.green },
  { key: "presentToday", label: "Present", note: "today", icon: Clock, href: "/attendance", color: C.teal },
] as const;

const LINK_QUICK_RANGES = [14, 30, 90] as const;
const TREND_CAP_DAYS = 60; // the overview endpoint returns at most 60 daily points

export default function DashboardPage() {
  usePageTitle("Dashboard");
  const { user } = useAuth();
  const firstName = user?.name?.split(" ")[0] || "";
  // UI courtesy only (the API decides): the posting-watch endpoint is admin-only, and a
  // non-admin must never mount a request that would 403. Mirrors require-admin-role.ts.
  const isAdmin = (user?.roles ?? []).some((r) => {
    const n = String(r).toLowerCase();
    return n === "admin" || n === "super admin";
  });
  const today = new Date();
  const todayISO = toISO(today);
  const yesterdayISO = toISO(new Date(today.getTime() - DAY));
  const monthStartMs = new Date(today.getFullYear(), today.getMonth(), 1).getTime();

  /* ── Links Activity range (default last 30 days, as in the mockup) ── */
  const startFor = (days: number) => toISO(new Date(today.getTime() - (days - 1) * DAY));
  const [linkStart, setLinkStart] = useState(startFor(30));
  const [linkEnd, setLinkEnd] = useState(todayISO);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [selBar, setSelBar] = useState<number | null>(null);
  const activeQuick = LINK_QUICK_RANGES.find((d) => linkEnd === todayISO && linkStart === startFor(d)) ?? null;
  function applyQuickRange(days: number) {
    setLinkStart(startFor(days));
    setLinkEnd(todayISO);
    setSelBar(null);
  }

  // Dates are always passed so the trend array covers the selected window
  // (without them the endpoint falls back to a fixed 14 days).
  const { data, isLoading } = useOverviewStats(linkStart, linkEnd, true);
  const stats = (data as any)?.data || {};
  const pendingEmployees: number = stats.pendingEmployees ?? 0;

  /* ── "Page refreshed" clock ── */
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [, setTick] = useState(0);
  useEffect(() => { if (data) setLoadedAt(Date.now()); }, [data]);
  useEffect(() => { const t = setInterval(() => setTick((v) => v + 1), 30_000); return () => clearInterval(t); }, []);
  const refreshedLabel = (() => {
    if (!loadedAt) return null;
    const mins = Math.floor((Date.now() - loadedAt) / 60_000);
    return mins < 1 ? "page refreshed just now" : `page refreshed ${mins} min ago`;
  })();

  /* ── Employees + teams lists (join / creation dates for the KPI trends) ── */
  const { data: empList } = useSWR("/employees?limit=500", (u: string) => apiFetch<any>(u), { revalidateOnFocus: false, dedupingInterval: 300_000 });
  const { data: teamList } = useSWR("/teams", (u: string) => apiFetch<any>(u), { revalidateOnFocus: false, dedupingInterval: 300_000 });
  const empRows: { createdAt: string }[] = (empList as any)?.data ?? [];
  const teamRows: { createdAt: string; parentId: string | null }[] = ((teamList as any)?.data ?? []).filter((t: any) => !t.parentId);
  const cumulative = (dates: number[]) =>
    Array.from({ length: 14 }, (_, i) => {
      const end = today.getTime() - (13 - i) * DAY;
      return dates.filter((d) => d <= end).length;
    });
  const empDates = empRows.map((e) => new Date(e.createdAt).getTime());
  const teamDates = teamRows.map((t) => new Date(t.createdAt).getTime());
  // Pending approvals: the count and its leave/docs/pictures split come from
  // useOverviewStats (pendingApprovals, pendingLeaveRequests, pendingDocuments,
  // pendingProfilePictures). There is no real queue-history series, so — per the header
  // note — the Pending KPI carries no sparkline (it is not reconstructed from three
  // unbounded admin list fetches).
  const joinedThisMonth = empList ? empDates.filter((d) => d >= monthStartMs).length : null;
  const teamsThisMonth = teamList ? teamDates.filter((d) => d >= monthStartMs).length : null;

  /* ── Account Growth + Top Movers (connected Meta channels only) ── */
  const [growthDays, setGrowthDays] = useState(30);
  const { data: growthData, isLoading: growthLoading } = useGrowthOverview(growthDays);
  const g = (growthData as any)?.data;
  const growthAccountCount: number = g?.accountCount ?? 0;
  // Top Movers platform filter — a client-side filter of the same payload. Options come
  // from the payload's per-platform buckets (never hardcoded); "all" uses topMovers.
  const [growthPlatform, setGrowthPlatform] = useState("all");
  const topMoversByPlatform: Record<string, TopMover[]> = g?.topMoversByPlatform ?? {};
  const growthPlatformOptions = Object.keys(topMoversByPlatform);
  const activeGrowthPlatform = growthPlatform === "all" || growthPlatformOptions.includes(growthPlatform) ? growthPlatform : "all";
  const topMovers: TopMover[] = ((activeGrowthPlatform === "all" ? g?.topMovers : topMoversByPlatform[activeGrowthPlatform]) ?? [])
    .slice()
    .sort((a: TopMover, b: TopMover) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0))
    .slice(0, 6);
  const growthLive: number | undefined = g?.liveCount;
  const growthStale: number | undefined = g?.staleCount;
  const growthManual: number | undefined = g?.manualCount;
  const growthAccounts: { platform: string; latest: number | null }[] = g?.accounts ?? [];
  const growthByPlatform = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of growthAccounts) map.set(a.platform, (map.get(a.platform) ?? 0) + (a.latest ?? 0));
    return [...map.entries()].map(([platform, followers]) => ({ platform, followers })).sort((x, y) => y.followers - x.followers);
  }, [growthAccounts]);
  const growthByPlatformMax = growthByPlatform[0]?.followers ?? 0;
  const totalFollowers: number = g?.totalFollowers ?? 0;
  const totalDelta: number | null = g?.totalDelta ?? null;
  const baseFollowers = totalDelta != null ? totalFollowers - totalDelta : 0;
  const totalDeltaPct = totalDelta != null && baseFollowers > 0 ? (totalDelta / baseFollowers) * 100 : null;
  // Follower history line — the overview's audience series (API snapshots of the
  // connected channels whose history spans the window). Same window as the card.
  const { data: overviewData } = useSWR(
    `/admin/overview?days=${growthDays}`,
    (u: string) => apiFetch<any>(u),
    { revalidateOnFocus: false, dedupingInterval: 300_000, shouldRetryOnError: false },
  );
  const audienceSeries: number[] = ((overviewData as any)?.data?.audience?.series ?? []).map((p: any) => p.followers ?? 0);
  const growthPath = seriesPaths(audienceSeries, 300, 90);

  /* ── Fixed 30-day window for the glance cards ── */
  const perfEnd = todayISO;
  const perfStart = toISO(new Date(today.getTime() - 29 * DAY));
  const prevEnd = toISO(new Date(today.getTime() - 30 * DAY));
  const prevStart = toISO(new Date(today.getTime() - 59 * DAY));
  const { data: linksAnalyticsData, isLoading: perfLoading } = useLinksAnalytics(perfStart, perfEnd);
  const la = (linksAnalyticsData as any)?.data;
  const topSubmitters: { employeeId: string; name: string; totalLinks: number; reportCount: number }[] = la?.topSubmitters ?? [];
  const teamRanks: { teamId: string; teamName: string; memberCount?: number; totalLinks: number; avgLinksPerMember: number }[] = la?.teamRanks ?? [];
  // Active employees with no report in the same fixed 30-day window (same payload, no extra fetch).
  const nonSubmitters: { employeeId: string; name: string }[] = la?.nonSubmitters ?? [];
  const la30Daily: { date: string; linkCount: number; reportCount: number }[] = la?.dailyTrend ?? [];
  const la30Growth: number | null = la?.growthRate ?? null;

  const PERF_METRICS = [
    { key: "links", label: "Links" }, { key: "engagement", label: "Engagement" },
    { key: "youtube", label: "YouTube" }, { key: "facebook", label: "Facebook" },
    { key: "instagram", label: "Instagram" }, { key: "snapchat", label: "Snapchat" },
  ];
  const [perfMetric, setPerfMetric] = useState("links");
  const { data: leaderboardData } = useSWR(
    `/admin/reports/leaderboard?startDate=${perfStart}&endDate=${perfEnd}`,
    (url: string) => apiFetch<any>(url),
    { revalidateOnFocus: false, dedupingInterval: 300_000 },
  );
  const leaderboardRows: any[] = (leaderboardData as any)?.data ?? [];
  const { data: platformLbData } = usePlatformLeaderboards(perfStart, perfEnd);
  const platformBoards: Record<string, any[]> = (platformLbData as any)?.data ?? {};

  // Each row: { employeeId, name, primary (teal figure), secondary (grey badge) }.
  const topPerformers = (() => {
    if (perfMetric === "engagement") {
      return [...leaderboardRows]
        .sort((a, b) => (b.totalEngagement ?? 0) - (a.totalEngagement ?? 0))
        .slice(0, 6)
        .map((r) => ({
          employeeId: r.employee?.id ?? r.employeeId,
          name: r.employee?.name ?? r.name ?? "—",
          primary: fmtCompact(r.totalEngagement ?? 0),
          secondary: `${r.totalLinks ?? 0} links`,
        }));
    }
    if (["youtube", "facebook", "instagram", "snapchat"].includes(perfMetric)) {
      const board = platformBoards[perfMetric] ?? [];
      const isViews = perfMetric !== "instagram"; // IG publishes no view counts
      return board.slice(0, 6).map((r: any) => ({
        employeeId: r.employee?.id ?? "—",
        name: r.employee?.name ?? "—",
        primary: isViews
          ? `${fmtCompact(r.views ?? 0)} views`
          : `${fmtCompact((r.likes ?? 0) + (r.comments ?? 0))} likes+cmts`,
        secondary: `${r.engagedLinkCount ?? 0} link${(r.engagedLinkCount ?? 0) !== 1 ? "s" : ""}`,
      }));
    }
    // Links (default): ranked by links submitted — the figure IS the link count, the
    // badge is the number of reports those links came from (same fields as before).
    return [...topSubmitters]
      .sort((a, b) => b.totalLinks - a.totalLinks)
      .slice(0, 6)
      .map((p) => ({
        employeeId: p.employeeId,
        name: p.name,
        primary: `${fmtInt(p.totalLinks)} link${p.totalLinks !== 1 ? "s" : ""}`,
        secondary: `${p.reportCount} report${p.reportCount !== 1 ? "s" : ""}`,
      }));
  })();
  const perfNote: Record<string, string> = {
    links: "Last 30 days · by links submitted",
    engagement: "Last 30 days · views + likes + comments (mostly views)",
    instagram: "Last 30 days · by likes + comments (Instagram publishes no view counts)",
    youtube: "Last 30 days · by views",
    facebook: "Last 30 days · by views",
    snapchat: "Last 30 days · by views",
  };

  const TOP_LINK_PLATFORMS = [
    { key: "youtube", label: "YouTube", metric: "views" as const },
    { key: "instagram", label: "Instagram", metric: "engagement" as const },
    { key: "facebook", label: "Facebook", metric: "engagement" as const },
    { key: "snapchat", label: "Snapchat", metric: "views" as const },
  ];
  const [topLinkPlatform, setTopLinkPlatform] = useState("youtube");
  const activeLinkPlatform = TOP_LINK_PLATFORMS.find((p) => p.key === topLinkPlatform) ?? TOP_LINK_PLATFORMS[0];
  const { data: topLinksData, isLoading: topLinksLoading } = useTopLinks(topLinkPlatform, perfStart, perfEnd, 5);
  const topLinksRows: {
    linkId: string | null; url: string; employeeName: string;
    views: number | null; likes: number | null; comments: number | null;
  }[] = (topLinksData as any)?.data ?? [];

  const { data: insightsData, isLoading: insightsLoading } = useInsightsSummary(perfStart, perfEnd);
  const { data: insightsPrevData } = useInsightsSummary(prevStart, prevEnd);
  const insights = (insightsData as any)?.data;
  const insightsPrev = (insightsPrevData as any)?.data;
  const insightsByPlatform: { platform: string; totalViews: number; totalLikes: number; totalComments: number; linkCount: number }[] =
    (insights?.byPlatform ?? []).filter((p: any) => (p.linkCount ?? 0) > 0);

  // Links Activity's own range — supplies the "vs previous period" figure for In Range.
  const { data: linkActivityAnalytics } = useLinksAnalytics(linkStart, linkEnd);
  const rangeGrowth: number | null = (linkActivityAnalytics as any)?.data?.growthRate ?? null;
  // Per-platform link counts for the selected range — same payload, no extra request.
  const linksPlatformBreakdown: { platform: string; count: number; pct?: number }[] =
    ((linkActivityAnalytics as any)?.data?.platformBreakdown ?? []).slice().sort((a: any, b: any) => b.count - a.count);
  const linksPlatformTotal = linksPlatformBreakdown.reduce((a, p) => a + p.count, 0);

  /* ── Derived figures ── */
  const linksTrend: { date: string; count: number }[] = stats.linksTrend ?? [];
  const countOn = (iso: string) => linksTrend.find((d) => d.date === iso)?.count ?? null;
  const rangeDays = Math.max(1, Math.round((new Date(linkEnd).getTime() - new Date(linkStart).getTime()) / DAY) + 1);
  const inRange: number | null = isLoading ? null : (stats.linksInRange ?? linksTrend.reduce((a, d) => a + d.count, 0));
  const employeeBase: number = stats.totalEmployees ?? 0; // the submission-rate denominator (admins excluded)
  const submittedToday: number = stats.submittedTodayCount ?? 0;
  const submissionRate: number = stats.submissionRateToday ?? 0;
  // Sunday is the only non-working day (IST): nobody is expected to submit, so the
  // "not submitted" figure is withheld rather than showing everyone as missing.
  const isSundayIST = new Date(Date.now() + 330 * 60_000).getUTCDay() === 0;
  const notSubmitted: number | null = isSundayIST ? null : Math.max(0, employeeBase - submittedToday);
  const openTotal = (stats.pendingApprovals ?? 0) + pendingEmployees;

  // Today vs yesterday (full day) and this week vs the same weekdays last week —
  // both read from the daily trend, so they only show when the range covers them.
  const yesterdayCount = countOn(yesterdayISO);
  const weekPct = (() => {
    const dow = (today.getDay() + 6) % 7; // 0 = Monday
    let cur = 0, prev = 0;
    for (let i = 0; i <= dow; i++) {
      const c = countOn(toISO(new Date(today.getTime() - i * DAY)));
      const p = countOn(toISO(new Date(today.getTime() - (i + 7) * DAY)));
      if (c == null || p == null) return null;
      cur += c; prev += p;
    }
    return pctChange(cur, prev);
  })();

  const last14 = (vals: number[]) => vals.slice(-14);
  const kpis = [
    {
      key: "totalUsersCount", label: "Employees", icon: Users, href: "/employees", color: C.teal,
      trend: joinedThisMonth != null ? `↑ ${joinedThisMonth}` : null, tc: C.teal,
      note: `joined this month${pendingEmployees > 0 ? ` · ${pendingEmployees} awaiting approval` : ""}`,
      spark: empRows.length ? cumulative(empDates) : [],
    },
    {
      key: "activeTeams", label: "Teams", icon: Building2, href: "/teams", color: C.blue,
      trend: teamsThisMonth != null ? `↑ ${teamsThisMonth}` : null, tc: C.teal,
      note: `active teams${teamsThisMonth ? ` · ${teamsThisMonth} created this month` : ""}`,
      spark: teamRows.length ? cumulative(teamDates) : [],
    },
    {
      key: "pendingApprovals", label: "Pending", icon: FileCheck, href: "/approvals", color: C.gold,
      trend: [stats.pendingLeaveRequests ? `${stats.pendingLeaveRequests} leave` : "", stats.pendingDocuments ? `${stats.pendingDocuments} docs` : ""].filter(Boolean).join(" · ") || null,
      tc: C.gold,
      note: stats.pendingProfilePictures ? `${stats.pendingProfilePictures} profile picture${stats.pendingProfilePictures !== 1 ? "s" : ""} to review` : "leave + documents + profile pictures",
      spark: [] as number[],
    },
    {
      key: "linksToday", label: "Links Today", icon: Link2, href: "/reports", color: C.purple,
      pct: pctChange(stats.linksToday, yesterdayCount), note: "vs. yesterday's full day",
      spark: last14(linksTrend.map((d) => d.count)),
    },
    {
      key: "linksThisMonth", label: "Links / Month", icon: Calendar, href: "/reports/links", color: C.green,
      pct: la30Growth, note: "last 30 days vs. previous 30 days",
      spark: last14(la30Daily.map((d) => d.linkCount)),
    },
    {
      key: "submittedTodayCount", label: "Submitted Today", icon: BarChart2, href: "/reports", color: C.pink,
      trend: `${submissionRate}%`, tc: C.teal, note: `of ${fmtInt(employeeBase)} employees have reported`,
      spark: last14(la30Daily.map((d) => d.reportCount)),
    },
  ];

  /* ── Links Activity bars ── */
  const barMax = Math.max(1, ...linksTrend.map((d) => d.count));
  const step = barMax > 2000 ? 500 : barMax > 400 ? 100 : barMax > 40 ? 10 : 1;
  const ceil = Math.max(step * 4, Math.ceil(barMax / step) * step);
  const fmtTick = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v % 1000 ? 1 : 0)}k` : String(Math.round(v)));
  const yTicks = [ceil, ceil * 0.75, ceil * 0.5, ceil * 0.25, 0].map(fmtTick);
  const sel = selBar != null && selBar < linksTrend.length ? selBar : linksTrend.length - 1;
  const tickCount = Math.min(7, linksTrend.length);
  const xTicks = Array.from({ length: tickCount }, (_, i) =>
    fmtDay(linksTrend[Math.round(((linksTrend.length - 1) * i) / Math.max(1, tickCount - 1))].date));

  /* ── Engagement donut (share of interactions by platform) ── */
  const donut = useMemo(() => {
    const rows = insightsByPlatform
      .map((p) => ({ name: p.platform, v: p.totalViews + p.totalLikes + p.totalComments }))
      .filter((r) => r.v > 0)
      .sort((a, b) => b.v - a.v);
    const total = rows.reduce((a, r) => a + r.v, 0);
    const circ = 2 * Math.PI * 46;
    let acc = 0;
    return {
      total,
      segs: rows.map((r) => {
        const pct = total ? (r.v / total) * 100 : 0;
        const len = (circ * pct) / 100;
        const gap = rows.length > 1 ? Math.min(2, len / 2) : 0;
        const s = { ...r, pct, c: platColor(r.name), dash: `${Math.max(0, len - gap).toFixed(1)} ${(circ - len + gap).toFixed(1)}`, off: (-acc).toFixed(1) };
        acc += len;
        return s;
      }),
    };
  }, [insightsByPlatform]);

  /* ── Engagement per-platform rows (same insights payload) ──
     Snapchat publishes no likes/comments and Instagram mostly no view counts; the API
     sums with coalesce(…, 0), so those zeros mean "not available" and render as "—". */
  const engagementRows = insightsByPlatform
    .slice()
    .sort((a, b) => (b.totalViews + b.totalLikes + b.totalComments) - (a.totalViews + a.totalLikes + a.totalComments))
    .map((p) => {
      const plat = p.platform.toLowerCase();
      const noViews = p.totalViews == null || (plat === "instagram" && !p.totalViews);
      const noLikes = plat === "snapchat";
      return {
        platform: p.platform,
        linkCount: p.linkCount as number | null,
        views: noViews ? "—" : fmtCompact(p.totalViews),
        likes: noLikes || p.totalLikes == null ? "—" : fmtCompact(p.totalLikes),
        comments: noLikes || p.totalComments == null ? "—" : fmtCompact(p.totalComments),
        viewsTip: noViews ? "Not available for this platform" : undefined,
        likesTip: noLikes ? "Snapchat publishes no likes or comments" : undefined,
      };
    });

  const teamTotal = teamRanks.reduce((a, t) => a + t.totalLinks, 0);
  const teamMax = teamRanks[0]?.totalLinks ?? 0;

  const h = today.getHours();
  const greeting = h < 12 ? "Good Morning" : h < 17 ? "Good Afternoon" : "Good Evening";

  return (
    <div className="pb-2">
      {/* Greeting */}
      <div className="pt-[22px] pb-4 flex items-end justify-between gap-4 flex-wrap">
        <div>
          <p className="text-[10.5px] font-semibold tracking-[.14em] uppercase text-ds-gold mb-1.5">Management Portal</p>
          <h1 className="m-0 text-2xl font-semibold tracking-[-.01em] text-ds-text">{greeting}{firstName ? `, ${firstName}` : ""}!</h1>
          <p className="mt-1 text-[12.5px] text-ds-t2">Here&apos;s what&apos;s happening across Digital Sukoon today.</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Link href="/accounts" className="inline-flex items-center gap-2 h-8 px-3.5 rounded-[6px] border border-ds-line2 bg-ds-inset text-ds-text text-[12px] font-medium whitespace-nowrap hover:border-ds-line4">
            <Globe className="h-3.5 w-3.5 text-ds-blue" strokeWidth={1.8} /> Manage Accounts
          </Link>
          <Link href="/accounts?tab=by-employee" className="inline-flex items-center gap-2 h-8 px-3.5 rounded-[6px] border border-ds-gold bg-ds-gold/[.12] text-ds-gold text-[12px] font-semibold whitespace-nowrap hover:bg-ds-gold/[.22] hover:text-ds-gold2">
            <Share2 className="h-3.5 w-3.5" strokeWidth={1.8} /> Assign Account
          </Link>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid gap-2.5 sm:gap-3.5 grid-cols-2 md:grid-cols-3 min-[1400px]:grid-cols-6">
        {kpis.map((k) => {
          const Icon = k.icon;
          const spark = seriesPaths(k.spark, 64, 24);
          return (
            <Link
              key={k.key}
              href={k.href}
              className="relative flex flex-col min-[480px]:flex-row gap-2 min-[480px]:gap-2.5 min-h-[104px] p-3 rounded-[6px] bg-ds-card border border-ds-line text-ds-text overflow-hidden min-w-0 transition-colors hover:border-ds-line3"
            >
              <span className="h-10 w-10 rounded-[9px] shrink-0 grid place-items-center" style={{ background: `color-mix(in srgb, ${k.color} 12%, transparent)` }}>
                <Icon className="h-[18px] w-[18px]" style={{ color: k.color }} strokeWidth={1.8} />
              </span>
              <span className="flex flex-col min-w-0 flex-1">
                <span className="text-[11.5px] text-ds-t2 truncate">{k.label}</span>
                <span className="flex items-center gap-2 mt-0.5 min-w-0">
                  <span className="text-[22px] font-semibold leading-[1.15] tracking-[-.01em] whitespace-nowrap shrink-0">
                    {isLoading ? "—" : fmtInt(stats[k.key] ?? 0)}
                  </span>
                  {spark && !isLoading && (
                    <svg viewBox="0 0 64 24" preserveAspectRatio="none" className="ml-auto h-[22px] min-w-[28px] flex-[0_1_64px] overflow-visible" aria-hidden="true">
                      <path d={spark.area} fill={k.color} fillOpacity=".14" />
                      <path d={spark.line} fill="none" stroke={k.color} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                    </svg>
                  )}
                </span>
                {!isLoading && "pct" in k ? (
                  <span className="mt-0.5 h-[18px] flex items-center"><Trend pct={(k as any).pct} /></span>
                ) : !isLoading && (k as any).trend ? (
                  <span className="text-[12px] font-semibold mt-0.5 truncate" style={{ color: (k as any).tc }}>{(k as any).trend}</span>
                ) : null}
                <span className="text-[9.5px] text-ds-t3 mt-[3px] leading-[1.4]">{isLoading ? "" : k.note}</span>
              </span>
            </Link>
          );
        })}
      </div>

      {/* Posting watch — assigned channels with no new post for 2h+ (admins only) */}
      {isAdmin && <div className="mt-3.5"><PostingWatchCard /></div>}

      {/* Row: Links Activity + Needs Attention */}
      <div className="grid gap-3.5 mt-3.5 grid-cols-1 xl:grid-cols-3">
        <Card className="xl:col-span-2 min-h-[300px]">
          <CardHead
            title="Links Activity"
            extra={
              <span className="inline-flex items-center gap-[5px] text-[11px] font-medium text-ds-teal" title="Refreshes automatically every 2 minutes">
                <span className="ds-beat h-1.5 w-1.5 rounded-full bg-ds-teal [animation:dsBeat_2s_infinite]" />Live
              </span>
            }
            right={
              <div className="flex items-center gap-2">
                <Seg
                  options={LINK_QUICK_RANGES.map((d) => ({ key: d as number, label: `${d}d` }))}
                  value={(activeQuick ?? -1) as number}
                  onChange={(d) => { applyQuickRange(d); setShowDatePicker(false); }}
                />
                <button
                  type="button"
                  onClick={() => setShowDatePicker((v) => !v)}
                  aria-expanded={showDatePicker}
                  aria-label="Custom date range"
                  title="Custom date range"
                  className={`h-[26px] w-[26px] grid place-items-center rounded-full border transition-colors ${showDatePicker || !activeQuick ? "border-ds-gold text-ds-gold bg-ds-gold/[.1]" : "border-ds-line text-ds-t2 hover:text-ds-text"}`}
                >
                  <CalendarDays className="h-3 w-3" />
                </button>
                {!activeQuick && (
                  <button type="button" onClick={() => { applyQuickRange(30); setShowDatePicker(false); }} title="Reset to last 30 days" aria-label="Reset range" className="h-[26px] w-[26px] grid place-items-center rounded-full border border-ds-line text-ds-t3 hover:text-ds-redsoft">
                    <X className="h-3 w-3" />
                  </button>
                )}
                <ViewAll href="/reports" />
              </div>
            }
          />

          {showDatePicker && (
            <div className="mt-2.5 flex items-center gap-3 flex-wrap p-2.5 rounded-[6px] bg-ds-inset border border-ds-line">
              <label className="flex items-center gap-2 text-[11px] text-ds-t2">
                From
                <input type="date" value={linkStart} max={linkEnd} onChange={(e) => { setLinkStart(e.target.value); setSelBar(null); }} className="h-8 rounded-[6px] border border-ds-line2 bg-ds-card text-ds-text text-xs px-2" />
              </label>
              <label className="flex items-center gap-2 text-[11px] text-ds-t2">
                To
                <input type="date" value={linkEnd} min={linkStart} max={todayISO} onChange={(e) => { setLinkEnd(e.target.value); setSelBar(null); }} className="h-8 rounded-[6px] border border-ds-line2 bg-ds-card text-ds-text text-xs px-2" />
              </label>
              <button type="button" onClick={() => setShowDatePicker(false)} className="h-8 px-3 rounded-[6px] border border-ds-gold bg-ds-gold/[.12] text-ds-gold text-xs font-semibold hover:bg-ds-gold/[.22]">Apply</button>
            </div>
          )}

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-y-2 mt-2.5 whitespace-nowrap">
            {[
              { v: stats.linksToday, l: "Today", pct: pctChange(stats.linksToday, yesterdayCount), tip: "vs. yesterday's full day" },
              { v: stats.linksThisWeek, l: "This Week", pct: weekPct, tip: "vs. the same weekdays last week" },
              { v: stats.linksThisMonth, l: "This Month", pct: null as number | null, tip: "" },
              { v: inRange, l: `In Range · ${rangeDays}d`, pct: rangeGrowth, tip: `vs. the previous ${rangeDays} days`, gold: true },
            ].map((t, i) => (
              <div key={t.l} className={`leading-tight ${i % 2 ? "pl-3 border-l border-ds-line" : ""} ${i === 2 ? "sm:pl-3 sm:border-l sm:border-ds-line" : ""}`} title={t.tip || undefined}>
                <div className="text-lg font-semibold text-ds-text">{isLoading ? "—" : fmtInt(t.v ?? 0)}</div>
                <div className={`text-[10px] ${t.gold ? "text-ds-gold" : "text-ds-t2"}`}>{t.l}</div>
                <div className="h-4">{!isLoading && <Trend pct={t.pct} />}</div>
              </div>
            ))}
          </div>

          {/* Links per platform for the selected range */}
          {linksPlatformBreakdown.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 mt-2" aria-label="Links by platform in the selected range">
              {linksPlatformBreakdown.map((p) => {
                const pct = p.pct ?? (linksPlatformTotal ? Math.round((p.count / linksPlatformTotal) * 100) : null);
                return (
                  <span key={p.platform} className="inline-flex items-center gap-1.5 h-[22px] px-2 rounded-[5px] bg-ds-inset border border-ds-line2 text-[10.5px] whitespace-nowrap max-w-full min-w-0">
                    <i className="h-[7px] w-[7px] rounded-full shrink-0" style={{ background: platColor(p.platform) }} aria-hidden="true" />
                    <span className="text-ds-t2 truncate">{platName(p.platform)}</span>
                    <b className="font-semibold text-ds-text">{fmtCompact(p.count)}</b>
                    {pct != null && <span className="text-ds-t3">{pct}%</span>}
                  </span>
                );
              })}
            </div>
          )}

          {/* Bar chart */}
          <div className="flex-1 grid [grid-template-columns:36px_minmax(0,1fr)] [grid-template-rows:minmax(150px,1fr)_16px] mt-3">
            {isLoading ? (
              <div className="col-span-2 grid place-items-center text-[11px] text-ds-t3">Loading chart…</div>
            ) : linksTrend.length === 0 ? (
              <div className="col-span-2 grid place-items-center text-[11px] text-ds-t3">No link data in this range</div>
            ) : (
              <>
                <div className="flex flex-col justify-between text-[9px] text-ds-t3 text-right pr-1.5 leading-none" aria-hidden="true">
                  {yTicks.map((y, i) => <span key={i}>{y}</span>)}
                </div>
                <div className="relative border-b border-ds-line [background:repeating-linear-gradient(180deg,var(--hx-101E29)_0_1px,transparent_1px_25%)]">
                  <div className="absolute inset-0 flex items-end gap-[3px] px-0.5" role="list" aria-label="Links per day">
                    {linksTrend.map((d, i) => {
                      const on = i === sel;
                      return (
                        <button
                          key={d.date}
                          type="button"
                          role="listitem"
                          title={`${fmtDay(d.date)} · ${d.count.toLocaleString()} links`}
                          aria-label={`${fmtDay(d.date)}: ${d.count} links`}
                          onClick={() => setSelBar(i)}
                          onMouseEnter={() => setSelBar(i)}
                          className="group flex-1 min-w-0 h-full flex items-end"
                        >
                          <span
                            className="w-full rounded-t-[2px] transition-opacity group-hover:opacity-100"
                            style={{
                              height: `${Math.max(d.count ? 1.5 : 0, (d.count / ceil) * 100)}%`,
                              background: on ? "linear-gradient(180deg,var(--hx-F4D58C),var(--hx-E9BD62))" : "linear-gradient(180deg,var(--hx-C9973A),var(--hx-7A5B1E))",
                              opacity: on ? 1 : 0.75,
                            }}
                          />
                        </button>
                      );
                    })}
                  </div>
                  {sel >= 0 && linksTrend[sel] && (
                    <div
                      className="absolute pointer-events-none whitespace-nowrap rounded-[5px] border border-ds-line3 bg-[color:var(--hx-0B1A26)] px-2.5 py-1 text-center shadow-[0_6px_16px_rgba(0,0,0,.5)] -translate-x-1/2 transition-[left,bottom] duration-200"
                      style={{
                        left: `${Math.min(Math.max(((sel + 0.5) / linksTrend.length) * 100, 12), 88)}%`,
                        bottom: `min(calc(${((linksTrend[sel].count / ceil) * 100).toFixed(1)}% + 8px), calc(100% - 40px))`,
                      }}
                    >
                      <div className="text-[12px] font-semibold text-ds-text">{linksTrend[sel].count.toLocaleString()}</div>
                      <div className="text-[9.5px] text-ds-t2">{fmtDay(linksTrend[sel].date)} · {linksTrend[sel].date === todayISO ? "links so far" : "links"}</div>
                    </div>
                  )}
                </div>
                <div className="col-start-2 flex justify-between text-[9px] text-ds-t3 pt-1" aria-hidden="true">
                  {xTicks.map((x, i) => <span key={i}>{x}</span>)}
                </div>
              </>
            )}
          </div>
          {rangeDays > TREND_CAP_DAYS && !isLoading && (
            <p className="mt-1.5 text-[9.5px] text-ds-t3">Chart shows the last {TREND_CAP_DAYS} days of the range; the In Range total covers all {rangeDays} days.</p>
          )}
        </Card>

        <Card>
          <CardHead
            title="Needs Attention"
            right={!isLoading && openTotal > 0 ? <span className="text-[8.5px] font-bold px-1.5 py-0.5 rounded-[3px] bg-ds-red text-white tracking-[.06em]">{openTotal} OPEN</span> : undefined}
          />
          {!isLoading && pendingEmployees > 0 && (
            <div className="mt-3 p-3 rounded-[6px] bg-ds-gold/[.07] border border-ds-gold/30 flex items-center gap-3">
              <span className="h-9 w-9 rounded-[9px] bg-ds-gold/[.14] grid place-items-center shrink-0">
                <UserPlus className="h-[18px] w-[18px] text-ds-gold" strokeWidth={1.8} />
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-[12.5px] font-semibold text-ds-text">{pendingEmployees} employee{pendingEmployees !== 1 ? "s" : ""} awaiting approval</p>
                <p className="text-[10.5px] text-ds-t2 mt-0.5">Review and approve new team members</p>
              </div>
              <Link href="/employees/pending" className="h-7 px-3 rounded-[5px] border border-ds-gold bg-ds-gold/[.12] text-ds-gold text-[11px] font-semibold inline-flex items-center whitespace-nowrap hover:bg-ds-gold/[.22]">Review →</Link>
            </div>
          )}
          {isLoading ? <Skeleton rows={5} /> : (
            <div className="flex flex-col mt-2.5">
              {[
                { label: "Approvals queue · total", n: stats.pendingApprovals ?? 0, c: C.gold, sub: false, href: "/approvals" },
                { label: "↳ Leave requests", n: stats.pendingLeaveRequests ?? 0, c: "var(--hx-33506A)", sub: true, href: "/leave" },
                { label: "↳ Documents to verify", n: stats.pendingDocuments ?? 0, c: "var(--hx-33506A)", sub: true, href: "/approvals" },
                { label: "↳ Profile pictures", n: stats.pendingProfilePictures ?? 0, c: "var(--hx-33506A)", sub: true, href: "/approvals" },
                { label: "New joiners to review", n: pendingEmployees, c: C.pink, sub: false, href: "/employees/pending" },
                { label: "Not submitted today", n: notSubmitted, c: C.blue, sub: false, href: "/reports", note: isSundayIST ? "Sunday — no submissions expected" : undefined },
              ].map((q) => (
                <Link key={q.label} href={q.href} className={`flex items-center gap-2.5 py-[9px] pr-1 border-b border-ds-grid text-[11.5px] hover:bg-ds-hover min-w-0 ${q.sub ? "pl-[18px]" : "pl-1"}`}>
                  <span className="h-[7px] w-[7px] rounded-full shrink-0" style={{ background: q.c }} />
                  <span className={`flex-1 min-w-0 truncate ${q.sub ? "text-ds-t2" : "text-ds-text"}`}>{q.label}</span>
                  {"note" in q && q.note ? (
                    <span className="text-[10px] text-ds-t3 text-right truncate min-w-0" title={q.note}>{q.note}</span>
                  ) : (
                    <b className="font-semibold text-ds-text">{fmtInt(q.n)}</b>
                  )}
                </Link>
              ))}
            </div>
          )}

          {/* Haven't submitted — active employees with no report in the last 30 days */}
          <div className="mt-3">
            <p className="text-[10px] font-semibold tracking-[.08em] uppercase text-ds-t3">
              Haven&apos;t submitted · 30 days{!perfLoading && nonSubmitters.length > 0 ? ` (${nonSubmitters.length})` : ""}
            </p>
            {perfLoading ? <Skeleton rows={2} h="h-6" /> : nonSubmitters.length === 0 ? (
              <p className="mt-2 text-[11px] text-ds-teal">Everyone has submitted in the last 30 days</p>
            ) : (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {nonSubmitters.slice(0, 12).map((e) => (
                  <Link
                    key={e.employeeId}
                    href={`/reports/${e.employeeId}`}
                    title={e.name}
                    className="inline-flex items-center gap-1.5 h-[24px] pl-0.5 pr-2 rounded-full bg-ds-red/[.08] border border-ds-red/25 text-[10.5px] text-ds-redsoft max-w-[11rem] min-w-0 hover:bg-ds-red/[.16]"
                  >
                    <span className="h-5 w-5 rounded-full shrink-0 grid place-items-center bg-ds-red/[.22] text-[8px] font-bold text-ds-redsoft">{initialsOf(e.name)}</span>
                    <span className="truncate">{e.name}</span>
                  </Link>
                ))}
                {nonSubmitters.length > 12 && (
                  <span className="inline-flex items-center h-[24px] px-2 text-[10.5px] text-ds-t3">+{nonSubmitters.length - 12} more</span>
                )}
              </div>
            )}
          </div>
          <p className="mt-auto pt-2.5 text-[9.5px] text-ds-t3">Approvals total = leave + documents + profile pictures.</p>
        </Card>
      </div>

      {/* Row: Account Growth / Top Movers / Top Performers */}
      <div className="grid gap-3.5 mt-3.5 grid-cols-1 md:grid-cols-2 xl:grid-cols-3 [&>*:last-child]:md:col-span-2 [&>*:last-child]:xl:col-span-1">
        <Card className="min-h-[290px]">
          <CardHead
            title="Account Growth"
            right={<Seg options={[7, 30, 90].map((d) => ({ key: d, label: `${d}d` }))} value={growthDays} onChange={setGrowthDays} />}
          />
          {growthLoading ? <Skeleton rows={4} /> : growthAccountCount === 0 ? (
            <Empty>No follower data yet — counts appear once channels are connected.</Empty>
          ) : (
            <>
              <div className="flex items-end gap-2.5 mt-1.5">
                <span className="text-[26px] font-semibold leading-none tracking-[-.01em] text-ds-text">{fmtCompact(totalFollowers)}</span>
                <span className="flex flex-col leading-tight min-w-0">
                  {totalDelta != null && (
                    <span className={`text-[13px] font-semibold ${totalDelta < 0 ? "text-ds-red" : "text-ds-teal"}`}>
                      {totalDelta < 0 ? "↓" : "↑"} {totalDeltaPct != null ? `${Math.abs(totalDeltaPct).toFixed(1)}%` : fmtCompact(Math.abs(totalDelta))}
                    </span>
                  )}
                  <span className="text-[9.5px] text-ds-t3 truncate">
                    Total followers{totalDelta != null ? ` · ${totalDelta >= 0 ? "+" : "−"}${fmtCompact(Math.abs(totalDelta))}` : ""} across {growthAccountCount} account{growthAccountCount !== 1 ? "s" : ""}
                  </span>
                </span>
              </div>
              {(growthLive !== undefined || growthStale !== undefined || growthManual !== undefined) && (
                <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-ds-t3" title="Sync state of the tracked accounts">
                  <span className="inline-flex items-center gap-1"><i className="h-1.5 w-1.5 rounded-full bg-ds-teal" aria-hidden="true" />{fmtInt(growthLive ?? 0)} live</span>
                  <span aria-hidden="true">·</span>
                  <span className="inline-flex items-center gap-1"><i className="h-1.5 w-1.5 rounded-full bg-ds-gold" aria-hidden="true" />{fmtInt(growthStale ?? 0)} stale</span>
                  <span aria-hidden="true">·</span>
                  <span className="inline-flex items-center gap-1"><i className="h-1.5 w-1.5 rounded-full bg-ds-t4" aria-hidden="true" />{fmtInt(growthManual ?? 0)} manual</span>
                </p>
              )}
              {growthPath ? (
                <svg viewBox="0 0 300 90" preserveAspectRatio="none" className="w-full h-[90px] mt-2.5 block" aria-label={`Follower trend over the last ${growthDays} days`}>
                  <defs>
                    <linearGradient id="dsGrowth" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0" stopColor="var(--hx-00D7A0)" stopOpacity=".35" />
                      <stop offset="1" stopColor="var(--hx-00D7A0)" stopOpacity="0" />
                    </linearGradient>
                  </defs>
                  <path d={growthPath.area} fill="url(#dsGrowth)" />
                  <path d={growthPath.line} fill="none" stroke="var(--hx-00D7A0)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
                </svg>
              ) : (
                <div className="h-[90px] mt-2.5 rounded-[4px] bg-ds-hover/40" aria-hidden="true" />
              )}
              {growthByPlatform.length > 0 && growthByPlatformMax > 0 && (
                <>
                  <p className="text-[10px] font-semibold tracking-[.08em] uppercase text-ds-t3 mt-3">Followers by platform</p>
                  <div className="flex flex-col gap-2 mt-2">
                    {growthByPlatform.map((p) => (
                      <div key={p.platform} className="grid [grid-template-columns:72px_minmax(0,1fr)_44px] gap-2 items-center text-[11px]">
                        <span className="text-ds-t5 truncate">{platName(p.platform)}</span>
                        <span className="h-1.5 rounded-[3px] bg-ds-hover overflow-hidden">
                          <span className="block h-full rounded-[3px]" style={{ width: `${Math.max(2, Math.round((p.followers / growthByPlatformMax) * 100))}%`, background: platColor(p.platform) }} />
                        </span>
                        <b className="font-semibold text-right text-ds-text">{fmtCompact(p.followers)}</b>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </Card>

        <Card>
          <CardHead title="Top Movers" right={<ViewAll href="/accounts/growth" />} />
          {growthPlatformOptions.length > 0 && (
            <div className="mt-2 flex max-w-full overflow-x-auto">
              <Seg
                options={[{ key: "all", label: "All" }, ...growthPlatformOptions.map((p) => ({ key: p, label: platName(p) }))]}
                value={activeGrowthPlatform}
                onChange={setGrowthPlatform}
              />
            </div>
          )}
          {growthLoading ? <Skeleton rows={6} /> : topMovers.length === 0 ? <Empty>No movers yet</Empty> : (
            <>
              <div className="grid [grid-template-columns:14px_minmax(0,1fr)_34px_52px_48px] gap-1.5 text-[10px] text-ds-t3 px-1 pt-2.5 pb-[5px] border-b border-ds-line">
                <span>#</span><span>Channel</span><span /><span className="text-right">Gained</span><span className="text-right">Growth</span>
              </div>
              {topMovers.map((m, i) => {
                const safeUrl = httpUrlOrNull(m.profileUrl);
                const neg = (m.delta ?? 0) < 0;
                return (
                  <div key={m.accountId} className="grid [grid-template-columns:14px_minmax(0,1fr)_34px_52px_48px] gap-1.5 items-center min-h-[34px] px-1 rounded-[4px] text-[11px] hover:bg-ds-hover">
                    <span className="text-ds-gold font-semibold">{i + 1}</span>
                    <span className="flex items-center gap-[7px] min-w-0">
                      <span className="h-5 w-5 rounded-full shrink-0 grid place-items-center text-[8px] font-bold text-white" style={{ background: AVATAR[i % AVATAR.length] }}>{initialsOf(m.displayName)}</span>
                      <Link href={`/accounts/${m.accountId}`} className="truncate text-ds-text hover:underline" title={m.displayName}>{m.displayName}</Link>
                      {safeUrl && (
                        <a href={safeUrl} target="_blank" rel="noopener noreferrer" aria-label={`Open ${m.displayName} channel`} className="shrink-0 text-ds-t3 hover:text-ds-gold">
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </span>
                    <span className="h-4 grid place-items-center rounded-[3px] bg-ds-chip border border-ds-line2 text-ds-t2 text-[8.5px] font-bold tracking-[.04em]">{platAbbr(m.platform)}</span>
                    <span className="text-right text-ds-text">{m.delta == null ? "—" : `${neg ? "−" : "+"}${fmtCompact(Math.abs(m.delta))}`}</span>
                    <span className={`text-right font-semibold ${neg ? "text-ds-red" : "text-ds-teal"}`}>
                      {m.deltaPct == null ? "—" : `${neg ? "↓" : "↑"} ${Math.abs(m.deltaPct).toFixed(1)}%`}
                    </span>
                  </div>
                );
              })}
            </>
          )}
        </Card>

        <Card>
          <CardHead title="Top Performers" right={<ViewAll href="/reports/leaderboard" />} />
          <p className="text-[9.5px] text-ds-t3 mt-[3px]">{perfNote[perfMetric]}</p>
          <div className="mt-2 overflow-x-auto">
            <Seg stretch options={PERF_METRICS} value={perfMetric} onChange={setPerfMetric} />
          </div>
          {perfLoading ? <Skeleton rows={6} /> : topPerformers.length === 0 ? <Empty>No data in the last 30 days</Empty> : (
            <div className="flex flex-col gap-0.5 mt-2">
              {topPerformers.map((p, i) => (
                <Link key={`${p.employeeId}-${i}`} href={`/reports/${p.employeeId}`} className="flex items-center gap-2 min-h-[30px] px-1 rounded-[4px] text-[11px] hover:bg-ds-hover">
                  <span className="w-3.5 text-ds-gold font-semibold">{i + 1}</span>
                  <span className="flex-1 min-w-0 font-semibold text-ds-text truncate">{p.name}</span>
                  <span className="text-[9.5px] text-ds-t2 bg-ds-hover rounded-full px-[7px] py-0.5 whitespace-nowrap">{p.secondary}</span>
                  <span className="min-w-[48px] text-right font-semibold text-ds-teal whitespace-nowrap">{p.primary}</span>
                </Link>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* Row: Top Links / Teams / Engagement */}
      <div className="grid gap-3.5 mt-3.5 grid-cols-1 md:grid-cols-2 xl:grid-cols-3 [&>*:last-child]:md:col-span-2 [&>*:last-child]:xl:col-span-1">
        <Card>
          <CardHead title="Top Links" right={<Chip>Last 30 Days</Chip>} />
          <div className="mt-2">
            <Seg stretch options={TOP_LINK_PLATFORMS.map((p) => ({ key: p.key, label: p.label }))} value={topLinkPlatform} onChange={setTopLinkPlatform} />
          </div>
          {topLinksLoading ? <Skeleton rows={5} h="h-8" /> : topLinksRows.length === 0 ? <Empty>No {activeLinkPlatform.label} links in the last 30 days</Empty> : (
            <div className="flex flex-col gap-2 mt-2.5">
              {topLinksRows.map((link) => {
                const safe = httpUrlOrNull(link.url);
                const value = activeLinkPlatform.metric === "views" ? link.views : (link.likes ?? 0) + (link.comments ?? 0);
                const label = link.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
                const inner = (
                  <>
                    <span className="w-11 h-7 rounded-[3px] shrink-0" style={{ background: PLATFORM_TILE[activeLinkPlatform.key] }} aria-hidden="true" />
                    <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                      <span className="text-[10.5px] font-semibold leading-[1.3] truncate text-ds-text" title={link.url}>{label}</span>
                      <span className="flex gap-[7px] items-center text-[9.5px] text-ds-t3 min-w-0">
                        <span className="inline-flex items-center h-3.5 px-1 rounded-[3px] bg-ds-chip border border-ds-line2 text-ds-t2 text-[8px] font-bold shrink-0">{platAbbr(activeLinkPlatform.key)}</span>
                        <span className="truncate">{link.employeeName}</span>
                      </span>
                    </span>
                    <span className="flex flex-col items-end leading-[1.15] shrink-0">
                      <b className="text-[11.5px] font-semibold text-ds-text">{value == null ? "—" : fmtCompact(value)}</b>
                      <i className="not-italic text-[9px] text-ds-t3">{activeLinkPlatform.metric === "views" ? "views" : "likes + comments"}</i>
                    </span>
                  </>
                );
                return safe ? (
                  <a key={link.linkId ?? link.url} href={safe} target="_blank" rel="noopener noreferrer" className="flex gap-[9px] items-center px-[3px] py-0.5 rounded-[4px] hover:bg-ds-hover">{inner}</a>
                ) : (
                  <div key={link.linkId ?? link.url} className="flex gap-[9px] items-center px-[3px] py-0.5">{inner}</div>
                );
              })}
            </div>
          )}
        </Card>

        <Card>
          <CardHead title="Top Teams by Links" right={<ViewAll href="/reports/links" />} />
          <p className="text-[9.5px] text-ds-t3 mt-[3px]">
            Last 30 days{!perfLoading && teamRanks.length > 0 ? ` · ${fmtInt(teamTotal)} links from ${teamRanks.length} team${teamRanks.length !== 1 ? "s" : ""}` : ""}
          </p>
          {perfLoading ? <Skeleton rows={6} /> : teamRanks.length === 0 ? <Empty>No team data</Empty> : (
            <div className="flex flex-col gap-3 mt-3.5">
              {teamRanks.slice(0, 6).map((t, i) => (
                <div key={t.teamId} className="flex flex-col gap-[5px]">
                  <div className="flex justify-between gap-2 text-[11px]">
                    <span className="flex gap-2 min-w-0">
                      <span className="text-ds-gold font-semibold w-2.5 shrink-0">{i + 1}</span>
                      <span className="font-semibold text-ds-text truncate" title={t.teamName}>{t.teamName}</span>
                      {t.memberCount != null && <span className="hidden sm:inline text-ds-t3 whitespace-nowrap">{t.memberCount} member{t.memberCount !== 1 ? "s" : ""}</span>}
                    </span>
                    <span className="flex items-center gap-2 shrink-0">
                      {t.avgLinksPerMember != null && (
                        <span className="text-[9.5px] text-ds-t2 bg-ds-hover rounded-full px-[7px] py-0.5 whitespace-nowrap" title="Average links per team member, last 30 days">{t.avgLinksPerMember}/member</span>
                      )}
                      <b className="font-semibold text-ds-text">{fmtInt(t.totalLinks)}</b>
                    </span>
                  </div>
                  <span className="h-[5px] rounded-[3px] bg-ds-hover overflow-hidden ml-[18px]">
                    <span className="block h-full rounded-[3px] bg-gradient-to-r from-ds-golddeep to-ds-gold" style={{ width: `${teamMax ? Math.max(2, Math.round((t.totalLinks / teamMax) * 100)) : 0}%` }} />
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <CardHead title="Total Engagement" right={<Chip>Last 30 Days</Chip>} />
          {insightsLoading ? <Skeleton rows={4} h="h-10" /> : (
            <>
              <div className="grid grid-cols-3 mt-2">
                {[
                  { v: insights?.totalViews ?? 0, p: insightsPrev?.totalViews, l: "Views", c: "var(--hx-2F86F0)" },
                  { v: insights?.totalLikes ?? 0, p: insightsPrev?.totalLikes, l: "Likes", c: "var(--hx-DD3FAF)" },
                  { v: insights?.totalComments ?? 0, p: insightsPrev?.totalComments, l: "Comments", c: "var(--hx-16AD85)" },
                ].map((t, i) => (
                  <div key={t.l} className={`leading-tight min-w-0 ${i ? "border-l border-ds-line pl-2.5" : ""}`} title="vs. the previous 30 days">
                    <div className="text-base font-semibold text-ds-text truncate">{fmtCompact(t.v)}</div>
                    <div className="text-[10px]" style={{ color: t.c }}>{t.l}</div>
                    <div className="h-4"><Trend pct={pctChange(t.v, t.p)} /></div>
                  </div>
                ))}
              </div>
              {donut.segs.length === 0 ? (insightsByPlatform.length === 0 ? <Empty>No engagement data in the last 30 days</Empty> : null) : (
                <div className="flex-1 grid [grid-template-columns:auto_minmax(0,1fr)] gap-4 items-center mt-3">
                  <div className="relative h-[120px] w-[120px]">
                    <svg viewBox="0 0 120 120" width="120" height="120" className="-rotate-90" aria-hidden="true">
                      <circle cx="60" cy="60" r="46" fill="none" stroke="var(--hx-0F1E2A)" strokeWidth="14" />
                      {donut.segs.map((s) => (
                        <circle key={s.name} cx="60" cy="60" r="46" fill="none" stroke={s.c} strokeWidth="14" strokeDasharray={s.dash} strokeDashoffset={s.off} />
                      ))}
                    </svg>
                    <div className="absolute inset-0 flex flex-col items-center justify-center">
                      <span className="text-[17px] font-semibold leading-none text-ds-text">{fmtCompact(donut.total)}</span>
                      <span className="text-[9.5px] text-ds-t2 mt-[3px]">interactions</span>
                    </div>
                  </div>
                  <div className="flex flex-col gap-[7px] min-w-0">
                    {donut.segs.map((s) => (
                      <div key={s.name} className="flex items-center gap-2 text-[11px]">
                        <i className="h-[7px] w-[7px] rounded-full shrink-0" style={{ background: s.c }} />
                        <span className="flex-1 text-ds-t5 truncate">{platName(s.name)}</span>
                        <span className="text-ds-t2">{fmtCompact(s.v)}</span>
                        <b className="w-[34px] text-right font-semibold text-ds-text">{s.pct < 1 && s.pct > 0 ? "<1" : Math.round(s.pct)}%</b>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {/* Per-platform breakdown (views / likes / comments / links), as before */}
              {insightsByPlatform.length > 0 && (
                <div className="mt-3 min-w-0">
                  <div className="grid [grid-template-columns:minmax(0,1fr)_repeat(4,minmax(0,44px))] gap-x-2 text-[9.5px] text-ds-t3 px-1 pb-[5px] border-b border-ds-line">
                    <span>Platform</span><span className="text-right">Views</span><span className="text-right">Likes</span><span className="text-right">Cmts</span><span className="text-right">Links</span>
                  </div>
                  {engagementRows.map((p) => (
                    <div key={p.platform} className="grid [grid-template-columns:minmax(0,1fr)_repeat(4,minmax(0,44px))] gap-x-2 items-center min-h-[28px] px-1 border-b border-ds-grid text-[11px]">
                      <span className="flex items-center gap-2 min-w-0">
                        <i className="h-[7px] w-[7px] rounded-full shrink-0" style={{ background: platColor(p.platform) }} aria-hidden="true" />
                        <span className="text-ds-t5 truncate">{platName(p.platform)}</span>
                      </span>
                      <span className="text-right text-ds-text truncate" title={p.viewsTip}>{p.views}</span>
                      <span className="text-right text-ds-text truncate" title={p.likesTip}>{p.likes}</span>
                      <span className="text-right text-ds-text truncate" title={p.likesTip}>{p.comments}</span>
                      <span className="text-right text-ds-t2 truncate">{fmtInt(p.linkCount)}</span>
                    </div>
                  ))}
                  {engagementRows.some((p) => p.views === "—" || p.likes === "—" || p.comments === "—") && (
                    <p className="mt-1.5 text-[9.5px] text-ds-t3">“—” = metric not available for that platform.</p>
                  )}
                </div>
              )}
            </>
          )}
        </Card>
      </div>

      {/* More stats */}
      <div className="grid gap-3.5 mt-3.5 grid-cols-2 lg:grid-cols-5 [&>*:last-child]:col-span-2 [&>*:last-child]:lg:col-span-1">
        {moreStats.map((k) => {
          const Icon = k.icon;
          const note = k.key === "presentToday" && employeeBase ? `of ${fmtInt(employeeBase)} today` : k.note;
          return (
            <Link key={k.key} href={k.href} className="flex items-center gap-2.5 px-3 py-2.5 rounded-[6px] bg-ds-card border border-ds-line text-ds-text min-w-0 transition-colors hover:border-ds-line3">
              <span className="h-8 w-8 rounded-[8px] shrink-0 grid place-items-center" style={{ background: `color-mix(in srgb, ${k.color} 12%, transparent)` }}>
                <Icon className="h-4 w-4" style={{ color: k.color }} strokeWidth={1.8} />
              </span>
              <span className="flex flex-col min-w-0 flex-1">
                <span className="text-[11px] text-ds-t2 truncate">{k.label}</span>
                <span className="text-[17px] font-semibold leading-tight">{isLoading ? "—" : fmtInt(stats[k.key] ?? 0)}</span>
              </span>
              <span className="text-[10px] text-ds-t3 whitespace-nowrap">{note}</span>
            </Link>
          );
        })}
      </div>

      <p className="mt-3.5 text-right text-[9.5px] text-ds-t4 tracking-[.04em] leading-normal">
        Link counts through {today.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
        {!isLoading && employeeBase > 0 ? ` · ${fmtInt(submittedToday)} of ${fmtInt(employeeBase)} employees submitted today` : ""}
        {refreshedLabel ? ` · ${refreshedLabel}` : ""}
      </p>
    </div>
  );
}
