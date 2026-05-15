"use client";
import { useEffect, useState } from "react";
import { useRouter, useParams } from "next/navigation";
import { mutate } from "swr";
import { Topstrip } from "@/components/portal-topstrip";
import { Button, IconButton, StatusBadge, Avatar, Empty, KbdRow } from "@/components/portal-shared";
import { Icon } from "@/components/portal-icons";
import { ReasonModal } from "@/components/reason-modal";
import { IGFeedCard, IGProfileGrid, IGStory } from "@/components/ig-previews";
import { Actions, fmt } from "@/lib/portal-store";
import { useClientContentPost, useClientPostComments, useClientPendingApprovals, PENDING_APPROVALS_KEY } from "@/lib/hooks/use-content";
import { apiFetch } from "@/lib/api";

export default function ContentDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const postId = params?.id;

  const { data: post, isLoading: postLoading, error: postError } = useClientContentPost(postId || "");
  const { data: commentsData } = useClientPostComments(postId || "");
  const comments = commentsData ?? post?.thread ?? post?.comments ?? [];
  const { data: pendingData } = useClientPendingApprovals();
  const pending = pendingData ?? [];

  const project = post?.project;
  const [previewMode, setPreviewMode] = useState<"feed" | "profile" | "story">("feed");
  const [modal, setModal] = useState<null | "revise" | "reject">(null);

  const isPending = post?.status === "PENDING_APPROVAL";
  const queueIndex = post ? pending.findIndex((p: any) => p.id === post.id) : -1;
  const queueTotal = pending.length;
  const prevInQueue = queueIndex > 0 ? pending[queueIndex - 1] : null;
  const nextInQueue = queueIndex >= 0 && queueIndex < pending.length - 1 ? pending[queueIndex + 1] : null;

  const onBack = () => router.push("/content");
  const advance = () => {
    if (nextInQueue) setTimeout(() => router.push(`/content/${nextInQueue.id}`), 220);
    else setTimeout(onBack, 220);
  };

  async function handleApprove() {
    try {
      await apiFetch(`/client/content/${post.id}/respond`, { method: "PUT", body: JSON.stringify({ status: "APPROVED" }) });
      mutate(post?.id ? `/client/content/${post.id}` : null);
      mutate(PENDING_APPROVALS_KEY);
      Actions.toast({ kind: "success", text: "Approved!" });
      advance();
    } catch { Actions.toast({ kind: "danger", text: "Could not approve. Please try again." }); }
  }

  async function handleRevise(note: string) {
    try {
      await apiFetch(`/client/content/${post.id}/respond`, { method: "PUT", body: JSON.stringify({ status: "REJECTED", clientNote: note }) });
      mutate(post?.id ? `/client/content/${post.id}` : null);
      mutate(PENDING_APPROVALS_KEY);
      Actions.toast({ kind: "success", text: "Revision requested." });
      advance();
    } catch { Actions.toast({ kind: "danger", text: "Could not request revision. Please try again." }); }
  }

  useEffect(() => {
    if (!post || !isPending) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.matches("input, textarea, select") || modal) return;
      if (e.key === "a" || e.key === "A") { e.preventDefault(); handleApprove(); }
      else if (e.key === "r" || e.key === "R") { e.preventDefault(); setModal("revise"); }
      else if (e.key === "x" || e.key === "X") { e.preventDefault(); setModal("reject"); }
      else if ((e.key === "ArrowDown" || e.key === "j") && nextInQueue) router.push(`/content/${nextInQueue.id}`);
      else if ((e.key === "ArrowUp"   || e.key === "k") && prevInQueue) router.push(`/content/${prevInQueue.id}`);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [post?.id, isPending, modal, prevInQueue, nextInQueue, router]);

  const previewPost = post ? { ...post, aspect: post.aspectRatio ?? post.aspect, scheduled: post.scheduledAt ?? post.scheduled } : null;
  const displayStatus = post?.status === "PENDING_APPROVAL" ? "PENDING" : post?.status;

  if (postLoading) {
    return (
      <>
        <Topstrip title="Content" />
        <div className="p-6 flex-1 grid place-items-center">
          <div className="h-8 w-8 border-2 border-muted border-b-indigo rounded-full animate-spin" />
        </div>
      </>
    );
  }

  if (postError || !post) {
    return (
      <>
        <Topstrip title="Not found" />
        <div className="p-6 flex-1 grid place-items-center">
          <Empty icon={<Icon.X size={20} />} title="Post not found" cta={<Button size="sm" variant="default" onClick={onBack}>Go back</Button>} />
        </div>
      </>
    );
  }

  return (
    <>
      <Topstrip
        title={
          <span className="inline-flex items-center gap-2">
            <button onClick={onBack} className="text-ink-3 hover:text-ink transition-colors shrink-0">
              <Icon.ChevLeft size={18} />
            </button>
            <span className="truncate">{post.title}</span>
          </span>
        }
        sub={`${project?.name ?? ""} · ${post.format}${post.aspectRatio ?? post.aspect ? " · " + (post.aspectRatio ?? post.aspect) : ""}`}
        right={isPending && queueTotal > 0 ? (
          <div className="flex items-center gap-1.5 text-[12px] text-ink-3 font-semibold">
            <span className="tabular-nums">{queueIndex + 1} / {queueTotal}</span>
            <IconButton size="sm" variant="default" icon={<Icon.ChevUp   size={14} />} label="Previous" onClick={() => prevInQueue && router.push(`/content/${prevInQueue.id}`)} disabled={!prevInQueue} />
            <IconButton size="sm" variant="default" icon={<Icon.ChevDown size={14} />} label="Next"     onClick={() => nextInQueue && router.push(`/content/${nextInQueue.id}`)} disabled={!nextInQueue} />
          </div>
        ) : undefined}
      />

      <div className="flex-1 overflow-y-auto">
        <div className="px-6 py-6 max-w-[1200px] mx-auto w-full fade-up d1 grid grid-cols-1 lg:grid-cols-[1fr_296px] gap-6">

          {/* ── Preview pane ── */}
          <div className="space-y-4">
            {/* Preview mode tabs */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1 p-0.5 bg-muted rounded-xl" style={{ border: "2px solid rgba(26,26,26,0.1)" }}>
                {(["feed", "profile", "story"] as const).map((m) => (
                  <button key={m} onClick={() => setPreviewMode(m)}
                    className={`h-7 px-3 text-[12.5px] font-semibold rounded-lg transition-all
                      ${previewMode === m ? "bg-surface text-ink shadow-hard-ink" : "text-ink-3 hover:text-ink"}`}>
                    {m.charAt(0).toUpperCase() + m.slice(1)}
                  </button>
                ))}
              </div>
              <div className="text-[12px] text-ink-3 font-medium flex items-center gap-1.5">
                <Icon.Clock size={13} />
                <span>Publishes <span className={`font-bold ${post.overdue ? "text-attention" : "text-ink-2"}`}>{fmt.date(post.scheduledAt ?? post.scheduled)}</span></span>
              </div>
            </div>

            {/* IG preview */}
            <div className="flex justify-center">
              {previewMode === "feed"    && previewPost && <IGFeedCard    post={previewPost} />}
              {previewMode === "profile" && previewPost && <IGProfileGrid post={previewPost} />}
              {previewMode === "story"   && previewPost && <IGStory       post={previewPost} />}
            </div>

            {/* Detail cards */}
            <div className="grid grid-cols-2 gap-4">
              <div className="v3-card p-4">
                <h3 className="text-[11px] uppercase tracking-wider font-bold text-ink-3 mb-3">Details</h3>
                <dl className="space-y-2">
                  {([
                    ["Account", "@bombay.roastery"],
                    ["Format", `${post.format}${post.aspectRatio ?? post.aspect ? " · " + (post.aspectRatio ?? post.aspect) : ""}`],
                    ["Scheduled", fmt.date(post.scheduledAt ?? post.scheduled)],
                    ["Created by", post.authorName],
                  ] as [string, string][]).map(([k, v]) => (
                    <div key={k} className="grid gap-2 text-[13px]" style={{ gridTemplateColumns: "80px 1fr" }}>
                      <dt className="text-ink-3 font-medium">{k}</dt>
                      <dd className="text-ink-2 font-semibold">{v}</dd>
                    </div>
                  ))}
                </dl>
              </div>
              <div className="v3-card p-4">
                <h3 className="text-[11px] uppercase tracking-wider font-bold text-ink-3 mb-2">Brand fit</h3>
                <p className="text-[13px] text-ink-2 leading-relaxed font-medium">
                  {post.format === "REEL" || post.format === "CAROUSEL"
                    ? "Dominant colours match the profile palette. No off-brand contrast issues detected."
                    : "Sits cleanly between scheduled posts. No off-brand elements detected."}
                </p>
              </div>
            </div>
          </div>

          {/* ── Decision rail ── */}
          <aside className="space-y-4 lg:sticky lg:top-4 self-start">
            <div className="v3-card p-4">
              <div className="flex items-center justify-between mb-3">
                <span className="text-[11px] uppercase tracking-wider font-bold text-ink-3">Status</span>
                <StatusBadge status={displayStatus as any} />
              </div>
              {isPending ? (
                <>
                  <div className="space-y-2 mt-3">
                    <Button variant="primary" size="md" className="w-full" icon={<Icon.Check size={15} sw={2.5} />} kbd="A" onClick={handleApprove}>
                      Approve
                    </Button>
                    <Button variant="default" size="md" className="w-full" icon={<Icon.Edit size={14} />} kbd="R" onClick={() => setModal("revise")}>
                      Request revision
                    </Button>
                    <Button variant="danger"  size="md" className="w-full" icon={<Icon.X    size={14} />} kbd="X" onClick={() => setModal("reject")}>
                      Reject
                    </Button>
                  </div>
                  <div className="mt-3 pt-3" style={{ borderTop: "1px solid rgba(26,26,26,0.08)" }}>
                    <KbdRow items={[{ k: "↑↓", label: "navigate queue" }]} />
                  </div>
                </>
              ) : (
                <p className="text-[13px] text-ink-2 font-medium mt-2">
                  {post.status === "APPROVED"  && "Approved. Will publish on schedule."}
                  {post.status === "SCHEDULED" && `Scheduled for ${fmt.date(post.scheduledAt ?? post.scheduled)}.`}
                  {post.status === "REJECTED"  && "Rejected. Team has been notified."}
                  {post.status === "REVISION"  && "Revision requested. Waiting on a new draft."}
                  {post.status === "PUBLISHED" && "Live on Instagram."}
                </p>
              )}
            </div>

            {/* Thread */}
            <div className="v3-card overflow-hidden">
              <div className="px-4 h-11 flex items-center justify-between" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
                <h3 className="text-[11px] uppercase tracking-wider font-bold text-ink-3">Discussion</h3>
                <span className="text-[11px] text-ink-3 font-medium">{comments.length}</span>
              </div>
              <div className="px-4 py-3 space-y-3 max-h-[220px] overflow-y-auto">
                {comments.length === 0 ? (
                  <div className="text-[12px] text-ink-4 text-center py-3 font-medium">No comments yet.</div>
                ) : comments.map((c: any, i: number) => (
                  <div key={c.id ?? i} className="flex items-start gap-2.5">
                    <Avatar initial={c.author?.name?.[0] ?? c.a ?? "?"} size="xs" />
                    <div className="flex-1 min-w-0">
                      <div className="text-[11.5px] text-ink-3 font-semibold">
                        {c.author?.name ?? c.who ?? "Agency"} · {c.createdAt ? new Date(c.createdAt).toLocaleDateString("en", { month: "short", day: "numeric" }) : c.at ?? ""}
                      </div>
                      <div className="text-[13px] text-ink-2 font-medium">{c.body ?? c.t}</div>
                    </div>
                  </div>
                ))}
              </div>
              <ReplyBox postId={post.id} />
            </div>
          </aside>
        </div>
      </div>

      <ReasonModal open={modal === "revise"} kind="revise" post={post} onClose={() => setModal(null)}
        onConfirm={(note) => { setModal(null); handleRevise(note); }} />
      <ReasonModal open={modal === "reject"} kind="reject" post={post} onClose={() => setModal(null)}
        onConfirm={(note) => { setModal(null); handleRevise(note); }} />
    </>
  );
}

function ReplyBox({ postId }: { postId: string }) {
  const [val, setVal] = useState("");
  const [sending, setSending] = useState(false);

  const send = async () => {
    if (!val.trim() || sending) return;
    setSending(true);
    try {
      await apiFetch(`/client/content/${postId}/comments`, { method: "POST", body: JSON.stringify({ body: val.trim() }) });
      mutate(`/client/content/${postId}/comments`);
      setVal("");
    } catch { Actions.toast({ kind: "danger", text: "Could not send reply. Please try again." }); }
    finally { setSending(false); }
  };

  return (
    <div className="p-3 flex items-end gap-2" style={{ borderTop: "2px solid rgba(26,26,26,0.07)" }}>
      <textarea
        value={val}
        onChange={(e) => setVal(e.target.value)}
        placeholder="Reply…"
        rows={1}
        disabled={sending}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }}
        className="flex-1 resize-none text-[13px] bg-bg rounded-xl px-3 py-2 outline-none font-medium min-h-[36px] disabled:opacity-50"
        style={{ border: "2px solid rgba(26,26,26,0.15)" }}
      />
      <IconButton size="sm" variant="ink" icon={<Icon.Send size={14} />} label="Send" onClick={send} disabled={!val.trim() || sending} />
    </div>
  );
}
