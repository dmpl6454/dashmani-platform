"use client";
import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useClientContentPost } from "@/lib/hooks/use-content";
import { apiFetch } from "@/lib/api";

const STATUS_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  PENDING_APPROVAL: "Pending Your Approval",
  APPROVED: "Approved",
  SCHEDULED: "Scheduled",
  PUBLISHED: "Published",
  FAILED: "Failed",
  REJECTED: "Rejected",
};

const STATUS_COLOR: Record<string, string> = {
  DRAFT: "bg-[#FFF3C4] text-[#1A1A1A]",
  PENDING_APPROVAL: "bg-[#FFF3C4] text-[#1A1A1A]",
  APPROVED: "bg-[rgba(107,203,119,0.12)] text-[#6BCB77]",
  SCHEDULED: "bg-[rgba(52,152,219,0.12)] text-[#3498DB]",
  PUBLISHED: "bg-[rgba(107,203,119,0.12)] text-[#6BCB77]",
  FAILED: "bg-[rgba(231,76,60,0.1)] text-[#E74C3C]",
  REJECTED: "bg-[rgba(231,76,60,0.1)] text-[#E74C3C]",
};

export default function ClientContentDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const { data, isLoading, mutate } = useClientContentPost(id as string);
  const [responding, setResponding] = useState(false);

  if (isLoading) return (
    <div className="flex items-center justify-center py-12">
      <div className="h-8 w-8 border-2 border-[#E8E0D0] border-b-2 border-b-[#F5D547] rounded-full animate-spin" />
    </div>
  );
  const post = (data as any)?.data;
  if (!post) return <div className="py-8 text-center text-[#7A7A7A]">Content not found</div>;

  async function handleRespond(status: "APPROVED" | "REJECTED") {
    setResponding(true);
    try {
      await apiFetch(`/client/content/${id}/respond`, {
        method: "PUT",
        body: JSON.stringify({ status }),
      });
      mutate();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setResponding(false);
    }
  }

  return (
    <div className="max-w-3xl space-y-6 crx-animate-fade">
      <div className="crx-animate-slide crx-delay-1 flex items-start justify-between">
        <div>
          <h2 className="font-serif text-4xl font-light text-[#1A1A1A]">{post.title}</h2>
          <div className="flex gap-2 mt-3">
            <span className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${STATUS_COLOR[post.status] || "bg-[#FFF3C4] text-[#1A1A1A]"}`}>
              {STATUS_LABELS[post.status] || post.status}
            </span>
          </div>
        </div>
        <button onClick={() => router.push("/content")} className="px-5 py-2 text-sm font-medium border border-[#E8E0D0] rounded-full text-[#1A1A1A] hover:bg-[#FEFCF7] transition-colors">Back</button>
      </div>

      <div className="crx-animate-slide crx-delay-2 bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0]">
        <div className="p-6 space-y-4">
          {post.caption && (
            <div>
              <h4 className="text-sm font-medium text-[#7A7A7A] mb-1">Caption</h4>
              <p className="text-sm whitespace-pre-wrap text-[#1A1A1A]">{post.caption}</p>
            </div>
          )}
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div className="p-4 bg-[#FEFCF7] rounded-2xl border border-[#F0EAD8]">
              <span className="text-[#7A7A7A] text-xs">Project</span>
              <p className="text-[#1A1A1A] font-medium mt-0.5">{post.project?.name}</p>
            </div>
            <div className="p-4 bg-[#FEFCF7] rounded-2xl border border-[#F0EAD8]">
              <span className="text-[#7A7A7A] text-xs">Account</span>
              <p className="text-[#1A1A1A] font-medium mt-0.5">{post.account ? `${post.account.platform?.name}: ${post.account.handle}` : "--"}</p>
            </div>
            <div className="p-4 bg-[#FEFCF7] rounded-2xl border border-[#F0EAD8]">
              <span className="text-[#7A7A7A] text-xs">Scheduled</span>
              <p className="text-[#1A1A1A] font-medium mt-0.5">{post.scheduledAt ? new Date(post.scheduledAt).toLocaleString() : "--"}</p>
            </div>
            <div className="p-4 bg-[#FEFCF7] rounded-2xl border border-[#F0EAD8]">
              <span className="text-[#7A7A7A] text-xs">Created by</span>
              <p className="text-[#1A1A1A] font-medium mt-0.5">{post.createdBy?.name}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Media */}
      {post.mediaUrls?.length > 0 && (
        <div className="crx-animate-slide crx-delay-3 bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0]">
          <div className="p-5 border-b border-[#F0EAD8]">
            <h3 className="font-serif text-lg text-[#1A1A1A]">Media ({post.mediaUrls.length})</h3>
          </div>
          <div className="p-5">
            <div className="grid grid-cols-2 gap-3">
              {post.mediaUrls.map((url: string, i: number) => (
                <div key={i} className="border border-[#E8E0D0] rounded-2xl overflow-hidden hover:shadow-[0_4px_24px_rgba(0,0,0,0.07)] transition-shadow">
                  <img
                    src={url}
                    alt={`Media ${i + 1}`}
                    className="w-full h-40 object-cover"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = "none";
                      (e.target as HTMLImageElement).parentElement!.innerHTML = `<div class="flex items-center justify-center h-40 bg-[#FEFCF7] text-xs text-[#7A7A7A] p-2 break-all">${url}</div>`;
                    }}
                  />
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block p-2 text-xs text-[#1A1A1A] hover:text-[#F5D547] hover:underline truncate transition-colors"
                  >
                    {url}
                  </a>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Approve / Reject */}
      {post.status === "PENDING_APPROVAL" && (
        <div className="crx-animate-slide crx-delay-4 bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0]">
          <div className="p-5 border-b border-[#F0EAD8]">
            <h3 className="font-serif text-lg text-[#1A1A1A]">Your Review</h3>
          </div>
          <div className="p-5">
            <p className="text-sm text-[#7A7A7A] mb-4">
              This content is waiting for your approval before it can be scheduled for publishing.
            </p>
            <div className="flex gap-3">
              <button onClick={() => handleRespond("APPROVED")} disabled={responding} className="px-6 py-2.5 text-sm font-medium bg-[#F5D547] text-[#1A1A1A] rounded-full shadow-[0_4px_16px_rgba(245,213,71,0.35)] hover:shadow-[0_6px_24px_rgba(245,213,71,0.45)] disabled:opacity-50 transition-all">
                {responding ? "..." : "Approve"}
              </button>
              <button onClick={() => handleRespond("REJECTED")} disabled={responding} className="px-6 py-2.5 text-sm font-medium border border-[#E8E0D0] rounded-full text-[#1A1A1A] hover:bg-[#FEFCF7] disabled:opacity-50 transition-colors">
                {responding ? "..." : "Reject"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
