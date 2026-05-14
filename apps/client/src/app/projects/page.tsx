"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Topstrip } from "@/components/portal-topstrip";
import { Button, StatusBadge, Avatar, Empty } from "@/components/portal-shared";
import { Icon } from "@/components/portal-icons";
import { sel, usePortalStore, type Project } from "@/lib/portal-store";

type Filter = "all" | "active" | "attention" | "paused" | "done";
type SortKey = "due" | "name" | "health";

export default function ProjectsPage() {
  const router = useRouter();
  const projects = usePortalStore(sel.projects);
  const posts = usePortalStore(sel.posts);
  const [filter, setFilter] = useState<Filter>("active");
  const [sortKey, setSortKey] = useState<SortKey>("due");

  const filtered = useMemo(() => {
    let list = projects.slice();
    if (filter === "active") list = list.filter((p) => p.status === "ACTIVE");
    else if (filter === "attention") list = list.filter((p) => p.attention || p.pending > 0);
    else if (filter === "paused") list = list.filter((p) => p.status === "PAUSED");
    else if (filter === "done") list = list.filter((p) => p.status === "COMPLETED" || p.status === "ARCHIVED");
    list.sort((a, b) => {
      if (sortKey === "name") return a.name.localeCompare(b.name);
      if (sortKey === "health") return (b.health ?? -1) - (a.health ?? -1);
      const ad = a.due ? new Date(a.due).valueOf() : Infinity;
      const bd = b.due ? new Date(b.due).valueOf() : Infinity;
      return ad - bd;
    });
    return list;
  }, [projects, filter, sortKey]);

  const counts: Record<Filter, number> = {
    all: projects.length,
    active: projects.filter((p) => p.status === "ACTIVE").length,
    attention: projects.filter((p) => p.attention || p.pending > 0).length,
    paused: projects.filter((p) => p.status === "PAUSED").length,
    done: projects.filter((p) => p.status === "COMPLETED" || p.status === "ARCHIVED").length,
  };

  const chips: { id: Filter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "active", label: "Active" },
    { id: "attention", label: "Attention" },
    { id: "paused", label: "Paused" },
    { id: "done", label: "Done" },
  ];

  return (
    <>
      <Topstrip
        title="Projects"
        sub={`${projects.length} projects`}
        right={<Button variant="primary" size="sm" icon={<Icon.Plus size={15} sw={2.4}/>}>New brief</Button>}
      />
      <div className="px-6 py-5 max-w-[1200px] mx-auto w-full">
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          {chips.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`h-8 px-3 inline-flex items-center gap-1.5 rounded-md text-[13px] font-medium transition-colors ${filter === f.id ? "bg-ink text-bg" : "bg-surface border border-border text-ink-2 hover:bg-muted/60"}`}
            >
              {f.label}
              <span className={`text-[11px] tabular-nums ${filter === f.id ? "text-bg/70" : "text-ink-4"}`}>{counts[f.id]}</span>
              {f.id === "attention" && counts.attention > 0 && filter !== f.id && <span className="h-1.5 w-1.5 rounded-full bg-attention"/>}
            </button>
          ))}
          <div className="flex-1"/>
          <div className="text-[12px] text-ink-3 inline-flex items-center gap-2">
            <span>Sort:</span>
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
              className="h-7 pl-2 pr-7 bg-surface border border-border rounded text-[12px] text-ink appearance-none cursor-pointer"
            >
              <option value="due">Due date</option>
              <option value="name">Name</option>
              <option value="health">Health</option>
            </select>
          </div>
        </div>

        <div className="bg-surface border border-border rounded-lg overflow-hidden">
          <div className="grid grid-cols-[1fr_110px_100px_64px_72px_120px_28px] items-center gap-3 px-4 h-10 border-b border-rule bg-muted/30 text-[11px] uppercase tracking-wider font-medium text-ink-3">
            <span>Project</span>
            <span>Status</span>
            <span>Owner</span>
            <span className="text-right">Posts</span>
            <span className="text-right">Approvals</span>
            <span className="text-right">Health</span>
            <span></span>
          </div>
          {filtered.length === 0 ? (
            <Empty icon={<Icon.Folder size={20}/>} title="No projects match" hint="Try a different filter." cta={<Button size="sm" variant="ghost" onClick={() => setFilter("all")}>Clear filter</Button>} />
          ) : filtered.map((p, i) => (
            <ProjectRow
              key={p.id}
              project={p}
              divider={i < filtered.length - 1}
              onOpen={() => router.push(`/projects/${p.id}`)}
              pending={posts.filter((post) => post.project === p.id && post.status === "PENDING").length}
            />
          ))}
        </div>
      </div>
    </>
  );
}

function ProjectRow({ project: p, divider, onOpen, pending }: { project: Project; divider: boolean; onOpen: () => void; pending: number }) {
  const healthColor =
    p.health == null ? "bg-neutral"
    : p.health < 60 ? "bg-attention"
    : p.health < 85 ? "bg-action-deep"
    : "bg-success";
  return (
    <div
      onClick={onOpen}
      className={`grid grid-cols-[1fr_110px_100px_64px_72px_120px_28px] items-center gap-3 px-4 h-row hover:bg-muted/40 cursor-pointer transition-colors group ${divider ? "border-b border-rule" : ""}`}
    >
      <div className="min-w-0 flex items-center gap-2">
        <div className="text-[13.5px] font-medium text-ink truncate">{p.name}</div>
        {p.attention === "overdue" && <span className="text-[10.5px] px-1.5 h-5 inline-flex items-center bg-attention-bg text-attention rounded font-medium">overdue</span>}
      </div>
      <div><StatusBadge status={p.status} className="!h-5 !text-[10.5px]" /></div>
      <div className="flex items-center gap-2 text-[12px] text-ink-2"><Avatar initial={p.owner} size="xs" /><span>{p.owner}</span></div>
      <div className="text-right text-[12.5px] text-ink-2 tabular-nums text-rowtight">{p.tasks.done}/{p.tasks.total}</div>
      <div className="text-right">
        {pending > 0
          ? <span className="text-attention font-medium text-[12.5px] inline-flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-attention"/>{pending}</span>
          : <span className="text-ink-4 text-[12.5px]">—</span>}
      </div>
      <div className="flex items-center gap-2">
        {p.health != null ? (
          <>
            <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
              <div className={`h-full ${healthColor}`} style={{ width: `${p.health}%` }} />
            </div>
            <span className="text-[11.5px] tabular-nums text-ink-2 w-6 text-right">{p.health}</span>
          </>
        ) : <span className="text-ink-4 text-[12px] w-full text-right">—</span>}
      </div>
      <div className="text-ink-4 group-hover:text-ink-2"><Icon.ChevRight size={14}/></div>
    </div>
  );
}
