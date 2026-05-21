"use client";
import { useState } from "react";
import { apiFetch } from "@/lib/api";
import useSWR from "swr";
import { FileText, ChevronDown, Download } from "lucide-react";
import { Topstrip } from "@/components/portal-shell";

interface SalarySlip {
  id: string; month: number; year: number;
  basicSalary: number; hra: number; conveyance: number;
  medicalAllowance: number; specialAllowance: number; otherEarnings: number;
  pf: number; esi: number; tax: number; otherDeductions: number;
  netSalary: number; status: string; remarks?: string;
}

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

const statusCfg: Record<string, string> = {
  DRAFT:            "bg-muted text-ink-3 border-ink/10",
  PENDING_APPROVAL: "bg-attention-bg text-attention border-attention/20",
  APPROVED:         "bg-success-bg text-success border-success/20",
  REJECTED:         "bg-danger-bg text-danger border-danger/20",
};

function fmt(n: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);
}

function handleDownload(slip: SalarySlip) {
  const w = window.open("", "_blank");
  if (!w) return;
  w.document.write(`<html><head><title>Salary Slip - ${MONTHS[slip.month - 1]} ${slip.year}</title>
    <style>body{font-family:sans-serif;padding:40px}table{width:100%;border-collapse:collapse}td,th{border:1px solid #ccc;padding:8px;text-align:left}th{background:#f5f5f5}.right{text-align:right}h1{font-size:20px}@media print{body{padding:20px}}</style></head><body>
    <h1>Digital Sukoon - Salary Slip</h1><p>${MONTHS[slip.month - 1]} ${slip.year}</p>
    <table><tr><th>Earnings</th><th class="right">Amount</th></tr>
    <tr><td>Basic Salary</td><td class="right">₹${slip.basicSalary?.toLocaleString("en-IN")}</td></tr>
    <tr><td>HRA</td><td class="right">₹${slip.hra?.toLocaleString("en-IN")}</td></tr>
    <tr><td>Conveyance</td><td class="right">₹${slip.conveyance?.toLocaleString("en-IN")}</td></tr>
    <tr><td>Medical</td><td class="right">₹${slip.medicalAllowance?.toLocaleString("en-IN")}</td></tr>
    <tr><td>Special</td><td class="right">₹${slip.specialAllowance?.toLocaleString("en-IN")}</td></tr>
    <tr><th>Deductions</th><th class="right">Amount</th></tr>
    <tr><td>PF</td><td class="right">₹${slip.pf?.toLocaleString("en-IN")}</td></tr>
    <tr><td>ESI</td><td class="right">₹${slip.esi?.toLocaleString("en-IN")}</td></tr>
    <tr><td>Tax</td><td class="right">₹${slip.tax?.toLocaleString("en-IN")}</td></tr>
    <tr><th>Net Salary</th><th class="right">₹${slip.netSalary?.toLocaleString("en-IN")}</th></tr></table>
    <p style="margin-top:20px;color:#888">Status: ${slip.status}</p></body></html>`);
  w.document.close(); w.print();
}

export default function SalarySlipsPage() {
  const { data, isLoading } = useSWR<any>("/hr/salary-slips", apiFetch);
  const slips: SalarySlip[] = data?.data ?? [];
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <>
      <Topstrip title="Salary Slips" sub={`${slips.length} slips`} />
      <div className="px-6 py-6 flex-1 overflow-y-auto max-w-[900px]">
        <div className="space-y-3 anim-fade-up d1">
          {isLoading ? (
            <div className="v3-card overflow-hidden">{[1,2,3].map(i => <div key={i} className="px-5 py-4 border-b border-ink/5"><div className="h-5 bg-muted rounded-lg animate-pulse w-64" /></div>)}</div>
          ) : slips.length === 0 ? (
            <div className="v3-card px-5 py-10 text-center"><FileText size={24} className="mx-auto mb-3 text-ink-4" /><p className="text-[13px] text-ink-3 font-medium">No salary slips yet</p></div>
          ) : (
            <div className="v3-card overflow-hidden">
              <table className="w-full text-[13px]">
                <thead>
                  <tr style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
                    {["Month","Gross","Deductions","Net Pay","Status",""].map(h => (
                      <th key={h} className="text-left px-5 py-3 text-[11px] font-bold text-ink-3 uppercase tracking-wider">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {slips.map((s, i) => {
                    const sc = statusCfg[s.status] || statusCfg.DRAFT;
                    const gross = (s.basicSalary || 0) + (s.hra || 0) + (s.conveyance || 0) + (s.medicalAllowance || 0) + (s.specialAllowance || 0) + (s.otherEarnings || 0);
                    const deductions = (s.pf || 0) + (s.esi || 0) + (s.tax || 0) + (s.otherDeductions || 0);
                    const expanded = expandedId === s.id;
                    return (
                      <>
                        <tr key={s.id} className="v3-row cursor-pointer" onClick={() => setExpandedId(expanded ? null : s.id)}
                          style={i < slips.length - 1 || expanded ? { borderBottom: "1px solid rgba(26,26,26,0.05)" } : {}}>
                          <td className="px-5 py-3.5 font-semibold text-ink">{MONTHS[s.month - 1]} {s.year}</td>
                          <td className="px-5 py-3.5 text-ink-2 font-medium">{fmt(gross)}</td>
                          <td className="px-5 py-3.5 text-danger font-medium">{fmt(deductions)}</td>
                          <td className="px-5 py-3.5 font-bold text-ink">{fmt(s.netSalary || 0)}</td>
                          <td className="px-5 py-3.5">
                            <span className={`inline-flex h-6 px-2.5 rounded-full text-[11px] font-semibold items-center border ${sc}`}>{s.status.replace("_", " ")}</span>
                          </td>
                          <td className="px-5 py-3.5">
                            <div className="flex items-center gap-2">
                              <button onClick={e => { e.stopPropagation(); handleDownload(s); }}
                                className="btn-3d inline-flex items-center gap-1.5 px-3 h-7 rounded-lg bg-surface text-ink-2 text-[11.5px] font-semibold border-2 border-ink/12">
                                <Download size={12} /> Download
                              </button>
                              <ChevronDown size={14} className={`text-ink-4 transition-transform ${expanded ? "rotate-180" : ""}`} />
                            </div>
                          </td>
                        </tr>
                        {expanded && (
                          <tr key={s.id + "-exp"} style={{ borderBottom: "1px solid rgba(26,26,26,0.05)" }}>
                            <td colSpan={6} className="px-5 pb-4 pt-2">
                              <div className="grid grid-cols-2 gap-4">
                                <div className="v3-card-inset p-4">
                                  <p className="text-[11px] font-bold text-ink-4 uppercase tracking-wider mb-3">Earnings</p>
                                  {[["Basic Salary", s.basicSalary],["HRA", s.hra],["Conveyance", s.conveyance],["Medical", s.medicalAllowance],["Special", s.specialAllowance],["Other", s.otherEarnings]].filter(([,v]) => v).map(([label, val]) => (
                                    <div key={label as string} className="flex justify-between py-1 text-[12.5px]">
                                      <span className="text-ink-3">{label}</span>
                                      <span className="font-semibold text-ink">{fmt(val as number)}</span>
                                    </div>
                                  ))}
                                </div>
                                <div className="v3-card-inset p-4">
                                  <p className="text-[11px] font-bold text-ink-4 uppercase tracking-wider mb-3">Deductions</p>
                                  {[["PF", s.pf],["ESI", s.esi],["Tax", s.tax],["Other", s.otherDeductions]].filter(([,v]) => v).map(([label, val]) => (
                                    <div key={label as string} className="flex justify-between py-1 text-[12.5px]">
                                      <span className="text-ink-3">{label}</span>
                                      <span className="font-semibold text-danger">{fmt(val as number)}</span>
                                    </div>
                                  ))}
                                  <div className="flex justify-between pt-2 mt-2 border-t border-ink/10 text-[13px]">
                                    <span className="font-bold text-ink">Net Pay</span>
                                    <span className="font-bold text-ink">{fmt(s.netSalary || 0)}</span>
                                  </div>
                                </div>
                              </div>
                              {s.remarks && <p className="text-[12px] text-ink-3 mt-3 font-medium italic">"{s.remarks}"</p>}
                            </td>
                          </tr>
                        )}
                      </>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
