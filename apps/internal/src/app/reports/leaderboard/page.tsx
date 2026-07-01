"use client";
import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { Input } from "@dashmani/ui";
import { Trophy, Flame, Users, FileText, Link2, Eye, Heart, MessageCircle, TrendingUp, Info } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { UserAvatar } from "@/components/user-avatar";

const MEDALS = ["#1", "#2", "#3"];

// Compact number formatter for engagement (1.2M, 45.3k, 980). Null-safe.
const fmtCompact = (n: number | null | undefined): string => {
  const v = n ?? 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(v);
};

export default function AdminLeaderboardPage() {
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  const params = new URLSearchParams();
  if (startDate) params.set("startDate", startDate);
  if (endDate) params.set("endDate", endDate);
  const query = params.toString() ? `?${params.toString()}` : "";

  const { data, isLoading } = useSWR(`/admin/reports/leaderboard${query}`, (url) => apiFetch(url));
  const entries: any[] = (data as any)?.data ?? [];

  // Top Links leaderboard — engagement ranking (views+likes+comments from link_metrics).
  const { data: tlData, isLoading: tlLoading } = useSWR(
    `/admin/reports/top-links-leaderboard${query}`,
    (url) => apiFetch(url),
  );
  const tlEntries: any[] = (tlData as any)?.data ?? [];

  // True data-back-to dates (global, window-independent) so the coverage note is honest
  // about how far the underlying data actually reaches \u2014 not just "coverage lags".
  const { data: covData } = useSWR(`/admin/reports/leaderboard-coverage`, (url) => apiFetch(url), {
    revalidateOnFocus: false,
    dedupingInterval: 300_000,
  });
  const coverage = (covData as any)?.data ?? {};
  const fmtCovDate = (iso?: string | null) =>
    iso ? new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : null;

  const topPerformer = entries[0]?.employee?.name ?? "\u2014";
  const activeEmployees = entries.length;
  const totalReports = entries.reduce((sum: number, e: any) => sum + e.totalReports, 0);
  const totalLinks = entries.reduce((sum: number, e: any) => sum + e.totalLinks, 0);

  const statCards = [
    { title: "Top Performer", value: topPerformer, icon: Trophy, sub: "highest contributor" },
    { title: "Active Employees", value: activeEmployees, icon: Users, sub: "reporting" },
    { title: "Total Reports", value: totalReports, icon: FileText, sub: "submitted" },
    { title: "Total Links", value: totalLinks, icon: Link2, sub: "shared" },
  ];

  return (
    <div className="space-y-6 crx-animate-fade">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-serif text-4xl font-light text-[#1A1A1A] flex items-center gap-3">
            <Trophy className="h-8 w-8 text-[#F5D547]" />
            Leaderboard
          </h1>
          <p className="text-[#7A7A7A] mt-1">
            Employee ranking by reports, streaks, and engagement
          </p>
        </div>
        <Link
          href="/reports"
          className="text-sm text-[#1A1A1A] hover:text-[#F5D547] font-medium"
        >
          &larr; Back to Reports
        </Link>
      </div>

      {/* Date Range Filter */}
      <div className="flex flex-wrap gap-4 items-end p-5 bg-white rounded-2xl border border-[#E8E0D0] shadow-[0_2px_16px_rgba(0,0,0,0.05)] crx-animate-slide crx-delay-1">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-[#7A7A7A]">Start Date</label>
          <Input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="w-44 border border-[#E8E0D0] rounded-lg focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547]"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-[#7A7A7A]">End Date</label>
          <Input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className="w-44 border border-[#E8E0D0] rounded-lg focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547]"
          />
        </div>
        {(startDate || endDate) && (
          <button
            onClick={() => { setStartDate(""); setEndDate(""); }}
            className="text-sm text-[#1A1A1A] hover:text-[#F5D547] self-end pb-1"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {statCards.map((card, i) => {
          const Icon = card.icon;
          return (
            <div
              key={card.title}
              className={`bg-white rounded-2xl p-5 shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] transition-all hover:shadow-[0_4px_24px_rgba(0,0,0,0.07)] crx-animate-slide crx-delay-${i + 2}`}
            >
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm text-[#7A7A7A]">{card.title}</span>
                <div className="h-10 w-10 rounded-xl bg-[#FFF3C4] flex items-center justify-center">
                  <Icon className="h-5 w-5 text-[#1A1A1A]" />
                </div>
              </div>
              <p className="text-[40px] font-light font-num text-[#1A1A1A] leading-tight truncate">
                {isLoading ? "--" : card.value}
              </p>
              <p className="text-xs text-[#B0B0B0] mt-1">{card.sub}</p>
            </div>
          );
        })}
      </div>

      {/* Leaderboard Table */}
      <div className="rounded-2xl border border-[#E8E0D0] bg-white overflow-hidden shadow-[0_2px_16px_rgba(0,0,0,0.05)] crx-animate-slide crx-delay-6">
        <div className="px-6 py-4 border-b border-[#F0EAD8]">
          <h3 className="font-semibold font-serif text-[#1A1A1A]">Rankings</h3>
        </div>
        {isLoading ? (
          <p className="py-8 text-center text-sm text-[#B0B0B0]">Loading...</p>
        ) : entries.length === 0 ? (
          <p className="py-8 text-center text-sm text-[#B0B0B0]">No data found.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#F0EAD8]">
                  <th className="text-left py-3 px-5 text-[#7A7A7A] text-xs font-medium w-16">Rank</th>
                  <th className="text-left py-3 px-4 text-[#7A7A7A] text-xs font-medium">Employee</th>
                  <th className="text-right py-3 px-4 text-[#7A7A7A] text-xs font-medium">Reports</th>
                  <th className="text-right py-3 px-4 text-[#7A7A7A] text-xs font-medium">Links</th>
                  <th className="text-right py-3 px-4 text-[#7A7A7A] text-xs font-medium" title="Average links per reporting day (days the employee submitted), not per calendar day">Avg/Report</th>
                  <th className="text-center py-3 px-4 text-[#7A7A7A] text-xs font-medium">Streak</th>
                  <th className="text-center py-3 px-4 text-[#7A7A7A] text-xs font-medium">Best Streak</th>
                  <th className="text-right py-3 px-4 text-[#7A7A7A] text-xs font-medium" title="Views + likes + comments from collected link metrics (YouTube views; IG/FB/Snapchat likes+comments).">Engagement</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry: any) => (
                  <tr
                    key={entry.employee.id}
                    className="border-b border-[#F0EAD8] last:border-0 hover:bg-[rgba(255,248,225,0.5)] transition-colors"
                  >
                    <td className="py-3 px-5 text-center text-lg font-num">
                      {entry.rank <= 3 ? (
                        <span className="inline-flex items-center justify-center h-8 w-8 rounded-full bg-[#FFF3C4] text-[#1A1A1A] font-bold text-sm">
                          {MEDALS[entry.rank - 1]}
                        </span>
                      ) : `#${entry.rank}`}
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-3">
                        <UserAvatar
                          name={entry.employee.name}
                          imageUrl={entry.employee.profileImageUrl}
                          size={7}
                          textClassName="text-xs"
                        />
                        <div>
                          <Link
                            href={`/reports/${entry.employee.id}`}
                            className="font-medium text-[#1A1A1A] hover:text-[#F5D547]"
                          >
                            {entry.employee.name}
                          </Link>
                          <p className="text-xs text-[#B0B0B0]">{entry.employee.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="py-3 px-4 text-right font-medium text-[#1A1A1A]">{entry.totalReports}</td>
                    <td className="py-3 px-4 text-right text-[#1A1A1A]">{entry.totalLinks}</td>
                    <td className="py-3 px-4 text-right text-[#1A1A1A]">{entry.avgLinksPerReport ?? entry.avgLinksPerDay}</td>
                    <td className="py-3 px-4 text-center">
                      <span className="flex items-center justify-center gap-1">
                        <Flame className="h-4 w-4 text-[#F5A623]" />
                        <span className="font-medium text-[#1A1A1A]">{entry.currentStreak}</span>
                      </span>
                    </td>
                    <td className="py-3 px-4 text-center font-medium text-[#1A1A1A]">{entry.longestStreak}</td>
                    <td className="py-3 px-4 text-right text-[#1A1A1A]" title={`${(entry.engagementViews ?? 0).toLocaleString()} views · ${(entry.engagementLikes ?? 0).toLocaleString()} likes · ${(entry.engagementComments ?? 0).toLocaleString()} comments`}>{fmtCompact(entry.totalEngagement)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ============ Top Links Leaderboard (engagement ranking) ============ */}
      <div className="rounded-2xl border border-[#E8E0D0] bg-white overflow-hidden shadow-[0_2px_16px_rgba(0,0,0,0.05)] crx-animate-slide crx-delay-6">
        <div className="px-6 py-4 border-b border-[#F0EAD8] flex items-center gap-2">
          <TrendingUp className="h-5 w-5 text-[#F5A623]" />
          <h3 className="font-semibold font-serif text-[#1A1A1A]">Top Links Leaderboard</h3>
          <span className="text-xs text-[#B0B0B0] font-normal">ranked by post engagement</span>
        </div>
        {/* Honest coverage note */}
        <div className="px-6 py-3 bg-[#FFFBEF] border-b border-[#F0EAD8] flex items-start gap-2">
          <Info className="h-4 w-4 text-[#B0B0B0] mt-0.5 shrink-0" />
          <p className="text-xs text-[#7A7A7A] leading-relaxed">
            Ranked by total engagement (views&nbsp;+&nbsp;likes&nbsp;+&nbsp;comments) from collected post metrics &mdash; the same data behind the Top&nbsp;Links panels.
            YouTube and Facebook contribute <span className="font-medium">views&nbsp;+&nbsp;likes&nbsp;+&nbsp;comments</span>; Instagram contributes <span className="font-medium">likes&nbsp;+&nbsp;comments</span> only (Instagram doesn&rsquo;t expose a view count &mdash; so a 0 in Views is correct for an Instagram post, not missing data; a 0 on a YouTube or Facebook post means its metrics haven&rsquo;t been collected yet).
            {" "}Snapchat links are counted in submission totals but engagement metrics are not collected via API.
            The <span className="font-medium">Links (metrics&nbsp;/&nbsp;sent)</span> column shows how many of each person&rsquo;s links we&rsquo;ve collected metrics for so far &mdash; new links are picked up automatically by a background job, but collection lags submission (Instagram most of all), so a person&rsquo;s engagement reflects their <span className="font-medium">covered</span> links and grows as coverage catches up.
            {(coverage.reportsSince || coverage.metricsSince) && (
              <>
                {" "}<span className="font-medium">Data coverage:</span> reports go back to{" "}
                <span className="font-medium">{fmtCovDate(coverage.reportsSince) ?? "—"}</span>
                {coverage.metricsSince && <> and engagement metrics to <span className="font-medium">{fmtCovDate(coverage.metricsSince)}</span> (earlier links have volume but may lack collected metrics)</>}.
              </>
            )}
          </p>
        </div>
        {tlLoading ? (
          <p className="py-8 text-center text-sm text-[#B0B0B0]">Loading...</p>
        ) : tlEntries.length === 0 ? (
          <p className="py-8 text-center text-sm text-[#B0B0B0]">No engagement data yet for this period.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#F0EAD8]">
                  <th className="text-left py-3 px-5 text-[#7A7A7A] text-xs font-medium w-16">Rank</th>
                  <th className="text-left py-3 px-4 text-[#7A7A7A] text-xs font-medium">Employee</th>
                  <th className="text-right py-3 px-4 text-[#7A7A7A] text-xs font-medium">Views</th>
                  <th className="text-right py-3 px-4 text-[#7A7A7A] text-xs font-medium">Likes</th>
                  <th className="text-right py-3 px-4 text-[#7A7A7A] text-xs font-medium">Comments</th>
                  <th className="text-right py-3 px-4 text-[#7A7A7A] text-xs font-medium" title="Links with metrics collected / total links submitted. Coverage fills in over time as the metrics job runs.">Links (metrics&nbsp;/&nbsp;sent)</th>
                  <th className="text-right py-3 px-4 text-[#7A7A7A] text-xs font-medium">Total Engagement</th>
                </tr>
              </thead>
              <tbody>
                {tlEntries.map((entry: any) => (
                  <tr
                    key={entry.employee.id}
                    className="border-b border-[#F0EAD8] last:border-0 hover:bg-[rgba(255,248,225,0.5)] transition-colors"
                  >
                    <td className="py-3 px-5 text-center text-lg font-num">
                      {entry.rank <= 3 ? (
                        <span className="inline-flex items-center justify-center h-8 w-8 rounded-full bg-[#FFF3C4] text-[#1A1A1A] font-bold text-sm">
                          {MEDALS[entry.rank - 1]}
                        </span>
                      ) : `#${entry.rank}`}
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-3">
                        <UserAvatar
                          name={entry.employee.name}
                          imageUrl={entry.employee.profileImageUrl}
                          size={7}
                          textClassName="text-xs"
                        />
                        <div>
                          <Link
                            href={`/reports/${entry.employee.id}`}
                            className="font-medium text-[#1A1A1A] hover:text-[#F5D547]"
                          >
                            {entry.employee.name}
                          </Link>
                          <p className="text-xs text-[#B0B0B0]">{entry.employee.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="py-3 px-4 text-right text-[#1A1A1A]">
                      <span className="inline-flex items-center justify-end gap-1" title={`${(entry.views ?? 0).toLocaleString()} views`}>
                        <Eye className="h-3.5 w-3.5 text-[#B0B0B0]" />{fmtCompact(entry.views)}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right text-[#1A1A1A]">
                      <span className="inline-flex items-center justify-end gap-1" title={`${(entry.likes ?? 0).toLocaleString()} likes`}>
                        <Heart className="h-3.5 w-3.5 text-[#B0B0B0]" />{fmtCompact(entry.likes)}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right text-[#1A1A1A]">
                      <span className="inline-flex items-center justify-end gap-1" title={`${(entry.comments ?? 0).toLocaleString()} comments`}>
                        <MessageCircle className="h-3.5 w-3.5 text-[#B0B0B0]" />{fmtCompact(entry.comments)}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right text-[#7A7A7A]">
                      {(() => {
                        const covered = entry.engagedLinkCount ?? 0;
                        const submitted = entry.submittedLinkCount ?? covered;
                        const partial = submitted > covered;
                        return (
                          <span
                            title={partial
                              ? `Metrics collected on ${covered.toLocaleString()} of ${submitted.toLocaleString()} submitted links — the rest are still being collected (Instagram metrics lag the most).`
                              : `Metrics on all ${covered.toLocaleString()} links`}
                          >
                            <span className="text-[#1A1A1A]">{covered.toLocaleString()}</span>
                            {partial && (
                              <span className="text-[#B0B0B0]"> / {submitted.toLocaleString()}</span>
                            )}
                          </span>
                        );
                      })()}
                    </td>
                    <td className="py-3 px-4 text-right font-semibold text-[#1A1A1A]" title={`${(entry.totalEngagement ?? 0).toLocaleString()} total`}>{fmtCompact(entry.totalEngagement)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
