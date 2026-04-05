"use client";
import { Card, CardHeader, CardTitle, CardContent } from "@dashmani/ui";
import { useTaskAnalytics, useContentAnalytics, useAttendanceAnalytics } from "@/lib/hooks/use-analytics";
import Link from "next/link";

function ProgressBar({ value, max, color }: { value: number; max: number; color: string }) {
  const percent = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="w-full bg-gray-200 rounded-full h-3">
      <div
        className={`h-3 rounded-full ${color}`}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

function StatusBar({ label, count, total, color }: { label: string; count: number; total: number; color: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-muted-foreground w-28 shrink-0">{label}</span>
      <ProgressBar value={count} max={total} color={color} />
      <span className="text-sm font-medium w-10 text-right">{count}</span>
    </div>
  );
}

const STATUS_COLORS: Record<string, string> = {
  TODO: "bg-gray-400",
  IN_PROGRESS: "bg-blue-500",
  IN_REVIEW: "bg-yellow-500",
  DONE: "bg-green-500",
  CANCELLED: "bg-red-400",
  DRAFT: "bg-gray-400",
  SCHEDULED: "bg-blue-500",
  PUBLISHED: "bg-green-500",
  FAILED: "bg-red-500",
};

export default function AnalyticsOverviewPage() {
  const { data: taskData, isLoading: taskLoading } = useTaskAnalytics();
  const { data: contentData, isLoading: contentLoading } = useContentAnalytics();
  const { data: attendanceData, isLoading: attendanceLoading } = useAttendanceAnalytics();

  const tasks = (taskData as any)?.data;
  const content = (contentData as any)?.data;
  const attendance = (attendanceData as any)?.data;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Analytics</h2>
          <p className="text-muted-foreground">Platform-wide performance overview</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Task Distribution */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Task Distribution</CardTitle>
            <Link href="/analytics/tasks" className="text-sm text-blue-600 hover:underline">
              View details
            </Link>
          </CardHeader>
          <CardContent>
            {taskLoading ? (
              <p className="text-sm text-muted-foreground">Loading...</p>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center justify-between text-sm mb-4">
                  <span className="font-medium">{tasks?.totalTasks ?? 0} total tasks</span>
                  <span className="text-green-600 font-medium">{tasks?.completionRate ?? 0}% complete</span>
                </div>
                {(tasks?.byStatus ?? []).map((s: any) => (
                  <StatusBar
                    key={s.status}
                    label={s.status.replace("_", " ")}
                    count={s.count}
                    total={tasks?.totalTasks || 1}
                    color={STATUS_COLORS[s.status] || "bg-gray-400"}
                  />
                ))}
                {tasks?.overdueCount > 0 && (
                  <p className="text-sm text-red-600 mt-2">
                    {tasks.overdueCount} overdue task{tasks.overdueCount > 1 ? "s" : ""}
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Content Pipeline */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Content Pipeline</CardTitle>
            <Link href="/analytics/content" className="text-sm text-blue-600 hover:underline">
              View details
            </Link>
          </CardHeader>
          <CardContent>
            {contentLoading ? (
              <p className="text-sm text-muted-foreground">Loading...</p>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center justify-between text-sm mb-4">
                  <span className="font-medium">{content?.totalPosts ?? 0} total posts</span>
                  <span className="text-blue-600 font-medium">{content?.scheduledUpcoming ?? 0} scheduled</span>
                </div>
                {(content?.byStatus ?? []).map((s: any) => (
                  <StatusBar
                    key={s.status}
                    label={s.status}
                    count={s.count}
                    total={content?.totalPosts || 1}
                    color={STATUS_COLORS[s.status] || "bg-gray-400"}
                  />
                ))}
                {content?.totalPosts === 0 && (
                  <p className="text-sm text-muted-foreground">No content posts yet.</p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Attendance Summary */}
        <Card>
          <CardHeader>
            <CardTitle>Attendance Today</CardTitle>
          </CardHeader>
          <CardContent>
            {attendanceLoading ? (
              <p className="text-sm text-muted-foreground">Loading...</p>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center justify-between text-sm mb-2">
                  <span className="font-medium">{attendance?.totalEmployees ?? 0} employees</span>
                  <span className="text-green-600 font-medium">{attendance?.attendanceRate ?? 0}% attendance rate</span>
                </div>
                <StatusBar label="Present" count={attendance?.presentToday ?? 0} total={attendance?.totalEmployees || 1} color="bg-green-500" />
                <StatusBar label="Late" count={attendance?.lateToday ?? 0} total={attendance?.totalEmployees || 1} color="bg-yellow-500" />
                <StatusBar label="Absent" count={attendance?.absentToday ?? 0} total={attendance?.totalEmployees || 1} color="bg-red-400" />
                <StatusBar label="On Leave" count={attendance?.onLeaveToday ?? 0} total={attendance?.totalEmployees || 1} color="bg-blue-400" />
              </div>
            )}
          </CardContent>
        </Card>

        {/* Attendance Trend */}
        <Card>
          <CardHeader>
            <CardTitle>Attendance Trend (7 days)</CardTitle>
          </CardHeader>
          <CardContent>
            {attendanceLoading ? (
              <p className="text-sm text-muted-foreground">Loading...</p>
            ) : (
              <div className="space-y-2">
                {(attendance?.dailyBreakdown ?? []).length === 0 ? (
                  <p className="text-sm text-muted-foreground">No attendance records in the last 7 days.</p>
                ) : (
                  <div className="space-y-2">
                    {(attendance?.dailyBreakdown ?? []).map((day: any) => (
                      <div key={day.date} className="flex items-center gap-3">
                        <span className="text-xs text-muted-foreground w-20 shrink-0">{day.date}</span>
                        <div className="flex-1 flex h-4 rounded-full overflow-hidden bg-gray-100">
                          {day.present > 0 && (
                            <div className="bg-green-500 h-full" style={{ width: `${((day.present) / (attendance?.totalEmployees || 1)) * 100}%` }} />
                          )}
                          {day.absent > 0 && (
                            <div className="bg-red-400 h-full" style={{ width: `${(day.absent / (attendance?.totalEmployees || 1)) * 100}%` }} />
                          )}
                          {day.leave > 0 && (
                            <div className="bg-blue-400 h-full" style={{ width: `${(day.leave / (attendance?.totalEmployees || 1)) * 100}%` }} />
                          )}
                        </div>
                        <span className="text-xs w-8 text-right">{day.present}</span>
                      </div>
                    ))}
                    <div className="flex gap-4 text-xs text-muted-foreground mt-3">
                      <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-green-500 inline-block" /> Present</span>
                      <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-red-400 inline-block" /> Absent</span>
                      <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-blue-400 inline-block" /> Leave</span>
                    </div>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
