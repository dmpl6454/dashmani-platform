"use client";
import { useState } from "react";
import Link from "next/link";
import { useContentCalendar } from "@/lib/hooks/use-content";
import { useProjects } from "@/lib/hooks/use-projects";
import { ChevronLeft, ChevronRight, List, Plus } from "lucide-react";

const STATUS_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  PENDING_APPROVAL: "Pending",
  APPROVED: "Approved",
  SCHEDULED: "Scheduled",
  PUBLISHED: "Published",
  FAILED: "Failed",
  REJECTED: "Rejected",
};

const STATUS_DOT_COLOR: Record<string, string> = {
  DRAFT: "var(--hx-A7B3C2)",
  PENDING_APPROVAL: "var(--hx-FBBF24)",
  APPROVED: "var(--hx-34D399)",
  SCHEDULED: "var(--hx-238BFF)",
  PUBLISHED: "var(--hx-00D7A0)",
  FAILED: "var(--hx-FB7185)",
  REJECTED: "var(--hx-E5484D)",
};

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function ContentCalendarPage() {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth() + 1);
  const [projectId, setProjectId] = useState("");
  const { data, isLoading } = useContentCalendar(year, month, projectId || undefined);
  const { data: projectsData } = useProjects();
  const calendarData = (data as any)?.data;
  const projects = (projectsData as any)?.data || [];

  function prevMonth() {
    if (month === 1) { setMonth(12); setYear(year - 1); } else { setMonth(month - 1); }
  }

  function nextMonth() {
    if (month === 12) { setMonth(1); setYear(year + 1); } else { setMonth(month + 1); }
  }

  const firstDay = new Date(year, month - 1, 1).getDay();
  const daysInMonth = new Date(year, month, 0).getDate();
  const weeks: (number | null)[][] = [];
  let currentWeek: (number | null)[] = [];

  for (let i = 0; i < firstDay; i++) currentWeek.push(null);
  for (let day = 1; day <= daysInMonth; day++) {
    currentWeek.push(day);
    if (currentWeek.length === 7) { weeks.push(currentWeek); currentWeek = []; }
  }
  if (currentWeek.length > 0) {
    while (currentWeek.length < 7) currentWeek.push(null);
    weeks.push(currentWeek);
  }

  function getPostsForDay(day: number) {
    if (!calendarData?.days) return [];
    const dateKey = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return calendarData.days[dateKey] || [];
  }

  return (
    <div className="pb-6">
      {/* Header */}
      <section className="flex items-end justify-between gap-4 flex-wrap pt-[26px] pb-5">
        <div className="basis-full sm:basis-auto sm:flex-1 min-w-0">
          <p className="text-[10px] tracking-[.2em] uppercase text-ds-gold font-semibold">Content Studio</p>
          <h1 className="mt-2 mb-0 text-[28px] font-semibold tracking-[-.02em] text-ds-text">Content Calendar</h1>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Link href="/content" className="inline-flex items-center gap-1.5 h-[34px] px-3.5 rounded-[6px] border border-ds-line2 bg-ds-card text-ds-t5 text-[12px] font-semibold whitespace-nowrap transition-colors hover:border-ds-line4 hover:text-ds-text">
            <List className="h-[13px] w-[13px]" strokeWidth={1.8} /> List View
          </Link>
          <Link href="/content/new" className="inline-flex items-center gap-1.5 h-[34px] px-4 rounded-[6px] border border-ds-gold bg-ds-gold/[.14] text-ds-gold text-[12px] font-semibold whitespace-nowrap transition-colors hover:bg-ds-gold/[.22] hover:text-ds-gold2">
            <Plus className="h-3.5 w-3.5" /> New Content
          </Link>
        </div>
      </section>

      {/* Controls */}
      <section className="flex flex-wrap items-center gap-2.5">
        <div className="flex items-center gap-1 h-[34px] px-1 rounded-[17px] bg-ds-inset border border-ds-line2">
          <button type="button" onClick={prevMonth} aria-label="Previous month" className="h-[26px] w-[26px] rounded-full grid place-items-center text-ds-t2 hover:bg-[color:var(--hx-132430)] hover:text-ds-text">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="min-w-[150px] text-center text-[12.5px] font-semibold text-ds-text whitespace-nowrap">
            {MONTH_NAMES[month - 1]} {year}
          </span>
          <button type="button" onClick={nextMonth} aria-label="Next month" className="h-[26px] w-[26px] rounded-full grid place-items-center text-ds-t2 hover:bg-[color:var(--hx-132430)] hover:text-ds-text">
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        <select
          className="h-[34px] max-w-full px-3 rounded-[17px] border border-ds-line2 bg-ds-inset text-ds-t5 text-[16px] sm:text-[12px] outline-none cursor-pointer [color-scheme:dark]"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          aria-label="Project"
        >
          <option value="" className="bg-ds-card">All Projects</option>
          {projects.map((p: any) => (
            <option key={p.id} value={p.id} className="bg-ds-card">{p.name}</option>
          ))}
        </select>
      </section>

      {isLoading ? (
        <section className="mt-3.5 px-5 py-14 text-center rounded-[8px] bg-ds-card border border-ds-line text-[12.5px] text-ds-t3">Loading calendar...</section>
      ) : (
        <section className="mt-3.5 rounded-[8px] bg-ds-card border border-ds-line overflow-hidden">
          <div className="overflow-x-auto">
            <div className="min-w-[700px]">
              <div className="grid grid-cols-7 border-b border-ds-line bg-[color:var(--hx-0A1620)]">
                {DAY_NAMES.map((d) => (
                  <div key={d} className="px-2 py-2.5 text-center text-[10px] tracking-[.12em] uppercase text-ds-t3 font-semibold border-r border-ds-grid last:border-r-0">
                    {d}
                  </div>
                ))}
              </div>
              {weeks.map((week, wi) => (
                <div key={wi} className="grid grid-cols-7 border-b border-ds-grid last:border-b-0">
                  {week.map((day, di) => {
                    const posts = day ? getPostsForDay(day) : [];
                    const isToday =
                      day === today.getDate() &&
                      month === today.getMonth() + 1 &&
                      year === today.getFullYear();
                    return (
                      <div
                        key={di}
                        className={`min-h-[104px] p-1.5 border-r border-ds-grid last:border-r-0 ${
                          day ? (isToday ? "bg-[rgba(233,189,98,.05)]" : "bg-ds-card") : "bg-[color:var(--hx-060F16)]"
                        }`}
                      >
                        {day && (
                          <>
                            <div
                              className={`text-[11px] font-semibold mb-1 h-6 w-6 rounded-full flex items-center justify-center tabular-nums ${
                                isToday
                                  ? "bg-ds-gold text-[color:var(--hx-060D14)] font-bold"
                                  : "text-ds-t3"
                              }`}
                            >
                              {day}
                            </div>
                            <div className="space-y-0.5">
                              {posts.slice(0, 3).map((post: any) => (
                                <Link key={post.id} href={`/content/${post.id}`} className="block">
                                  <div className="flex items-center gap-1.5 px-1.5 py-1 rounded-[4px] text-[11px] hover:bg-ds-hover truncate transition-colors">
                                    <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: STATUS_DOT_COLOR[post.status] || "var(--hx-738395)" }} />
                                    <span className="truncate text-ds-t5">{post.title}</span>
                                  </div>
                                </Link>
                              ))}
                              {posts.length > 3 && (
                                <div className="text-[10.5px] text-ds-t3 px-1.5">+{posts.length - 3} more</div>
                              )}
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Legend */}
      <div className="flex flex-wrap gap-4 mt-3.5 text-[11px]">
        {Object.entries(STATUS_DOT_COLOR).map(([status, color]) => (
          <div key={status} className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full" style={{ background: color }} />
            <span className="text-ds-t2">{STATUS_LABELS[status]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
