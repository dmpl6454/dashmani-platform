"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { mutate } from "swr";
import { Topstrip } from "@/components/portal-topstrip";
import { Button, StatusBadge, Avatar, FormatPill, AspectThumb, Empty, Skeleton, PageError } from "@/components/portal-shared";
import { Icon } from "@/components/portal-icons";
import { fmt, Actions } from "@/lib/portal-store";
import { apiFetch } from "@/lib/api";
import { useClientProjects } from "@/lib/hooks/use-projects";
import { useClientPendingApprovals, PENDING_APPROVALS_KEY } from "@/lib/hooks/use-content";
import { useClientAnalytics } from "@/lib/hooks/use-analytics";
import { NewBriefModal } from "@/components/new-brief-modal";

// Minimal local types for API shapes
interface ApiPost {
  id: string;
  title: string;
  format: "REEL" | "CAROUSEL" | "STORY" | "POST" | "DOC";
  aspectRatio: string | null;
  scheduledAt: string | null;
  status: string;
  project?: { id: string; name: string } | null;
  authorName: string;
}

interface ApiProject {
  id: string;
  name: string;
  status: string;
  healthScore: number | null;
}

interface ClientAnalytics {
  totalPosts: number;
  postsByStatus: Record<string, number>;
  postsByFormat: Record<string, number>;
  approvalTurnaround: number | null;
  scheduledThisWeek: number;
  liveThisWeek: number;
  projectSummaries: unknown[];
}

export default function DashboardPage() {
  const router = useRouter();
  const [briefOpen, setBriefOpen] = useState(false);

  const { data: approvalsData, isLoading: approvalsLoading, error: approvalsError } = useClientPendingApprovals();
  const { data: projectsRaw, isLoading: projectsLoading } = useClientProjects();
  const { data: analyticsData } = useClientAnalytics();

  const isLoading = approvalsLoading || projectsLoading;

  const pending: ApiPost[] = (approvalsData ?? []) as ApiPost[];
  const projects: ApiProject[] = (projectsRaw?.items ?? []) as ApiProject[];

  const now = new Date();

  // Map pending posts to UI-friendly shape
  const mappedPending = pending.map((p) => ({
    id: p.id,
    title: p.title,
    format: p.format,
    aspect: p.aspectRatio,
    scheduled: p.scheduledAt,
    status: p.status,
    project: p.project?.id ?? null,
    projectName: p.project?.name ?? null,
    authorName: p.authorName,
    overdue: !!(p.scheduledAt && new Date(p.scheduledAt) < now && p.status === "PENDING_APPROVAL"),
  }));

  const overdue = mappedPending.filter((p) => p.overdue).length;
  const dueToday = mappedPending.filter((p) => {
    if (!p.scheduled) return false;
    return new Date(p.scheduled).toDateString() === now.toDateString();
  }).length;

  if (isLoading) {
    return (
      <>
        <Topstrip title="Home" />
        <div className="px-6 py-6 max-w-[1200px] mx-auto w-full space-y-6">
          <Skeleton className="h-8 w-48" />
          <div className="grid grid-cols-4 gap-4">
            {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-20" />)}
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-[1.4fr_1fr] gap-4">
            <Skeleton className="h-64" />
            <Skeleton className="h-64" />
          </div>
        </div>
      </>
    );
  }

  if (approvalsError) {
    return (
      <>
        <Topstrip title="Home" />
        <div className="p-6 flex-1 grid place-items-center">
          <PageError message="Could not load dashboard data." />
        </div>
      </>
    );
  }

  return (
    <>
      <Topstrip
        title="Home"
        sub={new Date().toLocaleDateString("en", { weekday: "long", month: "short", day: "numeric" })}
        right={<Button variant="primary" size="sm" icon={<Icon.Plus size={15} sw={2.4}/>} onClick={() => setBriefOpen(true)}>New brief</Button>}
      />
      <NewBriefModal open={briefOpen} onClose={() => setBriefOpen(false)} />
      <div className="px-6 py-6 max-w-[1200px] mx-auto w-full">
        {/* ── Approvals queue — hero. Shown unconditionally; "All caught up" is the empty state. ── */}
        <section aria-labelledby="approvals-heading" className="mb-6">
          <div className="flex items-end justify-between mb-3 gap-3 flex-wrap">
            <div>
              <h2 id="approvals-heading" className="text-[22px] font-semibold leading-tight">
                {mappedPending.length > 0 ? "Awaiting your review" : "You're all caught up"}
              </h2>
              <p className="text-[13px] text-ink-3 mt-0.5">
                {mappedPending.length > 0 ? (
                  <>
                    {mappedPending.length} item{mappedPending.length !== 1 ? "s" : ""}
                    {dueToday > 0 ? ` · ${dueToday} due today` : ""}
                    {overdue > 0 ? <> · <span className="text-attention font-medium">{overdue} overdue</span></> : ""}
                  </>
                ) : (
                  <>No pending approvals right now.</>
                )}
              </p>
            </div>
            {mappedPending.length > 0 && (
              <Button variant="default" size="sm" iconRight={<Icon.ArrowRight size={14}/>} onClick={() => router.push("/approvals")}>
                Open inbox
              </Button>
            )}
          </div>

          {mappedPending.length === 0 ? (
            <div className="bg-surface border border-border rounded-lg p-8">
              <Empty
                icon={<Icon.Check size={20}/>}
                title="No approvals pending"
                hint="Your agency will send drafts here when they're ready for review."
                cta={<Button variant="ghost" size="sm" onClick={() => router.push("/content")} iconRight={<Icon.ArrowRight size={14}/>}>Browse scheduled content</Button>}
              />
            </div>
          ) : (
            <div className="bg-surface border border-border rounded-lg overflow-hidden">
              {mappedPending.slice(0, 5).map((p, i) => (
                <DashApprovalRow
                  key={p.id}
                  post={p}
                  projectName={p.projectName}
                  divider={i < Math.min(4, mappedPending.length - 1)}
                />
              ))}
              {mappedPending.length > 5 && (
                <button
                  onClick={() => router.push("/approvals")}
                  className="w-full h-10 text-[13px] font-medium text-ink-2 hover:bg-muted/60 transition-colors border-t border-rule flex items-center justify-center gap-1.5"
                >
                  See {mappedPending.length - 5} more <Icon.ArrowRight size={14}/>
                </button>
              )}
            </div>
          )}
        </section>

        {/* ── Vanity stats demoted to a single inline strip. Operational, not decorative. ── */}
        <section aria-label="Quick stats" className="mb-6">
          <div className="bg-surface border border-border rounded-lg divide-x divide-rule flex">
            <DashStat label="Active projects" value={projects.filter((p) => p.status === "ACTIVE").length} />
            <DashStat label="Scheduled posts" value={analyticsData?.scheduledThisWeek ?? 0} sub="next 7 days" />
            <DashStat label="Avg. approval" value={analyticsData?.approvalTurnaround ? `${analyticsData.approvalTurnaround}h` : "—"} sub="last 30d" />
            <DashStat label="Posts went live" value={analyticsData?.liveThisWeek ?? 0} sub="last 7 days" />
          </div>
        </section>

        {/* ── Projects + Activity ── */}
        <section className="grid grid-cols-1 lg:grid-cols-[1.4fr_1fr] gap-4">
          <div className="bg-surface border border-border rounded-lg">
            <div className="px-4 h-11 border-b border-rule flex items-center justify-between">
              <h3 className="text-[13px] font-semibold text-ink">Your projects</h3>
              <button onClick={() => router.push("/projects")} className="text-[12px] text-ink-3 hover:text-ink inline-flex items-center gap-1">
                View all <Icon.ArrowRight size={12}/>
              </button>
            </div>
            <ul>
              {projects.filter((p) => p.status === "ACTIVE").slice(0, 4).map((p, i, arr) => (
                <li key={p.id}>
                  <button
                    onClick={() => router.push("/projects")}
                    className={`w-full px-4 h-11 flex items-center gap-3 hover:bg-muted/40 transition-colors text-left ${i < arr.length - 1 ? "border-b border-rule" : ""}`}
                  >
                    <StatusBadge status={p.status as any} className="!h-5 !text-[10.5px]" />
                    <span className="flex-1 text-[13.5px] truncate text-rowtight">{p.name}</span>
                    <Icon.ChevRight size={14} className="text-ink-4" />
                  </button>
                </li>
              ))}
              {projects.filter((p) => p.status === "ACTIVE").length === 0 && (
                <li className="px-4 py-6 text-[12px] text-ink-4 text-center">No active projects.</li>
              )}
            </ul>
          </div>

          <div className="bg-surface border border-border rounded-lg">
            <div className="px-4 h-11 border-b border-rule flex items-center justify-between">
              <h3 className="text-[13px] font-semibold text-ink">Since you were here</h3>
              <span className="text-[11px] text-ink-3">last 12h</span>
            </div>
            <div className="px-4 py-6 text-[12px] text-ink-4 text-center">No recent activity.</div>
          </div>
        </section>
      </div>
    </>
  );
}

function DashStat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="flex-1 px-4 py-3">
      <div className="text-[11px] uppercase tracking-wider text-ink-3 font-medium">{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-[22px] font-semibold leading-none text-ink tabular-nums">{value}</span>
        {sub && <span className="text-[11px] text-ink-3">{sub}</span>}
      </div>
    </div>
  );
}

function DashApprovalRow({
  post,
  projectName,
  divider,
}: {
  post: any;
  projectName: string | null;
  divider: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const due = post.scheduled ? fmt.date(post.scheduled) : null;

  const handleApprove = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setBusy(true);
    try {
      await apiFetch(`/client/content/${post.id}/respond`, {
        method: "PUT",
        body: JSON.stringify({ status: "APPROVED" }),
      });
      mutate(PENDING_APPROVALS_KEY);
    } catch (err) {
      console.error("Approve failed:", err);
      Actions.toast({ kind: "danger", text: "Could not approve. Please try again." });
    } finally {
      setBusy(false);
    }
  };

  const handleRevise = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setBusy(true);
    try {
      await apiFetch(`/client/content/${post.id}/respond`, {
        method: "PUT",
        body: JSON.stringify({ status: "REJECTED", clientNote: "Please revise per upcoming notes." }),
      });
      mutate(PENDING_APPROVALS_KEY);
    } catch (err) {
      console.error("Revise failed:", err);
      Actions.toast({ kind: "danger", text: "Could not request revision. Please try again." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={`group flex items-center gap-3 px-3 py-2.5 hover:bg-muted/40 cursor-pointer transition-colors ${divider ? "border-b border-rule" : ""}`}
      onClick={() => router.push(`/content/${post.id}`)}
    >
      <AspectThumb aspect={post.aspect || "1:1"} format={post.format} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[14px] font-medium text-ink truncate">{post.title}</span>
          <FormatPill format={post.format} aspect={post.aspect} />
        </div>
        <div className="text-[12px] text-ink-3 mt-0.5 truncate">
          {projectName ?? "—"} · by {post.authorName} ·{" "}
          <span className={post.overdue ? "text-attention font-medium" : ""}>{due}{post.overdue ? " · overdue" : ""}</span>
        </div>
      </div>
      <div className="flex items-center gap-1.5 opacity-90 group-hover:opacity-100">
        <Button variant="default" size="sm" onClick={handleRevise} disabled={busy}>Revise</Button>
        <Button variant="primary" size="sm" onClick={handleApprove} icon={<Icon.Check size={15} sw={2.4}/>} disabled={busy}>Approve</Button>
      </div>
    </div>
  );
}
