"use client";
import { useTaskAnalytics, useContentAnalytics, useAttendanceAnalytics } from "@/lib/hooks/use-analytics";
import Link from "next/link";
import { formatStatus } from "@dashmani/shared";
import { AlertCircle } from "lucide-react";
import { usePageTitle } from "@/lib/hooks/use-page-title";

// Mockup palette.
const STATUS_COLORS: Record<string, string> = {
  TODO: "var(--hx-738395)",
  IN_PROGRESS: "var(--hx-E9BD62)",
  IN_REVIEW: "var(--hx-6EB2FF)",
  DONE: "var(--hx-00D7A0)",
  CANCELLED: "var(--hx-FB7185)",
  DRAFT: "var(--hx-738395)",
  PENDING_APPROVAL: "var(--hx-E9BD62)",
  APPROVED: "var(--hx-9B7EDE)",
  SCHEDULED: "var(--hx-6EB2FF)",
  PUBLISHED: "var(--hx-00D7A0)",
  FAILED: "var(--hx-FB7185)",
  REJECTED: "var(--hx-FB7185)",
};
const C = { present: "var(--hx-00D7A0)", late: "var(--hx-E9BD62)", absent: "var(--hx-FB7185)", leave: "var(--hx-9B7EDE)" };
// Lifecycle order (the mockup's), not the API's arbitrary groupBy order.
const TASK_ORDER = ["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE", "CANCELLED"];
const CONTENT_ORDER = ["DRAFT", "PENDING_APPROVAL", "APPROVED", "SCHEDULED", "PUBLISHED", "FAILED", "REJECTED"];
const LABELS: Record<string, string> = { TODO: "To Do" };
const ordered = (rows: any[], order: string[]) =>
  [...rows].sort((a, b) => {
    const ia = order.indexOf(a.status), ib = order.indexOf(b.status);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
const statusRows = (rows: any[], order: string[]) =>
  ordered(rows ?? [], order).map((s: any) => ({ label: LABELS[s.status] ?? formatStatus(s.status), count: s.count, color: STATUS_COLORS[s.status] || "var(--hx-738395)" }));
// Local calendar day key (IST for users in India) — never toISOString, which is UTC.
const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const rgba = (hex: string, a: number) => {
  if (hex.startsWith("var(")) return `color-mix(in srgb, ${hex} ${Math.round(a * 100)}%, transparent)`; const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};
const pct = (n: number, d: number) => `${d > 0 ? Math.min(100, (n / d) * 100) : 0}%`;

function Card({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col min-w-0 rounded-[16px] border border-[color:var(--hx-2A4658)] bg-ds-card overflow-hidden shadow-[0_12px_32px_rgba(0,0,0,.35)]">
      <div className="flex items-center justify-between gap-3 h-[60px] px-6 border-b border-ds-line">
        <span className="text-[15px] font-semibold tracking-[-.01em] text-ds-text">{title}</span>
        {right}
      </div>
      <div className="flex flex-col gap-[22px] p-6">{children}</div>
    </div>
  );
}

function Headline({ total, unit, pill, color }: { total: number | string; unit: string; pill?: string; color: string }) {
  return (
    <div className="flex items-end justify-between gap-3 flex-wrap">
      <span className="leading-[1.1]">
        <span className="block text-[34px] font-bold tracking-[-.04em] text-ds-text tabular-nums">{total}</span>
        <span className="text-[12px] text-ds-t3">{unit}</span>
      </span>
      {pill && (
        <span
          className="inline-flex items-center h-[30px] px-3 rounded-full border text-[12px] font-semibold whitespace-nowrap"
          style={{ background: rgba(color, 0.1), borderColor: rgba(color, 0.3), color }}
        >
          {pill}
        </span>
      )}
    </div>
  );
}

function Bars({ rows, total }: { rows: { label: string; count: number; color: string }[]; total: number }) {
  return (
    <div className="flex flex-col gap-3.5">
      {rows.map((r) => (
        <div key={r.label} className="grid grid-cols-[124px_minmax(0,1fr)_44px] items-center gap-3.5">
          <span className="flex items-center gap-2 text-[12.5px] text-ds-t2 min-w-0">
            <i className="h-[7px] w-[7px] rounded-[2px] shrink-0" style={{ background: r.color }} />
            <span className="truncate">{r.label}</span>
          </span>
          <span className="h-2.5 rounded-[5px] bg-[color:var(--hx-132430)] overflow-hidden">
            <span className="block h-full rounded-[5px]" style={{ width: pct(r.count, total), background: r.color }} />
          </span>
          <span className="text-right text-[13px] font-semibold text-ds-text tabular-nums">{r.count}</span>
        </div>
      ))}
    </div>
  );
}

const Muted = ({ children }: { children: React.ReactNode }) => <p className="text-[13px] text-ds-t3">{children}</p>;
const Skeleton = () => (
  <div className="flex flex-col gap-3.5" aria-hidden="true">
    <div className="h-9 w-20 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
    {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-2.5 rounded-[5px] bg-ds-hover motion-safe:animate-pulse" />)}
  </div>
);
const DetailsLink = ({ href }: { href: string }) => (
  <Link href={href} className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-ds-gold hover:text-[color:var(--hx-F4D58C)] whitespace-nowrap">
    View details →
  </Link>
);

export default function AnalyticsOverviewPage() {
  usePageTitle("Analytics");
  const { data: taskData, isLoading: taskLoading, error: taskError } = useTaskAnalytics();
  const { data: contentData, isLoading: contentLoading, error: contentError } = useContentAnalytics();
  const { data: attendanceData, isLoading: attendanceLoading, error: attendanceError } = useAttendanceAnalytics();

  const tasks = (taskData as any)?.data;
  const content = (contentData as any)?.data;
  const attendance = (attendanceData as any)?.data;
  const totalEmp = attendance?.totalEmployees || 0;
  // "Today" is the IST calendar day (the API's attendance days are IST), whatever the
  // browser's own clock or time zone says. A local Date at that calendar day lets the
  // label and the 7-day trend keys below use plain getDate()/getDay().
  const istClock = new Date(Date.now() + 330 * 60_000);
  const now = new Date(istClock.getUTCFullYear(), istClock.getUTCMonth(), istClock.getUTCDate());
  const todayLabel = `${DOW[now.getDay()].slice(0, 3)}, ${now.getDate()} ${MONTH_SHORT[now.getMonth()]}`;

  return (
    <div className="pb-8">
      <section className="pt-[30px] pb-[22px]">
        <h1 className="text-[34px] font-bold tracking-[-.03em] text-ds-text leading-tight">Analytics</h1>
        <p className="mt-1.5 text-[13.5px] text-ds-t2">Platform-wide performance overview</p>
      </section>

      <section className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr))]">
        {/* Task Distribution */}
        <Card title="Task Distribution" right={<DetailsLink href="/analytics/tasks" />}>
          {taskLoading && !taskData ? <Skeleton /> : taskError ? <Muted>Task figures couldn&apos;t be loaded just now.</Muted> : (
            <>
              <Headline total={tasks?.totalTasks ?? 0} unit="total tasks" pill={`${tasks?.completionRate ?? 0}% complete`} color="var(--hx-00D7A0)" />
              {(tasks?.byStatus ?? []).length === 0 ? <Muted>No tasks yet.</Muted> : (
                <Bars
                  total={tasks?.totalTasks || 0}
                  rows={statusRows(tasks?.byStatus, TASK_ORDER)}
                />
              )}
              {tasks?.overdueCount > 0 && (
                <div className="flex items-center gap-2 px-3.5 py-2.5 rounded-[10px] bg-[rgba(229,72,77,.08)] border border-[rgba(229,72,77,.25)] text-[color:var(--hx-FB7185)] text-[12.5px] font-semibold">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  {tasks.overdueCount} overdue task{tasks.overdueCount > 1 ? "s" : ""}
                </div>
              )}
            </>
          )}
        </Card>

        {/* Content Pipeline */}
        <Card title="Content Pipeline" right={<DetailsLink href="/analytics/content" />}>
          {contentLoading && !contentData ? <Skeleton /> : contentError ? <Muted>Content figures couldn&apos;t be loaded just now.</Muted> : (
            <>
              <Headline total={content?.totalPosts ?? 0} unit="total posts" pill={`${content?.scheduledUpcoming ?? 0} scheduled`} color="var(--hx-6EB2FF)" />
              {content?.totalPosts === 0 || (content?.byStatus ?? []).length === 0 ? <Muted>No content posts yet.</Muted> : (
                <Bars
                  total={content?.totalPosts || 0}
                  rows={statusRows(content?.byStatus, CONTENT_ORDER)}
                />
              )}
            </>
          )}
        </Card>

        {/* Attendance Today */}
        <Card title="Attendance Today" right={<span className="text-[12px] text-ds-t3">{todayLabel}</span>}>
          {attendanceLoading && !attendanceData ? <Skeleton /> : attendanceError ? <Muted>Attendance figures couldn&apos;t be loaded just now.</Muted> : (
            <>
              <Headline total={totalEmp} unit="employees" pill={`${attendance?.attendanceRate ?? 0}% attendance`} color="var(--hx-00D7A0)" />
              <Bars
                total={totalEmp}
                rows={[
                  // Same figure as before the redesign: the API's presentToday (present + late + half-day).
                  { label: "Present", count: attendance?.presentToday ?? 0, color: C.present },
                  { label: "Late", count: attendance?.lateToday ?? 0, color: C.late },
                  { label: "Absent", count: attendance?.absentToday ?? 0, color: C.absent },
                  { label: "On Leave", count: attendance?.onLeaveToday ?? 0, color: C.leave },
                ]}
              />
            </>
          )}
        </Card>

        {/* Attendance Trend */}
        <Card title="Attendance Trend" right={<span className="text-[12px] text-ds-t3">Last 7 days</span>}>
          {attendanceLoading && !attendanceData ? <Skeleton /> : attendanceError ? <Muted>Attendance figures couldn&apos;t be loaded just now.</Muted> : (
            <div className="flex flex-col gap-3 -mt-1">
              {(() => {
                // Always the full last 7 days (the API's window: today and the 6 before it).
                // A day with no records shows an empty bar and "—", never a made-up 0;
                // Sunday is the weekly off day.
                const byDay = new Map<string, any>((attendance?.dailyBreakdown ?? []).map((d: any) => [d.date, d]));
                return Array.from({ length: 7 }, (_, k) => {
                  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (6 - k));
                  return { d, key: dayKey(d), day: byDay.get(dayKey(d)) };
                });
              })().map(({ d, key, day }) => {
                const sunday = d.getDay() === 0;
                // `present` already includes late arrivals (analytics.service), so split them for the bar.
                const late = day?.late ?? 0;
                const onTime = Math.max(0, (day?.present ?? 0) - late);
                return (
                  <div key={key} className="grid grid-cols-[72px_minmax(0,1fr)_36px] items-center gap-3.5">
                    <span className="leading-[1.2]">
                      <span className="block text-[12.5px] font-semibold text-ds-t5">{d.getDate()} {MONTH_SHORT[d.getMonth()]}</span>
                      <span className="text-[10.5px] text-ds-t3">{sunday ? "Sun · off" : DOW[d.getDay()].slice(0, 3)}</span>
                    </span>
                    <span
                      className="flex h-3.5 rounded-[7px] bg-[color:var(--hx-132430)] overflow-hidden"
                      title={day ? `Present ${onTime} · Late ${late} · Absent ${day.absent ?? 0} · Leave ${day.leave ?? 0}` : "No attendance records for this day"}
                    >
                      {day && (
                        <>
                          <span style={{ width: pct(onTime, totalEmp), background: C.present }} />
                          <span style={{ width: pct(late, totalEmp), background: C.late }} />
                          <span style={{ width: pct(day.absent ?? 0, totalEmp), background: C.absent }} />
                          <span style={{ width: pct(day.leave ?? 0, totalEmp), background: C.leave }} />
                        </>
                      )}
                    </span>
                    <span className={`text-right text-[13px] font-semibold tabular-nums ${day ? "text-ds-text" : "text-[color:var(--hx-4A6275)]"}`}>{day ? day.present ?? 0 : "—"}</span>
                  </div>
                );
              })}
              <div className="flex gap-x-[18px] gap-y-2 flex-wrap mt-2 pt-4 border-t border-[color:var(--hx-132430)] text-[11.5px] text-ds-t2">
                {[["Present", C.present], ["Late", C.late], ["Absent", C.absent], ["Leave", C.leave]].map(([l, c]) => (
                  <span key={l} className="flex items-center gap-[7px]"><i className="h-2 w-2 rounded-[2px]" style={{ background: c }} />{l}</span>
                ))}
                <span className="ml-auto text-ds-t3">Count = present + late</span>
              </div>
            </div>
          )}
        </Card>
      </section>
    </div>
  );
}
