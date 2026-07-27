"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { mutate } from "swr";
import { Topstrip } from "@/components/portal-topstrip";
import { Button, AspectThumb, FormatPill, Avatar, Empty, KbdRow, Modal, PageError, IconButton, Tag } from "@/components/portal-shared";
import { Icon } from "@/components/portal-icons";
import { ReasonModal } from "@/components/reason-modal";
import { IGFeedCard } from "@/components/ig-previews";
import { Actions, fmt } from "@/lib/portal-store";
import { useClientProjects } from "@/lib/hooks/use-projects";
import { useClientPendingApprovals, PENDING_APPROVALS_KEY } from "@/lib/hooks/use-content";
import { useIsCompact } from "@/lib/hooks/use-input-device";
import { apiFetch } from "@/lib/api";

export default function ApprovalsPage() {
  const router = useRouter();
  const { data: approvalsData, isLoading, error: approvalsError } = useClientPendingApprovals();
  const pending: any[] = approvalsData ?? [];
  const { data: projectsData } = useClientProjects();
  const projects: any[] = projectsData?.items ?? [];
  const compact = useIsCompact();

  const [focusId, setFocusId] = useState<string | undefined>(pending[0]?.id);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [modal, setModal] = useState<null | "revise" | "reject" | "bulk-confirm" | "bulk-revise">(null);

  useEffect(() => {
    if (!pending.find((p) => p.id === focusId)) setFocusId(pending[0]?.id);
  }, [pending, focusId]);

  useEffect(() => {
    const valid = new Set(pending.map((p) => p.id));
    const next = new Set([...selectedIds].filter((id) => valid.has(id)));
    if (next.size !== selectedIds.size) setSelectedIds(next);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  const focusPost = pending.find((p) => p.id === focusId) || null;
  const focusIndex = pending.findIndex((p) => p.id === focusId);
  const focusProject = focusPost ? projects.find((pr) => pr.id === (focusPost.project?.id ?? focusPost.project)) || null : null;

  async function handleApprove(id: string) {
    try {
      await apiFetch(`/client/content/${id}/respond`, { method: "PUT", body: JSON.stringify({ status: "APPROVED" }) });
      mutate(PENDING_APPROVALS_KEY);
      Actions.toast({ kind: "success", text: "Approved!" });
    } catch { Actions.toast({ kind: "danger", text: "Could not approve. Please try again." }); }
  }

  async function handleRevise(id: string, note: string) {
    try {
      await apiFetch(`/client/content/${id}/respond`, { method: "PUT", body: JSON.stringify({ status: "REJECTED", clientNote: note }) });
      mutate(PENDING_APPROVALS_KEY);
      Actions.toast({ kind: "success", text: "Revision requested." });
    } catch { Actions.toast({ kind: "danger", text: "Could not request revision." }); }
  }

  async function handleBulkApprove(ids: string[]) {
    try {
      await Promise.all(ids.map(id => apiFetch(`/client/content/${id}/respond`, { method: "PUT", body: JSON.stringify({ status: "APPROVED" }) })));
      mutate(PENDING_APPROVALS_KEY);
      setSelectedIds(new Set());
      setModal(null);
      Actions.toast({ kind: "success", text: `Approved ${ids.length} items.` });
    } catch { Actions.toast({ kind: "danger", text: "Bulk approve failed." }); }
  }

  async function handleBulkRevise(note: string) {
    try {
      await Promise.all(selectedArray.map(p => apiFetch(`/client/content/${p.id}/respond`, { method: "PUT", body: JSON.stringify({ status: "REJECTED", clientNote: note }) })));
      mutate(PENDING_APPROVALS_KEY);
      setSelectedIds(new Set());
      setModal(null);
    } catch { Actions.toast({ kind: "danger", text: "Bulk revision failed." }); }
  }

  const move = (dir: number) => {
    if (!pending.length) return;
    setFocusId(pending[Math.max(0, Math.min(pending.length - 1, (focusIndex < 0 ? 0 : focusIndex) + dir))].id);
  };

  const toggleSelect = (id: string) =>
    setSelectedIds((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.matches("input, textarea, select") || modal) return;
      if (!focusPost) return;
      if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); move(1); }
      else if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); move(-1); }
      else if (e.key === "a" || e.key === "A") { e.preventDefault(); handleApprove(focusPost.id); }
      else if (e.key === "r" || e.key === "R") { e.preventDefault(); setModal("revise"); }
      else if (e.key === "x" || e.key === "X") { e.preventDefault(); setModal("reject"); }
      else if (e.key === "Enter") { e.preventDefault(); router.push(`/content/${focusPost.id}`); }
      else if (e.key === " ") { e.preventDefault(); toggleSelect(focusPost.id); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusPost, focusIndex, pending, modal, router]);

  const selectedArray = pending.filter((p) => selectedIds.has(p.id));
  const selectedProjects = new Set(selectedArray.map((p) => p.project?.id ?? p.project));
  const bulkSafe = selectedArray.length > 0 && selectedProjects.size === 1;

  return (
    <>
      <Topstrip
        title="Approvals"
        sub={pending.length > 0 ? `${pending.length} pending` : "Inbox zero"}
        right={
          <div className="hidden md:flex items-center gap-2">
            <KbdRow items={[{ k: "A", label: "approve" }, { k: "R", label: "revise" }, { k: "X", label: "reject" }, { k: "↑↓", label: "move" }]} />
          </div>
        }
      />

      {/* Bulk action bar */}
      {selectedArray.length > 0 && (
        <div
          /* Wraps on a phone — four controls in one 390px row overflowed the page.
             The sticky offset tracks the topstrip, which is h-14 there and h-16 up. */
          className="sticky top-14 sm:top-16 z-20 px-4 sm:px-6 py-2 sm:py-0 sm:h-12 flex flex-wrap items-center gap-x-3 gap-y-2 slide-right"
          style={{ background: "#EDEDFD", borderBottom: "2px solid rgba(93,95,239,0.25)" }}
        >
          <span className="text-[13px] font-bold text-indigo">
            {selectedArray.length} selected
            {!bulkSafe && <span className="text-attention ml-2 font-medium"> · spans {selectedProjects.size} projects</span>}
          </span>
          <div className="hidden sm:block flex-1" />
          <Button variant="ghost" size="sm" onClick={() => setSelectedIds(new Set())}>Clear</Button>
          <Button variant="default" size="sm" onClick={() => setModal("bulk-revise")}>Request revision</Button>
          <Button variant="primary" size="sm" icon={<Icon.Check size={13} sw={2.5} />}
            disabled={!bulkSafe}
            title={!bulkSafe ? "Selection spans multiple projects" : undefined}
            onClick={() => setModal("bulk-confirm")}>
            Approve {selectedArray.length}
          </Button>
        </div>
      )}

      {/* Split layout */}
      <div className="approvals-split flex-1 min-h-0">

        {/* List panel */}
        <div className="approvals-list overflow-y-auto bg-bg">
          {approvalsError && !isLoading ? (
            <div className="p-4"><PageError message="Could not load approvals." /></div>
          ) : isLoading ? (
            <div className="p-4 space-y-2">
              {[0,1,2,3].map(i => <div key={i} className="h-16 bg-muted rounded-xl animate-pulse" />)}
            </div>
          ) : pending.length === 0 ? (
            <Empty icon={<Icon.Check size={20} />} title="Inbox zero" hint="Nothing waiting on you." />
          ) : (
            <ul>
              {pending.map((p, i) => {
                const project = projects.find((pr) => pr.id === (p.project?.id ?? p.project)) || null;
                return (
                  <ApprovalListRow
                    key={p.id}
                    post={p}
                    project={project}
                    selected={selectedIds.has(p.id)}
                    focused={focusId === p.id}
                    onSelect={(e) => { e.stopPropagation(); toggleSelect(p.id); }}
                    onFocus={() => setFocusId(p.id)}
                    onOpen={() => router.push(`/content/${p.id}`)}
                    divider={i < pending.length - 1}
                    delay={`d${Math.min(i + 1, 8)}`}
                    compact={compact}
                  />
                );
              })}
            </ul>
          )}
        </div>

        {/* Preview panel */}
        <div className="approvals-detail overflow-y-auto" style={{ background: "rgba(243,238,216,0.3)" }}>
          {focusPost ? (
            <ApprovalPreview
              post={focusPost}
              project={focusProject}
              onOpen={() => router.push(`/content/${focusPost.id}`)}
              onApprove={() => handleApprove(focusPost.id)}
              onRevise={() => setModal("revise")}
              onReject={() => setModal("reject")}
            />
          ) : (
            <div className="h-full grid place-items-center">
              <Empty icon={<Icon.Check size={24} />} title="All caught up" hint="New drafts will appear here." />
            </div>
          )}
        </div>
      </div>

      <ReasonModal open={modal === "revise"} kind="revise" post={focusPost} onClose={() => setModal(null)}
        onConfirm={(note) => { setModal(null); if (focusPost) handleRevise(focusPost.id, note); }} />
      <ReasonModal open={modal === "reject"} kind="reject" post={focusPost} onClose={() => setModal(null)}
        onConfirm={(note) => { setModal(null); if (focusPost) handleRevise(focusPost.id, note); }} />

      <Modal open={modal === "bulk-confirm"} onClose={() => setModal(null)} title="Confirm bulk approval" size="lg"
        footer={<>
          <Button variant="ghost" onClick={() => setModal(null)}>Cancel</Button>
          <Button variant="primary" icon={<Icon.Check size={14} sw={2.5} />} onClick={() => handleBulkApprove([...selectedIds])}>
            Approve all {selectedArray.length}
          </Button>
        </>}>
        <p className="text-[13px] text-ink-2 font-medium mb-3">
          Approving <b className="text-ink">{selectedArray.length}</b> items in{" "}
          <b className="text-ink">{projects.find((pr) => pr.id === (selectedArray[0]?.project?.id ?? selectedArray[0]?.project))?.name ?? "—"}</b>. They&apos;ll all go to scheduled.
        </p>
        <ul className="v3-card-sm max-h-[240px] overflow-y-auto divide-y" style={{ borderColor: "rgba(26,26,26,0.07)" }}>
          {selectedArray.map((p) => (
            <li key={p.id} className="px-3 py-2.5 flex items-center gap-2.5 text-[13px]">
              <AspectThumb aspect={(p.aspectRatio ?? p.aspect) || "1:1"} format={p.format} />
              <div className="flex-1 min-w-0">
                <div className="font-semibold truncate">{p.title}</div>
                <div className="text-[11.5px] text-ink-3 font-medium">{fmt.date(p.scheduledAt ?? p.scheduled)}</div>
              </div>
              <FormatPill format={p.format} aspect={p.aspectRatio ?? p.aspect} />
            </li>
          ))}
        </ul>
      </Modal>

      <BulkReviseModal
        open={modal === "bulk-revise"}
        items={selectedArray}
        onClose={() => setModal(null)}
        onConfirm={(note) => handleBulkRevise(note)}
      />
    </>
  );
}

function ApprovalListRow({ post, project, selected, focused, onSelect, onFocus, onOpen, divider, delay, compact }: {
  post: any; project: any | null; selected: boolean; focused: boolean;
  onSelect: (e: React.MouseEvent) => void; onFocus: () => void; onOpen: () => void; divider: boolean; delay: string;
  compact: boolean;
}) {
  const overdue = post.overdue ?? (post.scheduledAt && new Date(post.scheduledAt) < new Date() && post.status === "PENDING_APPROVAL");
  const due = fmt.date(post.scheduledAt ?? post.scheduled);
  return (
    <li
      /* With the preview pane collapsed there is nothing for focus to drive, so a
         single tap has to open the post outright — otherwise tapping does nothing. */
      onClick={compact ? onOpen : onFocus}
      onDoubleClick={onOpen}
      className={`cursor-pointer transition-all fade-up ${delay}
        ${focused  ? "border-l-[3px] border-indigo bg-indigo-soft/60" : ""}
        ${selected && !focused ? "border-l-[3px] border-action bg-action-soft/30" : ""}
        ${!focused && !selected ? "border-l-[3px] border-transparent hover:bg-surface/70" : ""}`}
      style={divider ? { borderBottom: "1px solid rgba(26,26,26,0.07)" } : {}}
    >
      <div className="px-3 py-3 flex items-start gap-2.5">
        <label className="pt-0.5 shrink-0" onClick={(e) => e.stopPropagation()}>
          <input type="checkbox" checked={selected} onChange={(e) => onSelect(e as unknown as React.MouseEvent)}
            className="h-4 w-4 rounded cursor-pointer accent-indigo" />
        </label>
        <AspectThumb aspect={(post.aspectRatio ?? post.aspect) || "1:1"} format={post.format} />
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold truncate">{post.title}</div>
          <div className="text-[11.5px] text-ink-3 truncate font-medium">{project?.name ?? project?.short} · {post.authorName}</div>
          <div className="text-[11px] mt-0.5">
            <span className={`font-semibold ${overdue ? "text-attention" : "text-ink-3"}`}>
              {due}{overdue ? " · overdue" : ""}
            </span>
          </div>
        </div>
        {/* Only a navigating row gets the affordance */}
        {compact && (
          <span className="text-ink-4 shrink-0 self-center" aria-hidden>
            <Icon.ChevRight size={15} />
          </span>
        )}
      </div>
    </li>
  );
}

function ApprovalPreview({ post, project, onOpen, onApprove, onRevise, onReject }: {
  post: any; project: any | null; onOpen: () => void;
  onApprove: () => void; onRevise: () => void; onReject: () => void;
}) {
  const overdue = post.overdue ?? (post.scheduledAt && new Date(post.scheduledAt) < new Date() && post.status === "PENDING_APPROVAL");
  const previewPost = { ...post, aspect: post.aspectRatio ?? post.aspect, scheduled: post.scheduledAt ?? post.scheduled };
  return (
    <div className="p-6 max-w-[800px] mx-auto slide-right" key={post.id}>
      <div className="flex items-start justify-between gap-3 mb-5">
        <div className="min-w-0">
          <h2 className="font-display text-[22px] font-semibold leading-tight truncate">{post.title}</h2>
          <div className="text-[12.5px] text-ink-3 mt-1 flex items-center gap-2 font-medium flex-wrap">
            <span>{project?.name ?? project?.short}</span>
            <span>·</span>
            <FormatPill format={post.format} aspect={post.aspectRatio ?? post.aspect} />
            <span>·</span>
            <span>{post.authorName}</span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {overdue && <Tag tone="attention">overdue</Tag>}
          <Button variant="ghost" size="sm" iconRight={<Icon.ArrowRight size={13} />} onClick={onOpen}>Open full</Button>
        </div>
      </div>

      <div className="grid gap-5 mb-20 grid-cols-1 lg:grid-cols-[320px_1fr]">
        <IGFeedCard post={previewPost} />
        <div className="space-y-4 min-w-0">
          <div className="v3-card p-4">
            <h3 className="text-[11px] uppercase tracking-wider font-bold text-ink-3 mb-2">Caption</h3>
            <p className="text-[13.5px] leading-relaxed text-ink-2 font-medium">{post.caption}</p>
            {post.hashtags?.length > 0 && <p className="text-[12.5px] text-ink-3 mt-2 font-medium">{post.hashtags.join(" ")}</p>}
          </div>
          <div className="v3-card overflow-hidden">
            <div className="px-4 h-10 flex items-center justify-between" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
              <h3 className="text-[11px] uppercase tracking-wider font-bold text-ink-3">Discussion</h3>
              <span className="text-[11px] text-ink-3 font-medium">{(post.thread ?? post.comments ?? []).length}</span>
            </div>
            <div className="px-4 py-3 space-y-3 max-h-[160px] overflow-y-auto">
              {(post.thread ?? post.comments ?? []).length === 0 ? (
                <div className="text-[12px] text-ink-4 text-center py-2 font-medium">No comments yet.</div>
              ) : (post.thread ?? post.comments ?? []).map((t: any, i: number) => (
                <div key={i} className="flex items-start gap-2">
                  <Avatar initial={t.a ?? t.authorName?.[0] ?? "?"} size="xs" />
                  <div className="flex-1 min-w-0">
                    <div className="text-[11.5px] text-ink-3 font-semibold">{t.a ?? t.authorName ?? "Agency"} · {t.at ?? ""}</div>
                    <div className="text-[13px] text-ink-2 font-medium">{t.t ?? t.body}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Sticky decision bar */}
      <div
        className="fixed bottom-0 right-0 left-0 px-8 py-4 flex items-center gap-3"
        style={{ background: "rgba(253,252,240,0.97)", borderTop: "2px solid rgba(26,26,26,0.08)", backdropFilter: "blur(6px)", zIndex: 20 }}
      >
        <div className="text-[12px] text-ink-3 font-medium hidden md:block">A to approve · R to revise · X to reject</div>
        <div className="flex-1" />
        <Button variant="danger"  size="md" icon={<Icon.X    size={14} />} kbd="X" onClick={onReject}>Reject</Button>
        <Button variant="default" size="md" icon={<Icon.Edit size={14} />} kbd="R" onClick={onRevise}>Request revision</Button>
        <Button variant="primary" size="md" icon={<Icon.Check size={15} sw={2.5} />} kbd="A" onClick={onApprove}>Approve</Button>
      </div>
    </div>
  );
}

function BulkReviseModal({ open, items, onClose, onConfirm }: {
  open: boolean; items: any[]; onClose: () => void; onConfirm: (note: string) => void;
}) {
  const [note, setNote] = useState("");
  useEffect(() => { if (open) setNote(""); }, [open]);
  const canSubmit = note.trim().length >= 6;
  return (
    <Modal open={open} onClose={onClose} title={`Request revision · ${items.length} items`} size="lg"
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!canSubmit} onClick={() => onConfirm(note.trim())}>
          Send to {items.length} items
        </Button>
      </>}>
      <p className="text-[13px] text-ink-2 font-medium mb-3">This note will be attached to every selected item.</p>
      <textarea value={note} onChange={(e) => setNote(e.target.value)} autoFocus rows={4}
        placeholder="What needs to change across all of these?"
        className="w-full text-[13px] bg-bg rounded-xl px-3.5 py-2.5 outline-none resize-none font-medium"
        style={{ border: "2px solid rgba(26,26,26,0.2)" }}
      />
      <div className="text-[11.5px] text-ink-3 font-medium mt-1.5">
        {!canSubmit ? `${6 - note.trim().length} more characters needed.` : "Looks good ✓"}
      </div>
    </Modal>
  );
}
