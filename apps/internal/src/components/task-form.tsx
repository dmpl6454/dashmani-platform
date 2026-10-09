"use client";
import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";

const LABEL = "text-[10.5px] text-ds-t3 font-semibold tracking-[.1em] uppercase";
const FIELD =
  "w-full h-[46px] px-4 rounded-[12px] border border-ds-line2 bg-ds-inset text-ds-text text-[16px] sm:text-[13.5px] outline-none focus:border-[rgba(233,189,98,.6)] placeholder:text-ds-t4 [color-scheme:dark] min-w-0";
const GHOST_BTN =
  "h-[42px] px-5 rounded-full border border-ds-line2 text-ds-t2 text-[13px] font-semibold whitespace-nowrap hover:text-ds-text hover:border-[color:var(--hx-2A4658)] disabled:opacity-60";
const GOLD_BTN =
  "inline-flex items-center gap-2 h-[42px] px-5 rounded-full bg-ds-gold text-[color:var(--hx-060D14)] text-[13px] font-bold whitespace-nowrap hover:bg-[color:var(--hx-F4D58C)] disabled:opacity-60";

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
    <section className="relative mt-[26px] rounded-[16px] border border-ds-line3 bg-ds-card shadow-[0_14px_36px_rgba(0,0,0,.32)] overflow-hidden">
      <span aria-hidden="true" className="absolute left-0 right-0 top-0 h-px opacity-60 bg-[linear-gradient(90deg,transparent,var(--hx-E9BD62)_30%,var(--hx-E9BD62)_70%,transparent)]" />
      <div className="px-6 pt-[22px] pb-[18px] border-b border-ds-line">
        <p className="text-[10px] tracking-[.2em] uppercase text-ds-gold font-semibold">Work</p>
        <h1 className="mt-2 mb-0 text-[22px] font-semibold tracking-[-.02em] text-ds-text">{isEdit ? "Edit Task" : "Create New Task"}</h1>
      </div>
      <form onSubmit={handleSubmit} className="px-6 py-[22px] flex flex-col gap-[18px] max-w-[560px]">
        {error && (
          <div role="alert" className="px-3 py-2.5 rounded-[8px] bg-[rgba(229,72,77,.08)] border border-[rgba(229,72,77,.3)] text-[color:var(--hx-FB7185)] text-[12.5px]">{error}</div>
        )}
        <div className="flex flex-col gap-[7px]">
          <label htmlFor="task-title" className={LABEL}>Title<span className="text-ds-gold ml-[3px]">*</span></label>
          <input
            id="task-title"
            type="text"
            value={form.title}
            onChange={(e) => { setForm({ ...form, title: e.target.value }); if (titleError) setTitleError(""); }}
            className={`${FIELD} ${titleError ? "!border-[rgba(251,113,133,.6)]" : ""}`}
          />
          {titleError && (
            <p role="alert" className="text-[12px] text-[color:var(--hx-FB7185)] font-semibold flex items-center gap-1">
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              {titleError}
            </p>
          )}
        </div>
        <label className="flex flex-col gap-[7px]">
          <span className={LABEL}>Description</span>
          <textarea
            className={`${FIELD} h-auto min-h-[80px] py-3.5 leading-[1.55] resize-y`}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
          <label className="flex flex-col gap-[7px]">
            <span className={LABEL}>Priority</span>
            <select
              className={`${FIELD} cursor-pointer`}
              value={form.priority}
              onChange={(e) => setForm({ ...form, priority: e.target.value })}
            >
              <option value="LOW" className="bg-ds-card">Low</option>
              <option value="MEDIUM" className="bg-ds-card">Medium</option>
              <option value="HIGH" className="bg-ds-card">High</option>
              <option value="CRITICAL" className="bg-ds-card">Critical</option>
            </select>
          </label>
          <div className="flex flex-col gap-[7px]">
            <label htmlFor="task-due" className={LABEL}>Due Date{!isEdit && <span className="text-ds-gold ml-[3px]">*</span>}</label>
            <input
              id="task-due"
              type="date"
              value={form.dueDate}
              onChange={(e) => { setForm({ ...form, dueDate: e.target.value }); if (dueDateError) setDueDateError(""); }}
              className={`${FIELD} ${dueDateError ? "!border-[rgba(251,113,133,.6)]" : ""}`}
            />
            {dueDateError && <p role="alert" className="text-[12px] text-[color:var(--hx-FB7185)] font-semibold">{dueDateError}</p>}
          </div>
        </div>
        <label className="flex flex-col gap-[7px]">
          <span className={LABEL}>Assign To</span>
          <select
            className={`${FIELD} cursor-pointer`}
            value={form.assigneeId}
            onChange={(e) => setForm({ ...form, assigneeId: e.target.value })}
          >
            <option value="" className="bg-ds-card">Unassigned</option>
            {employees.map((emp: any) => (
              <option key={emp.id} value={emp.id} className="bg-ds-card">{emp.name}</option>
            ))}
          </select>
        </label>
        <div className="flex flex-col gap-[7px]">
          <label htmlFor="task-account" className={LABEL}>Linked Account{!isEdit && <span className="text-ds-gold ml-[3px]">*</span>}</label>
          <select
            id="task-account"
            className={`${FIELD} cursor-pointer ${accountError ? "!border-[rgba(251,113,133,.6)]" : ""}`}
            value={form.accountId}
            onChange={(e) => { setForm({ ...form, accountId: e.target.value }); if (accountError) setAccountError(""); }}
          >
            <option value="" className="bg-ds-card">Select account...</option>
            {accounts.map((acc: any) => (
              <option key={acc.id} value={acc.id} className="bg-ds-card">{acc.platform?.name}: {acc.handle}</option>
            ))}
          </select>
          {accountError && <p role="alert" className="text-[12px] text-[color:var(--hx-FB7185)] font-semibold">{accountError}</p>}
        </div>
        <div className="flex gap-2.5 flex-wrap pt-1">
          <button type="submit" disabled={loading} className={GOLD_BTN}>
            {loading ? "Saving..." : isEdit ? "Update Task" : "Create Task"}
          </button>
          <button type="button" onClick={() => router.back()} className={GHOST_BTN}>Cancel</button>
        </div>
      </form>
    </section>
  );
}
