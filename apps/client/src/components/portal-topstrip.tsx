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
    <header className="sticky top-0 z-30 bg-bg/96 backdrop-blur-sm" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
      <div className="h-16 px-6 flex items-center gap-3">
        {/* Title */}
        <div className="flex items-center gap-2.5 min-w-0">
          <h1 className="text-[16px] font-bold text-ink truncate">{title}</h1>
          {sub && <span className="text-[12px] text-ink-3 font-medium hidden md:inline truncate">{sub}</span>}
        </div>
        <div className="flex-1" />

        {/* Project filter */}
        {onProjectFilter && (
          <div className="relative">
            <select
              value={projectFilter || ""}
              onChange={(e) => onProjectFilter(e.target.value || null)}
              className="h-9 pl-3 pr-8 text-[13px] rounded-xl bg-surface font-semibold text-ink cursor-pointer appearance-none"
              style={{ border: "2px solid rgba(26,26,26,0.18)" }}
            >
              <option value="">All projects</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.short ?? p.name}</option>
              ))}
            </select>
            <Icon.ChevDown size={13} className="absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none text-ink-3" />
          </div>
        )}

        {/* Search */}
        <button
          onClick={() => palette.open()}
          className="h-9 pl-3 pr-3.5 inline-flex items-center gap-2 rounded-xl bg-surface text-ink-3 font-medium text-[13px] hover:text-ink transition-colors btn-3d"
          style={{ border: "2px solid rgba(26,26,26,0.2)" }}
        >
          <Icon.Search size={14} />
          <span>Search</span>
          <kbd className="ml-0.5">⌘K</kbd>
        </button>

        {right && <div className="flex items-center gap-2">{right}</div>}
      </div>
    </header>
  );
}
