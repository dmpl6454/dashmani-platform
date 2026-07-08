"use client";
import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useProjects } from "@/lib/hooks/use-projects";
import { Plus, Search, FolderOpen } from "lucide-react";

const STATUS_CONFIG: Record<string, { badge: string; label: string }> = {
  ACTIVE:    { badge: "bg-success-bg text-success border-success/20",     label: "Active" },
  PAUSED:    { badge: "bg-attention-bg text-attention border-attention/20",label: "Paused" },
  COMPLETED: { badge: "bg-indigo-soft text-indigo border-indigo/20",       label: "Completed" },
  ARCHIVED:  { badge: "bg-neutral-bg text-neutral border-neutral/20",      label: "Archived" },
};
const STATUS_OPTIONS = ["", "ACTIVE", "PAUSED", "COMPLETED", "ARCHIVED"];

export default function ProjectsPage() {
  const searchParams = useSearchParams();
  const initialStatus = searchParams.get("status") || "ACTIVE";
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<string>(initialStatus);
  const { data, isLoading } = useProjects({ search, status: status || undefined });
  const projects = (data as any)?.data || [];

  return (
    <div className="space-y-5 pop-in">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-semibold text-ink">Projects</h1>
          {!isLoading && (
            <p className="text-sm text-ink-4 mt-0.5">{projects.length} project{projects.length !== 1 ? "s" : ""}</p>
          )}
        </div>
        <Link href="/projects/new">
          <button className="h-9 px-4 rounded-full bg-ink text-white text-sm font-bold btn-3d hover:bg-ink-2 transition-colors flex items-center gap-1.5">
            <Plus className="h-4 w-4" /> New Project
          </button>
        </Link>
      </div>

      {/* Search + status filter */}
      <div className="flex gap-3 items-center flex-wrap fade-up d2">
        <div className="relative max-w-md flex-1 min-w-[200px]">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-4" />
          <input
            placeholder="Search projects…"
            className="w-full pl-10 pr-4 h-10 bg-surface border-2 border-ink/15 rounded-xl text-sm text-ink placeholder:text-ink-4 focus:outline-none focus:border-indigo transition-colors"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <select
          className="h-10 rounded-xl border-2 border-ink/15 bg-surface px-3 py-2 text-sm text-ink focus:outline-none focus:border-indigo transition-colors"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">All Statuses</option>
          {STATUS_OPTIONS.filter(Boolean).map((s) => (
            <option key={s} value={s}>{STATUS_CONFIG[s]?.label || s}</option>
          ))}
        </select>
      </div>

      {/* Project table */}
      <div className="v3-card overflow-hidden fade-up d3">
        {isLoading ? (
          <div className="py-14 flex items-center justify-center">
            <div className="h-6 w-6 rounded-full border-[3px] border-ink/10 border-t-indigo" style={{ animation: "spin 0.7s linear infinite" }} />
          </div>
        ) : projects.length === 0 ? (
          <div className="py-14 text-center text-ink-4">
            <FolderOpen className="h-8 w-8 mx-auto mb-2 opacity-30" />
            <p className="text-sm">No projects found</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b-2 border-ink/8 bg-muted/40">
                  <th className="text-left px-5 py-3 text-[10px] font-bold text-ink-4 uppercase tracking-wider">Project</th>
                  <th className="text-left px-5 py-3 text-[10px] font-bold text-ink-4 uppercase tracking-wider hidden md:table-cell">Client</th>
                  <th className="text-left px-5 py-3 text-[10px] font-bold text-ink-4 uppercase tracking-wider hidden lg:table-cell">Tasks</th>
                  <th className="text-left px-5 py-3 text-[10px] font-bold text-ink-4 uppercase tracking-wider">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {projects.map((p: any, i: number) => {
                  const cfg = STATUS_CONFIG[p.status] || STATUS_CONFIG.ARCHIVED;
                  return (
                    <tr key={p.id} className="v3-row" style={{ animationDelay: `${i * 0.03}s` }}>
                      <td className="px-5 py-3">
                        <Link href={`/projects/${p.id}`} className="flex items-center gap-3">
                          <div className="h-8 w-8 rounded-xl border-2 border-ink/12 bg-action-soft flex items-center justify-center shrink-0">
                            <FolderOpen className="h-4 w-4 text-ink-2" />
                          </div>
                          <span className="font-semibold text-ink hover:text-indigo transition-colors">{p.name}</span>
                        </Link>
                      </td>
                      <td className="px-5 py-3 text-ink-3 hidden md:table-cell">{p.client?.companyName || "—"}</td>
                      <td className="px-5 py-3 text-ink-3 hidden lg:table-cell">{p._count?.tasks || 0} tasks</td>
                      <td className="px-5 py-3">
                        <span className={`rounded-full px-3 py-1 text-xs font-semibold border ${cfg.badge}`}>
                          {cfg.label}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
