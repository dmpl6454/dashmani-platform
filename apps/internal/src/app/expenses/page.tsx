"use client";
import { useState } from "react";
import useSWR from "swr";
import { apiFetch } from "@/lib/api";
import { Receipt, Check, X, Clock, IndianRupee } from "lucide-react";

const STATUS_STYLES: Record<string, string> = {
  PENDING: "bg-[#FFF3C4] text-[#1A1A1A]",
  APPROVED: "bg-green-50 text-green-700",
  REJECTED: "bg-red-50 text-red-600",
};

export default function ExpensesPage() {
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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-serif text-4xl font-light text-[#1A1A1A]">Expense Claims</h1>
          <p className="text-[#7A7A7A] mt-1">Review and manage employee expense reimbursements</p>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <div className="bg-white rounded-2xl p-5 shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0]">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm text-[#7A7A7A]">Claims ({filter})</span>
            <div className="h-10 w-10 rounded-xl bg-[#FFF3C4] flex items-center justify-center">
              <Receipt className="h-5 w-5 text-[#1A1A1A]" />
            </div>
          </div>
          <p className="text-[40px] font-light font-serif text-[#1A1A1A] leading-tight">{expenses.length}</p>
        </div>
        <div className="bg-white rounded-2xl p-5 shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0]">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm text-[#7A7A7A]">Total Amount</span>
            <div className="h-10 w-10 rounded-xl bg-[#FFF3C4] flex items-center justify-center">
              <IndianRupee className="h-5 w-5 text-[#1A1A1A]" />
            </div>
          </div>
          <p className="text-[40px] font-light font-serif text-[#1A1A1A] leading-tight">{"\u20B9"}{totalAmount.toLocaleString("en-IN")}</p>
        </div>
      </div>

      {/* Filter */}
      <div className="flex gap-2">
        {["PENDING", "APPROVED", "REJECTED"].map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`px-5 py-2 rounded-full text-sm font-medium transition-all ${filter === s ? "bg-[#1A1A1A] text-white" : "bg-white border border-[#E8E0D0] text-[#7A7A7A] hover:border-[#1A1A1A]"}`}
          >
            {s}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0]">
        {expenses.length === 0 ? (
          <div className="text-center py-12 text-[#7A7A7A]">
            <Receipt className="h-12 w-12 mx-auto mb-3 opacity-30" />
            <p>No {filter.toLowerCase()} expense claims</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#F0EAD8]">
                  <th className="text-left py-3 px-5 text-[#7A7A7A] text-xs font-medium">Employee</th>
                  <th className="text-left py-3 px-3 text-[#7A7A7A] text-xs font-medium">Title</th>
                  <th className="text-left py-3 px-3 text-[#7A7A7A] text-xs font-medium">Category</th>
                  <th className="text-right py-3 px-3 text-[#7A7A7A] text-xs font-medium">Amount</th>
                  <th className="text-left py-3 px-3 text-[#7A7A7A] text-xs font-medium">Date</th>
                  <th className="text-left py-3 px-3 text-[#7A7A7A] text-xs font-medium">Status</th>
                  {filter === "PENDING" && <th className="text-right py-3 px-5 text-[#7A7A7A] text-xs font-medium">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {expenses.map((exp: any) => (
                  <tr key={exp.id} className="border-b border-[#F0EAD8] last:border-0 hover:bg-[rgba(255,248,225,0.5)] transition-colors">
                    <td className="py-3 px-5">
                      <div>
                        <p className="font-medium text-[#1A1A1A]">{exp.employee?.name}</p>
                        <p className="text-xs text-[#7A7A7A]">{exp.employee?.email}</p>
                      </div>
                    </td>
                    <td className="py-3 px-3">
                      <p className="text-[#1A1A1A]">{exp.title}</p>
                      {exp.description && <p className="text-xs text-[#7A7A7A] truncate max-w-[200px]">{exp.description}</p>}
                    </td>
                    <td className="py-3 px-3 text-[#7A7A7A]">{exp.category.replace("_", " ")}</td>
                    <td className="py-3 px-3 text-right font-semibold text-[#1A1A1A]">{"\u20B9"}{exp.amount.toLocaleString("en-IN")}</td>
                    <td className="py-3 px-3 text-[#7A7A7A]">{new Date(exp.createdAt).toLocaleDateString()}</td>
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
          <div className="bg-white rounded-2xl p-6 w-96 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-serif text-lg font-medium text-[#1A1A1A] mb-4">Reject Expense Claim</h3>
            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="Reason for rejection (optional)"
              rows={3}
              className="w-full border border-[#E8E0D0] rounded-lg px-3 py-2 text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-[#F5D547]"
            />
            <div className="flex gap-2 justify-end">
              <button onClick={() => setRejectId(null)} className="px-4 py-2 text-sm text-[#7A7A7A]">Cancel</button>
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
