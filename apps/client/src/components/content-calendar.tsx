"use client";
import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { FormatPill, IconButton } from "@/components/portal-shared";
import { Icon } from "@/components/portal-icons";
import { useClientContentCalendar } from "@/lib/hooks/use-content";

interface CalendarPost {
  id: string;
  title: string;
  format: string;
  aspectRatio?: string | null;
  aspect?: string | null;
  status: string;
  scheduledAt?: string | null;
}

interface ContentCalendarProps {
  year: number;
  month: number;
  projectFilter?: string | null;
  onPostClick: (postId: string) => void;
  onMonthChange: (year: number, month: number) => void;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const STATUS_EDGE: Record<string, string> = {
  PENDING_APPROVAL: "border-l-attention",
  APPROVED:         "border-l-success",
  SCHEDULED:        "border-l-neutral",
  PUBLISHED:        "border-l-success",
  REJECTED:         "border-l-danger",
  REVISION_REQUESTED: "border-l-attention",
  DRAFT:            "border-l-neutral",
};

function buildMonthGrid(year: number, month: number): (Date | null)[][] {
  // month is 1-indexed
  const firstDay = new Date(year, month - 1, 1);
  const lastDay = new Date(year, month, 0);
  const startDow = firstDay.getDay(); // 0=Sun
  const totalDays = lastDay.getDate();

  const cells: (Date | null)[] = [];
  // leading nulls
  for (let i = 0; i < startDow; i++) cells.push(null);
  // actual days
  for (let d = 1; d <= totalDays; d++) cells.push(new Date(year, month - 1, d));
  // trailing nulls to fill last week
  while (cells.length % 7 !== 0) cells.push(null);

  const rows: (Date | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
  return rows;
}

function toDateKey(d: Date): string {
  return d.toISOString().split("T")[0];
}

function todayKey(): string {
  return toDateKey(new Date());
}

export function ContentCalendar({ year, month, projectFilter, onPostClick, onMonthChange }: ContentCalendarProps) {
  const router = useRouter();
  const { data, isLoading } = useClientContentCalendar(year, month, projectFilter ?? undefined);

  const postsByDay = useMemo<Record<string, CalendarPost[]>>(() => {
    return data?.days ?? {};
  }, [data]);

  const rows = useMemo(() => buildMonthGrid(year, month), [year, month]);
  const today = todayKey();

  function prevMonth() {
    if (month === 1) onMonthChange(year - 1, 12);
    else onMonthChange(year, month - 1);
  }

  function nextMonth() {
    if (month === 12) onMonthChange(year + 1, 1);
    else onMonthChange(year, month + 1);
  }

  return (
    <div className="mt-4">
      {/* Month navigation header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <IconButton size="sm" variant="default" icon={<Icon.ChevLeft size={14} />} label="Previous month" onClick={prevMonth} />
          <span className="text-[14px] font-semibold text-ink min-w-[140px] text-center">
            {MONTH_NAMES[month - 1]} {year}
          </span>
          <IconButton size="sm" variant="default" icon={<Icon.ChevRight size={14} />} label="Next month" onClick={nextMonth} />
        </div>
        <button
          onClick={() => onMonthChange(new Date().getFullYear(), new Date().getMonth() + 1)}
          className="text-[12px] text-ink-3 hover:text-ink transition-colors px-2 py-1 rounded hover:bg-muted/60"
        >
          Today
        </button>
      </div>

      {/* Calendar grid */}
      <div className="border border-border rounded-lg overflow-hidden bg-surface">
        {/* Weekday headers */}
        <div className="grid grid-cols-7 border-b border-rule bg-muted/30">
          {WEEKDAYS.map((d) => (
            <div key={d} className="px-3 py-2 text-[11px] uppercase tracking-wider font-medium text-ink-4 text-center">
              {d}
            </div>
          ))}
        </div>

        {/* Week rows */}
        <div className="divide-y divide-rule">
          {isLoading && rows.length === 0 ? (
            <div className="h-[400px] flex items-center justify-center text-[13px] text-ink-4">Loading...</div>
          ) : (
            rows.map((week, wi) => (
              <div key={wi} className="grid grid-cols-7 divide-x divide-rule">
                {week.map((day, di) => {
                  const key = day ? toDateKey(day) : null;
                  const posts: CalendarPost[] = key ? (postsByDay[key] ?? []) : [];
                  const isToday = key === today;
                  const isOutside = day === null;

                  return (
                    <div
                      key={di}
                      className={`min-h-[88px] p-2 flex flex-col gap-1 ${isOutside ? "bg-muted/20" : "bg-surface hover:bg-muted/20 transition-colors"}`}
                    >
                      {day && (
                        <div className="flex items-center justify-between mb-0.5">
                          <span
                            className={`text-[13px] font-medium leading-none h-6 w-6 flex items-center justify-center rounded-full
                              ${isToday ? "bg-action text-ink font-semibold" : "text-ink-2"}`}
                          >
                            {day.getDate()}
                          </span>
                          {posts.length > 0 && (
                            <span className="text-[10px] text-ink-4 tabular-nums">{posts.length}</span>
                          )}
                        </div>
                      )}

                      {/* Post pills — up to 3, then +N */}
                      {posts.slice(0, 3).map((post) => (
                        <button
                          key={post.id}
                          onClick={() => onPostClick(post.id)}
                          className={`w-full text-left rounded border-l-2 ${STATUS_EDGE[post.status] ?? "border-l-neutral"} bg-bg/80 border border-border/60 px-1.5 py-1 hover:bg-muted/60 transition-colors`}
                        >
                          <div className="flex items-center gap-1 min-w-0">
                            <FormatPill
                              format={post.format as any}
                              aspect={post.aspectRatio ?? post.aspect ?? null}
                              className="!h-4 !text-[9px] shrink-0"
                            />
                            <span className="text-[11px] text-ink leading-tight truncate">{post.title}</span>
                          </div>
                        </button>
                      ))}

                      {posts.length > 3 && (
                        <button
                          onClick={() => {
                            // navigate to content list filtered by that date — fallback: first post
                            if (posts[3]) onPostClick(posts[3].id);
                          }}
                          className="text-[10.5px] text-ink-3 hover:text-ink transition-colors text-left px-1"
                        >
                          +{posts.length - 3} more
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
