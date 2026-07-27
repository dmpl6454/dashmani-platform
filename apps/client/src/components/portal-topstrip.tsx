"use client";
import type { ReactNode } from "react";
import { Icon } from "./portal-icons";
import { useCommandPalette } from "./command-palette";
import { useInputDevice } from "@/lib/hooks/use-input-device";

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
  const { hasKeyboard, searchShortcut } = useInputDevice();
  return (
    <header className="sticky top-0 z-30 bg-bg/96 backdrop-blur-sm" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
      <div className="h-14 sm:h-16 px-4 sm:px-6 flex items-center gap-2 sm:gap-3">
        {/* Title */}
        <div className="flex items-baseline gap-2.5 min-w-0 shrink">
          <h1 className="text-[15px] sm:text-[16px] font-bold text-ink truncate">{title}</h1>
          {sub && <span className="text-[12px] text-ink-3 font-medium hidden md:inline truncate">{sub}</span>}
        </div>
        <div className="flex-1 min-w-[8px]" />

        {/* Controls sit beside the title; they shrink on a phone so the title keeps its room */}
        <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
          {/* Project filter */}
          {onProjectFilter && (
            <div className="relative shrink-0">
              <select
                value={projectFilter || ""}
                onChange={(e) => onProjectFilter(e.target.value || null)}
                className="h-8 sm:h-9 pl-2.5 sm:pl-3 pr-6 sm:pr-8 text-[12px] sm:text-[13px] rounded-lg sm:rounded-xl bg-surface font-semibold text-ink cursor-pointer appearance-none max-w-[92px] sm:max-w-none truncate"
                style={{ border: "2px solid rgba(26,26,26,0.18)" }}
              >
                <option value="">All projects</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.short ?? p.name}</option>
                ))}
              </select>
              <Icon.ChevDown size={13} className="absolute right-1.5 sm:right-2.5 top-1/2 -translate-y-1/2 pointer-events-none text-ink-3" />
            </div>
          )}

          {/* Search */}
          <button
            onClick={() => palette.open()}
            aria-label="Search"
            className="h-8 sm:h-9 px-2.5 sm:px-3 sm:pr-3.5 inline-flex items-center gap-2 rounded-lg sm:rounded-xl bg-surface text-ink-3 font-medium text-[13px] hover:text-ink transition-colors btn-3d shrink-0"
            style={{ border: "2px solid rgba(26,26,26,0.2)" }}
          >
            <Icon.Search size={14} />
            {/* Label drops on phones so the page's own controls still fit the row */}
            <span className="hidden sm:inline">Search</span>
            {hasKeyboard && <kbd className="ml-0.5 hidden sm:inline-block">{searchShortcut}</kbd>}
          </button>

          {right && <div className="flex items-center gap-2 shrink-0">{right}</div>}
        </div>
      </div>
    </header>
  );
}
