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
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    apiFetch("/employees?status=ACTIVE&limit=500").then((res: any) => setEmployees(res.data || []));
    apiFetch("/accounts?limit=500").then((res: any) => setAccounts(res.data || []));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!form.title.trim()) {
      setTitleError("Title is required");
      return;
    }
    setTitleError("");
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
    <Card className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0]">
      <CardHeader>
        <CardTitle className="font-serif text-[#1A1A1A]">{isEdit ? "Edit Task" : "Create New Task"}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4 max-w-lg">
          {error && <p className="text-sm text-red-500">{error}</p>}
          <div>
            <Input
              label="Title"
              value={form.title}
              onChange={(e) => { setForm({ ...form, title: e.target.value }); if (titleError) setTitleError(""); }}
              className={`border rounded-lg focus:ring-2 focus:border-[#F5D547] ${titleError ? "border-red-400 focus:ring-red-200" : "border-[#E8E0D0] focus:ring-[#F5D547]"}`}
            />
            {titleError && (
              <p role="alert" className="mt-1.5 text-xs text-red-500 font-semibold flex items-center gap-1">
                <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                {titleError}
              </p>
            )}
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium text-[#1A1A1A]">Description</label>
            <textarea
              className="flex w-full rounded-lg border border-[#E8E0D0] bg-white px-3 py-2 text-sm min-h-[80px] focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] outline-none"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-sm font-medium text-[#1A1A1A]">Priority</label>
              <select
                className="flex h-10 w-full rounded-lg border border-[#E8E0D0] bg-white px-3 py-2 text-sm focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] outline-none"
                value={form.priority}
                onChange={(e) => setForm({ ...form, priority: e.target.value })}
              >
                <option value="LOW">Low</option>
                <option value="MEDIUM">Medium</option>
                <option value="HIGH">High</option>
                <option value="CRITICAL">Critical</option>
              </select>
            </div>
            <Input label="Due Date" type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} className="border border-[#E8E0D0] rounded-lg focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547]" />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium text-[#1A1A1A]">Assign To</label>
            <select
              className="flex h-10 w-full rounded-lg border border-[#E8E0D0] bg-white px-3 py-2 text-sm focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] outline-none"
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
            <label className="text-sm font-medium text-[#1A1A1A]">Linked Account</label>
            <select
              className="flex h-10 w-full rounded-lg border border-[#E8E0D0] bg-white px-3 py-2 text-sm focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] outline-none"
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
            <Button type="submit" disabled={loading} className="bg-[#1A1A1A] text-white rounded-full hover:bg-[#2B2B2B]">
              {loading ? "Saving..." : isEdit ? "Update Task" : "Create Task"}
            </Button>
            <Button type="button" variant="outline" onClick={() => router.back()} className="border border-[#E8E0D0] rounded-full text-[#1A1A1A] hover:bg-[#FEFCF7]">Cancel</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
