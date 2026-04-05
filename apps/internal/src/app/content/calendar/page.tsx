"use client";
import { useState } from "react";
import Link from "next/link";
import { useContentCalendar } from "@/lib/hooks/use-content";
import { useProjects } from "@/lib/hooks/use-projects";
import { Button, Card, CardContent } from "@dashmani/ui";

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
  DRAFT: "bg-gray-400",
  PENDING_APPROVAL: "bg-yellow-400",
  APPROVED: "bg-green-400",
  SCHEDULED: "bg-blue-400",
  PUBLISHED: "bg-emerald-500",
  FAILED: "bg-red-500",
  REJECTED: "bg-red-400",
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
  const weeks: (number | null)[][] = [];
  let currentWeek: (number | null)[] = [];

  for (let i = 0; i < firstDay; i++) {
    currentWeek.push(null);
  }
  for (let day = 1; day <= daysInMonth; day++) {
    currentWeek.push(day);
    if (currentWeek.length === 7) {
      weeks.push(currentWeek);
      currentWeek = [];
    }
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
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Content Calendar</h2>
        <div className="flex items-center gap-2">
          <Link href="/content">
            <Button variant="outline">List View</Button>
          </Link>
          <Link href="/content/new">
            <Button>+ New Content</Button>
          </Link>
        </div>
      </div>

      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={prevMonth}>
            &larr;
          </Button>
          <span className="text-lg font-semibold min-w-[180px] text-center">
            {MONTH_NAMES[month - 1]} {year}
          </span>
          <Button variant="outline" size="sm" onClick={nextMonth}>
            &rarr;
          </Button>
        </div>
        <select
          className="h-10 rounded-md border border-border bg-white px-3 py-2 text-sm"
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
        <div className="text-center text-muted-foreground py-8">Loading calendar...</div>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="grid grid-cols-7 border-b">
              {DAY_NAMES.map((d) => (
                <div key={d} className="p-2 text-center text-sm font-medium text-muted-foreground border-r last:border-r-0">
                  {d}
                </div>
              ))}
            </div>
            {weeks.map((week, wi) => (
              <div key={wi} className="grid grid-cols-7 border-b last:border-b-0">
                {week.map((day, di) => {
                  const posts = day ? getPostsForDay(day) : [];
                  const isToday =
                    day === today.getDate() &&
                    month === today.getMonth() + 1 &&
                    year === today.getFullYear();
                  return (
                    <div
                      key={di}
                      className={`min-h-[100px] p-1.5 border-r last:border-r-0 ${
                        day ? "bg-white" : "bg-gray-50"
                      }`}
                    >
                      {day && (
                        <>
                          <div
                            className={`text-xs font-medium mb-1 ${
                              isToday
                                ? "bg-brand-blue text-white w-6 h-6 rounded-full flex items-center justify-center"
                                : "text-muted-foreground"
                            }`}
                          >
                            {day}
                          </div>
                          <div className="space-y-0.5">
                            {posts.slice(0, 3).map((post: any) => (
                              <Link
                                key={post.id}
                                href={`/content/${post.id}`}
                                className="block"
                              >
                                <div className="flex items-center gap-1 px-1 py-0.5 rounded text-xs hover:bg-gray-100 truncate">
                                  <span
                                    className={`w-2 h-2 rounded-full flex-shrink-0 ${
                                      STATUS_DOT_COLOR[post.status] || "bg-gray-400"
                                    }`}
                                  />
                                  <span className="truncate">{post.title}</span>
                                </div>
                              </Link>
                            ))}
                            {posts.length > 3 && (
                              <div className="text-xs text-muted-foreground px-1">
                                +{posts.length - 3} more
                              </div>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Legend */}
      <div className="flex flex-wrap gap-4 text-xs">
        {Object.entries(STATUS_DOT_COLOR).map(([status, color]) => (
          <div key={status} className="flex items-center gap-1.5">
            <span className={`w-2.5 h-2.5 rounded-full ${color}`} />
            <span className="text-muted-foreground">{STATUS_LABELS[status]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
