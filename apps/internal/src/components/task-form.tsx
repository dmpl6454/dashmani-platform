"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Card, CardHeader, CardTitle, CardContent } from "@dashmani/ui";
import { apiFetch } from "@/lib/api";

interface TaskFormProps {
  task?: any;
}

export function TaskForm({ task }: TaskFormProps) {
  const router = useRouter();
  const isEdit = !!task;
  const [employees, setEmployees] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [form, setForm] = useState({
    title: task?.title || "",
    description: task?.description || "",
    priority: task?.priority || "MEDIUM",
    assigneeId: task?.assignee?.id || "",
    accountId: task?.account?.id || "",
    dueDate: task?.dueDate ? task.dueDate.split("T")[0] : "",
  });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    apiFetch("/employees?limit=100").then((res: any) => setEmployees(res.data || []));
    apiFetch("/accounts?limit=100").then((res: any) => setAccounts(res.data || []));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const payload: any = {
        title: form.title,
        description: form.description || undefined,
        priority: form.priority,
        assigneeId: form.assigneeId || undefined,
        accountId: form.accountId || undefined,
        dueDate: form.dueDate || undefined,
      };
      if (isEdit) {
        await apiFetch(`/tasks/${task.id}`, { method: "PUT", body: JSON.stringify(payload) });
      } else {
        await apiFetch("/tasks", { method: "POST", body: JSON.stringify(payload) });
      }
      router.push("/tasks");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{isEdit ? "Edit Task" : "Create New Task"}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4 max-w-lg">
          {error && <p className="text-sm text-red-500">{error}</p>}
          <Input label="Title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required />
          <div className="space-y-1">
            <label className="text-sm font-medium">Description</label>
            <textarea
              className="flex w-full rounded-md border border-border bg-white px-3 py-2 text-sm min-h-[80px]"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-sm font-medium">Priority</label>
              <select
                className="flex h-10 w-full rounded-md border border-border bg-white px-3 py-2 text-sm"
                value={form.priority}
                onChange={(e) => setForm({ ...form, priority: e.target.value })}
              >
                <option value="LOW">Low</option>
                <option value="MEDIUM">Medium</option>
                <option value="HIGH">High</option>
                <option value="CRITICAL">Critical</option>
              </select>
            </div>
            <Input label="Due Date" type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Assign To</label>
            <select
              className="flex h-10 w-full rounded-md border border-border bg-white px-3 py-2 text-sm"
              value={form.assigneeId}
              onChange={(e) => setForm({ ...form, assigneeId: e.target.value })}
            >
              <option value="">Unassigned</option>
              {employees.map((emp: any) => (
                <option key={emp.id} value={emp.id}>{emp.name}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Linked Account</label>
            <select
              className="flex h-10 w-full rounded-md border border-border bg-white px-3 py-2 text-sm"
              value={form.accountId}
              onChange={(e) => setForm({ ...form, accountId: e.target.value })}
            >
              <option value="">None</option>
              {accounts.map((acc: any) => (
                <option key={acc.id} value={acc.id}>{acc.platform?.name}: {acc.handle}</option>
              ))}
            </select>
          </div>
          <div className="flex gap-3">
            <Button type="submit" disabled={loading}>
              {loading ? "Saving..." : isEdit ? "Update Task" : "Create Task"}
            </Button>
            <Button type="button" variant="outline" onClick={() => router.back()}>Cancel</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
