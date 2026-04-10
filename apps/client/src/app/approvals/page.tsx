"use client";
import { useState } from "react";
import { useClientApprovals } from "@/lib/hooks/use-projects";
import { apiFetch } from "@/lib/api";
import { mutate } from "swr";

export default function ApprovalsPage() {
  const [filter, setFilter] = useState<string>("");
  const { data, isLoading } = useClientApprovals({ status: filter });
  const approvals = (data as any)?.data || [];
  const [responding, setResponding] = useState<string | null>(null);

  async function respond(id: string, status: string, note?: string) {
    setResponding(id);
    try {
      await apiFetch(`/client/approvals/${id}/respond`, {
        method: "PUT",
        body: JSON.stringify({ status, clientNote: note }),
      });
      mutate((key: string) => typeof key === "string" && key.includes("/client/approvals"), undefined, { revalidate: true });
    } catch (err: any) {
      alert(err.message);
    } finally {
      setResponding(null);
    }
  }

  const statusBadge: Record<string, string> = {
    PENDING: "bg-[#FFF3C4] text-[#1A1A1A]",
    APPROVED: "bg-[rgba(107,203,119,0.12)] text-[#6BCB77]",
    REJECTED: "bg-[rgba(231,76,60,0.1)] text-[#E74C3C]",
    REVISION_REQUESTED: "bg-[#FFF3C4] text-[#1A1A1A]",
  };

  return (
    <div className="space-y-6 crx-animate-fade">
      <div className="crx-animate-slide crx-delay-1">
        <h2 className="font-serif text-4xl font-light text-[#1A1A1A]">Approvals</h2>
        <p className="text-[#7A7A7A] mt-1">Review and respond to approval requests</p>
      </div>
      <div className="crx-animate-slide crx-delay-2 flex gap-2">
        {["", "PENDING", "APPROVED", "REJECTED"].map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition-all ${filter === s ? "bg-[#1A1A1A] text-white" : "bg-white text-[#7A7A7A] border border-[#E8E0D0] hover:bg-[#FEFCF7]"}`}
          >
            {s || "All"}
          </button>
        ))}
      </div>
      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <div className="h-8 w-8 border-2 border-[#E8E0D0] border-b-2 border-b-[#F5D547] rounded-full animate-spin" />
        </div>
      ) : approvals.length === 0 ? (
        <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] py-12 text-center text-[#7A7A7A]">No approvals found.</div>
      ) : (
        <div className="space-y-4">
          {approvals.map((a: any, idx: number) => (
            <div key={a.id} className={`crx-animate-slide crx-delay-${Math.min(idx + 3, 6)} bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] hover:shadow-[0_4px_24px_rgba(0,0,0,0.07)] transition-all`}>
              <div className="p-5">
                <div className="flex items-start justify-between">
                  <div className="flex items-start gap-3">
                    <div className="h-10 w-10 rounded-full flex-shrink-0 flex items-center justify-center text-white text-sm font-medium" style={{ background: "linear-gradient(135deg, #E8D5B7, #B8956A)" }}>
                      {(a.requestedBy?.name || "?").charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <p className="font-medium text-[#1A1A1A]">{a.title}</p>
                      <p className="text-sm text-[#7A7A7A]">{a.project?.name}</p>
                      {a.description && <p className="text-sm mt-1 text-[#1A1A1A]">{a.description}</p>}
                      {a.fileUrl && (
                        <a href={a.fileUrl} target="_blank" rel="noopener noreferrer" className="text-sm text-[#1A1A1A] underline mt-1 block font-medium hover:text-[#F5D547] transition-colors">View Attachment</a>
                      )}
                      <p className="text-xs text-[#B0B0B0] mt-2">Requested by {a.requestedBy?.name}</p>
                    </div>
                  </div>
                  <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${statusBadge[a.status] || "bg-[#FFF3C4] text-[#1A1A1A]"}`}>{a.status?.replace("_", " ")}</span>
                </div>
                {a.status === "PENDING" && (
                  <div className="flex gap-2 mt-4 ml-[52px]">
                    <button onClick={() => respond(a.id, "APPROVED")} disabled={responding === a.id} className="px-5 py-2 text-sm font-medium bg-[#F5D547] text-[#1A1A1A] rounded-full shadow-[0_4px_16px_rgba(245,213,71,0.35)] hover:shadow-[0_6px_24px_rgba(245,213,71,0.45)] disabled:opacity-50 transition-all">Approve</button>
                    <button onClick={() => respond(a.id, "REVISION_REQUESTED", "Please revise")} disabled={responding === a.id} className="px-5 py-2 text-sm font-medium bg-[#1A1A1A] text-white rounded-full hover:bg-[#2B2B2B] disabled:opacity-50 transition-colors">Request Revision</button>
                    <button onClick={() => respond(a.id, "REJECTED", "Not approved")} disabled={responding === a.id} className="px-5 py-2 text-sm font-medium border border-[#E8E0D0] rounded-full text-[#E74C3C] hover:bg-[rgba(231,76,60,0.05)] disabled:opacity-50 transition-colors">Reject</button>
                  </div>
                )}
                {a.clientNote && <p className="text-sm mt-3 ml-[52px] p-3 bg-[#FEFCF7] rounded-2xl border border-[#F0EAD8] text-[#1A1A1A]">Note: {a.clientNote}</p>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
