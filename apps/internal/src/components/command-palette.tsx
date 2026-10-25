"use client";
import { useEffect, useRef, useState, useMemo } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  Search, LayoutDashboard, Users, Building2, Clock, CheckSquare, Globe,
  BarChart3, Briefcase, FolderOpen, FileEdit, TrendingUp, FileText,
  UserPlus, Megaphone, Wallet, FileSignature, Calendar, BriefcaseBusiness,
  Bug, Sparkles, Laptop, GraduationCap, AlertCircle, Settings, ArrowRight, X,
} from "lucide-react";
import { cn } from "@dashmani/ui";
import { isDsRoute } from "@/lib/ds-routes";

/* ── All navigable pages ── */
const SEARCH_ITEMS = [
  /* Main nav */
  { id: "dashboard",     label: "Dashboard",     group: "Pages", icon: LayoutDashboard,   href: "/dashboard"     },
  { id: "employees",     label: "Employees",     group: "Pages", icon: Users,             href: "/employees"     },
  { id: "teams",         label: "Teams",         group: "Pages", icon: Building2,         href: "/teams"         },
  { id: "tasks",         label: "Tasks",         group: "Pages", icon: CheckSquare,       href: "/tasks"         },
  { id: "content",       label: "Content",       group: "Pages", icon: FileEdit,          href: "/content"       },
  { id: "accounts",      label: "Accounts",      group: "Pages", icon: Globe,             href: "/accounts"      },
  { id: "account-growth", label: "Account Growth", group: "Pages", icon: TrendingUp,      href: "/accounts/growth" },
  { id: "workload",      label: "Workload",      group: "Pages", icon: BarChart3,         href: "/workload"      },
  { id: "clients",       label: "Clients",       group: "Pages", icon: Briefcase,         href: "/clients"       },
  { id: "projects",      label: "Projects",      group: "Pages", icon: FolderOpen,        href: "/projects"      },
  { id: "attendance",    label: "Attendance",    group: "Pages", icon: Clock,             href: "/attendance"    },
  { id: "approvals",     label: "Approvals",     group: "Pages", icon: CheckSquare,       href: "/approvals"     },
  { id: "analytics",     label: "Analytics",     group: "Pages", icon: TrendingUp,        href: "/analytics"     },
  { id: "reports",       label: "Reports",       group: "Pages", icon: FileText,          href: "/reports"       },
  { id: "announcements", label: "Announcements", group: "Pages", icon: Megaphone,         href: "/announcements" },
  /* More */
  { id: "ai-assistant",  label: "AI Assistant",  group: "Tools", icon: Sparkles,          href: "/ai-assistant"  },
  { id: "salary-slips",  label: "Salary Slips",  group: "Tools", icon: Wallet,            href: "/salary-slips"  },
  { id: "offer-letters", label: "Offer Letters", group: "Tools", icon: FileSignature,     href: "/offer-letters" },
  { id: "holidays",      label: "Holidays",      group: "Tools", icon: Calendar,          href: "/holidays"      },
  { id: "jobs",          label: "Job Listings",  group: "Tools", icon: BriefcaseBusiness, href: "/jobs"          },
  { id: "expenses",      label: "Expenses",      group: "Tools", icon: Wallet,            href: "/expenses"      },
  { id: "devices",       label: "Devices",       group: "Tools", icon: Laptop,            href: "/devices"       },
  { id: "auto-teams",    label: "Auto Teams",    group: "Tools", icon: UserPlus,          href: "/auto-teams"    },
  { id: "internships",   label: "Internships",   group: "Tools", icon: GraduationCap,     href: "/internships"   },
  { id: "complaints",    label: "Complaints",    group: "Tools", icon: AlertCircle,       href: "/complaints"    },
  { id: "bug-reports",   label: "Bug Reports",   group: "Tools", icon: Bug,               href: "/bug-reports"   },
  { id: "settings",      label: "Settings",      group: "Tools", icon: Settings,          href: "/settings"      },
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
      return [{ heading: "Quick navigation", items: SEARCH_ITEMS.slice(0, 8) }];
    }
    const q = query.toLowerCase();
    const pageHits = SEARCH_ITEMS.filter(i => i.label.toLowerCase().includes(q));
    const out: { heading: string; items: typeof SEARCH_ITEMS }[] = [];
    const pages = pageHits.filter(i => i.group === "Pages");
    const tools = pageHits.filter(i => i.group === "Tools");
    if (pages.length) out.push({ heading: "Pages", items: pages });
    if (tools.length) out.push({ heading: "Tools", items: tools });
    if (!out.length)  out.push({ heading: "No results", items: [] });
    return out;
  }, [query]);

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
