"use client";

import { useState, useEffect } from "react";
import { apiFetch } from "@/lib/api";
import useSWR from "swr";
import { FileText, Check, X, Search, Download, Pencil } from "lucide-react";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import { formatStatus } from "@dashmani/shared";

const inputClass =
  "w-full border border-[#E8E0D0] bg-white rounded-lg px-4 py-2.5 text-sm text-[#1A1A1A] placeholder:text-[#B0B0B0] focus:outline-none focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] transition-colors";

const statusBadge: Record<string, string> = {
  DRAFT: "bg-[rgba(0,0,0,0.06)] text-[#7A7A7A]",
  PENDING_APPROVAL: "bg-[rgba(245,213,71,0.18)] text-[#B8960C]",
  APPROVED: "bg-[rgba(107,203,119,0.12)] text-[#6BCB77]",
  REJECTED: "bg-[rgba(231,76,60,0.1)] text-[#E74C3C]",
};

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/v1";

export default function SalarySlipsPage() {
  usePageTitle("Salary Slips");
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  const [status, setStatus] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [bulkMonth, setBulkMonth] = useState(now.getMonth() + 1);
  const [bulkYear, setBulkYear] = useState(now.getFullYear());
  const [generating, setGenerating] = useState(false);
  const [editSlip, setEditSlip] = useState<any>(null);

  // Debounce search input 250ms
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

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
        <button
          onClick={handleGenerateBulk}
          disabled={generating}
          className="bg-[#1A1A1A] text-white py-2.5 px-6 rounded-full font-semibold hover:bg-[#2B2B2B] transition-all disabled:opacity-50 flex items-center gap-2"
        >
          <Download size={16} />
          {generating ? "Generating..." : `Generate for ${new Date(bulkYear, bulkMonth - 1).toLocaleString("default", { month: "long" })} ${bulkYear}`}
        </button>
      </div>

      {/* Filter Bar */}
      <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0] p-5">
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
          <div>
            <label className="block text-xs font-medium text-[#7A7A7A] mb-1">Month</label>
            <select value={month} onChange={(e) => setMonth(Number(e.target.value))} className={inputClass}>
              {Array.from({ length: 12 }, (_, i) => (
                <option key={i + 1} value={i + 1}>
                  {new Date(new Date().getFullYear(), i).toLocaleString("default", { month: "long" })}
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
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
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
                    <td className="p-4 text-[#1A1A1A] font-medium">{slip.employee?.name || "—"}</td>
                    <td className="p-4 text-[#1A1A1A]">
                      {new Date(slip.year || new Date().getFullYear(), (slip.month || 1) - 1).toLocaleString("default", { month: "short" })} {slip.year}
                    </td>
                    <td className="p-4 text-[#1A1A1A]">{slip.basicSalary != null ? `₹${Number(slip.basicSalary).toLocaleString()}` : "—"}</td>
                    <td className="p-4 text-[#1A1A1A] font-semibold">{slip.netSalary != null ? `₹${Number(slip.netSalary).toLocaleString()}` : "—"}</td>
                    <td className="p-4">
                      <span className={`rounded-full px-3 py-1 text-xs font-medium ${statusBadge[slip.status] || statusBadge.DRAFT}`}>
                        {formatStatus(slip.status || "DRAFT")}
                      </span>
                    </td>
                    <td className="p-4">
                      <div className="flex items-center gap-2 flex-wrap">
                        <a
                          href={`${API_URL}/admin/ai/salary-slip/${slip.id}/html`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 rounded-full bg-[rgba(0,0,0,0.06)] text-[#7A7A7A] px-3 py-1.5 text-xs font-medium hover:bg-[rgba(0,0,0,0.12)] transition-colors"
                        >
                          <FileText size={13} /> View
                        </a>
                        {slip.status !== "APPROVED" && (
                          <button
                            onClick={() => setEditSlip(slip)}
                            className="flex items-center gap-1 rounded-full bg-[rgba(99,102,241,0.1)] text-[#6366F1] px-3 py-1.5 text-xs font-medium hover:bg-[rgba(99,102,241,0.2)] transition-colors"
                          >
                            <Pencil size={13} /> Edit
                          </button>
                        )}
                        {slip.status === "PENDING_APPROVAL" && (
                          <>
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
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Edit Modal */}
      {editSlip && (
        <EditSlipModal
          slip={editSlip}
          onClose={() => setEditSlip(null)}
          onSaved={() => { setEditSlip(null); mutate(); }}
        />
      )}
    </div>
  );
}

function EditSlipModal({ slip, onClose, onSaved }: { slip: any; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    basicSalary: String(slip.basicSalary ?? ""),
    hra: String(slip.hra ?? ""),
    conveyance: String(slip.conveyance ?? ""),
    medicalAllowance: String(slip.medicalAllowance ?? ""),
    specialAllowance: String(slip.specialAllowance ?? ""),
    otherEarnings: String(slip.otherEarnings ?? "0"),
    pf: String(slip.pf ?? ""),
    esi: String(slip.esi ?? ""),
    tax: String(slip.tax ?? "0"),
    otherDeductions: String(slip.otherDeductions ?? "0"),
    remarks: slip.remarks ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState("");

  const n = (v: string) => parseFloat(v) || 0;
  const totalEarnings = n(form.basicSalary) + n(form.hra) + n(form.conveyance) + n(form.medicalAllowance) + n(form.specialAllowance) + n(form.otherEarnings);
  const totalDeductions = n(form.pf) + n(form.esi) + n(form.tax) + n(form.otherDeductions);
  const netSalary = totalEarnings - totalDeductions;

  async function handleSave() {
    setSaving(true);
    setEditError("");
    try {
      await apiFetch(`/admin/salary-slips/${slip.id}`, {
        method: "PUT",
        body: JSON.stringify({
          basicSalary: n(form.basicSalary),
          hra: n(form.hra),
          conveyance: n(form.conveyance),
          medicalAllowance: n(form.medicalAllowance),
          specialAllowance: n(form.specialAllowance),
          otherEarnings: n(form.otherEarnings),
          pf: n(form.pf),
          esi: n(form.esi),
          tax: n(form.tax),
          otherDeductions: n(form.otherDeductions),
          remarks: form.remarks || undefined,
        }),
      });
      onSaved();
    } catch (e: any) {
      setEditError(e.message || "Failed to save changes");
    } finally {
      setSaving(false);
    }
  }

  const fieldClass = "w-full border border-[#E8E0D0] bg-white rounded-lg px-3 py-2 text-sm text-[#1A1A1A] focus:outline-none focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] transition-colors";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-lg font-semibold text-[#1A1A1A]">Edit Salary Slip</h2>
              <p className="text-sm text-[#7A7A7A]">{slip.employee?.name} — {new Date(slip.year, slip.month - 1).toLocaleString("default", { month: "long" })} {slip.year}</p>
            </div>
            <button onClick={onClose} className="text-[#7A7A7A] hover:text-[#1A1A1A] transition-colors">
              <X size={20} />
            </button>
          </div>

          <div className="space-y-4">
            <div>
              <p className="text-xs font-semibold text-[#7A7A7A] uppercase tracking-wide mb-2">Earnings</p>
              <div className="grid grid-cols-2 gap-3">
                {[
                  { key: "basicSalary", label: "Basic Salary" },
                  { key: "hra", label: "HRA" },
                  { key: "conveyance", label: "Conveyance" },
                  { key: "medicalAllowance", label: "Medical Allowance" },
                  { key: "specialAllowance", label: "Special Allowance" },
                  { key: "otherEarnings", label: "Other Earnings" },
                ].map(({ key, label }) => (
                  <div key={key}>
                    <label className="block text-xs text-[#7A7A7A] mb-1">{label}</label>
                    <input
                      type="number"
                      step="0.01"
                      value={form[key as keyof typeof form]}
                      onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                      className={fieldClass}
                    />
                  </div>
                ))}
              </div>
            </div>

            <div>
              <p className="text-xs font-semibold text-[#7A7A7A] uppercase tracking-wide mb-2">Deductions</p>
              <div className="grid grid-cols-2 gap-3">
                {[
                  { key: "pf", label: "PF" },
                  { key: "esi", label: "ESI" },
                  { key: "tax", label: "Income Tax (TDS)" },
                  { key: "otherDeductions", label: "Other Deductions" },
                ].map(({ key, label }) => (
                  <div key={key}>
                    <label className="block text-xs text-[#7A7A7A] mb-1">{label}</label>
                    <input
                      type="number"
                      step="0.01"
                      value={form[key as keyof typeof form]}
                      onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                      className={fieldClass}
                    />
                  </div>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-xs text-[#7A7A7A] mb-1">Remarks</label>
              <textarea
                value={form.remarks}
                onChange={(e) => setForm({ ...form, remarks: e.target.value })}
                rows={2}
                className={fieldClass + " resize-none"}
              />
            </div>

            <div className="flex items-center justify-between rounded-xl bg-[rgba(107,203,119,0.08)] border border-[rgba(107,203,119,0.3)] px-4 py-3">
              <span className="text-sm font-medium text-[#1A1A1A]">Net Salary</span>
              <span className="text-lg font-bold text-[#2E7D32]">₹{netSalary.toLocaleString("en-IN", { maximumFractionDigits: 0 })}</span>
            </div>

            {editError && (
              <p className="text-sm text-[#E74C3C] bg-[rgba(231,76,60,0.06)] border border-[rgba(231,76,60,0.2)] rounded-lg px-3 py-2">{editError}</p>
            )}

            <div className="flex justify-end gap-3 pt-2">
              <button onClick={onClose} className="px-5 py-2.5 rounded-full border border-[#E8E0D0] text-sm font-medium text-[#7A7A7A] hover:border-[#1A1A1A] transition-colors">
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-5 py-2.5 rounded-full bg-[#1A1A1A] text-white text-sm font-medium hover:bg-[#2B2B2B] disabled:opacity-50 transition-colors"
              >
                {saving ? "Saving..." : "Save Changes"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
