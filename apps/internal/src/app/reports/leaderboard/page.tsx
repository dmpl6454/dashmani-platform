"use client";
import { useState, type ReactNode } from "react";
import type React from "react";
import Link from "next/link";
import useSWR from "swr";
import { Trophy, Flame, Users, FileText, Link2, Eye, Heart, MessageCircle, TrendingUp, Info, ArrowLeft, X } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { UserAvatar } from "@/components/user-avatar";

const MEDALS = ["#1", "#2", "#3"];

/** Rank badge colours: gold / silver / bronze (matches /reports/links). */
const RANK_STYLE: React.CSSProperties[] = [
  { background: "rgba(233,189,98,.16)", color: "var(--hx-E9BD62)" },
  { background: "rgba(212,219,228,.12)", color: "var(--hx-D4DBE4)" },
  { background: "rgba(240,128,60,.14)", color: "var(--hx-F0A070)" },
];

const CARD = "rounded-[16px] border border-[color:var(--hx-2A4658)] bg-ds-card overflow-hidden shadow-[0_12px_32px_rgba(0,0,0,.35)] min-w-0";
const CARD_HEAD = "flex items-center gap-x-2.5 gap-y-1 flex-wrap min-h-[62px] px-5 sm:px-6 py-3 border-b border-ds-line";
const CARD_TITLE = "text-[15px] font-semibold tracking-[-.01em] text-ds-text whitespace-nowrap";
const CARD_SUB = "text-[12px] text-ds-t3 font-normal";
const HEAD_ROW = "bg-ds-inset border-b border-ds-line2";
const TH = "py-0 h-[46px] px-4 text-[10.5px] font-semibold uppercase tracking-[.08em] text-ds-t3 whitespace-nowrap";
const ROW = "border-b border-[color:var(--hx-132430)] last:border-b-0 hover:bg-[color:var(--hx-0A1620)] transition-colors";
const TD = "py-3 px-4 text-ds-t5 tabular-nums";
const NAME_LINK = "text-[14px] font-semibold text-ds-text hover:text-ds-gold transition-colors";
const SUB_TEXT = "text-[11.5px] text-ds-t3";
const EMPTY = "px-6 py-10 text-center text-[12.5px] text-ds-t3";
const METRIC_ICON = "h-3.5 w-3.5 text-ds-t4";
const FIELD =
  "h-10 w-44 px-3 rounded-full border border-ds-line2 bg-ds-inset text-ds-text text-[16px] sm:text-[13px] outline-none [color-scheme:dark] focus:border-ds-gold";
const LABEL = "text-[10.5px] font-semibold tracking-[.12em] uppercase text-ds-t3";

// Compact number formatter for engagement (1.2M, 45.3k, 980). Null-safe.
const rgba = (hex: string, a: number) => {
  if (hex.startsWith("var(")) return `color-mix(in srgb, ${hex} ${Math.round(a * 100)}%, transparent)`; const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};

const fmtCompact = (n: number | null | undefined): string => {
  const v = n ?? 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}m`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(v);
};

// Rank badge shared by the desktop table cells and the mobile cards — preserves the
// top-3 medal treatment everywhere ranks are shown. `size` controls the non-medal (#4+)
// text treatment: "lg" matches the original desktop `<td>` styling (text-lg, default ink,
// no shrink/width constraints), "sm" is the compact muted style used inside mobile cards.
function RankBadge({ rank, size = "sm" }: { rank: number; size?: "sm" | "lg" }) {
  return rank <= 3 ? (
    <span
      className="inline-flex items-center justify-center h-8 w-8 shrink-0 rounded-full font-bold text-[12px] tabular-nums"
      style={RANK_STYLE[rank - 1]}
    >
      {MEDALS[rank - 1]}
    </span>
  ) : size === "lg" ? (
    <span className="text-[15px] font-semibold tabular-nums text-ds-t2">{`#${rank}`}</span>
  ) : (
    <span className="text-[13px] font-semibold tabular-nums text-ds-t3 shrink-0 w-8 text-center">{`#${rank}`}</span>
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
    <Link href={href} className="text-[14px] font-semibold text-ds-text hover:text-ds-gold truncate block">
      {name}
    </Link>
  ) : (
    <p className="text-[14px] font-semibold text-ds-text truncate">{name}</p>
  );
  return (
    <div className="rounded-[12px] border border-ds-line bg-ds-inset p-3">
      <div className="flex items-center gap-3 min-w-0">
        <RankBadge rank={rank} />
        <div className="min-w-0 flex-1">
          {nameEl}
          {subtitle && <p className="text-[11.5px] text-ds-t3 break-all">{subtitle}</p>}
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 pl-11">
        {metrics.map((m) => (
          <div key={m.label} className="flex items-baseline justify-between gap-2 text-xs">
            <span className="text-ds-t3">{m.label}</span>
            <span className="font-semibold text-ds-t5 tabular-nums text-right">{m.value}</span>
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

  const { data, isLoading } = useSWR(`/admin/reports/leaderboard${query}`, (url) => apiFetch(url), {
    revalidateOnFocus: false,
    dedupingInterval: 300_000,
  });
  const entries: any[] = (data as any)?.data ?? [];

  // Top Links leaderboard — engagement ranking (views+likes+comments from link_metrics).
  const { data: tlData, isLoading: tlLoading } = useSWR(
    `/admin/reports/top-links-leaderboard${query}`,
    (url) => apiFetch(url),
    { revalidateOnFocus: false, dedupingInterval: 300_000 },
  );
  const tlEntries: any[] = (tlData as any)?.data ?? [];

  // FAIR per-platform boards — each platform ranked by the metric it actually exposes
  // (YouTube/Facebook by views; Instagram by likes+comments). Separate from the combined
  // board above, which mixes incomparable metrics/scales and is only a raw-volume view.
  const { data: platData, isLoading: platLoading } = useSWR(
    `/admin/reports/platform-leaderboards${query}`,
    (url) => apiFetch(url),
    { revalidateOnFocus: false, dedupingInterval: 300_000 },
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
    { title: "Top Performer", value: topPerformer, icon: Trophy, sub: "highest contributor", color: "var(--hx-E9BD62)" },
    { title: "Active Employees", value: activeEmployees, icon: Users, sub: "reporting", color: "var(--hx-6EB2FF)" },
    { title: "Total Reports", value: totalReports, icon: FileText, sub: "submitted", color: "var(--hx-B8A3EC)" },
    { title: "Total Links", value: totalLinks, icon: Link2, sub: "shared", color: "var(--hx-00D7A0)" },
  ];

  return (
    <div className="pb-10 space-y-4">
      {/* Back + title */}
      <section className="pt-[22px]">
        <Link href="/reports" className="inline-flex items-center gap-2 text-[13.5px] font-medium text-ds-t2 hover:text-ds-text transition-colors">
          <ArrowLeft className="h-[15px] w-[15px]" strokeWidth={1.8} /> Back to Reports
        </Link>
      </section>
      <section className="pt-0 pb-1">
        <h1 className="text-[28px] sm:text-[34px] font-bold tracking-[-.03em] text-ds-text leading-tight flex items-center gap-3">
          <Trophy className="h-7 w-7 text-ds-gold" strokeWidth={1.8} />
          Leaderboard
        </h1>
        <p className="mt-1.5 text-[13.5px] text-ds-t2">
          Employee ranking by reports, streaks, and engagement
        </p>
      </section>

      {/* Date Range Filter */}
      <section className="flex flex-wrap gap-x-5 gap-y-4 items-end px-[22px] py-[18px] rounded-[16px] border border-[color:var(--hx-2A4658)] bg-ds-card">
        <label className="flex flex-col gap-2">
          <span className={LABEL}>Start Date</span>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className={FIELD}
          />
        </label>
        <label className="flex flex-col gap-2">
          <span className={LABEL}>End Date</span>
          <input
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className={FIELD}
          />
        </label>
        {(startDate || endDate) && (
          <button
            type="button"
            onClick={() => { setStartDate(""); setEndDate(""); }}
            className="h-10 inline-flex items-center gap-1 rounded-full border border-ds-line2 px-3.5 text-[12px] text-ds-t2 hover:text-[color:var(--hx-FB7185)] hover:border-[rgba(229,72,77,.4)] self-end"
          >
            <X className="h-3 w-3" /> Clear filters
          </button>
        )}
      </section>

      {/* Stat Cards */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {statCards.map((card) => {
          const Icon = card.icon;
          return (
            <div
              key={card.title}
              className="flex flex-col gap-3.5 px-5 py-[18px] rounded-[16px] bg-ds-card border border-[color:var(--hx-2A4658)] min-w-0"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] font-semibold text-ds-t2 truncate">{card.title}</span>
                <span
                  className="h-[30px] w-[30px] rounded-[9px] grid place-items-center shrink-0"
                  style={{ background: rgba(card.color, 0.13), color: card.color }}
                >
                  <Icon className="h-[15px] w-[15px]" />
                </span>
              </div>
              <span className="leading-[1.2] min-w-0">
                <span className="block text-[24px] sm:text-[28px] font-bold tracking-[-.04em] tabular-nums text-ds-text whitespace-nowrap truncate">
                  {isLoading ? "—" : card.value}
                </span>
                <span className="block text-[11.5px] text-ds-t3 truncate">{card.sub}</span>
              </span>
            </div>
          );
        })}
      </section>

      {/* Leaderboard Table */}
      <section className={CARD}>
        <div className={CARD_HEAD}>
          <Trophy className="h-4 w-4 text-ds-gold" strokeWidth={1.8} />
          <h3 className={CARD_TITLE}>Rankings</h3>
        </div>
        {isLoading ? (
          <p className={EMPTY}>Loading...</p>
        ) : entries.length === 0 ? (
          <p className={EMPTY}>No data found.</p>
        ) : (
          <>
            <div className="hidden sm:block overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className={`${HEAD_ROW} text-left`}>
                    <th className={`${TH} text-center px-5 w-16`}>Rank</th>
                    <th className={`${TH} text-left`}>Employee</th>
                    <th className={`${TH} text-right`}>Reports</th>
                    <th className={`${TH} text-right`}>Links</th>
                    <th className={`${TH} text-right`} title="Average links per reporting day (days the employee submitted), not per calendar day">Avg/Report</th>
                    <th className={`${TH} text-center`}>Streak</th>
                    <th className={`${TH} text-center`}>Best Streak</th>
                    <th className={`${TH} text-right`} title="Views + likes + comments from collected link metrics (YouTube views; IG/FB/Snapchat likes+comments).">Engagement</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry: any) => (
                    <tr
                      key={entry.employee.id}
                      className={ROW}
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
                              className={NAME_LINK}
                            >
                              {entry.employee.name}
                            </Link>
                            <p className={SUB_TEXT}>{entry.employee.email}</p>
                          </div>
                        </div>
                      </td>
                      <td className={`${TD} text-right font-semibold text-ds-text`}>{entry.totalReports}</td>
                      <td className={`${TD} text-right`}>{entry.totalLinks}</td>
                      <td className={`${TD} text-right`}>{entry.avgLinksPerReport ?? entry.avgLinksPerDay}</td>
                      <td className={`${TD} text-center`}>
                        <span className="flex items-center justify-center gap-1">
                          <Flame className="h-4 w-4 text-[color:var(--hx-F59E66)]" />
                          <span className="font-semibold text-[color:var(--hx-F59E66)]">{entry.currentStreak}</span>
                        </span>
                      </td>
                      <td className={`${TD} text-center font-semibold`}>{entry.longestStreak}</td>
                      <td className={`${TD} text-right`} title={`${(entry.engagementViews ?? 0).toLocaleString()} views · ${(entry.engagementLikes ?? 0).toLocaleString()} likes · ${(entry.engagementComments ?? 0).toLocaleString()} comments`}>{fmtCompact(entry.totalEngagement)}</td>
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
                          <Flame className="h-3.5 w-3.5 text-[color:var(--hx-F59E66)]" />
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
      </section>

      {/* ============ Top Links Leaderboard (engagement ranking) ============ */}
      <section className={CARD}>
        <div className={CARD_HEAD}>
          <TrendingUp className="h-4 w-4 text-ds-gold" strokeWidth={1.8} />
          <h3 className={CARD_TITLE}>Total Collected Engagement</h3>
          <span className={CARD_SUB}>raw cross-platform volume &mdash; not a fair ranking</span>
        </div>
        {/* Honest coverage note */}
        <div className="px-5 sm:px-6 py-3.5 bg-ds-inset border-b border-ds-line flex items-start gap-2.5">
          <Info className="h-4 w-4 text-ds-gold mt-0.5 shrink-0" />
          <p className="text-[11.5px] text-ds-t2 leading-[1.6]">
            <span className="font-semibold text-ds-t5">This is raw total volume, not a fair ranking</span> &mdash; it sums views&nbsp;+&nbsp;likes&nbsp;+&nbsp;comments across platforms, but platforms don&rsquo;t expose the same metrics or scales (Facebook&rsquo;s raw numbers dwarf YouTube&rsquo;s, and Instagram has no views at all), so it structurally favors some platforms. <span className="font-semibold text-ds-t5">For a fair comparison, use the per-platform boards below.</span> It&rsquo;s the same data behind the Top&nbsp;Links panels.
            YouTube and Facebook contribute <span className="font-semibold text-ds-t5">views&nbsp;+&nbsp;likes&nbsp;+&nbsp;comments</span>; Instagram contributes <span className="font-semibold text-ds-t5">likes&nbsp;+&nbsp;comments</span> only (Instagram doesn&rsquo;t expose a view count &mdash; so a 0 in Views is correct for an Instagram post, not missing data; a 0 on a YouTube or Facebook post means its metrics haven&rsquo;t been collected yet).
            {" "}Snapchat links are counted in submission totals but engagement metrics are not collected via API.
            The <span className="font-semibold text-ds-t5">Links (metrics&nbsp;/&nbsp;sent)</span> column shows how many of each person&rsquo;s links we&rsquo;ve collected metrics for so far &mdash; new links are picked up automatically by a background job, but collection lags submission (Instagram most of all), so a person&rsquo;s engagement reflects their <span className="font-semibold text-ds-t5">covered</span> links and grows as coverage catches up.
            {(coverage.reportsSince || coverage.metricsSince) && (
              <>
                {" "}<span className="font-semibold text-ds-t5">Data coverage:</span> reports go back to{" "}
                <span className="font-semibold text-ds-t5">{fmtCovDate(coverage.reportsSince) ?? "—"}</span>
                {coverage.metricsSince && <> and engagement metrics to <span className="font-semibold text-ds-t5">{fmtCovDate(coverage.metricsSince)}</span> (earlier links have volume but may lack collected metrics)</>}.
              </>
            )}
          </p>
        </div>
        {tlLoading ? (
          <p className={EMPTY}>Loading...</p>
        ) : tlEntries.length === 0 ? (
          <p className={EMPTY}>No engagement data yet for this period.</p>
        ) : (
          <>
            <div className="hidden sm:block overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className={`${HEAD_ROW} text-left`}>
                    <th className={`${TH} text-center px-5 w-16`}>Rank</th>
                    <th className={`${TH} text-left`}>Employee</th>
                    <th className={`${TH} text-right`}>Views</th>
                    <th className={`${TH} text-right`}>Likes</th>
                    <th className={`${TH} text-right`}>Comments</th>
                    <th className={`${TH} text-right`} title="Links with metrics collected / total links submitted. Coverage fills in over time as the metrics job runs.">Links (metrics&nbsp;/&nbsp;sent)</th>
                    <th className={`${TH} text-right`}>Total Engagement</th>
                  </tr>
                </thead>
                <tbody>
                  {tlEntries.map((entry: any) => (
                    <tr
                      key={entry.employee.id}
                      className={ROW}
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
                              className={NAME_LINK}
                            >
                              {entry.employee.name}
                            </Link>
                            <p className={SUB_TEXT}>{entry.employee.email}</p>
                          </div>
                        </div>
                      </td>
                      <td className={`${TD} text-right`}>
                        <span className="inline-flex items-center justify-end gap-1" title={`${(entry.views ?? 0).toLocaleString()} views`}>
                          <Eye className={METRIC_ICON} />{fmtCompact(entry.views)}
                        </span>
                      </td>
                      <td className={`${TD} text-right`}>
                        <span className="inline-flex items-center justify-end gap-1" title={`${(entry.likes ?? 0).toLocaleString()} likes`}>
                          <Heart className={METRIC_ICON} />{fmtCompact(entry.likes)}
                        </span>
                      </td>
                      <td className={`${TD} text-right`}>
                        <span className="inline-flex items-center justify-end gap-1" title={`${(entry.comments ?? 0).toLocaleString()} comments`}>
                          <MessageCircle className={METRIC_ICON} />{fmtCompact(entry.comments)}
                        </span>
                      </td>
                      <td className={`${TD} text-right text-ds-t3`}>
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
                              <span className="text-ds-t5">{covered.toLocaleString()}</span>
                              {partial && (
                                <span className="text-ds-t4"> / {submitted.toLocaleString()}</span>
                              )}
                            </span>
                          );
                        })()}
                      </td>
                      <td className={`${TD} text-right font-bold text-ds-gold`} title={`${(entry.totalEngagement ?? 0).toLocaleString()} total`}>{fmtCompact(entry.totalEngagement)}</td>
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
                            <Eye className={METRIC_ICON} />{fmtCompact(entry.views)}
                          </span>
                        ),
                      },
                      {
                        label: "Likes",
                        value: (
                          <span className="inline-flex items-center gap-1 justify-end">
                            <Heart className={METRIC_ICON} />{fmtCompact(entry.likes)}
                          </span>
                        ),
                      },
                      {
                        label: "Comments",
                        value: (
                          <span className="inline-flex items-center gap-1 justify-end">
                            <MessageCircle className={METRIC_ICON} />{fmtCompact(entry.comments)}
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
      </section>

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
          <section key={key} className={CARD}>
            <div className={CARD_HEAD}>
              <TrendingUp className="h-4 w-4 text-ds-gold" strokeWidth={1.8} />
              <h3 className={CARD_TITLE}>{label} Leaderboard</h3>
              <span className={CARD_SUB}>ranked by {rankBy}{!showViews && " (Instagram exposes no view count)"}{!showLikes && " (Snapchat exposes no like count)"}</span>
            </div>
            {platLoading ? (
              <p className={EMPTY}>Loading...</p>
            ) : board.length === 0 ? (
              <p className={EMPTY}>No {label} engagement data yet for this period.</p>
            ) : (
              <>
                <div className="hidden sm:block overflow-x-auto">
                  <table className="w-full text-[13px]">
                    <thead>
                      <tr className={`${HEAD_ROW} text-left`}>
                        <th className={`${TH} text-center px-5 w-16`}>Rank</th>
                        <th className={`${TH} text-left`}>Employee</th>
                        {showViews && <th className={`${TH} text-right`}>Views</th>}
                        {showLikes && <th className={`${TH} text-right`}>Likes</th>}
                        <th className={`${TH} text-right`}>Comments</th>
                        <th className={`${TH} text-right`}>Links</th>
                      </tr>
                    </thead>
                    <tbody>
                      {board.map((entry: any) => (
                        <tr key={entry.employee.id} className={ROW}>
                          <td className="py-3 px-5 text-center">
                            <RankBadge rank={entry.rank} size="lg" />
                          </td>
                          <td className="py-3 px-4">
                            <div className="flex items-center gap-3">
                              <UserAvatar name={entry.employee.name} imageUrl={entry.employee.profileImageUrl} size={7} textClassName="text-xs" />
                              <div>
                                <Link href={`/reports/${entry.employee.id}`} className={NAME_LINK}>{entry.employee.name}</Link>
                                <p className={SUB_TEXT}>{entry.employee.email}</p>
                              </div>
                            </div>
                          </td>
                          {showViews && (
                            <td className={`${TD} text-right`}>
                              <span className="inline-flex items-center justify-end gap-1" title={`${(entry.views ?? 0).toLocaleString()} views`}>
                                <Eye className={METRIC_ICON} />{fmtCompact(entry.views)}
                              </span>
                            </td>
                          )}
                          {showLikes && (
                            <td className={`${TD} text-right`}>
                              <span className="inline-flex items-center justify-end gap-1" title={`${(entry.likes ?? 0).toLocaleString()} likes`}>
                                <Heart className={METRIC_ICON} />{fmtCompact(entry.likes)}
                              </span>
                            </td>
                          )}
                          <td className={`${TD} text-right`}>
                            <span className="inline-flex items-center justify-end gap-1" title={`${(entry.comments ?? 0).toLocaleString()} comments`}>
                              <MessageCircle className={METRIC_ICON} />{fmtCompact(entry.comments)}
                            </span>
                          </td>
                          <td className={`${TD} text-right text-ds-t3`} title={`Metrics collected on ${(entry.engagedLinkCount ?? 0).toLocaleString()} ${label} links`}>{(entry.engagedLinkCount ?? 0).toLocaleString()}</td>
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
                                    <Eye className={METRIC_ICON} />{fmtCompact(entry.views)}
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
                                    <Heart className={METRIC_ICON} />{fmtCompact(entry.likes)}
                                  </span>
                                ),
                              },
                            ]
                          : []),
                        {
                          label: "Comments",
                          value: (
                            <span className="inline-flex items-center gap-1 justify-end">
                              <MessageCircle className={METRIC_ICON} />{fmtCompact(entry.comments)}
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
          </section>
        );
      })}
    </div>
  );
}
