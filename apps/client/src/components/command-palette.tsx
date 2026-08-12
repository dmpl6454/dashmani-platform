"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FileText } from "lucide-react";
import { Icon } from "./portal-icons";
import { KbdRow } from "./portal-shared";
import { useClientProjects } from "@/lib/hooks/use-projects";
import { useInputDevice } from "@/lib/hooks/use-input-device";
import { apiFetch } from "@/lib/api";

interface PaletteItem {
  id: string;
  label: string;
  sub?: string;
  href: string;
  icon: React.ComponentType<any>;
}

const PAGES: PaletteItem[] = [
  { id: "page-dashboard", label: "Home",      sub: "Dashboard",        href: "/dashboard", icon: Icon.Dashboard  },
  { id: "page-projects",  label: "Projects",  sub: "Browse projects",  href: "/projects",  icon: Icon.Folder     },
  { id: "page-content",   label: "Content",   sub: "All posts",        href: "/content",   icon: Icon.Edit       },
  { id: "page-approvals", label: "Approvals", sub: "Pending review",   href: "/approvals", icon: Icon.Check      },
  { id: "page-analytics", label: "Analytics", sub: "Metrics",          href: "/analytics", icon: Icon.Chart      },
  { id: "page-files",     label: "Files",     sub: "Project files",    href: "/files",     icon: Icon.File       },
];

// Module-level event emitter so any component can open the palette.
type Listener = (open: boolean) => void;
const listeners = new Set<Listener>();
let openState = false;

function setOpen(next: boolean) {
  openState = next;
  listeners.forEach((l) => l(openState));
}

export function useCommandPalette() {
  return {
    open:   () => setOpen(true),
    close:  () => setOpen(false),
    toggle: () => setOpen(!openState),
  };
}

export function CommandPalette() {
  const router = useRouter();
  const [open, setLocalOpen] = useState(openState);
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const { hasKeyboard } = useInputDevice();

  const { data: projectsData } = useClientProjects();
  const projects: any[] = projectsData?.items ?? [];
  const [posts, setPosts] = useState<any[]>([]);

  useEffect(() => {
    if (query.trim().length < 2) { setPosts([]); return; }
    let cancelled = false;
    apiFetch<any>(`/client/content?search=${encodeURIComponent(query.trim())}&limit=10`)
      .then((res) => { if (!cancelled) setPosts(res?.data?.items ?? res?.data ?? []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [query]);

  useEffect(() => {
    const l: Listener = (next) => setLocalOpen(next);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);

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
      setFocused(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const items: PaletteItem[] = useMemo(() => {
    const projectItems: PaletteItem[] = projects.map((p: any) => ({
      id:    `project-${p.id}`,
      label: p.name,
      sub:   `Project · ${p.status}`,
      href:  `/projects/${p.id}`,
      icon:  Icon.Folder,
    }));
    const postItems: PaletteItem[] = posts.map((p: any) => ({
      id:    `post-${p.id}`,
      label: p.title,
      sub:   p.format ?? p.platform ?? p.status ?? "Post",
      href:  `/content/${p.id}`,
      icon:  FileText,
    }));
    const all = [...PAGES, ...projectItems, ...postItems];
    const q = query.trim().toLowerCase();
    if (!q) return PAGES;
    return all.filter((i) => i.label.toLowerCase().includes(q) || i.sub?.toLowerCase().includes(q));
  }, [projects, posts, query]);

  useEffect(() => { setFocused(0); }, [query]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") { e.preventDefault(); setFocused((v) => Math.min(items.length - 1, v + 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setFocused((v) => Math.max(0, v - 1)); }
      else if (e.key === "Enter") {
        e.preventDefault();
        const item = items[focused];
        if (item) { setOpen(false); router.push(item.href); }
      } else if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, items, focused, router]);

  if (!open) return null;

  return (
    <div className="palette-shell pop-in" onClick={() => setOpen(false)}>
      <div className="v3-card palette-card" onClick={(e) => e.stopPropagation()}>
        {/* Input */}
        <div className="flex items-center gap-3 px-4 h-14 shrink-0" style={{ borderBottom: "2px solid rgba(26,26,26,0.08)" }}>
          <Icon.Search size={18} className="text-ink-3 shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search posts, projects…"
            className="flex-1 bg-transparent text-[15px] font-semibold text-ink placeholder:text-ink-4 outline-none"
          />
          {query && (
            <button onClick={() => setQuery("")} aria-label="Clear search" className="text-ink-3 hover:text-ink transition-colors">
              <Icon.X size={16} />
            </button>
          )}
          {hasKeyboard ? (
            <kbd className="shrink-0">Esc</kbd>
          ) : (
            /* No Esc key and no scrim to tap on a sheet — give touch users a real close control. */
            <button
              onClick={() => setOpen(false)}
              aria-label="Close search"
              className="shrink-0 h-8 px-3 rounded-lg text-[12.5px] font-bold text-ink-2 bg-muted"
            >
              Close
            </button>
          )}
        </div>

        {/* Results */}
        <div className="palette-results py-2">
          {items.length === 0 && query.trim() && (
            <div className="px-5 py-8 text-center text-[13px] text-ink-3 font-medium">
              No results for &ldquo;<span className="font-bold text-ink">{query}</span>&rdquo;
            </div>
          )}
          {!query.trim() && (
            <div className="px-4 pb-1 pt-1">
              <span className="text-[10px] uppercase tracking-widest font-bold text-ink-3">Quick navigation</span>
            </div>
          )}
          {items.map((it, i) => {
            const IC = it.icon;
            const isFocused = i === focused;
            return (
              <button
                key={it.id}
                onMouseEnter={() => setFocused(i)}
                onClick={() => { setOpen(false); router.push(it.href); }}
                className={`w-full flex items-center gap-3 px-4 h-12 text-left transition-colors
                  ${isFocused ? "bg-indigo-soft" : "hover:bg-muted/60"}`}
              >
                <div className={`h-8 w-8 rounded-xl grid place-items-center shrink-0 border-2
                  ${isFocused ? "bg-indigo text-white border-ink" : "bg-muted text-ink-2 border-ink/10"}`}>
                  <IC size={15} sw={2} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className={`text-[13.5px] font-semibold truncate ${isFocused ? "text-indigo" : "text-ink"}`}>{it.label}</div>
                  {it.sub && <div className="text-[11px] text-ink-3 font-medium truncate">{it.sub}</div>}
                </div>
                {isFocused && hasKeyboard && <kbd className="shrink-0">↵</kbd>}
              </button>
            );
          })}
        </div>

        {/* Footer — keyboard affordances only, so it has nothing to say on touch */}
        {hasKeyboard && (
          <div className="px-4 py-2.5 flex items-center gap-4 shrink-0" style={{ borderTop: "2px solid rgba(26,26,26,0.07)", background: "rgba(243,238,216,0.4)" }}>
            <KbdRow items={[{ k: "↑↓", label: "navigate" }, { k: "↵", label: "open" }, { k: "Esc", label: "close" }]} />
          </div>
        )}
      </div>
    </div>
  );
}
