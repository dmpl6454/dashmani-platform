"use client";
import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useTask } from "@/lib/hooks/use-tasks";
import { Button, Input } from "@dashmani/ui";
import { apiFetch } from "@/lib/api";

const STATUS_LABELS: Record<string, string> = {
  TODO: "To Do", IN_PROGRESS: "In Progress", IN_REVIEW: "In Review", DONE: "Done", CANCELLED: "Cancelled",
};

const STATUS_OPTIONS = ["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE", "CANCELLED"];

const PRIORITY_BADGE: Record<string, string> = {
  CRITICAL: "bg-[rgba(231,76,60,0.1)] text-[#E74C3C]",
  HIGH: "bg-[rgba(245,166,35,0.12)] text-[#F5A623]",
  MEDIUM: "bg-[#FFF3C4] text-[#1A1A1A]",
  LOW: "bg-[rgba(0,0,0,0.06)] text-[#7A7A7A]",
};

export default function TaskDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const { data, isLoading, mutate } = useTask(id as string);
  const [comment, setComment] = useState("");
  const [commenting, setCommenting] = useState(false);

  if (isLoading) return <div className="flex items-center justify-center h-64"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#F5D547]" /></div>;
  const task = (data as any)?.data;
  if (!task) return <div className="text-[#7A7A7A] text-center py-8">Task not found</div>;

  async function handleStatusChange(status: string) {
    try {
      await apiFetch(`/tasks/${id}/status`, { method: "PUT", body: JSON.stringify({ status }) });
      mutate();
    } catch (err: any) {
      alert(err.message);
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
          <h1 className="font-serif text-4xl font-light text-[#1A1A1A]">{task.title}</h1>
          <div className="flex gap-2 mt-3">
            <span className={`rounded-full px-3 py-1 text-xs font-medium ${PRIORITY_BADGE[task.priority] || "bg-[rgba(0,0,0,0.06)] text-[#7A7A7A]"}`}>{task.priority}</span>
            <span className="rounded-full px-3 py-1 text-xs font-medium bg-[#FFF3C4] text-[#1A1A1A]">{STATUS_LABELS[task.status]}</span>
          </div>
        </div>
        <Button variant="outline" onClick={() => router.push(`/tasks`)} className="border border-[#E8E0D0] rounded-full text-[#1A1A1A] hover:bg-[rgba(255,248,225,0.5)]">Back</Button>
      </div>

      <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] crx-animate-slide crx-delay-1">
        <div className="p-6 space-y-4">
          {task.description && <p className="text-sm text-[#1A1A1A]">{task.description}</p>}
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div><span className="text-[#7A7A7A]">Assignee:</span> <span className="text-[#1A1A1A]">{task.assignee?.name || "Unassigned"}</span></div>
            <div><span className="text-[#7A7A7A]">Created by:</span> <span className="text-[#1A1A1A]">{task.createdBy?.name}</span></div>
            {task.account && <div><span className="text-[#7A7A7A]">Account:</span> <span className="text-[#1A1A1A]">{task.account.platform?.name}: {task.account.handle}</span></div>}
            {task.dueDate && <div><span className="text-[#7A7A7A]">Due:</span> <span className="text-[#1A1A1A]">{new Date(task.dueDate).toLocaleDateString()}</span></div>}
            {task.completedAt && <div><span className="text-[#7A7A7A]">Completed:</span> <span className="text-[#1A1A1A]">{new Date(task.completedAt).toLocaleDateString()}</span></div>}
            {task.dependsOn && <div><span className="text-[#7A7A7A]">Depends on:</span> <span className="text-[#1A1A1A]">{task.dependsOn.title} ({task.dependsOn.status})</span></div>}
          </div>
        </div>
      </div>

      <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] crx-animate-slide crx-delay-2">
        <div className="px-6 py-4 border-b border-[#F0EAD8]">
          <h3 className="text-base font-serif text-[#1A1A1A] font-medium">Update Status</h3>
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
                className={task.status === s ? "bg-[#1A1A1A] text-white rounded-full" : "border border-[#E8E0D0] rounded-full text-[#1A1A1A] hover:bg-[rgba(255,248,225,0.5)]"}
              >
                {STATUS_LABELS[s]}
              </Button>
            ))}
          </div>
        </div>
      </div>

      <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] crx-animate-slide crx-delay-3">
        <div className="px-6 py-4 border-b border-[#F0EAD8]">
          <h3 className="text-base font-serif text-[#1A1A1A] font-medium">Comments ({task.comments?.length || 0})</h3>
        </div>
        <div className="p-6 space-y-4">
          {task.comments?.map((c: any) => (
            <div key={c.id} className="border-b border-[#F0EAD8] pb-3 last:border-0">
              <div className="flex items-center gap-2 mb-1">
                <div
                  className="h-6 w-6 rounded-full flex items-center justify-center text-white text-xs font-semibold shrink-0"
                  style={{ background: "linear-gradient(135deg, #5B4BF5, #3023D0)" }}
                >
                  {c.author?.name?.[0]?.toUpperCase()}
                </div>
                <span className="text-sm font-medium text-[#1A1A1A]">{c.author?.name}</span>
                <span className="text-xs text-[#B0B0B0]">{new Date(c.createdAt).toLocaleString()}</span>
              </div>
              <p className="text-sm text-[#1A1A1A] ml-8">{c.body}</p>
            </div>
          ))}
          <div className="flex gap-2">
            <Input placeholder="Add a comment..." value={comment} onChange={(e) => setComment(e.target.value)} className="flex-1 border border-[#E8E0D0] rounded-lg focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547]" />
            <Button onClick={handleAddComment} disabled={commenting || !comment.trim()} className="bg-[#1A1A1A] text-white rounded-full hover:bg-[#2B2B2B]">
              {commenting ? "..." : "Post"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
