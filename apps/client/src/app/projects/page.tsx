"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Topstrip } from "@/components/portal-topstrip";
import { Button, StatusBadge, Avatar, Empty, PageError, Skeleton } from "@/components/portal-shared";
import { Icon } from "@/components/portal-icons";
import { useClientProjects } from "@/lib/hooks/use-projects";
import { useClientAnalytics } from "@/lib/hooks/use-analytics";
import { NewBriefModal } from "@/components/new-brief-modal";
import type { StatusKey } from "@/lib/portal-store";

type Filter = "all" | "active" | "attention" | "paused" | "done";
type SortKey = "due" | "name" | "health";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all",       label: "All"       },
  { id: "active",    label: "Active"    },
  { id: "attention", label: "Attention" },
  { id: "paused",    label: "Paused"    },
  { id: "done",      label: "Done"      },
];

export default function ProjectsPage() {
  const router = useRouter();
  const { data: projectsRaw, isLoading, error: projectsError } = useClientProjects();
  const { data: analyticsData } = useClientAnalytics();

  const projects: any[] = projectsRaw?.items ?? [];

  const pendingByProject: Record<string, number> = {};
  for (const ps of analyticsData?.projectSummaries ?? []) {
    pendingByProject[ps.projectId] = ps.pendingCount;
  }

  const [filter, setFilter] = useState<Filter>("active");
  const [sortKey, setSortKey] = useState<SortKey>("due");
  const [briefOpen, setBriefOpen] = useState(false);

  const isOverdue = (p: any) =>
    p.dueDate && new Date(p.dueDate) < new Date() && p.status === "ACTIVE";

  const filtered = useMemo(() => {
    let list = projects.slice();
    if (filter === "active")    list = list.filter((p) => p.status === "ACTIVE");
    else if (filter === "attention") list = list.filter((p) => isOverdue(p) || (pendingByProject[p.id] ?? 0) > 0);
    else if (filter === "paused")    list = list.filter((p) => p.status === "PAUSED");
    else if (filter === "done")      list = list.filter((p) => p.status === "COMPLETED" || p.status === "ARCHIVED");
    list.sort((a, b) => {
      if (sortKey === "name")   return a.name.localeCompare(b.name);
      if (sortKey === "health") return ((b.healthScore ?? -1) - (a.healthScore ?? -1));
      const ad = a.dueDate ? new Date(a.dueDate).valueOf() : Infinity;
      const bd = b.dueDate ? new Date(b.dueDate).valueOf() : Infinity;
      return ad - bd;
    });
    return list;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, filter, sortKey, pendingByProject]);

  const counts: Record<Filter, number> = {
    all:       projects.length,
    active:    projects.filter((p) => p.status === "ACTIVE").length,
    attention: projects.filter((p) => isOverdue(p) || (pendingByProject[p.id] ?? 0) > 0).length,
    paused:    projects.filter((p) => p.status === "PAUSED").length,
    done:      projects.filter((p) => p.status === "COMPLETED" || p.status === "ARCHIVED").length,
  };

  return (
    <>
      <Topstrip
        title="Projects"
        sub={`${projects.length} total`}
        right={
          <Button variant="ink" size="sm" icon={<Icon.Plus size={14} sw={2.5} />} onClick={() => setBriefOpen(true)}>
            New brief
          </Button>
        }
      />
      <NewBriefModal open={briefOpen} onClose={() => setBriefOpen(false)} />

      <div className="px-6 py-6 max-w-[1200px] mx-auto w-full flex-1 overflow-y-auto">
        {/* Filter + sort row */}
        <div className="flex items-center gap-2 mb-5 flex-wrap slide-right">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`h-9 px-4 inline-flex items-center gap-1.5 rounded-xl text-[13px] font-semibold border-2 transition-all
                ${filter === f.id
                  ? "bg-ink text-white border-ink btn-3d"
                  : "bg-surface text-ink-2 border-ink/20 hover:border-ink/50 hover:text-ink"}`}
            >
              {f.label}
              <span className={`text-[11px] tabular-nums ${filter === f.id ? "text-white/60" : "text-ink-4"}`}>
                {counts[f.id]}
              </span>
              {f.id === "attention" && counts.attention > 0 && filter !== f.id && (
                <span className="h-1.5 w-1.5 rounded-full bg-attention" />
              )}
            </button>
          ))}
          <div className="flex-1" />
          <div className="inline-flex items-center gap-2 text-[12.5px] text-ink-3 font-medium">
            <span>Sort:</span>
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
              className="h-9 pl-3 pr-7 bg-surface rounded-xl text-[12.5px] text-ink font-semibold appearance-none cursor-pointer"
              style={{ border: "2px solid rgba(26,26,26,0.2)" }}
            >
              <option value="due">Due date</option>
              <option value="name">Name</option>
              <option value="health">Health</option>
            </select>
          </div>
        </div>

        {/* Table */}
        <div className="v3-card overflow-hidden fade-up d2">
          <div
            className="grid items-center gap-3 px-5 h-11 bg-muted/40 text-[11px] uppercase tracking-wider font-bold text-ink-3"
            style={{ gridTemplateColumns: "1fr 110px 80px 60px 70px 100px 20px", borderBottom: "2px solid rgba(26,26,26,0.07)" }}
          >
            <span>Project</span>
            <span>Status</span>
            <span>Owner</span>
            <span className="text-right">Posts</span>
            <span className="text-right">Pending</span>
            <span className="text-right">Health</span>
            <span></span>
          </div>

          {projectsError && !isLoading && (
            <div className="px-5 py-6"><PageError message="Could not load projects. Please refresh." /></div>
          )}

          {isLoading && [...Array(4)].map((_, i) => (
            <div key={i} className="grid items-center gap-3 px-5 h-row" style={{ gridTemplateColumns: "1fr 110px 80px 60px 70px 100px 20px", borderBottom: "1px solid rgba(26,26,26,0.06)" }}>
              <Skeleton className="h-3.5 w-2/3" />
              <Skeleton className="h-5 w-16" />
              <Skeleton className="h-5 w-14" />
              <Skeleton className="h-3 w-8 ml-auto" />
              <Skeleton className="h-3 w-8 ml-auto" />
              <Skeleton className="h-2 w-full" />
            </div>
          ))}

          {!isLoading && filtered.length === 0 ? (
            <Empty
              icon={<Icon.Folder size={20} />}
              title={projects.length === 0 ? "No projects yet" : "No projects match"}
              hint={projects.length === 0 ? "Contact your account manager to set up projects." : "Try a different filter."}
              cta={projects.length > 0 ? <Button size="sm" variant="ghost" onClick={() => setFilter("all")}>Clear filter</Button> : undefined}
            />
          ) : !isLoading && filtered.map((p, i) => (
            <ProjectRow
              key={p.id}
              project={p}
              divider={i < filtered.length - 1}
              pending={pendingByProject[p.id] ?? 0}
              delay={`d${Math.min(i + 3, 8)}`}
              onOpen={() => router.push(`/projects/${p.id}`)}
            />
          ))}
        </div>
      </div>
    </>
  );
}

function ProjectRow({ project: p, divider, pending, delay, onOpen }: {
  project: any; divider: boolean; pending: number; delay: string; onOpen: () => void;
}) {
  const health = p.healthScore ?? null;
  const overdue = p.dueDate && new Date(p.dueDate) < new Date() && p.status === "ACTIVE";
  const owner: string = p.owner ?? p.ownerName ?? "—";
  const hColor = health == null ? "bg-ink-4" : health < 60 ? "bg-attention" : health < 85 ? "bg-action-deep" : "bg-success";

  return (
    <div
      onClick={onOpen}
      className={`group grid items-center gap-3 px-5 h-row v3-row cursor-pointer transition-colors fade-up ${delay}`}
      style={{
        gridTemplateColumns: "1fr 110px 80px 60px 70px 100px 20px",
        ...(divider ? { borderBottom: "1px solid rgba(26,26,26,0.06)" } : {}),
      }}
    >
      <div className="min-w-0 flex items-center gap-2">
        <span className="text-[13.5px] font-semibold text-ink truncate">{p.name}</span>
        {overdue && (
          <span className="text-[10px] px-2 h-5 inline-flex items-center bg-attention-bg text-attention rounded-full font-bold border border-attention/20 shrink-0">
            overdue
          </span>
        )}
      </div>
      <div><StatusBadge status={p.status as StatusKey} className="!h-5 !text-[10px]" /></div>
      <div className="flex items-center gap-1.5 text-[12.5px] text-ink-2 font-semibold">
        <Avatar initial={owner !== "—" ? owner[0].toUpperCase() : "?"} size="xs" />
        <span className="truncate">{owner}</span>
      </div>
      <div className="text-right text-[13px] text-ink-2 tabular-nums font-semibold">—</div>
      <div className="text-right">
        {pending > 0
          ? <span className="text-attention font-bold text-[13px]">{pending}</span>
          : <span className="text-ink-4 text-[13px]">—</span>}
      </div>
      <div className="flex items-center gap-2 justify-end">
        {health != null ? (
          <>
            <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden" style={{ border: "1px solid rgba(26,26,26,0.08)" }}>
              <div className={`h-full ${hColor} rounded-full transition-all duration-500`} style={{ width: `${health}%` }} />
            </div>
            <span className="text-[11.5px] tabular-nums text-ink-2 w-6 text-right font-bold">{health}</span>
          </>
        ) : (
          <span className="text-ink-4 text-[13px] w-full text-right">—</span>
        )}
      </div>
      <div className="text-ink-4 group-hover:text-indigo transition-colors">
        <Icon.ChevRight size={14} />
      </div>
    </div>
  );
}
