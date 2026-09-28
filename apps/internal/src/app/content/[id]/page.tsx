"use client";
import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useContentPost } from "@/lib/hooks/use-content";
import { Button } from "@dashmani/ui";
import { ContentForm } from "@/components/content-form";
import { apiFetch } from "@/lib/api";
import useSWR from "swr";
import { Send } from "lucide-react";

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
  DRAFT: "bg-[rgba(0,0,0,0.06)] text-ink-3",
  PENDING_APPROVAL: "bg-action-soft text-ink",
  APPROVED: "bg-[rgba(107,203,119,0.12)] text-success",
  SCHEDULED: "bg-[rgba(52,152,219,0.12)] text-[#3498DB]",
  PUBLISHED: "bg-[rgba(107,203,119,0.12)] text-success",
  FAILED: "bg-[rgba(231,76,60,0.1)] text-danger",
  REJECTED: "bg-[rgba(231,76,60,0.1)] text-danger",
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
  const [commentBody, setCommentBody] = useState("");
  const [submittingComment, setSubmittingComment] = useState(false);
  const { data: commentsData, mutate: mutateComments } = useSWR(
    id ? `/content/${id}/comments` : null,
    (url: string) => apiFetch<any>(url)
  );
  const comments: any[] = commentsData?.data || [];

  if (isLoading) return <div className="flex items-center justify-center h-64"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-action" /></div>;
  const post = (data as any)?.data;
  if (!post) return <div className="py-8 text-center text-ink-3">Content not found</div>;

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

  async function handleAddComment(e: React.FormEvent) {
    e.preventDefault();
    if (!commentBody.trim()) return;
    setSubmittingComment(true);
    try {
      await apiFetch(`/content/${id}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: commentBody.trim() }),
      });
      setCommentBody("");
      mutateComments();
    } catch (err: any) {
      alert(err.message);
    } finally {
      setSubmittingComment(false);
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
          <h1 className="font-serif text-4xl font-light text-ink">{post.title}</h1>
          <div className="flex gap-2 mt-3">
            <span className={`rounded-full px-3 py-1 text-xs font-medium ${STATUS_BADGE[post.status] || "bg-[rgba(0,0,0,0.06)] text-ink-3"}`}>
              {STATUS_LABELS[post.status] || post.status}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {post.status !== "PUBLISHED" && (
            <>
              <Button variant="outline" onClick={() => setIsEditing(true)} className="border border-border rounded-full text-ink hover:bg-[rgba(255,248,225,0.5)]">Edit</Button>
              <Button variant="outline" onClick={handleDelete} className="border border-border rounded-full text-ink hover:bg-[rgba(255,248,225,0.5)]">Delete</Button>
            </>
          )}
          <Button variant="outline" onClick={() => router.push("/content")} className="border border-border rounded-full text-ink hover:bg-[rgba(255,248,225,0.5)]">Back</Button>
        </div>
      </div>

      <div className="bg-surface rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-border crx-animate-slide crx-delay-1">
        <div className="p-6 space-y-4">
          {post.caption && (
            <div>
              <h4 className="text-xs font-medium text-ink-3 mb-1 uppercase tracking-wide">Caption</h4>
              <p className="text-sm whitespace-pre-wrap text-ink">{post.caption}</p>
            </div>
          )}
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div><span className="text-ink-3">Project:</span> <span className="text-ink">{post.project?.name}</span></div>
            <div><span className="text-ink-3">Client:</span> <span className="text-ink">{post.project?.client?.companyName || "--"}</span></div>
            <div><span className="text-ink-3">Account:</span> <span className="text-ink">{post.account ? `${post.account.platform?.name}: ${post.account.handle}` : "--"}</span></div>
            <div><span className="text-ink-3">Created by:</span> <span className="text-ink">{post.createdBy?.name}</span></div>
            <div><span className="text-ink-3">Scheduled:</span> <span className="text-ink">{post.scheduledAt ? new Date(post.scheduledAt).toLocaleString() : "--"}</span></div>
            <div><span className="text-ink-3">Published:</span> <span className="text-ink">{post.publishedAt ? new Date(post.publishedAt).toLocaleString() : "--"}</span></div>
            <div><span className="text-ink-3">Created:</span> <span className="text-ink">{new Date(post.createdAt).toLocaleString()}</span></div>
            <div><span className="text-ink-3">Updated:</span> <span className="text-ink">{new Date(post.updatedAt).toLocaleString()}</span></div>
          </div>
        </div>
      </div>

      {/* Media URLs */}
      {post.mediaUrls?.length > 0 && (
        <div className="bg-surface rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-border crx-animate-slide crx-delay-2">
          <div className="px-6 py-4 border-b border-border">
            <h3 className="text-base font-serif text-ink font-medium">Media ({post.mediaUrls.length})</h3>
          </div>
          <div className="p-6">
            <div className="grid grid-cols-2 gap-3">
              {post.mediaUrls.map((url: string, i: number) => (
                <div key={i} className="border border-border rounded-xl overflow-hidden">
                  <img
                    src={url}
                    alt={`Media ${i + 1}`}
                    className="w-full h-40 object-cover"
                    onError={(e) => {
                      const img = e.target as HTMLImageElement;
                      img.style.display = "none";
                      const fallback = document.createElement("div");
                      fallback.className = "flex items-center justify-center h-40 bg-[rgba(255,248,225,0.5)] text-xs text-ink-3 p-2 break-all";
                      fallback.textContent = url;
                      img.parentElement?.appendChild(fallback);
                    }}
                  />
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block p-2 text-xs text-ink hover:text-action truncate"
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
        <div className="bg-surface rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-border crx-animate-slide crx-delay-3">
          <div className="px-6 py-4 border-b border-border">
            <h3 className="text-base font-serif text-ink font-medium">Actions</h3>
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
                  className={action.variant === "default" ? "bg-action text-[#06121B] rounded-full hover:bg-[#243645]" : "border border-border rounded-full text-ink hover:bg-[rgba(255,248,225,0.5)]"}
                >
                  {action.label}
                </Button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Comments */}
      <div className="bg-surface rounded-2xl shadow-[0_2px_16px_rgba(0,0,0,0.05)] border border-border">
        <div className="px-6 py-4 border-b border-border">
          <h3 className="text-base font-serif text-ink font-medium">Comments {comments.length > 0 && <span className="text-ink-3 font-sans text-sm font-normal">({comments.length})</span>}</h3>
        </div>
        <div className="p-6 space-y-4">
          {comments.length === 0 ? (
            <p className="text-sm text-ink-4 text-center py-4">No comments yet</p>
          ) : (
            <div className="space-y-4">
              {comments.map((c: any) => (
                <div key={c.id} className="flex gap-3">
                  <div className="h-8 w-8 rounded-full bg-action-soft flex items-center justify-center text-xs font-bold text-gold shrink-0">
                    {c.author?.name?.[0]?.toUpperCase() || "?"}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2 mb-1">
                      <span className="text-sm font-medium text-ink">{c.author?.name || "Unknown"}</span>
                      <span className="text-xs text-ink-4">{new Date(c.createdAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
                    </div>
                    <p className="text-sm text-ink-2 whitespace-pre-wrap">{c.body}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
          <form onSubmit={handleAddComment} className="flex gap-3 pt-2 border-t border-border">
            <textarea
              value={commentBody}
              onChange={(e) => setCommentBody(e.target.value)}
              placeholder="Add a comment..."
              rows={2}
              className="flex-1 border border-border bg-surface rounded-lg px-3 py-2 text-sm text-ink placeholder:text-ink-4 focus:outline-none focus:ring-2 focus:ring-action focus:border-action transition-colors resize-none"
            />
            <button
              type="submit"
              disabled={submittingComment || !commentBody.trim()}
              className="self-end flex items-center gap-1.5 bg-action text-[#06121B] py-2 px-4 rounded-full text-sm font-semibold hover:bg-[#243645] disabled:opacity-40 transition-all"
            >
              <Send size={14} /> {submittingComment ? "Posting..." : "Post"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
