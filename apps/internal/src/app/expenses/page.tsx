"use client";
import { useState } from "react";
import useSWR from "swr";
import { apiFetch } from "@/lib/api";
import { Receipt, Check, X, Clock, IndianRupee } from "lucide-react";
import { usePageTitle } from "@/lib/hooks/use-page-title";

const STATUS_STYLES: Record<string, string> = {
  PENDING: "bg-action-soft text-ink",
  APPROVED: "bg-green-50 text-green-700",
  REJECTED: "bg-red-50 text-red-600",
};

export default function ExpensesPage() {
  usePageTitle("Expense Claims");
  const [filter, setFilter] = useState("PENDING");
  const { data, mutate } = useSWR(`/admin/expenses?status=${filter}`, (url) => apiFetch<any>(url), { refreshInterval: 15000 });
  const expenses = (data as any)?.data ?? [];
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  async function handleApprove(id: string) {
    try {
      await apiFetch(`/admin/expenses/${id}/approve`, { method: "POST" });
      mutate();
    } catch (e: any) { alert(e.message); }
  }

  async function handleReject(id: string) {
    try {
      await apiFetch(`/admin/expenses/${id}/reject`, { method: "POST", body: JSON.stringify({ reason: rejectReason }) });
      setRejectId(null);
      setRejectReason("");
      mutate();
    } catch (e: any) { alert(e.message); }
  }

  const totalAmount = expenses.reduce((s: number, e: any) => s + e.amount, 0);

  return (
    <div className="space-y-6 crx-animate-fade">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-serif text-4xl font-light text-ink">Expense Claims</h1>
          <p className="text-ink-3 mt-1">Review and manage employee expense reimbursements</p>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <div className="bg-surface rounded-2xl p-5 shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-border">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm text-ink-3">Claims ({filter})</span>
            <div className="h-10 w-10 rounded-xl bg-action-soft flex items-center justify-center">
              <Receipt className="h-5 w-5 text-ink" />
            </div>
          </div>
          <p className="text-[40px] font-light font-num text-ink leading-tight">{expenses.length}</p>
        </div>
        <div className="bg-surface rounded-2xl p-5 shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-border">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm text-ink-3">Total Amount</span>
            <div className="h-10 w-10 rounded-xl bg-action-soft flex items-center justify-center">
              <IndianRupee className="h-5 w-5 text-ink" />
            </div>
          </div>
          <p className="text-[40px] font-light font-num text-ink leading-tight">{"\u20B9"}{totalAmount.toLocaleString("en-IN")}</p>
        </div>
      </div>

      {/* Filter */}
      <div className="flex flex-wrap gap-2">
        {["PENDING", "APPROVED", "REJECTED"].map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`px-5 py-2 rounded-full text-sm font-medium transition-all ${filter === s ? "bg-action text-[#06121B]" : "bg-surface border border-border text-ink-3 hover:border-[#33506A]"}`}
          >
            {s}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="bg-surface rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-border">
        {expenses.length === 0 ? (
          <div className="text-center py-12 text-ink-3">
            <Receipt className="h-12 w-12 mx-auto mb-3 opacity-30" />
            <p>No {filter.toLowerCase()} expense claims</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-3 px-5 text-ink-3 text-xs font-medium">Employee</th>
                  <th className="text-left py-3 px-3 text-ink-3 text-xs font-medium">Title</th>
                  <th className="text-left py-3 px-3 text-ink-3 text-xs font-medium">Category</th>
                  <th className="text-right py-3 px-3 text-ink-3 text-xs font-medium">Amount</th>
                  <th className="text-left py-3 px-3 text-ink-3 text-xs font-medium">Date</th>
                  <th className="text-left py-3 px-3 text-ink-3 text-xs font-medium">Status</th>
                  {filter === "PENDING" && <th className="text-right py-3 px-5 text-ink-3 text-xs font-medium">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {expenses.map((exp: any) => (
                  <tr key={exp.id} className="border-b border-border last:border-0 hover:bg-[rgba(255,248,225,0.5)] transition-colors">
                    <td className="py-3 px-5">
                      <div>
                        <p className="font-medium text-ink">{exp.employee?.name}</p>
                        <p className="text-xs text-ink-3">{exp.employee?.email}</p>
                      </div>
                    </td>
                    <td className="py-3 px-3">
                      <p className="text-ink">{exp.title}</p>
                      {exp.description && <p className="text-xs text-ink-3 truncate max-w-[200px]">{exp.description}</p>}
                    </td>
                    <td className="py-3 px-3 text-ink-3">{exp.category.replace("_", " ")}</td>
                    <td className="py-3 px-3 text-right font-semibold text-ink">{"\u20B9"}{exp.amount.toLocaleString("en-IN")}</td>
                    <td className="py-3 px-3 text-ink-3">{new Date(exp.createdAt).toLocaleDateString()}</td>
                    <td className="py-3 px-3">
                      <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${STATUS_STYLES[exp.status] || ""}`}>{exp.status}</span>
                    </td>
                    {filter === "PENDING" && (
                      <td className="py-3 px-5 text-right">
                        <div className="flex items-center gap-1.5 justify-end">
                          <button onClick={() => handleApprove(exp.id)} className="p-1.5 rounded-lg bg-green-50 text-green-700 hover:bg-green-100 transition-colors" title="Approve">
                            <Check className="h-4 w-4" />
                          </button>
                          <button onClick={() => setRejectId(exp.id)} className="p-1.5 rounded-lg bg-red-50 text-red-600 hover:bg-red-100 transition-colors" title="Reject">
                            <X className="h-4 w-4" />
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Reject Modal */}
      {rejectId && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setRejectId(null)}>
          <div className="bg-surface rounded-2xl p-6 w-96 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-serif text-lg font-medium text-ink mb-4">Reject Expense Claim</h3>
            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Reason for rejection (optional)"
              rows={3}
              className="w-full border border-border rounded-lg px-3 py-2 text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-action"
            />
            <div className="flex gap-2 justify-end">
              <button onClick={() => setRejectId(null)} className="px-4 py-2 text-sm text-ink-3">Cancel</button>
              <button onClick={() => handleReject(rejectId)} className="bg-red-600 text-white px-5 py-2 rounded-full text-sm font-semibold hover:bg-red-700">
                Reject
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
