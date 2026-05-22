"use client";
import { useState } from "react";
import useSWR from "swr";
import { CalendarOff, Check, X, Clock, Paperclip } from "lucide-react";
import { apiFetch, API_BASE } from "@/lib/api";
import { formatStatus } from "@dashmani/shared";
import { usePageTitle } from "@/lib/hooks/use-page-title";

const STATUS_TABS = ["ALL", "PENDING", "APPROVED", "REJECTED"] as const;
type StatusTab = typeof STATUS_TABS[number];

const statusColors: Record<string, string> = {
  PENDING: "bg-yellow-50 text-yellow-700 border border-yellow-200",
  APPROVED: "bg-green-50 text-green-700 border border-green-200",
  REJECTED: "bg-red-50 text-red-700 border border-red-200",
};

const typeColors: Record<string, string> = {
  CASUAL: "bg-blue-50 text-blue-700",
  SICK: "bg-orange-50 text-orange-700",
  EARNED: "bg-purple-50 text-purple-700",
};

function formatDateRange(start: string, end?: string) {
  const s = new Date(start).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  if (!end || end === start) return s;
  const e = new Date(end).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  return `${s} — ${e}`;
}

export default function LeavePage() {
  usePageTitle("Leave");
  const [tab, setTab] = useState<StatusTab>("PENDING");
  const [actioning, setActioning] = useState<string | null>(null);

  const query = tab === "ALL" ? "" : `?status=${tab}`;
  const { data, mutate } = useSWR(`/admin/leave-requests${query}`, (url: string) => apiFetch<any>(url), {
    revalidateOnFocus: true,
  });
  const leaves: any[] = data?.data || [];

  async function approve(id: string) {
    setActioning(id);
    try {
      await apiFetch(`/admin/leave-requests/${id}/approve`, { method: "POST" });
      mutate();
    } catch (e: any) { alert(e.message); }
    setActioning(null);
  }

  async function reject(id: string) {
    setActioning(id);
    try {
      await apiFetch(`/admin/leave-requests/${id}/reject`, { method: "POST" });
      mutate();
    } catch (e: any) { alert(e.message); }
    setActioning(null);
  }

  const pendingCount = leaves.filter((l) => l.status === "PENDING").length;

  return (
    <div className="space-y-6 crx-animate-fade">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-serif text-4xl font-light text-ink">Leave Requests</h1>
          <p className="text-sm text-ink-3 mt-1">Approve or reject employee leave applications</p>
        </div>
        {pendingCount > 0 && (
          <div className="flex items-center gap-2 bg-attention/10 px-4 py-2 rounded-full">
            <Clock className="h-4 w-4 text-attention" />
            <span className="text-sm font-semibold text-ink">{pendingCount} Pending</span>
          </div>
        )}
      </div>

      {/* Status tabs */}
      <div className="flex gap-2 flex-wrap">
        {STATUS_TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 rounded-full text-sm font-medium transition-all ${
              tab === t ? "bg-ink text-white" : "bg-white text-ink-3 border border-ink/10 hover:bg-muted"
            }`}
          >
            {t === "ALL" ? "All" : formatStatus(t)}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="v3-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-ink/8">
                <th className="text-left p-4 text-ink-4 text-xs font-semibold uppercase tracking-wide">Employee</th>
                <th className="text-left p-4 text-ink-4 text-xs font-semibold uppercase tracking-wide">Type</th>
                <th className="text-left p-4 text-ink-4 text-xs font-semibold uppercase tracking-wide">Dates</th>
                <th className="text-left p-4 text-ink-4 text-xs font-semibold uppercase tracking-wide">Reason</th>
                <th className="text-left p-4 text-ink-4 text-xs font-semibold uppercase tracking-wide">Attachment</th>
                <th className="text-left p-4 text-ink-4 text-xs font-semibold uppercase tracking-wide">Status</th>
                <th className="text-left p-4 text-ink-4 text-xs font-semibold uppercase tracking-wide">Actions</th>
              </tr>
            </thead>
            <tbody>
              {leaves.length === 0 ? (
                <tr>
                  <td colSpan={7} className="p-10 text-center text-ink-3">
                    <CalendarOff className="h-8 w-8 mx-auto mb-2 opacity-30" />
                    No leave requests found
                  </td>
                </tr>
              ) : leaves.map((leave: any) => (
                <tr key={leave.id} className="border-b border-ink/5 last:border-0 hover:bg-muted/40">
                  <td className="p-4">
                    <p className="font-semibold text-ink">{leave.employee?.name || "—"}</p>
                    <p className="text-xs text-ink-4">{leave.employee?.email || ""}</p>
                  </td>
                  <td className="p-4">
                    <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${typeColors[leave.type] || "bg-muted text-ink-3"}`}>
                      {leave.type}
                    </span>
                  </td>
                  <td className="p-4 text-ink-3 text-xs whitespace-nowrap">
                    {formatDateRange(leave.startDate, leave.endDate)}
                  </td>
                  <td className="p-4 text-ink-3 max-w-[200px]">
                    <p className="truncate">{leave.reason || "—"}</p>
                  </td>
                  <td className="p-4">
                    {leave.attachmentUrl ? (
                      <a
                        href={`${API_BASE}${leave.attachmentUrl}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 text-xs text-indigo font-medium hover:underline"
                      >
                        <Paperclip size={12} />
                        {leave.attachmentName || "View"}
                      </a>
                    ) : (
                      <span className="text-xs text-ink-4">—</span>
                    )}
                  </td>
                  <td className="p-4">
                    <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${statusColors[leave.status] || "bg-muted text-ink-3"}`}>
                      {formatStatus(leave.status)}
                    </span>
                  </td>
                  <td className="p-4">
                    {leave.status === "PENDING" ? (
                      <div className="flex gap-2">
                        <button
                          onClick={() => approve(leave.id)}
                          disabled={actioning === leave.id}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-sage text-white rounded-full text-xs font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
                        >
                          <Check className="h-3.5 w-3.5" />
                          Approve
                        </button>
                        <button
                          onClick={() => reject(leave.id)}
                          disabled={actioning === leave.id}
                          className="flex items-center gap-1.5 px-3 py-1.5 bg-terra text-white rounded-full text-xs font-medium hover:opacity-90 disabled:opacity-50 transition-opacity"
                        >
                          <X className="h-3.5 w-3.5" />
                          Reject
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs text-ink-4">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
