"use client";
import { useTaskAnalytics } from "@/lib/hooks/use-analytics";
import { formatStatus } from "@dashmani/shared";

function ProgressBar({ value, max, color }: { value: number; max: number; color: string }) {
  const percent = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="w-full bg-action-soft rounded-lg h-[24px]">
      <div className={`h-[24px] rounded-lg ${color}`} style={{ width: `${percent}%` }} />
    </div>
  );
}

const STATUS_COLORS: Record<string, string> = {
  TODO: "bg-ink-4",
  IN_PROGRESS: "bg-action",
  IN_REVIEW: "bg-action-soft",
  DONE: "bg-success",
  CANCELLED: "bg-danger",
};

const PRIORITY_COLORS: Record<string, string> = {
  CRITICAL: "bg-danger",
  HIGH: "bg-gold",
  MEDIUM: "bg-action",
  LOW: "bg-ink-4",
};

const PRIORITY_BADGE: Record<string, string> = {
  CRITICAL: "bg-[rgba(231,76,60,0.1)] text-danger",
  HIGH: "bg-[rgba(245,166,35,0.12)] text-gold",
  MEDIUM: "bg-action-soft text-ink",
  LOW: "bg-[rgba(0,0,0,0.06)] text-ink-3",
};

export default function TaskAnalyticsPage() {
  const { data, isLoading } = useTaskAnalytics();
  const tasks = (data as any)?.data;

  if (isLoading) {
    return <div className="flex items-center justify-center h-64"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-action" /></div>;
  }

  const statCards = [
    { title: "Total Tasks", value: tasks?.totalTasks ?? 0, sub: "all time", color: "text-ink" },
    { title: "Completion Rate", value: `${tasks?.completionRate ?? 0}%`, sub: "overall", color: "text-success" },
    { title: "Completed This Month", value: tasks?.completedThisMonth ?? 0, sub: "current period", color: "text-ink" },
    { title: "Overdue", value: tasks?.overdueCount ?? 0, sub: "need attention", color: "text-danger" },
  ];

  return (
    <div className="space-y-6 crx-animate-fade">
      <div>
        <h1 className="font-serif text-4xl font-light text-ink">Task Analytics</h1>
        <p className="text-ink-3 mt-1">Detailed task performance breakdown</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {statCards.map((card, i) => (
          <div
            key={card.title}
            className={`bg-surface rounded-2xl p-5 shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-border transition-all hover:shadow-[0_4px_24px_rgba(0,0,0,0.07)] crx-animate-slide crx-delay-${i + 1}`}
          >
            <span className="text-sm text-ink-3">{card.title}</span>
            <p className={`text-[40px] font-light font-num leading-tight mt-2 ${card.color}`}>{card.value}</p>
            <p className="text-xs text-ink-4 mt-1">{card.sub}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-surface rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-border transition-all hover:shadow-[0_4px_24px_rgba(0,0,0,0.07)] crx-animate-slide crx-delay-5">
          <div className="px-6 py-4 border-b border-border">
            <h3 className="font-serif text-ink font-medium">By Status</h3>
          </div>
          <div className="p-6">
            <div className="space-y-3">
              {(tasks?.byStatus ?? []).map((s: any) => (
                <div key={s.status} className="flex items-center gap-3">
                  <span className="text-sm w-28 shrink-0 text-ink-3">{formatStatus(s.status)}</span>
                  <ProgressBar value={s.count} max={tasks?.totalTasks || 1} color={STATUS_COLORS[s.status] || "bg-ink-4"} />
                  <span className="text-sm font-medium w-10 text-right text-ink">{s.count}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="bg-surface rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-border transition-all hover:shadow-[0_4px_24px_rgba(0,0,0,0.07)] crx-animate-slide crx-delay-6">
          <div className="px-6 py-4 border-b border-border">
            <h3 className="font-serif text-ink font-medium">By Priority</h3>
          </div>
          <div className="p-6">
            <div className="space-y-3">
              {(tasks?.byPriority ?? []).map((p: any) => (
                <div key={p.priority} className="flex items-center gap-3">
                  <span className={`rounded-full px-3 py-1 text-xs font-medium w-20 text-center ${PRIORITY_BADGE[p.priority] || "bg-[rgba(0,0,0,0.06)] text-ink-3"}`}>
                    {formatStatus(p.priority)}
                  </span>
                  <ProgressBar value={p.count} max={tasks?.totalTasks || 1} color={PRIORITY_COLORS[p.priority] || "bg-ink-4"} />
                  <span className="text-sm font-medium w-10 text-right text-ink">{p.count}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="lg:col-span-2 bg-surface rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-border transition-all hover:shadow-[0_4px_24px_rgba(0,0,0,0.07)] crx-animate-slide crx-delay-6">
          <div className="px-6 py-4 border-b border-border">
            <h3 className="font-serif text-ink font-medium">Top Assignees</h3>
          </div>
          <div className="p-6">
            {(tasks?.topAssignees ?? []).length === 0 ? (
              <p className="text-sm text-ink-3">No assigned tasks yet.</p>
            ) : (
              <div className="space-y-3">
                {(tasks?.topAssignees ?? []).map((a: any) => (
                  <div key={a.assigneeId} className="flex items-center gap-3">
                    <div className="flex items-center gap-2 w-36 shrink-0">
                      <div
                        className="h-6 w-6 rounded-full flex items-center justify-center text-white text-xs font-semibold shrink-0"
                        style={{ background: "linear-gradient(135deg, #5B4BF5, #3023D0)" }}
                      >
                        {a.assigneeName?.[0]?.toUpperCase()}
                      </div>
                      <span className="text-sm truncate text-ink">{a.assigneeName}</span>
                    </div>
                    <div className="flex-1 flex h-[24px] rounded-lg overflow-hidden bg-action-soft">
                      <div className="bg-success h-full" style={{ width: `${a.total > 0 ? (a.done / a.total) * 100 : 0}%` }} />
                      <div className="bg-action-soft h-full" style={{ width: `${a.total > 0 ? ((a.total - a.done) / a.total) * 100 : 0}%` }} />
                    </div>
                    <span className="text-sm w-20 text-right text-ink">{a.done}/{a.total} done</span>
                  </div>
                ))}
                <div className="flex gap-4 text-xs text-ink-3 mt-2">
                  <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-success inline-block" /> Completed</span>
                  <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-action-soft inline-block" /> Remaining</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
