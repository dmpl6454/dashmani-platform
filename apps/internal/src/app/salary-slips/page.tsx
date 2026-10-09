"use client";

import { useState, useEffect } from "react";
import { apiFetch } from "@/lib/api";
import useSWR from "swr";
import { FileText, Check, X, Search, Download, Pencil } from "lucide-react";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import { formatStatus } from "@dashmani/shared";
import { ModalPortal } from "@/components/modal-portal";

const inputClass =
  "h-[42px] w-full px-3.5 rounded-[10px] border border-ds-line2 bg-ds-inset text-ds-text text-[16px] sm:text-[13px] outline-none focus:border-[rgba(233,189,98,.6)] placeholder:text-ds-t4 [color-scheme:dark] min-w-0 transition-colors";
const LABEL = "block text-[10.5px] text-ds-t3 font-semibold tracking-[.1em] uppercase mb-[7px]";
const TH = "text-left px-5 h-[52px] text-[11px] font-semibold tracking-[.08em] uppercase text-ds-t3 whitespace-nowrap";

// Mockup palette.
const STATUS_COLOR: Record<string, string> = {
  DRAFT: "var(--hx-738395)",
  PENDING_APPROVAL: "var(--hx-E9BD62)",
  APPROVED: "var(--hx-00D7A0)",
  REJECTED: "var(--hx-FB7185)",
};
const rgba = (hex: string, a: number) => {
  if (hex.startsWith("var(")) return `color-mix(in srgb, ${hex} ${Math.round(a * 100)}%, transparent)`; const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
};
const ACTION = "inline-flex items-center gap-1 h-8 px-3 rounded-full border text-[12px] font-semibold whitespace-nowrap transition-colors";

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
    <div className="pb-8">
      <section className="flex items-end justify-between gap-4 flex-wrap pt-[30px] pb-[22px]">
        <div className="flex-[1_1_320px] min-w-0">
          <h1 className="text-[34px] font-bold tracking-[-.03em] text-ds-text leading-tight">Salary Slips</h1>
          <p className="mt-1.5 text-[13.5px] text-ds-t2">
            {isLoading && !data ? "Loading…" : `${slips.length} salary ${slips.length === 1 ? "slip" : "slips"}`}
          </p>
        </div>
        <button
          onClick={handleGenerateBulk}
          disabled={generating}
          className="inline-flex items-center gap-2 h-[46px] px-[22px] rounded-full bg-ds-gold text-[color:var(--hx-060D14)] text-[14px] font-bold whitespace-nowrap hover:bg-[color:var(--hx-F4D58C)] disabled:opacity-60 transition-colors"
        >
          <Download className="h-[15px] w-[15px]" strokeWidth={2.4} />
          {generating ? "Generating..." : `Generate for ${new Date(bulkYear, bulkMonth - 1).toLocaleString("default", { month: "long" })} ${bulkYear}`}
        </button>
      </section>

      {/* Filter Bar */}
      <section className="rounded-[16px] border border-[color:var(--hx-2A4658)] bg-ds-card p-5 shadow-[0_12px_32px_rgba(0,0,0,.35)]">
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
          <div>
            <label className={LABEL}>Month</label>
            <select value={month} onChange={(e) => setMonth(Number(e.target.value))} className={`${inputClass} cursor-pointer`}>
              {Array.from({ length: 12 }, (_, i) => (
                <option key={i + 1} value={i + 1} className="bg-ds-card">
                  {new Date(new Date().getFullYear(), i).toLocaleString("default", { month: "long" })}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={LABEL}>Year</label>
            <input
              type="number"
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
              className={inputClass}
            />
          </div>
          <div>
            <label className={LABEL}>Status</label>
            <select value={status} onChange={(e) => setStatus(e.target.value)} className={`${inputClass} cursor-pointer`}>
              <option value="" className="bg-ds-card">All</option>
              <option value="DRAFT" className="bg-ds-card">Draft</option>
              <option value="PENDING_APPROVAL" className="bg-ds-card">Pending Approval</option>
              <option value="APPROVED" className="bg-ds-card">Approved</option>
              <option value="REJECTED" className="bg-ds-card">Rejected</option>
            </select>
          </div>
          <div>
            <label className={LABEL}>Employee</label>
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ds-t3" />
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
      </section>

      {/* Table */}
      <section className="mt-4 rounded-[16px] border border-[color:var(--hx-2A4658)] bg-ds-card overflow-hidden shadow-[0_12px_32px_rgba(0,0,0,.35)]">
        <div className="overflow-x-auto [color-scheme:dark]">
          <table className="w-full min-w-[720px] text-[13.5px]">
            <thead>
              <tr className="bg-ds-inset border-b border-ds-line2">
                <th className={TH}>Employee Name</th>
                <th className={TH}>Month/Year</th>
                <th className={TH}>Basic</th>
                <th className={TH}>Net Salary</th>
                <th className={TH}>Status</th>
                <th className={TH}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 4 }).map((_, i) => (
                  <tr key={i} className="border-b border-[color:var(--hx-132430)]">
                    <td colSpan={6} className="px-5 py-5">
                      <div className="h-3.5 w-full max-w-[520px] rounded-[4px] bg-ds-hover motion-safe:animate-pulse" />
                    </td>
                  </tr>
                ))
              ) : slips.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-14 px-5 text-center text-ds-t3 text-[13px]">
                    <FileText className="h-[30px] w-[30px] mx-auto mb-2.5 opacity-50" strokeWidth={1.5} />
                    No salary slips found
                  </td>
                </tr>
              ) : (
                slips.map((slip: any) => {
                  const color = STATUS_COLOR[slip.status] || STATUS_COLOR.DRAFT;
                  return (
                  <tr key={slip.id} className="border-b border-[color:var(--hx-132430)] last:border-0 hover:bg-[color:var(--hx-0A1620)] transition-colors tabular-nums">
                    <td className="px-5 py-4 text-ds-text font-semibold">{slip.employee?.name || "—"}</td>
                    <td className="px-5 py-4 text-ds-t5 whitespace-nowrap">
                      {new Date(slip.year || new Date().getFullYear(), (slip.month || 1) - 1).toLocaleString("default", { month: "short" })} {slip.year}
                    </td>
                    <td className="px-5 py-4 text-ds-t5 whitespace-nowrap">{slip.basicSalary != null ? `₹${Number(slip.basicSalary).toLocaleString()}` : "—"}</td>
                    <td className="px-5 py-4 text-ds-gold font-bold whitespace-nowrap">{slip.netSalary != null ? `₹${Number(slip.netSalary).toLocaleString()}` : "—"}</td>
                    <td className="px-5 py-4">
                      <span
                        className="inline-flex items-center gap-1.5 h-[26px] px-[11px] rounded-full text-[11.5px] font-semibold whitespace-nowrap border"
                        style={{ background: rgba(color, 0.1), borderColor: rgba(color, 0.28), color }}
                      >
                        <i className="h-[5px] w-[5px] rounded-full" style={{ background: color }} />
                        {formatStatus(slip.status || "DRAFT")}
                      </span>
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex items-center gap-2 flex-wrap">
                        <a
                          href={`${API_URL}/admin/ai/salary-slip/${slip.id}/html`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={`${ACTION} border-ds-line2 text-ds-t5 hover:border-ds-line4 hover:text-ds-text`}
                        >
                          <FileText size={13} /> View
                        </a>
                        {slip.status !== "APPROVED" && (
                          <button
                            onClick={() => setEditSlip(slip)}
                            className={`${ACTION} border-[rgba(233,189,98,.4)] bg-[rgba(233,189,98,.08)] text-ds-gold hover:bg-[rgba(233,189,98,.18)]`}
                          >
                            <Pencil size={13} /> Edit
                          </button>
                        )}
                        {slip.status === "PENDING_APPROVAL" && (
                          <>
                            <button
                              onClick={() => handleAction(slip.id, "approve")}
                              className={`${ACTION} border-[rgba(0,215,160,.3)] bg-[rgba(0,215,160,.08)] text-ds-teal hover:bg-[rgba(0,215,160,.18)]`}
                            >
                              <Check size={13} /> Approve
                            </button>
                            <button
                              onClick={() => handleAction(slip.id, "reject")}
                              className={`${ACTION} border-[rgba(229,72,77,.3)] bg-[rgba(229,72,77,.08)] text-[color:var(--hx-FB7185)] hover:bg-[rgba(229,72,77,.18)]`}
                            >
                              <X size={13} /> Reject
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

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

  const fieldClass =
    "h-[38px] w-full px-3 rounded-[6px] border border-ds-line2 bg-ds-inset text-ds-text text-[16px] sm:text-[12.5px] outline-none focus:border-ds-gold placeholder:text-ds-t4 [color-scheme:dark] min-w-0 transition-colors";
  const fieldLabel = "block text-[10.5px] text-ds-t3 font-semibold tracking-[.1em] uppercase mb-[7px]";
  const groupLabel = "text-[11px] font-semibold text-ds-gold uppercase tracking-[.14em] mb-3";

  return (
    <ModalPortal>
      <div className="ds-root contents">
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[rgba(2,6,10,.7)]">
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Edit Salary Slip"
            className="relative w-full max-w-2xl max-h-[90vh] overflow-y-auto bg-ds-card border border-ds-line2 rounded-[12px] shadow-[0_20px_50px_rgba(0,0,0,.6)]"
          >
            <span aria-hidden="true" className="absolute left-0 right-0 top-0 h-px opacity-70 bg-[linear-gradient(90deg,transparent,var(--hx-E9BD62)_30%,var(--hx-E9BD62)_70%,transparent)]" />
            <div className="p-6">
              <div className="flex items-start justify-between gap-3 mb-5">
                <div className="min-w-0">
                  <h2 className="text-[15px] font-semibold text-ds-text">Edit Salary Slip</h2>
                  <p className="mt-1 text-[12.5px] text-ds-t2">{slip.employee?.name} — {new Date(slip.year, slip.month - 1).toLocaleString("default", { month: "long" })} {slip.year}</p>
                </div>
                <button onClick={onClose} aria-label="Close" className="text-ds-t3 hover:text-ds-text transition-colors">
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="space-y-5">
                <div>
                  <p className={groupLabel}>Earnings</p>
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
                        <label className={fieldLabel}>{label}</label>
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
                  <p className={groupLabel}>Deductions</p>
                  <div className="grid grid-cols-2 gap-3">
                    {[
                      { key: "pf", label: "PF" },
                      { key: "esi", label: "ESI" },
                      { key: "tax", label: "Income Tax (TDS)" },
                      { key: "otherDeductions", label: "Other Deductions" },
                    ].map(({ key, label }) => (
                      <div key={key}>
                        <label className={fieldLabel}>{label}</label>
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
                  <label className={fieldLabel}>Remarks</label>
                  <textarea
                    value={form.remarks}
                    onChange={(e) => setForm({ ...form, remarks: e.target.value })}
                    rows={2}
                    className={fieldClass + " h-auto py-2.5 resize-none"}
                  />
                </div>

                <div className="flex items-center justify-between rounded-[10px] bg-[rgba(0,215,160,.08)] border border-[rgba(0,215,160,.3)] px-4 py-3">
                  <span className="text-[13px] font-semibold text-ds-text">Net Salary</span>
                  <span className="text-[18px] font-bold text-ds-teal tabular-nums">₹{netSalary.toLocaleString("en-IN", { maximumFractionDigits: 0 })}</span>
                </div>

                {editError && (
                  <p className="px-3 py-2.5 rounded-[6px] bg-[rgba(229,72,77,.08)] border border-[rgba(229,72,77,.3)] text-[color:var(--hx-FB7185)] text-[12px]">{editError}</p>
                )}

                <div className="flex justify-end gap-2 pt-1">
                  <button onClick={onClose} className="h-9 px-3.5 rounded-[6px] border border-ds-line2 text-ds-t2 text-[12px] font-semibold hover:text-ds-text hover:border-ds-line4 transition-colors">
                    Cancel
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={saving}
                    className="h-9 px-[18px] rounded-[6px] bg-ds-gold text-[color:var(--hx-060D14)] text-[12px] font-bold hover:bg-[color:var(--hx-F4D58C)] disabled:opacity-60 transition-colors"
                  >
                    {saving ? "Saving..." : "Save Changes"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}
