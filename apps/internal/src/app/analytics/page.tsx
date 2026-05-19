"use client";
import { useTaskAnalytics, useContentAnalytics, useAttendanceAnalytics } from "@/lib/hooks/use-analytics";
import Link from "next/link";
import { formatStatus } from "@dashmani/shared";

function ProgressBar({ value, max, color }: { value: number; max: number; color: string }) {
  const percent = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="w-full bg-[#F0E4C4] rounded-lg h-[24px]">
      <div
        className={`h-[24px] rounded-lg ${color}`}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

function StatusBar({ label, count, total, color }: { label: string; count: number; total: number; color: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-[#7A7A7A] w-28 shrink-0">{label}</span>
      <ProgressBar value={count} max={total} color={color} />
      <span className="text-sm font-medium w-10 text-right text-[#1A1A1A]">{count}</span>
    </div>
  );
}

const STATUS_COLORS: Record<string, string> = {
  TODO: "bg-[#B0B0B0]",
  IN_PROGRESS: "bg-[#F5D547]",
  IN_REVIEW: "bg-[#FAE89E]",
  DONE: "bg-[#6BCB77]",
  CANCELLED: "bg-[#E74C3C]",
  DRAFT: "bg-[#B0B0B0]",
  SCHEDULED: "bg-[#F5D547]",
  PUBLISHED: "bg-[#6BCB77]",
  FAILED: "bg-[#E74C3C]",
};

export default function AnalyticsOverviewPage() {
  const { data: taskData, isLoading: taskLoading } = useTaskAnalytics();
  const { data: contentData, isLoading: contentLoading } = useContentAnalytics();
  const { data: attendanceData, isLoading: attendanceLoading } = useAttendanceAnalytics();

  const tasks = (taskData as any)?.data;
  const content = (contentData as any)?.data;
  const attendance = (attendanceData as any)?.data;

  return (
    <div className="space-y-6 crx-animate-fade">
      <div>
        <h1 className="font-serif text-4xl font-light text-[#1A1A1A]">Analytics</h1>
        <p className="text-[#7A7A7A] mt-1">Platform-wide performance overview</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Task Distribution */}
        <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] transition-all hover:shadow-[0_4px_24px_rgba(0,0,0,0.07)] crx-animate-slide crx-delay-1">
          <div className="px-6 py-4 border-b border-[#F0EAD8] flex items-center justify-between">
            <h3 className="font-serif text-[#1A1A1A] font-medium">Task Distribution</h3>
            <Link href="/analytics/tasks" className="text-sm text-[#1A1A1A] hover:text-[#F5D547] font-medium">
              View details
            </Link>
          </div>
          <div className="p-6">
            {taskLoading ? (
              <p className="text-sm text-[#7A7A7A]">Loading...</p>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center justify-between text-sm mb-4">
                  <span className="font-medium text-[#1A1A1A]">{tasks?.totalTasks ?? 0} total tasks</span>
                  <span className="rounded-full px-3 py-1 text-xs font-medium bg-[rgba(107,203,119,0.12)] text-[#6BCB77]">{tasks?.completionRate ?? 0}% complete</span>
                </div>
                {(tasks?.byStatus ?? []).map((s: any) => (
                  <StatusBar
                    key={s.status}
                    label={formatStatus(s.status)}
                    count={s.count}
                    total={tasks?.totalTasks || 1}
                    color={STATUS_COLORS[s.status] || "bg-[#B0B0B0]"}
                  />
                ))}
                {tasks?.overdueCount > 0 && (
                  <p className="text-sm text-[#E74C3C] mt-2">
                    {tasks.overdueCount} overdue task{tasks.overdueCount > 1 ? "s" : ""}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Content Pipeline */}
        <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] transition-all hover:shadow-[0_4px_24px_rgba(0,0,0,0.07)] crx-animate-slide crx-delay-2">
          <div className="px-6 py-4 border-b border-[#F0EAD8] flex items-center justify-between">
            <h3 className="font-serif text-[#1A1A1A] font-medium">Content Pipeline</h3>
            <Link href="/analytics/content" className="text-sm text-[#1A1A1A] hover:text-[#F5D547] font-medium">
              View details
            </Link>
          </div>
          <div className="p-6">
            {contentLoading ? (
              <p className="text-sm text-[#7A7A7A]">Loading...</p>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center justify-between text-sm mb-4">
                  <span className="font-medium text-[#1A1A1A]">{content?.totalPosts ?? 0} total posts</span>
                  <span className="rounded-full px-3 py-1 text-xs font-medium bg-[rgba(52,152,219,0.12)] text-[#3498DB]">{content?.scheduledUpcoming ?? 0} scheduled</span>
                </div>
                {(content?.byStatus ?? []).map((s: any) => (
                  <StatusBar
                    key={s.status}
                    label={formatStatus(s.status)}
                    count={s.count}
                    total={content?.totalPosts || 1}
                    color={STATUS_COLORS[s.status] || "bg-[#B0B0B0]"}
                  />
                ))}
                {content?.totalPosts === 0 && (
                  <p className="text-sm text-[#7A7A7A]">No content posts yet.</p>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Attendance Summary */}
        <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] transition-all hover:shadow-[0_4px_24px_rgba(0,0,0,0.07)] crx-animate-slide crx-delay-3">
          <div className="px-6 py-4 border-b border-[#F0EAD8]">
            <h3 className="font-serif text-[#1A1A1A] font-medium">Attendance Today</h3>
          </div>
          <div className="p-6">
            {attendanceLoading ? (
              <p className="text-sm text-[#7A7A7A]">Loading...</p>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center justify-between text-sm mb-2">
                  <span className="font-medium text-[#1A1A1A]">{attendance?.totalEmployees ?? 0} employees</span>
                  <span className="rounded-full px-3 py-1 text-xs font-medium bg-[rgba(107,203,119,0.12)] text-[#6BCB77]">{attendance?.attendanceRate ?? 0}% attendance</span>
                </div>
                <StatusBar label="Present" count={attendance?.presentToday ?? 0} total={attendance?.totalEmployees || 1} color="bg-[#6BCB77]" />
                <StatusBar label="Late" count={attendance?.lateToday ?? 0} total={attendance?.totalEmployees || 1} color="bg-[#F5A623]" />
                <StatusBar label="Absent" count={attendance?.absentToday ?? 0} total={attendance?.totalEmployees || 1} color="bg-[#E74C3C]" />
                <StatusBar label="On Leave" count={attendance?.onLeaveToday ?? 0} total={attendance?.totalEmployees || 1} color="bg-[#FAE89E]" />
              </div>
            )}
          </div>
        </div>

        {/* Attendance Trend */}
        <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] transition-all hover:shadow-[0_4px_24px_rgba(0,0,0,0.07)] crx-animate-slide crx-delay-4">
          <div className="px-6 py-4 border-b border-[#F0EAD8]">
            <h3 className="font-serif text-[#1A1A1A] font-medium">Attendance Trend (7 days)</h3>
          </div>
          <div className="p-6">
            {attendanceLoading ? (
              <p className="text-sm text-[#7A7A7A]">Loading...</p>
            ) : (
              <div className="space-y-2">
                {(attendance?.dailyBreakdown ?? []).length === 0 ? (
                  <p className="text-sm text-[#7A7A7A]">No attendance records in the last 7 days.</p>
                ) : (
                  <div className="space-y-2">
                    {(attendance?.dailyBreakdown ?? []).map((day: any) => (
                      <div key={day.date} className="flex items-center gap-3">
                        <span className="text-xs text-[#7A7A7A] w-20 shrink-0">{day.date}</span>
                        <div className="flex-1 flex h-[24px] rounded-lg overflow-hidden bg-[#F0E4C4]">
                          {day.present > 0 && (
                            <div className="bg-[#6BCB77] h-full" style={{ width: `${((day.present) / (attendance?.totalEmployees || 1)) * 100}%` }} />
                          )}
                          {day.absent > 0 && (
                            <div className="bg-[#E74C3C] h-full" style={{ width: `${(day.absent / (attendance?.totalEmployees || 1)) * 100}%` }} />
                          )}
                          {day.leave > 0 && (
                            <div className="bg-[#FAE89E] h-full" style={{ width: `${(day.leave / (attendance?.totalEmployees || 1)) * 100}%` }} />
                          )}
                        </div>
                        <span className="text-xs w-8 text-right text-[#1A1A1A] font-medium">{day.present}</span>
                      </div>
                    ))}
                    <div className="flex gap-4 text-xs text-[#7A7A7A] mt-3">
                      <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-[#6BCB77] inline-block" /> Present</span>
                      <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-[#E74C3C] inline-block" /> Absent</span>
                      <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-[#FAE89E] inline-block" /> Leave</span>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
