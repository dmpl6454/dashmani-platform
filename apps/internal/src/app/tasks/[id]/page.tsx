"use client";
import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { useTask } from "@/lib/hooks/use-tasks";
import { Button, Input } from "@dashmani/ui";
import { apiFetch } from "@/lib/api";
import { useEmployees } from "@/lib/hooks/use-employees";
import { usePageTitle } from "@/lib/hooks/use-page-title";

const STATUS_LABELS: Record<string, string> = {
  TODO: "To Do", IN_PROGRESS: "In Progress", IN_REVIEW: "In Review", DONE: "Done", CANCELLED: "Cancelled",
};

const STATUS_OPTIONS = ["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE", "CANCELLED"];

const PRIORITY_BADGE: Record<string, string> = {
  CRITICAL: "bg-[rgba(231,76,60,0.1)] text-danger",
  HIGH: "bg-[rgba(245,166,35,0.12)] text-gold",
  MEDIUM: "bg-action-soft text-ink",
  LOW: "bg-[rgba(0,0,0,0.06)] text-ink-3",
};

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

  if (isLoading) return <div className="flex items-center justify-center h-64"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-action" /></div>;
  const task = (data as any)?.data;
  if (!task) return <div className="text-ink-3 text-center py-8">Task not found</div>;

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

  return (
    <div className="max-w-3xl space-y-6 crx-animate-fade">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="font-serif text-4xl font-light text-ink">{task.title}</h1>
          <div className="flex gap-2 mt-3">
            <span className={`rounded-full px-3 py-1 text-xs font-medium ${PRIORITY_BADGE[task.priority] || "bg-[rgba(0,0,0,0.06)] text-ink-3"}`}>{task.priority}</span>
            <span className="rounded-full px-3 py-1 text-xs font-medium bg-action-soft text-ink">{STATUS_LABELS[task.status]}</span>
          </div>
        </div>
        <Button variant="outline" onClick={() => router.push(`/tasks`)} className="border border-border rounded-full text-ink hover:bg-action/[0.06]">Back</Button>
      </div>

      <div className="bg-surface rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-border crx-animate-slide crx-delay-1">
        <div className="p-6 space-y-4">
          {task.description && <p className="text-sm text-ink">{task.description}</p>}
          <div className="grid grid-cols-2 gap-4 text-sm [&>div]:min-w-0 [&>div]:overflow-visible">
            <div className="flex items-center gap-2">
              <span className="text-ink-3">Assignee:</span>
              <select
                value={reassignValue || task.assignee?.id || ""}
                onChange={(e) => { setReassignValue(e.target.value); handleReassign(e.target.value); }}
                disabled={reassigning}
                className="border border-border bg-surface rounded-lg px-2 py-1 text-sm text-ink outline-none focus:ring-2 focus:ring-action focus:border-action transition-colors disabled:opacity-60"
              >
                <option value="">Unassigned</option>
                {employees.map((emp: any) => (
                  <option key={emp.id} value={emp.id}>{emp.name}</option>
                ))}
              </select>
              {reassigning && <span className="text-xs text-ink-3">Saving...</span>}
            </div>
            <div><span className="text-ink-3">Created by:</span> <span className="text-ink">{task.createdBy?.name}</span></div>
            {task.account && <div><span className="text-ink-3">Account:</span> <span className="text-ink">{task.account.platform?.name}: {task.account.handle}</span></div>}
            {task.dueDate && <div><span className="text-ink-3">Due:</span> <span className="text-ink">{new Date(task.dueDate).toLocaleDateString()}</span></div>}
            {task.completedAt && <div><span className="text-ink-3">Completed:</span> <span className="text-ink">{new Date(task.completedAt).toLocaleDateString()}</span></div>}
            {task.dependsOn && <div><span className="text-ink-3">Depends on:</span> <span className="text-ink">{task.dependsOn.title} ({task.dependsOn.status})</span></div>}
          </div>
        </div>
      </div>

      <div className="bg-surface rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-border crx-animate-slide crx-delay-2">
        <div className="px-6 py-4 border-b border-border">
          <h3 className="text-base font-serif text-ink font-medium">Update Status</h3>
        </div>
        <div className="p-6">
          <div className="flex flex-wrap gap-2">
            {STATUS_OPTIONS.map((s) => (
              <Button
                key={s}
                variant={task.status === s ? "default" : "outline"}
                size="sm"
                onClick={() => handleStatusChange(s)}
                disabled={task.status === s}
                className={task.status === s ? "bg-action text-[#06121B] rounded-full" : "border border-border rounded-full text-ink hover:bg-action/[0.06]"}
              >
                {STATUS_LABELS[s]}
              </Button>
            ))}
          </div>
        </div>
      </div>

      <div className="bg-surface rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-border crx-animate-slide crx-delay-3">
        <div className="px-6 py-4 border-b border-border">
          <h3 className="text-base font-serif text-ink font-medium">Comments ({task.comments?.length || 0})</h3>
        </div>
        <div className="p-6 space-y-4">
          {task.comments?.map((c: any) => (
            <div key={c.id} className="border-b border-border pb-3 last:border-0">
              <div className="flex items-center gap-2 mb-1">
                <div
                  className="h-6 w-6 rounded-full flex items-center justify-center text-white text-xs font-semibold shrink-0"
                  style={{ background: "linear-gradient(135deg, #5B4BF5, #3023D0)" }}
                >
                  {c.author?.name?.[0]?.toUpperCase()}
                </div>
                <span className="text-sm font-medium text-ink">{c.author?.name}</span>
                <span className="text-xs text-ink-4">{new Date(c.createdAt).toLocaleString()}</span>
              </div>
              <p className="text-sm text-ink ml-8">{c.body}</p>
            </div>
          ))}
          <div className="flex gap-2">
            <Input placeholder="Add a comment..." value={comment} onChange={(e) => setComment(e.target.value)} className="flex-1 border border-border rounded-lg focus:ring-2 focus:ring-action focus:border-action" />
            <Button onClick={handleAddComment} disabled={commenting || !comment.trim()} className="bg-action text-[#06121B] rounded-full hover:opacity-90">
              {commenting ? "..." : "Post"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
