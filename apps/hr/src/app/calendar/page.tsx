"use client";
import { useState } from "react";
import { apiFetch } from "@/lib/api";
import useSWR from "swr";
import { Topstrip } from "@/components/portal-shell";
import {
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  Briefcase,
} from "lucide-react";

interface CalendarDay {
  date: string;
  isWeekend: boolean;
  isHoliday: boolean;
  holidayName?: string;
  isLeave: boolean;
  leaveType?: string;
  leaveStatus?: string;
}

interface CalendarData {
  year: number;
  month: number;
  workingDays: number;
  days: CalendarDay[];
}

interface Holiday {
  id: string;
  date: string;
  name: string;
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const fetcher = (url: string) => apiFetch<any>(url).then((r) => r.data);

export default function CalendarPage() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);

  const { data: calendar } = useSWR<CalendarData>(
    `/hr/calendar?year=${year}&month=${month}`,
    fetcher
  );
  const { data: holidays } = useSWR<Holiday[]>(
    `/hr/holidays?year=${year}`,
    fetcher
  );

  function prevMonth() {
    if (month === 1) { setMonth(12); setYear(year - 1); }
    else { setMonth(month - 1); }
  }

  function nextMonth() {
    if (month === 12) { setMonth(1); setYear(year + 1); }
    else { setMonth(month + 1); }
  }

  const firstDay = new Date(year, month - 1, 1).getDay();
  const daysInMonth = new Date(year, month, 0).getDate();

  const dayMap = new Map<string, CalendarDay>();
  calendar?.days?.forEach((d) => {
    const dateStr = new Date(d.date).getDate().toString();
    dayMap.set(dateStr, d);
  });

  const cells: (CalendarDay | null)[] = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const existing = dayMap.get(d.toString());
    if (existing) {
      cells.push(existing);
    } else {
      const dateObj = new Date(year, month - 1, d);
      const dow = dateObj.getDay();
      cells.push({
        date: dateObj.toISOString(),
        isWeekend: dow === 0, // Mon–Sat working week — Sunday only
        isHoliday: false,
        isLeave: false,
      });
    }
  }

  function getCellClasses(day: CalendarDay | null) {
    if (!day) return "bg-transparent border-transparent";
    if (day.isLeave) {
      if (day.leaveStatus === "PENDING") return "bg-attention-bg border-attention/30";
      if (day.leaveStatus === "REJECTED") return "bg-danger-bg border-danger/20 opacity-70";
      return "bg-indigo-soft border-indigo/20"; // APPROVED
    }
    if (day.isHoliday) return "bg-danger-bg border-danger/20";
    if (day.isWeekend) return "bg-muted border-ink/5";
    return "bg-surface border-ink/8";
  }

  function getDateTextClass(day: CalendarDay) {
    if (day.isHoliday) return "text-danger";
    if (day.isLeave) {
      if (day.leaveStatus === "PENDING") return "text-attention";
      if (day.leaveStatus === "REJECTED") return "text-danger line-through";
      return "text-indigo"; // APPROVED
    }
    if (day.isWeekend) return "text-ink-4";
    return "text-ink";
  }

  function getLeaveStatusLabel(day: CalendarDay) {
    if (!day.isLeave) return null;
    if (day.leaveStatus === "PENDING") return { text: "Pending", cls: "text-attention" };
    if (day.leaveStatus === "REJECTED") return { text: "Rejected", cls: "text-danger" };
    return null; // APPROVED — just show leave type, no extra label
  }

  return (
    <>
      <Topstrip title="Work Calendar" sub="Your monthly schedule at a glance" />
      <div className="px-6 py-6 flex-1 overflow-y-auto max-w-[900px]">

        {/* Working Days Stat */}
        <div className="flex flex-wrap items-center gap-4 mb-6">
          <div className="v3-card-sm p-3 flex items-center gap-3">
            <div className="h-9 w-9 rounded-xl bg-indigo-soft flex items-center justify-center shrink-0">
              <Briefcase className="w-4 h-4 text-indigo" />
            </div>
            <div className="leading-tight">
              <p className="text-xl font-num font-light text-ink leading-none">
                {calendar?.workingDays ?? "--"}
              </p>
              <p className="text-[11px] text-ink-4 font-medium mt-1">Working Days</p>
            </div>
          </div>
        </div>

        {/* Month Selector + Calendar */}
        <div className="v3-card mb-5">
          <div className="px-5 h-12 flex items-center justify-between" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
            <button
              onClick={prevMonth}
              className="p-1.5 rounded-lg hover:bg-muted transition-colors"
            >
              <ChevronLeft className="w-4 h-4 text-ink" />
            </button>
            <h2 className="text-[15px] font-display font-semibold text-ink">
              {MONTH_NAMES[month - 1]} {year}
            </h2>
            <button
              onClick={nextMonth}
              className="p-1.5 rounded-lg hover:bg-muted transition-colors"
            >
              <ChevronRight className="w-4 h-4 text-ink" />
            </button>
          </div>

          <div className="p-5">
            {/* Day Headers */}
            <div className="grid grid-cols-7 gap-1 mb-1">
              {DAY_NAMES.map((d) => (
                <div key={d} className="text-center text-[11px] font-bold text-ink-4 uppercase tracking-wider py-2">
                  {d}
                </div>
              ))}
            </div>

            {/* Calendar Grid */}
            <div className="grid grid-cols-7 gap-1">
              {cells.map((day, idx) => (
                <div
                  key={idx}
                  className={`relative min-h-[72px] rounded-xl border p-1.5 transition-colors ${getCellClasses(day)}`}
                  title={
                    day?.isHoliday
                      ? day.holidayName
                      : day?.isLeave
                        ? `${day.leaveType?.replace(/_/g, " ")} — ${day.leaveStatus}`
                        : undefined
                  }
                >
                  {day && (
                    <>
                      <span className={`text-[13px] font-semibold ${getDateTextClass(day)}`}>
                        {new Date(day.date).getDate()}
                      </span>
                      {day.isHoliday && day.holidayName && (
                        <p className="text-[9px] leading-tight text-danger mt-0.5 truncate font-medium">
                          {day.holidayName}
                        </p>
                      )}
                      {day.isLeave && day.leaveType && (() => {
                        const statusLabel = getLeaveStatusLabel(day);
                        const leaveColor = day.leaveStatus === "PENDING" ? "text-attention"
                          : day.leaveStatus === "REJECTED" ? "text-danger"
                          : "text-indigo";
                        return (
                          <>
                            <p className={`text-[9px] leading-tight mt-0.5 truncate font-medium ${leaveColor}`}>
                              {day.leaveType.replace(/_/g, " ")}
                            </p>
                            {statusLabel && (
                              <p className={`text-[8px] leading-tight mt-0.5 truncate font-bold uppercase tracking-wide ${statusLabel.cls}`}>
                                {statusLabel.text}
                              </p>
                            )}
                          </>
                        );
                      })()}
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Legend */}
        <div className="v3-card mb-5">
          <div className="px-5 h-12 flex items-center gap-2" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
            <CalendarDays className="w-4 h-4 text-ink-3" />
            <span className="text-[13px] font-semibold text-ink">Legend</span>
          </div>
          <div className="px-5 py-4 flex flex-wrap gap-5">
            <div className="flex items-center gap-2">
              <span className="w-4 h-4 rounded-lg bg-surface border border-ink/10" />
              <span className="text-[12px] text-ink-3 font-medium">Working Day</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-4 h-4 rounded-lg bg-muted border border-ink/5" />
              <span className="text-[12px] text-ink-3 font-medium">Weekend</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-4 h-4 rounded-lg bg-danger-bg border border-danger/20" />
              <span className="text-[12px] text-ink-3 font-medium">Holiday</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-4 h-4 rounded-lg bg-indigo-soft border border-indigo/20" />
              <span className="text-[12px] text-ink-3 font-medium">Leave Approved</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-4 h-4 rounded-lg bg-attention-bg border border-attention/30" />
              <span className="text-[12px] text-ink-3 font-medium">Leave Pending</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-4 h-4 rounded-lg bg-danger-bg border border-danger/20 opacity-70" />
              <span className="text-[12px] text-ink-3 font-medium">Leave Rejected</span>
            </div>
          </div>
        </div>

        {/* Holidays List */}
        {holidays && holidays.length > 0 && (
          <div className="v3-card">
            <div className="px-5 h-12 flex items-center gap-2" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
              <span className="text-[13px] font-semibold text-ink">Holidays in {year}</span>
            </div>
            <div className="px-5 py-3 space-y-1">
              {holidays.map((h) => (
                <div
                  key={h.id}
                  className="v3-row flex items-center justify-between py-2.5 px-3 rounded-xl"
                >
                  <span className="text-[13px] font-medium text-ink">{h.name}</span>
                  <span className="text-[12px] text-ink-4 font-medium">
                    {new Date(h.date).toLocaleDateString("en-IN", {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    })}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
