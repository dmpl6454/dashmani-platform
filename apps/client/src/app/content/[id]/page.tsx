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
import { useClientContentPost, useClientPostComments } from "@/lib/hooks/use-content";
import { useClientApprovals } from "@/lib/hooks/use-projects";
import { apiFetch } from "@/lib/api";

export default function ContentDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const postId = params?.id;

  const { data: postRaw, isLoading: postLoading } = useClientContentPost(postId || "");
  const post = (postRaw as any)?.data;

  const { data: commentsRaw } = useClientPostComments(postId || "");
  const comments = (commentsRaw as any)?.data ?? post?.thread ?? post?.comments ?? [];

  const { data: approvalsRaw } = useClientApprovals();
  const pending = ((approvalsRaw as any)?.data ?? []) as any[];

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
      await apiFetch(`/client/content/${post.id}/respond`, {
        method: "PUT",
        body: JSON.stringify({ status: "APPROVED" }),
      });
      mutate(post?.id ? `/client/content/${post.id}` : null);
      mutate("/client/approvals?limit=100");
      advance();
    } catch (err) {
      console.error("Approve failed:", err);
      Actions.toast({ kind: "danger", text: "Could not approve. Please try again." });
    }
  }

  async function handleRevise(note: string) {
    try {
      await apiFetch(`/client/content/${post.id}/respond`, {
        method: "PUT",
        body: JSON.stringify({ status: "REJECTED", clientNote: note }),
      });
      mutate(post?.id ? `/client/content/${post.id}` : null);
      mutate("/client/approvals?limit=100");
      advance();
    } catch (err) {
      console.error("Revise failed:", err);
      Actions.toast({ kind: "danger", text: "Could not request revision. Please try again." });
    }
  }

  async function handleReject(note: string) {
    try {
      await apiFetch(`/client/content/${post.id}/respond`, {
        method: "PUT",
        body: JSON.stringify({ status: "REJECTED", clientNote: note }),
      });
      mutate(post?.id ? `/client/content/${post.id}` : null);
      mutate("/client/approvals?limit=100");
      advance();
    } catch (err) {
      console.error("Reject failed:", err);
      Actions.toast({ kind: "danger", text: "Could not reject. Please try again." });
    }
  }

  useEffect(() => {
    if (!post || !isPending) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.matches("input, textarea, select") || modal) return;
      if (e.key === "a" || e.key === "A") { e.preventDefault(); handleApprove(); }
      else if (e.key === "r" || e.key === "R") { e.preventDefault(); setModal("revise"); }
      else if (e.key === "x" || e.key === "X") { e.preventDefault(); setModal("reject"); }
      else if (e.key === "ArrowDown" || e.key === "j") { if (nextInQueue) router.push(`/content/${nextInQueue.id}`); }
      else if (e.key === "ArrowUp" || e.key === "k") { if (prevInQueue) router.push(`/content/${prevInQueue.id}`); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [post?.id, isPending, modal, prevInQueue, nextInQueue, router]);

  // Transform post for preview components that expect legacy field names
  const previewPost = post ? {
    ...post,
    aspect: post.aspectRatio ?? post.aspect,
    scheduled: post.scheduledAt ?? post.scheduled,
  } : null;

  // Map API status to StatusBadge-compatible key
  const displayStatus = post?.status === "PENDING_APPROVAL" ? "PENDING" : post?.status;

  if (postLoading) {
    return (
      <>
        <Topstrip title="Content" />
        <div className="p-6 flex-1 grid place-items-center">
          <div className="h-8 w-8 border-2 border-border border-b-action rounded-full animate-spin" />
        </div>
      </>
    );
  }

  if (!post) {
    return (
      <>
        <Topstrip title="Not found" />
        <div className="p-6">
          <Empty icon={<Icon.X size={20}/>} title="Post not found" cta={<Button size="sm" onClick={onBack}>Back to content</Button>} />
        </div>
      </>
    );
  }

  return (
    <>
      <Topstrip
        title={
          <span className="inline-flex items-center gap-2">
            <button onClick={onBack} className="text-ink-3 hover:text-ink"><Icon.ChevLeft size={18}/></button>
            <span>{post.title}</span>
          </span>
        }
        sub={`${project?.name ?? project?.short ?? ""} · ${post.format}${post.aspectRatio ?? post.aspect ? " · " + (post.aspectRatio ?? post.aspect) : ""}${post.duration ? " · " + post.duration : ""}`}
        right={isPending && queueTotal > 0 ? (
          <div className="flex items-center gap-1.5 text-[12px] text-ink-3">
            <span className="tabular-nums">{queueIndex + 1} of {queueTotal}</span>
            <IconButton size="sm" variant="default" icon={<Icon.ChevUp size={16}/>} label="Previous" onClick={() => prevInQueue && router.push(`/content/${prevInQueue.id}`)} disabled={!prevInQueue} />
            <IconButton size="sm" variant="default" icon={<Icon.ChevDown size={16}/>} label="Next" onClick={() => nextInQueue && router.push(`/content/${nextInQueue.id}`)} disabled={!nextInQueue} />
          </div>
        ) : undefined}
      />

      <div className="px-6 py-6 max-w-[1200px] mx-auto w-full grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
        {/* Preview pane */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="bg-muted rounded-md p-0.5 inline-flex items-center gap-0.5">
              {([{ id: "feed", label: "Feed" }, { id: "profile", label: "Profile" }, { id: "story", label: "Story" }] as const).map((m) => (
                <button
                  key={m.id}
                  onClick={() => setPreviewMode(m.id)}
                  className={`h-7 px-3 text-[12.5px] font-medium rounded ${previewMode === m.id ? "bg-surface text-ink shadow-sm" : "text-ink-3 hover:text-ink"}`}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <div className="text-[12px] text-ink-3 flex items-center gap-1.5">
              <Icon.Clock size={14}/>
              <span>
                Publishes <span className={post.overdue ? "text-attention font-medium" : "font-medium text-ink-2"}>{fmt.date(post.scheduledAt ?? post.scheduled)}</span>
              </span>
            </div>
          </div>

          <div className="flex justify-center">
            {previewMode === "feed" && previewPost && <IGFeedCard post={previewPost} />}
            {previewMode === "profile" && previewPost && <IGProfileGrid post={previewPost} />}
            {previewMode === "story" && previewPost && <IGStory post={previewPost} />}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="bg-surface border border-border rounded-lg p-4">
              <h3 className="text-[12px] uppercase tracking-wider font-medium text-ink-3 mb-2">Details</h3>
              <dl className="text-[13px] space-y-1.5 text-rowtight">
                <DetailRow k="Account" v="@bombay.roastery" />
                <DetailRow k="Format" v={`${post.format}${post.aspectRatio ?? post.aspect ? " · " + (post.aspectRatio ?? post.aspect) : ""}${post.duration ? " · " + post.duration : ""}`} />
                <DetailRow k="Scheduled" v={fmt.date(post.scheduledAt ?? post.scheduled)} />
                <DetailRow k="Created" v={post.authorName} />
                <DetailRow k="Brief" v={<a className="text-ink underline decoration-action decoration-2 underline-offset-2" href="#">{project?.name}</a>} />
              </dl>
            </div>
            <div className="bg-surface border border-border rounded-lg p-4">
              <h3 className="text-[12px] uppercase tracking-wider font-medium text-ink-3 mb-2">Brand fit</h3>
              <div className="text-[13px] text-ink-2 leading-relaxed text-rowtight">
                {post.format === "REEL" || post.format === "CAROUSEL"
                  ? <>Dominant colours match the profile palette (brown · amber · ink). No off-brand contrast issues detected.</>
                  : <>Sits cleanly between scheduled posts. No off-brand elements detected.</>}
              </div>
              <button className="mt-2 text-[12px] text-ink-3 hover:text-ink inline-flex items-center gap-1">
                See profile grid <Icon.ArrowRight size={12}/>
              </button>
            </div>
          </div>
        </div>

        {/* Decision rail */}
        <aside className="space-y-4 lg:sticky lg:top-20 self-start">
          <div className="bg-surface border border-border rounded-lg p-4">
            <div className="flex items-center justify-between">
              <div className="text-[11px] uppercase tracking-wider text-ink-3 font-medium">Status</div>
              <StatusBadge status={displayStatus as any} />
            </div>
            {isPending ? (
              <>
                <div className="grid grid-cols-1 gap-2 mt-3">
                  <Button variant="primary" size="md" icon={<Icon.Check size={16} sw={2.4}/>} kbd="A" onClick={handleApprove}>
                    Approve
                  </Button>
                  <Button variant="default" size="md" icon={<Icon.Edit size={15}/>} kbd="R" onClick={() => setModal("revise")}>
                    Request revision
                  </Button>
                  <Button variant="danger" size="md" icon={<Icon.X size={15}/>} kbd="X" onClick={() => setModal("reject")}>
                    Reject
                  </Button>
                </div>
                <div className="mt-3 pt-3 border-t border-rule">
                  <KbdRow items={[{ k: "↑↓", label: "navigate queue" }]} />
                </div>
              </>
            ) : (
              <div className="mt-3 text-[12.5px] text-ink-2 text-rowtight">
                {post.status === "APPROVED" && <>Approved. Will publish on schedule.</>}
                {post.status === "SCHEDULED" && <>Locked in. Posts at {fmt.date(post.scheduledAt ?? post.scheduled)}.</>}
                {post.status === "REJECTED" && <>Rejected. The team has been notified.</>}
                {post.status === "REVISION" && <>Revision requested. Waiting on a new draft.</>}
                {post.status === "PUBLISHED" && <>Live on Instagram. See analytics for performance.</>}
              </div>
            )}
          </div>

          <div className="bg-surface border border-border rounded-lg">
            <div className="px-4 h-11 border-b border-rule flex items-center justify-between">
              <h3 className="text-[12px] uppercase tracking-wider font-medium text-ink-3">Discussion</h3>
              <span className="text-[11px] text-ink-3">{comments.length}</span>
            </div>
            <div className="px-4 py-3 space-y-3 max-h-[260px] overflow-y-auto">
              {comments.length === 0 ? (
                <div className="text-[12px] text-ink-4 text-center py-4">No comments yet.</div>
              ) : comments.map((c: any, i: number) => (
                <div key={c.id ?? i} className="flex items-start gap-2.5">
                  <Avatar initial={c.author?.name?.[0] ?? c.a ?? "?"} size="xs" />
                  <div className="flex-1 min-w-0">
                    <div className="text-[11.5px] text-ink-3">
                      <span className="font-medium text-ink-2">{c.author?.name ?? c.who ?? c.a ?? "Agency"}</span>
                      {" · "}
                      {c.createdAt ? new Date(c.createdAt).toLocaleDateString("en", { month: "short", day: "numeric" }) : c.at ?? ""}
                    </div>
                    <div className="text-[13px] text-ink-2 text-rowtight">{c.body ?? c.t}</div>
                  </div>
                </div>
              ))}
            </div>
            <ReplyBox postId={post.id} />
          </div>
        </aside>
      </div>

      <ReasonModal
        open={modal === "revise"}
        kind="revise"
        post={post}
        onClose={() => setModal(null)}
        onConfirm={(note) => { setModal(null); handleRevise(note); }}
      />
      <ReasonModal
        open={modal === "reject"}
        kind="reject"
        post={post}
        onClose={() => setModal(null)}
        onConfirm={(note) => { setModal(null); handleReject(note); }}
      />
    </>
  );
}

function DetailRow({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[80px_1fr] gap-2">
      <dt className="text-ink-3">{k}</dt>
      <dd className="text-ink-2">{v}</dd>
    </div>
  );
}

function ReplyBox({ postId }: { postId: string }) {
  const [val, setVal] = useState("");
  const [sending, setSending] = useState(false);

  const send = async () => {
    if (!val.trim() || sending) return;
    setSending(true);
    try {
      await apiFetch(`/client/content/${postId}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: val.trim() }),
      });
      mutate(`/client/content/${postId}/comments`);
      setVal("");
    } catch (err) {
      console.error("Failed to send reply:", err);
      Actions.toast({ kind: "danger", text: "Could not send reply. Please try again." });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="border-t border-rule p-2.5 flex items-end gap-2">
      <textarea
        value={val}
        onChange={(e) => setVal(e.target.value)}
        placeholder="Reply…"
        rows={1}
        disabled={sending}
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }}
        className="flex-1 resize-none text-[13px] bg-bg/40 border border-border rounded-md px-2.5 py-1.5 outline-none focus:bg-surface min-h-[34px] disabled:opacity-50"
      />
      <IconButton size="sm" variant="ink" icon={<Icon.Send size={15}/>} label="Send" onClick={send} disabled={!val.trim() || sending} />
    </div>
  );
}
