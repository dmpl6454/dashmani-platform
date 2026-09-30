"use client";
import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertCircle, CalendarX2, CheckCircle2, ChevronDown, ChevronUp, Clock, Download, FileText, Hourglass, Loader2, RefreshCw,
  Search, Users,
} from "lucide-react";
import {
  filterGapPairs,
  filterGapPeople,
  gapChannelsOfPerson,
  gapRangeProblem,
  gapShiftDay,
  gapSpanDays,
  istDateTime,
  normalizeGapMinMissed,
  normalizeGapSearch,
  selectGapExportPairs,
  type GapEmployeeRow,
  type GapPairRow,
  type GapRange,
  type GapRowFilters,
  type GapView,
  type GapWindowRange,
  type SubmissionGapsResult,
} from "@dashmani/shared";
import { useSubmissionGaps } from "@/lib/hooks/use-reports";
import { apiFetchBlob, downloadBlob } from "@/lib/api";
import { downloadCsv } from "@/lib/csv";
import { todayISO } from "../_range";
import { fmtDay, fmtRange, nf, pct, plural, rangeDays, timeFor } from "./_gap-format";
import { PairDayByDay, PersonDayByDay, RangeInputs, RangeProblem, useRangeDraft } from "./_gap-days";
import { SearchableSelect, type SelectOption } from "./_searchable-select";

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
 *   • Range, team and platform are server-side (they change the per-person aggregates).
 *     Person, channel, search and "≥ N missed" are client-side over the loaded rows —
 *     through the SAME shared functions (@dashmani/shared) the server's all-rows CSV uses,
 *     so that file covers exactly the rows on screen. Sorting is client-side.
 *   • The tab may override the page's range pills with its own dates ("Use page range"
 *     returns to them). Each expanded row can move month by month or to its own dates.
 */

type SortKey = "missed" | "gap" | "rate" | "last" | "name";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "missed", label: "Most missed days" },
  { key: "gap", label: "Longest current gap" },
  { key: "rate", label: "Lowest active rate" },
  { key: "last", label: "Oldest last post" },
  { key: "name", label: "Name (A–Z)" },
];

const PAGE = 100;
const RANGE_CHIPS = 6;

function compareRows<T extends { countedDays: number; missedDays: number; currentGapDays: number; activeRate: number | null; lastPostedDay: string | null; lastPostedAt: string | null; employee: { name: string } }>(
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
      // Never posted in this window, with days to count, sorts FIRST — it is older than
      // any post in it. Nothing countable yet AND no post (e.g. assigned today) sorts
      // LAST: it cannot be neglected yet, so it must not top "Oldest last post".
      const rank = (r: T) => (r.lastPostedDay != null ? 1 : r.countedDays === 0 ? 2 : 0);
      d = rank(a) - rank(b);
      if (d === 0 && a.lastPostedDay != null && b.lastPostedDay != null) {
        d = a.lastPostedDay.localeCompare(b.lastPostedDay) || (a.lastPostedAt ?? "").localeCompare(b.lastPostedAt ?? "");
      }
    }
    return d || a.employee.name.localeCompare(b.employee.name) || tiebreak(a, b);
  };
}

function MetricLabel({ children }: { children: React.ReactNode }) {
  return <span className="xl:hidden block text-[10px] font-semibold uppercase tracking-wide text-ink-4">{children}</span>;
}

function TodayChip({ status, links, of }: { status: GapPairRow["todayStatus"] | GapEmployeeRow["todayStatus"]; links: number; of?: string }) {
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

function MissedRanges({ ranges, total, truncated, year }: { ranges: GapRange[]; total: number; truncated: boolean; year: string }) {
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

function ExpandButton({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      aria-label={open ? "Hide day by day" : "Show day by day"}
      className="inline-flex h-9 items-center gap-1 rounded-full border border-ink/10 px-2.5 text-xs font-medium text-ink hover:bg-ink/5"
    >
      <span className="xl:hidden">Days</span>
      {open ? <ChevronUp className="h-3.5 w-3.5" aria-hidden /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden />}
    </button>
  );
}

const GRID =
  "grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-6 xl:grid-cols-[minmax(0,1.25fr)_minmax(0,1.5fr)_4.5rem_5.5rem_6rem_7rem_6.5rem_2.5rem] xl:items-center";

const toolbarBtn =
  "inline-flex items-center gap-1.5 rounded-full border border-ink/10 px-3 py-1.5 text-xs font-semibold text-ink hover:bg-ink/5 disabled:opacity-40";

export function SubmissionGapsPanel({
  startDate, endDate, windowLabel,
}: { startDate: string; endDate: string; windowLabel: string }) {
  const [view, setView] = useState<GapView>("channels");
  const [search, setSearch] = useState("");
  const [teamId, setTeamId] = useState("");
  const [platform, setPlatform] = useState("");
  const [personId, setPersonId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [minMissed, setMinMissed] = useState("0");
  const [sortKey, setSortKey] = useState<SortKey>("missed");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);
  // Dates for THIS tab only; null = follow the page's range pills.
  const [custom, setCustom] = useState<GapWindowRange | null>(null);
  const [allCsv, setAllCsv] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });

  const resetList = () => {
    setExpanded(null);
    setLimit(PAGE);
    // A failed export's message describes the old filters (e.g. "too many rows").
    setAllCsv((s) => (s.error ? { ...s, error: null } : s));
  };

  const clientToday = todayISO();
  const pageRange = useMemo(() => ({ startDate, endDate }), [startDate, endDate]);
  const applied = custom ?? pageRange;
  const rangeDraft = useRangeDraft(applied, clientToday, (r) => {
    setCustom(r);
    resetList();
  });
  const problem = gapRangeProblem(applied.startDate, applied.endDate, clientToday);

  const { data, error, isLoading, mutate } = useSubmissionGaps(!problem, {
    startDate: applied.startDate,
    endDate: applied.endDate,
    teamId: teamId || undefined,
    platform: platform || undefined,
  });
  const d = (data as { data?: SubmissionGapsResult } | undefined)?.data;
  // The server's IST "today" once loaded (it decides what is counted), the browser's IST
  // day before that.
  const today = d?.range.today ?? clientToday;
  const year = today.slice(0, 4);
  const report = useMemo<GapWindowRange | null>(
    () => (d ? { startDate: d.range.startDate, endDate: d.range.endDate } : null),
    [d],
  );
  // Keep the last filter options while a new filter loads, so a selected team never
  // appears to reset to "All teams" mid-request.
  const optionsRef = useRef<SubmissionGapsResult["filters"]>({ teams: [], platforms: [] });
  if (d) optionsRef.current = d.filters;
  const options = optionsRef.current;

  const filters = useMemo<GapRowFilters>(
    () => ({
      q: normalizeGapSearch(search),
      minMissed: normalizeGapMinMissed(minMissed),
      employeeId: personId || null,
      accountId: accountId || null,
    }),
    [search, minMissed, personId, accountId],
  );

  const pairs = useMemo(
    () =>
      d
        ? filterGapPairs(d.rows, filters).sort(
            compareRows<GapPairRow>(sortKey, (a, b) => a.account.displayName.localeCompare(b.account.displayName) || a.account.id.localeCompare(b.account.id)),
          )
        : [],
    [d, filters, sortKey],
  );

  const people = useMemo(
    () => (d ? filterGapPeople(d, filters).sort(compareRows<GapEmployeeRow>(sortKey, (a, b) => a.employee.id.localeCompare(b.employee.id))) : []),
    [d, filters, sortKey],
  );

  // Person / channel dropdowns, from the loaded rows. Each narrows the other's LIST (a
  // person's channels; a channel's people), so no pairing can be picked that has no row;
  // the counts on each option stay the totals (a person's channels, a channel's people).
  const personOptions = useMemo<SelectOption[]>(() => {
    const m = new Map<string, { name: string; team: string | null; channels: number; inFacet: boolean }>();
    for (const r of d?.rows ?? []) {
      const inFacet = !filters.accountId || r.account.id === filters.accountId;
      const cur = m.get(r.employee.id);
      if (cur) {
        cur.channels++;
        cur.inFacet ||= inFacet;
      } else m.set(r.employee.id, { name: r.employee.name, team: r.employee.team?.name ?? null, channels: 1, inFacet });
    }
    return [...m]
      .filter(([, p]) => p.inFacet)
      .map(([id, p]) => ({ value: id, label: p.name, detail: `${p.team ?? "No team"} · ${plural(p.channels, "channel")}` }))
      .sort((a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value));
  }, [d, filters.accountId]);

  const channelOptions = useMemo<SelectOption[]>(() => {
    const m = new Map<string, { name: string; platform: string; handle: string; people: number; inFacet: boolean }>();
    for (const r of d?.rows ?? []) {
      const inFacet = !filters.employeeId || r.employee.id === filters.employeeId;
      const cur = m.get(r.account.id);
      if (cur) {
        cur.people++;
        cur.inFacet ||= inFacet;
      } else {
        m.set(r.account.id, { name: r.account.displayName, platform: r.account.platformName, handle: r.account.handle, people: 1, inFacet });
      }
    }
    return [...m]
      .filter(([, c]) => c.inFacet)
      .map(([id, c]) => ({
        value: id,
        label: c.name,
        detail: `${c.platform} · @${c.handle.replace(/^@/, "")} · ${plural(c.people, "person", "people")}`,
      }))
      .sort((a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value));
  }, [d, filters.employeeId]);

  // Remember a selection's label, so it still reads correctly when a team / platform /
  // range change takes it out of the loaded rows (the list then says nothing matches).
  const labels = useRef(new Map<string, string>());
  for (const o of personOptions) labels.current.set(`p:${o.value}`, o.label);
  for (const o of channelOptions) labels.current.set(`c:${o.value}`, o.label);
  const personLabel = personId ? labels.current.get(`p:${personId}`) ?? "Selected person" : "";
  const channelLabel = accountId ? labels.current.get(`c:${accountId}`) ?? "Selected channel" : "";

  const list = view === "channels" ? pairs : people;
  const total = view === "channels" ? d?.rows.length ?? 0 : d?.employees.length ?? 0;
  const filtersNarrow = filters.q !== "" || filters.minMissed > 0 || !!filters.employeeId || !!filters.accountId;

  const inGapNow = d ? d.employees.filter((e) => e.currentGapDays > 0).length : null;
  const endsYesterday = !!d && d.range.countedThrough === gapShiftDay(d.range.today, -1);
  const notYetPeople = d && d.range.includesToday ? d.employees.filter((e) => e.todayStatus === "not_yet").length : null;
  const onlyToday = !!d && d.range.countedThrough < d.range.startDate;
  // Nothing in this window can be counted yet (only today, or every assignment starts
  // today). A 0 would read as "measured, and zero" — the tiles show "—" instead.
  const nothingCounted = !!d && (onlyToday || d.totals.countedDays === 0);

  const teamName = teamId ? options.teams.find((t) => t.id === teamId)?.name ?? "selected team" : "";
  const platformName = platform ? options.platforms.find((p) => p.slug === platform)?.name ?? platform : "";

  /** The active filters in words — the Gaps CSV's comment row. */
  function filtersText(): string {
    const parts = [
      teamName && `team ${teamName}`,
      platformName && `platform ${platformName}`,
      personLabel && `person ${personLabel}`,
      channelLabel && `channel ${channelLabel}`,
      filters.q && `search "${search.trim()}"`,
      filters.minMissed > 0 && `at least ${nf.format(filters.minMissed)} missed ${view === "channels" ? "days" : "days with no link on any channel"}`,
    ].filter(Boolean);
    return parts.length ? `Filters: ${parts.join("; ")}` : "Filters: none";
  }

  function exportCsv() {
    if (!d) return;
    const yes = (b: boolean) => (b ? "Yes" : "");
    const rangesText = (rs: GapRange[]) => rs.map(([s, e]) => (s === e ? s : `${s}..${e}`)).join("; ");
    const todayText = (s: string | null) => (s == null ? "" : s === "not_yet" ? "Not yet" : s === "partial" ? "Some channels" : "Posted");
    const rate = (r: number | null) => (r == null ? "" : (r * 100).toFixed(1));
    const narrowed = filtersNarrow || !!teamId || !!platform;
    const base = `submission-gaps-${view}-${d.range.startDate}_${d.range.endDate}${narrowed ? "-filtered" : ""}.csv`;
    // One comment row above the header: a file opened later still says what it covers.
    const preamble = [[
      `# Submission gaps (${view === "channels" ? "by channel" : "by person"}) · ${d.range.startDate} to ${d.range.endDate} (IST) · ${filtersText()} · exported ${istDateTime(new Date())} IST`,
    ]];
    if (view === "channels") {
      downloadCsv(
        base,
        [
          "Person", "Team", "Channel", "Handle", "Platform", "Assigned since (IST)", "Counted from", "Counted through",
          "Counted days", "Active days", "Missed days", "Active rate %", "Longest gap (days)", "Current gap (days)",
          "Current gap may be longer?", "Last posted day in window (IST)", "Last posted at in window (IST)", "Last posted time approx?", "Links (counted days)",
          "Today", "Links today", "Missed ranges (most recent, up to 20)", "Missed ranges (total)",
        ],
        pairs.map((r) => [
          r.employee.name, r.employee.team?.name ?? "", r.account.displayName, r.account.handle, r.account.platformName,
          r.assignedSince, r.countedFrom ?? "", r.countedThrough ?? "", r.countedDays, r.activeDays, r.missedDays,
          rate(r.activeRate), r.countedDays ? r.longestGapDays : "", r.countedDays ? r.currentGapDays : "",
          yes(r.currentGapOpenEnded), r.lastPostedDay ?? "", r.lastPostedIST ?? "", yes(r.lastPostedApprox), r.linkCount,
          todayText(r.todayStatus), d.range.includesToday ? r.todayLinks : "", rangesText(r.missedRanges), r.missedRangeCount,
        ]),
        preamble,
      );
    } else {
      downloadCsv(
        base,
        [
          "Person", "Team", "Channels", "Counted days", "Active days", "Days with no link on any channel", "Partial days",
          "Missed channel-days", "Active rate %", "Longest gap (days)", "Current gap (days)", "Current gap may be longer?",
          "Last posted day in window (IST)", "Last posted at in window (IST)", "Last posted time approx?", "Links (counted days)", "Today", "Channels posted today",
          "Missed ranges (most recent, up to 20)", "Missed ranges (total)",
        ],
        people.map((r) => [
          r.employee.name, r.employee.team?.name ?? "", r.accountCount, r.countedDays, r.activeDays, r.missedDays,
          r.partialDays, r.missedChannelDays, rate(r.activeRate), r.countedDays ? r.longestGapDays : "",
          r.countedDays ? r.currentGapDays : "", yes(r.currentGapOpenEnded), r.lastPostedDay ?? "", r.lastPostedIST ?? "", yes(r.lastPostedApprox),
          r.linkCount, todayText(r.todayStatus), d.range.includesToday ? r.todayPostedAccounts : "",
          rangesText(r.missedRanges), r.missedRangeCount,
        ]),
        preamble,
      );
    }
  }

  // Rows the all-rows day-by-day CSV will have: every exported pair × every day of the
  // window through today (days before an assignment included, as "Not assigned yet").
  const exportPairs = useMemo(() => (d ? selectGapExportPairs(d, view, filters).length : 0), [d, view, filters]);
  const exportDays = d ? Math.max(0, gapSpanDays(d.range.startDate, d.range.endDate < d.range.today ? d.range.endDate : d.range.today)) : 0;
  const exportRows = exportPairs * exportDays;

  async function exportAllDaysCsv() {
    if (!d || allCsv.busy) return;
    setAllCsv({ busy: true, error: null });
    try {
      // Exactly the request behind the rows on screen, plus the client-side filters —
      // the server applies them with the same shared functions.
      const qs = new URLSearchParams({ startDate: d.range.startDate, endDate: d.range.endDate, view });
      if (teamId) qs.set("teamId", teamId);
      if (platform) qs.set("platform", platform);
      if (filters.employeeId) qs.set("employeeId", filters.employeeId);
      if (filters.accountId) qs.set("accountId", filters.accountId);
      if (filters.q) qs.set("q", filters.q);
      if (filters.minMissed > 0) qs.set("minMissed", String(filters.minMissed));
      const { blob, filename } = await apiFetchBlob(`/admin/reports/submission-gaps/days.csv?${qs.toString()}`);
      downloadBlob(blob, filename || `submission-gaps-day-by-day-${d.range.startDate}_${d.range.endDate}.csv`);
      setAllCsv({ busy: false, error: null });
    } catch (e) {
      setAllCsv({ busy: false, error: e instanceof Error ? e.message : "The export failed — please try again." });
    }
  }

  // The range this tab shows: the page's pills, or its own dates.
  const rangeShort = custom ? fmtRange([custom.startDate, custom.endDate], year) : windowLabel;

  const tiles: { label: string; value: string; sub: string; icon: React.ReactNode; tone: string }[] = [
    {
      label: "Channel assignments",
      value: d ? nf.format(d.totals.assignments) : "—",
      sub: d ? plural(d.totals.employees, "person", "people") : rangeShort.toLowerCase(),
      icon: <Users className="h-3.5 w-3.5 text-indigo" aria-hidden />,
      tone: "bg-indigo-soft",
    },
    {
      label: "Missed channel-days",
      value: !d || nothingCounted ? "—" : nf.format(d.totals.missedDays),
      sub: !d ? "every calendar day counts" : nothingCounted ? "nothing counted yet" : `of ${nf.format(d.totals.countedDays)} counted`,
      icon: <CalendarX2 className="h-3.5 w-3.5 text-attention" aria-hidden />,
      tone: "bg-attention/10",
    },
    {
      label: endsYesterday || !d ? "People in a gap now" : "People in a gap at window end",
      value: inGapNow == null || nothingCounted ? "—" : nf.format(inGapNow),
      sub: !d
        ? "no link on any assigned channel"
        : nothingCounted
          ? "nothing counted yet"
          : `no link on any channel on ${fmtDay(d.range.countedThrough, year)}`,
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
  const rangeText = custom ? `${rangeShort} (this tab's own dates)` : windowLabel;

  return (
    <div className="space-y-4">
      <div className="v3-card p-5 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-semibold text-ink">Submission gaps</p>
            <p className="text-xs text-ink-4 mt-0.5 break-words">
              Who did not submit links for the channels assigned to them · {rangeText}
            </p>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <div role="group" aria-label="View" className="inline-flex rounded-full border border-ink/10 p-0.5">
              {(["channels", "people"] as GapView[]).map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={view === v}
                  onClick={() => { setView(v); resetList(); }}
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
              className={toolbarBtn}
              title="Download the rows below (after every filter) as CSV — one row per channel or person"
            >
              <Download className="h-3.5 w-3.5" aria-hidden /> Gaps CSV
            </button>
            <button
              type="button"
              onClick={exportAllDaysCsv}
              disabled={!d || list.length === 0 || allCsv.busy}
              aria-live="polite"
              className={toolbarBtn}
              title={
                d
                  ? `One line per person × channel × day for every row below (${plural(exportRows, "line")}), built on the server`
                  : "Available once the rows have loaded"
              }
            >
              {allCsv.busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <FileText className="h-3.5 w-3.5" aria-hidden />}
              {allCsv.busy ? "Preparing…" : "Day-by-day CSV (all rows)"}
            </button>
          </div>
        </div>
        {allCsv.error && (
          <p role="alert" className="flex items-start gap-1.5 text-xs text-attention">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-none" aria-hidden />
            <span className="min-w-0 break-words">Couldn&apos;t build the day-by-day CSV: {allCsv.error}</span>
          </p>
        )}

        <p className="text-[11px] leading-relaxed text-ink-4">
          <span className="font-semibold text-ink">How this is counted:</span> every calendar day counts — 7 days a week;
          weekends, holidays and leave are <em>not</em> excluded. Days before a channel was assigned to the person are not
          counted (the day-by-day view marks them &ldquo;not assigned yet&rdquo;). Today is still in progress, so it is never
          counted as missed — it has its own column. Only live links on the assigned channel itself count — scheduled or
          blank links, and links on other channels, don&apos;t. Last posted only looks inside the selected window: a dash
          means no link in the window, not never. Times are IST; a <span className="font-num">~</span> marks an
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
      {d && filtersNarrow && (
        <p className="-mt-2 text-[11px] text-ink-4">
          These totals cover the whole range, team and platform; the person, channel, search and minimum filters narrow
          the list below and both CSVs.
        </p>
      )}

      <div className="v3-card p-4 space-y-3">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <label className="relative block min-w-0">
            <span className="sr-only">Search person or channel</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-4" aria-hidden />
            <input
              type="search"
              value={search}
              onChange={(e) => { setSearch(e.target.value); resetList(); }}
              placeholder={view === "channels" ? "Search person or channel" : "Search person"}
              className={`${inputCls} pl-9`}
            />
          </label>
          <label className="block min-w-0">
            <span className="sr-only">Team</span>
            <select value={teamId} onChange={(e) => { setTeamId(e.target.value); resetList(); }} className={inputCls}>
              <option value="">All teams</option>
              {options.teams.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </label>
          <label className="block min-w-0">
            <span className="sr-only">Platform</span>
            <select value={platform} onChange={(e) => { setPlatform(e.target.value); resetList(); }} className={inputCls}>
              <option value="">All platforms</option>
              {options.platforms.map((p) => (
                <option key={p.slug} value={p.slug}>{p.name}</option>
              ))}
            </select>
          </label>
          <SearchableSelect
            label="Person"
            allLabel="All people"
            value={personId}
            options={personOptions}
            onChange={(v) => { setPersonId(v); resetList(); }}
            searchPlaceholder="Search people"
            staleLabel={personLabel ? `${personLabel} (not in this scope)` : undefined}
          />
          <SearchableSelect
            label="Channel"
            allLabel="All channels"
            value={accountId}
            options={channelOptions}
            onChange={(v) => { setAccountId(v); resetList(); }}
            searchPlaceholder="Search channels or @handles"
            staleLabel={channelLabel ? `${channelLabel} (not in this scope)` : undefined}
          />
          <label className="block min-w-0">
            <span className="sr-only">Sort</span>
            <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)} className={inputCls}>
              {SORTS.map((s) => (
                <option key={s.key} value={s.key}>Sort: {s.label}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="grid grid-cols-2 gap-2 border-t border-ink/10 pt-3 sm:grid-cols-[10.5rem_10.5rem_minmax(0,1fr)] sm:items-end">
          <p className="col-span-2 min-w-0 break-words text-xs text-ink-4 sm:col-span-3">
            <span className="font-semibold text-ink">Dates for this tab:</span>{" "}
            {custom
              ? "custom — they override the page's range pills here only."
              : `following the page's range pills (${windowLabel}). Pick dates to override them for this tab.`}
          </p>
          <RangeInputs range={rangeDraft} today={clientToday} label="Submission gaps dates" />
          <div className="col-span-2 flex min-w-0 flex-wrap items-center gap-2 sm:col-span-1">
            {(custom || rangeDraft.dirty) && (
              <button
                type="button"
                onClick={() => {
                  if (custom) {
                    setCustom(null);
                    resetList();
                  }
                  rangeDraft.discard();
                }}
                className="inline-flex h-10 items-center rounded-full border border-ink/10 bg-white px-3 text-xs font-semibold text-ink hover:bg-ink/5"
              >
                Use page range
              </button>
            )}
          </div>
          <div className="col-span-2 sm:col-span-3">
            <RangeProblem message={rangeDraft.problem} />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs text-ink-4">
          <label className="inline-flex flex-wrap items-center gap-2">
            <span>Only rows with at least</span>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={366}
              value={minMissed}
              onChange={(e) => { setMinMissed(e.target.value); resetList(); }}
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
          <AlertCircle className="h-4 w-4 flex-none text-attention" aria-hidden />
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
          <AlertCircle className="h-4 w-4 flex-none text-attention" aria-hidden />
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
          <span className="min-w-0 flex-1">No rows match the person, channel, search or minimum-missed filters.</span>
          <button
            type="button"
            onClick={() => { setSearch(""); setMinMissed("0"); setPersonId(""); setAccountId(""); resetList(); }}
            className="rounded-full border border-ink/10 px-3 py-1.5 text-xs font-semibold text-ink hover:bg-ink/5"
          >
            Clear
          </button>
        </div>
      )}

      {d && report && list.length > 0 && (
        <div className="v3-card p-3 sm:p-4">
          <div className={`hidden xl:grid ${GRID} px-3 pb-2 text-[10px] font-semibold uppercase tracking-wide text-ink-4`}>
            <span>Person</span>
            <span>{view === "channels" ? "Channel" : "Channels"}</span>
            <span className="text-right">Missed</span>
            <span>Active</span>
            <span>Current gap</span>
            <span>Last posted <span className="whitespace-nowrap">(in window)</span></span>
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
                          <MetricLabel>Last posted <span className="whitespace-nowrap">(in window)</span></MetricLabel>
                          <LastPosted day={r.lastPostedDay} ist={r.lastPostedIST} approx={r.lastPostedApprox} year={year} />
                        </div>
                        <div className="min-w-0">
                          <MetricLabel>Today</MetricLabel>
                          <TodayChip status={r.todayStatus} links={r.todayLinks} />
                        </div>
                        <div className="flex min-w-0 items-end justify-end xl:items-center">
                          <ExpandButton open={open} onClick={() => setExpanded(open ? null : key)} />
                        </div>
                      </div>
                      <MissedRanges ranges={r.missedRanges} total={r.missedRangeCount} truncated={r.missedRangesTruncated} year={year} />
                      {open && <PairDayByDay row={r} report={report} today={today} year={year} />}
                    </li>
                  );
                })
              : people.slice(0, limit).map((r) => {
                  const key = `p:${r.employee.id}`;
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
                          <p className="truncate text-sm text-ink">
                            {filters.accountId ? channelLabel || plural(r.accountCount, "channel") : plural(r.accountCount, "channel")}
                          </p>
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
                              title={filters.accountId ? "Days with no link on the selected channel" : "Days with no link on ANY assigned channel"}
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
                          <MetricLabel>Last posted <span className="whitespace-nowrap">(in window)</span></MetricLabel>
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
                          <ExpandButton open={open} onClick={() => setExpanded(open ? null : key)} />
                        </div>
                      </div>
                      <MissedRanges ranges={r.missedRanges} total={r.missedRangeCount} truncated={r.missedRangesTruncated} year={year} />
                      {open && (
                        <PersonDayByDay
                          person={r}
                          channels={gapChannelsOfPerson(d.rows, r.employee.id, filters.accountId)}
                          report={report}
                          today={today}
                          year={year}
                        />
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
