"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import useSWR from "swr";
import { Bug } from "lucide-react";

const severityColors: Record<string, string> = {
  LOW: "bg-blue-50 text-blue-700", MEDIUM: "bg-yellow-50 text-yellow-700",
  HIGH: "bg-orange-50 text-orange-700", CRITICAL: "bg-red-50 text-red-700",
};
const statusColors: Record<string, string> = {
  OPEN: "bg-red-50 text-red-700", IN_PROGRESS: "bg-yellow-50 text-yellow-700",
  RESOLVED: "bg-green-50 text-green-700", CLOSED: "bg-gray-100 text-gray-700",
  WONT_FIX: "bg-gray-100 text-gray-600",
};

export default function BugReportsPage() {
  const [statusFilter, setStatusFilter] = useState("");
  const { data, mutate } = useSWR(
    `/admin/bug-reports${statusFilter ? `?status=${statusFilter}` : ""}`,
    (url: string) => apiFetch<any>(url)
  );
  const bugs = data?.data || [];
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [resolution, setResolution] = useState("");

  async function updateStatus(id: string, status: string) {
    try {
      await apiFetch(`/admin/bug-reports/${id}/status`, {
        method: "POST",
        body: JSON.stringify({ status, resolution: resolution || undefined }),
      });
      setResolution("");
      mutate();
    } catch (e: any) { alert(e.message); }
  }

  return (
    <div className="space-y-6 crx-animate-fade">
      <div className="flex items-center justify-between">
        <h1 className="font-serif text-4xl font-light text-[#1A1A1A]">Bug Reports</h1>
        <div className="flex gap-2">
          {["", "OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"].map((s) => (
            <button key={s} onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${statusFilter === s ? "bg-[#1A1A1A] text-white" : "bg-white text-[#7A7A7A] border border-[#E8E0D0] hover:border-[#F5D547]"}`}
            >{s || "All"}</button>
          ))}
        </div>
      </div>

      <div className="space-y-4">
        {bugs.length === 0 ? (
          <div className="bg-white rounded-2xl border border-[#E8E0D0] p-8 text-center text-[#7A7A7A]">
            <Bug size={24} className="mx-auto mb-2 opacity-30" />No bug reports
          </div>
        ) : bugs.map((bug: any) => (
          <div key={bug.id} className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0] overflow-hidden">
            <div className="p-5 cursor-pointer hover:bg-[#FEFCF7] transition-colors" onClick={() => setExpandedId(expandedId === bug.id ? null : bug.id)}>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="font-semibold text-[#1A1A1A]">{bug.title}</h3>
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${severityColors[bug.severity] || ""}`}>{bug.severity}</span>
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${statusColors[bug.status] || ""}`}>{bug.status}</span>
                  </div>
                  <p className="text-xs text-[#7A7A7A]">by {bug.reporter?.name} · {new Date(bug.createdAt).toLocaleDateString()} {bug.page ? `· Page: ${bug.page}` : ""}</p>
                </div>
              </div>
            </div>
            {expandedId === bug.id && (
              <div className="border-t border-[#E8E0D0] p-5 bg-[#FEFCF7] space-y-3">
                <p className="text-sm text-[#555] whitespace-pre-line">{bug.description}</p>
                {bug.resolution && <div className="bg-green-50 rounded-lg p-3 text-sm"><strong>Resolution:</strong> {bug.resolution}</div>}
                <div className="flex items-center gap-3">
                  <input
                    type="text" placeholder="Resolution note (optional)" value={resolution}
                    onChange={(e) => setResolution(e.target.value)}
                    className="flex-1 border border-[#E8E0D0] rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[#F5D547]"
                  />
                  {bug.status === "OPEN" && (
                    <button onClick={() => updateStatus(bug.id, "IN_PROGRESS")} className="rounded-full bg-yellow-50 text-yellow-700 px-3 py-1.5 text-xs font-medium hover:bg-yellow-100">In Progress</button>
                  )}
                  {(bug.status === "OPEN" || bug.status === "IN_PROGRESS") && (
                    <>
                      <button onClick={() => updateStatus(bug.id, "RESOLVED")} className="rounded-full bg-green-50 text-green-700 px-3 py-1.5 text-xs font-medium hover:bg-green-100">Resolve</button>
                      <button onClick={() => updateStatus(bug.id, "WONT_FIX")} className="rounded-full bg-gray-100 text-gray-600 px-3 py-1.5 text-xs font-medium hover:bg-gray-200">Won't Fix</button>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
