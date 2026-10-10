"use client";
import { useEffect, useState, type ReactNode } from "react";
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

// The site's header: a 2px divider, an "ON AIR" pulse and an IST clock on the
// right, uppercase tracked meta. The page title keeps the site's 800 weight.
export function Topstrip({ title, sub, projectFilter, onProjectFilter, right, projects: projectsProp }: TopstripProps) {
  const projects = projectsProp ?? [];
  const palette = useCommandPalette();
  const { hasKeyboard, searchShortcut } = useInputDevice();
  const [clock, setClock] = useState("");

  useEffect(() => {
    const tick = () => setClock(new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata" }));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <header className="sticky top-0 z-30 bg-bg/95 backdrop-blur-sm border-b-2 border-border">
      <div className="min-h-[56px] sm:min-h-[64px] px-4 sm:px-6 py-2 flex items-center gap-2 sm:gap-3">
        {/* Title */}
        <div className="min-w-0 shrink leading-tight">
          <h1 className="text-[18px] sm:text-[20px] font-extrabold tracking-[-0.03em] text-ink truncate">{title}</h1>
          {sub && <div className="kicker hidden md:block truncate mt-0.5">{sub}</div>}
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
                className="h-8 sm:h-9 pl-2.5 sm:pl-3 pr-6 sm:pr-8 text-[12px] sm:text-[13px] bg-surface font-semibold text-ink cursor-pointer appearance-none max-w-[92px] sm:max-w-none truncate border-2 border-[rgba(255,255,255,0.25)] hover:border-[rgba(255,255,255,0.45)] focus:border-indigo outline-none"
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
            className="h-8 sm:h-9 px-2.5 sm:px-3 sm:pr-3.5 inline-flex items-center gap-2 bg-transparent text-ink-2 font-semibold text-[13px] hover:text-ink hover:border-indigo-light transition-colors shrink-0 border-2 border-[rgba(255,255,255,0.3)]"
          >
            <Icon.Search size={14} />
            {/* Label drops on phones so the page's own controls still fit the row */}
            <span className="hidden sm:inline">Search</span>
            {hasKeyboard && <kbd className="ml-0.5 hidden sm:inline-block">{searchShortcut}</kbd>}
          </button>

          {right && <div className="flex items-center gap-2 shrink-0">{right}</div>}

          {/* ON AIR + clock, as on the site's header. Hidden on phones. */}
          <span className="on-air hidden xl:inline-flex pl-3 ml-1 border-l-2 border-border"><i aria-hidden /> On air</span>
          <span className="hidden xl:inline text-[12px] tracking-[0.12em] text-ink-3 tabular-nums" suppressHydrationWarning>{clock}</span>
        </div>
      </div>
    </header>
  );
}
