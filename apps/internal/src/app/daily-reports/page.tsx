"use client";
import { useState, useMemo } from "react";
import { ClipboardList, CalendarDays, CheckCircle2, AlertTriangle, Filter, Search, Clock, ChevronLeft, ChevronRight } from "lucide-react";
import { useDailyReports, useDailyReportStatus } from "@/lib/hooks/use-daily-reports";
import { useEmployees } from "@/lib/hooks/use-employees";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import { BoxesLoader } from "@/components/boxes-loader";

// Local-date (IST for users in India) — never toISOString, which is UTC.
function isoLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function todayLocalISO(): string {
  return isoLocal(new Date());
}
function shiftDay(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00");
  d.setDate(d.getDate() + n);
  return isoLocal(d);
}

function displayDate(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

function fmtTime(v: string | null | undefined): string {
  if (!v) return "";
  return new Date(v).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
}

// Initials avatar, same palette as the Employees page.
const AV_BG = ["var(--hx-10222E)", "var(--hx-0E2A22)", "var(--hx-1B1630)", "var(--hx-2A2410)", "var(--hx-2A1116)"];
const AV_FG = ["var(--hx-238BFF)", "var(--hx-34D399)", "var(--hx-9B7EDE)", "var(--hx-E9BD62)", "var(--hx-FB7185)"];
const hash = (s: string) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = s.charCodeAt(i) + ((h << 5) - h);
  return Math.abs(h);
};
function Mono({ name, size }: { name: string; size: number }) {
  const k = hash(name || "") % 5;
  return (
    <span
      aria-hidden="true"
      className="rounded-full grid place-items-center font-bold shrink-0"
      style={{ width: size, height: size, background: AV_BG[k], color: AV_FG[k], fontSize: size >= 34 ? 13 : 10 }}
    >
      {(name || "?").trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

const MISSING_PREVIEW = 18;

export default function DailyReportsPage() {
  usePageTitle("Daily Updates");
  const [date, setDate] = useState(todayLocalISO());
  const [employeeId, setEmployeeId] = useState("");
  const [missingQuery, setMissingQuery] = useState("");
  const [showAllMissing, setShowAllMissing] = useState(false);

  const today = todayLocalISO();
  const isToday = date === today;
  const dayWord = isToday ? "today" : "on this day";

  const { data: reportsEnv, isLoading: reportsLoading } = useDailyReports(date, employeeId || undefined);
  const { data: statusEnv } = useDailyReportStatus(date);
  const { data: empEnv } = useEmployees({ limit: 500 });

  const reports = (reportsEnv as any)?.data ?? [];
  const status = (statusEnv as any)?.data;
  const employees = (empEnv as any)?.data ?? [];

  const nonSubmitters = status?.nonSubmitters ?? [];
  const submittedCount = status?.submittedCount ?? 0;
  const totalEmployees = status?.totalEmployees ?? 0;
  const pct = totalEmployees > 0 ? Math.round((submittedCount / totalEmployees) * 100) : null;
  const allIn = nonSubmitters.length === 0;

  const sortedReports = useMemo(
    () => [...reports].sort((a: any, b: any) => (b.updatedAt || b.date).localeCompare(a.updatedAt || a.date)),
    [reports],
  );

  const missingShown = useMemo(() => {
    const q = missingQuery.trim().toLowerCase();
    const f = nonSubmitters.filter((e: any) => !q || (e.name ?? "").toLowerCase().includes(q));
    return showAllMissing || q ? f : f.slice(0, MISSING_PREVIEW);
  }, [nonSubmitters, missingQuery, showAllMissing]);

  const selectedName = employeeId ? employees.find((e: any) => e.id === employeeId)?.name ?? "Selected employee" : null;

  const changeDate = (v: string) => {
    if (!v) return;
    setDate(v > today ? today : v);
  };

  return (
    <div className="pb-8">
      {/* Header */}
      <section className="flex items-end justify-between gap-4 flex-wrap pt-[26px] pb-5">
        <div className="flex-[1_1_380px] min-w-0">
          <div className="text-[10px] tracking-[.2em] uppercase text-ds-gold font-semibold">Work</div>
          <h1 className="mt-2 text-[28px] font-semibold tracking-[-.02em] text-ds-text">Daily Updates</h1>
          <p className="mt-1.5 text-[13.5px] text-ds-t2 [text-wrap:pretty]">
            Written work updates from all employees · {displayDate(date)}
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center h-[34px] rounded-full border border-ds-line2 bg-ds-inset overflow-hidden">
            <button
              type="button"
              onClick={() => setDate(shiftDay(date, -1))}
              title="Previous day"
              aria-label="Previous day"
              className="w-[34px] h-full grid place-items-center text-ds-t2 hover:text-ds-gold"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <label className="flex items-center gap-[7px] h-full px-1.5 border-x border-ds-line text-ds-t5">
              <CalendarDays className="h-[13px] w-[13px] text-ds-gold" />
              <input
                type="date"
                value={date}
                max={today}
                onChange={(e) => changeDate(e.target.value)}
                aria-label="Date"
                className="bg-transparent border-0 outline-none text-ds-text text-[16px] sm:text-[12px] [color-scheme:dark] w-[128px]"
              />
            </label>
            <button
              type="button"
              onClick={() => !isToday && setDate(shiftDay(date, 1))}
              disabled={isToday}
              title="Next day"
              aria-label="Next day"
              className="w-[34px] h-full grid place-items-center text-ds-t2 hover:text-ds-gold disabled:text-[color:var(--hx-33506A)] disabled:hover:text-[color:var(--hx-33506A)] disabled:cursor-default"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          {!isToday && (
            <button
              type="button"
              onClick={() => setDate(today)}
              className="h-[34px] px-3.5 rounded-full border border-ds-gold bg-[rgba(233,189,98,.14)] text-ds-gold text-[12px] font-semibold whitespace-nowrap hover:bg-[rgba(233,189,98,.22)]"
            >
              Today
            </button>
          )}

          <label className="flex items-center gap-2 h-[34px] px-3 rounded-full border border-ds-line2 bg-ds-inset text-ds-t3 max-w-full">
            <Filter className="h-[13px] w-[13px] shrink-0" />
            <select
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
              aria-label="Employee"
              className="bg-transparent border-0 outline-none text-ds-text text-[16px] sm:text-[12px] min-w-[150px] max-w-[220px] cursor-pointer"
            >
              <option value="" className="bg-ds-card">All employees</option>
              {employees.map((e: any) => (
                <option key={e.id} value={e.id} className="bg-ds-card">{e.name}</option>
              ))}
            </select>
          </label>
        </div>
      </section>

      {/* Submission status (only meaningful for the "all employees" view) */}
      {!employeeId && status && (
        <section className="relative rounded-[12px] bg-[linear-gradient(180deg,var(--hx-0B1A27)_0%,var(--hx-08131C)_75%)] border border-[color:var(--hx-1D3444)] overflow-hidden">
          <span
            aria-hidden="true"
            className="absolute left-0 right-0 top-0 h-px"
            style={{ background: `linear-gradient(90deg,transparent,${allIn ? "var(--hx-00D7A0)" : "var(--hx-E9BD62)"} 30%,${allIn ? "var(--hx-00D7A0)" : "var(--hx-E9BD62)"} 70%,transparent)` }}
          />
          <div className="flex flex-wrap gap-x-10 gap-y-6 px-7 py-[26px] items-center">
            <div className="flex-none">
              <div className="text-[10.5px] tracking-[.22em] uppercase text-ds-t2 font-semibold">Submitted {dayWord}</div>
              <div className="flex items-baseline gap-2.5 mt-2.5">
                <span className="text-[60px] font-semibold tracking-[-.04em] leading-[.9] text-ds-text">{submittedCount}</span>
                <span className="text-[24px] font-light text-ds-t3 tracking-[-.02em]">/ {totalEmployees}</span>
              </div>
              <div className="flex items-center gap-2.5 mt-3.5 w-[240px] max-w-full">
                <div className="flex-1 h-1 rounded-[2px] bg-[color:var(--hx-132430)] overflow-hidden">
                  <div
                    className="h-full bg-[linear-gradient(90deg,var(--hx-B8913F),var(--hx-E9BD62))] transition-[width] duration-500"
                    style={{ width: `${pct ?? 0}%` }}
                  />
                </div>
                <span className="text-[11px] font-bold text-ds-gold">{pct === null ? "—" : `${pct}%`}</span>
              </div>
            </div>

            <div className="flex-[1_1_360px] min-w-0 sm:pl-7 sm:border-l border-[color:var(--hx-1D3444)]">
              <div className={`flex items-center gap-2 text-[13.5px] font-semibold ${allIn ? "text-ds-teal" : "text-[color:var(--hx-FBBF24)]"}`}>
                {allIn ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <AlertTriangle className="h-4 w-4 shrink-0" />}
                <span>
                  {allIn
                    ? `Everyone has submitted ${dayWord}`
                    : `${nonSubmitters.length} of ${totalEmployees} ${nonSubmitters.length === 1 ? "employee hasn't" : "employees haven't"} submitted ${dayWord}`}
                </span>
              </div>
              <div className="text-[11px] text-ds-t3 mt-3">
                {submittedCount} submitted · counts active employees only (excludes pure-admin accounts).
              </div>
            </div>
          </div>

          {!allIn && (
            <div className="border-t border-ds-line bg-[color-mix(in_srgb,var(--hx-060F16)_35%,transparent)] px-7 pt-4 pb-5">
              <div className="flex items-center gap-3 flex-wrap">
                <span className="whitespace-nowrap text-[10px] tracking-[.18em] uppercase text-[color:var(--hx-FBBF24)] font-bold">Not yet submitted</span>
                <span className="h-5 px-2 rounded-full bg-[rgba(251,191,36,.12)] text-[color:var(--hx-FBBF24)] text-[10.5px] font-bold inline-flex items-center whitespace-nowrap">
                  {nonSubmitters.length} pending
                </span>
                <label className="sm:ml-auto flex items-center gap-[7px] h-7 px-[11px] rounded-full bg-ds-inset border border-ds-line2 text-ds-t3 w-[220px] max-w-full">
                  <Search className="h-3 w-3 shrink-0" />
                  <input
                    value={missingQuery}
                    onChange={(e) => setMissingQuery(e.target.value)}
                    placeholder="Find a name…"
                    aria-label="Find a name among those not yet submitted"
                    className="flex-1 min-w-0 bg-transparent border-0 outline-none text-ds-text text-[16px] sm:text-[11.5px] placeholder:text-ds-t3"
                  />
                </label>
              </div>
              <div className="flex flex-wrap gap-1.5 mt-3">
                {missingShown.map((e: any) => (
                  <button
                    key={e.id}
                    type="button"
                    onClick={() => setEmployeeId(e.id)}
                    title={`View ${e.name}`}
                    className="inline-flex items-center gap-[7px] h-7 pl-[3px] pr-[11px] rounded-full border border-ds-line2 bg-ds-inset text-ds-t5 text-[11.5px] font-medium whitespace-nowrap max-w-full hover:border-[rgba(251,191,36,.55)] hover:text-[color:var(--hx-F4D58C)]"
                  >
                    <Mono name={e.name} size={22} />
                    <span className="truncate">{e.name}</span>
                  </button>
                ))}
                {missingShown.length === 0 && (
                  <span className="text-[11.5px] text-ds-t3 py-1">No name matches “{missingQuery.trim()}”.</span>
                )}
                {!missingQuery.trim() && nonSubmitters.length > MISSING_PREVIEW && (
                  <button
                    type="button"
                    onClick={() => setShowAllMissing((v) => !v)}
                    className="h-7 px-[13px] rounded-full border border-dashed border-[color:var(--hx-33506A)] text-ds-gold text-[11.5px] font-semibold whitespace-nowrap hover:border-ds-gold"
                  >
                    {showAllMissing ? "Show fewer" : `Show all ${nonSubmitters.length}`}
                  </button>
                )}
              </div>
            </div>
          )}
        </section>
      )}

      {/* List header */}
      <section className="flex items-baseline justify-between gap-3 mt-[26px] mb-3 flex-wrap">
        <div className="flex items-baseline gap-2.5 min-w-0">
          <span className="text-[16px] font-semibold text-ds-text truncate">{selectedName ?? "Submitted updates"}</span>
          {!reportsLoading && (
            <span className="text-[11.5px] text-ds-t3 whitespace-nowrap">
              {sortedReports.length} {sortedReports.length === 1 ? "update" : "updates"}
            </span>
          )}
          {employeeId && (
            <button type="button" onClick={() => setEmployeeId("")} className="text-[11.5px] text-ds-gold hover:underline whitespace-nowrap">
              Show all
            </button>
          )}
        </div>
        <span className="text-[11px] text-ds-t3">Latest first</span>
      </section>

      {/* Submitted reports */}
      {reportsLoading ? (
        <div className="bg-ds-card border border-ds-line rounded-[10px] p-12 grid place-items-center">
          <BoxesLoader />
        </div>
      ) : sortedReports.length === 0 ? (
        <div className="bg-ds-card border border-dashed border-ds-line2 rounded-[10px] px-5 py-14 text-center text-ds-t3 text-[13px]">
          <ClipboardList className="h-[30px] w-[30px] mx-auto opacity-50" strokeWidth={1.5} />
          <div className="mt-2.5">
            No daily updates {employeeId ? "from this employee " : ""}for {displayDate(date)} yet.
          </div>
        </div>
      ) : (
        <section className="grid gap-3.5 [grid-template-columns:repeat(auto-fill,minmax(min(100%,420px),1fr))]">
          {sortedReports.map((r: any) => {
            const name = r.employee?.name ?? "Unknown";
            const time = fmtTime(r.updatedAt);
            return (
              <article key={r.id} className="relative flex flex-col bg-ds-card border border-ds-line rounded-[10px] overflow-hidden hover:border-[color:var(--hx-2A4658)] transition-colors">
                <div className="flex items-center gap-3 px-5 py-4 border-b border-[color:var(--hx-101E29)]">
                  <span className="rounded-full border border-ds-line2 shrink-0">
                    <Mono name={name} size={38} />
                  </span>
                  <div className="flex-1 min-w-0 leading-[1.3]">
                    <div className="text-[13.5px] font-semibold text-ds-text truncate">{name}</div>
                    <div className="text-[11px] text-ds-t3 truncate">{r.employee?.email ?? "—"}</div>
                  </div>
                  {time && (
                    <span className="inline-flex items-center gap-[5px] h-6 px-2.5 rounded-full bg-ds-inset border border-ds-line text-ds-t2 text-[11px] font-semibold whitespace-nowrap shrink-0">
                      <Clock className="h-[11px] w-[11px]" />
                      {time}
                    </span>
                  )}
                </div>

                <div className="flex flex-col gap-4 px-5 pt-[18px] pb-5">
                  <div>
                    <div className="text-[10px] tracking-[.18em] uppercase text-ds-gold font-bold">What they did</div>
                    <p className="mt-[7px] text-[13px] leading-[1.6] text-ds-text whitespace-pre-wrap break-words [text-wrap:pretty]">{r.tasks || "—"}</p>
                  </div>

                  {r.tomorrowPlan && (
                    <div className="pt-3.5 border-t border-dashed border-ds-line">
                      <div className="text-[10px] tracking-[.18em] uppercase text-[color:var(--hx-6EB2FF)] font-bold">Tomorrow&apos;s plan</div>
                      <p className="mt-[7px] text-[12.5px] leading-[1.6] text-ds-t5 whitespace-pre-wrap break-words [text-wrap:pretty]">{r.tomorrowPlan}</p>
                    </div>
                  )}

                  {r.blockers && (
                    <div className="px-3.5 py-3 rounded-[8px] bg-[rgba(251,191,36,.05)] border border-[rgba(251,191,36,.18)]">
                      <div className="text-[10px] tracking-[.18em] uppercase text-[color:var(--hx-FBBF24)] font-bold">Notes</div>
                      <p className="mt-1.5 text-[12.5px] leading-[1.55] text-ds-t5 italic whitespace-pre-wrap break-words [text-wrap:pretty]">{r.blockers}</p>
                    </div>
                  )}
                </div>
              </article>
            );
          })}
        </section>
      )}
    </div>
  );
}
