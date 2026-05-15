"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "./portal-icons";
import { useClientProjects } from "@/lib/hooks/use-projects";

interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  href: string;
  group: "Pages" | "Projects";
}

const PAGES: PaletteItem[] = [
  { id: "page-dashboard", label: "Dashboard", hint: "Home",     href: "/dashboard", group: "Pages" },
  { id: "page-projects",  label: "Projects",  hint: "Browse projects", href: "/projects",  group: "Pages" },
  { id: "page-content",   label: "Content",   hint: "All posts", href: "/content",   group: "Pages" },
  { id: "page-approvals", label: "Approvals", hint: "Pending review", href: "/approvals", group: "Pages" },
  { id: "page-analytics", label: "Analytics", hint: "Metrics", href: "/analytics", group: "Pages" },
  { id: "page-files",     label: "Files",     hint: "Project files", href: "/files",     group: "Pages" },
];

// Module-level event emitter so any component can open the palette without prop drilling.
type Listener = (open: boolean) => void;
const listeners = new Set<Listener>();
let openState = false;

function setOpen(next: boolean) {
  openState = next;
  listeners.forEach((l) => l(openState));
}

export function useCommandPalette() {
  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!openState),
  };
}

export function CommandPalette() {
  const router = useRouter();
  const [open, setLocalOpen] = useState(openState);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: projectsData } = useClientProjects();
  const projects = projectsData?.items ?? [];

  // Subscribe to module-level open/close events.
  useEffect(() => {
    const l: Listener = (next) => setLocalOpen(next);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);

  // Global Cmd/Ctrl+K handler.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setOpen(!openState);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const items: PaletteItem[] = useMemo(() => {
    const projectItems: PaletteItem[] = projects.map((p: any) => ({
      id: `project-${p.id}`,
      label: p.name,
      hint: p.status,
      href: `/projects/${p.id}`,
      group: "Projects" as const,
    }));
    const all = [...PAGES, ...projectItems];
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter((i) =>
      i.label.toLowerCase().includes(q) || i.hint?.toLowerCase().includes(q)
    );
  }, [projects, query]);

  function navigate(item: PaletteItem) {
    setOpen(false);
    router.push(item.href);
  }

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(items.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = items[activeIndex];
      if (item) navigate(item);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  }

  if (!open) return null;

  // Group items by their group key in order of appearance.
  const groups: { name: string; items: PaletteItem[] }[] = [];
  for (const it of items) {
    let g = groups.find((x) => x.name === it.group);
    if (!g) { g = { name: it.group, items: [] }; groups.push(g); }
    g.items.push(it);
  }

  let flatIndex = -1;
  return (
    <div
      className="fixed inset-0 z-50 bg-ink/40 backdrop-blur-sm flex items-start justify-center pt-[12vh] px-4"
      onClick={() => setOpen(false)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[560px] bg-surface border border-border rounded-lg shadow-xl overflow-hidden"
      >
        <div className="flex items-center gap-2 px-3 h-12 border-b border-rule">
          <Icon.Search size={16} className="text-ink-3 shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActiveIndex(0); }}
            onKeyDown={handleKey}
            placeholder="Jump to a page or project..."
            className="flex-1 h-full bg-transparent text-[14px] text-ink placeholder:text-ink-4 outline-none"
          />
          <kbd className="text-[10px] text-ink-3 px-1.5 h-5 inline-flex items-center bg-muted rounded">Esc</kbd>
        </div>
        <div className="max-h-[420px] overflow-y-auto py-1.5">
          {items.length === 0 ? (
            <div className="px-4 py-6 text-[13px] text-ink-3 text-center">No matches.</div>
          ) : (
            groups.map((g) => (
              <div key={g.name} className="px-1.5">
                <div className="px-2.5 pt-2 pb-1 text-[10.5px] uppercase tracking-wider text-ink-4 font-medium">{g.name}</div>
                {g.items.map((item) => {
                  flatIndex++;
                  const isActive = flatIndex === activeIndex;
                  return (
                    <button
                      key={item.id}
                      onMouseEnter={() => setActiveIndex(flatIndex)}
                      onClick={() => navigate(item)}
                      className={`w-full text-left flex items-center gap-2.5 px-2.5 h-9 rounded text-[13px] transition-colors ${isActive ? "bg-muted text-ink" : "text-ink-2 hover:bg-muted/60"}`}
                    >
                      <span className="flex-1 truncate font-medium">{item.label}</span>
                      {item.hint && <span className="text-[11px] text-ink-4 truncate">{item.hint}</span>}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
        <div className="px-3 h-8 border-t border-rule flex items-center justify-between text-[10.5px] text-ink-4">
          <span>↑↓ navigate · ↵ open · Esc close</span>
          <span>⌘K</span>
        </div>
      </div>
    </div>
  );
}
