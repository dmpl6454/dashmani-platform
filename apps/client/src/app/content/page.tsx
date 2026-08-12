"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Topstrip } from "@/components/portal-topstrip";
import { StatusBadge, FormatPill, AspectThumb, Empty, PageError, Button, Skeleton, FilterChip, SegTabs } from "@/components/portal-shared";
import { Icon } from "@/components/portal-icons";
import { fmt } from "@/lib/portal-store";
import { useClientContent } from "@/lib/hooks/use-content";
import { useClientProjects } from "@/lib/hooks/use-projects";
import { ContentCalendar } from "@/components/content-calendar";
import { NewBriefModal } from "@/components/new-brief-modal";

type Filter = "all" | "pending" | "approved" | "live" | "rejected";

const STATUS_MAP: Record<Filter, string[]> = {
  all:      [],
  pending:  ["PENDING_APPROVAL"],
  approved: ["APPROVED", "SCHEDULED"],
  live:     ["PUBLISHED"],
  rejected: ["REJECTED", "REVISION"],
};

export default function ContentPage() {
  const router = useRouter();
  const { data: contentData, isLoading, error: contentError } = useClientContent();
  const { data: projectsData } = useClientProjects();

  const posts: any[] = contentData?.items ?? [];
  const projects: any[] = projectsData?.items ?? [];

  const [view, setView] = useState<"list" | "calendar">("list");
  const [filter, setFilter] = useState<Filter>("all");
  const [projectFilter, setProjectFilter] = useState<string | null>(null);
  const [calYear, setCalYear] = useState(() => new Date().getFullYear());
  const [calMonth, setCalMonth] = useState(() => new Date().getMonth() + 1);
  const [briefOpen, setBriefOpen] = useState(false);

  const filtered = useMemo(() => {
    let list = posts.slice();
    if (projectFilter) list = list.filter((p) => (p.project?.id ?? p.project) === projectFilter);
    if (filter !== "all") {
      const allowed = STATUS_MAP[filter];
      list = list.filter((p) => allowed.includes(p.status));
    }
    list.sort((a, b) => {
      if (!a.scheduledAt) return 1;
      if (!b.scheduledAt) return -1;
      return new Date(a.scheduledAt).valueOf() - new Date(b.scheduledAt).valueOf();
    });
    return list;
  }, [posts, projectFilter, filter]);

  const counts = {
    all:      posts.length,
    pending:  posts.filter((p) => p.status === "PENDING_APPROVAL").length,
    approved: posts.filter((p) => ["APPROVED", "SCHEDULED"].includes(p.status)).length,
    live:     posts.filter((p) => p.status === "PUBLISHED").length,
    rejected: posts.filter((p) => ["REJECTED", "REVISION"].includes(p.status)).length,
  };

  const CHIPS: { id: Filter; label: string; count?: number; dot?: boolean }[] = [
    { id: "all",      label: "All",               count: counts.all },
    { id: "pending",  label: "Needs you",          count: counts.pending, dot: counts.pending > 0 },
    { id: "approved", label: "Approved",           count: counts.approved },
    { id: "live",     label: "Live",               count: counts.live },
    { id: "rejected", label: "Revision / Rejected", count: counts.rejected },
  ];

  return (
    <>
      <Topstrip
        title="Content"
        sub={`${posts.length} posts`}
        projectFilter={projectFilter}
        onProjectFilter={setProjectFilter}
        projects={projects}
        right={
          <SegTabs
            value={view}
            onChange={setView}
            options={[{ value: "list", label: "List" }, { value: "calendar", label: "Calendar" }]}
          />
        }
      />
      <NewBriefModal open={briefOpen} onClose={() => setBriefOpen(false)} defaultProjectId={projectFilter ?? undefined} />

      <div className="px-4 sm:px-6 py-6 max-w-[1200px] mx-auto w-full flex-1 overflow-y-auto">
        {/* Filter chips */}
        <div className="flex items-center gap-2 flex-wrap mb-5 slide-right">
          {CHIPS.map((c) => (
            <FilterChip
              key={c.id}
              active={filter === c.id}
              count={c.count}
              dot={c.dot}
              onClick={() => setFilter(c.id)}
            >
              {c.label}
            </FilterChip>
          ))}
          <div className="flex-1" />
          <Button variant="ink" size="sm" icon={<Icon.Plus size={14} sw={2.5} />} onClick={() => setBriefOpen(true)}>
            New brief
          </Button>
        </div>

        {view === "list" ? (
          <div className="v3-card overflow-hidden fade-up d2">
            <div
              className="tbl-head row-content items-center gap-3 px-5 h-11 bg-muted/40 text-[11px] uppercase tracking-wider font-bold text-ink-3"
              style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}
            >
              <span></span><span>Post</span><span>Project</span><span>Scheduled</span><span className="text-right">Status</span>
            </div>

            {contentError && !isLoading && (
              <div className="px-5 py-6"><PageError message="Could not load content. Please refresh." /></div>
            )}

            {isLoading && [...Array(4)].map((_, i) => (
              <div key={i} className="row-content items-center gap-3 px-5 h-row" style={{ borderBottom: "1px solid rgba(26,26,26,0.06)" }}>
                <Skeleton className="h-7 w-7" />
                <Skeleton className="h-3.5 w-2/3" />
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-5 w-14 ml-auto" />
              </div>
            ))}

            {!isLoading && filtered.length === 0 ? (
              <Empty icon={<Icon.Edit size={20} />} title="No posts match" hint="Try a different filter." />
            ) : !isLoading && filtered.map((p, i) => (
              <ContentRow
                key={p.id}
                post={p}
                divider={i < filtered.length - 1}
                onOpen={() => router.push(`/content/${p.id}`)}
                delay={`d${Math.min(i + 3, 8)}`}
              />
            ))}
          </div>
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

function ContentRow({ post: p, divider, onOpen, delay }: { post: any; divider: boolean; onOpen: () => void; delay: string }) {
  const overdue = p.scheduledAt && new Date(p.scheduledAt) < new Date() && p.status === "PENDING_APPROVAL";
  const projectName = p.project?.name ?? "—";
  return (
    <div
      onClick={onOpen}
      className={`group row-content items-center gap-3 px-5 h-row v3-row cursor-pointer fade-up ${delay}`}
      style={divider ? { borderBottom: "1px solid rgba(26,26,26,0.06)" } : undefined}
    >
      <AspectThumb aspect={p.aspectRatio || "1:1"} format={p.format} />
      <div className="min-w-0 flex items-center gap-2">
        <span className="text-[13.5px] font-semibold text-ink truncate">{p.title}</span>
        <FormatPill format={p.format} aspect={p.aspectRatio} />
      </div>
      <span className="text-[12.5px] text-ink-2 truncate font-medium">{projectName}</span>
      <span className={`text-[12.5px] tabular-nums font-medium ${overdue ? "text-attention font-semibold" : "text-ink-2"}`}>
        {fmt.date(p.scheduledAt)}
      </span>
      <div className="text-right"><StatusBadge status={p.status} /></div>
    </div>
  );
}
