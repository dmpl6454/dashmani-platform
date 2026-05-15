"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { mutate } from "swr";
import { Topstrip } from "@/components/portal-topstrip";
import { Button, AspectThumb, FormatPill, Avatar, Empty, KbdRow, Modal, PageError } from "@/components/portal-shared";
import { Icon } from "@/components/portal-icons";
import { ReasonModal } from "@/components/reason-modal";
import { IGFeedCard } from "@/components/ig-previews";
import { Actions, fmt } from "@/lib/portal-store";
import { useClientProjects } from "@/lib/hooks/use-projects";
import { useClientPendingApprovals, PENDING_APPROVALS_KEY } from "@/lib/hooks/use-content";
import { apiFetch } from "@/lib/api";

export default function ApprovalsPage() {
  const router = useRouter();
  const { data: approvalsData, isLoading, error: approvalsError } = useClientPendingApprovals();
  const pending: any[] = approvalsData ?? [];

  const { data: projectsData } = useClientProjects();
  const projects: any[] = projectsData?.items ?? [];

  const [focusId, setFocusId] = useState<string | undefined>(pending[0]?.id);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [modal, setModal] = useState<null | "revise" | "reject" | "bulk-confirm" | "bulk-revise">(null);

  useEffect(() => {
    if (!pending.find((p) => p.id === focusId)) {
      setFocusId(pending[0]?.id);
    }
  }, [pending, focusId]);

  useEffect(() => {
    const valid = new Set(pending.map((p) => p.id));
    const next = new Set([...selectedIds].filter((id) => valid.has(id)));
    if (next.size !== selectedIds.size) setSelectedIds(next);
  }, [pending]);

  const focusPost = pending.find((p) => p.id === focusId) || null;
  const focusIndex = pending.findIndex((p) => p.id === focusId);
  const focusProjectId = focusPost?.project?.id ?? focusPost?.project;
  const focusProject = focusPost ? projects.find((pr) => pr.id === focusProjectId) || null : null;

  async function handleApprove(id: string) {
    try {
      await apiFetch(`/client/content/${id}/respond`, {
        method: "PUT",
        body: JSON.stringify({ status: "APPROVED" }),
      });
      mutate(PENDING_APPROVALS_KEY);
    } catch {
      Actions.toast({ kind: "danger", text: "Could not approve. Please try again." });
    }
  }

  async function handleRevise(id: string, note: string) {
    try {
      await apiFetch(`/client/content/${id}/respond`, {
        method: "PUT",
        body: JSON.stringify({ status: "REJECTED", clientNote: note }),
      });
      mutate(PENDING_APPROVALS_KEY);
    } catch {
      Actions.toast({ kind: "danger", text: "Could not request revision. Please try again." });
    }
  }

  async function handleReject(id: string, note: string) {
    try {
      await apiFetch(`/client/content/${id}/respond`, {
        method: "PUT",
        body: JSON.stringify({ status: "REJECTED", clientNote: note }),
      });
      mutate(PENDING_APPROVALS_KEY);
    } catch {
      Actions.toast({ kind: "danger", text: "Could not reject. Please try again." });
    }
  }

  async function handleBulkApprove(ids: string[]) {
    try {
      await Promise.all(ids.map(id =>
        apiFetch(`/client/content/${id}/respond`, {
          method: "PUT",
          body: JSON.stringify({ status: "APPROVED" }),
        })
      ));
      mutate(PENDING_APPROVALS_KEY);
      setSelectedIds(new Set());
      setModal(null);
    } catch {
      Actions.toast({ kind: "danger", text: "Bulk approve failed. Please try again." });
    }
  }

  async function handleBulkRevise(note: string) {
    try {
      await Promise.all(selectedArray.map(p =>
        apiFetch(`/client/content/${p.id}/respond`, {
          method: "PUT",
          body: JSON.stringify({ status: "REJECTED", clientNote: note }),
        })
      ));
      mutate(PENDING_APPROVALS_KEY);
      setSelectedIds(new Set());
      setModal(null);
    } catch {
      Actions.toast({ kind: "danger", text: "Bulk revision request failed. Please try again." });
    }
  }

  const move = (dir: number) => {
    if (!pending.length) return;
    const next = Math.max(0, Math.min(pending.length - 1, (focusIndex < 0 ? 0 : focusIndex) + dir));
    setFocusId(pending[next].id);
  };

  const toggleSelect = (id: string) =>
    setSelectedIds((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });

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
  }, [focusPost, focusIndex, pending, modal, router]);

  const selectedArray = pending.filter((p) => selectedIds.has(p.id));
  const selectedProjects = new Set(selectedArray.map((p) => p.project?.id ?? p.project));
  const bulkSafe = selectedArray.length > 0 && selectedProjects.size === 1;

  return (
    <>
      <Topstrip
        title="Approvals"
        sub={`${pending.length} pending · keyboard-first`}
        right={
          <div className="text-[11.5px] text-ink-3 flex items-center gap-2.5">
            <KbdRow items={[{ k: "A", label: "approve" }, { k: "R", label: "revise" }, { k: "X", label: "reject" }, { k: "↑↓", label: "move" }]} />
          </div>
        }
      />

      {selectedArray.length > 0 && (
        <div className="sticky top-14 z-20 bg-action-soft border-b border-action px-6 h-12 flex items-center gap-3">
          <span className="text-[13px] font-medium text-ink">
            {selectedArray.length} selected
            {!bulkSafe && <span className="text-attention ml-2">· spans {selectedProjects.size} projects</span>}
          </span>
          <div className="flex-1"/>
          <Button variant="default" size="sm" onClick={() => setSelectedIds(new Set())}>Clear</Button>
          <Button variant="default" size="sm" onClick={() => setModal("bulk-revise")}>Request revision</Button>
          <Button
            variant="primary"
            size="sm"
            icon={<Icon.Check size={15} sw={2.4}/>}
            disabled={!bulkSafe}
            title={!bulkSafe ? "Selection spans multiple projects" : undefined}
            onClick={() => setModal("bulk-confirm")}
          >
            Approve {selectedArray.length}
          </Button>
        </div>
      )}

      <div className="flex-1 grid grid-cols-[340px_1fr] min-h-0">
        <div className="border-r border-rule bg-bg overflow-y-auto">
          {approvalsError && !isLoading ? (
            <div className="p-4">
              <PageError message="Could not load approvals." />
            </div>
          ) : isLoading ? (
            <div className="p-4 space-y-2">
              {[0,1,2,3].map(i => <div key={i} className="h-16 bg-muted rounded animate-pulse"/>)}
            </div>
          ) : pending.length === 0 ? (
            <Empty icon={<Icon.Check size={20}/>} title="Inbox zero" hint="Nothing waiting on you." />
          ) : (
            <ul>
              {pending.map((p, i) => {
                const postProjectId = p.project?.id ?? p.project;
                const matchingProject = projects.find((pr) => pr.id === postProjectId) || null;
                return (
                  <ApprovalListRow
                    key={p.id}
                    post={p}
                    project={matchingProject}
                    selected={selectedIds.has(p.id)}
                    focused={focusId === p.id}
                    onSelect={(e) => { e.stopPropagation(); toggleSelect(p.id); }}
                    onFocus={() => setFocusId(p.id)}
                    onOpen={() => router.push(`/content/${p.id}`)}
                    divider={i < pending.length - 1}
                  />
                );
              })}
            </ul>
          )}
        </div>

        <div className="overflow-y-auto bg-surface/30">
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
              <Empty icon={<Icon.Check size={20}/>} title="You're caught up" hint="New drafts will appear here." />
            </div>
          )}
        </div>
      </div>

      <ReasonModal
        open={modal === "revise"}
        kind="revise"
        post={focusPost}
        onClose={() => setModal(null)}
        onConfirm={(note) => { setModal(null); if (focusPost) handleRevise(focusPost.id, note); }}
      />
      <ReasonModal
        open={modal === "reject"}
        kind="reject"
        post={focusPost}
        onClose={() => setModal(null)}
        onConfirm={(note) => { setModal(null); if (focusPost) handleReject(focusPost.id, note); }}
      />

      <Modal
        open={modal === "bulk-confirm"}
        onClose={() => setModal(null)}
        title="Confirm bulk approval"
        size="lg"
        footer={<>
          <Button variant="ghost" onClick={() => setModal(null)}>Cancel</Button>
          <Button variant="primary" icon={<Icon.Check size={15} sw={2.4}/>} onClick={() => handleBulkApprove([...selectedIds])}>
            Approve all {selectedArray.length}
          </Button>
        </>}
      >
        <p className="text-[13px] text-ink-2 mb-3 text-rowtight">
          You&apos;re approving <b>{selectedArray.length}</b> items in{" "}
          <b>{projects.find((pr) => pr.id === (selectedArray[0]?.project?.id ?? selectedArray[0]?.project))?.name ?? projects.find((pr) => pr.id === (selectedArray[0]?.project?.id ?? selectedArray[0]?.project))?.short}</b>. They&apos;ll all go to scheduled.
        </p>
        <ul className="bg-bg border border-border rounded-md max-h-[260px] overflow-y-auto divide-y divide-rule">
          {selectedArray.map((p) => (
            <li key={p.id} className="px-3 py-2 flex items-center gap-2.5 text-[13px]">
              <AspectThumb aspect={(p.aspectRatio ?? p.aspect) || "1:1"} format={p.format} />
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">{p.title}</div>
                <div className="text-[11.5px] text-ink-3">{fmt.date(p.scheduledAt ?? p.scheduled)}</div>
              </div>
              <FormatPill format={p.format} aspect={(p.aspectRatio ?? p.aspect)}/>
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

function ApprovalListRow({ post, project, selected, focused, onSelect, onFocus, onOpen, divider }: {
  post: any; project: any | null; selected: boolean; focused: boolean;
  onSelect: (e: React.MouseEvent) => void; onFocus: () => void; onOpen: () => void; divider: boolean;
}) {
  const overdue = post.overdue ?? (post.scheduledAt && new Date(post.scheduledAt) < new Date() && post.status === "PENDING_APPROVAL");
  const due = fmt.date(post.scheduledAt ?? post.scheduled);
  return (
    <li
      onClick={onFocus}
      onDoubleClick={onOpen}
      className={`group cursor-pointer transition-colors border-l-2 ${focused ? "bg-surface border-l-action" : selected ? "bg-action-soft/40 border-l-transparent" : "bg-bg border-l-transparent hover:bg-surface/50"} ${divider ? "border-b border-rule" : ""}`}
    >
      <div className="px-3 py-2.5 flex items-start gap-2.5">
        <label className="pt-0.5" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={selected}
            onChange={(e) => onSelect(e as unknown as React.MouseEvent)}
            className="h-4 w-4 rounded border-border accent-ink cursor-pointer"
          />
        </label>
        <AspectThumb aspect={(post.aspectRatio ?? post.aspect) || "1:1"} format={post.format} />
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-medium truncate">{post.title}</div>
          <div className="text-[11.5px] text-ink-3 truncate">{project?.name ?? project?.short} · by {post.authorName}</div>
          <div className="text-[11px] mt-0.5 flex items-center gap-1.5">
            <span className={overdue ? "text-attention font-medium" : "text-ink-3"}>{due}{overdue ? " · overdue" : ""}</span>
          </div>
        </div>
      </div>
    </li>
  );
}

function ApprovalPreview({ post, project, onOpen, onApprove, onRevise, onReject }: {
  post: any; project: any | null; onOpen: () => void;
  onApprove: () => void; onRevise: () => void; onReject: () => void;
}) {
  const overdue = post.overdue ?? (post.scheduledAt && new Date(post.scheduledAt) < new Date() && post.status === "PENDING_APPROVAL");
  const previewPost = {
    ...post,
    aspect: post.aspectRatio ?? post.aspect,
    scheduled: post.scheduledAt ?? post.scheduled,
  };
  return (
    <div className="p-6 max-w-[820px] mx-auto">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="min-w-0">
          <h2 className="text-[20px] font-semibold leading-tight truncate">{post.title}</h2>
          <div className="text-[12.5px] text-ink-3 mt-1 flex items-center gap-2">
            <span>{project?.name ?? project?.short}</span>
            <span>·</span>
            <FormatPill format={post.format} aspect={post.aspectRatio ?? post.aspect}/>
            {post.duration && <span className="tabular-nums">{post.duration}</span>}
            <span>·</span>
            <span>by {post.authorName}</span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {overdue && (
            <span className="text-[11.5px] px-2 h-6 inline-flex items-center bg-attention-bg text-attention rounded font-medium">
              overdue · {fmt.date(post.scheduledAt ?? post.scheduled)}
            </span>
          )}
          <Button variant="ghost" size="sm" iconRight={<Icon.ArrowRight size={14}/>} onClick={onOpen}>Open</Button>
        </div>
      </div>

      <div className="grid grid-cols-[340px_1fr] gap-6 mb-4">
        <IGFeedCard post={previewPost} />
        <div className="space-y-4 min-w-0">
          <div className="bg-surface border border-border rounded-lg p-4">
            <h3 className="text-[11px] uppercase tracking-wider font-medium text-ink-3 mb-2">Caption</h3>
            <p className="text-[13.5px] leading-relaxed text-ink-2 text-rowtight">{post.caption}</p>
            {post.hashtags?.length > 0 && <p className="text-[12.5px] text-ink-3 mt-2 text-rowtight">{post.hashtags.join(" ")}</p>}
          </div>
          <div className="bg-surface border border-border rounded-lg">
            <div className="px-4 h-11 border-b border-rule flex items-center justify-between">
              <h3 className="text-[12px] uppercase tracking-wider font-medium text-ink-3">Discussion</h3>
              <span className="text-[11px] text-ink-3">{(post.thread ?? post.comments ?? []).length}</span>
            </div>
            <div className="px-4 py-3 space-y-3 max-h-[180px] overflow-y-auto">
              {(post.thread ?? post.comments ?? []).length === 0 ? (
                <div className="text-[12px] text-ink-4 text-center py-2">No comments yet.</div>
              ) : (post.thread ?? post.comments ?? []).map((t: any, i: number) => (
                <div key={i} className="flex items-start gap-2.5">
                  <Avatar initial={t.a ?? t.authorName?.[0] ?? "?"} size="xs" />
                  <div className="flex-1 min-w-0">
                    <div className="text-[11.5px] text-ink-3">
                      <span className="font-medium text-ink-2">{t.a ?? t.authorName ?? "Agency"}</span> · {t.at ?? (t.createdAt ? new Date(t.createdAt).toLocaleDateString() : "")}
                    </div>
                    <div className="text-[13px] text-ink-2 text-rowtight">{t.t ?? t.body}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="sticky bottom-0 -mx-6 px-6 py-3 bg-bg/95 backdrop-blur border-t border-rule flex items-center gap-2">
        <div className="text-[12px] text-ink-3 hidden md:block">Press A to approve, R to revise, X to reject.</div>
        <div className="flex-1"/>
        <Button variant="danger" size="md" icon={<Icon.X size={15}/>} kbd="X" onClick={onReject}>Reject</Button>
        <Button variant="default" size="md" icon={<Icon.Edit size={15}/>} kbd="R" onClick={onRevise}>Request revision</Button>
        <Button variant="primary" size="md" icon={<Icon.Check size={16} sw={2.4}/>} kbd="A" onClick={onApprove}>Approve</Button>
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
    <Modal
      open={open}
      onClose={onClose}
      title={`Request revision · ${items.length} items`}
      size="lg"
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!canSubmit} onClick={() => onConfirm(note.trim())}>
          Send to {items.length} items
        </Button>
      </>}
    >
      <p className="text-[13px] text-ink-2 mb-3 text-rowtight">This note will be attached to every selected item.</p>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        autoFocus
        rows={4}
        placeholder="What needs to change across all of these?"
        className="w-full text-[13px] bg-bg/40 border border-border rounded-md px-3 py-2 outline-none focus:bg-surface focus:border-ink resize-none"
      />
      <div className="text-[11px] text-ink-3 mt-1">{note.length < 6 ? `Add at least ${6 - note.length} more.` : "Looks good."}</div>
    </Modal>
  );
}
