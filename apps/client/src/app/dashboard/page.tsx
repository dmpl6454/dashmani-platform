"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { mutate } from "swr";
import { Topstrip } from "@/components/portal-topstrip";
import { Button, StatusBadge, FormatPill, AspectThumb, Empty, Skeleton, PageError } from "@/components/portal-shared";
import { Icon } from "@/components/portal-icons";
import { fmt, Actions } from "@/lib/portal-store";
import { apiFetch } from "@/lib/api";
import { useClientProjects } from "@/lib/hooks/use-projects";
import { useClientPendingApprovals, PENDING_APPROVALS_KEY } from "@/lib/hooks/use-content";
import { useClientAnalytics } from "@/lib/hooks/use-analytics";
import { NewBriefModal } from "@/components/new-brief-modal";

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

const ACCENT_ICON: Record<string, string> = {
  indigo: "bg-indigo-soft text-indigo",
  sage:   "bg-sage-soft text-sage",
  terra:  "bg-terra-soft text-terra",
  action: "bg-action-soft text-ink-2",
};

export default function DashboardPage() {
  const router = useRouter();
  const [briefOpen, setBriefOpen] = useState(false);

  const { data: approvalsData, isLoading: approvalsLoading, error: approvalsError } = useClientPendingApprovals();
  const { data: projectsRaw, isLoading: projectsLoading } = useClientProjects();
  const { data: analyticsData } = useClientAnalytics();

  const isLoading = approvalsLoading || projectsLoading;
  const now = new Date();

  const pending: ApiPost[] = (approvalsData ?? []) as ApiPost[];
  const projects: ApiProject[] = (projectsRaw?.items ?? []) as ApiProject[];

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
  const dueToday = mappedPending.filter((p) => p.scheduled && new Date(p.scheduled).toDateString() === now.toDateString()).length;
  const activeProj = projects.filter((p) => p.status === "ACTIVE").length;

  const statTiles = [
    { label: "Active projects",  value: activeProj,                                       sub: "in progress",  accent: "indigo", IconC: Icon.Folder   },
    { label: "Scheduled posts",  value: analyticsData?.scheduledThisWeek ?? 0,            sub: "next 7 days",  accent: "sage",   IconC: Icon.Calendar },
    { label: "Avg. approval",    value: analyticsData?.approvalTurnaround ? `${analyticsData.approvalTurnaround}h` : "—", sub: "last 30 days", accent: "terra", IconC: Icon.Clock },
    { label: "Posts live",       value: analyticsData?.liveThisWeek ?? 0,                 sub: "last 7 days",  accent: "action", IconC: Icon.Chart    },
  ];

  if (isLoading) {
    return (
      <>
        <Topstrip title="Home" sub={now.toLocaleDateString("en", { weekday: "long", month: "short", day: "numeric" })} />
        <div className="px-6 py-6 max-w-[1260px] mx-auto w-full space-y-4">
          <Skeleton className="h-40 v3-card" />
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-32 v3-card" />)}
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-4">
            <Skeleton className="h-56 v3-card" />
            <Skeleton className="h-56 v3-card" />
          </div>
        </div>
      </>
    );
  }

  if (approvalsError) {
    return (
      <>
        <Topstrip title="Home" />
        <div className="p-6 flex-1 grid place-items-center"><PageError message="Could not load dashboard data." /></div>
      </>
    );
  }

  return (
    <>
      <Topstrip
        title="Home"
        sub={now.toLocaleDateString("en", { weekday: "long", month: "short", day: "numeric" })}
        right={
          <Button variant="ink" size="sm" icon={<Icon.Plus size={14} sw={2.5} />} onClick={() => setBriefOpen(true)}>
            New brief
          </Button>
        }
      />
      <NewBriefModal open={briefOpen} onClose={() => setBriefOpen(false)} />

      <div className="px-6 py-6 max-w-[1260px] mx-auto w-full overflow-y-auto flex-1">
        <div className="bento grid-cols-1">

          {/* ── Row 1: Approvals hero ── */}
          <section className="fade-up d1">
            <div className={`v3-card overflow-hidden ${mappedPending.length === 0 ? "border-success/40" : ""}`}>
              <div className="px-6 py-4 flex items-center justify-between gap-3 flex-wrap" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
                <div>
                  <h2 className="font-display text-[22px] font-semibold leading-tight text-ink">
                    {mappedPending.length > 0
                      ? <>{mappedPending.length} item{mappedPending.length !== 1 ? "s" : ""} waiting for review</>
                      : <>You&rsquo;re all caught up</>}
                  </h2>
                  <p className="text-[13px] text-ink-3 mt-0.5 font-medium">
                    {mappedPending.length > 0 ? (
                      <>
                        {dueToday > 0 && <span className="text-attention font-semibold">{dueToday} due today · </span>}
                        {overdue  > 0 && <span className="text-attention font-semibold">{overdue} overdue · </span>}
                        Approvals inbox
                      </>
                    ) : (
                      <>Nothing pending. Your agency will send drafts here when ready.</>
                    )}
                  </p>
                </div>
                {mappedPending.length > 0 && (
                  <Button variant="ink" size="sm" iconRight={<Icon.ArrowRight size={13} />} onClick={() => router.push("/approvals")}>
                    Open inbox
                  </Button>
                )}
              </div>

              {mappedPending.length === 0 ? (
                <div className="px-6 py-7 flex items-center justify-center gap-2.5 text-success">
                  <Icon.Check size={18} sw={2.5} />
                  <span className="text-[14px] font-semibold">All content reviewed</span>
                </div>
              ) : (
                <ul>
                  {mappedPending.slice(0, 4).map((p, i) => (
                    <DashApprovalRow
                      key={p.id}
                      post={p}
                      divider={i < Math.min(3, mappedPending.length - 1)}
                      delay={`d${i + 2}`}
                    />
                  ))}
                  {mappedPending.length > 4 && (
                    <li>
                      <button
                        onClick={() => router.push("/approvals")}
                        className="w-full h-11 text-[13px] font-semibold text-indigo hover:bg-indigo-soft transition-colors flex items-center justify-center gap-1.5"
                        style={{ borderTop: "1px solid rgba(26,26,26,0.07)" }}
                      >
                        {mappedPending.length - 4} more in inbox <Icon.ArrowRight size={13} />
                      </button>
                    </li>
                  )}
                </ul>
              )}
            </div>
          </section>

          {/* ── Row 2: Stat tiles ── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {statTiles.map((tile, i) => {
              const IC = tile.IconC;
              return (
                <div key={i} className={`fade-up d${i + 2}`}>
                  <div className="v3-card v3-card-lift p-5 h-full flex flex-col gap-3">
                    <div className={`h-9 w-9 rounded-xl grid place-items-center ${ACCENT_ICON[tile.accent]}`}>
                      <IC size={16} sw={2} />
                    </div>
                    <div>
                      <div className="font-num text-[34px] font-semibold leading-none text-ink">{tile.value}</div>
                      <div className="text-[13px] font-semibold text-ink mt-1">{tile.label}</div>
                      <div className="text-[11.5px] text-ink-3 font-medium mt-0.5">{tile.sub}</div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* ── Row 3: Projects + Activity ── */}
          <div className="grid grid-cols-1 lg:grid-cols-[3fr_2fr] gap-4">
            <div className="fade-up d6">
              <div className="v3-card overflow-hidden">
                <div className="px-5 h-12 flex items-center justify-between" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
                  <h3 className="text-[14px] font-bold text-ink">Your projects</h3>
                  <button onClick={() => router.push("/projects")} className="text-[12.5px] text-indigo font-semibold hover:underline inline-flex items-center gap-1">
                    View all <Icon.ArrowRight size={12} />
                  </button>
                </div>
                <ul>
                  {projects.filter((p) => p.status === "ACTIVE").slice(0, 4).map((p, i, arr) => (
                    <li key={p.id} style={i < arr.length - 1 ? { borderBottom: "1px solid rgba(26,26,26,0.06)" } : {}}>
                      <button
                        onClick={() => router.push("/projects")}
                        className="w-full px-5 h-12 flex items-center gap-3 v3-row text-left"
                      >
                        <StatusBadge status={p.status as any} className="!h-5 !text-[10px]" />
                        <span className="flex-1 text-[13.5px] font-semibold text-ink truncate">{p.name}</span>
                        <Icon.ChevRight size={14} className="text-ink-4 shrink-0" />
                      </button>
                    </li>
                  ))}
                  {projects.filter((p) => p.status === "ACTIVE").length === 0 && (
                    <li className="px-5 py-8 text-[12.5px] text-ink-4 text-center font-medium">No active projects.</li>
                  )}
                </ul>
              </div>
            </div>

            <div className="fade-up d7">
              <div className="v3-card overflow-hidden">
                <div className="px-5 h-12 flex items-center justify-between" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
                  <h3 className="text-[14px] font-bold text-ink">Recent activity</h3>
                  <span className="text-[11px] text-ink-3 font-medium">last 12h</span>
                </div>
                <div className="px-5 py-6 text-[12.5px] text-ink-4 text-center font-medium">No recent activity.</div>
              </div>
            </div>
          </div>

        </div>
      </div>
    </>
  );
}

function DashApprovalRow({ post, divider, delay }: { post: any; divider: boolean; delay: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const act = (status: string) => async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    try {
      await apiFetch(`/client/content/${post.id}/respond`, {
        method: "PUT",
        body: JSON.stringify({ status, ...(status === "REVISION_REQUESTED" ? { clientNote: "Revision requested." } : {}) }),
      });
      mutate(PENDING_APPROVALS_KEY);
      Actions.toast({ kind: "success", text: status === "APPROVED" ? "Approved!" : "Revision requested." });
    } catch {
      Actions.toast({ kind: "danger", text: "Action failed. Please try again." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <li
      className={`group flex items-center gap-3 px-5 py-3.5 v3-row cursor-pointer fade-up ${delay}`}
      style={divider ? { borderBottom: "1px solid rgba(26,26,26,0.06)" } : {}}
      onClick={() => router.push(`/content/${post.id}`)}
    >
      <AspectThumb aspect={post.aspect || "1:1"} format={post.format} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[14px] font-semibold text-ink truncate">{post.title}</span>
          <FormatPill format={post.format} aspect={post.aspect} />
        </div>
        <div className="text-[12px] text-ink-3 mt-0.5 truncate font-medium">
          {post.projectName ?? "—"} · {post.authorName} ·{" "}
          <span className={post.overdue ? "text-attention font-semibold" : ""}>{post.scheduled ? fmt.date(post.scheduled) : "—"}</span>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
        <Button variant="default" size="sm" disabled={busy} onClick={act("REVISION_REQUESTED")}>Revise</Button>
        <Button variant="primary" size="sm" icon={<Icon.Check size={13} sw={2.5} />} disabled={busy} onClick={act("APPROVED")}>Approve</Button>
      </div>
    </li>
  );
}
