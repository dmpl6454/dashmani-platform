"use client";
import { useState } from "react";
import Link from "next/link";
import { useContentCalendar } from "@/lib/hooks/use-content";
import { useProjects } from "@/lib/hooks/use-projects";
import { Button } from "@dashmani/ui";

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
  DRAFT: "bg-[#B0B0B0]",
  PENDING_APPROVAL: "bg-[#F5D547]",
  APPROVED: "bg-[#6BCB77]",
  SCHEDULED: "bg-[#3498DB]",
  PUBLISHED: "bg-[#6BCB77]",
  FAILED: "bg-[#E74C3C]",
  REJECTED: "bg-[#E74C3C]",
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
    <div className="space-y-6 crx-animate-fade">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-serif text-4xl font-light text-[#1A1A1A]">Content Calendar</h1>
        <div className="flex items-center gap-2">
          <Link href="/content">
            <Button variant="outline" className="border border-[#E8E0D0] rounded-full text-[#1A1A1A] hover:bg-[rgba(255,248,225,0.5)]">List View</Button>
          </Link>
          <Link href="/content/new">
            <Button className="bg-[#1A1A1A] text-white rounded-full hover:bg-[#2B2B2B]">+ New Content</Button>
          </Link>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 sm:gap-4 crx-animate-slide crx-delay-1">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={prevMonth} className="border border-[#E8E0D0] rounded-full text-[#1A1A1A] hover:bg-[rgba(255,248,225,0.5)]">
            &larr;
          </Button>
          <span className="text-lg font-semibold font-serif min-w-[180px] text-center text-[#1A1A1A]">
            {MONTH_NAMES[month - 1]} {year}
          </span>
          <Button variant="outline" size="sm" onClick={nextMonth} className="border border-[#E8E0D0] rounded-full text-[#1A1A1A] hover:bg-[rgba(255,248,225,0.5)]">
            &rarr;
          </Button>
        </div>
        <select
          className="h-10 max-w-full rounded-lg border border-[#E8E0D0] bg-white px-3 py-2 text-sm focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] outline-none"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
        >
          <option value="">All Projects</option>
          {projects.map((p: any) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>

      {isLoading ? (
        <div className="text-center text-[#7A7A7A] py-8">Loading calendar...</div>
      ) : (
        <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] overflow-hidden crx-animate-slide crx-delay-2">
          <div className="grid grid-cols-7 border-b border-[#F0EAD8]">
            {DAY_NAMES.map((d) => (
              <div key={d} className="p-2 text-center text-[#7A7A7A] text-xs font-medium border-r border-[#F0EAD8] last:border-r-0">
                {d}
              </div>
            ))}
          </div>
          {weeks.map((week, wi) => (
            <div key={wi} className="grid grid-cols-7 border-b border-[#F0EAD8] last:border-b-0">
              {week.map((day, di) => {
                const posts = day ? getPostsForDay(day) : [];
                const isToday =
                  day === today.getDate() &&
                  month === today.getMonth() + 1 &&
                  year === today.getFullYear();
                return (
                  <div
                    key={di}
                    className={`min-h-[100px] p-1.5 border-r border-[#F0EAD8] last:border-r-0 ${
                      day ? "bg-white" : "bg-[rgba(255,248,225,0.3)]"
                    }`}
                  >
                    {day && (
                      <>
                        <div
                          className={`text-xs font-medium mb-1 ${
                            isToday
                              ? "bg-[#F5D547] text-[#1A1A1A] w-6 h-6 rounded-full flex items-center justify-center font-bold"
                              : "text-[#7A7A7A]"
                          }`}
                        >
                          {day}
                        </div>
                        <div className="space-y-0.5">
                          {posts.slice(0, 3).map((post: any) => (
                            <Link key={post.id} href={`/content/${post.id}`} className="block">
                              <div className="flex items-center gap-1 px-1 py-0.5 rounded text-xs hover:bg-[rgba(255,248,225,0.5)] truncate transition-colors">
                                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${STATUS_DOT_COLOR[post.status] || "bg-[#B0B0B0]"}`} />
                                <span className="truncate text-[#1A1A1A]">{post.title}</span>
                              </div>
                            </Link>
                          ))}
                          {posts.length > 3 && (
                            <div className="text-xs text-[#B0B0B0] px-1">+{posts.length - 3} more</div>
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
      )}

      {/* Legend */}
      <div className="flex flex-wrap gap-4 text-xs">
        {Object.entries(STATUS_DOT_COLOR).map(([status, color]) => (
          <div key={status} className="flex items-center gap-1.5">
            <span className={`w-2.5 h-2.5 rounded-full ${color}`} />
            <span className="text-[#7A7A7A]">{STATUS_LABELS[status]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
