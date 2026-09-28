"use client";

import { useState } from "react";
import { apiFetch, API_BASE } from "@/lib/api";
import useSWR from "swr";
import { FileCheck, Image, CalendarOff, Check, X, Clock, History, CheckSquare } from "lucide-react";
import { useAuth } from "@/lib/auth";


type Tab = "documents" | "pictures" | "leave";
type LeaveFilter = "PENDING" | "APPROVED" | "REJECTED";

export default function ApprovalsPage() {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<Tab>("documents");
  const [leaveFilter, setLeaveFilter] = useState<LeaveFilter>("PENDING");

  // Bulk selection state per tab
  const [selectedDocs, setSelectedDocs] = useState<Set<string>>(new Set());
  const [selectedPics, setSelectedPics] = useState<Set<string>>(new Set());
  const [selectedLeaves, setSelectedLeaves] = useState<Set<string>>(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);

  const { data: docsData, mutate: mutateDocs } = useSWR(
    "/admin/documents/pending",
    (url: string) => apiFetch<any>(url)
  );
  const { data: picsData, mutate: mutatePics } = useSWR(
    "/admin/profile-pictures/pending",
    (url: string) => apiFetch<any>(url)
  );
  const { data: pendingLeaveData, mutate: mutatePendingLeave } = useSWR(
    "/admin/leave-requests?status=PENDING",
    (url: string) => apiFetch<any>(url)
  );
  const { data: leaveData, mutate: mutateLeave } = useSWR(
    `/admin/leave-requests?status=${leaveFilter}`,
    (url: string) => apiFetch<any>(url)
  );

  const docs = docsData?.data || [];
  const pics = picsData?.data || [];
  const pendingLeaves = pendingLeaveData?.data || [];
  const leaves = leaveData?.data || [];

  async function reviewDocument(id: string, status: "APPROVED" | "REJECTED") {
    try {
      await apiFetch(`/admin/documents/${id}/review`, {
        method: "POST",
        body: JSON.stringify({ status }),
      });
      mutateDocs();
    } catch (e: any) {
      alert(e.message || "Failed to review document");
    }
  }

  async function reviewPicture(id: string, action: "approve" | "reject") {
    try {
      await apiFetch(`/admin/profile-pictures/${id}/${action}`, { method: "POST" });
      mutatePics();
    } catch (e: any) {
      alert(e.message || "Failed to review picture");
    }
  }

  async function reviewLeave(id: string, action: "approve" | "reject") {
    try {
      await apiFetch(`/admin/leave-requests/${id}/${action}`, { method: "POST" });
      mutateLeave();
      mutatePendingLeave();
    } catch (e: any) {
      alert(e.message || "Failed to review leave request");
    }
  }

  async function bulkAction(
    tab: Tab,
    action: "APPROVE" | "REJECT",
  ) {
    setBulkLoading(true);
    try {
      if (tab === "documents") {
        await apiFetch("/admin/documents/bulk-review", {
          method: "POST",
          body: JSON.stringify({ ids: Array.from(selectedDocs), action }),
        });
        setSelectedDocs(new Set());
        mutateDocs();
      } else if (tab === "pictures") {
        await apiFetch("/admin/profile-pictures/bulk-review", {
          method: "POST",
          body: JSON.stringify({ ids: Array.from(selectedPics), action }),
        });
        setSelectedPics(new Set());
        mutatePics();
      } else {
        await apiFetch("/admin/leave-requests/bulk", {
          method: "POST",
          body: JSON.stringify({ ids: Array.from(selectedLeaves), action }),
        });
        setSelectedLeaves(new Set());
        mutateLeave();
        mutatePendingLeave();
      }
    } catch (e: any) {
      alert(e.message || "Bulk action failed");
    } finally {
      setBulkLoading(false);
    }
  }

  function toggleDoc(id: string) {
    setSelectedDocs((prev) => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });
  }
  function toggleAllDocs() {
    setSelectedDocs(selectedDocs.size === docs.length ? new Set() : new Set(docs.map((d: any) => d.id)));
  }
  function togglePic(id: string) {
    setSelectedPics((prev) => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });
  }
  function toggleLeave(id: string) {
    setSelectedLeaves((prev) => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });
  }
  function toggleAllLeaves(pool: any[]) {
    setSelectedLeaves(selectedLeaves.size === pool.length ? new Set() : new Set(pool.map((l: any) => l.id)));
  }

  const tabs: { key: Tab; label: string; icon: typeof FileCheck; count: number }[] = [
    { key: "documents", label: "Documents", icon: FileCheck, count: docs.length },
    { key: "pictures", label: "Profile Pictures", icon: Image, count: pics.length },
    { key: "leave", label: "Leave Requests", icon: CalendarOff, count: pendingLeaves.length },
  ];

  const BulkBar = ({ tab, count }: { tab: Tab; count: number }) =>
    count > 0 ? (
      <div className="sticky bottom-4 z-10 flex items-center gap-3 bg-action text-[#06121B] px-5 py-3 rounded-2xl shadow-lg w-fit mx-auto">
        <CheckSquare size={16} className="text-action" />
        <span className="text-sm font-medium">{count} selected</span>
        <button
          disabled={bulkLoading}
          onClick={() => bulkAction(tab, "APPROVE")}
          className="flex items-center gap-1.5 bg-[rgba(107,203,119,0.2)] text-success px-4 py-1.5 rounded-full text-xs font-semibold hover:bg-[rgba(107,203,119,0.35)] transition-colors disabled:opacity-50"
        >
          <Check size={13} /> Approve Selected
        </button>
        <button
          disabled={bulkLoading}
          onClick={() => bulkAction(tab, "REJECT")}
          className="flex items-center gap-1.5 bg-[rgba(231,76,60,0.2)] text-danger px-4 py-1.5 rounded-full text-xs font-semibold hover:bg-[rgba(231,76,60,0.35)] transition-colors disabled:opacity-50"
        >
          <X size={13} /> Reject Selected
        </button>
      </div>
    ) : null;

  return (
    <div className="space-y-6 crx-animate-fade">
      <h1 className="font-serif text-4xl font-light text-ink">Approvals</h1>

      {/* Tab Navigation — scrolls horizontally on phones like the Accounts tabs */}
      <div className="flex gap-2 border-b border-border overflow-x-auto">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-2 px-3 sm:px-5 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                activeTab === tab.key
                  ? "border-action text-ink"
                  : "border-transparent text-ink-3 hover:text-ink"
              }`}
            >
              <Icon size={16} />
              {tab.label}
              {tab.count > 0 && (
                <span className="ml-1 bg-[rgba(245,213,71,0.25)] text-gold text-xs font-semibold rounded-full px-2 py-0.5">
                  {tab.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Documents Tab */}
      {activeTab === "documents" && (
        <div className="space-y-4">
          <div className="bg-surface rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-border">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="p-4 w-10">
                      <input
                        type="checkbox"
                        checked={docs.length > 0 && selectedDocs.size === docs.length}
                        onChange={toggleAllDocs}
                        className="accent-[#1A1A1A] w-4 h-4 cursor-pointer"
                      />
                    </th>
                    <th className="text-left p-4 text-ink-3 text-xs font-medium">Employee</th>
                    <th className="text-left p-4 text-ink-3 text-xs font-medium">Document Type</th>
                    <th className="text-left p-4 text-ink-3 text-xs font-medium">Filename</th>
                    <th className="text-left p-4 text-ink-3 text-xs font-medium">Upload Date</th>
                    <th className="text-left p-4 text-ink-3 text-xs font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {docs.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="p-8 text-center text-ink-3">
                        <FileCheck size={24} className="mx-auto mb-2 opacity-30" />
                        No documents pending review
                      </td>
                    </tr>
                  ) : (
                    docs.map((doc: any) => (
                      <tr key={doc.id} className="border-b border-border last:border-0 hover:bg-[rgba(255,248,225,0.5)] transition-colors">
                        <td className="p-4">
                          <input
                            type="checkbox"
                            checked={selectedDocs.has(doc.id)}
                            onChange={() => toggleDoc(doc.id)}
                            className="accent-[#1A1A1A] w-4 h-4 cursor-pointer"
                          />
                        </td>
                        <td className="p-4 text-ink font-medium">{doc.employeeName || doc.employee?.name || "—"}</td>
                        <td className="p-4 text-ink">{doc.documentType || doc.type || "—"}</td>
                        <td className="p-4 text-ink">{doc.filename || doc.originalName || "—"}</td>
                        <td className="p-4 text-ink-3">{doc.uploadedAt ? new Date(doc.uploadedAt).toLocaleDateString() : "—"}</td>
                        <td className="p-4">
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => reviewDocument(doc.id, "APPROVED")}
                              className="flex items-center gap-1 rounded-full bg-[rgba(107,203,119,0.12)] text-success px-3 py-1.5 text-xs font-medium hover:bg-[rgba(107,203,119,0.25)] transition-colors"
                            >
                              <Check size={13} /> Approve
                            </button>
                            <button
                              onClick={() => reviewDocument(doc.id, "REJECTED")}
                              className="flex items-center gap-1 rounded-full bg-[rgba(231,76,60,0.1)] text-danger px-3 py-1.5 text-xs font-medium hover:bg-[rgba(231,76,60,0.2)] transition-colors"
                            >
                              <X size={13} /> Reject
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
          <BulkBar tab="documents" count={selectedDocs.size} />
        </div>
      )}

      {/* Profile Pictures Tab */}
      {activeTab === "pictures" && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {pics.length === 0 ? (
              <div className="col-span-full bg-surface rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-border p-8 text-center text-ink-3">
                <Image size={24} className="mx-auto mb-2 opacity-30" />
                No profile pictures pending review
              </div>
            ) : (
              pics.map((pic: any) => (
                <div key={pic.id} className={`bg-surface rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border transition-all p-5 ${selectedPics.has(pic.id) ? "border-action ring-2 ring-[rgba(245,213,71,0.3)]" : "border-border"}`}>
                  <div className="flex items-center gap-2 mb-3">
                    <input
                      type="checkbox"
                      checked={selectedPics.has(pic.id)}
                      onChange={() => togglePic(pic.id)}
                      className="accent-[#1A1A1A] w-4 h-4 cursor-pointer"
                    />
                    <p className="font-medium text-ink">{pic.employeeName || pic.employee?.name || "Unknown"}</p>
                  </div>
                  <div className="flex gap-4 mb-4">
                    <div className="flex-1 text-center">
                      <p className="text-[10px] uppercase tracking-wider text-ink-3 mb-1.5">Current</p>
                      <div className="w-20 h-20 mx-auto rounded-full bg-muted overflow-hidden border-2 border-border">
                        {pic.employee?.profileImageUrl ? (
                          <img src={pic.employee.profileImageUrl.startsWith("http") ? pic.employee.profileImageUrl : `${API_BASE}${pic.employee.profileImageUrl}`} alt="Current" className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-ink-4 text-xs">None</div>
                        )}
                      </div>
                    </div>
                    <div className="flex-1 text-center">
                      <p className="text-[10px] uppercase tracking-wider text-ink-3 mb-1.5">New</p>
                      <div className="w-20 h-20 mx-auto rounded-full bg-muted overflow-hidden border-2 border-action">
                        {pic.filePath ? (
                          <img src={pic.filePath.startsWith("http") ? pic.filePath : `${API_BASE}${pic.filePath}`} alt="New" className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-ink-4 text-xs">—</div>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => reviewPicture(pic.id, "approve")}
                      className="flex-1 flex items-center justify-center gap-1 rounded-full bg-[rgba(107,203,119,0.12)] text-success py-2 text-xs font-medium hover:bg-[rgba(107,203,119,0.25)] transition-colors"
                    >
                      <Check size={13} /> Approve
                    </button>
                    <button
                      onClick={() => reviewPicture(pic.id, "reject")}
                      className="flex-1 flex items-center justify-center gap-1 rounded-full bg-[rgba(231,76,60,0.1)] text-danger py-2 text-xs font-medium hover:bg-[rgba(231,76,60,0.2)] transition-colors"
                    >
                      <X size={13} /> Reject
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
          <BulkBar tab="pictures" count={selectedPics.size} />
        </div>
      )}

      {/* Leave Requests Tab */}
      {activeTab === "leave" && (
        <div className="space-y-4">
          {/* Status Filter Pills */}
          <div className="flex items-center gap-2 p-1 bg-surface rounded-xl border border-border w-fit">
            {([
              { key: "PENDING" as LeaveFilter, label: "Pending", icon: Clock, count: pendingLeaves.length as number | undefined },
              { key: "APPROVED" as LeaveFilter, label: "Approved", icon: Check, count: undefined as number | undefined },
              { key: "REJECTED" as LeaveFilter, label: "Rejected", icon: X, count: undefined as number | undefined },
            ]).map((f) => {
              const Icon = f.icon;
              const isActive = leaveFilter === f.key;
              return (
                <button
                  key={f.key}
                  onClick={() => { setLeaveFilter(f.key); setSelectedLeaves(new Set()); }}
                  className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium transition-all ${
                    isActive
                      ? "bg-gradient-to-r from-indigo to-indigo text-white shadow-[0_2px_8px_rgba(91,75,245,0.25)]"
                      : "text-ink-3 hover:bg-muted hover:text-ink"
                  }`}
                >
                  <Icon size={13} />
                  {f.label}
                  {f.count !== undefined && f.count > 0 && (
                    <span className={`ml-1 text-[10px] font-semibold rounded-full px-1.5 py-0.5 ${isActive ? "bg-surface/20" : "bg-[rgba(245,213,71,0.25)] text-gold"}`}>
                      {f.count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <div className="bg-surface rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-border">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    {leaveFilter === "PENDING" && (
                      <th className="p-4 w-10">
                        <input
                          type="checkbox"
                          checked={leaves.length > 0 && selectedLeaves.size === leaves.length}
                          onChange={() => toggleAllLeaves(leaves)}
                          className="accent-[#1A1A1A] w-4 h-4 cursor-pointer"
                        />
                      </th>
                    )}
                    <th className="text-left p-4 text-ink-3 text-xs font-medium">Employee</th>
                    <th className="text-left p-4 text-ink-3 text-xs font-medium">Date Range</th>
                    <th className="text-left p-4 text-ink-3 text-xs font-medium">Type</th>
                    <th className="text-left p-4 text-ink-3 text-xs font-medium">Reason</th>
                    <th className="text-left p-4 text-ink-3 text-xs font-medium">
                      {leaveFilter === "PENDING" ? "Actions" : "Status"}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {leaves.length === 0 ? (
                    <tr>
                      <td colSpan={leaveFilter === "PENDING" ? 6 : 5} className="p-8 text-center text-ink-3">
                        {leaveFilter === "PENDING" ? <Clock size={24} className="mx-auto mb-2 opacity-30" /> : <History size={24} className="mx-auto mb-2 opacity-30" />}
                        No {leaveFilter.toLowerCase()} leave requests
                      </td>
                    </tr>
                  ) : (
                    leaves.map((leave: any) => (
                      <tr key={leave.id} className="border-b border-border last:border-0 hover:bg-[rgba(255,248,225,0.5)] transition-colors">
                        {leaveFilter === "PENDING" && (
                          <td className="p-4">
                            <input
                              type="checkbox"
                              checked={selectedLeaves.has(leave.id)}
                              onChange={() => toggleLeave(leave.id)}
                              className="accent-[#1A1A1A] w-4 h-4 cursor-pointer"
                            />
                          </td>
                        )}
                        <td className="p-4 text-ink font-medium">{leave.employeeName || leave.employee?.name || "—"}</td>
                        <td className="p-4 text-ink">
                          {leave.startDate ? new Date(leave.startDate).toLocaleDateString() : "—"}
                          {" — "}
                          {leave.endDate ? new Date(leave.endDate).toLocaleDateString() : "—"}
                        </td>
                        <td className="p-4">
                          <span className="rounded-full bg-[rgba(245,213,71,0.15)] text-gold px-3 py-1 text-xs font-medium">
                            {leave.leaveType || leave.type || "—"}
                          </span>
                        </td>
                        <td className="p-4 text-ink-3 max-w-[200px] truncate">{leave.reason || "—"}</td>
                        <td className="p-4">
                          {leaveFilter === "PENDING" ? (
                            <div className="flex items-center gap-2">
                              {leave.employeeId === user?.id ? (
                                <span className="text-xs text-ink-4 italic">Self-approval not allowed</span>
                              ) : (
                                <>
                                  <button
                                    onClick={() => reviewLeave(leave.id, "approve")}
                                    className="flex items-center gap-1 rounded-full bg-[rgba(107,203,119,0.12)] text-success px-3 py-1.5 text-xs font-medium hover:bg-[rgba(107,203,119,0.25)] transition-colors"
                                  >
                                    <Check size={13} /> Approve
                                  </button>
                                  <button
                                    onClick={() => reviewLeave(leave.id, "reject")}
                                    className="flex items-center gap-1 rounded-full bg-[rgba(231,76,60,0.1)] text-danger px-3 py-1.5 text-xs font-medium hover:bg-[rgba(231,76,60,0.2)] transition-colors"
                                  >
                                    <X size={13} /> Reject
                                  </button>
                                </>
                              )}
                            </div>
                          ) : (
                            <div className="flex flex-col gap-0.5">
                              <span className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium w-fit ${
                                leaveFilter === "APPROVED" ? "bg-[rgba(107,203,119,0.15)] text-success" : "bg-[rgba(231,76,60,0.1)] text-danger"
                              }`}>
                                {leaveFilter === "APPROVED" ? <Check size={12} /> : <X size={12} />}
                                {leaveFilter}
                              </span>
                              {leave.approvedAt && (
                                <span className="text-[10px] text-ink-4 mt-1">
                                  on {new Date(leave.approvedAt).toLocaleDateString()}
                                </span>
                              )}
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
          {leaveFilter === "PENDING" && <BulkBar tab="leave" count={selectedLeaves.size} />}
        </div>
      )}
    </div>
  );
}
