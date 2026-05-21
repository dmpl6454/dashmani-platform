"use client";
import { useState } from "react";
import useSWR from "swr";
import { apiFetch } from "@/lib/api";
import { ListTodo, Check, MessageSquare } from "lucide-react";
import { Topstrip } from "@/components/portal-shell";

const statusDot: Record<string, string> = { TODO: "bg-attention", IN_PROGRESS: "bg-indigo", IN_REVIEW: "bg-action deep", DONE: "bg-success", CANCELLED: "bg-ink-4" };
const statusCls: Record<string, string> = { TODO: "bg-attention-bg text-attention border-attention/20", IN_PROGRESS: "bg-indigo-soft text-indigo border-indigo/20", IN_REVIEW: "bg-action-soft text-ink-2 border-ink/10", DONE: "bg-success-bg text-success border-success/20", CANCELLED: "bg-muted text-ink-3 border-ink/10" };
const priorityCls: Record<string, string> = { CRITICAL: "bg-danger-bg text-danger border-danger/20", HIGH: "bg-danger-bg text-danger border-danger/20", MEDIUM: "bg-attention-bg text-attention border-attention/20", LOW: "bg-muted text-ink-3 border-ink/10" };

export default function TasksPage() {
  const { data, mutate } = useSWR("/hr/tasks", (url) => apiFetch<any>(url), { refreshInterval: 30000 });
  const tasks = (data as any)?.data ?? [];
  const [filter, setFilter] = useState("ALL");
  const [commentForm, setCommentForm] = useState<{ taskId: string; content: string } | null>(null);
  const [sending, setSending] = useState(false);

  const filtered = filter === "ALL" ? tasks : tasks.filter((t: any) => t.status === filter);

  async function updateStatus(taskId: string, status: string) {
    try { await apiFetch(`/hr/tasks/${taskId}/status`, { method: "PUT", body: JSON.stringify({ status }) }); mutate(); }
    catch (e: any) { alert(e.message); }
  }

  async function addComment(taskId: string) {
    if (!commentForm?.content.trim()) return;
    setSending(true);
    try { await apiFetch(`/hr/tasks/${taskId}/comments`, { method: "POST", body: JSON.stringify({ content: commentForm.content }) }); setCommentForm(null); mutate(); }
    catch (e: any) { alert(e.message); }
    finally { setSending(false); }
  }

  const counts: Record<string, number> = { ALL: tasks.length };
  tasks.forEach((t: any) => { counts[t.status] = (counts[t.status] || 0) + 1; });

  return (
    <>
      <Topstrip title="My Tasks" sub={`${tasks.length} assigned`} />
      <div className="px-6 py-6 flex-1 overflow-y-auto max-w-[900px]">
        <div className="space-y-4 anim-fade-up d1">

          {/* Filters */}
          <div className="flex gap-2 flex-wrap">
            {["ALL", "TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"].map(f => (
              <button key={f} onClick={() => setFilter(f)}
                className={`h-8 px-4 rounded-full text-[12px] font-semibold border-2 transition-all ${
                  filter === f ? "bg-ink text-white border-ink" : "bg-surface text-ink-2 border-ink/12 hover:border-ink/25"
                }`}>
                {f === "ALL" ? "All" : f === "IN_PROGRESS" ? "In Progress" : f === "IN_REVIEW" ? "In Review" : f === "TODO" ? "To Do" : "Done"}
                <span className="ml-1.5 opacity-60">{counts[f] || 0}</span>
              </button>
            ))}
          </div>

          {/* Task list */}
          <div className="v3-card overflow-hidden">
            {filtered.length === 0 ? (
              <div className="px-5 py-10 text-center"><ListTodo size={24} className="mx-auto mb-3 text-ink-4" /><p className="text-[13px] text-ink-3 font-medium">No tasks here</p></div>
            ) : filtered.map((task: any, i: number) => (
              <div key={task.id} className="group" style={i < filtered.length - 1 ? { borderBottom: "1px solid rgba(26,26,26,0.06)" } : {}}>
                <div className="px-5 py-4 space-y-2 v3-row">
                  <div className="flex items-start gap-3">
                    <button onClick={() => task.status !== "DONE" && updateStatus(task.id, "DONE")}
                      className={`h-5 w-5 rounded-full border-2 shrink-0 mt-0.5 transition-all grid place-items-center ${task.status === "DONE" ? "bg-success border-success" : "border-ink/20 hover:border-success"}`}>
                      {task.status === "DONE" && <Check size={10} strokeWidth={3} className="text-white" />}
                    </button>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`text-[13.5px] font-semibold ${task.status === "DONE" ? "line-through text-ink-3" : "text-ink"}`}>{task.title}</span>
                        <span className={`h-5 px-2 rounded-full text-[10px] font-bold border inline-flex items-center ${priorityCls[task.priority] || "bg-muted text-ink-3 border-ink/10"}`}>{task.priority}</span>
                      </div>
                      {task.description && <p className="text-[12px] text-ink-3 mt-0.5">{task.description}</p>}
                      <div className="flex items-center gap-3 mt-1 text-[11px] text-ink-4 font-medium">
                        {task.dueDate && <span className={(new Date(task.dueDate) < new Date() && task.status !== "DONE") ? "text-danger font-semibold" : ""}>Due {new Date(task.dueDate).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</span>}
                        {task.account && <span>Account: {task.account.displayName || task.account.handle}</span>}
                        {task.creator && <span>By: {task.creator.name}</span>}
                      </div>
                    </div>
                    <span className={`h-5 px-2 rounded-full text-[10px] font-bold border inline-flex items-center shrink-0 ${statusCls[task.status] || ""}`}>
                      {task.status.replace("_", " ")}
                    </span>
                  </div>

                  {/* Action buttons */}
                  <div className="flex items-center gap-2 flex-wrap pl-8 opacity-0 group-hover:opacity-100 transition-opacity">
                    {task.status === "TODO" && <button onClick={() => updateStatus(task.id, "IN_PROGRESS")} className="h-7 px-3 rounded-lg bg-indigo-soft text-indigo text-[11.5px] font-semibold hover:bg-indigo hover:text-white transition-colors">Start</button>}
                    {task.status === "IN_PROGRESS" && <button onClick={() => updateStatus(task.id, "IN_REVIEW")} className="h-7 px-3 rounded-lg bg-action-soft text-ink-2 text-[11.5px] font-semibold hover:bg-action transition-colors">Submit for Review</button>}
                    {task.status !== "DONE" && task.status !== "CANCELLED" && <button onClick={() => updateStatus(task.id, "DONE")} className="h-7 px-3 rounded-lg bg-success-bg text-success text-[11.5px] font-semibold hover:bg-success hover:text-white transition-colors flex items-center gap-1"><Check size={11} strokeWidth={2.5} />Done</button>}
                    <button onClick={() => setCommentForm(commentForm?.taskId === task.id ? null : { taskId: task.id, content: "" })}
                      className="h-7 px-3 rounded-lg border-2 border-ink/10 text-ink-3 text-[11.5px] font-semibold hover:border-ink/25 hover:text-ink transition-colors flex items-center gap-1">
                      <MessageSquare size={11} /> Comment
                    </button>
                  </div>

                  {/* Comments */}
                  {task.comments?.length > 0 && (
                    <div className="pl-8 pt-2 space-y-2">
                      {task.comments.slice(-3).map((c: any) => (
                        <div key={c.id} className="v3-card-inset p-2.5">
                          <div className="flex items-center gap-2 mb-0.5">
                            <span className="text-[11.5px] font-bold text-ink">{c.author?.name ?? "Unknown"}</span>
                            <span className="text-[10px] text-ink-4">{new Date(c.createdAt).toLocaleDateString()}</span>
                          </div>
                          <p className="text-[12px] text-ink-2">{c.content}</p>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Comment form */}
                  {commentForm?.taskId === task.id && commentForm && (
                    <div className="pl-8 flex gap-2">
                      <input value={commentForm.content} onChange={e => setCommentForm({ taskId: commentForm!.taskId, content: e.target.value })}
                        placeholder="Write a comment…" onKeyDown={e => e.key === "Enter" && addComment(task.id)}
                        className="flex-1 h-9 px-3 text-[13px] font-medium rounded-xl bg-bg border-2 border-ink/10 focus:border-indigo outline-none" />
                      <button onClick={() => addComment(task.id)} disabled={sending}
                        className="btn-3d h-9 px-4 rounded-xl bg-ink text-white text-[12.5px] font-semibold border-2 border-ink disabled:opacity-50">
                        Send
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
