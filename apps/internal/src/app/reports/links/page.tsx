"use client";
// Links Analytics — premium dark redesign ("ds"), built to the Links Analytics.dc.html mockup.
// UI only: the same hooks, the same requests, the same links. Every figure comes from the
// API; nothing here is mock data, and a missing figure renders "—", never a fabricated 0.
import { useState, useMemo, useRef } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import {
  ArrowLeft, TrendingUp, TrendingDown, Link2, Users, Trophy, AlertCircle, ChevronRight, Eye, Heart, MessageCircle, BarChart2, X,
} from "lucide-react";
import { useLinksAnalytics, useLinksAllAccounts, useTopYouTubeLinks } from "@/lib/hooks/use-reports";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import { RANGE_PRESETS, activePresetLabel, presetStart, todayISO, rangeLabel } from "../_range";
import { ExportButton, AllLinksCsvButton } from "../_export";

// Loaded only when the "Submission gaps" tab is opened — its code AND its request stay
// off the page's normal load (the panel's SWR key exists only while it is mounted).
const SubmissionGapsPanel = dynamic(
  () => import("./_submission-gaps").then((m) => m.SubmissionGapsPanel),
  {
    ssr: false,
    loading: () => (
      <div className="mt-4 rounded-[16px] border border-[color:var(--hx-2A4658)] bg-ds-card px-6 py-5 text-[12.5px] text-ds-t3">Loading submission gaps…</div>
    ),
  },
);

type Tab = "overview" | "gaps";

/* ── Formatting ── */
const nf = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString("en-IN"));

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

const PLATFORM_COLOR: Record<string, string> = {
  facebook: "var(--hx-2F86F0)", instagram: "var(--hx-DD3FAF)", youtube: "var(--hx-E52D47)", snapchat: "var(--hx-E9BD62)",
  twitter: "var(--hx-A7B3C2)", linkedin: "var(--hx-238BFF)", tiktok: "var(--hx-00D7A0)",
};
const PLATFORM_NAME: Record<string, string> = {
  facebook: "Facebook", instagram: "Instagram", youtube: "YouTube", snapchat: "Snapchat",
  twitter: "Twitter", linkedin: "LinkedIn", tiktok: "TikTok",
};
const platName = (p: string) => PLATFORM_NAME[p?.toLowerCase()] ?? (p ? p.charAt(0).toUpperCase() + p.slice(1) : "—");
const platColor = (p: string) => PLATFORM_COLOR[p?.toLowerCase()] ?? "var(--hx-738395)";

const rgba = (hex: string, a: number) => {
  if (hex.startsWith("var(")) return `color-mix(in srgb, ${hex} ${Math.round(a * 100)}%, transparent)`; const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};
const HUES = ["var(--hx-238BFF)", "var(--hx-E9BD62)", "var(--hx-9B7EDE)", "var(--hx-00D7A0)", "var(--hx-FB7185)", "var(--hx-6EB2FF)"];
const hueOf = (name: string) => {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return HUES[h % HUES.length];
};
const initials = (name: string) => (name || "?").split(/\s+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 2).toUpperCase();

/** Rank badge colours: gold / silver / bronze, then neutral. */
function rankStyle(i: number): React.CSSProperties {
  if (i === 0) return { background: "rgba(233,189,98,.16)", color: "var(--hx-E9BD62)" };
  if (i === 1) return { background: "rgba(212,219,228,.12)", color: "var(--hx-D4DBE4)" };
  if (i === 2) return { background: "rgba(240,128,60,.14)", color: "var(--hx-F0A070)" };
  return { background: "var(--hx-132430)", color: "var(--hx-738395)" };
}

/** A round axis maximum (1, 2, 2.5, 5 × 10^n) at or above the data's peak. */
function niceMax(v: number): number {
  if (v <= 0) return 4;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/* ── Building blocks ── */
const CARD = "flex flex-col rounded-[16px] border border-[color:var(--hx-2A4658)] bg-ds-card overflow-hidden shadow-[0_12px_32px_rgba(0,0,0,.35)] min-w-0";

function CardHead({ title, icon, right }: { title: string; icon?: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-x-4 gap-y-2 min-h-[62px] px-5 sm:px-6 py-3 border-b border-[color:var(--hx-182C39)] flex-wrap">
      <span className="flex items-center gap-2.5 text-[15px] font-semibold tracking-[-.01em] text-ds-text whitespace-nowrap">
        {icon}
        {title}
      </span>
      {right}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-6 py-10 text-center text-[12.5px] text-ds-t3">{children}</p>;
}

function Loading() {
  return (
    <div className="p-5 sm:p-6 space-y-3" aria-busy="true">
      {[0, 1, 2].map((i) => <div key={i} className="h-10 rounded-[8px] bg-ds-inset motion-safe:animate-pulse" />)}
    </div>
  );
}

function StatCard({ icon, color, value, label, valueColor }: { icon: React.ReactNode; color: string; value: string; label: string; valueColor?: string }) {
  return (
    <div className="flex flex-col gap-4 px-5 sm:px-[22px] py-5 rounded-[16px] bg-ds-card border border-[color:var(--hx-2A4658)] min-w-0">
      <span className="h-[34px] w-[34px] rounded-[10px] grid place-items-center" style={{ background: rgba(color, 0.14), color }}>
        {icon}
      </span>
      <span className="leading-[1.2] min-w-0">
        <span className="block text-[26px] sm:text-[30px] font-bold tracking-[-.04em] tabular-nums whitespace-nowrap truncate" style={{ color: valueColor ?? "var(--hx-F4F6F8)" }}>
          {value}
        </span>
        <span className="text-[12.5px] text-ds-t3">{label}</span>
      </span>
    </div>
  );
}

/* ── Daily trend: gold area chart with a hover read-out ── */
function DailyChart({ points }: { points: { date: string; links: number; reports: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const n = points.length;
  let max = niceMax(Math.max(0, ...points.map((p) => p.links)));
  if (max < 20) max = Math.ceil(max / 4) * 4; // quarter ticks stay whole numbers
  const ticks = [max, max * 0.75, max * 0.5, max * 0.25, 0];
  const x = (i: number) => (n <= 1 ? 500 : (i / (n - 1)) * 1000);
  const y = (v: number) => 240 - (v / max) * 240;
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.links).toFixed(1)}`).join(" ");
  const area = n > 0 ? `${line} L${x(n - 1).toFixed(1)},240 L${x(0).toFixed(1)},240 Z` : "";
  const step = Math.max(1, Math.ceil(n / 8));
  const xTicks = points.map((p, i) => ({ i, label: p.date })).filter(({ i }) => i % step === 0 || i === n - 1);

  const onMove = (e: React.MouseEvent) => {
    const el = plotRef.current;
    if (!el || n === 0) return;
    const r = el.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    setHover(n <= 1 ? 0 : Math.round(frac * (n - 1)));
  };
  const h = hover != null ? points[hover] : null;

  return (
    <div className="px-4 sm:px-6 pt-5 pb-4">
      <div className="grid grid-cols-[40px_minmax(0,1fr)] gap-2">
        <div className="flex flex-col justify-between h-[240px] text-[10.5px] text-ds-t3 text-right tabular-nums">
          {ticks.map((t, i) => <span key={i} className="leading-[0]">{nf(Math.round(t))}</span>)}
        </div>
        <div ref={plotRef} className="relative h-[240px]" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          <div className="absolute inset-0 flex flex-col justify-between pointer-events-none">
            {ticks.map((_, i) => <span key={i} className="h-0 border-t border-dashed border-[color:var(--hx-182C39)]" />)}
          </div>
          <svg viewBox="0 0 1000 240" preserveAspectRatio="none" className="absolute inset-0 w-full h-full overflow-visible" aria-hidden="true">
            <defs>
              <linearGradient id="la-daily" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="var(--hx-E9BD62)" stopOpacity=".3" />
                <stop offset="1" stopColor="var(--hx-E9BD62)" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d={area} fill="url(#la-daily)" />
            <path d={line} fill="none" stroke="var(--hx-E9BD62)" strokeWidth="2.2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
          </svg>
          {h && hover != null && (
            <>
              <span className="absolute top-0 bottom-0 w-px bg-[rgba(233,189,98,.35)] pointer-events-none" style={{ left: `${x(hover) / 10}%` }} />
              <span
                className="absolute h-2.5 w-2.5 -ml-[5px] -mt-[5px] rounded-full bg-ds-gold ring-4 ring-[rgba(233,189,98,.2)] pointer-events-none"
                style={{ left: `${x(hover) / 10}%`, top: `${(y(h.links) / 240) * 100}%` }}
              />
              <div
                className="absolute top-1 z-10 px-3 py-2 rounded-[10px] bg-[color:var(--hx-0B1720)] border border-ds-line2 shadow-[0_12px_28px_rgba(0,0,0,.55)] pointer-events-none whitespace-nowrap"
                style={hover > n / 2 ? { right: `calc(${100 - x(hover) / 10}% + 12px)` } : { left: `calc(${x(hover) / 10}% + 12px)` }}
              >
                <p className="text-[11px] text-ds-t3">{h.date}</p>
                <p className="text-[13px] font-semibold text-ds-text tabular-nums">
                  <span className="text-ds-gold">{nf(h.links)}</span> links · {nf(h.reports)} reports
                </p>
              </div>
            </>
          )}
        </div>
      </div>
      <div className="relative h-4 mt-2.5 ml-12 text-[10.5px] text-ds-t3 whitespace-nowrap">
        {xTicks.map(({ i, label }) => (
          <span
            key={i}
            className="absolute"
            style={{ left: `${x(i) / 10}%`, transform: i === 0 ? "none" : i === n - 1 ? "translateX(-100%)" : "translateX(-50%)" }}
          >
            {label}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ── Inline range toolbar (mockup: pills + From / To in one scrollable row) ── */
function RangeBar({ startDate, endDate, onChange }: { startDate: string; endDate: string; onChange: (s: string, e: string) => void }) {
  const active = activePresetLabel(startDate, endDate);
  const LABEL = "text-[10.5px] font-semibold tracking-[.12em] uppercase text-ds-t3";
  const FIELD =
    "h-9 px-2.5 rounded-full border border-ds-line2 bg-ds-inset text-ds-text text-[16px] sm:text-[12.5px] outline-none [color-scheme:dark] focus:border-[rgba(233,189,98,.55)]";
  return (
    <>
      <div className="flex gap-1.5 shrink-0" role="group" aria-label="Range">
        {RANGE_PRESETS.map((p) => {
          const on = active === p.label;
          return (
            <button
              key={p.label}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(presetStart(p.days), todayISO())}
              className={`h-9 min-w-[46px] px-[13px] rounded-full border text-[12.5px] font-semibold whitespace-nowrap shrink-0 transition-colors ${
                on ? "border-ds-gold bg-ds-gold text-[color:var(--hx-060D14)]" : "border-ds-line2 bg-ds-inset text-ds-t2 hover:text-ds-text"
              }`}
            >
              {p.label}
            </button>
          );
        })}
      </div>
      <span className="w-px h-6 bg-ds-line2 shrink-0 mx-1" aria-hidden="true" />
      <label className="flex items-center gap-2 shrink-0">
        <span className={LABEL}>From</span>
        <input type="date" value={startDate} max={endDate} onChange={(e) => onChange(e.target.value, endDate)} className={FIELD} />
      </label>
      <label className="flex items-center gap-2 shrink-0">
        <span className={LABEL}>To</span>
        <input type="date" value={endDate} min={startDate} max={todayISO()} onChange={(e) => onChange(startDate, e.target.value)} className={FIELD} />
      </label>
      {active === null && (
        <button
          type="button"
          onClick={() => onChange(presetStart(30), todayISO())}
          className="h-9 inline-flex items-center gap-1 rounded-full border border-ds-line2 px-3 text-[12px] text-ds-t2 hover:text-[color:var(--hx-FB7185)] shrink-0"
          title="Reset to last 30 days"
        >
          <X className="h-3 w-3" /> Reset
        </button>
      )}
    </>
  );
}

export default function LinksAnalyticsPage() {
  usePageTitle("Links Analytics");

  // Default to last 30 days; pills + custom range drive every chart/stat on the page.
  const [startDate, setStartDate] = useState(() => presetStart(30));
  const [endDate, setEndDate] = useState(() => todayISO());

  const windowLabel = rangeLabel(startDate, endDate);
  const [tab, setTab] = useState<Tab>("overview");

  // The Overview's requests exist only while the Overview is showing: with the Gaps tab
  // open, changing the range must not also refetch these (links-analytics loads every
  // link in the window). Overview is the default tab, so the first load is unchanged.
  const overviewShown = tab === "overview";
  const { data, isLoading } = useLinksAnalytics(startDate, endDate, overviewShown);
  const { data: accountsData, isLoading: accountsLoading } = useLinksAllAccounts(startDate, endDate, overviewShown);
  const [ytAllTime, setYtAllTime] = useState(false);
  const { data: topYouTubeData, isLoading: topYouTubeLoading } = useTopYouTubeLinks(
    ytAllTime ? undefined : startDate,
    ytAllTime ? undefined : endDate,
    20,
    overviewShown,
  );
  const allAccounts: any[] = useMemo(() => (accountsData as any)?.data ?? [], [accountsData]);
  const [expandedAccount, setExpandedAccount] = useState<string | null>(null);
  const d = (data as any)?.data;

  const rawDaily = d?.dailyTrend;
  const rawWeekly = d?.weeklyTrend;
  const dailyTrend = useMemo(() => (rawDaily ?? []).map((x: any) => ({
    date: fmtDate(x.date),
    links: x.linkCount ?? 0,
    reports: x.reportCount ?? 0,
  })), [rawDaily]);
  const weeklyTrend = useMemo(() => (rawWeekly ?? []).map((x: any) => ({
    week: fmtDate(x.weekStart),
    links: x.linkCount ?? 0,
  })), [rawWeekly]);
  const platformBreakdown: { platform: string; count: number; pct: number }[] = d?.platformBreakdown ?? [];
  const teamRanks: any[] = d?.teamRanks ?? [];
  const topSubmitters: any[] = d?.topSubmitters ?? [];
  const nonSubmitters: any[] = d?.nonSubmitters ?? [];
  const growthRate: number | null = d?.growthRate ?? null;
  const isPositiveGrowth = (growthRate ?? 0) >= 0;

  const peak = dailyTrend.reduce((m: { date: string; links: number } | null, p: { date: string; links: number }) => (m == null || p.links > m.links ? p : m), null);
  const weeklyMax = Math.max(1, ...weeklyTrend.map((w: { links: number }) => w.links));
  const platMax = Math.max(1, ...platformBreakdown.map((p) => p.pct));
  const topLinks: any[] = (topYouTubeData as any)?.data ?? [];

  return (
    <div className="pb-10">
      {/* Back + title */}
      <section className="pt-[22px]">
        <Link href="/reports" className="inline-flex items-center gap-2 text-[13.5px] font-medium text-ds-t2 hover:text-ds-text transition-colors">
          <ArrowLeft className="h-[15px] w-[15px]" strokeWidth={1.8} /> Reports
        </Link>
      </section>
      <section className="pt-3.5 pb-[18px]">
        <h1 className="text-[28px] sm:text-[34px] font-bold tracking-[-.03em] text-ds-text leading-tight">Links Analytics</h1>
        <p className="mt-1.5 text-[13.5px] text-ds-t2">Organisation-wide link submission insights · {windowLabel}</p>
      </section>

      {/* Toolbar — exports + range; the range drives both tabs */}
      <section className="flex items-center gap-2 overflow-x-auto overflow-y-hidden pb-1 [scrollbar-width:thin]">
        <div className="shrink-0"><ExportButton startDate={startDate} endDate={endDate} variant="ds" /></div>
        <div className="shrink-0"><AllLinksCsvButton startDate={startDate} endDate={endDate} variant="ds" /></div>
        <span className="w-px h-6 bg-ds-line2 shrink-0 mx-1" aria-hidden="true" />
        <RangeBar startDate={startDate} endDate={endDate} onChange={(s, e) => { setStartDate(s); setEndDate(e); }} />
      </section>

      {/* Tabs */}
      <div role="tablist" aria-label="Links analytics views" className="flex gap-1 p-1 mt-5 rounded-full bg-ds-inset border border-ds-line2 w-max max-w-full">
        {([
          ["overview", "Overview"],
          ["gaps", "Submission gaps"],
        ] as [Tab, string][]).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`links-tab-${id}`}
            aria-selected={tab === id}
            aria-controls={`links-panel-${id}`}
            onClick={() => setTab(id)}
            className={`h-[38px] px-5 rounded-full text-[13px] font-bold whitespace-nowrap transition-colors ${
              tab === id ? "bg-ds-gold text-[color:var(--hx-060D14)]" : "text-ds-t2 hover:text-ds-text"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "gaps" && (
        <div role="tabpanel" id="links-panel-gaps" aria-labelledby="links-tab-gaps" className="mt-4">
          <SubmissionGapsPanel startDate={startDate} endDate={endDate} windowLabel={windowLabel} />
        </div>
      )}

      {tab === "overview" && (
        <div role="tabpanel" id="links-panel-overview" aria-labelledby="links-tab-overview">
          {/* Stats */}
          <section className="grid grid-cols-2 lg:grid-cols-4 gap-3.5 mt-5">
            <StatCard icon={<Link2 className="h-4 w-4" />} color="var(--hx-E9BD62)" value={isLoading || !d ? "—" : nf(d.totalLinks ?? 0)} label="Total Links" />
            <StatCard icon={<TrendingUp className="h-4 w-4" />} color="var(--hx-6EB2FF)" value={isLoading || !d ? "—" : nf(d.avgLinksPerDay ?? 0)} label="Avg Links/Day" />
            <StatCard
              icon={isPositiveGrowth ? <TrendingUp className="h-4 w-4" /> : <TrendingDown className="h-4 w-4" />}
              color={isPositiveGrowth ? "var(--hx-00D7A0)" : "var(--hx-FB7185)"}
              valueColor={isLoading || growthRate === null ? undefined : isPositiveGrowth ? "var(--hx-00D7A0)" : "var(--hx-FB7185)"}
              value={isLoading ? "—" : growthRate === null ? "—" : `${isPositiveGrowth ? "+" : ""}${growthRate}%`}
              label="Growth vs Previous Period"
            />
            <StatCard icon={<AlertCircle className="h-4 w-4" />} color="var(--hx-FB7185)" value={isLoading || !d ? "—" : nf(nonSubmitters.length)} label="Non-Submitters" />
          </section>

          {/* Daily trend */}
          <section className={`${CARD} mt-4`}>
            <CardHead
              title="Daily Links Trend"
              right={peak && !isLoading ? <span className="text-[12px] text-ds-t3">Peak <b className="font-semibold text-ds-gold tabular-nums">{nf(peak.links)}</b> on {peak.date}</span> : undefined}
            />
            {isLoading ? <Loading /> : dailyTrend.length === 0 ? <Empty>No data in range</Empty> : <DailyChart points={dailyTrend} />}
          </section>

          {/* Weekly + Platforms */}
          <section className="grid gap-4 mt-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr))]">
            <div className={CARD}>
              <CardHead title="Weekly Trend" right={<span className="text-[12px] text-ds-t3">Links per week</span>} />
              {isLoading ? <Loading /> : weeklyTrend.length === 0 ? <Empty>No data</Empty> : (
                <div className="flex items-end gap-2.5 h-[230px] px-5 sm:px-6 pt-5 pb-4">
                  {weeklyTrend.map((w: { week: string; links: number }, i: number) => (
                    <div key={i} className="group flex-1 min-w-0 flex flex-col items-center justify-end gap-2 h-full" title={`Week of ${w.week}: ${nf(w.links)} links`}>
                      <span className="text-[11px] font-semibold text-ds-t5 tabular-nums">{fmtCompact(w.links)}</span>
                      <span
                        className="w-full max-w-[40px] rounded-t-[6px] rounded-b-[2px] transition-opacity group-hover:opacity-80"
                        style={{ height: `${Math.max(2, (w.links / weeklyMax) * 100) * 0.72}%`, background: "linear-gradient(180deg,var(--hx-E9BD62),rgba(233,189,98,.4))" }}
                      />
                      <span className="text-[10.5px] text-ds-t3 whitespace-nowrap">{w.week}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className={CARD}>
              <CardHead
                title="Platform Breakdown"
                right={
                  <span className="flex gap-3.5 text-[12px] text-ds-t3">
                    {d?.bestChannel && <span>Best: <b className="font-semibold text-ds-teal">{platName(d.bestChannel.platform)}</b></span>}
                    {d?.worstChannel && <span>Least: <b className="font-semibold text-[color:var(--hx-FB7185)]">{platName(d.worstChannel.platform)}</b></span>}
                  </span>
                }
              />
              {isLoading ? <Loading /> : platformBreakdown.length === 0 ? <Empty>No platform data</Empty> : (
                <div className="flex flex-col gap-[18px] p-5 sm:p-6">
                  {platformBreakdown.map((p) => (
                    <div key={p.platform} className="flex flex-col gap-2">
                      <div className="flex items-center justify-between gap-2.5">
                        <span className="flex items-center gap-2 text-[13px] font-semibold text-ds-text">
                          <i className="h-2 w-2 rounded-full" style={{ background: platColor(p.platform) }} />
                          {platName(p.platform)}
                        </span>
                        <span className="text-[12px] text-ds-t3 tabular-nums"><b className="font-semibold text-ds-t5">{nf(p.count)}</b> · {p.pct}%</span>
                      </div>
                      <span className="h-2 rounded-[4px] bg-[color:var(--hx-132430)] overflow-hidden">
                        <span className="block h-full rounded-[4px] transition-all duration-500" style={{ width: `${(p.pct / platMax) * 100}%`, background: platColor(p.platform) }} />
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          {/* Team ranks + Top submitters */}
          <section className="grid gap-4 mt-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr))]">
            <div className={CARD}>
              <CardHead title="Team Rankings" icon={<Trophy className="h-4 w-4 text-ds-gold" strokeWidth={1.8} />} right={<span className="text-[12px] text-ds-t3">Total links</span>} />
              {isLoading ? <Loading /> : teamRanks.length === 0 ? <Empty>No team data in range</Empty> : (
                <div>
                  {teamRanks.map((t, i) => (
                    <div key={t.teamId} className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-3.5 min-h-[62px] px-5 sm:px-6 py-2 border-b border-[color:var(--hx-132430)] last:border-b-0">
                      <span className="h-7 w-7 rounded-full grid place-items-center text-[11.5px] font-bold" style={rankStyle(i)}>{i + 1}</span>
                      <span className="flex flex-col gap-0.5 min-w-0 leading-[1.25]">
                        <span className="text-[14px] font-semibold text-ds-text truncate">{t.teamName}</span>
                        <span className="text-[11.5px] text-ds-t3 truncate">{t.memberCount} members · {t.avgLinksPerMember} avg/member</span>
                      </span>
                      <span className="text-[16px] font-bold text-ds-gold tabular-nums">{nf(t.totalLinks)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className={CARD}>
              <CardHead title="Top Submitters" icon={<Users className="h-4 w-4 text-[color:var(--hx-6EB2FF)]" strokeWidth={1.8} />} right={<span className="text-[12px] text-ds-t3">Total links</span>} />
              {isLoading ? <Loading /> : topSubmitters.length === 0 ? <Empty>No submissions in range</Empty> : (
                <div>
                  {topSubmitters.map((emp, i) => (
                    <div key={emp.employeeId} className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-3.5 min-h-[62px] px-5 sm:px-6 py-2 border-b border-[color:var(--hx-132430)] last:border-b-0">
                      <span className="h-7 w-7 rounded-full grid place-items-center text-[11.5px] font-bold" style={rankStyle(i)}>{i + 1}</span>
                      <span className="flex flex-col gap-0.5 min-w-0 leading-[1.25]">
                        <Link href={`/reports/${emp.employeeId}`} className="text-[14px] font-semibold text-ds-text hover:text-ds-gold transition-colors truncate">{emp.name}</Link>
                        <span className="text-[11.5px] text-ds-t3 truncate">{nf(emp.reportCount)} reports</span>
                      </span>
                      <span className="text-[16px] font-bold text-[color:var(--hx-6EB2FF)] tabular-nums">{nf(emp.totalLinks)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          {/* Non-submitters */}
          {nonSubmitters.length > 0 && (
            <section className={`${CARD} mt-4`}>
              <CardHead
                title="No Submissions in Range"
                icon={<AlertCircle className="h-4 w-4 text-[color:var(--hx-FB7185)]" strokeWidth={1.8} />}
                right={<span className="text-[12px] font-semibold text-[color:var(--hx-FB7185)]">{nonSubmitters.length} employee{nonSubmitters.length !== 1 ? "s" : ""}</span>}
              />
              <div className="flex flex-wrap gap-2 px-5 sm:px-6 py-5">
                {nonSubmitters.map((emp) => (
                  <Link
                    key={emp.employeeId}
                    href={`/employees/${emp.employeeId}`}
                    className="inline-flex items-center gap-2 h-[34px] pl-[5px] pr-3.5 rounded-full border border-[rgba(251,113,133,.25)] bg-[rgba(251,113,133,.08)] text-[12.5px] font-semibold text-[color:var(--hx-FDA4AF)] whitespace-nowrap transition-colors hover:bg-[rgba(251,113,133,.14)] hover:text-[color:var(--hx-FECDD3)]"
                  >
                    <span className="h-6 w-6 rounded-full grid place-items-center bg-[rgba(251,113,133,.16)] text-[10px] font-bold">{initials(emp.name)}</span>
                    {emp.name}
                  </Link>
                ))}
              </div>
            </section>
          )}

          {/* By Account */}
          <section className={`${CARD} mt-4`}>
            <CardHead
              title="By Account"
              icon={<BarChart2 className="h-4 w-4 text-[color:var(--hx-6EB2FF)]" strokeWidth={1.8} />}
              right={<span className="text-[12px] text-ds-t3">{allAccounts.length} channel{allAccounts.length !== 1 ? "s" : ""} active in range</span>}
            />
            {accountsLoading ? <Loading /> : allAccounts.length === 0 ? <Empty>No account-linked submissions in this range</Empty> : (
              <div className="flex flex-col">
                {allAccounts.map((account, i) => {
                  const isExpanded = expandedAccount === account.accountId;
                  const pc = platColor(account.platform);
                  return (
                    <div key={account.accountId} className="border-b border-[color:var(--hx-132430)] last:border-b-0">
                      <button
                        type="button"
                        onClick={() => setExpandedAccount(isExpanded ? null : account.accountId)}
                        aria-expanded={isExpanded}
                        className={`w-full grid grid-cols-[22px_minmax(0,1fr)_auto_16px] sm:grid-cols-[28px_minmax(0,1fr)_auto_20px] items-center gap-3 sm:gap-3.5 min-h-[72px] px-4 sm:px-6 py-3 text-left transition-colors hover:bg-[color:var(--hx-0A1620)] ${isExpanded ? "bg-[color:var(--hx-0A1620)]" : ""}`}
                      >
                        <span className="text-[12px] font-bold text-ds-t3 text-right tabular-nums">{i + 1}</span>
                        <span className="flex flex-col gap-1 min-w-0">
                          <span className="flex items-center gap-2 min-w-0 flex-wrap">
                            <span className="text-[14.5px] font-semibold text-ds-text truncate max-w-full">{account.displayName}</span>
                            <span className="h-[22px] px-[9px] rounded-full text-[11px] font-semibold inline-flex items-center shrink-0 whitespace-nowrap" style={{ background: rgba(pc, 0.14), color: pc }}>
                              {platName(account.platform)}
                            </span>
                            {account.handle && <span className="text-[11.5px] text-ds-t3 truncate min-w-0">@{String(account.handle).replace(/^@+/, "")}</span>}
                          </span>
                          <span className="text-[11.5px] text-ds-t3 truncate">
                            {account.employeeCount} employee{account.employeeCount !== 1 ? "s" : ""}
                            {account.topEmployee ? ` · top: ${account.topEmployee.name} (${account.topEmployee.totalLinks})` : ""}
                          </span>
                        </span>
                        <span className="flex items-baseline gap-1.5">
                          <b className="text-[18px] font-bold text-ds-gold tabular-nums">{nf(account.totalLinks)}</b>
                          <span className="hidden sm:inline text-[11.5px] text-ds-t3">links</span>
                        </span>
                        <ChevronRight className={`h-4 w-4 text-ds-t3 transition-transform duration-200 ${isExpanded ? "rotate-90" : ""}`} />
                      </button>

                      {isExpanded && (
                        <div className="flex flex-col gap-3 px-4 sm:pl-[66px] sm:pr-6 pt-4 pb-[18px] bg-ds-inset border-t border-[color:var(--hx-132430)]">
                          {account.employees.map((emp: any) => {
                            const hue = hueOf(emp.name ?? "");
                            return (
                              <div key={emp.employeeId} className="grid grid-cols-[28px_minmax(0,1fr)_40px_44px] sm:grid-cols-[28px_minmax(0,170px)_minmax(0,1fr)_44px_56px] items-center gap-3">
                                <span className="h-7 w-7 rounded-full grid place-items-center text-[10px] font-bold" style={{ background: rgba(hue, 0.16), color: hue }}>
                                  {initials(emp.name)}
                                </span>
                                <Link href={`/reports/${emp.employeeId}`} className="text-[12.5px] font-semibold text-ds-t5 hover:text-ds-gold transition-colors truncate">
                                  {emp.name}
                                </Link>
                                <span className="hidden sm:block h-1.5 rounded-[3px] bg-[color:var(--hx-132430)] overflow-hidden">
                                  <span className="block h-full rounded-[3px] bg-[color:var(--hx-6EB2FF)] transition-all duration-500" style={{ width: `${emp.pct}%` }} />
                                </span>
                                <span className="text-[11.5px] text-ds-t3 text-right tabular-nums">{emp.pct}%</span>
                                <span className="text-[12.5px] font-semibold text-ds-text text-right tabular-nums">{nf(emp.totalLinks)}</span>
                              </div>
                            );
                          })}
                          <div className="flex justify-between gap-4 pt-3 border-t border-[color:var(--hx-182C39)] text-[11.5px] text-ds-t3 whitespace-nowrap">
                            <span>Total for this channel</span>
                            <Link href={`/accounts/${account.accountId}`} className="font-semibold text-ds-gold hover:text-[color:var(--hx-F4D58C)]">
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
          </section>

          {/* Top YouTube Links */}
          {(topYouTubeLoading || topLinks.length > 0) && (
            <section className={`${CARD} mt-4`}>
              <div className="flex items-center justify-between gap-x-4 gap-y-2 min-h-[62px] px-5 sm:px-6 py-3 border-b border-[color:var(--hx-182C39)] flex-wrap">
                <span className="flex items-center gap-3 flex-wrap">
                  <span className="h-8 w-8 rounded-[9px] grid place-items-center bg-[rgba(251,113,133,.12)] text-[color:var(--hx-FB7185)]">
                    <Eye className="h-[15px] w-[15px]" strokeWidth={1.8} />
                  </span>
                  <span className="text-[15px] font-semibold tracking-[-.01em] text-ds-text whitespace-nowrap">Top YouTube Links</span>
                  <span className="flex gap-[3px] p-[3px] rounded-full bg-ds-inset border border-ds-line2">
                    {[
                      { allTime: false, label: windowLabel },
                      { allTime: true, label: "All time" },
                    ].map((m) => (
                      <button
                        key={m.label}
                        type="button"
                        aria-pressed={ytAllTime === m.allTime}
                        onClick={() => setYtAllTime(m.allTime)}
                        className={`h-[26px] px-3 rounded-full text-[11.5px] font-semibold whitespace-nowrap transition-colors ${
                          ytAllTime === m.allTime ? "bg-ds-gold text-[color:var(--hx-060D14)]" : "text-ds-t2 hover:text-ds-text"
                        }`}
                      >
                        {m.label}
                      </button>
                    ))}
                  </span>
                </span>
                <span className="text-[12px] text-ds-t3">YouTube only</span>
              </div>
              {topYouTubeLoading ? <Loading /> : (
                <div className="overflow-x-auto">
                  <div className="min-w-[640px]">
                    <div className="grid grid-cols-[28px_minmax(0,1fr)_minmax(0,160px)_76px_70px_84px] gap-x-3.5 items-center h-[46px] px-6 bg-ds-inset border-b border-ds-line2 text-[11px] font-semibold tracking-[.08em] uppercase text-ds-t3 whitespace-nowrap">
                      <span>#</span><span>Link</span><span>Employee</span>
                      <span className="text-right">Views</span><span className="text-right">Likes</span><span className="text-right">Comments</span>
                    </div>
                    {topLinks.map((link: any, i: number) => (
                      <div
                        key={`${link.linkId ?? link.url}-${i}`}
                        className="grid grid-cols-[28px_minmax(0,1fr)_minmax(0,160px)_76px_70px_84px] gap-x-3.5 items-center h-[54px] px-6 border-b border-[color:var(--hx-132430)] last:border-b-0 text-[13px] tabular-nums transition-colors hover:bg-[color:var(--hx-0A1620)]"
                      >
                        <span className="text-[12px] font-bold text-ds-t3">{i + 1}</span>
                        <a href={link.url} target="_blank" rel="noopener noreferrer" title={link.url} className="min-w-0 truncate text-ds-t5 hover:text-ds-gold transition-colors">{link.url}</a>
                        <span className="text-ds-t2 truncate">{link.employeeName}</span>
                        <span className="flex items-center justify-end gap-[5px] font-semibold whitespace-nowrap text-[color:var(--hx-FDA4AF)]"><Eye className="h-3 w-3 shrink-0" />{fmtCompact(link.views)}</span>
                        <span className="flex items-center justify-end gap-[5px] font-semibold whitespace-nowrap text-[color:var(--hx-F9A8D4)]"><Heart className="h-3 w-3 shrink-0" />{fmtCompact(link.likes)}</span>
                        <span className="flex items-center justify-end gap-[5px] font-semibold whitespace-nowrap text-ds-t2"><MessageCircle className="h-3 w-3 shrink-0" />{fmtCompact(link.comments)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
