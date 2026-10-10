"use client";
import { useState, useEffect } from "react";
import Link from "next/link";
import { ArrowLeft, Flame, Link2, BarChart2, Target, TrendingUp, CalendarDays } from "lucide-react";
import { useAdminReports, useEmployeeReportStats } from "@/lib/hooks/use-reports";
import { useEmployee } from "@/lib/hooks/use-employees";
import { UserAvatar } from "@/components/user-avatar";
import { DsRangeFilters, presetStart, todayISO, rangeLabel } from "../_range";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";

// Dark-design platform palette (matches the converted reports pages).
const PLATFORM_COLOR: Record<string, string> = {
  instagram: "var(--hx-F472B6)",
  facebook: "var(--hx-6EB2FF)",
  youtube: "var(--hx-FB7185)",
  snapchat: "var(--hx-FACC15)",
  twitter: "var(--hx-38BDF8)",
  linkedin: "var(--hx-4AA3DF)",
  tiktok: "var(--hx-A7B3C2)",
};
const platformColor = (p?: string) => PLATFORM_COLOR[(p ?? "").toLowerCase()] ?? "var(--hx-E9BD62)";
const rgba = (hex: string, a: number) => {
  if (hex.startsWith("var(")) return `color-mix(in srgb, ${hex} ${Math.round(a * 100)}%, transparent)`; const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};

function PlatformBadge({ platform }: { platform?: string }) {
  const c = platformColor(platform);
  return (
    <span
      className="inline-flex items-center h-[22px] px-[9px] rounded-full border text-[10px] font-bold tracking-[.06em] uppercase whitespace-nowrap shrink-0"
      style={{ background: rgba(c, 0.1), borderColor: rgba(c, 0.3), color: c }}
    >
      {platform ?? "—"}
    </span>
  );
}

const CARD = "flex flex-col min-w-0 rounded-[16px] border border-[color:var(--hx-2A4658)] bg-ds-card overflow-hidden shadow-[0_12px_32px_rgba(0,0,0,.35)]";
const CARD_HEAD = "flex items-center justify-between gap-x-4 gap-y-2 min-h-[62px] px-5 sm:px-6 py-3 border-b border-ds-line flex-wrap";
const CARD_TITLE = "text-[15px] font-semibold tracking-[-.01em] text-ds-text";

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
  const c = { indigo: "var(--hx-6EB2FF)", terra: "var(--hx-E9BD62)", sage: "var(--hx-00D7A0)", attention: "var(--hx-F59E66)" }[color];
  return (
    <div className="flex flex-col gap-4 px-5 py-[18px] rounded-[16px] bg-ds-card border border-[color:var(--hx-2A4658)] min-w-0">
      <span className="h-[34px] w-[34px] rounded-[10px] grid place-items-center" style={{ background: rgba(c, 0.14), color: c }}>
        <Icon className="h-4 w-4" />
      </span>
      <span className="leading-[1.2] min-w-0">
        <span className="block text-[26px] sm:text-[28px] font-bold tracking-[-.04em] tabular-nums text-ds-text whitespace-nowrap truncate">{value}</span>
        <span className="block text-[12.5px] text-ds-t3">{label}</span>
        {sub && <span className="block mt-1 text-[11.5px] font-semibold" style={{ color: c }}>{sub}</span>}
      </span>
    </div>
  );
}

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-[10px] border border-ds-line2 bg-ds-inset px-3 py-2 text-[12px] text-ds-t2 shadow-[0_12px_32px_rgba(0,0,0,.45)]">
      <p className="font-semibold text-ds-text mb-0.5">{label}</p>
      <p className="tabular-nums"><b className="font-semibold text-ds-gold">{payload[0].value}</b> link{payload[0].value !== 1 ? "s" : ""}</p>
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
  // Show ~8 evenly-spaced x-axis labels regardless of window length (a fixed
  // interval hid most labels on short windows and crowded long ones).
  const xAxisInterval = Math.max(0, Math.ceil(chartData.length / 8) - 1);

  const platformBreakdown: { platform: string; count: number }[] = s?.platformBreakdown ?? [];

  return (
    <div className="pb-10">
      {/* Back link */}
      <section className="pt-[22px]">
        <Link href="/reports" className="inline-flex items-center gap-2 text-[13.5px] font-medium text-ds-t2 hover:text-ds-text transition-colors">
          <ArrowLeft className="h-[15px] w-[15px]" strokeWidth={1.8} /> Back to Reports
        </Link>
      </section>

      {/* Employee header */}
      <section className="pt-3.5 pb-[18px]">
        {empLoading ? (
          <div className="h-12 w-64 rounded-[10px] bg-ds-inset motion-safe:animate-pulse" />
        ) : (
          <div className="flex items-center gap-4 min-w-0">
            <UserAvatar
              name={employee?.name}
              imageUrl={employee?.profileImageUrl}
              size={12}
              className="ring-2 ring-ds-line2"
              textClassName="text-lg"
            />
            <div className="min-w-0">
              <h1 className="text-[28px] sm:text-[34px] font-bold tracking-[-.03em] text-ds-text leading-tight truncate">{employee?.name ?? "Employee"}</h1>
              <p className="mt-0.5 text-[13.5px] text-ds-t2 truncate">{employee?.email}</p>
            </div>
          </div>
        )}
      </section>

      {/* Date range filter */}
      <section className="flex items-end gap-x-5 gap-y-4 flex-wrap px-[22px] py-[18px] rounded-[16px] border border-[color:var(--hx-2A4658)] bg-ds-card">
        <DsRangeFilters
          startDate={startDate}
          endDate={endDate}
          onChange={(start, end) => { setStartDate(start); setEndDate(end); }}
        />
        <span className="ml-auto self-center inline-flex items-center gap-1.5 h-[30px] px-3 rounded-full bg-[rgba(233,189,98,.1)] border border-[rgba(233,189,98,.3)] text-ds-gold text-[12px] font-semibold whitespace-nowrap">
          <CalendarDays className="h-3.5 w-3.5" />
          {windowLabel}
        </span>
      </section>

      {/* Stats strip — scoped to the selected window */}
      <section className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mt-4">
        <StatCard label="Reports" value={statsLoading ? "—" : (s?.totalReports ?? 0)} icon={BarChart2} color="indigo" />
        <StatCard label="Links" value={statsLoading ? "—" : (s?.totalLinks ?? 0)} icon={Link2} color="terra" />
        <StatCard label="Current Streak" value={statsLoading ? "—" : (s?.currentStreak ?? 0)} icon={Flame} color="attention" sub={`Best: ${s?.longestStreak ?? 0} days`} />
        <StatCard label="Avg Links/Day" value={statsLoading ? "—" : (s?.avgLinksPerDay ?? 0)} icon={TrendingUp} color="sage" />
        <StatCard label="Submission Rate" value={statsLoading ? "—" : `${s?.submissionRate ?? 0}%`} icon={Target} color="indigo" />
      </section>

      {/* Daily trend chart for the selected window */}
      <section className={`${CARD} mt-4`}>
        <div className={CARD_HEAD}>
          <span className={CARD_TITLE}>Links — {windowLabel}</span>
          {s?.bestChannel && (
            <span className="text-[12px] text-ds-t3">
              Best channel: <b className="font-semibold text-ds-gold">{s.bestChannel.platform}</b> ({s.bestChannel.count})
            </span>
          )}
        </div>
        <div className="h-56 px-3 sm:px-5 pt-4 pb-3">
          {statsLoading ? (
            <div className="h-full flex items-center justify-center"><p className="text-[12.5px] text-ds-t3">Loading chart…</p></div>
          ) : chartData.length === 0 ? (
            <div className="h-full flex items-center justify-center"><p className="text-[12.5px] text-ds-t3">No data in this window</p></div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} barSize={12} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--hx-182C39)" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: "var(--hx-738395)" }} axisLine={false} tickLine={false} interval={xAxisInterval} />
                <YAxis tick={{ fontSize: 10, fill: "var(--hx-738395)" }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip content={<ChartTooltip />} cursor={{ fill: "rgba(233,189,98,0.06)" }} />
                <Bar dataKey="links" fill="var(--hx-E9BD62)" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </section>

      {/* Platform breakdown */}
      {platformBreakdown.length > 0 && (
        <section className={`${CARD} mt-4`}>
          <div className={CARD_HEAD}>
            <span className={CARD_TITLE}>Platform Breakdown · {windowLabel}</span>
            <span className="flex items-center gap-3.5 text-[12px] text-ds-t3">
              {s?.bestChannel && <span>Best: <b className="font-semibold text-ds-teal">{s.bestChannel.platform}</b></span>}
              {s?.worstChannel && <span>Least: <b className="font-semibold text-[color:var(--hx-FB7185)]">{s.worstChannel.platform}</b></span>}
            </span>
          </div>
          <div className="flex flex-wrap gap-2 p-5 sm:p-6">
            {platformBreakdown.map((p: any) => {
              const c = platformColor(p.platform);
              return (
                <div
                  key={p.platform}
                  className="inline-flex items-center gap-2 h-[32px] pl-3 pr-1.5 rounded-full border"
                  style={{ background: rgba(c, 0.08), borderColor: rgba(c, 0.28) }}
                >
                  <i className="h-2 w-2 rounded-full shrink-0" style={{ background: c }} />
                  <span className="text-[12.5px] font-semibold text-ds-text">{p.platform}</span>
                  <span className="inline-flex items-center h-[22px] px-2 rounded-full text-[11px] font-bold tabular-nums" style={{ background: rgba(c, 0.16), color: c }}>{p.count}</span>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Reports list — filtered by date range */}
      <section className="mt-6 space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <span className="text-[15px] font-semibold tracking-[-.01em] text-ds-text">
            Reports in selected range
          </span>
          {!reportsLoading && (
            <span className="text-[12px] text-ds-t3 tabular-nums">
              {reports.length} report{reports.length !== 1 ? "s" : ""}
              {reports.length > 0 && ` · ${reports.reduce((s: number, r: any) => s + (r.links?.length ?? 0), 0)} links`}
            </span>
          )}
        </div>

        {reportsLoading ? (
          <div className="space-y-3" aria-busy="true">
            {[0, 1, 2].map((i) => <div key={i} className="h-[72px] rounded-[16px] bg-ds-card border border-ds-line motion-safe:animate-pulse" />)}
          </div>
        ) : reports.length === 0 ? (
          <div className="rounded-[16px] border border-ds-line bg-ds-card px-6 py-10 text-center">
            <p className="text-[13px] text-ds-t2">No reports in this date range</p>
            <p className="text-[12px] text-ds-t3 mt-1">Try expanding the range using the date picker above</p>
          </div>
        ) : (
          reports.map((report: any) => {
            const linkCount = report.links?.length ?? 0;
            const reportDate = report.date ?? report.submittedAt;
            const submittedAt = report.submittedAt ?? report.createdAt ?? report.date;
            return (
              <div key={report.id} className="rounded-[16px] border border-ds-line bg-ds-card overflow-hidden">
                <div className="flex items-center justify-between gap-3 flex-wrap px-[22px] py-3.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="inline-flex items-center h-[30px] px-3 rounded-full bg-[rgba(233,189,98,.1)] border border-[rgba(233,189,98,.3)] text-ds-gold text-[12px] font-semibold whitespace-nowrap">{formatDate(reportDate)}</span>
                    <span className="inline-flex items-center gap-1.5 h-[30px] px-3 rounded-full bg-[rgba(0,215,160,.1)] border border-[rgba(0,215,160,.28)] text-ds-teal text-[12px] font-bold whitespace-nowrap">
                      <Link2 className="h-3.5 w-3.5" />
                      {linkCount} link{linkCount !== 1 ? "s" : ""}
                    </span>
                  </div>
                  <span className="text-[12px] text-ds-t3 whitespace-nowrap">Submitted {formatTime(submittedAt)}</span>
                </div>

                {report.notes && (
                  <p className="mx-[22px] mb-3 pl-3 border-l-2 border-ds-line3 text-[12.5px] text-ds-t2 italic break-words">{report.notes}</p>
                )}

                <div className="border-t border-ds-line py-1.5">
                  {(report.links ?? []).map((link: any, i: number) => (
                    <div key={link.id ?? i} className="flex items-center gap-3 min-h-[40px] py-1.5 px-[22px] text-[12.5px] hover:bg-[color:var(--hx-0A1620)] transition-colors">
                      <PlatformBadge platform={link.platform} />
                      <a
                        href={link.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex-1 min-w-0 overflow-hidden flex items-center gap-2 group/url"
                        title={link.url}
                      >
                        {link.accountName && (
                          <span className="font-semibold text-ds-t5 truncate min-w-0 max-w-[45%] sm:max-w-[200px] group-hover/url:text-ds-gold transition-colors">{link.accountName}</span>
                        )}
                        <span className="min-w-0 truncate text-ds-t3 group-hover/url:text-ds-gold group-hover/url:underline">{link.url}</span>
                      </a>
                    </div>
                  ))}
                </div>
              </div>
            );
          })
        )}
      </section>
    </div>
  );
}
