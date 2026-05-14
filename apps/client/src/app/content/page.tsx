"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Topstrip } from "@/components/portal-topstrip";
import { StatusBadge, FormatPill, AspectThumb, Empty, IconButton } from "@/components/portal-shared";
import { Icon } from "@/components/portal-icons";
import { fmt } from "@/lib/portal-store";
import { useClientContent } from "@/lib/hooks/use-content";
import { useClientProjects } from "@/lib/hooks/use-projects";
import { ContentCalendar } from "@/components/content-calendar";

type Filter = "all" | "pending" | "approved" | "scheduled" | "live" | "rejected";

export default function ContentPage() {
  const router = useRouter();
  const { data: contentData, isLoading: contentLoading } = useClientContent();
  const { data: projectsData } = useClientProjects();

  const posts: any[] = (contentData as any)?.data ?? [];
  const projects: any[] = (projectsData as any)?.data ?? [];

  const [view, setView] = useState<"list" | "calendar">("list");
  const [filter, setFilter] = useState<Filter>("all");
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [calYear, setCalYear] = useState(() => new Date().getFullYear());
  const [calMonth, setCalMonth] = useState(() => new Date().getMonth() + 1);

  const filtered = useMemo(() => {
    let list = posts.slice();
    if (projectFilter) list = list.filter((p) => (p.project?.id ?? p.project) === projectFilter);
    if (filter === "pending") list = list.filter((p) => p.status === "PENDING_APPROVAL");
    else if (filter === "approved") list = list.filter((p) => p.status === "APPROVED" || p.status === "SCHEDULED");
    else if (filter === "scheduled") list = list.filter((p) => p.status === "SCHEDULED");
    else if (filter === "live") list = list.filter((p) => p.status === "PUBLISHED");
    else if (filter === "rejected") list = list.filter((p) => p.status === "REJECTED" || p.status === "REVISION");
    list.sort((a, b) => {
      if (!a.scheduledAt) return 1;
      if (!b.scheduledAt) return -1;
      return new Date(a.scheduledAt).valueOf() - new Date(b.scheduledAt).valueOf();
    });
    return list;
  }, [posts, projectFilter, filter]);

  const counts = {
    all: posts.length,
    pending: posts.filter((p) => p.status === "PENDING_APPROVAL").length,
    approved: posts.filter((p) => p.status === "APPROVED" || p.status === "SCHEDULED").length,
    live: posts.filter((p) => p.status === "PUBLISHED").length,
  };

  const chips: { id: Filter; label: string; count?: number; accent?: "attention" }[] = [
    { id: "all", label: "All", count: counts.all },
    { id: "pending", label: "Needs you", count: counts.pending, accent: counts.pending > 0 ? "attention" : undefined },
    { id: "approved", label: "Approved", count: counts.approved },
    { id: "live", label: "Live", count: counts.live },
    { id: "rejected", label: "Revision / Rejected" },
  ];

  return (
    <>
      <Topstrip
        title="Content"
        sub={`${posts.length} posts across all projects`}
        projectFilter={projectFilter}
        onProjectFilter={setProjectFilter}
        projects={projects}
        right={
          <div className="bg-muted rounded-md p-0.5 flex items-center gap-0.5">
            <button onClick={() => setView("list")} className={`h-7 px-2.5 text-[12.5px] font-medium rounded ${view === "list" ? "bg-surface text-ink shadow-sm" : "text-ink-3 hover:text-ink"}`}>List</button>
            <button onClick={() => setView("calendar")} className={`h-7 px-2.5 text-[12.5px] font-medium rounded ${view === "calendar" ? "bg-surface text-ink shadow-sm" : "text-ink-3 hover:text-ink"}`}>Calendar</button>
          </div>
        }
      />
      <div className="px-6 py-5 max-w-[1200px] mx-auto w-full">
        {view === "list" ? (
          <>
            <div className="flex items-center gap-2 flex-wrap">
              {chips.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setFilter(c.id)}
                  className={`h-8 px-3 inline-flex items-center gap-1.5 rounded-md text-[13px] font-medium transition-colors ${filter === c.id ? "bg-ink text-bg" : "bg-surface border border-border text-ink-2 hover:bg-muted/60"}`}
                >
                  {c.label}
                  {typeof c.count === "number" && <span className={`text-[11px] tabular-nums ${filter === c.id ? "text-bg/70" : "text-ink-4"}`}>{c.count}</span>}
                  {c.accent === "attention" && filter !== c.id && <span className="h-1.5 w-1.5 rounded-full bg-attention"/>}
                </button>
              ))}
            </div>
            <div className="bg-surface border border-border rounded-lg overflow-hidden mt-4">
              <div className="grid grid-cols-[40px_1fr_120px_140px_88px] items-center gap-3 px-4 h-10 border-b border-rule bg-muted/30 text-[11px] uppercase tracking-wider font-medium text-ink-3">
                <span></span>
                <span>Post</span>
                <span>Project</span>
                <span>Scheduled</span>
                <span className="text-right">Status</span>
              </div>
              {contentLoading && [0, 1, 2, 3].map((i) => (
                <div key={i} className="grid grid-cols-[40px_1fr_120px_140px_88px] items-center gap-3 px-4 h-row border-b border-rule last:border-b-0">
                  <div className="h-7 w-7 bg-muted rounded animate-pulse"/>
                  <div className="h-3.5 w-2/3 bg-muted rounded animate-pulse"/>
                  <div className="h-3 w-16 bg-muted rounded animate-pulse"/>
                  <div className="h-3 w-20 bg-muted rounded animate-pulse"/>
                  <div className="h-5 w-14 bg-muted rounded animate-pulse ml-auto"/>
                </div>
              ))}
              {!contentLoading && filtered.length === 0 ? (
                <Empty icon={<Icon.Edit size={20}/>} title="No posts match" hint="Try a different filter." />
              ) : !contentLoading && filtered.map((p, i) => (
                <ContentRow
                  key={p.id}
                  post={p}
                  divider={i < filtered.length - 1}
                  onOpen={() => router.push(`/content/${p.id}`)}
                />
              ))}
            </div>
          </>
        ) : (
          <ContentCalendar
            year={calYear}
            month={calMonth}
            projectFilter={projectFilter}
            onPostClick={(id) => router.push(`/content/${id}`)}
            onMonthChange={(y, m) => { setCalYear(y); setCalMonth(m); }}
          />
        )}
      </div>
    </>
  );
}

function ContentRow({ post: p, divider, onOpen }: { post: any; divider: boolean; onOpen: () => void }) {
  const overdue = p.scheduledAt && new Date(p.scheduledAt) < new Date() && p.status === "PENDING_APPROVAL";
  const projectName = p.project?.name ?? "—";
  return (
    <div
      onClick={onOpen}
      className={`grid grid-cols-[40px_1fr_120px_140px_88px] items-center gap-3 px-4 h-row hover:bg-muted/40 cursor-pointer transition-colors group ${divider ? "border-b border-rule" : ""}`}
    >
      <AspectThumb aspect={p.aspectRatio || "1:1"} format={p.format} />
      <div className="min-w-0 flex items-center gap-2">
        <span className="text-[13.5px] font-medium text-ink truncate">{p.title}</span>
        <FormatPill format={p.format} aspect={p.aspectRatio} />
      </div>
      <span className="text-[12.5px] text-ink-2 truncate text-rowtight">{projectName}</span>
      <span className={`text-[12.5px] tabular-nums text-rowtight ${overdue ? "text-attention font-medium" : "text-ink-2"}`}>{fmt.date(p.scheduledAt)}</span>
      <div className="text-right"><StatusBadge status={p.status} className="!h-5 !text-[10.5px]" /></div>
    </div>
  );
}
