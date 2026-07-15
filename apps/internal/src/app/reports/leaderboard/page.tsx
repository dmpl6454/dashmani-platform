"use client";
import { useState, type ReactNode } from "react";
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

// Rank badge shared by the desktop table cells and the mobile cards — preserves the
// top-3 medal treatment everywhere ranks are shown. `size` controls the non-medal (#4+)
// text treatment: "lg" matches the original desktop `<td>` styling (text-lg, default ink,
// no shrink/width constraints), "sm" is the compact muted style used inside mobile cards.
function RankBadge({ rank, size = "sm" }: { rank: number; size?: "sm" | "lg" }) {
  return rank <= 3 ? (
    <span className="inline-flex items-center justify-center h-8 w-8 shrink-0 rounded-full bg-[#FFF3C4] text-[#1A1A1A] font-bold text-sm">
      {MEDALS[rank - 1]}
    </span>
  ) : size === "lg" ? (
    <span className="text-lg font-num text-[#1A1A1A]">{`#${rank}`}</span>
  ) : (
    <span className="text-sm font-num text-[#7A7A7A] shrink-0 w-8 text-center">{`#${rank}`}</span>
  );
}

// Shared below-`sm` mini-card for a single ranked row. Used by all 5 boards — each board
// passes its own metric set as `{label, value}` pairs so the card body stays generic while
// each board's actual columns can differ (main board vs. per-platform boards).
function MobileRankCard({
  rank,
  name,
  subtitle,
  href,
  metrics,
}: {
  rank: number;
  name: string;
  subtitle?: string | null;
  href?: string;
  metrics: { label: string; value: ReactNode }[];
}) {
  const nameEl = href ? (
    <Link href={href} className="font-medium text-[#1A1A1A] hover:text-[#F5D547] truncate block">
      {name}
    </Link>
  ) : (
    <p className="font-medium text-[#1A1A1A] truncate">{name}</p>
  );
  return (
    <div className="rounded-xl border border-[#E8E0D0] bg-white p-3">
      <div className="flex items-center gap-3 min-w-0">
        <RankBadge rank={rank} />
        <div className="min-w-0 flex-1">
          {nameEl}
          {subtitle && <p className="text-xs text-[#B0B0B0] break-all">{subtitle}</p>}
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 pl-11">
        {metrics.map((m) => (
          <div key={m.label} className="flex items-baseline justify-between gap-2 text-xs">
            <span className="text-[#7A7A7A]">{m.label}</span>
            <span className="font-medium text-[#1A1A1A] font-num text-right">{m.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

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

  // FAIR per-platform boards — each platform ranked by the metric it actually exposes
  // (YouTube/Facebook by views; Instagram by likes+comments). Separate from the combined
  // board above, which mixes incomparable metrics/scales and is only a raw-volume view.
  const { data: platData, isLoading: platLoading } = useSWR(
    `/admin/reports/platform-leaderboards${query}`,
    (url) => apiFetch(url),
  );
  const platBoards: Record<string, any[]> = (platData as any)?.data ?? {};

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
      <div className="flex flex-wrap items-center justify-between gap-3">
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
          <>
            <div className="hidden sm:block overflow-x-auto">
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
                      <td className="py-3 px-5 text-center">
                        <RankBadge rank={entry.rank} size="lg" />
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
            <div className="sm:hidden space-y-2 p-3">
              {entries.map((entry: any) => (
                <MobileRankCard
                  key={entry.employee.id}
                  rank={entry.rank}
                  name={entry.employee.name}
                  subtitle={entry.employee.email}
                  href={`/reports/${entry.employee.id}`}
                  metrics={[
                    { label: "Reports", value: entry.totalReports },
                    { label: "Links", value: entry.totalLinks },
                    { label: "Avg/Report", value: entry.avgLinksPerReport ?? entry.avgLinksPerDay },
                    {
                      label: "Streak",
                      value: (
                        <span className="inline-flex items-center gap-1">
                          <Flame className="h-3.5 w-3.5 text-[#F5A623]" />
                          {entry.currentStreak}
                        </span>
                      ),
                    },
                    { label: "Best Streak", value: entry.longestStreak },
                    { label: "Engagement", value: fmtCompact(entry.totalEngagement) },
                  ]}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {/* ============ Top Links Leaderboard (engagement ranking) ============ */}
      <div className="rounded-2xl border border-[#E8E0D0] bg-white overflow-hidden shadow-[0_2px_16px_rgba(0,0,0,0.05)] crx-animate-slide crx-delay-6">
        <div className="px-6 py-4 border-b border-[#F0EAD8] flex items-center gap-2">
          <TrendingUp className="h-5 w-5 text-[#F5A623]" />
          <h3 className="font-semibold font-serif text-[#1A1A1A]">Total Collected Engagement</h3>
          <span className="text-xs text-[#B0B0B0] font-normal">raw cross-platform volume &mdash; not a fair ranking</span>
        </div>
        {/* Honest coverage note */}
        <div className="px-6 py-3 bg-[#FFFBEF] border-b border-[#F0EAD8] flex items-start gap-2">
          <Info className="h-4 w-4 text-[#B0B0B0] mt-0.5 shrink-0" />
          <p className="text-xs text-[#7A7A7A] leading-relaxed">
            <span className="font-medium">This is raw total volume, not a fair ranking</span> &mdash; it sums views&nbsp;+&nbsp;likes&nbsp;+&nbsp;comments across platforms, but platforms don&rsquo;t expose the same metrics or scales (Facebook&rsquo;s raw numbers dwarf YouTube&rsquo;s, and Instagram has no views at all), so it structurally favors some platforms. <span className="font-medium">For a fair comparison, use the per-platform boards below.</span> It&rsquo;s the same data behind the Top&nbsp;Links panels.
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
          <>
            <div className="hidden sm:block overflow-x-auto">
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
                      <td className="py-3 px-5 text-center">
                        <RankBadge rank={entry.rank} size="lg" />
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
            <div className="sm:hidden space-y-2 p-3">
              {tlEntries.map((entry: any) => {
                const covered = entry.engagedLinkCount ?? 0;
                const submitted = entry.submittedLinkCount ?? covered;
                const partial = submitted > covered;
                return (
                  <MobileRankCard
                    key={entry.employee.id}
                    rank={entry.rank}
                    name={entry.employee.name}
                    subtitle={entry.employee.email}
                    href={`/reports/${entry.employee.id}`}
                    metrics={[
                      {
                        label: "Views",
                        value: (
                          <span className="inline-flex items-center gap-1 justify-end">
                            <Eye className="h-3.5 w-3.5 text-[#B0B0B0]" />{fmtCompact(entry.views)}
                          </span>
                        ),
                      },
                      {
                        label: "Likes",
                        value: (
                          <span className="inline-flex items-center gap-1 justify-end">
                            <Heart className="h-3.5 w-3.5 text-[#B0B0B0]" />{fmtCompact(entry.likes)}
                          </span>
                        ),
                      },
                      {
                        label: "Comments",
                        value: (
                          <span className="inline-flex items-center gap-1 justify-end">
                            <MessageCircle className="h-3.5 w-3.5 text-[#B0B0B0]" />{fmtCompact(entry.comments)}
                          </span>
                        ),
                      },
                      {
                        label: "Links",
                        value: partial ? `${covered.toLocaleString()} / ${submitted.toLocaleString()}` : covered.toLocaleString(),
                      },
                      { label: "Total Engagement", value: fmtCompact(entry.totalEngagement) },
                    ]}
                  />
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* ============ FAIR per-platform boards ============ */}
      {/* Each platform ranked by the metric it actually exposes, so people are compared
          against peers on the same yardstick (no cross-platform metric/scale mixing). */}
      {([
        { key: "youtube", label: "YouTube", rankBy: "Views", showViews: true, showLikes: true },
        { key: "facebook", label: "Facebook", rankBy: "Views", showViews: true, showLikes: true },
        { key: "instagram", label: "Instagram", rankBy: "Likes + Comments", showViews: false, showLikes: true },
        // Snapchat Spotlight exposes no public like metric (unlike the other 3 platforms) —
        // showLikes:false hides the column entirely rather than rendering a fabricated "0"
        // (fmtCompact treats null as 0, which would misleadingly read as "zero likes measured").
        { key: "snapchat", label: "Snapchat", rankBy: "Views", showViews: true, showLikes: false },
      ] as const).map(({ key, label, rankBy, showViews, showLikes }) => {
        const board = platBoards[key] ?? [];
        return (
          <div key={key} className="rounded-2xl border border-[#E8E0D0] bg-white overflow-hidden shadow-[0_2px_16px_rgba(0,0,0,0.05)]">
            <div className="px-6 py-4 border-b border-[#F0EAD8] flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-[#F5A623]" />
              <h3 className="font-semibold font-serif text-[#1A1A1A]">{label} Leaderboard</h3>
              <span className="text-xs text-[#B0B0B0] font-normal">ranked by {rankBy}{!showViews && " (Instagram exposes no view count)"}{!showLikes && " (Snapchat exposes no like count)"}</span>
            </div>
            {platLoading ? (
              <p className="py-8 text-center text-sm text-[#B0B0B0]">Loading...</p>
            ) : board.length === 0 ? (
              <p className="py-8 text-center text-sm text-[#B0B0B0]">No {label} engagement data yet for this period.</p>
            ) : (
              <>
                <div className="hidden sm:block overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[#F0EAD8]">
                        <th className="text-left py-3 px-5 text-[#7A7A7A] text-xs font-medium w-16">Rank</th>
                        <th className="text-left py-3 px-4 text-[#7A7A7A] text-xs font-medium">Employee</th>
                        {showViews && <th className="text-right py-3 px-4 text-[#7A7A7A] text-xs font-medium">Views</th>}
                        {showLikes && <th className="text-right py-3 px-4 text-[#7A7A7A] text-xs font-medium">Likes</th>}
                        <th className="text-right py-3 px-4 text-[#7A7A7A] text-xs font-medium">Comments</th>
                        <th className="text-right py-3 px-4 text-[#7A7A7A] text-xs font-medium">Links</th>
                      </tr>
                    </thead>
                    <tbody>
                      {board.map((entry: any) => (
                        <tr key={entry.employee.id} className="border-b border-[#F0EAD8] last:border-0 hover:bg-[rgba(255,248,225,0.5)] transition-colors">
                          <td className="py-3 px-5 text-center">
                            <RankBadge rank={entry.rank} size="lg" />
                          </td>
                          <td className="py-3 px-4">
                            <div className="flex items-center gap-3">
                              <UserAvatar name={entry.employee.name} imageUrl={entry.employee.profileImageUrl} size={7} textClassName="text-xs" />
                              <div>
                                <Link href={`/reports/${entry.employee.id}`} className="font-medium text-[#1A1A1A] hover:text-[#F5D547]">{entry.employee.name}</Link>
                                <p className="text-xs text-[#B0B0B0]">{entry.employee.email}</p>
                              </div>
                            </div>
                          </td>
                          {showViews && (
                            <td className="py-3 px-4 text-right text-[#1A1A1A]">
                              <span className="inline-flex items-center justify-end gap-1" title={`${(entry.views ?? 0).toLocaleString()} views`}>
                                <Eye className="h-3.5 w-3.5 text-[#B0B0B0]" />{fmtCompact(entry.views)}
                              </span>
                            </td>
                          )}
                          {showLikes && (
                            <td className="py-3 px-4 text-right text-[#1A1A1A]">
                              <span className="inline-flex items-center justify-end gap-1" title={`${(entry.likes ?? 0).toLocaleString()} likes`}>
                                <Heart className="h-3.5 w-3.5 text-[#B0B0B0]" />{fmtCompact(entry.likes)}
                              </span>
                            </td>
                          )}
                          <td className="py-3 px-4 text-right text-[#1A1A1A]">
                            <span className="inline-flex items-center justify-end gap-1" title={`${(entry.comments ?? 0).toLocaleString()} comments`}>
                              <MessageCircle className="h-3.5 w-3.5 text-[#B0B0B0]" />{fmtCompact(entry.comments)}
                            </span>
                          </td>
                          <td className="py-3 px-4 text-right text-[#7A7A7A]" title={`Metrics collected on ${(entry.engagedLinkCount ?? 0).toLocaleString()} ${label} links`}>{(entry.engagedLinkCount ?? 0).toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="sm:hidden space-y-2 p-3">
                  {board.map((entry: any) => (
                    <MobileRankCard
                      key={entry.employee.id}
                      rank={entry.rank}
                      name={entry.employee.name}
                      subtitle={entry.employee.email}
                      href={`/reports/${entry.employee.id}`}
                      metrics={[
                        ...(showViews
                          ? [
                              {
                                label: "Views",
                                value: (
                                  <span className="inline-flex items-center gap-1 justify-end">
                                    <Eye className="h-3.5 w-3.5 text-[#B0B0B0]" />{fmtCompact(entry.views)}
                                  </span>
                                ),
                              },
                            ]
                          : []),
                        ...(showLikes
                          ? [
                              {
                                label: "Likes",
                                value: (
                                  <span className="inline-flex items-center gap-1 justify-end">
                                    <Heart className="h-3.5 w-3.5 text-[#B0B0B0]" />{fmtCompact(entry.likes)}
                                  </span>
                                ),
                              },
                            ]
                          : []),
                        {
                          label: "Comments",
                          value: (
                            <span className="inline-flex items-center gap-1 justify-end">
                              <MessageCircle className="h-3.5 w-3.5 text-[#B0B0B0]" />{fmtCompact(entry.comments)}
                            </span>
                          ),
                        },
                        { label: "Links", value: (entry.engagedLinkCount ?? 0).toLocaleString() },
                      ]}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
