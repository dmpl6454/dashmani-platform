"use client";
import { useState } from "react";
import Link from "next/link";
import { useTasks } from "@/lib/hooks/use-tasks";
import { TaskCard } from "@/components/task-card";
import { Button, Input } from "@dashmani/ui";

const STATUS_COLUMNS = ["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"];
const STATUS_LABELS: Record<string, string> = {
  TODO: "To Do",
  IN_PROGRESS: "In Progress",
  IN_REVIEW: "In Review",
  DONE: "Done",
};

const PRIORITY_BADGE: Record<string, string> = {
  CRITICAL: "bg-[rgba(231,76,60,0.1)] text-[#E74C3C]",
  HIGH: "bg-[rgba(245,166,35,0.12)] text-[#F5A623]",
  MEDIUM: "bg-[#FFF3C4] text-[#1A1A1A]",
  LOW: "bg-[rgba(0,0,0,0.06)] text-[#7A7A7A]",
};

export default function TasksPage() {
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"kanban" | "list">("kanban");
  const { data, isLoading } = useTasks({ search });
  const tasks = (data as any)?.data || [];

  return (
    <div className="space-y-6 crx-animate-fade">
      <div className="flex items-center justify-between">
        <h1 className="font-serif text-4xl font-light text-[#1A1A1A]">Tasks</h1>
        <div className="flex items-center gap-2">
          <div className="flex border border-[#E8E0D0] rounded-full overflow-hidden">
            <button
              className={`p-2 transition-colors ${view === "kanban" ? "bg-[#1A1A1A] text-white" : "text-[#7A7A7A] hover:bg-[rgba(255,248,225,0.5)]"}`}
              onClick={() => setView("kanban")}
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /></svg>
            </button>
            <button
              className={`p-2 transition-colors ${view === "list" ? "bg-[#1A1A1A] text-white" : "text-[#7A7A7A] hover:bg-[rgba(255,248,225,0.5)]"}`}
              onClick={() => setView("list")}
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" /></svg>
            </button>
          </div>
          <Link href="/tasks/new">
            <Button className="bg-[#1A1A1A] text-white rounded-full hover:bg-[#2B2B2B]">+ New Task</Button>
          </Link>
        </div>
      </div>

      <div className="relative max-w-sm crx-animate-slide crx-delay-1">
        <Input placeholder="Search tasks..." value={search} onChange={(e) => setSearch(e.target.value)} className="border border-[#E8E0D0] rounded-lg focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547]" />
      </div>

      {isLoading ? (
        <div className="text-center text-[#7A7A7A] py-8">Loading tasks...</div>
      ) : view === "kanban" ? (
        <div className="grid grid-cols-4 gap-4 crx-animate-slide crx-delay-2">
          {STATUS_COLUMNS.map((status) => {
            const columnTasks = tasks.filter((t: any) => t.status === status);
            return (
              <div key={status} className="bg-[rgba(255,248,225,0.5)] rounded-2xl p-3 border border-[#E8E0D0]">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-[#1A1A1A]">{STATUS_LABELS[status]}</h3>
                  <span className="rounded-full px-3 py-1 text-xs font-medium bg-[#FFF3C4] text-[#1A1A1A]">{columnTasks.length}</span>
                </div>
                <div className="space-y-2">
                  {columnTasks.map((task: any) => (
                    <TaskCard key={task.id} task={task} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="bg-white border border-[#E8E0D0] rounded-2xl overflow-x-auto shadow-[0_2px_16px_rgba(0,0,0,0.05)] crx-animate-slide crx-delay-2">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#F0EAD8]">
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Title</th>
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Status</th>
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Priority</th>
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Assignee</th>
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Due Date</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task: any) => (
                <tr key={task.id} className="border-b border-[#F0EAD8] last:border-0 hover:bg-[rgba(255,248,225,0.5)] transition-colors">
                  <td className="p-4">
                    <Link href={`/tasks/${task.id}`} className="text-[#1A1A1A] hover:text-[#F5D547] font-medium">{task.title}</Link>
                  </td>
                  <td className="p-4"><span className="rounded-full px-3 py-1 text-xs font-medium bg-[#FFF3C4] text-[#1A1A1A]">{STATUS_LABELS[task.status] || task.status}</span></td>
                  <td className="p-4"><span className={`rounded-full px-3 py-1 text-xs font-medium ${PRIORITY_BADGE[task.priority] || "bg-[rgba(0,0,0,0.06)] text-[#7A7A7A]"}`}>{task.priority}</span></td>
                  <td className="p-4 text-[#7A7A7A]">{task.assignee?.name || "Unassigned"}</td>
                  <td className="p-4 text-[#7A7A7A]">{task.dueDate ? new Date(task.dueDate).toLocaleDateString() : "\u2014"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
