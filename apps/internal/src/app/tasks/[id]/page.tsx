"use client";
import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { useTask } from "@/lib/hooks/use-tasks";
import { ChevronLeft } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useEmployees } from "@/lib/hooks/use-employees";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import { BoxesLoader } from "@/components/boxes-loader";

const STATUS_LABELS: Record<string, string> = {
  TODO: "To Do", IN_PROGRESS: "In Progress", IN_REVIEW: "In Review", DONE: "Done", CANCELLED: "Cancelled",
};

const STATUS_OPTIONS = ["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE", "CANCELLED"];

const STATUS_COLOR: Record<string, string> = {
  TODO: "var(--hx-A7B3C2)", IN_PROGRESS: "var(--hx-238BFF)", IN_REVIEW: "var(--hx-FBBF24)", DONE: "var(--hx-00D7A0)", CANCELLED: "var(--hx-738395)",
};
const PRIO_COLOR: Record<string, string> = {
  CRITICAL: "var(--hx-FB7185)", HIGH: "var(--hx-FBBF24)", MEDIUM: "var(--hx-6EB2FF)", LOW: "var(--hx-A7B3C2)",
};
const rgba = (hex: string, a: number) => { if (hex.startsWith("var(")) return `color-mix(in srgb, ${hex} ${Math.round(a * 100)}%, transparent)`; const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };

const CARD = "rounded-[8px] bg-ds-card border border-ds-line overflow-hidden";
const CARD_HEAD = "px-5 py-3 border-b border-ds-line bg-[color:var(--hx-0A1620)] text-[10px] tracking-[.12em] uppercase text-ds-t3 font-semibold";
const GHOST_BTN =
  "inline-flex items-center gap-1.5 h-[34px] px-3.5 rounded-[6px] border border-ds-line2 bg-ds-card text-ds-t5 text-[12px] font-semibold whitespace-nowrap transition-colors hover:border-ds-line4 hover:text-ds-text";
const META_K = "text-[10px] tracking-[.12em] uppercase text-ds-t3 font-semibold";

function Pill({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 h-[22px] px-2.5 rounded-[11px] border text-[10.5px] font-semibold whitespace-nowrap" style={{ color, background: rgba(color, 0.1), borderColor: rgba(color, 0.35) }}>
      <i className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {children}
    </span>
  );
}

export default function TaskDetailPage() {
  usePageTitle("Task Detail");
  const { id } = useParams();
  const router = useRouter();
  const { data, isLoading, mutate } = useTask(id as string);
  const [comment, setComment] = useState("");
  const [commenting, setCommenting] = useState(false);
  const [reassigning, setReassigning] = useState(false);
  const [reassignValue, setReassignValue] = useState("");
  // limit:500 so the task-reassign dropdown lists all active employees (API caps at 50 otherwise).
  const { data: employeesData } = useEmployees({ status: "ACTIVE", limit: 500 });
  const employees: any[] = (employeesData as any)?.data || [];

  if (isLoading) return <div className="flex items-center justify-center h-64"><BoxesLoader /></div>;
  const task = (data as any)?.data;
  if (!task) return <div className="mt-[26px] px-5 py-14 text-center rounded-[8px] bg-ds-card border border-dashed border-ds-line2 text-[12.5px] text-ds-t3">Task not found</div>;

  async function handleStatusChange(status: string) {
    try {
      await apiFetch(`/tasks/${id}/status`, { method: "PUT", body: JSON.stringify({ status }) });
      mutate();
    } catch (err: any) {
      alert(err.message);
    }
  }

  async function handleReassign(assigneeId: string) {
    if (!assigneeId) return;
    setReassigning(true);
    try {
      await apiFetch(`/tasks/${id}`, { method: "PUT", body: JSON.stringify({ assigneeId: assigneeId || null }) });
      mutate();
      setReassignValue("");
    } catch (err: any) {
      alert(err.message);
    } finally {
      setReassigning(false);
    }
  }

  async function handleAddComment() {
    if (!comment.trim()) return;
    setCommenting(true);
    try {
      await apiFetch(`/tasks/${id}/comments`, { method: "POST", body: JSON.stringify({ body: comment }) });
      setComment("");
      mutate();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setCommenting(false);
    }
  }

  const prioColor = PRIO_COLOR[task.priority] ?? "var(--hx-A7B3C2)";
  const stColor = STATUS_COLOR[task.status] ?? "var(--hx-A7B3C2)";

  return (
    <div className="max-w-3xl pb-6">
      {/* Header */}
      <section className="flex items-end justify-between gap-4 flex-wrap pt-[26px] pb-5">
        <div className="basis-full sm:basis-auto sm:flex-1 min-w-0">
          <button type="button" onClick={() => router.push(`/tasks`)} className="inline-flex items-center gap-1 text-[10px] tracking-[.2em] uppercase text-ds-gold font-semibold hover:text-ds-gold2">
            <ChevronLeft className="h-3 w-3" strokeWidth={2.4} /> Tasks
          </button>
          <h1 className="mt-2 mb-0 text-[28px] font-semibold tracking-[-.02em] text-ds-text [overflow-wrap:anywhere]">{task.title}</h1>
          <div className="flex gap-2 mt-3">
            <Pill color={prioColor}>{task.priority}</Pill>
            <Pill color={stColor}>{STATUS_LABELS[task.status]}</Pill>
          </div>
        </div>
        <button type="button" onClick={() => router.push(`/tasks`)} className={GHOST_BTN}>Back</button>
      </section>

      <div className="flex flex-col gap-3.5">
        <section className={CARD}>
          <div className="p-5 flex flex-col gap-5">
            {task.description && <p className="text-[13px] leading-[1.6] text-ds-t5 whitespace-pre-wrap [overflow-wrap:anywhere]">{task.description}</p>}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3.5 text-[12.5px] [&>div]:min-w-0 [&>div]:overflow-visible">
              <div className="flex flex-col gap-1">
                <span className={META_K}>Assignee</span>
                <div className="flex items-center gap-2">
                  <select
                    value={reassignValue || task.assignee?.id || ""}
                    onChange={(e) => { setReassignValue(e.target.value); handleReassign(e.target.value); }}
                    disabled={reassigning}
                    aria-label="Assignee"
                    className="h-[34px] min-w-0 max-w-full px-3 rounded-[17px] border border-ds-line2 bg-ds-inset text-ds-text text-[16px] sm:text-[12px] outline-none cursor-pointer [color-scheme:dark] focus:border-ds-gold disabled:opacity-60"
                  >
                    <option value="" className="bg-ds-card">Unassigned</option>
                    {employees.map((emp: any) => (
                      <option key={emp.id} value={emp.id} className="bg-ds-card">{emp.name}</option>
                    ))}
                  </select>
                  {reassigning && <span className="text-[11px] text-ds-t3">Saving...</span>}
                </div>
              </div>
              <div className="flex flex-col gap-1"><span className={META_K}>Created by</span> <span className="text-ds-text truncate">{task.createdBy?.name}</span></div>
              {task.account && <div className="flex flex-col gap-1"><span className={META_K}>Account</span> <span className="text-ds-text truncate">{task.account.platform?.name}: {task.account.handle}</span></div>}
              {task.dueDate && <div className="flex flex-col gap-1"><span className={META_K}>Due</span> <span className="text-ds-text">{new Date(task.dueDate).toLocaleDateString()}</span></div>}
              {task.completedAt && <div className="flex flex-col gap-1"><span className={META_K}>Completed</span> <span className="text-ds-text">{new Date(task.completedAt).toLocaleDateString()}</span></div>}
              {task.dependsOn && <div className="flex flex-col gap-1"><span className={META_K}>Depends on</span> <span className="text-ds-text truncate">{task.dependsOn.title} ({task.dependsOn.status})</span></div>}
            </div>
          </div>
        </section>

        <section className={CARD}>
          <div className={CARD_HEAD}>Update Status</div>
          <div className="p-5">
            <div className="flex flex-wrap gap-2">
              {STATUS_OPTIONS.map((s) => {
                const cur = task.status === s;
                const c = STATUS_COLOR[s];
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => handleStatusChange(s)}
                    disabled={cur}
                    aria-pressed={cur}
                    className={cur
                      ? "inline-flex items-center gap-1.5 h-[34px] px-3.5 rounded-[6px] border text-[12px] font-semibold whitespace-nowrap cursor-default"
                      : GHOST_BTN}
                    style={cur ? { color: c, background: rgba(c, 0.12), borderColor: rgba(c, 0.45) } : undefined}
                  >
                    <i className="h-1.5 w-1.5 rounded-full" style={{ background: c }} />
                    {STATUS_LABELS[s]}
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        <section className={CARD}>
          <div className={CARD_HEAD}>Comments ({task.comments?.length || 0})</div>
          <div className="p-5 flex flex-col gap-4">
            {task.comments?.map((c: any) => (
              <div key={c.id} className="border-b border-ds-grid pb-3 last:border-0">
                <div className="flex items-center gap-2 mb-1">
                  <div className="h-6 w-6 rounded-full border border-[rgba(35,139,255,.3)] bg-[rgba(35,139,255,.12)] flex items-center justify-center text-[color:var(--hx-6EB2FF)] text-[10.5px] font-bold shrink-0">
                    {c.author?.name?.[0]?.toUpperCase()}
                  </div>
                  <span className="text-[13px] font-semibold text-ds-text">{c.author?.name}</span>
                  <span className="text-[11px] text-ds-t3">{new Date(c.createdAt).toLocaleString()}</span>
                </div>
                <p className="text-[13px] leading-[1.55] text-ds-t5 ml-8 [overflow-wrap:anywhere]">{c.body}</p>
              </div>
            ))}
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="Add a comment..."
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                className="flex-1 min-w-0 h-[38px] px-4 rounded-full border border-ds-line2 bg-ds-inset text-ds-text text-[16px] sm:text-[13px] placeholder:text-ds-t4 outline-none focus:border-[rgba(233,189,98,.6)]"
              />
              <button
                type="button"
                onClick={handleAddComment}
                disabled={commenting || !comment.trim()}
                className="inline-flex items-center h-[38px] px-4 rounded-full bg-ds-gold text-[color:var(--hx-060D14)] text-[12.5px] font-bold whitespace-nowrap hover:bg-[color:var(--hx-F4D58C)] disabled:opacity-40 transition-colors"
              >
                {commenting ? "..." : "Post"}
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
