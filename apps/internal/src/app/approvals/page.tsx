"use client";

import { useState } from "react";
import { apiFetch, API_BASE } from "@/lib/api";
import useSWR from "swr";
import { FileCheck, Image, CalendarOff, Check, X, Clock } from "lucide-react";


type Tab = "documents" | "pictures" | "leave";

export default function ApprovalsPage() {
  const [activeTab, setActiveTab] = useState<Tab>("documents");

  const { data: docsData, mutate: mutateDocs } = useSWR(
    "/admin/documents/pending",
    (url: string) => apiFetch<any>(url)
  );
  const { data: picsData, mutate: mutatePics } = useSWR(
    "/admin/profile-pictures/pending",
    (url: string) => apiFetch<any>(url)
  );
  const { data: leaveData, mutate: mutateLeave } = useSWR(
    "/admin/leave-requests?status=PENDING",
    (url: string) => apiFetch<any>(url)
  );

  const docs = docsData?.data || [];
  const pics = picsData?.data || [];
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
    } catch (e: any) {
      alert(e.message || "Failed to review leave request");
    }
  }

  const tabs: { key: Tab; label: string; icon: typeof FileCheck; count: number }[] = [
    { key: "documents", label: "Documents", icon: FileCheck, count: docs.length },
    { key: "pictures", label: "Profile Pictures", icon: Image, count: pics.length },
    { key: "leave", label: "Leave Requests", icon: CalendarOff, count: leaves.length },
  ];

  return (
    <div className="space-y-6 crx-animate-fade">
      <h1 className="font-serif text-4xl font-light text-[#1A1A1A]">Approvals</h1>

      {/* Tab Navigation */}
      <div className="flex gap-2 border-b border-[#E8E0D0]">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-2 px-5 py-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.key
                  ? "border-[#F5D547] text-[#1A1A1A]"
                  : "border-transparent text-[#7A7A7A] hover:text-[#1A1A1A]"
              }`}
            >
              <Icon size={16} />
              {tab.label}
              {tab.count > 0 && (
                <span className="ml-1 bg-[rgba(245,213,71,0.25)] text-[#B8960C] text-xs font-semibold rounded-full px-2 py-0.5">
                  {tab.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Documents Tab */}
      {activeTab === "documents" && (
        <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0]">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#F0EAD8]">
                  <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Employee</th>
                  <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Document Type</th>
                  <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Filename</th>
                  <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Upload Date</th>
                  <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {docs.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="p-8 text-center text-[#7A7A7A]">
                      <FileCheck size={24} className="mx-auto mb-2 opacity-30" />
                      No documents pending review
                    </td>
                  </tr>
                ) : (
                  docs.map((doc: any) => (
                    <tr key={doc.id} className="border-b border-[#F0EAD8] last:border-0 hover:bg-[rgba(255,248,225,0.5)] transition-colors">
                      <td className="p-4 text-[#1A1A1A] font-medium">{doc.employeeName || doc.employee?.name || "—"}</td>
                      <td className="p-4 text-[#1A1A1A]">{doc.documentType || doc.type || "—"}</td>
                      <td className="p-4 text-[#1A1A1A]">{doc.filename || doc.originalName || "—"}</td>
                      <td className="p-4 text-[#7A7A7A]">{doc.uploadedAt ? new Date(doc.uploadedAt).toLocaleDateString() : "—"}</td>
                      <td className="p-4">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => reviewDocument(doc.id, "APPROVED")}
                            className="flex items-center gap-1 rounded-full bg-[rgba(107,203,119,0.12)] text-[#2E7D32] px-3 py-1.5 text-xs font-medium hover:bg-[rgba(107,203,119,0.25)] transition-colors"
                          >
                            <Check size={13} /> Approve
                          </button>
                          <button
                            onClick={() => reviewDocument(doc.id, "REJECTED")}
                            className="flex items-center gap-1 rounded-full bg-[rgba(231,76,60,0.1)] text-[#E74C3C] px-3 py-1.5 text-xs font-medium hover:bg-[rgba(231,76,60,0.2)] transition-colors"
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
      )}

      {/* Profile Pictures Tab */}
      {activeTab === "pictures" && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {pics.length === 0 ? (
            <div className="col-span-full bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0] p-8 text-center text-[#7A7A7A]">
              <Image size={24} className="mx-auto mb-2 opacity-30" />
              No profile pictures pending review
            </div>
          ) : (
            pics.map((pic: any) => (
              <div key={pic.id} className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0] p-5">
                <p className="font-medium text-[#1A1A1A] mb-3">{pic.employeeName || pic.employee?.name || "Unknown"}</p>
                <div className="flex gap-4 mb-4">
                  <div className="flex-1 text-center">
                    <p className="text-[10px] uppercase tracking-wider text-[#7A7A7A] mb-1.5">Current</p>
                    <div className="w-20 h-20 mx-auto rounded-full bg-[#F0EAD8] overflow-hidden border-2 border-[#E8E0D0]">
                      {pic.employee?.profileImageUrl ? (
                        <img src={pic.employee.profileImageUrl.startsWith("http") ? pic.employee.profileImageUrl : `${API_BASE}${pic.employee.profileImageUrl}`} alt="Current" className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-[#B0B0B0] text-xs">None</div>
                      )}
                    </div>
                  </div>
                  <div className="flex-1 text-center">
                    <p className="text-[10px] uppercase tracking-wider text-[#7A7A7A] mb-1.5">New</p>
                    <div className="w-20 h-20 mx-auto rounded-full bg-[#F0EAD8] overflow-hidden border-2 border-[#F5D547]">
                      {pic.filePath ? (
                        <img src={pic.filePath.startsWith("http") ? pic.filePath : `${API_BASE}${pic.filePath}`} alt="New" className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center text-[#B0B0B0] text-xs">—</div>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => reviewPicture(pic.id, "approve")}
                    className="flex-1 flex items-center justify-center gap-1 rounded-full bg-[rgba(107,203,119,0.12)] text-[#2E7D32] py-2 text-xs font-medium hover:bg-[rgba(107,203,119,0.25)] transition-colors"
                  >
                    <Check size={13} /> Approve
                  </button>
                  <button
                    onClick={() => reviewPicture(pic.id, "reject")}
                    className="flex-1 flex items-center justify-center gap-1 rounded-full bg-[rgba(231,76,60,0.1)] text-[#E74C3C] py-2 text-xs font-medium hover:bg-[rgba(231,76,60,0.2)] transition-colors"
                  >
                    <X size={13} /> Reject
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* Leave Requests Tab */}
      {activeTab === "leave" && (
        <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#E8E0D0]">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#F0EAD8]">
                  <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Employee</th>
                  <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Date Range</th>
                  <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Type</th>
                  <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Reason</th>
                  <th className="text-left p-4 text-[#7A7A7A] text-xs font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {leaves.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="p-8 text-center text-[#7A7A7A]">
                      <Clock size={24} className="mx-auto mb-2 opacity-30" />
                      No leave requests pending
                    </td>
                  </tr>
                ) : (
                  leaves.map((leave: any) => (
                    <tr key={leave.id} className="border-b border-[#F0EAD8] last:border-0 hover:bg-[rgba(255,248,225,0.5)] transition-colors">
                      <td className="p-4 text-[#1A1A1A] font-medium">{leave.employeeName || leave.employee?.name || "—"}</td>
                      <td className="p-4 text-[#1A1A1A]">
                        {leave.startDate ? new Date(leave.startDate).toLocaleDateString() : "—"}
                        {" — "}
                        {leave.endDate ? new Date(leave.endDate).toLocaleDateString() : "—"}
                      </td>
                      <td className="p-4">
                        <span className="rounded-full bg-[rgba(245,213,71,0.15)] text-[#B8960C] px-3 py-1 text-xs font-medium">
                          {leave.leaveType || leave.type || "—"}
                        </span>
                      </td>
                      <td className="p-4 text-[#7A7A7A] max-w-[200px] truncate">{leave.reason || "—"}</td>
                      <td className="p-4">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => reviewLeave(leave.id, "approve")}
                            className="flex items-center gap-1 rounded-full bg-[rgba(107,203,119,0.12)] text-[#2E7D32] px-3 py-1.5 text-xs font-medium hover:bg-[rgba(107,203,119,0.25)] transition-colors"
                          >
                            <Check size={13} /> Approve
                          </button>
                          <button
                            onClick={() => reviewLeave(leave.id, "reject")}
                            className="flex items-center gap-1 rounded-full bg-[rgba(231,76,60,0.1)] text-[#E74C3C] px-3 py-1.5 text-xs font-medium hover:bg-[rgba(231,76,60,0.2)] transition-colors"
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
      )}
    </div>
  );
}
