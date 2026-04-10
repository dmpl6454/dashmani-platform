"use client";
import { useState } from "react";
import { apiFetch } from "@/lib/api";
import useSWR, { mutate } from "swr";
import Link from "next/link";
import { Home, Send, CheckCircle2, XCircle, Clock, ArrowLeft } from "lucide-react";

const inputClass = "w-full border border-[#E8E0D0] bg-white rounded-lg px-4 py-2.5 text-sm text-[#1A1A1A] placeholder:text-[#B0B0B0] focus:outline-none focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] transition-colors";
const cardClass = "bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0] p-5";
const btnClass = "bg-[#1A1A1A] text-white py-2.5 px-6 rounded-full font-semibold hover:bg-[#2B2B2B] transition-all";

const statusColors: Record<string, string> = {
  PENDING: "bg-yellow-100 text-yellow-800 border-yellow-300",
  APPROVED: "bg-green-100 text-green-800 border-green-300",
  REJECTED: "bg-red-100 text-red-800 border-red-300",
};

const fetcher = (url: string) => apiFetch<any>(url).then((r) => r.data);

export default function WfhPage() {
  const { data: requests } = useSWR("/hr/leave-requests", fetcher);
  const wfhRequests = (requests || []).filter((r: any) => r.type === "WFH");

  const [form, setForm] = useState({ startDate: "", endDate: "", reason: "" });
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError("");
    setSuccess("");
    try {
      await apiFetch("/hr/leave-requests", {
        method: "POST",
        body: JSON.stringify({
          startDate: form.startDate,
          endDate: form.endDate || form.startDate,
          type: "WFH",
          reason: form.reason,
        }),
      });
      setSuccess("WFH request submitted successfully!");
      setForm({ startDate: "", endDate: "", reason: "" });
      mutate("/hr/leave-requests");
    } catch (err: any) {
      setError(err.message || "Failed to submit WFH request");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#FEFCF7] p-6 md:p-10 space-y-8">
      <div className="flex items-center gap-4">
        <Link href="/dashboard" className="h-10 w-10 rounded-xl bg-white border border-[#E8E0D0] flex items-center justify-center hover:bg-[#FFF3C4] transition-colors shrink-0">
          <ArrowLeft className="h-5 w-5 text-[#1A1A1A]" />
        </Link>
        <div>
          <h1 className="text-4xl font-light text-[#1A1A1A] font-serif flex items-center gap-3">
            <Home className="h-8 w-8 text-[#F5D547]" /> Work from Home
          </h1>
          <p className="text-sm text-[#888] mt-1">Request to work from home for specific dates</p>
        </div>
      </div>

      {/* Request Form */}
      <div className={cardClass}>
        <h2 className="text-lg font-semibold text-[#1A1A1A] mb-5 flex items-center gap-2">
          <Send className="w-4 h-4 text-[#F5D547]" /> New WFH Request
        </h2>

        {success && (
          <div className="mb-4 px-4 py-3 rounded-lg bg-green-50 border border-green-200 text-green-700 text-sm flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4" /> {success}
          </div>
        )}
        {error && (
          <div className="mb-4 px-4 py-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm flex items-center gap-2">
            <XCircle className="w-4 h-4" /> {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-[#1A1A1A] mb-1.5">Start Date *</label>
              <input type="date" className={inputClass} value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} required />
            </div>
            <div>
              <label className="block text-sm font-medium text-[#1A1A1A] mb-1.5">End Date</label>
              <input type="date" className={inputClass} value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} placeholder="Same as start if blank" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-[#1A1A1A] mb-1.5">Reason *</label>
            <textarea className={`${inputClass} min-h-[80px] resize-none`} placeholder="Why do you need to work from home?" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} required />
          </div>
          <button type="submit" className={btnClass} disabled={submitting}>
            {submitting ? "Submitting..." : "Submit WFH Request"}
          </button>
        </form>
      </div>

      {/* WFH Requests List */}
      <div className={cardClass}>
        <h2 className="text-lg font-semibold text-[#1A1A1A] mb-5 flex items-center gap-2">
          <Clock className="w-4 h-4 text-[#F5D547]" /> Your WFH Requests
        </h2>
        {wfhRequests.length === 0 ? (
          <div className="text-center py-10 text-[#B0B0B0]">
            <Home className="w-10 h-10 mx-auto mb-3 opacity-40" />
            <p className="text-sm">No WFH requests yet</p>
          </div>
        ) : (
          <div className="space-y-3">
            {wfhRequests.map((req: any) => (
              <div key={req.id} className="flex flex-col md:flex-row md:items-center justify-between gap-3 p-4 rounded-xl border border-[#E8E0D0] bg-[#FEFCF7]">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-semibold text-[#1A1A1A]">Work from Home</span>
                    <span className="text-xs text-[#B0B0B0]">
                      {new Date(req.startDate).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
                      {req.startDate !== req.endDate && ` \u2013 ${new Date(req.endDate).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}`}
                    </span>
                  </div>
                  <p className="text-sm text-[#666]">{req.reason}</p>
                </div>
                <span className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold border ${statusColors[req.status] || ""}`}>
                  {req.status}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
