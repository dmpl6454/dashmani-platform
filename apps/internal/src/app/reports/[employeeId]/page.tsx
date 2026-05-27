"use client";
import { useState, useEffect } from "react";
import Link from "next/link";
import { ArrowLeft, Flame, Link2, BarChart2, Target, TrendingUp, CalendarDays } from "lucide-react";
import { useAdminReports, useEmployeeReportStats } from "@/lib/hooks/use-reports";
import { useEmployee } from "@/lib/hooks/use-employees";
import { UserAvatar } from "@/components/user-avatar";
import { RangePills, presetStart, todayISO, rangeLabel } from "../_range";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";

const PLATFORM_BADGE: Record<string, string> = {
  instagram: "bg-pink-100 text-pink-700",
  twitter: "bg-sky-100 text-sky-700",
  linkedin: "bg-blue-50 text-blue-700",
  facebook: "bg-blue-50 text-blue-700",
  youtube: "bg-red-50 text-red-700",
  tiktok: "bg-gray-100 text-gray-800",
  snapchat: "bg-yellow-50 text-yellow-700",
};
function platformBadgeClass(platform: string) {
  return PLATFORM_BADGE[(platform ?? "").toLowerCase()] ?? "bg-muted text-ink-3";
}

function formatTime(dateStr: string) {
  try { return new Date(dateStr).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
  catch { return ""; }
}

function formatDate(dateStr: string) {
  try { return new Date(dateStr).toLocaleDateString([], { weekday: "short", year: "numeric", month: "short", day: "numeric" }); }
  catch { return dateStr; }
}

function StatCard({ label, value, icon: Icon, sub, color = "indigo" }: {
  label: string; value: string | number; icon: any; sub?: string; color?: "indigo" | "terra" | "sage" | "attention";
}) {
  const bg = { indigo: "bg-indigo-soft", terra: "bg-terra-soft", sage: "bg-sage-soft", attention: "bg-attention/10" }[color];
  const fg = { indigo: "text-indigo", terra: "text-terra", sage: "text-sage", attention: "text-attention" }[color];
  return (
    <div className="v3-card-sm p-4 flex flex-col gap-1">
      <div className={`h-8 w-8 rounded-lg flex items-center justify-center ${bg}`}>
        <Icon className={`h-4 w-4 ${fg}`} />
      </div>
      <p className="font-display text-2xl font-semibold text-ink leading-none mt-1">{value}</p>
      <p className="text-xs text-ink-4 font-medium">{label}</p>
      {sub && <p className={`text-[10px] font-semibold ${fg}`}>{sub}</p>}
    </div>
  );
}

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-ink text-white text-xs rounded-lg px-3 py-2 shadow-lg">
      <p className="font-semibold mb-0.5">{label}</p>
      <p>{payload[0].value} link{payload[0].value !== 1 ? "s" : ""}</p>
    </div>
  );
}

export default function EmployeeReportsPage({ params }: { params: { employeeId: string } }) {
  const { employeeId } = params;

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  }, [employeeId]);

  // Default to last 30 days; the pills/custom range drive every stat, chart and list.
  const [startDate, setStartDate] = useState(() => presetStart(30));
  const [endDate, setEndDate] = useState(() => todayISO());

  const { data: employeeData, isLoading: empLoading } = useEmployee(employeeId);
  const { data: reportsData, isLoading: reportsLoading } = useAdminReports({ employeeId, startDate, endDate });
  const { data: statsData, isLoading: statsLoading } = useEmployeeReportStats(employeeId, startDate, endDate);

  const employee = (employeeData as any)?.data;
  const reports = (reportsData as any)?.data ?? [];
  const s = (statsData as any)?.data;

  const windowLabel = rangeLabel(startDate, endDate);

  const dailyTrend: { date: string; linkCount: number }[] = s?.dailyTrend ?? [];
  const chartData = dailyTrend.map((d) => ({
    date: new Date(d.date).toLocaleDateString("en-IN", { day: "numeric", month: "short" }),
    links: d.linkCount,
  }));

  const platformBreakdown: { platform: string; count: number }[] = s?.platformBreakdown ?? [];

  return (
    <div className="space-y-6 pop-in">
      {/* Back link */}
      <Link href="/reports" className="flex items-center gap-1 text-sm text-ink-4 hover:text-ink transition-colors">
        <ArrowLeft className="h-4 w-4" /> Back to Reports
      </Link>

      {/* Employee header */}
      <div>
        {empLoading ? (
          <div className="h-8 w-48 bg-muted animate-pulse rounded-lg" />
        ) : (
          <div className="flex items-center gap-4">
            <UserAvatar
              name={employee?.name}
              imageUrl={employee?.profileImageUrl}
              size={12}
              textClassName="text-lg"
            />
            <div>
              <h1 className="font-display text-2xl font-semibold text-ink">{employee?.name ?? "Employee"}</h1>
              <p className="text-sm text-ink-4">{employee?.email}</p>
            </div>
          </div>
        )}
      </div>

      {/* Date range filter */}
      <div className="v3-card p-4 space-y-3">
        <div className="flex items-center gap-2">
          <CalendarDays className="h-4 w-4 text-indigo" />
          <p className="text-sm font-semibold text-ink">Date Range</p>
          <span className="ml-auto text-xs font-medium text-ink-4 bg-ink/5 px-2.5 py-1 rounded-full">{windowLabel}</span>
        </div>
        <RangePills
          startDate={startDate}
          endDate={endDate}
          onChange={(start, end) => { setStartDate(start); setEndDate(end); }}
        />
      </div>

      {/* Stats strip — scoped to the selected window */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <StatCard label="Reports" value={statsLoading ? "—" : (s?.totalReports ?? 0)} icon={BarChart2} color="indigo" />
        <StatCard label="Links" value={statsLoading ? "—" : (s?.totalLinks ?? 0)} icon={Link2} color="terra" />
        <StatCard label="Current Streak" value={statsLoading ? "—" : (s?.currentStreak ?? 0)} icon={Flame} color="attention" sub={`Best: ${s?.longestStreak ?? 0} days`} />
        <StatCard label="Avg Links/Day" value={statsLoading ? "—" : (s?.avgLinksPerDay ?? 0)} icon={TrendingUp} color="sage" />
        <StatCard label="Submission Rate" value={statsLoading ? "—" : `${s?.submissionRate ?? 0}%`} icon={Target} color="indigo" />
      </div>

      {/* Daily trend chart for the selected window */}
      <div className="v3-card p-5 space-y-3">
        <div className="flex items-center justify-between">
          <p className="font-semibold text-ink">Links — {windowLabel}</p>
          {s?.bestChannel && (
            <span className="text-xs text-ink-4">
              Best channel: <span className="font-semibold text-terra">{s.bestChannel.platform}</span> ({s.bestChannel.count})
            </span>
          )}
        </div>
        <div className="h-48">
          {statsLoading ? (
            <div className="h-full flex items-center justify-center"><p className="text-xs text-ink-4">Loading chart…</p></div>
          ) : chartData.length === 0 ? (
            <div className="h-full flex items-center justify-center"><p className="text-xs text-ink-4">No data in this window</p></div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} barSize={12} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 9, fill: "var(--color-ink-4, #888)" }} axisLine={false} tickLine={false} interval={4} />
                <YAxis tick={{ fontSize: 9, fill: "var(--color-ink-4, #888)" }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip content={<ChartTooltip />} cursor={{ fill: "rgba(0,0,0,0.04)" }} />
                <Bar dataKey="links" fill="var(--color-terra, #c97c3a)" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Platform breakdown */}
      {platformBreakdown.length > 0 && (
        <div className="v3-card p-5 space-y-3">
          <div className="flex items-center justify-between">
            <p className="font-semibold text-ink">Platform Breakdown · {windowLabel}</p>
            <div className="flex items-center gap-4 text-xs text-ink-4">
              {s?.bestChannel && <span>Best: <span className="font-semibold text-sage">{s.bestChannel.platform}</span></span>}
              {s?.worstChannel && <span>Least: <span className="font-semibold text-attention">{s.worstChannel.platform}</span></span>}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {platformBreakdown.map((p: any) => (
              <div key={p.platform} className="flex items-center gap-2 bg-muted/50 rounded-full px-3 py-1.5">
                <span className="text-xs font-semibold text-ink">{p.platform}</span>
                <span className="text-[10px] bg-ink/10 rounded-full px-2 py-0.5 font-bold text-ink-3">{p.count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Reports list — filtered by date range */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-ink">
            Reports in selected range
          </p>
          {!reportsLoading && (
            <span className="text-xs text-ink-4">
              {reports.length} report{reports.length !== 1 ? "s" : ""}
              {reports.length > 0 && ` · ${reports.reduce((s: number, r: any) => s + (r.links?.length ?? 0), 0)} links`}
            </span>
          )}
        </div>

        {reportsLoading ? (
          <p className="text-sm text-ink-4">Loading reports...</p>
        ) : reports.length === 0 ? (
          <div className="v3-card p-8 text-center">
            <p className="text-sm text-ink-4">No reports in this date range</p>
            <p className="text-xs text-ink-4 mt-1">Try expanding the range using the date picker above</p>
          </div>
        ) : (
          reports.map((report: any) => {
            const linkCount = report.links?.length ?? 0;
            const reportDate = report.date ?? report.submittedAt;
            const submittedAt = report.submittedAt ?? report.createdAt ?? report.date;
            return (
              <div key={report.id} className="v3-card p-5 space-y-3">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <span className="rounded-full px-3 py-1 text-xs font-medium bg-indigo-soft text-indigo">{formatDate(reportDate)}</span>
                    <span className="text-xs text-ink-4">{linkCount} link{linkCount !== 1 ? "s" : ""}</span>
                  </div>
                  <span className="text-xs text-ink-4">Submitted {formatTime(submittedAt)}</span>
                </div>

                {report.notes && (
                  <p className="text-sm text-ink-3 italic border-l-2 border-ink/10 pl-3">{report.notes}</p>
                )}

                <div className="space-y-1">
                  {(report.links ?? []).map((link: any, i: number) => (
                    <div key={link.id ?? i} className="flex items-center gap-2 py-1 px-2 rounded-lg hover:bg-muted/40 transition-colors">
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${platformBadgeClass(link.platform)}`}>
                        {link.platform ?? "—"}
                      </span>
                      <a
                        href={link.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex-1 min-w-0 flex items-center gap-2 group/url"
                        title={link.url}
                      >
                        {link.accountName && (
                          <span className="text-xs font-medium text-ink shrink-0 group-hover/url:text-indigo transition-colors">{link.accountName}</span>
                        )}
                        <span className="text-[10px] text-ink-4 truncate group-hover/url:underline">{link.url}</span>
                      </a>
                    </div>
                  ))}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
