"use client";
import { useState, useMemo } from "react";
import Link from "next/link";
import { ArrowLeft, TrendingUp, TrendingDown, Link2, Users, Trophy, AlertCircle, ChevronDown, ChevronUp, BarChart2, Eye, Heart, MessageCircle } from "lucide-react";
import { useLinksAnalytics, useLinksAllAccounts, useTopYouTubeLinks, useTopSnapchatLinks } from "@/lib/hooks/use-reports";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import { RangePills, presetStart, todayISO, rangeLabel } from "../_range";
import { ExportButton } from "../_export";
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid,
} from "recharts";

function fmtCompact(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtDate(d: string) {
  try { return new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short" }); }
  catch { return d; }
}

function fmtWeek(d: string) {
  try { return new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short" }); }
  catch { return d; }
}

function AreaTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-ink text-white text-xs rounded-lg px-3 py-2 shadow-lg">
      <p className="font-semibold mb-0.5">{label}</p>
      {payload.map((p: any) => (
        <p key={p.dataKey}>{p.name}: {p.value}</p>
      ))}
    </div>
  );
}

function BarTip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-ink text-white text-xs rounded-lg px-3 py-2 shadow-lg">
      <p className="font-semibold mb-0.5">Wk of {label}</p>
      <p>{payload[0].value} links</p>
    </div>
  );
}

export default function LinksAnalyticsPage() {
  usePageTitle("Links Analytics");

  // Default to last 30 days; pills + custom range drive every chart/stat on the page.
  const [startDate, setStartDate] = useState(() => presetStart(30));
  const [endDate, setEndDate] = useState(() => todayISO());

  const windowLabel = rangeLabel(startDate, endDate);

  const { data, isLoading } = useLinksAnalytics(startDate, endDate);
  const { data: accountsData, isLoading: accountsLoading } = useLinksAllAccounts(startDate, endDate);
  const [ytAllTime, setYtAllTime] = useState(false);
  const { data: topYouTubeData, isLoading: topYouTubeLoading } = useTopYouTubeLinks(
    ytAllTime ? undefined : startDate,
    ytAllTime ? undefined : endDate,
    20,
  );
  const [scAllTime, setScAllTime] = useState(false);
  const { data: topSnapchatData, isLoading: topSnapchatLoading } = useTopSnapchatLinks(
    scAllTime ? undefined : startDate,
    scAllTime ? undefined : endDate,
    20,
  );
  const allAccounts: any[] = useMemo(() => (accountsData as any)?.data ?? [], [accountsData]);
  const [expandedAccount, setExpandedAccount] = useState<string | null>(null);
  const d = (data as any)?.data;

  const rawDaily = d?.dailyTrend;
  const rawWeekly = d?.weeklyTrend;
  const dailyTrend = useMemo(() => (rawDaily ?? []).map((x: any) => ({
    date: fmtDate(x.date),
    links: x.linkCount,
    reports: x.reportCount,
  })), [rawDaily]);
  const weeklyTrend = useMemo(() => (rawWeekly ?? []).map((x: any) => ({
    week: fmtWeek(x.weekStart),
    links: x.linkCount,
  })), [rawWeekly]);
  const platformBreakdown: { platform: string; count: number; pct: number }[] = d?.platformBreakdown ?? [];
  const teamRanks: any[] = d?.teamRanks ?? [];
  const topSubmitters: any[] = d?.topSubmitters ?? [];
  const nonSubmitters: any[] = d?.nonSubmitters ?? [];
  const growthRate: number | null = d?.growthRate ?? null;
  const isPositiveGrowth = (growthRate ?? 0) >= 0;

  return (
    <div className="space-y-6 pop-in">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href="/reports" className="flex items-center gap-1 text-sm text-ink-4 hover:text-ink transition-colors">
          <ArrowLeft className="h-4 w-4" /> Reports
        </Link>
      </div>

      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold text-ink">Links Analytics</h1>
          <p className="text-sm text-ink-4 mt-0.5">Organisation-wide link submission insights · {windowLabel}</p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <ExportButton startDate={startDate} endDate={endDate} variant="light" />
          <RangePills
            startDate={startDate}
            endDate={endDate}
            onChange={(start, end) => { setStartDate(start); setEndDate(end); }}
          />
        </div>
      </div>

      {/* Top stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="v3-card-sm p-4 space-y-1">
          <div className="h-7 w-7 rounded-lg bg-terra-soft flex items-center justify-center">
            <Link2 className="h-3.5 w-3.5 text-terra" />
          </div>
          <p className="font-num text-2xl font-semibold text-ink leading-none pt-1">
            {isLoading ? "—" : (d?.totalLinks ?? 0)}
          </p>
          <p className="text-xs text-ink-4">Total Links</p>
        </div>
        <div className="v3-card-sm p-4 space-y-1">
          <div className="h-7 w-7 rounded-lg bg-indigo-soft flex items-center justify-center">
            <TrendingUp className="h-3.5 w-3.5 text-indigo" />
          </div>
          <p className="font-num text-2xl font-semibold text-ink leading-none pt-1">
            {isLoading ? "—" : (d?.avgLinksPerDay ?? 0)}
          </p>
          <p className="text-xs text-ink-4">Avg Links/Day</p>
        </div>
        <div className="v3-card-sm p-4 space-y-1">
          <div className={`h-7 w-7 rounded-lg flex items-center justify-center ${isPositiveGrowth ? "bg-sage-soft" : "bg-attention/10"}`}>
            {isPositiveGrowth
              ? <TrendingUp className="h-3.5 w-3.5 text-sage" />
              : <TrendingDown className="h-3.5 w-3.5 text-attention" />
            }
          </div>
          <p className={`font-num text-2xl font-semibold leading-none pt-1 ${isPositiveGrowth ? "text-sage" : "text-attention"}`}>
            {isLoading ? "—" : growthRate === null ? "—" : `${isPositiveGrowth ? "+" : ""}${growthRate}%`}
          </p>
          <p className="text-xs text-ink-4">Growth vs Previous Period</p>
        </div>
        <div className="v3-card-sm p-4 space-y-1">
          <div className="h-7 w-7 rounded-lg bg-attention/10 flex items-center justify-center">
            <AlertCircle className="h-3.5 w-3.5 text-attention" />
          </div>
          <p className="font-num text-2xl font-semibold text-ink leading-none pt-1">
            {isLoading ? "—" : nonSubmitters.length}
          </p>
          <p className="text-xs text-ink-4">Non-Submitters</p>
        </div>
      </div>

      {/* Daily trend */}
      <div className="v3-card p-5 space-y-3">
        <p className="font-semibold text-ink">Daily Links Trend</p>
        <div className="h-52">
          {isLoading ? (
            <div className="h-full flex items-center justify-center"><p className="text-xs text-ink-4">Loading…</p></div>
          ) : dailyTrend.length === 0 ? (
            <div className="h-full flex items-center justify-center"><p className="text-xs text-ink-4">No data in range</p></div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={dailyTrend} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
                <defs>
                  <linearGradient id="linkGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--color-terra, #c97c3a)" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="var(--color-terra, #c97c3a)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 9, fill: "var(--color-ink-4,#888)" }} axisLine={false} tickLine={false} interval={Math.max(0, Math.ceil(dailyTrend.length / 8) - 1)} />
                <YAxis tick={{ fontSize: 9, fill: "var(--color-ink-4,#888)" }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip content={<AreaTooltip />} />
                <Area type="monotone" dataKey="links" name="Links" stroke="var(--color-terra,#c97c3a)" fill="url(#linkGrad)" strokeWidth={2} dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Weekly trend */}
        <div className="v3-card p-5 space-y-3">
          <p className="font-semibold text-ink">Weekly Trend</p>
          <div className="h-44">
            {isLoading ? (
              <div className="h-full flex items-center justify-center"><p className="text-xs text-ink-4">Loading…</p></div>
            ) : weeklyTrend.length === 0 ? (
              <div className="h-full flex items-center justify-center"><p className="text-xs text-ink-4">No data</p></div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={weeklyTrend} barSize={20} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" vertical={false} />
                  <XAxis dataKey="week" tick={{ fontSize: 9, fill: "var(--color-ink-4,#888)" }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 9, fill: "var(--color-ink-4,#888)" }} axisLine={false} tickLine={false} allowDecimals={false} />
                  <Tooltip content={<BarTip />} cursor={{ fill: "rgba(0,0,0,0.04)" }} />
                  <Bar dataKey="links" fill="var(--color-indigo,#5b4bf5)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* Platform breakdown */}
        <div className="v3-card p-5 space-y-3">
          <div className="flex items-center justify-between">
            <p className="font-semibold text-ink">Platform Breakdown</p>
            <div className="text-xs text-ink-4 space-x-3">
              {d?.bestChannel && <span>Best: <span className="font-semibold text-sage">{d.bestChannel.platform.charAt(0).toUpperCase() + d.bestChannel.platform.slice(1)}</span></span>}
              {d?.worstChannel && <span>Least: <span className="font-semibold text-attention">{d.worstChannel.platform.charAt(0).toUpperCase() + d.worstChannel.platform.slice(1)}</span></span>}
            </div>
          </div>
          {isLoading ? (
            <p className="text-xs text-ink-4">Loading…</p>
          ) : platformBreakdown.length === 0 ? (
            <p className="text-xs text-ink-4">No platform data</p>
          ) : (
            <div className="space-y-2">
              {platformBreakdown.map((p) => (
                <div key={p.platform}>
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="text-xs font-medium text-ink">{p.platform.charAt(0).toUpperCase() + p.platform.slice(1)}</span>
                    <span className="text-xs text-ink-4">{p.count} ({p.pct}%)</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-ink/8 overflow-hidden">
                    <div className="h-full rounded-full bg-terra transition-all duration-500" style={{ width: `${p.pct}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Team ranks */}
        <div className="v3-card p-5 space-y-3">
          <div className="flex items-center gap-2">
            <Trophy className="h-4 w-4 text-action-deep" />
            <p className="font-semibold text-ink">Team Rankings</p>
          </div>
          {isLoading ? (
            <p className="text-xs text-ink-4">Loading…</p>
          ) : teamRanks.length === 0 ? (
            <p className="text-xs text-ink-4">No team data in range</p>
          ) : (
            <div className="space-y-2">
              {teamRanks.map((t, i) => (
                <div key={t.teamId} className="flex items-center gap-3">
                  <span className="text-xs font-bold text-ink-4 w-5 text-right">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-ink truncate">{t.teamName}</p>
                    <p className="text-[10px] text-ink-4">{t.memberCount} members · {t.avgLinksPerMember} avg/member</p>
                  </div>
                  <span className="text-sm font-semibold text-terra">{t.totalLinks}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Top submitters */}
        <div className="v3-card p-5 space-y-3">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-indigo" />
            <p className="font-semibold text-ink">Top Submitters</p>
          </div>
          {isLoading ? (
            <p className="text-xs text-ink-4">Loading…</p>
          ) : topSubmitters.length === 0 ? (
            <p className="text-xs text-ink-4">No submissions in range</p>
          ) : (
            <div className="space-y-2">
              {topSubmitters.map((emp, i) => (
                <div key={emp.employeeId} className="flex items-center gap-3">
                  <span className="text-xs font-bold text-ink-4 w-5 text-right">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <Link href={`/reports/${emp.employeeId}`} className="text-sm font-medium text-ink hover:text-indigo transition-colors truncate block">
                      {emp.name}
                    </Link>
                    <p className="text-[10px] text-ink-4">{emp.reportCount} reports</p>
                  </div>
                  <span className="text-sm font-semibold text-indigo">{emp.totalLinks}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Non-submitters */}
      {nonSubmitters.length > 0 && (
        <div className="v3-card p-5 space-y-3">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-attention" />
            <p className="font-semibold text-ink">No Submissions in Range</p>
            <span className="ml-auto text-xs text-attention font-semibold">{nonSubmitters.length} employee{nonSubmitters.length !== 1 ? "s" : ""}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {nonSubmitters.map((emp) => (
              <Link
                key={emp.employeeId}
                href={`/employees/${emp.employeeId}`}
                className="flex items-center gap-1.5 bg-attention/8 text-attention rounded-full px-3 py-1 text-xs font-medium hover:bg-attention/15 transition-colors"
              >
                {emp.name}
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* By Account breakdown */}
      <div className="v3-card p-5 space-y-3">
        <div className="flex items-center gap-2">
          <BarChart2 className="h-4 w-4 text-indigo" />
          <p className="font-semibold text-ink">By Account</p>
          <span className="ml-auto text-xs text-ink-4">{allAccounts.length} channel{allAccounts.length !== 1 ? "s" : ""} active in range</span>
        </div>

        {accountsLoading ? (
          <p className="text-xs text-ink-4">Loading…</p>
        ) : allAccounts.length === 0 ? (
          <p className="text-xs text-ink-4">No account-linked submissions in this range</p>
        ) : (
          <div className="space-y-1">
            {allAccounts.map((account, i) => {
              const isExpanded = expandedAccount === account.accountId;
              return (
                <div key={account.accountId} className="rounded-xl border border-ink/8 overflow-hidden">
                  {/* Account row */}
                  <button
                    onClick={() => setExpandedAccount(isExpanded ? null : account.accountId)}
                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-ink/3 transition-colors text-left"
                  >
                    <span className="text-xs font-bold text-ink-4 w-5 text-right shrink-0">{i + 1}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-ink truncate">{account.displayName}</span>
                        <span className="text-xs text-ink-4 bg-ink/5 rounded-full px-2 py-0.5 shrink-0">{account.platform}</span>
                        <span className="text-[10px] text-ink-4 font-mono truncate">@{account.handle}</span>
                      </div>
                      <p className="text-[10px] text-ink-4 mt-0.5">
                        {account.employeeCount} employee{account.employeeCount !== 1 ? "s" : ""}
                        {account.topEmployee ? ` · top: ${account.topEmployee.name} (${account.topEmployee.totalLinks})` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-sm font-semibold text-terra">{account.totalLinks}</span>
                      <span className="text-xs text-ink-4">links</span>
                      {isExpanded
                        ? <ChevronUp className="h-3.5 w-3.5 text-ink-4" />
                        : <ChevronDown className="h-3.5 w-3.5 text-ink-4" />
                      }
                    </div>
                  </button>

                  {/* Per-employee breakdown */}
                  {isExpanded && (
                    <div className="border-t border-ink/8 bg-ink/2 px-4 py-3 space-y-2">
                      {account.employees.map((emp: any) => (
                        <div key={emp.employeeId} className="flex items-center gap-3">
                          <div
                            className="h-6 w-6 rounded-full flex items-center justify-center text-white text-[10px] font-semibold shrink-0"
                            style={{ background: "linear-gradient(135deg, #5B4BF5, #3023D0)" }}
                          >
                            {emp.name?.[0]?.toUpperCase()}
                          </div>
                          <Link
                            href={`/reports/${emp.employeeId}`}
                            className="text-xs font-medium text-ink hover:text-indigo transition-colors w-32 truncate shrink-0"
                          >
                            {emp.name}
                          </Link>
                          <div className="flex-1 h-1.5 rounded-full bg-ink/8 overflow-hidden">
                            <div
                              className="h-full rounded-full bg-indigo transition-all duration-500"
                              style={{ width: `${emp.pct}%` }}
                            />
                          </div>
                          <span className="text-xs text-ink-4 w-8 text-right shrink-0">{emp.pct}%</span>
                          <span className="text-xs font-semibold text-ink w-8 text-right shrink-0">{emp.totalLinks}</span>
                        </div>
                      ))}
                      <div className="pt-1 border-t border-ink/8 flex items-center justify-between">
                        <span className="text-[10px] text-ink-4">Total for this channel</span>
                        <Link
                          href={`/accounts/${account.accountId}`}
                          className="text-[10px] text-indigo hover:underline"
                        >
                          View account →
                        </Link>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Top YouTube Links */}
        {(() => {
          const topLinks = (topYouTubeData as any)?.data ?? [];
          if (!topYouTubeLoading && topLinks.length === 0) return null;
          const windowLbl = rangeLabel(startDate, endDate);
          return (
            <div className="bg-white rounded-2xl border border-[#E8E0D0] shadow-[0_2px_16px_rgba(0,0,0,0.05)]">
              <div className="px-6 py-4 border-b border-[#F0EAD8] flex items-center gap-2 flex-wrap">
                <div className="h-8 w-8 rounded-lg bg-red-50 flex items-center justify-center shrink-0">
                  <Eye className="h-4 w-4 text-red-500" />
                </div>
                <h3 className="font-serif text-[#1A1A1A] font-medium">Top YouTube Links</h3>
                <div className="flex items-center gap-1 ml-2">
                  <button
                    onClick={() => setYtAllTime(false)}
                    className={`text-[11px] px-2.5 py-0.5 rounded-full border transition-colors ${!ytAllTime ? "bg-[#1A1A1A] text-white border-[#1A1A1A]" : "text-[#7A7A7A] border-[#E8E0D0] hover:border-[#1A1A1A]"}`}
                  >
                    {windowLbl}
                  </button>
                  <button
                    onClick={() => setYtAllTime(true)}
                    className={`text-[11px] px-2.5 py-0.5 rounded-full border transition-colors ${ytAllTime ? "bg-[#1A1A1A] text-white border-[#1A1A1A]" : "text-[#7A7A7A] border-[#E8E0D0] hover:border-[#1A1A1A]"}`}
                  >
                    All time
                  </button>
                </div>
                <span className="ml-auto text-[10px] text-[#B0B0B0] shrink-0">YouTube only · updates every 6h</span>
              </div>
              {topYouTubeLoading ? (
                <div className="px-6 py-4 text-xs text-[#B0B0B0]">Loading…</div>
              ) : (
                <>
                  <div className="px-6 py-2 grid grid-cols-[1.5rem_1fr_8rem_5rem_5rem_5rem] gap-3 text-[10px] font-medium text-[#B0B0B0] uppercase tracking-wide border-b border-[#F5F0E8]">
                    <span>#</span>
                    <span>Link</span>
                    <span>Employee</span>
                    <span className="text-right">Views</span>
                    <span className="text-right">Likes</span>
                    <span className="text-right">Comments</span>
                  </div>
                  <ul className="divide-y divide-[#F5F0E8]">
                    {topLinks.map((link: any, i: number) => (
                      <li key={`${link.linkId ?? link.url}-${i}`} className="px-6 py-3 grid grid-cols-[1.5rem_1fr_8rem_5rem_5rem_5rem] gap-3 items-center">
                        <span className="text-xs font-medium text-[#B0B0B0]">{i + 1}</span>
                        <a href={link.url} target="_blank" rel="noopener noreferrer" className="text-xs text-[#1A1A1A] hover:underline truncate min-w-0" title={link.url}>{link.url}</a>
                        <span className="text-xs text-[#7A7A7A] truncate">{link.employeeName}</span>
                        <span className="inline-flex items-center justify-end gap-1 text-[11px] font-semibold text-rose-700"><Eye className="h-3 w-3 shrink-0" />{fmtCompact(link.views)}</span>
                        <span className="inline-flex items-center justify-end gap-1 text-[11px] font-semibold text-pink-600"><Heart className="h-3 w-3 shrink-0" />{fmtCompact(link.likes)}</span>
                        <span className="inline-flex items-center justify-end gap-1 text-[11px] font-semibold text-slate-500"><MessageCircle className="h-3 w-3 shrink-0" />{fmtCompact(link.comments)}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          );
        })()}

        {/* Top Snapchat Links */}
        {(() => {
          const topLinks = (topSnapchatData as any)?.data ?? [];
          if (!topSnapchatLoading && topLinks.length === 0) return null;
          const windowLbl = rangeLabel(startDate, endDate);
          return (
            <div className="bg-white rounded-2xl border border-[#E8E0D0] shadow-[0_2px_16px_rgba(0,0,0,0.05)]">
              <div className="px-6 py-4 border-b border-[#F0EAD8] flex items-center gap-2 flex-wrap">
                <div className="h-8 w-8 rounded-lg bg-yellow-50 flex items-center justify-center shrink-0">
                  {/* Snapchat ghost icon */}
                  <svg className="h-4 w-4 text-yellow-500" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12.002 2C8.756 2 6.6 4.09 6.6 7.2v.617c-.43.19-.9.127-1.37.064C4.8 7.818 4.37 7.8 4 7.98c-.55.26-.58.94-.12 1.24.1.063.82.44 1.32 1.56.04.094.062.18.062.25 0 .063-.02.13-.055.2-.256.47-.9.73-1.44.87-.63.162-.9.51-.82.88.094.44.596.7 1.22.7.11 0 .23-.01.35-.03.28-.043.55-.07.78-.07.18 0 .34.018.48.055-.04.44-.065.89-.065 1.34 0 2.547 2.14 4.518 5.29 4.518.22 0 .44-.01.65-.03.142.23.396.36.67.36h.336c.275 0 .53-.13.67-.36.213.02.432.03.652.03 3.15 0 5.29-1.97 5.29-4.518 0-.45-.026-.9-.065-1.34.14-.037.3-.055.48-.055.228 0 .5.027.777.07.12.02.24.03.353.03.622 0 1.125-.26 1.218-.7.08-.37-.19-.718-.82-.88-.54-.14-1.183-.4-1.44-.87a.42.42 0 0 1-.055-.2c0-.07.023-.156.063-.25.497-1.12 1.22-1.497 1.32-1.56.457-.3.43-.98-.12-1.24-.37-.18-.8-.162-1.23-.1-.467.064-.937.127-1.37-.063V7.2C17.4 4.09 15.245 2 12.002 2Z" />
                  </svg>
                </div>
                <h3 className="font-serif text-[#1A1A1A] font-medium">Top Snapchat Links</h3>
                <div className="flex items-center gap-1 ml-2">
                  <button
                    onClick={() => setScAllTime(false)}
                    className={`text-[11px] px-2.5 py-0.5 rounded-full border transition-colors ${!scAllTime ? "bg-[#1A1A1A] text-white border-[#1A1A1A]" : "text-[#7A7A7A] border-[#E8E0D0] hover:border-[#1A1A1A]"}`}
                  >
                    {windowLbl}
                  </button>
                  <button
                    onClick={() => setScAllTime(true)}
                    className={`text-[11px] px-2.5 py-0.5 rounded-full border transition-colors ${scAllTime ? "bg-[#1A1A1A] text-white border-[#1A1A1A]" : "text-[#7A7A7A] border-[#E8E0D0] hover:border-[#1A1A1A]"}`}
                  >
                    All time
                  </button>
                </div>
                <span className="ml-auto text-[10px] text-[#B0B0B0] shrink-0">Snapchat · ranked by submissions</span>
              </div>
              {topSnapchatLoading ? (
                <div className="px-6 py-4 text-xs text-[#B0B0B0]">Loading…</div>
              ) : (
                <>
                  <div className="px-6 py-2 grid grid-cols-[1.5rem_1fr_1fr_6rem] gap-3 text-[10px] font-medium text-[#B0B0B0] uppercase tracking-wide border-b border-[#F5F0E8]">
                    <span>#</span>
                    <span>Link</span>
                    <span>Submitted by</span>
                    <span className="text-right">Submissions</span>
                  </div>
                  <ul className="divide-y divide-[#F5F0E8]">
                    {topLinks.map((link: any, i: number) => (
                      <li key={`${link.url}-${i}`} className="px-6 py-3 grid grid-cols-[1.5rem_1fr_1fr_6rem] gap-3 items-center">
                        <span className="text-xs font-medium text-[#B0B0B0]">{i + 1}</span>
                        <a href={link.url} target="_blank" rel="noopener noreferrer" className="text-xs text-[#1A1A1A] hover:underline truncate min-w-0" title={link.url}>{link.url}</a>
                        <span className="text-xs text-[#7A7A7A] truncate">{(link.employees ?? []).slice(0, 3).join(", ")}{(link.employees ?? []).length > 3 ? ` +${link.employees.length - 3}` : ""}</span>
                        <span className="inline-flex items-center justify-end gap-1 text-[11px] font-semibold text-yellow-700">
                          <Link2 className="h-3 w-3 shrink-0" />
                          {link.submissionCount}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          );
        })()}
      </div>
    </div>
  );
}
