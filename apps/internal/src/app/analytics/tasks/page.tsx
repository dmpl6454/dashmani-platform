"use client";
import { Card, CardHeader, CardTitle, CardContent, Badge } from "@dashmani/ui";
import { useTaskAnalytics } from "@/lib/hooks/use-analytics";

function ProgressBar({ value, max, color }: { value: number; max: number; color: string }) {
  const percent = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="w-full bg-gray-200 rounded-full h-3">
      <div className={`h-3 rounded-full ${color}`} style={{ width: `${percent}%` }} />
    </div>
  );
}

const STATUS_COLORS: Record<string, string> = {
  TODO: "bg-gray-400",
  IN_PROGRESS: "bg-blue-500",
  IN_REVIEW: "bg-yellow-500",
  DONE: "bg-green-500",
  CANCELLED: "bg-red-400",
};

const PRIORITY_COLORS: Record<string, string> = {
  CRITICAL: "bg-red-600",
  HIGH: "bg-orange-500",
  MEDIUM: "bg-yellow-500",
  LOW: "bg-gray-400",
};

const PRIORITY_BADGE_VARIANTS: Record<string, "default" | "secondary" | "warning" | "danger"> = {
  CRITICAL: "danger",
  HIGH: "warning",
  MEDIUM: "default",
  LOW: "secondary",
};

export default function TaskAnalyticsPage() {
  const { data, isLoading } = useTaskAnalytics();
  const tasks = (data as any)?.data;

  if (isLoading) {
    return <div className="text-center py-8 text-muted-foreground">Loading task analytics...</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Task Analytics</h2>
        <p className="text-muted-foreground">Detailed task performance breakdown</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold">{tasks?.totalTasks ?? 0}</p>
            <p className="text-sm text-muted-foreground">Total Tasks</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold text-green-600">{tasks?.completionRate ?? 0}%</p>
            <p className="text-sm text-muted-foreground">Completion Rate</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold">{tasks?.completedThisMonth ?? 0}</p>
            <p className="text-sm text-muted-foreground">Completed This Month</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <p className="text-2xl font-bold text-red-600">{tasks?.overdueCount ?? 0}</p>
            <p className="text-sm text-muted-foreground">Overdue</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader><CardTitle>By Status</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-3">
              {(tasks?.byStatus ?? []).map((s: any) => (
                <div key={s.status} className="flex items-center gap-3">
                  <span className="text-sm w-28 shrink-0">{s.status.replace("_", " ")}</span>
                  <ProgressBar value={s.count} max={tasks?.totalTasks || 1} color={STATUS_COLORS[s.status] || "bg-gray-400"} />
                  <span className="text-sm font-medium w-10 text-right">{s.count}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>By Priority</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-3">
              {(tasks?.byPriority ?? []).map((p: any) => (
                <div key={p.priority} className="flex items-center gap-3">
                  <Badge variant={PRIORITY_BADGE_VARIANTS[p.priority] || "secondary"} className="w-20 justify-center text-xs">
                    {p.priority}
                  </Badge>
                  <ProgressBar value={p.count} max={tasks?.totalTasks || 1} color={PRIORITY_COLORS[p.priority] || "bg-gray-400"} />
                  <span className="text-sm font-medium w-10 text-right">{p.count}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader><CardTitle>Top Assignees</CardTitle></CardHeader>
          <CardContent>
            {(tasks?.topAssignees ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">No assigned tasks yet.</p>
            ) : (
              <div className="space-y-3">
                {(tasks?.topAssignees ?? []).map((a: any) => (
                  <div key={a.assigneeId} className="flex items-center gap-3">
                    <span className="text-sm w-36 shrink-0 truncate">{a.assigneeName}</span>
                    <div className="flex-1 flex h-4 rounded-full overflow-hidden bg-gray-100">
                      <div className="bg-green-500 h-full" style={{ width: `${a.total > 0 ? (a.done / a.total) * 100 : 0}%` }} />
                      <div className="bg-blue-300 h-full" style={{ width: `${a.total > 0 ? ((a.total - a.done) / a.total) * 100 : 0}%` }} />
                    </div>
                    <span className="text-sm w-20 text-right">{a.done}/{a.total} done</span>
                  </div>
                ))}
                <div className="flex gap-4 text-xs text-muted-foreground mt-2">
                  <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-green-500 inline-block" /> Completed</span>
                  <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-blue-300 inline-block" /> Remaining</span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
