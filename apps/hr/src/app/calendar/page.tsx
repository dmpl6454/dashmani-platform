"use client";
import { useState } from "react";
import { apiFetch } from "@/lib/api";
import useSWR from "swr";
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

const cardClass =
  "bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0] p-5";

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
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
    if (month === 1) {
      setMonth(12);
      setYear(year - 1);
    } else {
      setMonth(month - 1);
    }
  }

  function nextMonth() {
    if (month === 12) {
      setMonth(1);
      setYear(year + 1);
    } else {
      setMonth(month + 1);
    }
  }

  // Build calendar grid
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
        isWeekend: dow === 0 || dow === 6,
        isHoliday: false,
        isLeave: false,
      });
    }
  }

  function getCellClasses(day: CalendarDay | null) {
    if (!day) return "bg-transparent";
    if (day.isLeave) return "bg-blue-50 border-blue-200";
    if (day.isHoliday) return "bg-red-50 border-red-200";
    if (day.isWeekend) return "bg-gray-50 border-gray-200";
    return "bg-white border-[#E8E0D0]";
  }

  return (
    <div className="min-h-screen bg-[#FEFCF7] p-6 md:p-10">
      <h1 className="text-4xl font-light text-[#1A1A1A] font-serif mb-8">
        Work Calendar
      </h1>

      {/* Working Days Stat */}
      <div className="flex flex-wrap items-center gap-5 mb-8">
        <div className={`${cardClass} flex items-center gap-3`}>
          <Briefcase className="w-5 h-5 text-[#F5D547]" />
          <div>
            <p className="text-2xl font-light text-[#1A1A1A] font-serif">
              {calendar?.workingDays ?? "--"}
            </p>
            <p className="text-xs text-[#B0B0B0]">Working Days</p>
          </div>
        </div>
      </div>

      {/* Month Selector */}
      <div className={`${cardClass} mb-8`}>
        <div className="flex items-center justify-between mb-6">
          <button
            onClick={prevMonth}
            className="p-2 rounded-full hover:bg-[#F5F3EF] transition-colors"
          >
            <ChevronLeft className="w-5 h-5 text-[#1A1A1A]" />
          </button>
          <h2 className="text-xl font-semibold text-[#1A1A1A] font-serif">
            {MONTH_NAMES[month - 1]} {year}
          </h2>
          <button
            onClick={nextMonth}
            className="p-2 rounded-full hover:bg-[#F5F3EF] transition-colors"
          >
            <ChevronRight className="w-5 h-5 text-[#1A1A1A]" />
          </button>
        </div>

        {/* Day Headers */}
        <div className="grid grid-cols-7 gap-1 mb-1">
          {DAY_NAMES.map((d) => (
            <div
              key={d}
              className="text-center text-xs font-semibold text-[#B0B0B0] py-2"
            >
              {d}
            </div>
          ))}
        </div>

        {/* Calendar Grid */}
        <div className="grid grid-cols-7 gap-1">
          {cells.map((day, idx) => (
            <div
              key={idx}
              className={`relative min-h-[70px] md:min-h-[80px] rounded-lg border p-1.5 transition-colors ${getCellClasses(day)}`}
              title={
                day?.isHoliday
                  ? day.holidayName
                  : day?.isLeave
                    ? `Leave: ${day.leaveType}`
                    : undefined
              }
            >
              {day && (
                <>
                  <span
                    className={`text-sm font-medium ${
                      day.isHoliday
                        ? "text-red-500"
                        : day.isLeave
                          ? "text-blue-600"
                          : day.isWeekend
                            ? "text-gray-400"
                            : "text-[#1A1A1A]"
                    }`}
                  >
                    {new Date(day.date).getDate()}
                  </span>
                  {day.isHoliday && day.holidayName && (
                    <p className="text-[10px] leading-tight text-red-500 mt-0.5 truncate">
                      {day.holidayName}
                    </p>
                  )}
                  {day.isLeave && day.leaveType && (
                    <p className="text-[10px] leading-tight text-blue-600 mt-0.5 truncate">
                      {day.leaveType}
                    </p>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Legend */}
      <div className={cardClass}>
        <h3 className="text-sm font-semibold text-[#1A1A1A] mb-3 flex items-center gap-2">
          <CalendarDays className="w-4 h-4 text-[#F5D547]" />
          Color Legend
        </h3>
        <div className="flex flex-wrap gap-5">
          <div className="flex items-center gap-2">
            <span className="w-4 h-4 rounded bg-white border border-[#E8E0D0]" />
            <span className="text-xs text-[#666]">Working Day</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-4 h-4 rounded bg-gray-50 border border-gray-200" />
            <span className="text-xs text-[#666]">Weekend</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-4 h-4 rounded bg-red-50 border border-red-200" />
            <span className="text-xs text-[#666]">Holiday</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-4 h-4 rounded bg-blue-50 border border-blue-200" />
            <span className="text-xs text-[#666]">Leave</span>
          </div>
        </div>
      </div>

      {/* Holidays List */}
      {holidays && holidays.length > 0 && (
        <div className={`${cardClass} mt-6`}>
          <h3 className="text-sm font-semibold text-[#1A1A1A] mb-3">
            Holidays in {year}
          </h3>
          <div className="space-y-2">
            {holidays.map((h) => (
              <div
                key={h.id}
                className="flex items-center justify-between py-2 px-3 rounded-lg bg-red-50 border border-red-100"
              >
                <span className="text-sm text-[#1A1A1A]">{h.name}</span>
                <span className="text-xs text-[#B0B0B0]">
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
  );
}
