"use client";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft, FileText, Link2, Flame, TrendingUp, Eye, Heart, MessageCircle,
  Share2, Calendar, BarChart3, Globe, Briefcase,
} from "lucide-react";
import { useEmployeePerformance } from "@/lib/hooks/use-reports";
import { BoxesLoader } from "@/components/boxes-loader";

const rgba = (hex: string, a: number) => { if (hex.startsWith("var(")) return `color-mix(in srgb, ${hex} ${Math.round(a * 100)}%, transparent)`; const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };

const PLATFORM_COLORS: Record<string, string> = {
  instagram: "var(--hx-DD3FAF)",
  twitter: "var(--hx-6EB2FF)",
  x: "var(--hx-A7B3C2)",
  linkedin: "var(--hx-238BFF)",
  facebook: "var(--hx-2F86F0)",
  youtube: "var(--hx-E52D47)",
  snapchat: "var(--hx-E9BD62)",
  pinterest: "var(--hx-FB7185)",
  telegram: "var(--hx-00D7A0)",
};

function getPlatformColor(slug: string) {
  return PLATFORM_COLORS[slug?.toLowerCase()] ?? "var(--hx-E9BD62)";
}

const CARD = "rounded-[16px] border border-[color:var(--hx-2A4658)] bg-ds-card shadow-[0_12px_32px_rgba(0,0,0,.35)]";
const ROW = "flex items-center justify-between p-3 rounded-[12px] bg-ds-inset border border-ds-line";
const HEAT_STEPS = ["bg-[color:var(--hx-132430)]", "bg-ds-gold/30", "bg-ds-gold/60", "bg-ds-gold"];

function HeatCell({ count }: { count: number }) {
  const bg =
    count === 0
      ? HEAT_STEPS[0]
      : count <= 3
        ? HEAT_STEPS[1]
        : count <= 8
          ? HEAT_STEPS[2]
          : HEAT_STEPS[3];
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
        <BoxesLoader />
      </div>
    );
  }

  if (!perf) {
    return (
      <div className="space-y-4">
        <Link href="/employees" className="inline-flex items-center gap-1.5 pt-[22px] text-[12px] font-medium text-ds-t2 hover:text-ds-gold transition-colors">
          <ArrowLeft className="h-[13px] w-[13px]" strokeWidth={2} /> Back to Employees
        </Link>
        <p className="text-[13px] text-ds-t3">Employee not found.</p>
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
    { label: "Likes", value: stats.totalLikes, icon: Heart, color: "var(--hx-EC42B7)" },
    { label: "Comments", value: stats.totalComments, icon: MessageCircle, color: "var(--hx-238BFF)" },
    { label: "Shares", value: stats.totalShares, icon: Share2, color: "var(--hx-20C46E)" },
    { label: "Views", value: stats.totalViews, icon: Eye, color: "var(--hx-A849F5)" },
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
    <div className="space-y-6 pb-8 crx-animate-fade">
      {/* Header */}
      <div className="flex items-center gap-3 pt-[22px]">
        <Link href="/employees" className="inline-flex items-center gap-1.5 text-[12px] font-medium text-ds-t2 hover:text-ds-gold transition-colors">
          <ArrowLeft className="h-[13px] w-[13px]" strokeWidth={2} /> Employees
        </Link>
        <span className="text-ds-t4 text-[12px]">/</span>
        <Link href={`/reports/${id}`} className="text-[12px] font-medium text-ds-t2 hover:text-ds-gold transition-colors">
          Reports
        </Link>
      </div>

      {/* Stacks vertically on phones — the name + action button used to fight for
          the same row, wrapping the name to 2 lines and clipping the button. */}
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
        <div className="flex items-center gap-3 sm:gap-4 min-w-0">
          <div
            className="h-12 w-12 sm:h-16 sm:w-16 rounded-[16px] flex items-center justify-center text-lg sm:text-2xl font-bold shrink-0 border border-[rgba(233,189,98,.3)] bg-[rgba(233,189,98,.1)] text-ds-gold"
          >
            {employee.name?.[0]?.toUpperCase()}
          </div>
          <div className="min-w-0">
            <h1 className="m-0 text-[22px] sm:text-[30px] font-bold tracking-[-.03em] text-ds-text leading-tight truncate">{employee.name}</h1>
            <div className="flex flex-wrap items-center gap-2 sm:gap-3 mt-1">
              <span className="text-ds-t2 text-[12px] sm:text-[13.5px] truncate">{employee.email}</span>
              {employee.designation && (
                <span className="h-[22px] px-2.5 rounded-[11px] border border-ds-gold/30 bg-ds-gold/10 text-ds-gold text-[10.5px] font-semibold inline-flex items-center whitespace-nowrap">{employee.designation}</span>
              )}
              {employee.team && (
                <span className="text-[12px] text-ds-t3 flex items-center gap-1">
                  <Briefcase className="h-3 w-3" /> {employee.team}
                </span>
              )}
            </div>
            <div className="flex gap-1.5 mt-2">
              {employee.roles.map((role: string) => (
                <span key={role} className="h-5 px-2 rounded-[10px] border border-ds-line2 bg-ds-hover text-ds-t5 text-[10.5px] font-semibold inline-flex items-center whitespace-nowrap">{role}</span>
              ))}
              <span className={`inline-flex items-center gap-1.5 h-5 px-2 rounded-[10px] border text-[10.5px] font-semibold whitespace-nowrap ${
                employee.status === "ACTIVE" ? "border-ds-teal/30 bg-ds-teal/10 text-ds-teal" : "border-ds-line2 bg-ds-inset text-ds-t3"
              }`}><i className={`h-1.5 w-1.5 rounded-full ${employee.status === "ACTIVE" ? "bg-ds-teal" : "bg-ds-t3"}`} />{employee.status}</span>
            </div>
          </div>
        </div>
        <Link
          href={`/reports/${id}`}
          className="inline-flex items-center gap-1.5 h-[34px] px-4 rounded-[6px] border border-ds-gold bg-ds-gold/[.14] text-ds-gold text-[12px] font-semibold whitespace-nowrap transition-colors hover:bg-ds-gold/[.22] hover:text-ds-gold2 shrink-0 w-fit"
        >
          <FileText className="h-4 w-4" /> View All Reports
        </Link>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        {statCards.map((card, i) => {
          const Icon = card.icon;
          return (
            <div key={card.title} className={`rounded-[8px] bg-ds-card border border-ds-line p-4 sm:p-5 text-ds-text transition-colors hover:border-ds-line3 crx-animate-slide crx-delay-${Math.min(i + 1, 6)}`}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[12.5px] text-ds-t5">{card.title}</span>
                <Icon className="h-4 w-4 text-ds-t3" strokeWidth={1.8} />
              </div>
              <p className="text-[26px] font-semibold tracking-[-.02em] font-num text-ds-text leading-tight">{card.value}</p>
              <p className="text-[11px] text-ds-t3 mt-1">{card.sub}</p>
            </div>
          );
        })}
      </div>

      {/* Engagement Breakdown — 2 columns on phones so "Comments" doesn't clip to "Comme" */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
        {engagementCards.map((card) => {
          const Icon = card.icon;
          return (
            <div key={card.label} className="rounded-[8px] bg-ds-card border border-ds-line p-3 sm:p-4 flex items-center gap-2.5 sm:gap-3.5 min-w-0 transition-colors hover:border-ds-line3">
              <span className="h-9 w-9 sm:h-10 sm:w-10 rounded-[10px] grid place-items-center shrink-0" style={{ background: rgba(card.color, 0.13), color: card.color }}>
                <Icon className="h-4 w-4 sm:h-[18px] sm:w-[18px]" strokeWidth={1.8} />
              </span>
              <div className="min-w-0">
                <p className="text-[18px] sm:text-[22px] font-semibold tracking-[-.02em] font-num text-ds-text leading-tight">{card.value.toLocaleString()}</p>
                <p className="text-[12px] text-ds-t3 truncate">{card.label}</p>
              </div>
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Submission Heatmap */}
        <div className={`lg:col-span-2 ${CARD} p-5`}>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-[15px] font-semibold text-ds-text">Submission Activity</h3>
            <span className="text-[11px] text-ds-t3">Last 90 days</span>
          </div>
          <div className="flex gap-[3px] flex-wrap">
            {calendar.map((day: any) => (
              <div key={day.date} className="relative group">
                <HeatCell count={day.linkCount} />
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block z-10">
                  <div className="bg-ds-hover border border-ds-line2 text-ds-text text-[10px] px-2 py-1 rounded-[6px] whitespace-nowrap shadow-[0_8px_20px_rgba(0,0,0,.4)]">
                    {new Date(day.date).toLocaleDateString("en-IN", { month: "short", day: "numeric" })} — {day.linkCount} links
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 mt-3 text-[10px] text-ds-t3">
            <span>Less</span>
            {HEAT_STEPS.map((c) => (
              <div key={c} className={`w-3 h-3 rounded-[2px] ${c}`} />
            ))}
            <span>More</span>
          </div>
        </div>

        {/* Platform Breakdown */}
        <div className={`${CARD} p-5`}>
          <h3 className="text-[15px] font-semibold text-ds-text mb-4">Platform Breakdown</h3>
          {platformBreakdown.length === 0 ? (
            <p className="text-[13px] text-ds-t3">No platform data yet.</p>
          ) : (
            <div className="space-y-3">
              {platformBreakdown.map((p: any) => {
                const pct = stats.totalLinks > 0 ? Math.round((p.links / stats.totalLinks) * 100) : 0;
                return (
                  <div key={p.slug}>
                    <div className="flex items-center justify-between mb-1">
                      {(() => { const c = getPlatformColor(p.slug); return (
                        <span className="h-5 px-2 rounded-[10px] border text-[10.5px] font-semibold inline-flex items-center whitespace-nowrap" style={{ color: c, background: rgba(c, 0.1), borderColor: rgba(c, 0.3) }}>{p.name}</span>
                      ); })()}
                      <span className="text-[12px] text-ds-t2">{p.links} links</span>
                    </div>
                    <div className="h-2 bg-[color:var(--hx-132430)] rounded-full overflow-hidden">
                      <div className="h-full bg-ds-gold rounded-full transition-all" style={{ width: `${pct}%` }} />
                    </div>
                    <p className="text-[10.5px] text-ds-t3 mt-0.5">{pct}% — {p.engagement.toLocaleString()} engagement</p>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Weekly Trend */}
      <div className={`${CARD} p-5`}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-[15px] font-semibold text-ds-text flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-ds-t3" /> Weekly Trend
          </h3>
          <span className="text-[11px] text-ds-t3">Last 12 weeks</span>
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
                    <span className="bg-ds-hover border border-ds-line2 text-ds-text text-[10px] px-2 py-0.5 rounded-[6px] whitespace-nowrap shadow-[0_8px_20px_rgba(0,0,0,.4)]">
                      {w.reports}r / {w.links}l
                    </span>
                  </div>
                  <div
                    className="w-full max-w-[28px] rounded-t-[6px] bg-ds-gold/80 hover:bg-ds-gold2 transition-all"
                    style={{ height: `${Math.max(h, 4)}%` }}
                  />
                </div>
                <span className="text-[9px] text-ds-t3 truncate w-full text-center">{w.week}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent Reports */}
        <div className={`${CARD} p-5`}>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-[15px] font-semibold text-ds-text">Recent Reports</h3>
            <Link href={`/reports/${id}`} className="text-[12px] text-ds-gold hover:text-ds-gold2 font-semibold transition-colors">View all</Link>
          </div>
          {recentReports.length === 0 ? (
            <p className="text-[13px] text-ds-t3">No reports yet.</p>
          ) : (
            <div className="space-y-2">
              {recentReports.map((r: any) => (
                <div key={r.id} className={`${ROW} hover:bg-ds-hover hover:border-ds-line2 transition-colors`}>
                  <div className="flex items-center gap-3">
                    <div className="h-9 w-9 rounded-[10px] bg-ds-gold/[.13] flex items-center justify-center text-[13px] font-bold text-ds-gold">
                      {r.linkCount}
                    </div>
                    <div>
                      <p className="text-[13px] font-semibold text-ds-text">
                        {new Date(r.date).toLocaleDateString("en-IN", { weekday: "short", month: "short", day: "numeric" })}
                      </p>
                      <div className="flex gap-1 mt-0.5">
                        {r.platforms.slice(0, 3).map((p: string) => (
                          <span key={p} className="text-[10px] text-ds-t3">{p}</span>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-[12px] text-ds-t2">{r.linkCount} links</p>
                    {r.totalEngagement > 0 && (
                      <p className="text-[10.5px] text-ds-t3">{r.totalEngagement.toLocaleString()} views+likes+cmts</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Assigned Accounts */}
        <div className={`${CARD} p-5`}>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-[15px] font-semibold text-ds-text flex items-center gap-2">
              <Globe className="h-4 w-4 text-ds-t3" /> Assigned Accounts
            </h3>
            <span className="text-[11px] text-ds-t3">{assignedAccounts.length} active</span>
          </div>
          {assignedAccounts.length === 0 ? (
            <p className="text-[13px] text-ds-t3">No accounts assigned.</p>
          ) : (
            <div className="space-y-2">
              {assignedAccounts.map((acc: any) => (
                <div key={acc.id} className={ROW}>
                  <div className="flex items-center gap-3">
                    <div className="h-9 w-9 rounded-full border border-ds-line2 bg-[rgba(35,139,255,.14)] text-[color:var(--hx-6EB2FF)] flex items-center justify-center text-[12px] font-bold">
                      {(acc.handle || acc.displayName)?.[0]?.toUpperCase()}
                    </div>
                    <div>
                      <p className="text-[13px] font-semibold text-ds-text">{acc.handle || acc.displayName}</p>
                      <p className="text-[12px] text-ds-t3">{acc.platform}</p>
                    </div>
                  </div>
                  {acc.followerCount != null && (
                    <span className="text-[12px] text-ds-t2">{acc.followerCount.toLocaleString()} followers</span>
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
