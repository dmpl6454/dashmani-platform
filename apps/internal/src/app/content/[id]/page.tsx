"use client";
import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useContentPost } from "@/lib/hooks/use-content";
import { ContentForm } from "@/components/content-form";
import { apiFetch } from "@/lib/api";
import useSWR from "swr";
import { ChevronLeft, Send } from "lucide-react";
import { BoxesLoader } from "@/components/boxes-loader";

const STATUS_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  PENDING_APPROVAL: "Pending Approval",
  APPROVED: "Approved",
  SCHEDULED: "Scheduled",
  PUBLISHED: "Published",
  FAILED: "Failed",
  REJECTED: "Rejected",
};

const STATUS_COLOR: Record<string, string> = {
  DRAFT: "var(--hx-A7B3C2)",
  PENDING_APPROVAL: "var(--hx-FBBF24)",
  APPROVED: "var(--hx-34D399)",
  SCHEDULED: "var(--hx-238BFF)",
  PUBLISHED: "var(--hx-00D7A0)",
  FAILED: "var(--hx-FB7185)",
  REJECTED: "var(--hx-E5484D)",
};
const rgba = (hex: string, a: number) => { if (hex.startsWith("var(")) return `color-mix(in srgb, ${hex} ${Math.round(a * 100)}%, transparent)`; const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };

const CARD = "rounded-[8px] bg-ds-card border border-ds-line overflow-hidden";
const CARD_HEAD = "px-5 py-3 border-b border-ds-line bg-[color:var(--hx-0A1620)] text-[10px] tracking-[.12em] uppercase text-ds-t3 font-semibold";
const GHOST_BTN =
  "inline-flex items-center gap-1.5 h-[34px] px-3.5 rounded-[6px] border border-ds-line2 bg-ds-card text-ds-t5 text-[12px] font-semibold whitespace-nowrap transition-colors hover:border-ds-line4 hover:text-ds-text disabled:opacity-50";
const DANGER_BTN =
  "inline-flex items-center gap-1.5 h-[34px] px-3.5 rounded-[6px] border border-[rgba(251,113,133,.35)] bg-[rgba(251,113,133,.08)] text-[color:var(--hx-FB7185)] text-[12px] font-semibold whitespace-nowrap transition-colors hover:bg-[rgba(251,113,133,.14)] disabled:opacity-50";
const GOLD_BTN =
  "inline-flex items-center gap-1.5 h-[34px] px-4 rounded-[6px] border border-ds-gold bg-ds-gold/[.14] text-ds-gold text-[12px] font-semibold whitespace-nowrap transition-colors hover:bg-ds-gold/[.22] hover:text-ds-gold2 disabled:opacity-50";

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

  if (isLoading) return <div className="flex items-center justify-center h-64"><BoxesLoader /></div>;
  const post = (data as any)?.data;
  if (!post) return <div className="mt-[26px] px-5 py-14 text-center rounded-[8px] bg-ds-card border border-dashed border-ds-line2 text-[12.5px] text-ds-t3">Content not found</div>;

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
      <div className="max-w-2xl pb-6">
        <ContentForm content={post} />
      </div>
    );
  }

  const actions = STATUS_ACTIONS[post.status] || [];

  const stColor = STATUS_COLOR[post.status] ?? "var(--hx-A7B3C2)";
  const meta: [string, string][] = [
    ["Project", post.project?.name || "--"],
    ["Client", post.project?.client?.companyName || "--"],
    ["Account", post.account ? `${post.account.platform?.name}: ${post.account.handle}` : "--"],
    ["Created by", post.createdBy?.name || "--"],
    ["Scheduled", post.scheduledAt ? new Date(post.scheduledAt).toLocaleString() : "--"],
    ["Published", post.publishedAt ? new Date(post.publishedAt).toLocaleString() : "--"],
    ["Created", new Date(post.createdAt).toLocaleString()],
    ["Updated", new Date(post.updatedAt).toLocaleString()],
  ];

  return (
    <div className="max-w-3xl pb-6">
      {/* Header */}
      <section className="flex items-end justify-between gap-4 flex-wrap pt-[26px] pb-5">
        <div className="basis-full sm:basis-auto sm:flex-1 min-w-0">
          <button type="button" onClick={() => router.push("/content")} className="inline-flex items-center gap-1 text-[10px] tracking-[.2em] uppercase text-ds-gold font-semibold hover:text-ds-gold2">
            <ChevronLeft className="h-3 w-3" strokeWidth={2.4} /> Content Studio
          </button>
          <h1 className="mt-2 mb-0 text-[28px] font-semibold tracking-[-.02em] text-ds-text [overflow-wrap:anywhere]">{post.title}</h1>
          <div className="flex gap-2 mt-3">
            <span className="inline-flex items-center gap-1.5 h-[22px] px-2.5 rounded-[11px] border text-[10.5px] font-semibold whitespace-nowrap" style={{ color: stColor, background: rgba(stColor, 0.1), borderColor: rgba(stColor, 0.35) }}>
              <i className="h-1.5 w-1.5 rounded-full" style={{ background: stColor }} />
              {STATUS_LABELS[post.status] || post.status}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {post.status !== "PUBLISHED" && (
            <>
              <button type="button" onClick={() => setIsEditing(true)} className={GHOST_BTN}>Edit</button>
              <button type="button" onClick={handleDelete} className={DANGER_BTN}>Delete</button>
            </>
          )}
          <button type="button" onClick={() => router.push("/content")} className={GHOST_BTN}>Back</button>
        </div>
      </section>

      <div className="flex flex-col gap-3.5">
        <section className={CARD}>
          <div className="p-5 flex flex-col gap-5">
            {post.caption && (
              <div>
                <h4 className="text-[10px] tracking-[.12em] uppercase text-ds-t3 font-semibold mb-1.5">Caption</h4>
                <p className="text-[13px] leading-[1.6] whitespace-pre-wrap text-ds-t5 [overflow-wrap:anywhere]">{post.caption}</p>
              </div>
            )}
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3.5 text-[12.5px]">
              {meta.map(([k, v]) => (
                <div key={k} className="flex flex-col gap-1 min-w-0">
                  <dt className="text-[10px] tracking-[.12em] uppercase text-ds-t3 font-semibold">{k}</dt>
                  <dd className="text-ds-text truncate" title={v}>{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        {/* Media URLs */}
        {post.mediaUrls?.length > 0 && (
          <section className={CARD}>
            <div className={CARD_HEAD}>Media ({post.mediaUrls.length})</div>
            <div className="p-5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {post.mediaUrls.map((url: string, i: number) => (
                  <div key={i} className="border border-ds-line2 rounded-[8px] overflow-hidden bg-ds-inset">
                    <img
                      src={url}
                      alt={`Media ${i + 1}`}
                      className="w-full h-40 object-cover"
                      onError={(e) => {
                        const img = e.target as HTMLImageElement;
                        img.style.display = "none";
                        const fallback = document.createElement("div");
                        fallback.className = "flex items-center justify-center h-40 bg-ds-hover text-xs text-ds-t3 p-2 break-all";
                        fallback.textContent = url;
                        img.parentElement?.appendChild(fallback);
                      }}
                    />
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block px-3 py-2 text-[11.5px] text-ds-t2 hover:text-ds-gold truncate border-t border-ds-line"
                    >
                      {url}
                    </a>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* Status Actions */}
        {actions.length > 0 && (
          <section className={CARD}>
            <div className={CARD_HEAD}>Actions</div>
            <div className="p-5">
              <div className="flex flex-wrap gap-2">
                {actions.map((action) => (
                  <button
                    key={action.status}
                    type="button"
                    onClick={() => handleStatusChange(action.status)}
                    disabled={transitioning}
                    className={action.variant === "default" ? GOLD_BTN : GHOST_BTN}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* Comments */}
        <section className={CARD}>
          <div className={CARD_HEAD}>Comments {comments.length > 0 && <span className="text-ds-t4">({comments.length})</span>}</div>
          <div className="p-5 flex flex-col gap-4">
            {comments.length === 0 ? (
              <p className="text-[12.5px] text-ds-t3 text-center py-4">No comments yet</p>
            ) : (
              <div className="flex flex-col gap-4">
                {comments.map((c: any) => (
                  <div key={c.id} className="flex gap-3">
                    <div className="h-8 w-8 rounded-full border border-[rgba(233,189,98,.3)] bg-[rgba(233,189,98,.12)] flex items-center justify-center text-[11px] font-bold text-ds-gold shrink-0">
                      {c.author?.name?.[0]?.toUpperCase() || "?"}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2 mb-1">
                        <span className="text-[13px] font-semibold text-ds-text">{c.author?.name || "Unknown"}</span>
                        <span className="text-[11px] text-ds-t3">{new Date(c.createdAt).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
                      </div>
                      <p className="text-[13px] leading-[1.55] text-ds-t5 whitespace-pre-wrap [overflow-wrap:anywhere]">{c.body}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <form onSubmit={handleAddComment} className="flex gap-3 pt-4 border-t border-ds-line">
              <textarea
                value={commentBody}
                onChange={(e) => setCommentBody(e.target.value)}
                placeholder="Add a comment..."
                rows={2}
                className="flex-1 min-w-0 rounded-[12px] border border-ds-line2 bg-ds-inset px-4 py-2.5 text-[16px] sm:text-[13px] text-ds-text placeholder:text-ds-t4 outline-none focus:border-[rgba(233,189,98,.6)] transition-colors resize-none"
              />
              <button
                type="submit"
                disabled={submittingComment || !commentBody.trim()}
                className="self-end inline-flex items-center gap-1.5 h-[38px] px-4 rounded-full bg-ds-gold text-[color:var(--hx-060D14)] text-[12.5px] font-bold whitespace-nowrap hover:bg-[color:var(--hx-F4D58C)] disabled:opacity-40 transition-colors"
              >
                <Send size={14} /> {submittingComment ? "Posting..." : "Post"}
              </button>
            </form>
          </div>
        </section>
      </div>
    </div>
  );
}
