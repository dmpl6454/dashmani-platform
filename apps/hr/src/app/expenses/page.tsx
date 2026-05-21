"use client";
import { useState } from "react";
import useSWR from "swr";
import { Topstrip } from "@/components/portal-shell";
import { Receipt, Plus, Clock, CheckCircle, XCircle, IndianRupee } from "lucide-react";

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

const CATEGORIES = ["TRAVEL", "FOOD", "EQUIPMENT", "SOFTWARE", "OFFICE_SUPPLIES", "COMMUNICATION", "OTHER"];

const STATUS_STYLES: Record<string, { badge: string; icon: any }> = {
  PENDING: { badge: "bg-attention-bg text-attention border-attention/20", icon: Clock },
  APPROVED: { badge: "bg-success-bg text-success border-success/20", icon: CheckCircle },
  REJECTED: { badge: "bg-danger-bg text-danger border-danger/20", icon: XCircle },
};

export default function ExpensesPage() {
  const { data, mutate } = useSWR("/hr/expenses", (url) => apiFetch<any>(url), { refreshInterval: 30000 });
  const expenses = (data as any)?.data ?? [];

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ title: "", amount: "", category: "OTHER", description: "" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!form.title || !form.amount) { setError("Title and amount are required"); return; }
    setSubmitting(true);
    try {
      await apiFetch("/hr/expenses", {
        method: "POST",
        body: JSON.stringify(form),
      });
      setForm({ title: "", amount: "", category: "OTHER", description: "" });
      setShowForm(false);
      mutate();
    } catch (e: any) { setError(e.message); }
    finally { setSubmitting(false); }
  }

  const totalPending = expenses.filter((e: any) => e.status === "PENDING").reduce((s: number, e: any) => s + e.amount, 0);
  const totalApproved = expenses.filter((e: any) => e.status === "APPROVED").reduce((s: number, e: any) => s + e.amount, 0);

  const inputClass = "w-full h-10 px-3 text-[13px] font-medium rounded-xl bg-bg border-2 border-ink/10 focus:border-indigo outline-none transition-colors";
  const textareaClass = "w-full px-3 py-2.5 text-[13px] font-medium rounded-xl bg-bg border-2 border-ink/10 focus:border-indigo outline-none transition-colors resize-none";

  return (
    <>
      <Topstrip
        title="Expense Claims"
        sub="Submit and track expense reimbursements"
        right={
          <button
            onClick={() => setShowForm(!showForm)}
            className="btn-3d inline-flex items-center gap-2 px-5 h-10 rounded-xl bg-ink text-white text-[13px] font-semibold border-2 border-ink"
          >
            <Plus className="h-4 w-4" /> New Claim
          </button>
        }
      />
      <div className="px-6 py-6 flex-1 overflow-y-auto max-w-[900px] space-y-5">

        {/* Stats */}
        <div className="grid grid-cols-3 gap-3">
          <div className="v3-card-sm text-center py-4">
            <Receipt className="h-5 w-5 mx-auto mb-1.5 text-ink-3" />
            <p className="text-xl font-display font-light text-ink">{expenses.length}</p>
            <p className="text-[11px] text-ink-4 font-medium">Total Claims</p>
          </div>
          <div className="v3-card-sm text-center py-4">
            <Clock className="h-5 w-5 mx-auto mb-1.5 text-attention" />
            <p className="text-xl font-display font-light text-ink">&#8377;{totalPending.toLocaleString("en-IN")}</p>
            <p className="text-[11px] text-ink-4 font-medium">Pending</p>
          </div>
          <div className="v3-card-sm text-center py-4">
            <CheckCircle className="h-5 w-5 mx-auto mb-1.5 text-success" />
            <p className="text-xl font-display font-light text-success">&#8377;{totalApproved.toLocaleString("en-IN")}</p>
            <p className="text-[11px] text-ink-4 font-medium">Approved</p>
          </div>
        </div>

        {/* Form */}
        {showForm && (
          <div className="v3-card">
            <div className="px-5 h-12 flex items-center" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
              <span className="text-[13px] font-semibold text-ink">New Expense Claim</span>
            </div>
            <div className="p-5 space-y-4">
              {error && <p className="text-[13px] text-danger font-medium">{error}</p>}
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-[11.5px] font-bold text-ink-3 mb-1.5 uppercase tracking-wider">Title</p>
                    <input
                      value={form.title}
                      onChange={(e) => setForm({ ...form, title: e.target.value })}
                      required
                      placeholder="e.g. Client lunch"
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <p className="text-[11.5px] font-bold text-ink-3 mb-1.5 uppercase tracking-wider">Amount (&#8377;)</p>
                    <input
                      type="number"
                      step="0.01"
                      value={form.amount}
                      onChange={(e) => setForm({ ...form, amount: e.target.value })}
                      required
                      placeholder="0.00"
                      className={inputClass}
                    />
                  </div>
                </div>
                <div>
                  <p className="text-[11.5px] font-bold text-ink-3 mb-1.5 uppercase tracking-wider">Category</p>
                  <select
                    value={form.category}
                    onChange={(e) => setForm({ ...form, category: e.target.value })}
                    className={inputClass}
                  >
                    {CATEGORIES.map((c) => <option key={c} value={c}>{c.replace("_", " ")}</option>)}
                  </select>
                </div>
                <div>
                  <p className="text-[11.5px] font-bold text-ink-3 mb-1.5 uppercase tracking-wider">Description (optional)</p>
                  <textarea
                    value={form.description}
                    onChange={(e) => setForm({ ...form, description: e.target.value })}
                    rows={2}
                    placeholder="Additional details..."
                    className={textareaClass}
                  />
                </div>
                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={submitting}
                    className="btn-3d inline-flex items-center gap-2 px-5 h-10 rounded-xl bg-ink text-white text-[13px] font-semibold border-2 border-ink disabled:opacity-50"
                  >
                    {submitting ? "Submitting..." : "Submit Claim"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* List */}
        {expenses.length === 0 ? (
          <div className="v3-card p-12 text-center">
            <IndianRupee className="h-9 w-9 mx-auto mb-3 text-ink-4" />
            <p className="text-[13px] text-ink-3 font-medium">No expense claims yet</p>
          </div>
        ) : (
          <div className="v3-card">
            <div className="px-5 h-12 flex items-center" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
              <span className="text-[13px] font-semibold text-ink">Your Claims</span>
              <span className="ml-2 h-5 w-5 rounded-full bg-muted text-ink-3 text-[11px] font-bold flex items-center justify-center">{expenses.length}</span>
            </div>
            <div className="px-5 py-3 space-y-1">
              {expenses.map((exp: any) => {
                const st = STATUS_STYLES[exp.status] || STATUS_STYLES.PENDING;
                const Icon = st.icon;
                return (
                  <div key={exp.id} className="v3-row px-4 py-3.5 rounded-xl flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-semibold text-ink">{exp.title}</p>
                      <div className="flex items-center gap-2.5 mt-0.5 text-[11px] text-ink-4 font-medium">
                        <span>{exp.category.replace("_", " ")}</span>
                        <span>{new Date(exp.createdAt).toLocaleDateString()}</span>
                      </div>
                      {exp.description && <p className="text-[12px] text-ink-3 mt-1">{exp.description}</p>}
                      {exp.reviewNotes && <p className="text-[12px] text-danger mt-1 font-medium">Note: {exp.reviewNotes}</p>}
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-[15px] font-semibold text-ink">&#8377;{exp.amount.toLocaleString("en-IN")}</p>
                      <span className={`inline-flex items-center gap-1 h-6 px-2.5 rounded-full text-[11px] font-semibold border mt-1 ${st.badge}`}>
                        <Icon className="h-3 w-3" /> {exp.status}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
