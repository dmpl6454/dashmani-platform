"use client";
import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useContentPost } from "@/lib/hooks/use-content";
import { Button } from "@dashmani/ui";
import { ContentForm } from "@/components/content-form";
import { apiFetch } from "@/lib/api";

const STATUS_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  PENDING_APPROVAL: "Pending Approval",
  APPROVED: "Approved",
  SCHEDULED: "Scheduled",
  PUBLISHED: "Published",
  FAILED: "Failed",
  REJECTED: "Rejected",
};

const STATUS_BADGE: Record<string, string> = {
  DRAFT: "bg-[rgba(0,0,0,0.06)] text-[#7A7A7A]",
  PENDING_APPROVAL: "bg-[#FFF3C4] text-[#1A1A1A]",
  APPROVED: "bg-[rgba(107,203,119,0.12)] text-[#6BCB77]",
  SCHEDULED: "bg-[rgba(52,152,219,0.12)] text-[#3498DB]",
  PUBLISHED: "bg-[rgba(107,203,119,0.12)] text-[#6BCB77]",
  FAILED: "bg-[rgba(231,76,60,0.1)] text-[#E74C3C]",
  REJECTED: "bg-[rgba(231,76,60,0.1)] text-[#E74C3C]",
};

const STATUS_ACTIONS: Record<string, { label: string; status: string; variant: "default" | "outline" }[]> = {
  DRAFT: [
    { label: "Send for Approval", status: "PENDING_APPROVAL", variant: "default" },
    { label: "Schedule Directly", status: "SCHEDULED", variant: "outline" },
  ],
  PENDING_APPROVAL: [
    { label: "Back to Draft", status: "DRAFT", variant: "outline" },
  ],
  APPROVED: [
    { label: "Schedule", status: "SCHEDULED", variant: "default" },
    { label: "Back to Draft", status: "DRAFT", variant: "outline" },
  ],
  REJECTED: [
    { label: "Back to Draft", status: "DRAFT", variant: "outline" },
  ],
  SCHEDULED: [
    { label: "Mark Published", status: "PUBLISHED", variant: "default" },
    { label: "Mark Failed", status: "FAILED", variant: "outline" },
    { label: "Back to Draft", status: "DRAFT", variant: "outline" },
  ],
  FAILED: [
    { label: "Reschedule", status: "SCHEDULED", variant: "default" },
    { label: "Back to Draft", status: "DRAFT", variant: "outline" },
  ],
  PUBLISHED: [],
};

export default function ContentDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const { data, isLoading, mutate } = useContentPost(id as string);
  const [isEditing, setIsEditing] = useState(false);
  const [transitioning, setTransitioning] = useState(false);

  if (isLoading) return <div className="flex items-center justify-center h-64"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#F5D547]" /></div>;
  const post = (data as any)?.data;
  if (!post) return <div className="py-8 text-center text-[#7A7A7A]">Content not found</div>;

  async function handleStatusChange(newStatus: string) {
    setTransitioning(true);
    try {
      await apiFetch(`/content/${id}/status`, {
        method: "PUT",
        body: JSON.stringify({ status: newStatus }),
      });
      mutate();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setTransitioning(false);
    }
  }

  async function handleDelete() {
    if (!confirm("Are you sure you want to delete this content post?")) return;
    try {
      await apiFetch(`/content/${id}`, { method: "DELETE" });
      router.push("/content");
    } catch (err: any) {
      alert(err.message);
    }
  }

  if (isEditing) {
    return (
      <div className="max-w-2xl crx-animate-fade">
        <ContentForm content={post} />
      </div>
    );
  }

  const actions = STATUS_ACTIONS[post.status] || [];

  return (
    <div className="max-w-3xl space-y-6 crx-animate-fade">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="font-serif text-4xl font-light text-[#1A1A1A]">{post.title}</h1>
          <div className="flex gap-2 mt-3">
            <span className={`rounded-full px-3 py-1 text-xs font-medium ${STATUS_BADGE[post.status] || "bg-[rgba(0,0,0,0.06)] text-[#7A7A7A]"}`}>
              {STATUS_LABELS[post.status] || post.status}
            </span>
          </div>
        </div>
        <div className="flex gap-2">
          {post.status !== "PUBLISHED" && (
            <>
              <Button variant="outline" onClick={() => setIsEditing(true)} className="border border-[#E8E0D0] rounded-full text-[#1A1A1A] hover:bg-[rgba(255,248,225,0.5)]">Edit</Button>
              <Button variant="outline" onClick={handleDelete} className="border border-[#E8E0D0] rounded-full text-[#1A1A1A] hover:bg-[rgba(255,248,225,0.5)]">Delete</Button>
            </>
          )}
          <Button variant="outline" onClick={() => router.push("/content")} className="border border-[#E8E0D0] rounded-full text-[#1A1A1A] hover:bg-[rgba(255,248,225,0.5)]">Back</Button>
        </div>
      </div>

      <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] crx-animate-slide crx-delay-1">
        <div className="p-6 space-y-4">
          {post.caption && (
            <div>
              <h4 className="text-xs font-medium text-[#7A7A7A] mb-1 uppercase tracking-wide">Caption</h4>
              <p className="text-sm whitespace-pre-wrap text-[#1A1A1A]">{post.caption}</p>
            </div>
          )}
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div><span className="text-[#7A7A7A]">Project:</span> <span className="text-[#1A1A1A]">{post.project?.name}</span></div>
            <div><span className="text-[#7A7A7A]">Client:</span> <span className="text-[#1A1A1A]">{post.project?.client?.companyName || "--"}</span></div>
            <div><span className="text-[#7A7A7A]">Account:</span> <span className="text-[#1A1A1A]">{post.account ? `${post.account.platform?.name}: ${post.account.handle}` : "--"}</span></div>
            <div><span className="text-[#7A7A7A]">Created by:</span> <span className="text-[#1A1A1A]">{post.createdBy?.name}</span></div>
            <div><span className="text-[#7A7A7A]">Scheduled:</span> <span className="text-[#1A1A1A]">{post.scheduledAt ? new Date(post.scheduledAt).toLocaleString() : "--"}</span></div>
            <div><span className="text-[#7A7A7A]">Published:</span> <span className="text-[#1A1A1A]">{post.publishedAt ? new Date(post.publishedAt).toLocaleString() : "--"}</span></div>
            <div><span className="text-[#7A7A7A]">Created:</span> <span className="text-[#1A1A1A]">{new Date(post.createdAt).toLocaleString()}</span></div>
            <div><span className="text-[#7A7A7A]">Updated:</span> <span className="text-[#1A1A1A]">{new Date(post.updatedAt).toLocaleString()}</span></div>
          </div>
        </div>
      </div>

      {/* Media URLs */}
      {post.mediaUrls?.length > 0 && (
        <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] crx-animate-slide crx-delay-2">
          <div className="px-6 py-4 border-b border-[#F0EAD8]">
            <h3 className="text-base font-serif text-[#1A1A1A] font-medium">Media ({post.mediaUrls.length})</h3>
          </div>
          <div className="p-6">
            <div className="grid grid-cols-2 gap-3">
              {post.mediaUrls.map((url: string, i: number) => (
                <div key={i} className="border border-[#E8E0D0] rounded-xl overflow-hidden">
                  <img
                    src={url}
                    alt={`Media ${i + 1}`}
                    className="w-full h-40 object-cover"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = "none";
                      (e.target as HTMLImageElement).parentElement!.innerHTML = `<div class="flex items-center justify-center h-40 bg-[rgba(255,248,225,0.5)] text-xs text-[#7A7A7A] p-2 break-all">${url}</div>`;
                    }}
                  />
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block p-2 text-xs text-[#1A1A1A] hover:text-[#F5D547] truncate"
                  >
                    {url}
                  </a>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Status Actions */}
      {actions.length > 0 && (
        <div className="bg-white rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-[#E8E0D0] crx-animate-slide crx-delay-3">
          <div className="px-6 py-4 border-b border-[#F0EAD8]">
            <h3 className="text-base font-serif text-[#1A1A1A] font-medium">Actions</h3>
          </div>
          <div className="p-6">
            <div className="flex flex-wrap gap-2">
              {actions.map((action) => (
                <Button
                  key={action.status}
                  variant={action.variant}
                  size="sm"
                  onClick={() => handleStatusChange(action.status)}
                  disabled={transitioning}
                  className={action.variant === "default" ? "bg-[#1A1A1A] text-white rounded-full hover:bg-[#2B2B2B]" : "border border-[#E8E0D0] rounded-full text-[#1A1A1A] hover:bg-[rgba(255,248,225,0.5)]"}
                >
                  {action.label}
                </Button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
