"use client";
import { useState, useMemo } from "react";
import { ClipboardList, CalendarDays, CheckCircle2, AlertTriangle, Filter } from "lucide-react";
import { useDailyReports, useDailyReportStatus } from "@/lib/hooks/use-daily-reports";
import { useEmployees } from "@/lib/hooks/use-employees";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import { UserAvatar } from "@/components/user-avatar";

// Local-date (IST for users in India) — never toISOString, which is UTC.
function todayLocalISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function displayDate(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

function fmtTime(v: string | null | undefined): string {
  if (!v) return "";
  return new Date(v).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
}

export default function DailyReportsPage() {
  usePageTitle("Daily Updates");
  const [date, setDate] = useState(todayLocalISO());
  const [employeeId, setEmployeeId] = useState("");

  const isToday = date === todayLocalISO();

  const { data: reportsEnv, isLoading: reportsLoading } = useDailyReports(date, employeeId || undefined);
  const { data: statusEnv } = useDailyReportStatus(date);
  const { data: empEnv } = useEmployees({ limit: 500 });

  const reports = (reportsEnv as any)?.data ?? [];
  const status = (statusEnv as any)?.data;
  const employees = (empEnv as any)?.data ?? [];

  const nonSubmitters = status?.nonSubmitters ?? [];
  const submittedCount = status?.submittedCount ?? 0;
  const totalEmployees = status?.totalEmployees ?? 0;

  const sortedReports = useMemo(
    () => [...reports].sort((a: any, b: any) => (b.updatedAt || b.date).localeCompare(a.updatedAt || a.date)),
    [reports],
  );

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <span className="h-9 w-9 rounded-xl bg-[#FFF3C4] flex items-center justify-center">
          <ClipboardList className="h-5 w-5 text-[#1A1A1A]" />
        </span>
        <div>
          <h1 className="text-2xl font-bold text-[#1A1A1A]">Daily Updates</h1>
          <p className="text-sm text-[#7A7A7A]">Written work updates from all employees — {displayDate(date)}</p>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-2xl border border-[#F0EAD8] p-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <CalendarDays className="h-4 w-4 text-[#7A7A7A]" />
          <input
            type="date"
            value={date}
            max={todayLocalISO()}
            onChange={(e) => setDate(e.target.value)}
            className="h-9 rounded-lg border border-[#E8E0D0] bg-[#FEFCF8] text-sm px-2.5 focus:outline-none focus:ring-2 focus:ring-[#F5D547]"
          />
          {!isToday && (
            <button
              onClick={() => setDate(todayLocalISO())}
              className="h-9 px-3 rounded-lg text-xs font-semibold text-[#1A1A1A] border border-[#E8E0D0] hover:border-[#1A1A1A]/30"
            >
              Today
            </button>
          )}
        </div>
        <span className="h-5 w-px bg-[#E8E0D0]" />
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-[#7A7A7A]" />
          <select
            value={employeeId}
            onChange={(e) => setEmployeeId(e.target.value)}
            className="h-9 rounded-lg border border-[#E8E0D0] bg-[#FEFCF8] text-sm px-2.5 focus:outline-none focus:ring-2 focus:ring-[#F5D547] min-w-[180px]"
          >
            <option value="">All employees</option>
            {employees.map((e: any) => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Submission status banner (only meaningful for "all employees" view) */}
      {!employeeId && status && (
        <div className={`rounded-2xl border p-4 ${
          nonSubmitters.length === 0
            ? "bg-green-50 border-green-200"
            : "bg-amber-50 border-amber-200"
        }`}>
          <div className="flex items-center gap-2 mb-2">
            {nonSubmitters.length === 0 ? (
              <><CheckCircle2 className="h-5 w-5 text-green-600" /><span className="font-semibold text-green-800">Everyone has submitted {isToday ? "today" : "on this day"} ✅</span></>
            ) : (
              <><AlertTriangle className="h-5 w-5 text-amber-600" /><span className="font-semibold text-amber-800">{nonSubmitters.length} of {totalEmployees} {nonSubmitters.length === 1 ? "employee hasn't" : "employees haven't"} submitted {isToday ? "today" : "on this day"}</span></>
            )}
          </div>
          {nonSubmitters.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-2">
              {nonSubmitters.map((e: any) => (
                <span key={e.id} className="inline-flex items-center gap-1.5 bg-white border border-amber-200 rounded-full px-2.5 py-1 text-xs text-[#7A4A00]">
                  <UserAvatar name={e.name} size={5} />
                  {e.name}
                </span>
              ))}
            </div>
          )}
          <p className="text-[11px] text-[#7A7A7A] mt-2">
            {submittedCount} submitted • counts active employees only (excludes pure-admin accounts).
          </p>
        </div>
      )}

      {/* Submitted reports */}
      {reportsLoading ? (
        <div className="bg-white rounded-2xl border border-[#F0EAD8] p-10 flex justify-center">
          <div className="animate-spin rounded-full h-7 w-7 border-b-2 border-[#1A1A1A]" />
        </div>
      ) : sortedReports.length === 0 ? (
        <div className="bg-white rounded-2xl border border-[#F0EAD8] p-10 text-center text-[#7A7A7A]">
          <ClipboardList className="h-8 w-8 mx-auto mb-2 opacity-40" />
          No daily updates {employeeId ? "from this employee " : ""}for {displayDate(date)} yet.
        </div>
      ) : (
        <div className="space-y-3">
          {sortedReports.map((r: any) => (
            <div key={r.id} className="bg-white rounded-2xl border border-[#F0EAD8] p-5 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <UserAvatar name={r.employee?.name ?? "—"} size={9} />
                  <div>
                    <p className="text-sm font-semibold text-[#1A1A1A]">{r.employee?.name ?? "Unknown"}</p>
                    <p className="text-[11px] text-[#B0B0B0]">{r.employee?.email}</p>
                  </div>
                </div>
                <span className="text-[11px] text-[#B0B0B0]">{fmtTime(r.updatedAt)}</span>
              </div>

              <div>
                <p className="text-[10.5px] font-bold text-[#B0B0B0] uppercase tracking-wider mb-0.5">What they did</p>
                <p className="text-sm text-[#1A1A1A] whitespace-pre-wrap">{r.tasks || "—"}</p>
              </div>

              {r.tomorrowPlan && (
                <div>
                  <p className="text-[10.5px] font-bold text-[#B0B0B0] uppercase tracking-wider mb-0.5">Tomorrow's plan</p>
                  <p className="text-sm text-[#4A4A4A] whitespace-pre-wrap">{r.tomorrowPlan}</p>
                </div>
              )}

              {r.blockers && (
                <div>
                  <p className="text-[10.5px] font-bold text-[#B0B0B0] uppercase tracking-wider mb-0.5">Notes</p>
                  <p className="text-sm text-[#4A4A4A] italic whitespace-pre-wrap">{r.blockers}</p>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
