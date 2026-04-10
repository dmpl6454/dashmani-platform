"use client";
import { useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { ArrowLeft, ListTodo, Clock, CheckCircle, AlertCircle, MessageSquare } from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/v1";

async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = typeof window !== "undefined" ? localStorage.getItem("accessToken") : null;
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || "Request failed");
  return json;
}

const STATUS_STYLES: Record<string, string> = {
  TODO: "bg-gray-100 text-gray-700",
  IN_PROGRESS: "bg-blue-50 text-blue-700",
  IN_REVIEW: "bg-[#FFF3C4] text-[#1A1A1A]",
  DONE: "bg-green-50 text-green-700",
  CANCELLED: "bg-red-50 text-red-600",
};

const PRIORITY_STYLES: Record<string, string> = {
  CRITICAL: "bg-red-100 text-red-700",
  HIGH: "bg-orange-100 text-orange-700",
  MEDIUM: "bg-[#FFF3C4] text-[#1A1A1A]",
  LOW: "bg-gray-100 text-gray-600",
};

export default function TasksPage() {
  const { data, mutate } = useSWR("/hr/tasks", (url) => apiFetch<any>(url), { refreshInterval: 30000 });
  const tasks = (data as any)?.data ?? [];
  const [filter, setFilter] = useState("ALL");
  const [commentForm, setCommentForm] = useState<{ taskId: string; content: string } | null>(null);
  const [sending, setSending] = useState(false);

  const filtered = filter === "ALL" ? tasks : tasks.filter((t: any) => t.status === filter);

  async function updateStatus(taskId: string, status: string) {
    try {
      await apiFetch(`/hr/tasks/${taskId}/status`, {
        method: "PUT",
        body: JSON.stringify({ status }),
      });
      mutate();
    } catch (e: any) { alert(e.message); }
  }

  async function addComment(taskId: string) {
    if (!commentForm?.content.trim()) return;
    setSending(true);
    try {
      await apiFetch(`/hr/tasks/${taskId}/comments`, {
        method: "POST",
        body: JSON.stringify({ content: commentForm.content }),
      });
      setCommentForm(null);
      mutate();
    } catch (e: any) { alert(e.message); }
    finally { setSending(false); }
  }

  const counts = {
    all: tasks.length,
    todo: tasks.filter((t: any) => t.status === "TODO").length,
    inProgress: tasks.filter((t: any) => t.status === "IN_PROGRESS").length,
    done: tasks.filter((t: any) => t.status === "DONE").length,
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#FDF6E3] via-[#F7ECD5] to-[#EFE2C4]">
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="flex items-center gap-3 mb-6">
          <Link href="/dashboard" className="p-2 rounded-lg hover:bg-white/60 transition-colors">
            <ArrowLeft className="h-5 w-5 text-[#1A1A1A]" />
          </Link>
          <div>
            <h1 className="font-serif text-3xl font-light text-[#1A1A1A]">My Tasks</h1>
            <p className="text-sm text-[#7A7A7A]">Tasks assigned to you by admin</p>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-4 gap-3 mb-6">
          {[
            { label: "Total", value: counts.all, icon: ListTodo },
            { label: "To Do", value: counts.todo, icon: AlertCircle },
            { label: "In Progress", value: counts.inProgress, icon: Clock },
            { label: "Done", value: counts.done, icon: CheckCircle },
          ].map((s) => (
            <div key={s.label} className="bg-white rounded-xl border border-[#E8E0D0] p-4 text-center">
              <s.icon className="h-5 w-5 mx-auto mb-1 text-[#7A7A7A]" />
              <p className="text-2xl font-serif font-light text-[#1A1A1A]">{s.value}</p>
              <p className="text-xs text-[#7A7A7A]">{s.label}</p>
            </div>
          ))}
        </div>

        {/* Filter */}
        <div className="flex gap-2 mb-4 flex-wrap">
          {["ALL", "TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"].map((s) => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={`px-4 py-1.5 rounded-full text-xs font-medium transition-all ${filter === s ? "bg-[#1A1A1A] text-white" : "bg-white border border-[#E8E0D0] text-[#7A7A7A] hover:border-[#1A1A1A]"}`}
            >
              {s.replace("_", " ")}
            </button>
          ))}
        </div>

        {/* Tasks */}
        {filtered.length === 0 ? (
          <div className="text-center py-12 text-[#7A7A7A]">
            <ListTodo className="h-12 w-12 mx-auto mb-3 opacity-30" />
            <p>No tasks found</p>
          </div>
        ) : (
          <div className="space-y-3">
            {filtered.map((task: any) => (
              <div key={task.id} className="bg-white rounded-xl border border-[#E8E0D0] p-4 hover:shadow-[0_2px_12px_rgba(0,0,0,0.06)] transition-all">
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="flex-1">
                    <h3 className="font-medium text-[#1A1A1A]">{task.title}</h3>
                    {task.description && <p className="text-sm text-[#7A7A7A] mt-1">{task.description}</p>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${PRIORITY_STYLES[task.priority] || ""}`}>
                      {task.priority}
                    </span>
                    <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${STATUS_STYLES[task.status] || ""}`}>
                      {task.status.replace("_", " ")}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-4 text-xs text-[#7A7A7A] mb-3">
                  {task.dueDate && (
                    <span className={new Date(task.dueDate) < new Date() && task.status !== "DONE" ? "text-red-500 font-medium" : ""}>
                      Due: {new Date(task.dueDate).toLocaleDateString()}
                    </span>
                  )}
                  {task.account && <span>Account: {task.account.displayName}</span>}
                  {task.creator && <span>By: {task.creator.name}</span>}
                </div>

                {/* Status update buttons */}
                <div className="flex items-center gap-2 flex-wrap">
                  {task.status === "TODO" && (
                    <button onClick={() => updateStatus(task.id, "IN_PROGRESS")} className="text-xs px-3 py-1.5 rounded-full bg-blue-50 text-blue-700 hover:bg-blue-100 font-medium transition-colors">
                      Start Working
                    </button>
                  )}
                  {task.status === "IN_PROGRESS" && (
                    <button onClick={() => updateStatus(task.id, "IN_REVIEW")} className="text-xs px-3 py-1.5 rounded-full bg-[#FFF3C4] text-[#1A1A1A] hover:bg-[#F5D547] font-medium transition-colors">
                      Submit for Review
                    </button>
                  )}
                  {task.status !== "DONE" && task.status !== "CANCELLED" && (
                    <button onClick={() => updateStatus(task.id, "DONE")} className="text-xs px-3 py-1.5 rounded-full bg-green-50 text-green-700 hover:bg-green-100 font-medium transition-colors">
                      Mark Done
                    </button>
                  )}
                  <button
                    onClick={() => setCommentForm(commentForm?.taskId === task.id ? null : { taskId: task.id, content: "" })}
                    className="text-xs px-3 py-1.5 rounded-full bg-white border border-[#E8E0D0] text-[#7A7A7A] hover:bg-[#FFF8E1] font-medium transition-colors flex items-center gap-1"
                  >
                    <MessageSquare className="h-3 w-3" /> Comment
                  </button>
                </div>

                {/* Comments */}
                {task.comments?.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-[#F0EAD8] space-y-2">
                    {task.comments.slice(-3).map((c: any) => (
                      <div key={c.id} className="text-xs bg-[rgba(255,248,225,0.5)] rounded-lg p-2">
                        <span className="font-medium text-[#1A1A1A]">{c.author?.name ?? "Unknown"}</span>
                        <span className="text-[#B0B0B0] ml-2">{new Date(c.createdAt).toLocaleDateString()}</span>
                        <p className="text-[#7A7A7A] mt-0.5">{c.content}</p>
                      </div>
                    ))}
                  </div>
                )}

                {/* Comment Form */}
                {commentForm && commentForm.taskId === task.id && (
                  <div className="mt-3 flex gap-2">
                    <input
                      value={commentForm.content}
                      onChange={(e) => setCommentForm({ taskId: commentForm.taskId, content: e.target.value })}
                      placeholder="Write a comment..."
                      className="flex-1 border border-[#E8E0D0] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#F5D547]"
                      onKeyDown={(e) => e.key === "Enter" && addComment(task.id)}
                    />
                    <button
                      onClick={() => addComment(task.id)}
                      disabled={sending}
                      className="bg-[#1A1A1A] text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-[#2B2B2B] disabled:opacity-50"
                    >
                      Send
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
