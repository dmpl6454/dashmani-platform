"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ChevronLeft, ChevronRight, Download, RotateCcw } from "lucide-react";
import {
  GAP_DAYS_CSV_HEADERS,
  GAP_EARLIEST_DAY,
  buildGapDaySeries,
  gapCsvPairInfo,
  gapDaysCsvRow,
  gapFileSlug,
  gapMonthEnd,
  gapPostedFromDays,
  gapRangeProblem,
  gapSpanDays,
  gapWeekday,
  resolveGapDayWindow,
  stepGapDayWindow,
  type GapDayCell,
  type GapDayWindow,
  type GapEmployeeRow,
  type GapPairRow,
  type GapWindowRange,
  type SubmissionGapDaysResult,
} from "@dashmani/shared";
import { useSubmissionGapDays } from "@/lib/hooks/use-reports";
import { downloadCsv } from "@/lib/csv";
import { fmtDay, fmtMonth, fmtRange, nf, plural, timeFor } from "./_gap-format";

/**
 * The expanded day-by-day view of the Submission gaps panel.
 *
 *   • PairDayByDay   — one (person, channel) row: ◀ month ▶, custom From/To, Reset, and a
 *                      CSV of exactly the days on screen.
 *   • PersonDayByDay — one person: the SAME view for each of their channels, stacked,
 *                      under ONE shared navigation (so the channels line up day by day).
 *
 * Every window is fetched with useSubmissionGapDays — one small request per navigation
 * (typed dates are debounced and validated first) — and keepPreviousData keeps the last
 * window on screen while the next loads. The day series (including "Not assigned yet"
 * before the assignment, and today never counted as missed) comes from the SAME shared
 * builder the server's all-rows CSV uses, so the view and both CSVs agree day for day.
 */

const DAYS_PREVIEW = 62;
const RANGE_DEBOUNCE_MS = 450;

const dateInputCls =
  "h-9 w-full min-w-0 rounded-full border border-ds-line2 bg-ds-inset px-3 text-base text-ds-text tabular-nums [color-scheme:dark] focus:border-[rgba(233,189,98,.55)] focus:outline-none sm:text-[12.5px]";

/** Secondary pill button (dark design system). */
const pillBtnCls =
  "inline-flex h-9 items-center gap-1.5 rounded-full border border-ds-line2 bg-ds-inset px-4 text-[12.5px] font-semibold text-ds-t5 transition-colors hover:border-[#2A4658] hover:text-ds-text disabled:cursor-not-allowed disabled:opacity-40";

// ─── A From/To draft that applies itself once it settles and is valid ─────────────

export interface RangeDraft {
  draft: { from: string; to: string };
  /** Edited but not yet applied (waiting for the debounce, or invalid). */
  dirty: boolean;
  /** Why the typed window cannot be used — shown inline, never thrown. */
  problem: string | null;
  setFrom: (from: string) => void;
  setTo: (to: string) => void;
  discard: () => void;
}

/**
 * The inputs show `applied` until the admin edits them. An edit applies after
 * RANGE_DEBOUNCE_MS — so typing a date segment by segment (a native date input reports
 * "0002-09-01" mid-year) never becomes a request — and only when gapRangeProblem() finds
 * nothing wrong; otherwise the reason is shown and the previous window stays on screen.
 */
export function useRangeDraft(
  applied: GapWindowRange,
  today: string,
  onApply: (r: GapWindowRange) => void,
): RangeDraft {
  const [draft, setDraft] = useState({ from: applied.startDate, to: applied.endDate });
  const [dirty, setDirty] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // The latest callback without restarting the debounce every time the parent renders.
  const applyRef = useRef(onApply);
  useEffect(() => {
    applyRef.current = onApply;
  });

  useEffect(() => {
    setDraft({ from: applied.startDate, to: applied.endDate });
    setDirty(false);
    setProblem(null);
  }, [applied.startDate, applied.endDate]);

  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(() => {
      const p = gapRangeProblem(draft.from, draft.to, today);
      if (p) {
        setProblem(p);
        return;
      }
      setProblem(null);
      setDirty(false);
      if (draft.from !== applied.startDate || draft.to !== applied.endDate) {
        applyRef.current({ startDate: draft.from, endDate: draft.to });
      }
    }, RANGE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [dirty, draft.from, draft.to, today, applied.startDate, applied.endDate]);

  return {
    draft,
    dirty,
    problem,
    setFrom: (from) => {
      setDraft((d) => ({ ...d, from }));
      setDirty(true);
      setProblem(null);
    },
    setTo: (to) => {
      setDraft((d) => ({ ...d, to }));
      setDirty(true);
      setProblem(null);
    },
    discard: () => {
      setDraft({ from: applied.startDate, to: applied.endDate });
      setDirty(false);
      setProblem(null);
    },
  };
}

/** Labelled From / To date inputs for a RangeDraft (16px, capped at today). */
export function RangeInputs({ range, today, label }: { range: RangeDraft; today: string; label: string }) {
  return (
    <>
      <label className="block min-w-0">
        <span className="mb-1 block text-[10.5px] font-semibold uppercase tracking-[.08em] text-ds-t3">From</span>
        <input
          type="date"
          aria-label={`${label}: from`}
          value={range.draft.from}
          min={GAP_EARLIEST_DAY}
          max={range.draft.to && range.draft.to <= today ? range.draft.to : today}
          onChange={(e) => range.setFrom(e.target.value)}
          className={dateInputCls}
        />
      </label>
      <label className="block min-w-0">
        <span className="mb-1 block text-[10.5px] font-semibold uppercase tracking-[.08em] text-ds-t3">To</span>
        <input
          type="date"
          aria-label={`${label}: to`}
          value={range.draft.to}
          min={range.draft.from || GAP_EARLIEST_DAY}
          max={today}
          onChange={(e) => range.setTo(e.target.value)}
          className={dateInputCls}
        />
      </label>
    </>
  );
}

export function RangeProblem({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p
      role="alert"
      className="flex items-start gap-1.5 rounded-[10px] border border-[rgba(251,113,133,.25)] bg-[rgba(251,113,133,.08)] px-3 py-2 text-xs text-[#FDA4AF]"
    >
      <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-none" aria-hidden />
      <span className="min-w-0 break-words">{message}</span>
    </p>
  );
}

// ─── The navigation window of one expanded view ────────────────────────────────

interface DayWindowNav {
  win: GapDayWindow;
  range: GapWindowRange;
  prev: GapDayWindow | null;
  next: GapDayWindow | null;
  step: (delta: -1 | 1) => void;
  reset: () => void;
  custom: RangeDraft;
  today: string;
}

function useGapDayWindow(report: GapWindowRange, today: string): DayWindowNav {
  const [win, setWin] = useState<GapDayWindow>({ mode: "report" });
  const range = resolveGapDayWindow(win, report, today);
  const custom = useRangeDraft(range, today, (r) => setWin({ mode: "custom", startDate: r.startDate, endDate: r.endDate }));
  return {
    win,
    range,
    prev: stepGapDayWindow(win, report, today, -1),
    next: stepGapDayWindow(win, report, today, 1),
    step: (delta) => {
      const n = stepGapDayWindow(win, report, today, delta);
      if (n) setWin(n);
    },
    reset: () => {
      setWin({ mode: "report" });
      custom.discard();
    },
    custom,
    today,
  };
}

function DayWindowControls({ nav, year, actions }: { nav: DayWindowNav; year: string; actions?: React.ReactNode }) {
  const { win, range } = nav;
  const title = win.mode === "month" ? fmtMonth(win.month) : win.mode === "custom" ? "Custom range" : "Report range";
  const throughToday = win.mode === "month" && range.endDate === nav.today && gapMonthEnd(win.month) !== nav.today;
  const prevName = nav.prev?.mode === "month" ? fmtMonth(nav.prev.month) : null;
  const nextName = nav.next?.mode === "month" ? fmtMonth(nav.next.month) : null;
  const arrowCls =
    "inline-flex h-9 w-9 flex-none items-center justify-center rounded-full border border-ds-line2 bg-[#08131C] text-ds-t5 transition-colors hover:border-[#2A4658] hover:text-ds-gold disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-ds-line2 disabled:hover:text-ds-t5";
  return (
    <div className="space-y-3 rounded-[12px] border border-ds-line2 bg-ds-inset p-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => nav.step(-1)}
          disabled={!nav.prev}
          aria-label={prevName ? `Previous month: ${prevName}` : "Previous month (none before January 2025)"}
          title={prevName ?? "There is no report data before 2025"}
          className={arrowCls}
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </button>
        <div className="min-w-0 flex-1 text-center" aria-live="polite">
          <p className="break-words text-[14px] font-semibold tracking-[-.01em] text-ds-text">{title}</p>
          <p className="break-words text-[12px] tabular-nums text-ds-t3">
            {fmtRange([range.startDate, range.endDate], year)} · {plural(gapSpanDays(range.startDate, range.endDate), "day")}
            {throughToday ? " · through today" : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={() => nav.step(1)}
          disabled={!nav.next}
          aria-label={nextName ? `Next month: ${nextName}` : "Next month (nothing after today yet)"}
          title={nextName ?? "Nothing after today yet"}
          className={arrowCls}
        >
          <ChevronRight className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-[10.5rem_10.5rem_minmax(0,1fr)] sm:items-end">
        <RangeInputs range={nav.custom} today={nav.today} label="Day-by-day dates" />
        <div className="col-span-2 flex min-w-0 flex-wrap items-center gap-2 sm:col-span-1 sm:justify-end">
          {(win.mode !== "report" || nav.custom.dirty) && (
            <button
              type="button"
              onClick={nav.reset}
              className={pillBtnCls}
            >
              <RotateCcw className="h-3.5 w-3.5 text-ds-gold" aria-hidden /> Reset to report range
            </button>
          )}
          {actions}
        </div>
      </div>
      <RangeProblem message={nav.custom.problem} />
    </div>
  );
}

// ─── One channel's days ─────────────────────────────────────────────────────────

/** The days a ChannelDays is showing for the window it was asked for. */
export interface ChannelSeries {
  /** `${startDate}_${endDate}` of the requested window — the series is never stale. */
  window: string;
  cells: GapDayCell[];
}

const windowKey = (r: GapWindowRange) => `${r.startDate}_${r.endDate}`;

function ChannelDays({
  employeeId,
  accountId,
  range,
  year,
  onSeries,
}: {
  employeeId: string;
  accountId: string;
  range: GapWindowRange;
  year: string;
  /** Called with the loaded series for the requested window, or null while it is not loaded. */
  onSeries: (accountId: string, series: ChannelSeries | null) => void;
}) {
  const { data, error, mutate } = useSubmissionGapDays({
    employeeId,
    accountId,
    startDate: range.startDate,
    endDate: range.endDate,
  });
  const [showAll, setShowAll] = useState(false);
  const res = (data as { data?: SubmissionGapDaysResult } | undefined)?.data;
  // keepPreviousData: `res` may still be the PREVIOUS window. Only a response whose echoed
  // window and pair match the request describes what the navigator says is on screen.
  const fresh =
    !!res &&
    res.range.startDate === range.startDate &&
    res.range.endDate === range.endDate &&
    res.employee.id === employeeId &&
    res.account.id === accountId;
  const cells = useMemo(
    () =>
      res
        ? buildGapDaySeries({
            startDate: res.range.startDate,
            endDate: res.range.endDate,
            today: res.range.today,
            assignedSince: res.assignedSince,
            posted: gapPostedFromDays(res.days),
          })
        : null,
    [res],
  );
  const key = windowKey(range);

  useEffect(() => {
    onSeries(accountId, fresh && cells ? { window: key, cells } : null);
  }, [onSeries, accountId, fresh, cells, key]);

  const retry = (
    <button
      type="button"
      onClick={() => mutate()}
      className="inline-flex h-7 items-center rounded-full border border-ds-line2 bg-ds-inset px-3 text-[12px] font-semibold text-ds-t5 transition-colors hover:border-[#2A4658] hover:text-ds-text"
    >
      Retry
    </button>
  );

  if (error && !fresh) {
    // A failed window never shows the previous window's days as if they were this one's.
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2 rounded-[10px] border border-[rgba(251,113,133,.25)] bg-[rgba(251,113,133,.08)] px-3 py-2.5 text-xs text-[#FDA4AF]">
        <AlertCircle className="h-3.5 w-3.5 flex-none" aria-hidden />
        <span className="min-w-0 break-words">
          Couldn&apos;t load {fmtRange([range.startDate, range.endDate], year)}: {(error as Error).message}
        </span>
        {retry}
      </div>
    );
  }
  if (!res || !cells) {
    return (
      <p className="px-1 py-3 text-xs text-ds-t3 motion-safe:animate-pulse" aria-busy="true">
        Loading days…
      </p>
    );
  }

  const assigned = cells.filter((c) => c.status !== "not_assigned");
  const notAssigned = cells.filter((c) => c.status === "not_assigned"); // newest first
  const shown = showAll ? assigned : assigned.slice(0, DAYS_PREVIEW);

  return (
    <div className={`pt-2 transition-opacity ${fresh ? "" : "opacity-50"}`} aria-busy={!fresh}>
      {!fresh && (
        <p className="pb-1.5 text-[11px] text-ds-t3">
          Loading {fmtRange([range.startDate, range.endDate], year)}… still showing{" "}
          {fmtRange([res.range.startDate, res.range.endDate], year)}.
        </p>
      )}
      {cells.length === 0 ? (
        <p className="px-1 py-2 text-xs text-ds-t3">No days to show in this window.</p>
      ) : (
        <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((d) => (
            <DayChip key={d.date} day={d} year={year} />
          ))}
          {notAssigned.length > 0 && (
            <li className="col-span-full min-w-0 rounded-[8px] border border-dashed border-[#2A4658] bg-[rgba(24,44,57,.45)] px-2.5 py-1.5 text-xs text-ds-t3">
              <span className="break-words">
                <span className="font-medium text-ds-t5">Not assigned yet</span> ·{" "}
                {fmtRange([notAssigned[notAssigned.length - 1].date, notAssigned[0].date], year)} (
                {plural(notAssigned.length, "day")}) — assigned {fmtDay(res.assignedSince, year)}; these days are not
                counted.
              </span>
            </li>
          )}
        </ul>
      )}
      {assigned.length > DAYS_PREVIEW && (
        <button type="button" onClick={() => setShowAll((v) => !v)} className="mt-2 text-xs font-semibold text-[#6EB2FF] hover:text-[#9CCBFF] hover:underline">
          {showAll ? "Show fewer days" : `Show all ${nf.format(assigned.length)} days`}
        </button>
      )}
    </div>
  );
}

function DayChip({ day: d, year }: { day: GapDayCell; year: string }) {
  const posted = d.status === "posted" || d.status === "today_posted";
  const isToday = d.status === "today_posted" || d.status === "today_pending";
  const first = timeFor(d.date, d.firstPostedIST, year);
  const last = timeFor(d.date, d.lastPostedIST, year);
  const times = first && last ? (first === last ? first : `${first}–${last}`) : "";
  const links = d.linkCount ?? 0;
  return (
    <li
      className={`flex min-w-0 items-center gap-2 rounded-[8px] border px-2.5 py-1.5 text-xs ${
        posted
          ? "border-[rgba(0,215,160,.25)] bg-[rgba(0,215,160,.08)]"
          : isToday
            ? "border-[rgba(233,189,98,.55)] bg-[rgba(233,189,98,.08)]"
            : "border-[rgba(251,113,133,.25)] bg-[rgba(251,113,133,.08)]"
      }`}
    >
      <i
        aria-hidden
        className={`h-2.5 w-2.5 flex-none rounded-[3px] ${posted ? "bg-[#00D7A0]" : isToday ? "bg-ds-gold" : "bg-[#FB7185]"}`}
      />
      {/* Bounded text ("Mon 15 Sep 2025" at most), so it may keep its width. */}
      <span className="min-w-[4.5rem] shrink-0 whitespace-nowrap font-num tabular-nums text-ds-t5">
        {gapWeekday(d.date)} {fmtDay(d.date, year)}
      </span>
      <span className={`min-w-0 break-words tabular-nums ${posted ? "text-[#5EEAC4]" : isToday ? "text-ds-gold" : "text-[#FDA4AF]"}`}>
        {isToday ? "Today · " : ""}
        {posted
          ? `${plural(links, "link")}${times ? ` · ${d.approximate ? "~" : ""}${times}` : ""}`
          : isToday
            ? "not yet"
            : "No link"}
      </span>
    </li>
  );
}

function Legend() {
  return (
    <p className="pt-1 text-[11px] leading-relaxed text-ds-t3">
      Newest first. <span className="font-semibold text-[#00D7A0]">Green</span> = posted, <span className="font-semibold text-[#FB7185]">red</span> = no
      link, <span className="font-semibold text-ds-gold">amber</span> = today (still in progress — never counted as missed), dashed =
      not assigned yet (not counted). Times are IST; ~ marks an approximate time (before 3 Jun 2026).
    </p>
  );
}

// ─── Day-by-day CSV (exactly the days on screen) ─────────────────────────────────

function downloadDaysCsv(fileParts: string[], range: GapWindowRange, blocks: { pair: GapPairRow; cells: GapDayCell[] }[]) {
  const rows: (string | number)[][] = [];
  for (const b of blocks) {
    const info = gapCsvPairInfo(b.pair);
    // The view is newest-first; the file runs oldest → newest (the all-rows export's order).
    for (let i = b.cells.length - 1; i >= 0; i--) rows.push(gapDaysCsvRow(info, b.cells[i]));
  }
  const name = ["submission-gaps-days", ...fileParts.map(gapFileSlug).filter(Boolean), `${range.startDate}_${range.endDate}`].join("-");
  // No comment row: the columns match the all-rows export, so the files can be combined
  // and pivoted — the window is in the filename and in every row's date.
  downloadCsv(`${name}.csv`, [...GAP_DAYS_CSV_HEADERS], rows);
}

function DaysCsvButton({ ready, onClick }: { ready: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!ready}
      title={ready ? "Download exactly the days shown, one row per day" : "Available once this window's days have loaded"}
      className={pillBtnCls}
    >
      <Download className="h-3.5 w-3.5 text-ds-teal" aria-hidden /> Day-by-day CSV
    </button>
  );
}

// ─── By channel: one (person, channel) ───────────────────────────────────────────

export function PairDayByDay({ row, report, today, year }: { row: GapPairRow; report: GapWindowRange; today: string; year: string }) {
  const nav = useGapDayWindow(report, today);
  const [series, setSeries] = useState<ChannelSeries | null>(null);
  const onSeries = useCallback((_accountId: string, s: ChannelSeries | null) => setSeries(s), []);
  const ready = series?.window === windowKey(nav.range);
  return (
    <div className="mt-3 space-y-2 border-t border-[#182C39] pt-3">
      <DayWindowControls
        nav={nav}
        year={year}
        actions={
          <DaysCsvButton
            ready={ready}
            onClick={() =>
              series && downloadDaysCsv([row.employee.name, row.account.displayName], nav.range, [{ pair: row, cells: series.cells }])
            }
          />
        }
      />
      <ChannelDays employeeId={row.employee.id} accountId={row.account.id} range={nav.range} year={year} onSeries={onSeries} />
      <Legend />
    </div>
  );
}

// ─── By person: every assigned channel, one shared navigation ─────────────────────

export function PersonDayByDay({
  person,
  channels,
  report,
  today,
  year,
}: {
  person: GapEmployeeRow;
  channels: GapPairRow[];
  report: GapWindowRange;
  today: string;
  year: string;
}) {
  const nav = useGapDayWindow(report, today);
  const [seriesById, setSeriesById] = useState<Record<string, ChannelSeries | null>>({});
  const onSeries = useCallback(
    (accountId: string, s: ChannelSeries | null) => setSeriesById((m) => (m[accountId] === s ? m : { ...m, [accountId]: s })),
    [],
  );
  const key = windowKey(nav.range);
  const ready = channels.length > 0 && channels.every((c) => seriesById[c.account.id]?.window === key);

  if (channels.length === 0) {
    return <p className="mt-3 border-t border-[#182C39] pt-3 text-xs text-ds-t3">No assigned channels in this scope.</p>;
  }
  return (
    <div className="mt-3 space-y-3 border-t border-[#182C39] pt-3">
      <DayWindowControls
        nav={nav}
        year={year}
        actions={
          <DaysCsvButton
            ready={ready}
            onClick={() =>
              downloadDaysCsv(
                [person.employee.name],
                nav.range,
                // The all-rows export's order: by channel name, then id.
                [...channels]
                  .sort((a, b) => a.account.displayName.localeCompare(b.account.displayName) || a.account.id.localeCompare(b.account.id))
                  .map((c) => ({ pair: c, cells: seriesById[c.account.id]?.cells ?? [] })),
              )
            }
          />
        }
      />
      {channels.map((c) => (
        <section
          key={c.account.id}
          className="min-w-0 space-y-1 rounded-[12px] border border-[#182C39] bg-[rgba(11,23,32,.55)] p-3"
          aria-label={`${c.account.displayName}, day by day`}
        >
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs">
            <span className="min-w-0 max-w-full truncate text-[14px] font-semibold text-ds-text">{c.account.displayName}</span>
            <span className="min-w-0 break-words text-ds-t3">
              {c.account.platformName} · @{c.account.handle.replace(/^@/, "")} · since {fmtDay(c.assignedSince, year)}
            </span>
            <span className={`min-w-0 break-words tabular-nums ${c.missedDays > 0 ? "text-[#FDA4AF]" : "text-[#5EEAC4]"}`}>
              Report range:{" "}
              {c.countedDays === 0
                ? "nothing counted yet"
                : `${plural(c.missedDays, "missed day")} of ${nf.format(c.countedDays)}${
                    c.currentGapDays > 0 ? ` · gap ${c.currentGapOpenEnded ? "≥ " : ""}${plural(c.currentGapDays, "day")}` : ""
                  }`}
            </span>
          </div>
          <ChannelDays employeeId={person.employee.id} accountId={c.account.id} range={nav.range} year={year} onSeries={onSeries} />
        </section>
      ))}
      <Legend />
    </div>
  );
}
