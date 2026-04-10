"use client";
import { useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { ArrowLeft, Receipt, Plus, IndianRupee, Clock, CheckCircle, XCircle } from "lucide-react";

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

const STATUS_STYLES: Record<string, { bg: string; icon: any }> = {
  PENDING: { bg: "bg-[#FFF3C4] text-[#1A1A1A]", icon: Clock },
  APPROVED: { bg: "bg-green-50 text-green-700", icon: CheckCircle },
  REJECTED: { bg: "bg-red-50 text-red-600", icon: XCircle },
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

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#FDF6E3] via-[#F7ECD5] to-[#EFE2C4]">
      <div className="max-w-3xl mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Link href="/dashboard" className="p-2 rounded-lg hover:bg-white/60 transition-colors">
              <ArrowLeft className="h-5 w-5 text-[#1A1A1A]" />
            </Link>
            <div>
              <h1 className="font-serif text-3xl font-light text-[#1A1A1A]">Expense Claims</h1>
              <p className="text-sm text-[#7A7A7A]">Submit and track expense reimbursements</p>
            </div>
          </div>
          <button
            onClick={() => setShowForm(!showForm)}
            className="inline-flex items-center gap-2 bg-[#F5D547] text-[#1A1A1A] rounded-full px-5 py-2.5 text-sm font-medium shadow-[0_4px_16px_rgba(245,213,71,0.35)] hover:shadow-[0_6px_24px_rgba(245,213,71,0.45)] transition-all"
          >
            <Plus className="h-4 w-4" /> New Claim
          </button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-3 mb-6">
          <div className="bg-white rounded-xl border border-[#E8E0D0] p-4 text-center">
            <Receipt className="h-5 w-5 mx-auto mb-1 text-[#7A7A7A]" />
            <p className="text-2xl font-serif font-light text-[#1A1A1A]">{expenses.length}</p>
            <p className="text-xs text-[#7A7A7A]">Total Claims</p>
          </div>
          <div className="bg-white rounded-xl border border-[#E8E0D0] p-4 text-center">
            <Clock className="h-5 w-5 mx-auto mb-1 text-[#7A7A7A]" />
            <p className="text-2xl font-serif font-light text-[#1A1A1A]">{"\u20B9"}{totalPending.toLocaleString("en-IN")}</p>
            <p className="text-xs text-[#7A7A7A]">Pending</p>
          </div>
          <div className="bg-white rounded-xl border border-[#E8E0D0] p-4 text-center">
            <CheckCircle className="h-5 w-5 mx-auto mb-1 text-green-600" />
            <p className="text-2xl font-serif font-light text-green-700">{"\u20B9"}{totalApproved.toLocaleString("en-IN")}</p>
            <p className="text-xs text-[#7A7A7A]">Approved</p>
          </div>
        </div>

        {/* Form */}
        {showForm && (
          <div className="bg-white rounded-xl border border-[#E8E0D0] p-5 mb-6">
            <h3 className="font-serif text-lg font-medium text-[#1A1A1A] mb-4">New Expense Claim</h3>
            {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
            <form onSubmit={handleSubmit} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-[#7A7A7A] mb-1 block">Title</label>
                  <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required placeholder="e.g. Client lunch" className="w-full border border-[#E8E0D0] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#F5D547]" />
                </div>
                <div>
                  <label className="text-xs font-medium text-[#7A7A7A] mb-1 block">Amount ({"\u20B9"})</label>
                  <input type="number" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required placeholder="0.00" className="w-full border border-[#E8E0D0] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#F5D547]" />
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-[#7A7A7A] mb-1 block">Category</label>
                <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className="w-full border border-[#E8E0D0] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#F5D547]">
                  {CATEGORIES.map((c) => <option key={c} value={c}>{c.replace("_", " ")}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-[#7A7A7A] mb-1 block">Description (optional)</label>
                <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} placeholder="Additional details..." className="w-full border border-[#E8E0D0] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#F5D547]" />
              </div>
              <button type="submit" disabled={submitting} className="bg-[#1A1A1A] text-white px-5 py-2.5 rounded-full text-sm font-semibold hover:bg-[#2B2B2B] disabled:opacity-50 transition-all">
                {submitting ? "Submitting..." : "Submit Claim"}
              </button>
            </form>
          </div>
        )}

        {/* List */}
        {expenses.length === 0 ? (
          <div className="text-center py-12 text-[#7A7A7A]">
            <Receipt className="h-12 w-12 mx-auto mb-3 opacity-30" />
            <p>No expense claims yet</p>
          </div>
        ) : (
          <div className="space-y-3">
            {expenses.map((exp: any) => {
              const st = STATUS_STYLES[exp.status] || STATUS_STYLES.PENDING;
              const Icon = st.icon;
              return (
                <div key={exp.id} className="bg-white rounded-xl border border-[#E8E0D0] p-4 hover:shadow-[0_2px_12px_rgba(0,0,0,0.06)] transition-all">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1">
                      <h3 className="font-medium text-[#1A1A1A]">{exp.title}</h3>
                      <div className="flex items-center gap-3 mt-1 text-xs text-[#7A7A7A]">
                        <span>{exp.category.replace("_", " ")}</span>
                        <span>{new Date(exp.createdAt).toLocaleDateString()}</span>
                      </div>
                      {exp.description && <p className="text-sm text-[#7A7A7A] mt-1">{exp.description}</p>}
                      {exp.reviewNotes && <p className="text-sm text-red-500 mt-1">Note: {exp.reviewNotes}</p>}
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-lg font-semibold text-[#1A1A1A]">{"\u20B9"}{exp.amount.toLocaleString("en-IN")}</p>
                      <span className={`inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-full font-medium ${st.bg}`}>
                        <Icon className="h-3 w-3" /> {exp.status}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
