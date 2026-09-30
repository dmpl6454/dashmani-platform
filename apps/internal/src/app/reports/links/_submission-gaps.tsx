"use client";
import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertCircle, CalendarX2, CheckCircle2, ChevronDown, ChevronUp, Clock, Download, Hourglass, RefreshCw, Search, Users,
} from "lucide-react";
import { useSubmissionGaps, useSubmissionGapDays } from "@/lib/hooks/use-reports";
import { downloadCsv } from "@/lib/csv";

/**
 * Submission gaps — who did NOT submit links for the channels assigned to them.
 *
 * Contract with the page (do not break):
 *   • LAZY. This module is loaded with next/dynamic only when the "Submission gaps" tab
 *     is opened, and its SWR key only exists while it is mounted, so the Links
 *     Analytics page's normal load is unchanged.
 *   • The counting rules are the server's (submission-gaps.service.ts) and are stated
 *     on screen: every calendar day counts, days before the assignment are not counted,
 *     today is never "missed" — it is its own column.
 *   • A number renders only from loaded data. "—" means "nothing to show" (no countable
 *     days, no post in the window, window without today) — never a fabricated 0.
 *   • Team / platform are server-side filters (they change the per-person aggregates);
 *     search, "≥ N missed" and sorting are client-side over the loaded rows.
 */

interface Team { id: string; name: string }
type Range = [string, string];

interface PairRow {
  employee: { id: string; name: string; team: Team | null };
  account: { id: string; handle: string; displayName: string; platform: string; platformName: string };
  assignedSince: string;
  countedFrom: string | null;
  countedThrough: string | null;
  countedDays: number;
  activeDays: number;
  missedDays: number;
  activeRate: number | null;
  missedRanges: Range[];
  missedRangeCount: number;
  missedRangesTruncated: boolean;
  longestGapDays: number;
  currentGapDays: number;
  currentGapOpenEnded: boolean;
  lastPostedDay: string | null;
  lastPostedAt: string | null;
  lastPostedIST: string | null;
  lastPostedApprox: boolean;
  linkCount: number;
  todayStatus: "posted" | "not_yet" | null;
  todayLinks: number;
}

interface PersonRow {
  employee: { id: string; name: string; team: Team | null };
  accountCount: number;
  countedFrom: string | null;
  countedThrough: string | null;
  countedDays: number;
  activeDays: number;
  missedDays: number;
  partialDays: number;
  missedChannelDays: number;
  activeRate: number | null;
  missedRanges: Range[];
  missedRangeCount: number;
  missedRangesTruncated: boolean;
  longestGapDays: number;
  currentGapDays: number;
  currentGapOpenEnded: boolean;
  lastPostedDay: string | null;
  lastPostedAt: string | null;
  lastPostedIST: string | null;
  lastPostedApprox: boolean;
  linkCount: number;
  todayStatus: "posted" | "partial" | "not_yet" | null;
  todayPostedAccounts: number;
  todayLinks: number;
}

interface GapsData {
  range: {
    startDate: string;
    endDate: string;
    today: string;
    includesToday: boolean;
    countedThrough: string;
    exactTimesSince: string;
  };
  rows: PairRow[];
  employees: PersonRow[];
  totals: {
    assignments: number;
    employees: number;
    countedDays: number;
    missedDays: number;
    notYetToday: number | null;
    truncated: boolean;
  };
  excluded: { inactiveChannelAssignments: number };
  filters: { teams: Team[]; platforms: { slug: string; name: string }[] };
}

interface GapDay {
  date: string;
  status: "posted" | "missed" | "today_posted" | "today_pending";
  linkCount: number;
  firstPostedIST: string | null;
  lastPostedIST: string | null;
  approximate: boolean;
}

type View = "channels" | "people";
type SortKey = "missed" | "gap" | "rate" | "last" | "name";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "missed", label: "Most missed days" },
  { key: "gap", label: "Longest current gap" },
  { key: "rate", label: "Lowest active rate" },
  { key: "last", label: "Oldest last post" },
  { key: "name", label: "Name (A–Z)" },
];

const PAGE = 100;
const DAYS_PREVIEW = 62;
const RANGE_CHIPS = 6;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const nf = new Intl.NumberFormat("en-IN");

// All formatting works on the strings the API sends (IST calendar days and IST
// "YYYY-MM-DD HH:MM" times). Nothing goes through new Date(...) + the browser's
// timezone, so a device outside India still shows the IST day.
function fmtDay(iso: string, currentYear: string): string {
  const [y, m, d] = iso.split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1] ?? m}${y !== currentYear ? ` ${y}` : ""}`;
}

function fmtRange([s, e]: Range, currentYear: string): string {
  if (s === e) return fmtDay(s, currentYear);
  const [sy, sm, sd] = s.split("-");
  const [ey, em, ed] = e.split("-");
  if (sy === ey && sm === em) return `${Number(sd)}–${Number(ed)} ${MONTHS[Number(em) - 1]}${ey !== currentYear ? ` ${ey}` : ""}`;
  return `${fmtDay(s, currentYear)} – ${fmtDay(e, currentYear)}`;
}

function rangeDays([s, e]: Range): number {
  return Math.round((Date.parse(`${e}T00:00:00Z`) - Date.parse(`${s}T00:00:00Z`)) / 86_400_000) + 1;
}

function shiftDay(iso: string, delta: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** Mirrors the server's validation so an impossible window never becomes a request. */
function rangeProblem(start: string, end: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return "Pick a start and an end date.";
  if (start > end) return "The start date must be on or before the end date.";
  if (start < "2025-01-01") return "Pick a start date in 2025 or later — there is no report data before that.";
  if (rangeDays([start, end]) > 366) return "Pick a window of at most 366 days — longer ranges are not analysed at once.";
  return null;
}

function weekday(iso: string): string {
  return WEEKDAYS[new Date(`${iso}T00:00:00Z`).getUTCDay()] ?? "";
}

function pct(rate: number | null): string {
  return rate == null ? "—" : `${Math.round(rate * 100)}%`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${nf.format(n)} ${n === 1 ? one : many}`;
}

function compareRows<T extends { missedDays: number; currentGapDays: number; activeRate: number | null; lastPostedDay: string | null; lastPostedAt: string | null; employee: { name: string } }>(
  key: SortKey,
  tiebreak: (a: T, b: T) => number,
) {
  return (a: T, b: T): number => {
    let d = 0;
    if (key === "missed") d = b.missedDays - a.missedDays;
    else if (key === "gap") d = b.currentGapDays - a.currentGapDays;
    else if (key === "rate") {
      // No countable days (null) sorts last — it is not a low rate, it is no rate.
      if (a.activeRate == null || b.activeRate == null) d = a.activeRate == null ? (b.activeRate == null ? 0 : 1) : -1;
      else d = a.activeRate - b.activeRate;
    } else if (key === "last") {
      // Never posted in this window sorts FIRST — it is older than any post in it.
      if (a.lastPostedDay == null || b.lastPostedDay == null) d = a.lastPostedDay == null ? (b.lastPostedDay == null ? 0 : -1) : 1;
      else d = a.lastPostedDay.localeCompare(b.lastPostedDay) || (a.lastPostedAt ?? "").localeCompare(b.lastPostedAt ?? "");
    }
    return d || a.employee.name.localeCompare(b.employee.name) || tiebreak(a, b);
  };
}

function MetricLabel({ children }: { children: React.ReactNode }) {
  return <span className="xl:hidden block text-[10px] font-semibold uppercase tracking-wide text-ink-4">{children}</span>;
}

function TodayChip({ status, links, of }: { status: PairRow["todayStatus"] | PersonRow["todayStatus"]; links: number; of?: string }) {
  if (status == null) return <span className="text-sm text-ink-4" title="This window does not include today">—</span>;
  if (status === "posted") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-sage-soft px-2 py-0.5 text-[11px] font-semibold text-sage">
        <CheckCircle2 className="h-3 w-3" aria-hidden /> Posted{links > 0 ? ` · ${nf.format(links)}` : ""}
      </span>
    );
  }
  if (status === "partial") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
        <Hourglass className="h-3 w-3" aria-hidden /> Some{of ? ` · ${of}` : ""}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
      <Clock className="h-3 w-3" aria-hidden /> Not yet
    </span>
  );
}

function GapValue({ days, open, counted }: { days: number; open: boolean; counted: number }) {
  if (counted === 0) return <span className="text-sm text-ink-4">—</span>;
  if (days === 0) return <span className="text-sm font-medium text-sage">None</span>;
  return (
    <span
      className="text-sm font-semibold text-attention"
      title={open ? "The gap runs back past the start of this window — it may be longer. Widen the range to see where it began." : undefined}
    >
      {open ? "≥ " : ""}{plural(days, "day")}
    </span>
  );
}

/** A time with its own IST day appended when it is not the report day (a late submission). */
function timeFor(reportDay: string, ist: string | null, year: string): string {
  if (!ist) return "";
  const [date, time] = ist.split(" ");
  return date === reportDay ? time : `${time} (${fmtDay(date, year)})`;
}

function LastPosted({ day, ist, approx, year }: { day: string | null; ist: string | null; approx: boolean; year: string }) {
  if (!day) return <span className="text-sm text-ink-4" title="No link in this window">—</span>;
  return (
    <span
      className="block text-sm text-ink"
      title={approx ? "Approximate — before 3 Jun 2026 only the report's first-submit time is known" : "The latest day with a link, and the time of that day's last link"}
    >
      {fmtDay(day, year)}
      <span className="block text-xs text-ink-4 font-num">{approx ? "~" : ""}{timeFor(day, ist, year)} IST</span>
    </span>
  );
}

function MissedRanges({ ranges, total, truncated, year }: { ranges: Range[]; total: number; truncated: boolean; year: string }) {
  if (total === 0) return null;
  const shown = ranges.slice(-RANGE_CHIPS);
  const hidden = total - shown.length;
  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-2">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-4">Missed</span>
      {hidden > 0 && (
        <span className="text-[11px] text-ink-4" title={truncated ? "Open the day-by-day view for the full list" : undefined}>
          +{nf.format(hidden)} earlier
        </span>
      )}
      {shown.map((r) => (
        <span key={r[0]} className="rounded-md bg-attention/10 px-1.5 py-0.5 text-[11px] font-medium text-attention">
          {fmtRange(r, year)}
          {r[0] !== r[1] ? ` (${rangeDays(r)}d)` : ""}
        </span>
      ))}
    </div>
  );
}

function DayByDay({
  employeeId, accountId, startDate, endDate, year,
}: { employeeId: string; accountId: string; startDate: string; endDate: string; year: string }) {
  const { data, error, isLoading, mutate } = useSubmissionGapDays({ employeeId, accountId, startDate, endDate });
  const [showAll, setShowAll] = useState(false);
  const res = (data as { data?: { days: GapDay[]; assignedSince: string } } | undefined)?.data;

  if (!res && isLoading) return <p className="px-1 py-3 text-xs text-ink-4">Loading days…</p>;
  if (!res && error) {
    return (
      <div className="flex flex-wrap items-center gap-2 px-1 py-3 text-xs text-attention">
        <AlertCircle className="h-3.5 w-3.5" aria-hidden />
        <span className="min-w-0 break-words">Couldn&apos;t load the days: {(error as Error).message}</span>
        <button type="button" onClick={() => mutate()} className="rounded-full border border-ink/10 px-2.5 py-1 text-ink hover:bg-ink/5">
          Retry
        </button>
      </div>
    );
  }
  if (!res) return null;
  if (res.days.length === 0) {
    return <p className="px-1 py-3 text-xs text-ink-4">No countable days in this window (assigned {fmtDay(res.assignedSince, year)}).</p>;
  }
  const days = showAll ? res.days : res.days.slice(0, DAYS_PREVIEW);
  return (
    <div className="pt-3">
      <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
        {days.map((d) => {
          const posted = d.status === "posted" || d.status === "today_posted";
          const isToday = d.status === "today_posted" || d.status === "today_pending";
          const first = timeFor(d.date, d.firstPostedIST, year);
          const last = timeFor(d.date, d.lastPostedIST, year);
          const times = first && last ? (first === last ? first : `${first}–${last}`) : "";
          return (
            <li
              key={d.date}
              className={`flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs ${
                posted ? "border-sage/20 bg-sage-soft/40" : isToday ? "border-amber-200 bg-amber-50/60" : "border-attention/20 bg-attention/5"
              }`}
            >
              <span className="min-w-[4.5rem] shrink-0 whitespace-nowrap font-num text-ink">
                {weekday(d.date)} {fmtDay(d.date, year)}
              </span>
              <span className={`min-w-0 break-words ${posted ? "text-sage" : isToday ? "text-amber-700" : "text-attention"}`}>
                {isToday ? "Today · " : ""}
                {posted
                  ? `${plural(d.linkCount, "link")}${times ? ` · ${d.approximate ? "~" : ""}${times}` : ""}`
                  : isToday ? "not yet" : "No link"}
              </span>
            </li>
          );
        })}
      </ul>
      {res.days.length > DAYS_PREVIEW && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="mt-2 text-xs font-medium text-indigo hover:underline"
        >
          {showAll ? "Show fewer days" : `Show all ${nf.format(res.days.length)} days`}
        </button>
      )}
      <p className="pt-2 text-[11px] text-ink-4">Newest first. Times are IST; ~ marks an approximate time (before 3 Jun 2026).</p>
    </div>
  );
}

const GRID =
  "grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1.5fr)_4.5rem_5.5rem_6rem_7rem_6.5rem_2.5rem] xl:items-center";

export function SubmissionGapsPanel({
  startDate, endDate, windowLabel,
}: { startDate: string; endDate: string; windowLabel: string }) {
  const [view, setView] = useState<View>("channels");
  const [search, setSearch] = useState("");
  const [teamId, setTeamId] = useState("");
  const [platform, setPlatform] = useState("");
  const [minMissed, setMinMissed] = useState("0");
  const [sortKey, setSortKey] = useState<SortKey>("missed");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);

  const { data, error, isLoading, mutate } = useSubmissionGaps(true, {
    startDate,
    endDate,
    teamId: teamId || undefined,
    platform: platform || undefined,
  });
  const d = (data as { data?: GapsData } | undefined)?.data;
  const year = (d?.range.today ?? endDate).slice(0, 4);
  const problem = rangeProblem(startDate, endDate);
  // Keep the last filter options while a new filter loads, so a selected team never
  // appears to reset to "All teams" mid-request.
  const optionsRef = useRef<GapsData["filters"]>({ teams: [], platforms: [] });
  if (d) optionsRef.current = d.filters;
  const options = optionsRef.current;

  const q = search.trim().toLowerCase();
  const min = Math.max(0, Number.parseInt(minMissed, 10) || 0);

  const pairs = useMemo(() => {
    const rows = (d?.rows ?? []).filter(
      (r) =>
        r.missedDays >= min &&
        (!q ||
          r.employee.name.toLowerCase().includes(q) ||
          r.account.displayName.toLowerCase().includes(q) ||
          r.account.handle.toLowerCase().includes(q)),
    );
    return rows.sort(compareRows<PairRow>(sortKey, (a, b) => a.account.displayName.localeCompare(b.account.displayName)));
  }, [d, q, min, sortKey]);

  const people = useMemo(() => {
    const rows = (d?.employees ?? []).filter((r) => r.missedDays >= min && (!q || r.employee.name.toLowerCase().includes(q)));
    return rows.sort(compareRows<PersonRow>(sortKey, (a, b) => a.employee.id.localeCompare(b.employee.id)));
  }, [d, q, min, sortKey]);

  const channelsByPerson = useMemo(() => {
    const m = new Map<string, PairRow[]>();
    for (const r of d?.rows ?? []) {
      const list = m.get(r.employee.id) ?? [];
      list.push(r);
      m.set(r.employee.id, list);
    }
    return m;
  }, [d]);

  const list = view === "channels" ? pairs : people;
  const total = view === "channels" ? d?.rows.length ?? 0 : d?.employees.length ?? 0;
  const filtersNarrow = q !== "" || min > 0;

  const inGapNow = d ? d.employees.filter((e) => e.currentGapDays > 0).length : null;
  const endsYesterday = !!d && d.range.countedThrough === shiftDay(d.range.today, -1);
  const notYetPeople = d && d.range.includesToday ? d.employees.filter((e) => e.todayStatus === "not_yet").length : null;
  const onlyToday = !!d && d.range.countedThrough < d.range.startDate;

  function exportCsv() {
    if (!d) return;
    const yes = (b: boolean) => (b ? "Yes" : "");
    const rangesText = (rs: Range[]) => rs.map(([s, e]) => (s === e ? s : `${s}..${e}`)).join("; ");
    const todayText = (s: string | null) => (s == null ? "" : s === "not_yet" ? "Not yet" : s === "partial" ? "Some channels" : "Posted");
    const rate = (r: number | null) => (r == null ? "" : (r * 100).toFixed(1));
    if (view === "channels") {
      downloadCsv(
        `submission-gaps-channels-${d.range.startDate}_${d.range.endDate}.csv`,
        [
          "Person", "Team", "Channel", "Handle", "Platform", "Assigned since (IST)", "Counted from", "Counted through",
          "Counted days", "Active days", "Missed days", "Active rate %", "Longest gap (days)", "Current gap (days)",
          "Current gap may be longer?", "Last posted day (IST)", "Last posted at (IST)", "Last posted time approx?", "Links (counted days)",
          "Today", "Links today", "Missed ranges (most recent, up to 20)", "Missed ranges (total)",
        ],
        pairs.map((r) => [
          r.employee.name, r.employee.team?.name ?? "", r.account.displayName, r.account.handle, r.account.platformName,
          r.assignedSince, r.countedFrom ?? "", r.countedThrough ?? "", r.countedDays, r.activeDays, r.missedDays,
          rate(r.activeRate), r.countedDays ? r.longestGapDays : "", r.countedDays ? r.currentGapDays : "",
          yes(r.currentGapOpenEnded), r.lastPostedDay ?? "", r.lastPostedIST ?? "", yes(r.lastPostedApprox), r.linkCount,
          todayText(r.todayStatus), d.range.includesToday ? r.todayLinks : "", rangesText(r.missedRanges), r.missedRangeCount,
        ]),
      );
    } else {
      downloadCsv(
        `submission-gaps-people-${d.range.startDate}_${d.range.endDate}.csv`,
        [
          "Person", "Team", "Channels", "Counted days", "Active days", "Days with no link on any channel", "Partial days",
          "Missed channel-days", "Active rate %", "Longest gap (days)", "Current gap (days)", "Current gap may be longer?",
          "Last posted day (IST)", "Last posted at (IST)", "Last posted time approx?", "Links (counted days)", "Today", "Channels posted today",
          "Missed ranges (most recent, up to 20)", "Missed ranges (total)",
        ],
        people.map((r) => [
          r.employee.name, r.employee.team?.name ?? "", r.accountCount, r.countedDays, r.activeDays, r.missedDays,
          r.partialDays, r.missedChannelDays, rate(r.activeRate), r.countedDays ? r.longestGapDays : "",
          r.countedDays ? r.currentGapDays : "", yes(r.currentGapOpenEnded), r.lastPostedDay ?? "", r.lastPostedIST ?? "", yes(r.lastPostedApprox),
          r.linkCount, todayText(r.todayStatus), d.range.includesToday ? r.todayPostedAccounts : "",
          rangesText(r.missedRanges), r.missedRangeCount,
        ]),
      );
    }
  }

  const tiles: { label: string; value: string; sub: string; icon: React.ReactNode; tone: string }[] = [
    {
      label: "Channel assignments",
      value: d ? nf.format(d.totals.assignments) : "—",
      sub: d ? plural(d.totals.employees, "person", "people") : windowLabel.toLowerCase(),
      icon: <Users className="h-3.5 w-3.5 text-indigo" aria-hidden />,
      tone: "bg-indigo-soft",
    },
    {
      label: "Missed channel-days",
      value: d ? nf.format(d.totals.missedDays) : "—",
      sub: d ? `of ${nf.format(d.totals.countedDays)} counted` : "every calendar day counts",
      icon: <CalendarX2 className="h-3.5 w-3.5 text-attention" aria-hidden />,
      tone: "bg-attention/10",
    },
    {
      label: endsYesterday || !d ? "People in a gap now" : "People in a gap at window end",
      value: inGapNow == null ? "—" : nf.format(inGapNow),
      sub: d && !onlyToday ? `no link on any channel on ${fmtDay(d.range.countedThrough, year)}` : "nothing counted yet",
      icon: <Hourglass className="h-3.5 w-3.5 text-terra" aria-hidden />,
      tone: "bg-terra-soft",
    },
    {
      label: "Not posted yet today",
      value: notYetPeople == null ? "—" : nf.format(notYetPeople),
      sub: !d
        ? "today is shown separately"
        : d.range.includesToday
          ? `${plural(d.totals.notYetToday ?? 0, "channel")} · today is in progress`
          : "this window does not include today",
      icon: <Clock className="h-3.5 w-3.5 text-amber-700" aria-hidden />,
      tone: "bg-amber-50",
    },
  ];

  const inputCls =
    "h-10 w-full min-w-0 rounded-lg border border-ink/10 bg-white px-3 text-base text-ink focus:outline-none focus:ring-2 focus:ring-[#F5D547]";

  return (
    <div className="space-y-4">
      <div className="v3-card p-5 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-semibold text-ink">Submission gaps</p>
            <p className="text-xs text-ink-4 mt-0.5">
              Who did not submit links for the channels assigned to them · {windowLabel}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div role="group" aria-label="View" className="inline-flex rounded-full border border-ink/10 p-0.5">
              {(["channels", "people"] as View[]).map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={view === v}
                  onClick={() => { setView(v); setExpanded(null); setLimit(PAGE); }}
                  className={`rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${
                    view === v ? "bg-[#1A1A1A] text-white" : "text-ink-4 hover:text-ink"
                  }`}
                >
                  {v === "channels" ? "By channel" : "By person"}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={exportCsv}
              disabled={!d || list.length === 0}
              className="inline-flex items-center gap-1.5 rounded-full border border-ink/10 px-3 py-1.5 text-xs font-semibold text-ink hover:bg-ink/5 disabled:opacity-40"
              title="Download the rows below (after search and filters) as CSV"
            >
              <Download className="h-3.5 w-3.5" aria-hidden /> Gaps CSV
            </button>
          </div>
        </div>

        <p className="text-[11px] leading-relaxed text-ink-4">
          <span className="font-semibold text-ink">How this is counted:</span> every calendar day counts — 7 days a week;
          weekends, holidays and leave are <em>not</em> excluded. Days before a channel was assigned to the person are not
          counted. Today is still in progress, so it is never counted as missed — it has its own column. Only live links
          count (scheduled and blank ones don&apos;t). Times are IST; a <span className="font-num">~</span> marks an
          approximate time (before 3 Jun 2026 only the report&apos;s first-submit time is known).
          {d && d.excluded.inactiveChannelAssignments > 0
            ? ` ${plural(d.excluded.inactiveChannelAssignments, "assignment")} to paused or archived channels ${d.excluded.inactiveChannelAssignments === 1 ? "is" : "are"} not shown.`
            : ""}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.label} className="v3-card-sm min-w-0 p-4 space-y-1">
            <div className={`flex h-7 w-7 items-center justify-center rounded-lg ${t.tone}`}>{t.icon}</div>
            <p className="font-num text-2xl font-semibold leading-none text-ink pt-1">{t.value}</p>
            <p className="text-xs font-medium text-ink">{t.label}</p>
            <p className="text-[11px] text-ink-4 break-words">{t.sub}</p>
          </div>
        ))}
      </div>

      <div className="v3-card p-4 space-y-3">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <label className="relative block min-w-0 lg:col-span-2">
            <span className="sr-only">Search person or channel</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-4" aria-hidden />
            <input
              type="search"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setLimit(PAGE); }}
              placeholder={view === "channels" ? "Search person or channel" : "Search person"}
              className={`${inputCls} pl-9`}
            />
          </label>
          <label className="block min-w-0">
            <span className="sr-only">Team</span>
            <select value={teamId} onChange={(e) => { setTeamId(e.target.value); setExpanded(null); setLimit(PAGE); }} className={inputCls}>
              <option value="">All teams</option>
              {options.teams.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </label>
          <label className="block min-w-0">
            <span className="sr-only">Platform</span>
            <select value={platform} onChange={(e) => { setPlatform(e.target.value); setExpanded(null); setLimit(PAGE); }} className={inputCls}>
              <option value="">All platforms</option>
              {options.platforms.map((p) => (
                <option key={p.slug} value={p.slug}>{p.name}</option>
              ))}
            </select>
          </label>
          <label className="block min-w-0">
            <span className="sr-only">Sort</span>
            <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)} className={inputCls}>
              {SORTS.map((s) => (
                <option key={s.key} value={s.key}>Sort: {s.label}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-ink-4">
          <label className="inline-flex items-center gap-2">
            <span>Only rows with at least</span>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={366}
              value={minMissed}
              onChange={(e) => { setMinMissed(e.target.value); setLimit(PAGE); }}
              className="h-10 w-20 rounded-lg border border-ink/10 bg-white px-2 text-base text-ink focus:outline-none focus:ring-2 focus:ring-[#F5D547]"
            />
            <span>missed {view === "channels" ? "days" : "days (no link on any channel)"}</span>
          </label>
          {d && (
            <span className="ml-auto">
              {nf.format(list.length)} of {plural(total, view === "channels" ? "row" : "person", view === "channels" ? "rows" : "people")}
              {filtersNarrow ? " match" : ""}
            </span>
          )}
        </div>
      </div>

      {/* States: invalid window → loading → failed → only-today note → empty → list. */}
      {problem && (
        <div className="v3-card p-5 flex items-center gap-3 text-sm text-ink">
          <AlertCircle className="h-4 w-4 text-attention" aria-hidden />
          <span className="min-w-0 break-words">{problem}</span>
        </div>
      )}

      {!problem && !d && isLoading && (
        <div className="v3-card p-5 space-y-3" aria-busy="true">
          {[0, 1, 2].map((i) => <div key={i} className="h-14 animate-pulse rounded-xl bg-ink/5" />)}
          <p className="text-xs text-ink-4">Loading submission gaps…</p>
        </div>
      )}

      {!problem && !d && !isLoading && error && (
        <div className="v3-card p-5 flex flex-wrap items-center gap-3">
          <AlertCircle className="h-4 w-4 text-attention" aria-hidden />
          <p className="min-w-0 flex-1 break-words text-sm text-ink">
            Couldn&apos;t load submission gaps. <span className="text-ink-4">{(error as Error).message}</span>
          </p>
          <button
            type="button"
            onClick={() => mutate()}
            className="inline-flex items-center gap-1.5 rounded-full border border-ink/10 px-3 py-1.5 text-xs font-semibold text-ink hover:bg-ink/5"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Retry
          </button>
        </div>
      )}

      {d && onlyToday && (
        <div className="v3-card p-4 text-xs text-ink">
          Only today is in this window, and today is still in progress — nothing can be missed yet. The Today column shows
          who has posted so far. Pick a longer window to see missed days.
        </div>
      )}

      {d && d.totals.truncated && (
        <p className="text-xs text-attention">
          Showing the first {nf.format(d.rows.length)} of {nf.format(d.totals.assignments)} assignments — narrow by team or
          platform to see the rest.
        </p>
      )}

      {d && total === 0 && (
        <div className="v3-card p-5 text-sm text-ink-4">
          No current channel assignments match {teamId || platform ? "these filters" : "— assign channels to people on the Accounts page"}.
        </div>
      )}

      {d && total > 0 && list.length === 0 && (
        <div className="v3-card p-5 flex flex-wrap items-center gap-3 text-sm text-ink-4">
          <span className="min-w-0 flex-1">No rows match the search or the minimum-missed filter.</span>
          <button
            type="button"
            onClick={() => { setSearch(""); setMinMissed("0"); }}
            className="rounded-full border border-ink/10 px-3 py-1.5 text-xs font-semibold text-ink hover:bg-ink/5"
          >
            Clear
          </button>
        </div>
      )}

      {d && list.length > 0 && (
        <div className="v3-card p-3 sm:p-4">
          <div className={`hidden xl:grid ${GRID} px-3 pb-2 text-[10px] font-semibold uppercase tracking-wide text-ink-4`}>
            <span>Person</span>
            <span>{view === "channels" ? "Channel" : "Channels"}</span>
            <span className="text-right">Missed</span>
            <span>Active</span>
            <span>Current gap</span>
            <span>Last posted</span>
            <span>Today</span>
            <span className="sr-only">Details</span>
          </div>
          <ul className="space-y-2">
            {view === "channels"
              ? pairs.slice(0, limit).map((r) => {
                  const key = `${r.employee.id}:${r.account.id}`;
                  const open = expanded === key;
                  return (
                    <li key={key} className="rounded-xl border border-ink/10 px-3 py-3">
                      <div className={GRID}>
                        <div className="col-span-2 min-w-0 sm:col-span-3 xl:col-span-1">
                          <Link href={`/reports/${r.employee.id}`} className="block truncate text-sm font-medium text-ink hover:text-indigo">
                            {r.employee.name}
                          </Link>
                          <p className="truncate text-xs text-ink-4">{r.employee.team?.name ?? "No team"}</p>
                        </div>
                        <div className="col-span-2 min-w-0 sm:col-span-3 xl:col-span-1">
                          <Link href={`/accounts/${r.account.id}`} className="block truncate text-sm text-ink hover:text-indigo">
                            {r.account.displayName}
                          </Link>
                          <p className="truncate text-xs text-ink-4">
                            {r.account.platformName} · @{r.account.handle.replace(/^@/, "")} · since {fmtDay(r.assignedSince, year)}
                          </p>
                        </div>
                        <div className="min-w-0 xl:text-right">
                          <MetricLabel>Missed</MetricLabel>
                          {r.countedDays === 0 ? (
                            <span className="text-sm text-ink-4" title="No countable days yet in this window">—</span>
                          ) : (
                            <span className={`font-num text-lg font-semibold leading-none ${r.missedDays > 0 ? "text-attention" : "text-sage"}`}>
                              {nf.format(r.missedDays)}
                            </span>
                          )}
                        </div>
                        <div className="min-w-0">
                          <MetricLabel>Active</MetricLabel>
                          <span className="block text-sm text-ink">
                            {r.countedDays === 0 ? "—" : `${nf.format(r.activeDays)}/${nf.format(r.countedDays)}`}
                            <span className="block text-xs text-ink-4">{pct(r.activeRate)} · {plural(r.linkCount, "link")}</span>
                          </span>
                        </div>
                        <div className="min-w-0">
                          <MetricLabel>Current gap</MetricLabel>
                          <GapValue days={r.currentGapDays} open={r.currentGapOpenEnded} counted={r.countedDays} />
                        </div>
                        <div className="min-w-0">
                          <MetricLabel>Last posted</MetricLabel>
                          <LastPosted day={r.lastPostedDay} ist={r.lastPostedIST} approx={r.lastPostedApprox} year={year} />
                        </div>
                        <div className="min-w-0">
                          <MetricLabel>Today</MetricLabel>
                          <TodayChip status={r.todayStatus} links={r.todayLinks} />
                        </div>
                        <div className="flex min-w-0 items-end justify-end xl:items-center">
                          <button
                            type="button"
                            onClick={() => setExpanded(open ? null : key)}
                            aria-expanded={open}
                            aria-label={open ? "Hide day by day" : "Show day by day"}
                            className="inline-flex h-9 items-center gap-1 rounded-full border border-ink/10 px-2.5 text-xs font-medium text-ink hover:bg-ink/5"
                          >
                            <span className="xl:hidden">Days</span>
                            {open ? <ChevronUp className="h-3.5 w-3.5" aria-hidden /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden />}
                          </button>
                        </div>
                      </div>
                      <MissedRanges ranges={r.missedRanges} total={r.missedRangeCount} truncated={r.missedRangesTruncated} year={year} />
                      {open && (
                        <DayByDay
                          employeeId={r.employee.id}
                          accountId={r.account.id}
                          startDate={d.range.startDate}
                          endDate={d.range.endDate}
                          year={year}
                        />
                      )}
                    </li>
                  );
                })
              : people.slice(0, limit).map((r) => {
                  const key = `p:${r.employee.id}`;
                  const open = expanded === key;
                  const channels = channelsByPerson.get(r.employee.id) ?? [];
                  return (
                    <li key={key} className="rounded-xl border border-ink/10 px-3 py-3">
                      <div className={GRID}>
                        <div className="col-span-2 min-w-0 sm:col-span-3 xl:col-span-1">
                          <Link href={`/reports/${r.employee.id}`} className="block truncate text-sm font-medium text-ink hover:text-indigo">
                            {r.employee.name}
                          </Link>
                          <p className="truncate text-xs text-ink-4">{r.employee.team?.name ?? "No team"}</p>
                        </div>
                        <div className="col-span-2 min-w-0 sm:col-span-3 xl:col-span-1">
                          <p className="text-sm text-ink">{plural(r.accountCount, "channel")}</p>
                          <p className="truncate text-xs text-ink-4">
                            {r.missedChannelDays > 0 ? `${plural(r.missedChannelDays, "missed channel-day")}` : "no missed channel-days"}
                          </p>
                        </div>
                        <div className="min-w-0 xl:text-right">
                          <MetricLabel>No-link days</MetricLabel>
                          {r.countedDays === 0 ? (
                            <span className="text-sm text-ink-4" title="No countable days yet in this window">—</span>
                          ) : (
                            <span
                              className={`font-num text-lg font-semibold leading-none ${r.missedDays > 0 ? "text-attention" : "text-sage"}`}
                              title="Days with no link on ANY assigned channel"
                            >
                              {nf.format(r.missedDays)}
                            </span>
                          )}
                        </div>
                        <div className="min-w-0">
                          <MetricLabel>Active</MetricLabel>
                          <span className="block text-sm text-ink">
                            {r.countedDays === 0 ? "—" : `${nf.format(r.activeDays)}/${nf.format(r.countedDays)}`}
                            <span className="block text-xs text-ink-4">
                              {pct(r.activeRate)}
                              {r.partialDays > 0 ? ` · ${nf.format(r.partialDays)} partial` : ""}
                            </span>
                          </span>
                        </div>
                        <div className="min-w-0">
                          <MetricLabel>Current gap</MetricLabel>
                          <GapValue days={r.currentGapDays} open={r.currentGapOpenEnded} counted={r.countedDays} />
                        </div>
                        <div className="min-w-0">
                          <MetricLabel>Last posted</MetricLabel>
                          <LastPosted day={r.lastPostedDay} ist={r.lastPostedIST} approx={r.lastPostedApprox} year={year} />
                        </div>
                        <div className="min-w-0">
                          <MetricLabel>Today</MetricLabel>
                          <TodayChip
                            status={r.todayStatus}
                            links={r.todayLinks}
                            of={`${nf.format(r.todayPostedAccounts)}/${nf.format(r.accountCount)}`}
                          />
                        </div>
                        <div className="flex min-w-0 items-end justify-end xl:items-center">
                          <button
                            type="button"
                            onClick={() => setExpanded(open ? null : key)}
                            aria-expanded={open}
                            aria-label={open ? "Hide channels" : "Show channels"}
                            className="inline-flex h-9 items-center gap-1 rounded-full border border-ink/10 px-2.5 text-xs font-medium text-ink hover:bg-ink/5"
                          >
                            <span className="xl:hidden">Channels</span>
                            {open ? <ChevronUp className="h-3.5 w-3.5" aria-hidden /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden />}
                          </button>
                        </div>
                      </div>
                      <MissedRanges ranges={r.missedRanges} total={r.missedRangeCount} truncated={r.missedRangesTruncated} year={year} />
                      {open && (
                        <ul className="mt-3 space-y-1.5 border-t border-ink/10 pt-3">
                          {channels.map((c) => (
                            <li key={c.account.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                              <span className="min-w-0 max-w-full truncate font-medium text-ink">{c.account.displayName}</span>
                              <span className="text-ink-4">{c.account.platformName}</span>
                              <span className={c.missedDays > 0 ? "font-semibold text-attention" : "text-sage"}>
                                {c.countedDays === 0 ? "nothing counted yet" : `${plural(c.missedDays, "missed day")} of ${nf.format(c.countedDays)}`}
                              </span>
                              {c.currentGapDays > 0 && (
                                <span className="text-attention">
                                  gap {c.currentGapOpenEnded ? "≥ " : ""}{plural(c.currentGapDays, "day")}
                                </span>
                              )}
                              <TodayChip status={c.todayStatus} links={c.todayLinks} />
                            </li>
                          ))}
                          <li className="pt-1 text-[11px] text-ink-4">
                            Switch to <button type="button" className="font-medium text-indigo hover:underline" onClick={() => { setView("channels"); setSearch(r.employee.name); setExpanded(null); }}>By channel</button> for the day-by-day view of each channel.
                          </li>
                        </ul>
                      )}
                    </li>
                  );
                })}
          </ul>
          {list.length > limit && (
            <div className="pt-3 text-center">
              <button
                type="button"
                onClick={() => setLimit((l) => l + PAGE)}
                className="rounded-full border border-ink/10 px-4 py-2 text-xs font-semibold text-ink hover:bg-ink/5"
              >
                Show {nf.format(Math.min(PAGE, list.length - limit))} more of {nf.format(list.length - limit)}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
