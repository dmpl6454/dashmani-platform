"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import useSWR from "swr";
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

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/v1";

const statusConfig: Record<string, { label: string; bg: string; text: string; icon: typeof CheckCircle2 }> = {
  PENDING: { label: "Pending", bg: "bg-yellow-50", text: "text-yellow-700", icon: Clock },
  SENT: { label: "Sent", bg: "bg-blue-50", text: "text-blue-700", icon: FileText },
  ACCEPTED: { label: "Accepted", bg: "bg-green-50", text: "text-green-700", icon: CheckCircle2 },
  REJECTED: { label: "Rejected", bg: "bg-red-50", text: "text-red-700", icon: XCircle },
};

function formatCurrency(amount: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(amount);
}

export default function OfferLettersPage() {
  const { data, error, isLoading } = useSWR("/hr/offer-letters", (url: string) => apiFetch<any>(url).then((r) => r.data || []));
  const [expandedId, setExpandedId] = useState<string | null>(null);

  function handleDownload(letter: OfferLetter) {
    const token = typeof window !== "undefined" ? localStorage.getItem("hrAccessToken") : null;
    const url = `${API_URL}/hr/offer-letters/${letter.id}/html`;

    fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((r) => r.json())
      .then((data) => {
        const html = data.data?.html || data.data || "";
        const win = window.open("", "_blank");
        if (win) {
          win.document.write(`<!DOCTYPE html><html><head><title>Offer Letter - ${letter.designation}</title>
            <style>body{font-family:Georgia,serif;max-width:800px;margin:40px auto;padding:20px;color:#1A1A1A}@media print{body{margin:0;padding:20px}}</style>
          </head><body>${html}</body></html>`);
          win.document.close();
        }
      });
  }

  return (
    <div className="min-h-screen bg-[#FEFCF7] p-6 md:p-10">
      <div className="mb-8">
        <h1 className="text-4xl font-light text-[#1A1A1A] font-serif">Offer Letters</h1>
        <p className="text-sm text-[#888] mt-1">View and download your offer letters</p>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-20">
          <div className="h-8 w-8 border-2 border-[#F5D547] border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-2xl p-5 text-sm">
          Failed to load offer letters. Please try again later.
        </div>
      )}

      {!isLoading && !error && (!data || data.length === 0) && (
        <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0] p-12 text-center">
          <div className="mx-auto w-16 h-16 bg-[#FEFCF7] rounded-full flex items-center justify-center mb-4">
            <FileText className="w-8 h-8 text-[#C4B89C]" />
          </div>
          <h3 className="text-lg font-semibold text-[#1A1A1A] mb-1">No offer letters yet</h3>
          <p className="text-sm text-[#888]">Your offer letters will appear here once they are generated.</p>
        </div>
      )}

      {data && data.length > 0 && (
        <div className="space-y-4">
          {data.map((letter: OfferLetter) => {
            const expanded = expandedId === letter.id;
            const status = statusConfig[letter.status] ?? statusConfig.PENDING;
            const StatusIcon = status.icon;

            return (
              <div key={letter.id} className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0] overflow-hidden transition-all">
                <div className="flex items-center justify-between p-5 cursor-pointer hover:bg-[#FEFCF7] transition-colors" onClick={() => setExpandedId(expanded ? null : letter.id)}>
                  <div className="flex items-center gap-4 flex-1 min-w-0">
                    <div className="w-10 h-10 rounded-xl bg-[#FEFCF7] border border-[#E8E0D0] flex items-center justify-center shrink-0">
                      <FileText className="w-5 h-5 text-[#C4B89C]" />
                    </div>
                    <div className="min-w-0">
                      <p className="font-semibold text-[#1A1A1A] text-sm">{letter.designation}</p>
                      <p className="text-xs text-[#888] mt-0.5">{letter.department} &middot; {new Date(letter.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}</p>
                    </div>
                  </div>

                  <div className="flex items-center gap-4">
                    <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium ${status.bg} ${status.text}`}>
                      <StatusIcon className="w-3.5 h-3.5" />
                      {status.label}
                    </span>
                    <button onClick={(e) => { e.stopPropagation(); handleDownload(letter); }} className="p-2 rounded-lg hover:bg-[#F5D547]/10 text-[#1A1A1A] transition-colors" title="Download">
                      <Download className="w-4 h-4" />
                    </button>
                    <div className="text-[#888]">
                      {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                    </div>
                  </div>
                </div>

                {expanded && (
                  <div className="border-t border-[#E8E0D0] bg-[#FEFCF7] p-5">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <div className="p-4 rounded-xl bg-white border border-[#E8E0D0]">
                        <span className="text-xs text-[#B0B0B0]">Designation</span>
                        <p className="text-sm font-semibold text-[#1A1A1A]">{letter.designation}</p>
                      </div>
                      <div className="p-4 rounded-xl bg-white border border-[#E8E0D0]">
                        <span className="text-xs text-[#B0B0B0]">Salary</span>
                        <p className="text-sm font-semibold text-[#1A1A1A]">{letter.salary ? formatCurrency(letter.salary) : "--"}</p>
                      </div>
                      <div className="p-4 rounded-xl bg-white border border-[#E8E0D0]">
                        <span className="text-xs text-[#B0B0B0]">Joining Date</span>
                        <p className="text-sm font-semibold text-[#1A1A1A]">{letter.joiningDate ? new Date(letter.joiningDate).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" }) : "--"}</p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
