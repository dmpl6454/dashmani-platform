"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Topstrip } from "@/components/portal-topstrip";
import { StatusBadge, FormatPill, AspectThumb, Empty, IconButton } from "@/components/portal-shared";
import { Icon } from "@/components/portal-icons";
import { fmt } from "@/lib/portal-store";
import { useClientContent } from "@/lib/hooks/use-content";
import { useClientProjects } from "@/lib/hooks/use-projects";

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
          <CalendarView posts={filtered} onOpen={(id) => router.push(`/content/${id}`)} />
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

function CalendarView({ posts, onOpen }: { posts: any[]; onOpen: (id: string) => void }) {
  const monday = useMemo(() => {
    const today = new Date();
    const day = today.getDay() || 7;
    const m = new Date(today);
    m.setDate(today.getDate() - (day - 1));
    m.setHours(0, 0, 0, 0);
    return m;
  }, []);

  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });

  const slots = days.map((d) => ({
    date: d,
    items: posts.filter((p) => p.scheduledAt && new Date(p.scheduledAt).toDateString() === d.toDateString()),
  }));

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="text-[13px] text-ink-2">
          Week of {fmt.shortDate(monday.toISOString())} — {fmt.shortDate(days[6].toISOString())}
        </div>
        <div className="flex items-center gap-1">
          <IconButton size="sm" variant="default" icon={<Icon.ChevLeft size={16}/>} label="Previous week" />
          <IconButton size="sm" variant="default" icon={<Icon.ChevRight size={16}/>} label="Next week" />
        </div>
      </div>
      <div className="grid grid-cols-7 gap-2">
        {slots.map((s, i) => {
          const isToday = s.date.toDateString() === new Date().toDateString();
          return (
            <div key={i} className="bg-surface border border-border rounded-lg overflow-hidden min-h-[280px] flex flex-col">
              <div className={`px-3 py-2 border-b border-rule flex items-center justify-between ${isToday ? "bg-action-soft" : "bg-muted/30"}`}>
                <div>
                  <div className="text-[10.5px] uppercase tracking-wider text-ink-3 font-medium">{s.date.toLocaleDateString("en", { weekday: "short" })}</div>
                  <div className="text-[15px] font-semibold text-ink leading-none mt-0.5">{s.date.getDate()}</div>
                </div>
                <div className="text-[10.5px] text-ink-3">{s.items.length}</div>
              </div>
              <div className="p-2 space-y-1.5 flex-1">
                {s.items.length === 0 ? (
                  <button className="w-full h-full min-h-[100px] rounded-md border border-dashed border-border text-[11px] text-ink-4 hover:border-ink-3 hover:text-ink-3 hover:bg-muted/30 transition-colors">
                    + schedule
                  </button>
                ) : s.items.map((p) => (
                  <CalendarCard key={p.id} post={p} onOpen={() => onOpen(p.id)} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CalendarCard({ post: p, onOpen }: { post: any; onOpen: () => void }) {
  const kind = ({ ACTIVE: "success", PAUSED: "neutral", COMPLETED: "neutral", ARCHIVED: "neutral", DRAFT: "neutral", PENDING_APPROVAL: "attention", PENDING: "attention", APPROVED: "success", SCHEDULED: "neutral", PUBLISHED: "success", REJECTED: "danger", REVISION: "attention", FAILED: "danger" } as const)[p.status as string] ?? "neutral";
  const edgeColor = ({
    attention: "border-l-attention",
    success: "border-l-success",
    danger: "border-l-danger",
    neutral: "border-l-neutral",
  } as const)[kind];
  return (
    <button
      onClick={onOpen}
      className={`w-full text-left rounded-md border-l-2 ${edgeColor} bg-bg/70 border border-border p-2 hover:bg-muted/60 transition-colors`}
    >
      <div className="text-[10.5px] tabular-nums text-ink-3">{fmt.time(p.scheduledAt)}</div>
      <div className="text-[12px] font-medium text-ink leading-tight line-clamp-2 mt-0.5">{p.title.split(" — ")[0]}</div>
      <div className="mt-1.5 flex items-center justify-between gap-1">
        <FormatPill format={p.format} aspect={p.aspectRatio} className="!h-4 !text-[9.5px]" />
        {p.status === "PENDING_APPROVAL" && <span className="text-[9.5px] text-attention font-medium">needs you</span>}
      </div>
    </button>
  );
}
