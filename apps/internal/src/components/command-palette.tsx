"use client";
import { useEffect, useRef, useState, useMemo } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Search, LayoutDashboard, LayoutGrid, ArrowRight, X } from "lucide-react";
import { primaryNav, moreNav } from "@/components/sidebar";
import { cn } from "@dashmani/ui";
import { isDsRoute } from "@/lib/ds-routes";
import { useAuth } from "@/lib/auth";
import { canAccessPath, isHrOnly } from "@/lib/roles";

/* ── All navigable pages: derived from the sidebar's own data, so the two can never list
   different pages under different names (before 2026-11-06 this was a hand-kept copy that
   missed seven pages and renamed five). ── */
const SEARCH_ITEMS = [
  { id: "overview", label: "Overview", group: "Pages", icon: LayoutGrid, href: "/overview" },
  ...primaryNav.map((n) => ({ id: n.href.replace(/^\//, "").replace(/\//g, "-"), label: n.label, group: "Pages", icon: n.icon, href: n.href })),
  ...moreNav.map((n) => ({ id: n.href.replace(/^\//, ""), label: n.label, group: "Tools", icon: n.icon, href: n.href })),
];

const KBD_DARK = "!bg-ds-inset !border-ds-line2 !text-ds-t2 !shadow-none";

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const router = useRouter();
  // Dark ("ds") skin on redesigned pages; classic pages keep the original light palette.
  const dark = isDsRoute(usePathname() ?? "");
  // The HR-only portal lists only its own pages (lib/roles.ts), plus its home.
  const { user } = useAuth();
  const items = useMemo(() => {
    if (!isHrOnly(user)) return SEARCH_ITEMS;
    const hrHome = { id: "hr-home", label: "HR Home", group: "Pages", icon: LayoutDashboard, href: "/hr" };
    return [hrHome, ...SEARCH_ITEMS.filter((i) => canAccessPath(user, i.href))];
  }, [user]);
  const [query, setQuery]   = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  /* Reset + focus on open */
  useEffect(() => {
    if (open) {
      setQuery("");
      setCursor(0);
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [open]);

  /* Build result groups */
  const groups = useMemo(() => {
    if (!query.trim()) {
      return [{ heading: "Quick navigation", items: items.slice(0, 8) }];
    }
    const q = query.toLowerCase();
    const pageHits = items.filter(i => i.label.toLowerCase().includes(q));
    const out: { heading: string; items: typeof SEARCH_ITEMS }[] = [];
    const pages = pageHits.filter(i => i.group === "Pages");
    const tools = pageHits.filter(i => i.group === "Tools");
    if (pages.length) out.push({ heading: "Pages", items: pages });
    if (tools.length) out.push({ heading: "Tools", items: tools });
    if (!out.length)  out.push({ heading: "No results", items: [] });
    return out;
  }, [query, items]);

  const flat = groups.flatMap(g => g.items);

  /* Reset cursor on query change */
  useEffect(() => { setCursor(0); }, [query]);

  function navigate(item: (typeof SEARCH_ITEMS)[number]) {
    router.push(item.href);
    onClose();
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setCursor(c => Math.min(c + 1, flat.length - 1)); }
    if (e.key === "ArrowUp")   { e.preventDefault(); setCursor(c => Math.max(c - 1, 0)); }
    if (e.key === "Enter" && flat[cursor]) { navigate(flat[cursor]); }
    if (e.key === "Escape") onClose();
  }

  if (!open) return null;

  let globalIdx = 0;

  return (
    <div
      className={cn("fixed inset-0 z-[90] backdrop-blur-[2px] flex items-start justify-center pt-[12vh] px-4 pop-in", dark ? "bg-[rgba(2,6,10,.7)]" : "bg-ink/20")}
      onClick={onClose}
    >
      <div
        className={cn("w-full max-w-[520px] overflow-hidden", dark ? "rounded-[14px] border border-ds-line2 bg-ds-card shadow-[0_30px_80px_rgba(0,0,0,.65)]" : "v3-card")}
        onClick={e => e.stopPropagation()}
      >
        {/* Input row */}
        <div className={cn("flex items-center gap-3 px-4 h-14", dark ? "border-b border-ds-line" : "border-b-2 border-ink/10")}>
          <Search className={cn("h-[18px] w-[18px] flex-shrink-0", dark ? "text-ds-gold" : "text-ink-3")} strokeWidth={2} />
          <input
            ref={inputRef}
            className={cn("flex-1 text-[14.5px] font-medium bg-transparent outline-none", dark ? "ds-bare text-ds-text placeholder:text-ds-t3 border-0 shadow-none" : "text-ink placeholder:text-ink-4")}
            placeholder="Search pages, tools…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={onKey}
          />
          {query ? (
            <button onClick={() => setQuery("")} className={cn("transition-colors flex-shrink-0", dark ? "text-ds-t3 hover:text-ds-text" : "text-ink-4 hover:text-ink-2")}>
              <X className="h-3.5 w-3.5" />
            </button>
          ) : (
            <kbd className={cn("flex-shrink-0", dark && KBD_DARK)}>Esc</kbd>
          )}
        </div>

        {/* Results */}
        <div className="max-h-[380px] overflow-y-auto">
          {groups.map(group => {
            return (
              <div key={group.heading}>
                <div className="px-4 py-2.5">
                  <span className={cn("text-[10.5px] font-bold uppercase tracking-widest", dark ? "text-ds-gold" : "text-ink-4")}>{group.heading}</span>
                </div>
                {group.items.length === 0 && (
                  <div className={cn("px-4 pb-4 text-[13px] font-medium", dark ? "text-ds-t2" : "text-ink-3")}>No matches found</div>
                )}
                {group.items.map(item => {
                  const idx = globalIdx++;
                  const isHighlighted = idx === cursor;
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.id}
                      onClick={() => navigate(item)}
                      onMouseEnter={() => setCursor(idx)}
                      className={cn(
                        "w-full flex items-center gap-3 px-4 py-2.5 text-left transition-all",
                        dark ? (isHighlighted ? "bg-[rgba(233,189,98,.1)]" : "hover:bg-ds-hover") : (isHighlighted ? "bg-indigo-soft" : "hover:bg-muted/40")
                      )}
                    >
                      <div className={cn(
                        "h-8 w-8 rounded-xl grid place-items-center flex-shrink-0 transition-colors",
                        dark ? (isHighlighted ? "bg-ds-gold text-[color:var(--hx-060D14)]" : "bg-ds-inset border border-ds-line2 text-ds-t2") : (isHighlighted ? "bg-indigo text-white" : "bg-muted text-ink-3")
                      )}>
                        <Icon className="h-4 w-4" strokeWidth={2} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className={cn(
                          "text-[13.5px] font-semibold truncate",
                          dark ? (isHighlighted ? "text-ds-gold" : "text-ds-text") : (isHighlighted ? "text-indigo" : "text-ink")
                        )}>{item.label}</p>
                      </div>
                      {isHighlighted && <ArrowRight className={cn("h-3.5 w-3.5 flex-shrink-0", dark ? "text-ds-gold" : "text-indigo")} />}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className={cn("px-4 py-2.5 flex items-center gap-4 border-t", dark ? "border-ds-line bg-ds-inset" : "border-ink/10")}>
          <div className={cn("flex items-center gap-3 text-[11px] font-medium", dark ? "text-ds-t3" : "text-ink-4")}>
            <span className="flex items-center gap-1"><kbd className={cn(dark && KBD_DARK)}>↑↓</kbd> navigate</span>
            <span className="flex items-center gap-1"><kbd className={cn(dark && KBD_DARK)}>↵</kbd> open</span>
            <span className="flex items-center gap-1"><kbd className={cn(dark && KBD_DARK)}>Esc</kbd> close</span>
          </div>
        </div>
      </div>
    </div>
  );
}
