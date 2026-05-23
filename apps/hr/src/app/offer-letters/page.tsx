"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import useSWR from "swr";
import { Topstrip } from "@/components/portal-shell";
import { FileText, Download, ChevronDown, ChevronUp, CheckCircle2, Clock, XCircle } from "lucide-react";

interface OfferLetter {
  id: string;
  designation: string;
  department: string;
  salary: number;
  joiningDate: string;
  status: string;
  createdAt: string;
}


const statusConfig: Record<string, { label: string; badge: string; icon: typeof CheckCircle2 }> = {
  PENDING: { label: "Pending", badge: "bg-attention-bg text-attention border-attention/20", icon: Clock },
  SENT: { label: "Sent", badge: "bg-indigo-soft text-indigo border-indigo/20", icon: FileText },
  ACCEPTED: { label: "Accepted", badge: "bg-success-bg text-success border-success/20", icon: CheckCircle2 },
  REJECTED: { label: "Rejected", badge: "bg-danger-bg text-danger border-danger/20", icon: XCircle },
};

function formatCurrency(amount: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(amount);
}

export default function OfferLettersPage() {
  const { data, error, isLoading } = useSWR("/hr/offer-letters", (url: string) => apiFetch<any>(url).then((r) => r.data || []));
  const [expandedId, setExpandedId] = useState<string | null>(null);

  function handleDownload(letter: OfferLetter) {
    apiFetch<any>(`/hr/offer-letters/${letter.id}/html`).then((res) => {
      const html = res.data?.html || res.data || "";
      const win = window.open("", "_blank");
      if (win) {
        win.document.write(`<!DOCTYPE html><html><head><title>Offer Letter - ${letter.designation}</title>
          <style>body{font-family:Georgia,serif;max-width:800px;margin:40px auto;padding:20px;color:#1A1A1A}@media print{body{margin:0;padding:20px}}</style>
        </head><body>${html}</body></html>`);
        win.document.close();
      }
    }).catch((e: any) => alert(e.message));
  }

  return (
    <>
      <Topstrip title="Offer Letters" sub="View and download your offer letters" />
      <div className="px-6 py-6 flex-1 overflow-y-auto max-w-[900px]">

        {isLoading && (
          <div className="flex items-center justify-center py-16">
            <div className="h-7 w-7 border-2 border-indigo border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {error && (
          <div className="bg-danger-bg border border-danger/20 text-danger rounded-xl p-4 text-[13px] font-medium">
            Failed to load offer letters. Please try again later.
          </div>
        )}

        {!isLoading && !error && (!data || data.length === 0) && (
          <div className="v3-card p-12 text-center">
            <div className="mx-auto w-14 h-14 bg-muted rounded-full flex items-center justify-center mb-3">
              <FileText className="w-7 h-7 text-ink-4" />
            </div>
            <h3 className="text-[14px] font-semibold text-ink mb-1">No offer letters yet</h3>
            <p className="text-[13px] text-ink-3 font-medium">Your offer letters will appear here once they are generated.</p>
          </div>
        )}

        {data && data.length > 0 && (
          <div className="v3-card">
            <div className="px-5 h-12 flex items-center" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
              <span className="text-[13px] font-semibold text-ink">Your Offer Letters</span>
              <span className="ml-2 h-5 w-5 rounded-full bg-muted text-ink-3 text-[11px] font-bold flex items-center justify-center">{data.length}</span>
            </div>
            <div className="px-5 py-3 space-y-1">
              {data.map((letter: OfferLetter) => {
                const expanded = expandedId === letter.id;
                const status = statusConfig[letter.status] ?? statusConfig.PENDING;
                const StatusIcon = status.icon;

                return (
                  <div key={letter.id} className="rounded-xl overflow-hidden border border-ink/8">
                    <div
                      className="v3-row flex items-center justify-between px-4 py-3 cursor-pointer"
                      onClick={() => setExpandedId(expanded ? null : letter.id)}
                    >
                      <div className="flex items-center gap-3 flex-1 min-w-0">
                        <div className="w-9 h-9 rounded-xl bg-muted flex items-center justify-center shrink-0">
                          <FileText className="w-4 h-4 text-ink-3" />
                        </div>
                        <div className="min-w-0">
                          <p className="text-[13px] font-semibold text-ink truncate">{letter.designation}</p>
                          <p className="text-[11px] text-ink-4 font-medium mt-0.5">
                            {letter.department} &middot;{" "}
                            {new Date(letter.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-3">
                        <span className={`inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full text-[11px] font-semibold border ${status.badge}`}>
                          <StatusIcon className="w-3 h-3" />
                          {status.label}
                        </span>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDownload(letter); }}
                          className="p-1.5 rounded-lg hover:bg-muted text-ink-4 hover:text-ink transition-colors"
                          title="Download"
                        >
                          <Download className="w-3.5 h-3.5" />
                        </button>
                        <div className="text-ink-4">
                          {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                        </div>
                      </div>
                    </div>

                    {expanded && (
                      <div className="border-t border-ink/7 bg-muted px-4 py-4">
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                          <div className="v3-card-inset p-4">
                            <p className="text-[11.5px] font-bold text-ink-3 uppercase tracking-wider mb-1">Designation</p>
                            <p className="text-[13px] font-semibold text-ink">{letter.designation}</p>
                          </div>
                          <div className="v3-card-inset p-4">
                            <p className="text-[11.5px] font-bold text-ink-3 uppercase tracking-wider mb-1">Salary</p>
                            <p className="text-[13px] font-semibold text-ink">
                              {letter.salary ? formatCurrency(letter.salary) : "--"}
                            </p>
                          </div>
                          <div className="v3-card-inset p-4">
                            <p className="text-[11.5px] font-bold text-ink-3 uppercase tracking-wider mb-1">Joining Date</p>
                            <p className="text-[13px] font-semibold text-ink">
                              {letter.joiningDate
                                ? new Date(letter.joiningDate).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })
                                : "--"}
                            </p>
                          </div>
                        </div>
                      </div>
                    )}
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
