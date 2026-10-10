"use client";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { useTaskAnalytics } from "@/lib/hooks/use-analytics";
import { formatStatus } from "@dashmani/shared";

const pct = (n: number, d: number) => `${d > 0 ? Math.min(100, Math.round((n / d) * 100)) : 0}%`;
const rgba = (hex: string, a: number) => {
  if (hex.startsWith("var(")) return `color-mix(in srgb, ${hex} ${Math.round(a * 100)}%, transparent)`; const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};

function ProgressBar({ value, max, color }: { value: number; max: number; color: string }) {
  return (
    <span className="flex-1 min-w-0 h-2.5 rounded-[5px] bg-[color:var(--hx-132430)] overflow-hidden">
      <span className="block h-full rounded-[5px]" style={{ width: pct(value, max), background: color }} />
    </span>
  );
}

// Mockup palette.
const STATUS_COLORS: Record<string, string> = {
  TODO: "var(--hx-738395)",
  IN_PROGRESS: "var(--hx-E9BD62)",
  IN_REVIEW: "var(--hx-6EB2FF)",
  DONE: "var(--hx-00D7A0)",
  CANCELLED: "var(--hx-FB7185)",
};

const PRIORITY_COLORS: Record<string, string> = {
  CRITICAL: "var(--hx-FB7185)",
  HIGH: "var(--hx-FBBF24)",
  MEDIUM: "var(--hx-E9BD62)",
  LOW: "var(--hx-738395)",
};

const DONE_COLOR = "var(--hx-00D7A0)";
const REMAINING_COLOR = "var(--hx-33506A)";

function Card({ title, children, className = "" }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`flex flex-col min-w-0 rounded-[16px] border border-[color:var(--hx-2A4658)] bg-ds-card overflow-hidden shadow-[0_12px_32px_rgba(0,0,0,.35)] ${className}`}>
      <div className="flex items-center h-[60px] px-6 border-b border-ds-line">
        <span className="text-[15px] font-semibold tracking-[-.01em] text-ds-text">{title}</span>
      </div>
      <div className="p-6">{children}</div>
    </div>
  );
}

export default function TaskAnalyticsPage() {
  const { data, isLoading } = useTaskAnalytics();
  const tasks = (data as any)?.data;

  if (isLoading) {
    return (
      <div className="pb-8" aria-hidden="true">
        <div className="pt-[26px] pb-[22px] space-y-3.5">
          <div className="h-3 w-16 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
          <div className="h-9 w-56 rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[0, 1, 2, 3].map((i) => <div key={i} className="h-[128px] rounded-[16px] bg-ds-card border border-ds-line motion-safe:animate-pulse" />)}
        </div>
        <div className="mt-4 h-64 rounded-[16px] bg-ds-card border border-ds-line motion-safe:animate-pulse" />
      </div>
    );
  }

  const statCards = [
    { title: "Total Tasks", value: tasks?.totalTasks ?? 0, sub: "all time", color: "text-ds-text" },
    { title: "Completion Rate", value: `${tasks?.completionRate ?? 0}%`, sub: "overall", color: "text-ds-teal" },
    { title: "Completed This Month", value: tasks?.completedThisMonth ?? 0, sub: "current period", color: "text-ds-text" },
    { title: "Overdue", value: tasks?.overdueCount ?? 0, sub: "need attention", color: "text-[color:var(--hx-FB7185)]" },
  ];

  return (
    <div className="pb-8">
      <section className="pt-[26px]">
        <Link href="/analytics" className="inline-flex items-center gap-1.5 text-[13px] text-ds-t2 hover:text-ds-text transition-colors">
          <ArrowLeft className="h-3.5 w-3.5" /> Analytics
        </Link>
      </section>
      <section className="pt-3.5 pb-[22px]">
        <h1 className="text-[34px] font-bold tracking-[-.03em] text-ds-text leading-tight">Task Analytics</h1>
        <p className="mt-1.5 text-[13.5px] text-ds-t2">Detailed task performance breakdown</p>
      </section>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {statCards.map((card) => (
          <div key={card.title} className="min-w-0 rounded-[16px] border border-[color:var(--hx-2A4658)] bg-ds-card px-5 py-5 shadow-[0_12px_32px_rgba(0,0,0,.35)]">
            <span className="block text-[10.5px] font-semibold tracking-[.1em] uppercase text-ds-t3 truncate">{card.title}</span>
            <p className={`mt-2.5 text-[34px] font-bold tracking-[-.04em] tabular-nums leading-[1.1] ${card.color}`}>{card.value}</p>
            <p className="mt-1 text-[12px] text-ds-t3">{card.sub}</p>
          </div>
        ))}
      </section>

      <section className="mt-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title="By Status">
          <div className="flex flex-col gap-3.5">
            {(tasks?.byStatus ?? []).map((s: any) => (
              <div key={s.status} className="flex items-center gap-3.5">
                <span className="flex items-center gap-2 w-[124px] shrink-0 text-[12.5px] text-ds-t2 min-w-0">
                  <i className="h-[7px] w-[7px] rounded-[2px] shrink-0" style={{ background: STATUS_COLORS[s.status] || "var(--hx-738395)" }} />
                  <span className="truncate">{formatStatus(s.status)}</span>
                </span>
                <ProgressBar value={s.count} max={tasks?.totalTasks || 1} color={STATUS_COLORS[s.status] || "var(--hx-738395)"} />
                <span className="w-10 text-right text-[13px] font-semibold text-ds-text tabular-nums">{s.count}</span>
              </div>
            ))}
          </div>
        </Card>

        <Card title="By Priority">
          <div className="flex flex-col gap-3.5">
            {(tasks?.byPriority ?? []).map((p: any) => {
              const color = PRIORITY_COLORS[p.priority] || "var(--hx-738395)";
              return (
                <div key={p.priority} className="flex items-center gap-3.5">
                  <span
                    className="inline-flex items-center justify-center w-20 h-[26px] shrink-0 rounded-full border text-[11.5px] font-semibold"
                    style={{ background: rgba(color, 0.1), borderColor: rgba(color, 0.28), color }}
                  >
                    {formatStatus(p.priority)}
                  </span>
                  <ProgressBar value={p.count} max={tasks?.totalTasks || 1} color={color} />
                  <span className="w-10 text-right text-[13px] font-semibold text-ds-text tabular-nums">{p.count}</span>
                </div>
              );
            })}
          </div>
        </Card>

        <Card title="Top Assignees" className="lg:col-span-2">
          {(tasks?.topAssignees ?? []).length === 0 ? (
            <p className="text-[13px] text-ds-t3">No assigned tasks yet.</p>
          ) : (
            <div className="flex flex-col gap-3.5">
              {(tasks?.topAssignees ?? []).map((a: any) => (
                <div key={a.assigneeId} className="flex items-center gap-3.5">
                  <div className="flex items-center gap-2.5 w-36 shrink-0 min-w-0">
                    <span className="h-7 w-7 rounded-full grid place-items-center text-[11px] font-bold shrink-0 bg-[rgba(233,189,98,.14)] text-ds-gold">
                      {a.assigneeName?.[0]?.toUpperCase()}
                    </span>
                    <span className="text-[13px] text-ds-text truncate">{a.assigneeName}</span>
                  </div>
                  <span className="flex-1 min-w-0 flex h-2.5 rounded-[5px] overflow-hidden bg-[color:var(--hx-132430)]">
                    <span className="h-full" style={{ width: `${a.total > 0 ? (a.done / a.total) * 100 : 0}%`, background: DONE_COLOR }} />
                    <span className="h-full" style={{ width: `${a.total > 0 ? ((a.total - a.done) / a.total) * 100 : 0}%`, background: REMAINING_COLOR }} />
                  </span>
                  <span className="w-24 text-right text-[12.5px] text-ds-t2 tabular-nums whitespace-nowrap">
                    <span className="font-semibold text-ds-text">{a.done}/{a.total}</span> done
                  </span>
                </div>
              ))}
              <div className="flex gap-x-[18px] gap-y-2 flex-wrap mt-2 pt-4 border-t border-[color:var(--hx-132430)] text-[11.5px] text-ds-t2">
                <span className="flex items-center gap-[7px]"><i className="h-2 w-2 rounded-[2px]" style={{ background: DONE_COLOR }} /> Completed</span>
                <span className="flex items-center gap-[7px]"><i className="h-2 w-2 rounded-[2px]" style={{ background: REMAINING_COLOR }} /> Remaining</span>
              </div>
            </div>
          )}
        </Card>
      </section>
    </div>
  );
}
