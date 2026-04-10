"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import useSWR from "swr";
import { FileText, Check, X, Search, Download } from "lucide-react";

const inputClass =
  "w-full border border-[#E8E0D0] bg-white rounded-lg px-4 py-2.5 text-sm text-[#1A1A1A] placeholder:text-[#B0B0B0] focus:outline-none focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] transition-colors";

const statusBadge: Record<string, string> = {
  DRAFT: "bg-[rgba(0,0,0,0.06)] text-[#7A7A7A]",
  PENDING_APPROVAL: "bg-[rgba(245,213,71,0.18)] text-[#B8960C]",
  APPROVED: "bg-[rgba(107,203,119,0.12)] text-[#6BCB77]",
  REJECTED: "bg-[rgba(231,76,60,0.1)] text-[#E74C3C]",
};

export default function SalarySlipsPage() {
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [bulkMonth, setBulkMonth] = useState(now.getMonth() + 1);
  const [bulkYear, setBulkYear] = useState(now.getFullYear());
  const [generating, setGenerating] = useState(false);

  const params = new URLSearchParams();
  params.set("month", String(month));
  params.set("year", String(year));
  if (status) params.set("status", status);
  if (search) params.set("search", search);

  const { data, isLoading, mutate } = useSWR(
    `/admin/salary-slips?${params.toString()}`,
    (url: string) => apiFetch<any>(url)
  );
  const slips = data?.data || [];

  async function handleGenerateBulk() {
    setGenerating(true);
    try {
      await apiFetch("/admin/salary-slips/generate-bulk", {
        method: "POST",
        body: JSON.stringify({ month: bulkMonth, year: bulkYear }),
      });
      mutate();
    } catch (e: any) {
      alert(e.message || "Failed to generate salary slips");
    } finally {
      setGenerating(false);
    }
  }

  async function handleAction(id: string, action: "approve" | "reject") {
    try {
      await apiFetch(`/admin/salary-slips/${id}/${action}`, { method: "POST" });
      mutate();
    } catch (e: any) {
      alert(e.message || `Failed to ${action}`);
    }
  }

  return (
    <div className="space-y-6 crx-animate-fade">
      <div className="flex items-center justify-between">
        <h1 className="font-serif text-4xl font-light text-[#1A1A1A]">Salary Slips</h1>
        <div className="flex items-center gap-3">
          <select
            value={bulkMonth}
            onChange={(e) => setBulkMonth(Number(e.target.value))}
            className={inputClass + " !w-auto"}
          >
            {Array.from({ length: 12 }, (_, i) => (
              <option key={i + 1} value={i + 1}>
                {new Date(2024, i).toLocaleString("default", { month: "long" })}
              </option>
            ))}
          </select>
          <input
            type="number"
            value={bulkYear}
            onChange={(e) => setBulkYear(Number(e.target.value))}
            className={inputClass + " !w-24"}
          />
          <button
            onClick={handleGenerateBulk}
            disabled={generating}
            className="bg-[#1A1A1A] text-white py-2.5 px-6 rounded-full font-semibold hover:bg-[#2B2B2B] transition-all disabled:opacity-50 flex items-center gap-2"
          >
            <Download size={16} />
            {generating ? "Generating..." : "Generate for All Employees"}
          </button>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0] p-5">
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
          <div>
            <label className="block text-xs font-medium text-[#7A7A7A] mb-1">Month</label>
            <select value={month} onChange={(e) => setMonth(Number(e.target.value))} className={inputClass}>
              {Array.from({ length: 12 }, (_, i) => (
                <option key={i + 1} value={i + 1}>
                  {new Date(2024, i).toLocaleString("default", { month: "long" })}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-[#7A7A7A] mb-1">Year</label>
            <input
              type="number"
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
              className={inputClass}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-[#7A7A7A] mb-1">Status</label>
            <select value={status} onChange={(e) => setStatus(e.target.value)} className={inputClass}>
              <option value="">All</option>
              <option value="DRAFT">Draft</option>
              <option value="PENDING_APPROVAL">Pending Approval</option>
              <option value="APPROVED">Approved</option>
              <option value="REJECTED">Rejected</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-[#7A7A7A] mb-1">Employee</label>
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#B0B0B0]" />
              <input
                type="text"
                placeholder="Search employee..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className={inputClass + " !pl-9"}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0]">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#F0EAD8]">
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Employee Name</th>
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Month/Year</th>
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Basic</th>
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Net Salary</th>
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Status</th>
                <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={6} className="p-4 text-center text-[#7A7A7A]">Loading...</td>
                </tr>
              ) : slips.length === 0 ? (
                <tr>
                  <td colSpan={6} className="p-4 text-center text-[#7A7A7A]">
                    <FileText size={24} className="mx-auto mb-2 opacity-30" />
                    No salary slips found
                  </td>
                </tr>
              ) : (
                slips.map((slip: any) => (
                  <tr key={slip.id} className="border-b border-[#F0EAD8] last:border-0 hover:bg-[rgba(255,248,225,0.5)] transition-colors">
                    <td className="p-4 text-[#1A1A1A] font-medium">{slip.employeeName || slip.employee?.name || "—"}</td>
                    <td className="p-4 text-[#1A1A1A]">
                      {new Date(2024, (slip.month || 1) - 1).toLocaleString("default", { month: "short" })} {slip.year}
                    </td>
                    <td className="p-4 text-[#1A1A1A]">{slip.basic != null ? `₹${Number(slip.basic).toLocaleString()}` : "—"}</td>
                    <td className="p-4 text-[#1A1A1A] font-semibold">{slip.netSalary != null ? `₹${Number(slip.netSalary).toLocaleString()}` : "—"}</td>
                    <td className="p-4">
                      <span className={`rounded-full px-3 py-1 text-xs font-medium ${statusBadge[slip.status] || statusBadge.DRAFT}`}>
                        {slip.status?.replace("_", " ") || "DRAFT"}
                      </span>
                    </td>
                    <td className="p-4">
                      {slip.status === "PENDING_APPROVAL" && (
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => handleAction(slip.id, "approve")}
                            className="flex items-center gap-1 rounded-full bg-[rgba(107,203,119,0.12)] text-[#2E7D32] px-3 py-1.5 text-xs font-medium hover:bg-[rgba(107,203,119,0.25)] transition-colors"
                          >
                            <Check size={13} /> Approve
                          </button>
                          <button
                            onClick={() => handleAction(slip.id, "reject")}
                            className="flex items-center gap-1 rounded-full bg-[rgba(231,76,60,0.1)] text-[#E74C3C] px-3 py-1.5 text-xs font-medium hover:bg-[rgba(231,76,60,0.2)] transition-colors"
                          >
                            <X size={13} /> Reject
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
