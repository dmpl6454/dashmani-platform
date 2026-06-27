"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@dashmani/ui";
import {
  LayoutDashboard, Users, Building2, Clock, CheckSquare, Globe, BarChart3,
  Briefcase, FolderOpen, FileEdit, TrendingUp, FileText, UserPlus, Megaphone,
  ChevronLeft, ChevronRight, Wallet, FileSignature, Calendar, BriefcaseBusiness,
  Bug, Sparkles, Laptop, GraduationCap, AlertCircle, Settings, LayoutGrid,
  Menu, X as CloseIcon, CalendarOff, ClipboardList, Search, Receipt,
} from "lucide-react";
import { useOverviewStats } from "@/lib/hooks/use-analytics";
import { useState, useEffect } from "react";

/* ── Primary nav — grouped, always visible ── */
const primaryNav = [
  { href: "/dashboard",     label: "Dashboard",        icon: LayoutDashboard, group: null },
  { href: "/employees",     label: "Employees",        icon: Users,           group: "People",    badgeKey: "pendingEmployees" as const },
  { href: "/teams",         label: "Teams",            icon: Building2,       group: null },
  { href: "/tasks",         label: "Tasks",            icon: CheckSquare,     group: "Work" },
  { href: "/content",       label: "Content",          icon: FileEdit,        group: null },
  { href: "/accounts",      label: "Accounts",         icon: Globe,           group: null },
  { href: "/accounts/growth", label: "Account Growth", icon: TrendingUp,      group: null },
  { href: "/daily-reports", label: "Daily Updates",    icon: ClipboardList,   group: null },
  { href: "/workload",      label: "Workload Matrix",  icon: BarChart3,       group: null },
  { href: "/clients",       label: "Clients",          icon: Briefcase,       group: "Business" },
  { href: "/projects",      label: "Projects",         icon: FolderOpen,      group: null },
  { href: "/attendance",    label: "Attendance",       icon: Clock,           group: "Analytics" },
  { href: "/leave",         label: "Leave",            icon: CalendarOff,     group: null },
  { href: "/approvals",     label: "Approvals",        icon: CheckSquare,     group: null },
  { href: "/analytics",     label: "Analytics",        icon: TrendingUp,      group: null },
  { href: "/reports",       label: "Link Reports",     icon: FileText,        group: null },
  { href: "/reports/link-search", label: "Link Search",      icon: Search,          group: null },
  { href: "/expenses",      label: "Expense Claims",   icon: Wallet,          group: null },
  { href: "/devices",       label: "Assigned Devices", icon: Laptop,          group: null },
  { href: "/complaints",    label: "Complaints",       icon: AlertCircle,     group: null },
  { href: "/bug-reports",   label: "Bug Reports",      icon: Bug,             group: null },
  { href: "/ai-assistant",  label: "AI Assistant",     icon: Sparkles,        group: "Tools" },
  { href: "/api-costs",     label: "API Costs",        icon: Receipt,         group: null },
  { href: "/announcements", label: "Announcements",    icon: Megaphone,       group: null },
];

/* ── More section items (3-col grid) ── */
const moreNav = [
  { href: "/offer-letters", label: "Offer Letters", icon: FileSignature   },
  { href: "/holidays",      label: "Holiday Calendar", icon: Calendar      },
  { href: "/jobs",          label: "Job Listings",  icon: BriefcaseBusiness },
  { href: "/auto-teams",    label: "Auto Teams",    icon: UserPlus        },
  { href: "/internships",   label: "Internships",   icon: GraduationCap   },
  { href: "/settings",      label: "Settings",      icon: Settings        },
];

export function Sidebar() {
  const pathname = usePathname();
  const { data } = useOverviewStats();
  const stats = (data as any)?.data;
  const [collapsed, setCollapsed] = useState(false);
  const [moreOpen, setMoreOpen]   = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem("int-rail-collapsed");
    if (saved !== null) setCollapsed(saved === "true");
    const savedMore = localStorage.getItem("int-more-open");
    if (savedMore !== null) setMoreOpen(savedMore === "1");
  }, []);

  useEffect(() => { setMobileOpen(false); }, [pathname]);

  function toggleCollapsed() {
    setCollapsed(v => {
      localStorage.setItem("int-rail-collapsed", String(!v));
      return !v;
    });
  }

  function toggleMore() {
    setMoreOpen(v => {
      localStorage.setItem("int-more-open", v ? "0" : "1");
      return !v;
    });
  }

  const isMoreActive = moreNav.some(n => pathname === n.href || pathname.startsWith(n.href + "/"));

  function NavItem({ href, label, icon: Icon, badgeKey, group, prevGroup, mobile }: {
    href: string; label: string; icon: any; badgeKey?: "pendingEmployees"; group: string | null; prevGroup: string | null; mobile?: boolean;
  }) {
    const isActive = pathname === href || (href !== "/" && pathname.startsWith(href + "/"));
    const badge = badgeKey && stats ? stats[badgeKey] : 0;
    const expanded = !collapsed || !!mobile;
    const showGroupLabel = expanded && group && group !== prevGroup;

    return (
      <>
        {showGroupLabel && (
          <div className="px-3 pt-4 pb-1.5">
            <span className="text-[10px] font-bold text-ink-4 uppercase tracking-widest">{group}</span>
          </div>
        )}
        <Link
          href={href}
          title={!expanded ? label : undefined}
          className={cn(
            "group relative flex items-center gap-3 rounded-xl text-sm transition-all duration-150 select-none mb-0.5",
            !expanded ? "justify-center h-10 px-0" : "h-10 px-3",
            isActive ? "nav-active" : "text-ink-3 font-medium hover:bg-muted hover:text-ink"
          )}
        >
          <Icon className="h-[18px] w-[18px] flex-shrink-0" strokeWidth={isActive ? 2.4 : 1.8} />
          {expanded && (
            <>
              <span className="flex-1 truncate">{label}</span>
              {badge > 0 && (
                <span className={cn(
                  "h-5 min-w-[20px] px-1.5 rounded-full text-[10px] font-bold grid place-items-center tabular-nums",
                  isActive ? "bg-indigo/20 text-indigo" : "bg-attention-bg text-attention"
                )}>{badge}</span>
              )}
            </>
          )}
          {!expanded && badge > 0 && (
            <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-attention" />
          )}
          {!expanded && (
            <div className="pointer-events-none absolute left-full ml-3 top-1/2 -translate-y-1/2 z-50 opacity-0 group-hover:opacity-100 transition-opacity px-2.5 py-1 bg-ink text-white text-xs font-medium rounded-lg whitespace-nowrap shadow-hard">
              {label}
              {badge > 0 && <span className="ml-1.5 bg-attention px-1.5 py-0.5 rounded-full text-[10px]">{badge}</span>}
            </div>
          )}
        </Link>
      </>
    );
  }

  const SidebarBody = ({ mobile }: { mobile?: boolean }) => (
    <aside
      className={cn(
        "relative flex flex-col min-h-screen border-r-2 border-ink/10 bg-bg transition-[width] duration-200 ease-out shrink-0",
        mobile ? "w-[280px]" : collapsed ? "w-[58px]" : "w-[220px]"
      )}
    >
      {/* Logo */}
      <div className={cn(
        "flex items-center border-b-2 border-ink/10 h-[57px] shrink-0 overflow-hidden",
        (!collapsed || mobile) ? "gap-2.5 px-4" : "justify-center px-0"
      )}>
        <img src="/logo.svg" alt="Digital Sukoon" className="h-8 w-8 rounded-full shrink-0" />
        {(!collapsed || mobile) && (
          <div className="min-w-0">
            <p className="text-[11px] font-bold text-ink uppercase tracking-[1.5px] leading-tight truncate">Digital Sukoon</p>
            <p className="text-[10px] text-ink-4 leading-tight">Management Portal</p>
          </div>
        )}
      </div>

      {/* Nav scroll area */}
      <nav className="flex-1 overflow-y-auto py-3 px-2 min-h-0">
        {(() => {
          let prevGroup: string | null = null;
          return primaryNav.map(item => {
            const el = (
              <NavItem
                key={item.href}
                href={item.href}
                label={item.label}
                icon={item.icon}
                badgeKey={item.badgeKey}
                group={item.group}
                prevGroup={prevGroup}
                mobile={mobile}
              />
            );
            if (item.group) prevGroup = item.group;
            return el;
          });
        })()}

        {/* Divider before More */}
        <div className="mx-3 my-2 border-t border-dashed border-ink/10" />

        {/* More toggle button */}
        {(collapsed && !mobile) ? (
          <button
            onClick={() => setMoreOpen(v => !v)}
            title="More"
            className={cn(
              "w-full flex justify-center items-center h-10 rounded-xl transition-all mb-0.5",
              isMoreActive ? "nav-active" : "text-ink-3 hover:bg-muted hover:text-ink"
            )}
          >
            <LayoutGrid className="h-[18px] w-[18px]" strokeWidth={1.8} />
          </button>
        ) : (
          <button
            onClick={toggleMore}
            className={cn(
              "w-full flex items-center gap-3 px-3 h-10 rounded-xl text-[13px] font-medium transition-all mb-0.5",
              isMoreActive ? "nav-active" : "text-ink-3 hover:bg-muted hover:text-ink"
            )}
          >
            <LayoutGrid className="h-[18px] w-[18px] flex-shrink-0" strokeWidth={1.8} />
            <span className="flex-1 text-left text-sm">More</span>
            <span className="h-5 px-1.5 rounded-full bg-muted text-ink-4 text-[10px] font-bold grid place-items-center tabular-nums">
              {moreNav.length}
            </span>
            <ChevronRight
              className={cn("h-3.5 w-3.5 text-ink-4 transition-transform duration-200", moreOpen && "rotate-90")}
            />
          </button>
        )}

        {/* More expandable grid */}
        {(!collapsed || mobile) && (
          <div
            className="overflow-hidden transition-all duration-250"
            style={{
              maxHeight: moreOpen ? "520px" : "0px",
              opacity: moreOpen ? 1 : 0,
              transitionTimingFunction: "cubic-bezier(0.4,0,0.2,1)",
            }}
          >
            <div
              className="mx-1 mb-1 rounded-xl overflow-hidden"
              style={{ background: "#F3EED8", border: "1.5px solid rgba(26,26,26,0.09)" }}
            >
              {/* Grid header */}
              <div
                className="px-3 py-2"
                style={{ borderBottom: "1px solid rgba(26,26,26,0.07)" }}
              >
                <span className="text-[9.5px] font-bold text-ink-4 uppercase tracking-widest">All Features</span>
              </div>

              {/* 3-col icon grid */}
              <div className="grid grid-cols-3 gap-1 p-2">
                {moreNav.map(item => {
                  const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
                  const Icon = item.icon;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={cn(
                        "group flex flex-col items-center gap-1.5 px-1 py-2.5 rounded-lg text-center transition-all duration-150",
                        isActive
                          ? "bg-indigo text-white shadow-sm"
                          : "hover:bg-white/70 text-ink-3 hover:text-ink"
                      )}
                    >
                      <div className={cn(
                        "h-7 w-7 rounded-lg grid place-items-center shrink-0 transition-colors",
                        isActive ? "bg-white/20" : "bg-white/50 group-hover:bg-white/80"
                      )}>
                        <Icon className="h-3.5 w-3.5" strokeWidth={isActive ? 2.2 : 1.8} />
                      </div>
                      <span
                        className="text-[9.5px] font-semibold leading-tight text-center w-full line-clamp-2"
                        style={{ hyphens: "manual", wordBreak: "keep-all" }}
                      >
                        {item.label}
                      </span>
                    </Link>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </nav>

      {/* Collapse toggle — hidden in mobile drawer */}
      {!mobile && (
        <div className="px-2 py-3 shrink-0 border-t-2 border-ink/10">
          <button
            onClick={toggleCollapsed}
            title={collapsed ? "Expand" : "Collapse"}
            className={cn(
              "w-full flex items-center rounded-xl h-9 text-[12px] font-medium text-ink-3 hover:bg-muted hover:text-ink transition-colors",
              collapsed ? "justify-center px-0" : "gap-2 px-3"
            )}
          >
            {collapsed
              ? <ChevronRight className="h-4 w-4" />
              : <><ChevronLeft className="h-4 w-4" /><span>Collapse</span></>
            }
          </button>
        </div>
      )}
    </aside>
  );

  return (
    <>
      {/* Mobile top-bar hamburger */}
      <div className="lg:hidden fixed top-0 left-0 right-0 z-40 h-[57px] flex items-center gap-3 px-4 border-b-2 border-ink/10 bg-bg/95 backdrop-blur-md">
        <button onClick={() => setMobileOpen(true)} className="p-1 text-ink-3 hover:text-ink" aria-label="Open menu">
          <Menu className="h-5 w-5" />
        </button>
        <img src="/logo.svg" alt="Digital Sukoon" className="h-7 w-7 rounded-full shrink-0" />
        <span className="text-[11px] font-bold text-ink uppercase tracking-[1.5px]">Digital Sukoon</span>
      </div>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-50 flex">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
          <div className="relative z-10 flex flex-col h-full overflow-y-auto">
            <div className="absolute top-3 right-3 z-10">
              <button onClick={() => setMobileOpen(false)} className="p-1.5 rounded-lg bg-bg hover:bg-muted text-ink-3 hover:text-ink">
                <CloseIcon className="h-4 w-4" />
              </button>
            </div>
            <SidebarBody mobile />
          </div>
        </div>
      )}

      {/* Desktop sidebar */}
      <div className="hidden lg:flex">
        <SidebarBody />
      </div>
    </>
  );
}
