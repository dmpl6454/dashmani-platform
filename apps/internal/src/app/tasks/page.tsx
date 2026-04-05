"use client";
import { useState } from "react";
import Link from "next/link";
import { useTasks } from "@/lib/hooks/use-tasks";
import { TaskCard } from "@/components/task-card";
import { Button, Input, Badge } from "@dashmani/ui";

const STATUS_COLUMNS = ["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"];
const STATUS_LABELS: Record<string, string> = {
  TODO: "To Do",
  IN_PROGRESS: "In Progress",
  IN_REVIEW: "In Review",
  DONE: "Done",
};

export default function TasksPage() {
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"kanban" | "list">("kanban");
  const { data, isLoading } = useTasks({ search });
  const tasks = (data as any)?.data || [];

  const priorityColor: Record<string, "danger" | "warning" | "default" | "secondary"> = {
    CRITICAL: "danger",
    HIGH: "warning",
    MEDIUM: "default",
    LOW: "secondary",
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Tasks</h2>
        <div className="flex items-center gap-2">
          <div className="flex border rounded-md">
            <button
              className={`p-2 ${view === "kanban" ? "bg-brand-blue text-white" : "text-muted-foreground"} rounded-l-md`}
              onClick={() => setView("kanban")}
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /></svg>
            </button>
            <button
              className={`p-2 ${view === "list" ? "bg-brand-blue text-white" : "text-muted-foreground"} rounded-r-md`}
              onClick={() => setView("list")}
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" /></svg>
            </button>
          </div>
          <Link href="/tasks/new">
            <Button>+ New Task</Button>
          </Link>
        </div>
      </div>

      <div className="relative max-w-sm">
        <Input placeholder="Search tasks..." value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      {isLoading ? (
        <div className="text-center text-muted-foreground py-8">Loading tasks...</div>
      ) : view === "kanban" ? (
        <div className="grid grid-cols-4 gap-4">
          {STATUS_COLUMNS.map((status) => {
            const columnTasks = tasks.filter((t: any) => t.status === status);
            return (
              <div key={status} className="bg-gray-100 rounded-lg p-3">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold">{STATUS_LABELS[status]}</h3>
                  <Badge variant="secondary">{columnTasks.length}</Badge>
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
        <div className="bg-white border rounded-lg overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50">
                <th className="text-left p-4 font-medium">Title</th>
                <th className="text-left p-4 font-medium">Status</th>
                <th className="text-left p-4 font-medium">Priority</th>
                <th className="text-left p-4 font-medium">Assignee</th>
                <th className="text-left p-4 font-medium">Due Date</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task: any) => (
                <tr key={task.id} className="border-b hover:bg-gray-50">
                  <td className="p-4">
                    <Link href={`/tasks/${task.id}`} className="text-brand-blue hover:underline font-medium">{task.title}</Link>
                  </td>
                  <td className="p-4"><Badge variant="secondary">{STATUS_LABELS[task.status] || task.status}</Badge></td>
                  <td className="p-4"><Badge variant={priorityColor[task.priority]}>{task.priority}</Badge></td>
                  <td className="p-4 text-muted-foreground">{task.assignee?.name || "Unassigned"}</td>
                  <td className="p-4 text-muted-foreground">{task.dueDate ? new Date(task.dueDate).toLocaleDateString() : "\u2014"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
