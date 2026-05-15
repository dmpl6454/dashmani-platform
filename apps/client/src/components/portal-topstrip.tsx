"use client";
import type { ReactNode } from "react";
import { Icon } from "./portal-icons";
import { useCommandPalette } from "./command-palette";

interface TopstripProps {
  title: ReactNode;
  sub?: ReactNode;
  projectFilter?: string | null;
  onProjectFilter?: (id: string | null) => void;
  right?: ReactNode;
  projects?: { id: string; short?: string; name?: string }[];
}

export function Topstrip({ title, sub, projectFilter, onProjectFilter, right, projects: projectsProp }: TopstripProps) {
  const projects = projectsProp ?? [];
  const palette = useCommandPalette();
  return (
    <header className="sticky top-0 z-30 bg-bg/95 backdrop-blur-[2px] border-b border-rule">
      <div className="h-14 px-6 flex items-center gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <h1 className="text-[15px] font-semibold text-ink truncate">{title}</h1>
          {sub && <span className="text-xs text-ink-3 hidden md:inline truncate">{sub}</span>}
        </div>
        <div className="flex-1" />

        {onProjectFilter && (
          <div className="relative">
            <select
              value={projectFilter || ""}
              onChange={(e) => onProjectFilter(e.target.value || null)}
              className="h-9 pl-3 pr-8 text-[13px] rounded-md bg-surface border border-border text-ink hover:bg-muted/40 appearance-none cursor-pointer"
            >
              <option value="">All projects</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.short ?? p.name}</option>)}
            </select>
            <Icon.ChevDown size={14} className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-ink-3" />
          </div>
        )}

        <button
          onClick={() => palette.open()}
          className="h-9 pl-2.5 pr-3 inline-flex items-center gap-2 rounded-md bg-surface border border-border text-ink-3 hover:bg-muted/40"
        >
          <Icon.Search size={15}/>
          <span className="text-[13px]">Search</span>
          <kbd className="ml-1">⌘K</kbd>
        </button>

        {right}
      </div>
    </header>
  );
}
