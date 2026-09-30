"use client";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft, FileText, Link2, Flame, TrendingUp, Eye, Heart, MessageCircle,
  Share2, Calendar, BarChart3, Globe, Briefcase,
} from "lucide-react";
import { useEmployeePerformance } from "@/lib/hooks/use-reports";

const PLATFORM_COLORS: Record<string, string> = {
  instagram: "bg-pink-100 text-pink-700",
  twitter: "bg-sky-100 text-sky-700",
  x: "bg-gray-100 text-gray-800",
  linkedin: "bg-blue-100 text-blue-700",
  facebook: "bg-indigo-100 text-indigo-700",
  youtube: "bg-red-100 text-red-700",
  snapchat: "bg-yellow-100 text-yellow-800",
  pinterest: "bg-rose-100 text-rose-700",
  telegram: "bg-cyan-100 text-cyan-700",
};

function getPlatformColor(slug: string) {
  return PLATFORM_COLORS[slug?.toLowerCase()] ?? "bg-action-soft text-ink";
}

function HeatCell({ count }: { count: number }) {
  const bg =
    count === 0
      ? "bg-muted"
      : count <= 3
        ? "bg-action-soft"
        : count <= 8
          ? "bg-action"
          : "bg-[#1D2C3A]";
  return (
    <div
      className={`w-3 h-3 rounded-[2px] ${bg} transition-colors`}
      title={`${count} links`}
    />
  );
}

export default function EmployeePerformancePage() {
  const { id } = useParams() as { id: string };
  const { data, isLoading } = useEmployeePerformance(id);
  const perf = (data as any)?.data;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-action" />
      </div>
    );
  }

  if (!perf) {
    return (
      <div className="space-y-4">
        <Link href="/employees" className="flex items-center gap-1 text-sm text-ink-3 hover:text-ink">
          <ArrowLeft className="h-4 w-4" /> Back to Employees
        </Link>
        <p className="text-ink-3">Employee not found.</p>
      </div>
    );
  }

  const { employee, stats, platformBreakdown, weeklyTrend, calendar, recentReports, assignedAccounts } = perf;
  const maxWeeklyLinks = Math.max(...weeklyTrend.map((w: any) => w.links), 1);

  const statCards = [
    { title: "Total Reports", value: stats.totalReports, icon: FileText, sub: "all time" },
    { title: "Total Links", value: stats.totalLinks, icon: Link2, sub: `avg ${stats.avgLinksPerDay}/day` },
    { title: "Current Streak", value: `${stats.currentStreak}d`, icon: Flame, sub: `best: ${stats.longestStreak}d` },
    { title: "Engagement", value: stats.totalEngagement.toLocaleString(), icon: TrendingUp, sub: "likes + comments + shares" },
    { title: "This Month", value: stats.thisMonthReports, icon: Calendar, sub: `${stats.thisMonthLinks} links` },
    { title: "Views", value: stats.totalViews.toLocaleString(), icon: Eye, sub: "total views" },
  ];

  const engagementCards = [
    { label: "Likes", value: stats.totalLikes, icon: Heart, color: "text-pink-500" },
    { label: "Comments", value: stats.totalComments, icon: MessageCircle, color: "text-blue-500" },
    { label: "Shares", value: stats.totalShares, icon: Share2, color: "text-green-500" },
    { label: "Views", value: stats.totalViews, icon: Eye, color: "text-purple-500" },
  ];

  // Group calendar by weeks for display
  const weeks: { date: string; linkCount: number }[][] = [];
  let currentWeek: { date: string; linkCount: number }[] = [];
  for (let i = 0; i < calendar.length; i++) {
    const dayOfWeek = new Date(calendar[i].date).getDay();
    if (dayOfWeek === 0 && currentWeek.length > 0) {
      weeks.push(currentWeek);
      currentWeek = [];
    }
    currentWeek.push(calendar[i]);
  }
  if (currentWeek.length > 0) weeks.push(currentWeek);

  return (
    <div className="space-y-6 crx-animate-fade">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link href="/employees" className="flex items-center gap-1 text-sm text-ink-3 hover:text-ink transition-colors">
          <ArrowLeft className="h-4 w-4" /> Employees
        </Link>
        <span className="text-ink-4">/</span>
        <Link href={`/reports/${id}`} className="text-sm text-ink-3 hover:text-ink transition-colors">
          Reports
        </Link>
      </div>

      {/* Stacks vertically on phones — the name + action button used to fight for
          the same row, wrapping the name to 2 lines and clipping the button. */}
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
        <div className="flex items-center gap-3 sm:gap-4 min-w-0">
          <div
            className="h-12 w-12 sm:h-16 sm:w-16 rounded-2xl flex items-center justify-center text-white text-lg sm:text-2xl font-semibold shrink-0"
            style={{ background: "linear-gradient(135deg, #5B4BF5, #3023D0)" }}
          >
            {employee.name?.[0]?.toUpperCase()}
          </div>
          <div className="min-w-0">
            <h1 className="font-serif text-xl sm:text-4xl font-light text-ink truncate">{employee.name}</h1>
            <div className="flex flex-wrap items-center gap-2 sm:gap-3 mt-1">
              <span className="text-ink-3 text-xs sm:text-sm truncate">{employee.email}</span>
              {employee.designation && (
                <span className="bg-action-soft text-ink px-2.5 py-0.5 rounded-full text-xs font-medium">{employee.designation}</span>
              )}
              {employee.team && (
                <span className="text-xs text-ink-3 flex items-center gap-1">
                  <Briefcase className="h-3 w-3" /> {employee.team}
                </span>
              )}
            </div>
            <div className="flex gap-1.5 mt-2">
              {employee.roles.map((role: string) => (
                <span key={role} className="bg-action text-[#06121B] px-2.5 py-0.5 rounded-full text-[10px] font-medium">{role}</span>
              ))}
              <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-medium ${
                employee.status === "ACTIVE" ? "bg-[rgba(107,203,119,0.12)] text-success" : "bg-[rgba(0,0,0,0.06)] text-ink-3"
              }`}>{employee.status}</span>
            </div>
          </div>
        </div>
        <Link
          href={`/reports/${id}`}
          className="inline-flex items-center gap-2 bg-action text-[#06121B] rounded-full px-5 py-2.5 text-sm font-medium hover:opacity-90 transition-all shrink-0 w-fit"
        >
          <FileText className="h-4 w-4" /> View All Reports
        </Link>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        {statCards.map((card, i) => {
          const Icon = card.icon;
          return (
            <div key={card.title} className={`bg-surface rounded-2xl p-5 shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-border crx-animate-slide crx-delay-${Math.min(i + 1, 6)}`}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-ink-3">{card.title}</span>
                <Icon className="h-4 w-4 text-ink-4" />
              </div>
              <p className="text-[28px] font-light font-num text-ink leading-tight">{card.value}</p>
              <p className="text-[10px] text-ink-4 mt-1">{card.sub}</p>
            </div>
          );
        })}
      </div>

      {/* Engagement Breakdown — 2 columns on phones so "Comments" doesn't clip to "Comme" */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
        {engagementCards.map((card) => {
          const Icon = card.icon;
          return (
            <div key={card.label} className="bg-surface rounded-2xl p-3 sm:p-4 shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-border flex items-center gap-2 sm:gap-3 min-w-0">
              <div className="h-9 w-9 sm:h-10 sm:w-10 rounded-xl bg-action-soft flex items-center justify-center shrink-0">
                <Icon className={`h-4 w-4 sm:h-5 sm:w-5 ${card.color}`} />
              </div>
              <div className="min-w-0">
                <p className="text-lg sm:text-xl font-light font-num text-ink">{card.value.toLocaleString()}</p>
                <p className="text-xs text-ink-3 truncate">{card.label}</p>
              </div>
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Submission Heatmap */}
        <div className="lg:col-span-2 bg-surface rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-border p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-serif text-ink font-medium">Submission Activity</h3>
            <span className="text-xs text-ink-4">Last 90 days</span>
          </div>
          <div className="flex gap-[3px] flex-wrap">
            {calendar.map((day: any) => (
              <div key={day.date} className="relative group">
                <HeatCell count={day.linkCount} />
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block z-10">
                  <div className="bg-action text-[#06121B] text-[10px] px-2 py-1 rounded-lg whitespace-nowrap">
                    {new Date(day.date).toLocaleDateString("en-IN", { month: "short", day: "numeric" })} — {day.linkCount} links
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 mt-3 text-[10px] text-ink-4">
            <span>Less</span>
            <div className="w-3 h-3 rounded-[2px] bg-muted" />
            <div className="w-3 h-3 rounded-[2px] bg-action-soft" />
            <div className="w-3 h-3 rounded-[2px] bg-action" />
            <div className="w-3 h-3 rounded-[2px] bg-[#1D2C3A]" />
            <span>More</span>
          </div>
        </div>

        {/* Platform Breakdown */}
        <div className="bg-surface rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-border p-5">
          <h3 className="font-serif text-ink font-medium mb-4">Platform Breakdown</h3>
          {platformBreakdown.length === 0 ? (
            <p className="text-sm text-ink-4">No platform data yet.</p>
          ) : (
            <div className="space-y-3">
              {platformBreakdown.map((p: any) => {
                const pct = stats.totalLinks > 0 ? Math.round((p.links / stats.totalLinks) * 100) : 0;
                return (
                  <div key={p.slug}>
                    <div className="flex items-center justify-between mb-1">
                      <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${getPlatformColor(p.slug)}`}>{p.name}</span>
                      <span className="text-xs text-ink-3">{p.links} links</span>
                    </div>
                    <div className="h-2 bg-muted rounded-full overflow-hidden">
                      <div className="h-full bg-action rounded-full transition-all" style={{ width: `${pct}%` }} />
                    </div>
                    <p className="text-[10px] text-ink-4 mt-0.5">{pct}% — {p.engagement.toLocaleString()} engagement</p>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Weekly Trend */}
      <div className="bg-surface rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-border p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-serif text-ink font-medium flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-ink-4" /> Weekly Trend
          </h3>
          <span className="text-xs text-ink-4">Last 12 weeks</span>
        </div>
        {/* min-w-0 on each column: flex items default to min-width:auto, so 12 columns
            of content-sized labels overflowed the container instead of shrinking. */}
        <div className="flex items-end gap-1.5 sm:gap-2 h-32">
          {weeklyTrend.map((w: any, i: number) => {
            const h = maxWeeklyLinks > 0 ? (w.links / maxWeeklyLinks) * 100 : 0;
            return (
              <div key={i} className="flex-1 min-w-0 flex flex-col items-center gap-1 group">
                <div className="relative w-full flex justify-center">
                  <div className="absolute -top-6 hidden group-hover:block">
                    <span className="bg-action text-[#06121B] text-[10px] px-2 py-0.5 rounded-lg whitespace-nowrap">
                      {w.reports}r / {w.links}l
                    </span>
                  </div>
                  <div
                    className="w-full max-w-[28px] rounded-t-lg bg-action hover:bg-action transition-all"
                    style={{ height: `${Math.max(h, 4)}%` }}
                  />
                </div>
                <span className="text-[9px] text-ink-4 truncate w-full text-center">{w.week}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent Reports */}
        <div className="bg-surface rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-border p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-serif text-ink font-medium">Recent Reports</h3>
            <Link href={`/reports/${id}`} className="text-xs text-ink hover:text-action font-medium">View all</Link>
          </div>
          {recentReports.length === 0 ? (
            <p className="text-sm text-ink-4">No reports yet.</p>
          ) : (
            <div className="space-y-2">
              {recentReports.map((r: any) => (
                <div key={r.id} className="flex items-center justify-between p-3 rounded-xl bg-surface border border-border hover:bg-action-soft transition-colors">
                  <div className="flex items-center gap-3">
                    <div className="h-9 w-9 rounded-lg bg-action-soft flex items-center justify-center text-sm font-bold text-ink">
                      {r.linkCount}
                    </div>
                    <div>
                      <p className="text-sm font-medium text-ink">
                        {new Date(r.date).toLocaleDateString("en-IN", { weekday: "short", month: "short", day: "numeric" })}
                      </p>
                      <div className="flex gap-1 mt-0.5">
                        {r.platforms.slice(0, 3).map((p: string) => (
                          <span key={p} className="text-[9px] text-ink-3">{p}</span>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-ink-3">{r.linkCount} links</p>
                    {r.totalEngagement > 0 && (
                      <p className="text-[10px] text-ink-4">{r.totalEngagement.toLocaleString()} views+likes+cmts</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Assigned Accounts */}
        <div className="bg-surface rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-border p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-serif text-ink font-medium flex items-center gap-2">
              <Globe className="h-4 w-4 text-ink-4" /> Assigned Accounts
            </h3>
            <span className="text-xs text-ink-4">{assignedAccounts.length} active</span>
          </div>
          {assignedAccounts.length === 0 ? (
            <p className="text-sm text-ink-4">No accounts assigned.</p>
          ) : (
            <div className="space-y-2">
              {assignedAccounts.map((acc: any) => (
                <div key={acc.id} className="flex items-center justify-between p-3 rounded-xl bg-surface border border-border">
                  <div className="flex items-center gap-3">
                    <div
                      className="h-9 w-9 rounded-full flex items-center justify-center text-white text-xs font-semibold"
                      style={{ background: "linear-gradient(135deg, #5B4BF5, #3023D0)" }}
                    >
                      {(acc.handle || acc.displayName)?.[0]?.toUpperCase()}
                    </div>
                    <div>
                      <p className="text-sm font-medium text-ink">{acc.handle || acc.displayName}</p>
                      <p className="text-xs text-ink-3">{acc.platform}</p>
                    </div>
                  </div>
                  {acc.followerCount != null && (
                    <span className="text-xs text-ink-3">{acc.followerCount.toLocaleString()} followers</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
