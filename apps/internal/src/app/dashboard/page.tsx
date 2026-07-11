"use client";
import Link from "next/link";
import { useAuth } from "@/lib/auth";
import { useOverviewStats } from "@/lib/hooks/use-analytics";
import {
  Users, Building2, Clock, CheckCircle, FolderOpen, FileCheck, Send,
  UserPlus, ArrowRight, TrendingUp, Link2, Calendar, BarChart2, CalendarDays, X,
  Share2, Globe, ClipboardList, ChevronDown,
} from "lucide-react";
import { useState } from "react";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";

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

  const linksTrend: { date: string; count: number }[] = stats.linksTrend ?? [];
  const trendData = linksTrend.map((d) => ({
    date: new Date(d.date).toLocaleDateString("en-IN", { day: "numeric", month: "short" }),
    links: d.count,
  }));

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

        <Link href="/projects" className="v3-card-sm p-5 flex items-center gap-4 v3-card-lift group">
          <div className="h-12 w-12 rounded-xl border-2 border-ink/12 bg-sage-soft flex items-center justify-center">
            <FolderOpen className="h-6 w-6 text-sage" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-bold text-ink">{isLoading ? "—" : (stats.activeProjects ?? 0)}</p>
            <p className="text-xs text-ink-4">Active Projects</p>
          </div>
          <ArrowRight className="h-4 w-4 text-ink-4 opacity-0 group-hover:opacity-100 transition-opacity" />
        </Link>

        <Link href="/analytics" className="v3-card-sm p-5 flex items-center gap-4 v3-card-lift group">
          <div className="h-12 w-12 rounded-xl border-2 border-ink/12 bg-terra-soft flex items-center justify-center">
            <TrendingUp className="h-6 w-6 text-terra" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-bold text-ink">{isLoading ? "—" : (stats.contentPublishedThisMonth ?? 0)}</p>
            <p className="text-xs text-ink-4">Published This Month</p>
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

        {/* Daily Reports shortcut — written daily updates from all employees */}
        <Link href="/daily-reports" className="v3-card-sm p-5 flex items-center gap-4 v3-card-lift group">
          <div className="h-12 w-12 rounded-xl border-2 border-ink/12 bg-amber-100 flex items-center justify-center shrink-0">
            <ClipboardList className="h-6 w-6 text-amber-600" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-bold text-ink">Daily Updates</p>
            <p className="text-xs text-ink-4">See who wrote what today — notes, plans &amp; who hasn&apos;t submitted</p>
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
