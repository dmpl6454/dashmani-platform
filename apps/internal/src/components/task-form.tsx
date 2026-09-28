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
  const [titleError, setTitleError] = useState("");
  const [accountError, setAccountError] = useState("");
  const [dueDateError, setDueDateError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    apiFetch("/employees?status=ACTIVE&limit=500").then((res: any) => setEmployees(res.data || []));
    apiFetch("/accounts?limit=500").then((res: any) => setAccounts(res.data || []));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    let hasError = false;
    if (!form.title.trim()) { setTitleError("Title is required"); hasError = true; } else { setTitleError(""); }
    if (!isEdit && !form.accountId) { setAccountError("Account is required"); hasError = true; } else { setAccountError(""); }
    if (!isEdit && !form.dueDate) { setDueDateError("Due date is required"); hasError = true; } else { setDueDateError(""); }
    if (hasError) return;
    setLoading(true);
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
    <Card className="bg-surface rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-border">
      <CardHeader>
        <CardTitle className="font-serif text-ink">{isEdit ? "Edit Task" : "Create New Task"}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4 max-w-lg">
          {error && <p className="text-sm text-red-500">{error}</p>}
          <div>
            <Input
              label="Title"
              value={form.title}
              onChange={(e) => { setForm({ ...form, title: e.target.value }); if (titleError) setTitleError(""); }}
              className={`border rounded-lg focus:ring-2 focus:border-action ${titleError ? "border-red-400 focus:ring-red-200" : "border-border focus:ring-action"}`}
            />
            {titleError && (
              <p role="alert" className="mt-1.5 text-xs text-red-500 font-semibold flex items-center gap-1">
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                {titleError}
              </p>
            )}
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium text-ink">Description</label>
            <textarea
              className="flex w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm min-h-[80px] focus:ring-2 focus:ring-action focus:border-action outline-none"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-sm font-medium text-ink">Priority</label>
              <select
                className="flex h-10 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm focus:ring-2 focus:ring-action focus:border-action outline-none"
                value={form.priority}
                onChange={(e) => setForm({ ...form, priority: e.target.value })}
              >
                <option value="LOW">Low</option>
                <option value="MEDIUM">Medium</option>
                <option value="HIGH">High</option>
                <option value="CRITICAL">Critical</option>
              </select>
            </div>
            <div>
              <Input label="Due Date" type="date" value={form.dueDate} onChange={(e) => { setForm({ ...form, dueDate: e.target.value }); if (dueDateError) setDueDateError(""); }} className={`border rounded-lg focus:ring-2 focus:border-action ${dueDateError ? "border-red-400 focus:ring-red-200" : "border-border focus:ring-action"}`} />
              {dueDateError && <p role="alert" className="mt-1 text-xs text-red-500 font-semibold">{dueDateError}</p>}
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium text-ink">Assign To</label>
            <select
              className="flex h-10 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm focus:ring-2 focus:ring-action focus:border-action outline-none"
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
            <label className="text-sm font-medium text-ink">Linked Account{!isEdit && <span className="text-red-500 ml-0.5">*</span>}</label>
            <select
              className={`flex h-10 w-full rounded-lg border bg-surface px-3 py-2 text-sm focus:ring-2 focus:border-action outline-none ${accountError ? "border-red-400 focus:ring-red-200" : "border-border focus:ring-action"}`}
              value={form.accountId}
              onChange={(e) => { setForm({ ...form, accountId: e.target.value }); if (accountError) setAccountError(""); }}
            >
              <option value="">Select account...</option>
              {accounts.map((acc: any) => (
                <option key={acc.id} value={acc.id}>{acc.platform?.name}: {acc.handle}</option>
              ))}
            </select>
            {accountError && <p role="alert" className="mt-1 text-xs text-red-500 font-semibold">{accountError}</p>}
          </div>
          <div className="flex gap-3">
            <Button type="submit" disabled={loading} className="bg-action text-[#06121B] rounded-full hover:bg-[#243645]">
              {loading ? "Saving..." : isEdit ? "Update Task" : "Create Task"}
            </Button>
            <Button type="button" variant="outline" onClick={() => router.back()} className="border border-border rounded-full text-ink hover:bg-surface">Cancel</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
