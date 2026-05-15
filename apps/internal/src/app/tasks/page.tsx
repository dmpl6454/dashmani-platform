"use client";
import { useState } from "react";
import Link from "next/link";
import { useTasks } from "@/lib/hooks/use-tasks";
import { TaskCard } from "@/components/task-card";
import { Plus, Search, LayoutGrid, List } from "lucide-react";

const STATUS_COLUMNS = ["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"];
const STATUS_LABELS: Record<string, string> = {
  TODO:        "To Do",
  IN_PROGRESS: "In Progress",
  IN_REVIEW:   "In Review",
  DONE:        "Done",
};
const STATUS_BADGE: Record<string, string> = {
  TODO:        "bg-neutral-bg text-neutral",
  IN_PROGRESS: "bg-indigo-soft text-indigo",
  IN_REVIEW:   "bg-attention-bg text-attention",
  DONE:        "bg-success-bg text-success",
};
const PRIORITY_BADGE: Record<string, string> = {
  CRITICAL: "bg-danger-bg text-danger border-danger/20",
  HIGH:     "bg-attention-bg text-attention border-attention/20",
  MEDIUM:   "bg-action-soft text-ink border-ink/15",
  LOW:      "bg-neutral-bg text-neutral border-neutral/20",
};
const COLUMN_ACCENT: Record<string, string> = {
  TODO:        "border-t-ink-4",
  IN_PROGRESS: "border-t-indigo",
  IN_REVIEW:   "border-t-attention",
  DONE:        "border-t-success",
};

export default function TasksPage() {
  const [search, setSearch] = useState("");
  const [view,   setView]   = useState<"kanban" | "list">("kanban");
  const { data, isLoading } = useTasks({ search });
  const tasks = (data as any)?.data || [];

  return (
    <div className="space-y-5 pop-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-3xl font-semibold text-ink">Tasks</h1>
          {!isLoading && <p className="text-sm text-ink-4 mt-0.5">{tasks.length} task{tasks.length !== 1 ? "s" : ""}</p>}
        </div>
        <div className="flex items-center gap-2">
          {/* View toggle */}
          <div className="flex border-2 border-ink/12 rounded-xl overflow-hidden">
            <button
              className={`p-2 transition-colors ${view === "kanban" ? "bg-ink text-white" : "text-ink-4 hover:bg-muted"}`}
              onClick={() => setView("kanban")}
              title="Kanban"
            >
              <LayoutGrid className="h-4 w-4" />
            </button>
            <button
              className={`p-2 transition-colors ${view === "list" ? "bg-ink text-white" : "text-ink-4 hover:bg-muted"}`}
              onClick={() => setView("list")}
              title="List"
            >
              <List className="h-4 w-4" />
            </button>
          </div>
          <Link href="/tasks/new">
            <button className="h-9 px-4 rounded-full bg-ink text-white text-sm font-bold btn-3d hover:bg-ink-2 transition-colors flex items-center gap-1.5">
              <Plus className="h-4 w-4" /> New Task
            </button>
          </Link>
        </div>
      </div>

      {/* Search */}
      <div className="relative max-w-sm fade-up d2">
        <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-4" />
        <input
          placeholder="Search tasks…"
          className="w-full pl-10 pr-4 h-10 bg-surface border-2 border-ink/15 rounded-xl text-sm text-ink placeholder:text-ink-4 focus:outline-none focus:border-indigo transition-colors"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {isLoading ? (
        <div className="py-14 flex items-center justify-center">
          <div className="h-6 w-6 rounded-full border-[3px] border-ink/10 border-t-indigo" style={{ animation: "spin 0.7s linear infinite" }} />
        </div>
      ) : view === "kanban" ? (
        /* ── Kanban ── */
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 fade-up d3">
          {STATUS_COLUMNS.map((status) => {
            const columnTasks = tasks.filter((t: any) => t.status === status);
            return (
              <div key={status} className={`v3-card-sm p-3 border-t-4 ${COLUMN_ACCENT[status]}`}>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-xs font-bold text-ink uppercase tracking-wider">{STATUS_LABELS[status]}</h3>
                  <span className="text-xs font-bold text-ink-4 bg-muted px-2 py-0.5 rounded-full">{columnTasks.length}</span>
                </div>
                <div className="space-y-2">
                  {columnTasks.map((task: any) => (
                    <TaskCard key={task.id} task={task} />
                  ))}
                  {columnTasks.length === 0 && (
                    <p className="text-xs text-ink-4 text-center py-4 italic">No tasks</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        /* ── List ── */
        <div className="v3-card overflow-hidden fade-up d3">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b-2 border-ink/8 bg-muted/40">
                  <th className="text-left px-5 py-3 text-[10px] font-bold text-ink-4 uppercase tracking-wider">Title</th>
                  <th className="text-left px-5 py-3 text-[10px] font-bold text-ink-4 uppercase tracking-wider">Status</th>
                  <th className="text-left px-5 py-3 text-[10px] font-bold text-ink-4 uppercase tracking-wider">Priority</th>
                  <th className="text-left px-5 py-3 text-[10px] font-bold text-ink-4 uppercase tracking-wider hidden md:table-cell">Assignee</th>
                  <th className="text-left px-5 py-3 text-[10px] font-bold text-ink-4 uppercase tracking-wider hidden lg:table-cell">Due</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {tasks.length === 0 ? (
                  <tr><td colSpan={5} className="py-14 text-center text-ink-4 text-sm">No tasks found</td></tr>
                ) : tasks.map((task: any, i: number) => (
                  <tr key={task.id} className="v3-row" style={{ animationDelay: `${i * 0.02}s` }}>
                    <td className="px-5 py-3">
                      <Link href={`/tasks/${task.id}`} className="font-semibold text-ink hover:text-indigo transition-colors">
                        {task.title}
                      </Link>
                    </td>
                    <td className="px-5 py-3">
                      <span className={`rounded-full px-3 py-1 text-xs font-semibold ${STATUS_BADGE[task.status] || "bg-neutral-bg text-neutral"}`}>
                        {STATUS_LABELS[task.status] || task.status}
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      <span className={`rounded-full px-3 py-1 text-xs font-semibold border ${PRIORITY_BADGE[task.priority] || "bg-neutral-bg text-neutral border-neutral/20"}`}>
                        {task.priority}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-ink-3 hidden md:table-cell">{task.assignee?.name || "Unassigned"}</td>
                    <td className="px-5 py-3 text-ink-3 hidden lg:table-cell">
                      {task.dueDate ? new Date(task.dueDate).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
