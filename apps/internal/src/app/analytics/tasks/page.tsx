"use client";
import { useTaskAnalytics } from "@/lib/hooks/use-analytics";

function ProgressBar({ value, max, color }: { value: number; max: number; color: string }) {
  const percent = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="w-full bg-[#F0E4C4] rounded-lg h-[24px]">
      <div className={`h-[24px] rounded-lg ${color}`} style={{ width: `${percent}%` }} />
    </div>
  );
}

const STATUS_COLORS: Record<string, string> = {
  TODO: "bg-[#B0B0B0]",
  IN_PROGRESS: "bg-[#F5D547]",
  IN_REVIEW: "bg-[#FAE89E]",
  DONE: "bg-[#6BCB77]",
  CANCELLED: "bg-[#E74C3C]",
};

const PRIORITY_COLORS: Record<string, string> = {
  CRITICAL: "bg-[#E74C3C]",
  HIGH: "bg-[#F5A623]",
  MEDIUM: "bg-[#F5D547]",
  LOW: "bg-[#B0B0B0]",
};

const PRIORITY_BADGE: Record<string, string> = {
  CRITICAL: "bg-[rgba(231,76,60,0.1)] text-[#E74C3C]",
  HIGH: "bg-[rgba(245,166,35,0.12)] text-[#F5A623]",
  MEDIUM: "bg-[#FFF3C4] text-[#1A1A1A]",
  LOW: "bg-[rgba(0,0,0,0.06)] text-[#7A7A7A]",
};

export default function TaskAnalyticsPage() {
  const { data, isLoading } = useTaskAnalytics();
  const tasks = (data as any)?.data;

  if (isLoading) {
    return <div className="flex items-center justify-center h-64"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#F5D547]" /></div>;
  }

  const statCards = [
    { title: "Total Tasks", value: tasks?.totalTasks ?? 0, sub: "all time", color: "text-[#1A1A1A]" },
    { title: "Completion Rate", value: `${tasks?.completionRate ?? 0}%`, sub: "overall", color: "text-[#6BCB77]" },
    { title: "Completed This Month", value: tasks?.completedThisMonth ?? 0, sub: "current period", color: "text-[#1A1A1A]" },
    { title: "Overdue", value: tasks?.overdueCount ?? 0, sub: "need attention", color: "text-[#E74C3C]" },
  ];

  return (
    <div className="space-y-6 crx-animate-fade">
      <div>
        <h1 className="font-serif text-4xl font-light text-[#1A1A1A]">Task Analytics</h1>
        <p className="text-[#7A7A7A] mt-1">Detailed task performance breakdown</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {statCards.map((card, i) => (
          <div
            key={card.title}
            className={`bg-white rounded-2xl p-5 shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] transition-all hover:shadow-[0_4px_24px_rgba(0,0,0,0.07)] crx-animate-slide crx-delay-${i + 1}`}
          >
            <span className="text-sm text-[#7A7A7A]">{card.title}</span>
            <p className={`text-[40px] font-light font-serif leading-tight mt-2 ${card.color}`}>{card.value}</p>
            <p className="text-xs text-[#B0B0B0] mt-1">{card.sub}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] transition-all hover:shadow-[0_4px_24px_rgba(0,0,0,0.07)] crx-animate-slide crx-delay-5">
          <div className="px-6 py-4 border-b border-[#F0EAD8]">
            <h3 className="font-serif text-[#1A1A1A] font-medium">By Status</h3>
          </div>
          <div className="p-6">
            <div className="space-y-3">
              {(tasks?.byStatus ?? []).map((s: any) => (
                <div key={s.status} className="flex items-center gap-3">
                  <span className="text-sm w-28 shrink-0 text-[#7A7A7A]">{s.status.replace("_", " ")}</span>
                  <ProgressBar value={s.count} max={tasks?.totalTasks || 1} color={STATUS_COLORS[s.status] || "bg-[#B0B0B0]"} />
                  <span className="text-sm font-medium w-10 text-right text-[#1A1A1A]">{s.count}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] transition-all hover:shadow-[0_4px_24px_rgba(0,0,0,0.07)] crx-animate-slide crx-delay-6">
          <div className="px-6 py-4 border-b border-[#F0EAD8]">
            <h3 className="font-serif text-[#1A1A1A] font-medium">By Priority</h3>
          </div>
          <div className="p-6">
            <div className="space-y-3">
              {(tasks?.byPriority ?? []).map((p: any) => (
                <div key={p.priority} className="flex items-center gap-3">
                  <span className={`rounded-full px-3 py-1 text-xs font-medium w-20 text-center ${PRIORITY_BADGE[p.priority] || "bg-[rgba(0,0,0,0.06)] text-[#7A7A7A]"}`}>
                    {p.priority}
                  </span>
                  <ProgressBar value={p.count} max={tasks?.totalTasks || 1} color={PRIORITY_COLORS[p.priority] || "bg-[#B0B0B0]"} />
                  <span className="text-sm font-medium w-10 text-right text-[#1A1A1A]">{p.count}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="lg:col-span-2 bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] transition-all hover:shadow-[0_4px_24px_rgba(0,0,0,0.07)] crx-animate-slide crx-delay-6">
          <div className="px-6 py-4 border-b border-[#F0EAD8]">
            <h3 className="font-serif text-[#1A1A1A] font-medium">Top Assignees</h3>
          </div>
          <div className="p-6">
            {(tasks?.topAssignees ?? []).length === 0 ? (
              <p className="text-sm text-[#7A7A7A]">No assigned tasks yet.</p>
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
                      <span className="text-sm truncate text-[#1A1A1A]">{a.assigneeName}</span>
                    </div>
                    <div className="flex-1 flex h-[24px] rounded-lg overflow-hidden bg-[#F0E4C4]">
                      <div className="bg-[#6BCB77] h-full" style={{ width: `${a.total > 0 ? (a.done / a.total) * 100 : 0}%` }} />
                      <div className="bg-[#FAE89E] h-full" style={{ width: `${a.total > 0 ? ((a.total - a.done) / a.total) * 100 : 0}%` }} />
                    </div>
                    <span className="text-sm w-20 text-right text-[#1A1A1A]">{a.done}/{a.total} done</span>
                  </div>
                ))}
                <div className="flex gap-4 text-xs text-[#7A7A7A] mt-2">
                  <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-[#6BCB77] inline-block" /> Completed</span>
                  <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-[#FAE89E] inline-block" /> Remaining</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
