"use client";
import { useState } from "react";
import { apiFetch } from "@/lib/api";
import useSWR from "swr";
import { AlertCircle, MessageSquare, Send, X } from "lucide-react";

const inputClass = "w-full border border-[#E8E0D0] bg-white rounded-lg px-4 py-2.5 text-sm text-[#1A1A1A] placeholder:text-[#B0B0B0] focus:outline-none focus:ring-2 focus:ring-[#F5D547] focus:border-[#F5D547] transition-colors";

const statusColors: Record<string, string> = {
  OPEN: "bg-yellow-50 text-yellow-700",
  IN_REVIEW: "bg-blue-50 text-blue-700",
  RESOLVED: "bg-green-50 text-green-700",
  CLOSED: "bg-gray-100 text-gray-600",
};

export default function AdminComplaintsPage() {
  const [filter, setFilter] = useState("");
  const { data, mutate } = useSWR(`/admin/complaints${filter ? `?status=${filter}` : ""}`, (url: string) => apiFetch<any>(url));
  const complaints = data?.data || [];
  const [responding, setResponding] = useState<string | null>(null);
  const [response, setResponse] = useState("");
  const [responseStatus, setResponseStatus] = useState("RESOLVED");
  const [submitting, setSubmitting] = useState(false);

  async function handleRespond(id: string) {
    setSubmitting(true);
    try {
      await apiFetch(`/admin/complaints/${id}/respond`, {
        method: "POST",
        body: JSON.stringify({ response, status: responseStatus }),
      });
      setResponding(null);
      setResponse("");
      mutate();
    } catch (e: any) { alert(e.message); }
    setSubmitting(false);
  }

  const openCount = complaints.filter((c: any) => c.status === "OPEN").length;

  return (
    <div className="space-y-6 crx-animate-fade">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-serif text-3xl font-light text-[#1A1A1A]">Employee Complaints</h1>
          <p className="text-sm text-[#7A7A7A] mt-1">Review and respond to employee complaints</p>
        </div>
        {openCount > 0 && (
          <div className="flex items-center gap-2 bg-yellow-50 border border-yellow-200 text-yellow-800 px-4 py-2 rounded-full text-sm font-medium">
            <AlertCircle className="h-4 w-4" /> {openCount} Open
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="flex gap-2">
        {["", "OPEN", "IN_REVIEW", "RESOLVED", "CLOSED"].map((s) => (
          <button key={s} onClick={() => setFilter(s)} className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${filter === s ? "bg-[#1A1A1A] text-white" : "bg-white text-[#7A7A7A] border border-[#E8E0D0] hover:bg-[#FFF8E1]"}`}>
            {s || "All"}
          </button>
        ))}
      </div>

      {complaints.length === 0 ? (
        <div className="bg-white rounded-2xl border border-[#E8E0D0] p-12 text-center">
          <MessageSquare className="h-12 w-12 mx-auto mb-3 text-[#B0B0B0]" />
          <p className="text-[#7A7A7A] font-medium">No complaints found</p>
        </div>
      ) : (
        <div className="space-y-4">
          {complaints.map((c: any) => (
            <div key={c.id} className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0] p-5">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <h3 className="font-semibold text-[#1A1A1A]">{c.subject}</h3>
                  <p className="text-xs text-[#7A7A7A] mt-0.5">
                    {c.employee?.name} ({c.employee?.email}) · {c.category} · {new Date(c.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
                  </p>
                </div>
                <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${statusColors[c.status]}`}>{c.status.replace("_", " ")}</span>
              </div>
              <p className="text-sm text-[#555] whitespace-pre-wrap mb-3">{c.description}</p>

              {c.adminResponse && (
                <div className="bg-[#FEFCF7] border border-[#F0EAD8] rounded-xl p-3 mb-3">
                  <p className="text-xs font-semibold text-[#7A7A7A] mb-1">Your Response:</p>
                  <p className="text-sm text-[#1A1A1A]">{c.adminResponse}</p>
                </div>
              )}

              {responding === c.id ? (
                <div className="space-y-3 border-t border-[#F0EAD8] pt-3">
                  <textarea placeholder="Type your response..." value={response} onChange={(e) => setResponse(e.target.value)} rows={3} className={inputClass} />
                  <div className="flex items-center gap-3">
                    <select value={responseStatus} onChange={(e) => setResponseStatus(e.target.value)} className={inputClass + " max-w-[150px]"}>
                      <option value="IN_REVIEW">In Review</option>
                      <option value="RESOLVED">Resolved</option>
                      <option value="CLOSED">Closed</option>
                    </select>
                    <button onClick={() => handleRespond(c.id)} disabled={submitting} className="flex items-center gap-2 bg-[#1A1A1A] text-white px-4 py-2 rounded-full text-sm font-semibold hover:bg-[#2B2B2B] disabled:opacity-50">
                      <Send className="h-3.5 w-3.5" /> {submitting ? "Sending..." : "Send Response"}
                    </button>
                    <button onClick={() => { setResponding(null); setResponse(""); }} className="text-[#7A7A7A] text-sm hover:text-[#1A1A1A]">Cancel</button>
                  </div>
                </div>
              ) : (
                <button onClick={() => setResponding(c.id)} className="text-sm text-blue-600 hover:text-blue-800 font-medium">
                  {c.adminResponse ? "Update Response" : "Respond"}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
