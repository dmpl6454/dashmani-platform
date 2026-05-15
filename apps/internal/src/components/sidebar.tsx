"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@dashmani/ui";
import {
  LayoutDashboard, Users, Building2, Clock, CheckSquare, Globe, BarChart3,
  Briefcase, FolderOpen, FileEdit, TrendingUp, FileText, UserPlus, Megaphone,
  ChevronLeft, ChevronRight, Wallet, FileSignature, Calendar, BriefcaseBusiness,
  Bug, Sparkles, ClipboardList, Laptop, GraduationCap, AlertCircle,
} from "lucide-react";
import { useOverviewStats } from "@/lib/hooks/use-analytics";
import { useState, useEffect } from "react";

const primaryNav = [
  { href: "/dashboard",        label: "Dashboard",        icon: LayoutDashboard },
  { href: "/employees",        label: "Employees",        icon: Users },
  { href: "/employees/pending",label: "Pending",          icon: UserPlus,        badgeKey: "pendingEmployees" as const },
  { href: "/teams",            label: "Teams",            icon: Building2 },
  { href: "/tasks",            label: "Tasks",            icon: CheckSquare },
  { href: "/content",          label: "Content",          icon: FileEdit },
  { href: "/projects",         label: "Projects",         icon: FolderOpen },
  { href: "/clients",          label: "Clients",          icon: Briefcase },
  { href: "/accounts",         label: "Accounts",         icon: Globe },
  { href: "/analytics",        label: "Analytics",        icon: TrendingUp },
  { href: "/reports",          label: "Reports",          icon: FileText },
  { href: "/attendance",       label: "Attendance",       icon: Clock },
  { href: "/announcements",    label: "Announcements",    icon: Megaphone },
  { href: "/workload",         label: "Workload",         icon: BarChart3 },
];

const secondaryNav = [
  { href: "/approvals",        label: "Approvals",        icon: CheckSquare },
  { href: "/salary-slips",     label: "Salary Slips",     icon: Wallet },
  { href: "/offer-letters",    label: "Offer Letters",    icon: FileSignature },
  { href: "/holidays",         label: "Holidays",         icon: Calendar },
  { href: "/jobs",             label: "Job Listings",     icon: BriefcaseBusiness },
  { href: "/expenses",         label: "Expenses",         icon: Wallet },
  { href: "/devices",          label: "Devices",          icon: Laptop },
  { href: "/auto-teams",       label: "Auto Teams",       icon: UserPlus },
  { href: "/internships",      label: "Internships",      icon: GraduationCap },
  { href: "/complaints",       label: "Complaints",       icon: AlertCircle },
  { href: "/bug-reports",      label: "Bug Reports",      icon: Bug },
  { href: "/ai-assistant",     label: "AI Assistant",     icon: Sparkles },
];

export function Sidebar() {
  const pathname = usePathname();
  const { data } = useOverviewStats();
  const stats = (data as any)?.data;
  const [collapsed, setCollapsed] = useState(false);
  const [showMore, setShowMore] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem("int-rail-collapsed");
    if (saved !== null) setCollapsed(saved === "true");
  }, []);

  function toggleCollapsed() {
    setCollapsed(v => {
      localStorage.setItem("int-rail-collapsed", String(!v));
      return !v;
    });
  }

  const w = collapsed ? "w-[58px]" : "w-[220px]";

  function NavItem({ href, label, icon: Icon, badgeKey }: {
    href: string; label: string; icon: any; badgeKey?: "pendingEmployees";
  }) {
    const isActive = pathname === href || (href !== "/employees" && href !== "/" && pathname.startsWith(href));
    const badge = badgeKey && stats ? stats[badgeKey] : 0;
    return (
      <Link
        href={href}
        title={collapsed ? label : undefined}
        className={cn(
          "group relative flex items-center gap-3 px-3 py-2 rounded-xl text-sm transition-all duration-150 select-none",
          isActive ? "nav-active" : "text-ink-3 hover:bg-muted hover:text-ink"
        )}
      >
        <Icon className="h-5 w-5 flex-shrink-0" strokeWidth={isActive ? 2.5 : 2} />
        {!collapsed && <span className="flex-1 truncate font-medium">{label}</span>}
        {!collapsed && badge > 0 && (
          <span className="bg-attention text-white text-[10px] font-bold min-w-[18px] h-[18px] flex items-center justify-center rounded-full px-1 dot-pulse">
            {badge}
          </span>
        )}
        {collapsed && badge > 0 && (
          <span className="absolute top-0.5 right-0.5 h-2.5 w-2.5 rounded-full bg-attention dot-pulse" />
        )}
        {collapsed && (
          <div className="pointer-events-none absolute left-full ml-3 top-1/2 -translate-y-1/2 z-50 opacity-0 group-hover:opacity-100 transition-opacity px-2.5 py-1 bg-ink text-white text-xs font-medium rounded-lg whitespace-nowrap shadow-hard">
            {label}
            {badge > 0 && <span className="ml-1.5 bg-attention px-1.5 py-0.5 rounded-full text-[10px]">{badge}</span>}
          </div>
        )}
      </Link>
    );
  }

  return (
    <aside
      className={cn(
        "relative flex flex-col min-h-screen border-r-2 border-ink/10 bg-bg transition-[width] duration-200 ease-out shrink-0",
        w
      )}
    >
      {/* Logo */}
      <div className={cn(
        "flex items-center border-b-2 border-ink/10 h-[57px] shrink-0 overflow-hidden",
        collapsed ? "justify-center px-0" : "gap-2.5 px-4"
      )}>
        <img src="/logo.svg" alt="Digital Sukoon" className="h-8 w-8 rounded-full shrink-0" />
        {!collapsed && (
          <div className="min-w-0">
            <p className="text-[11px] font-bold text-ink uppercase tracking-[1.5px] leading-tight truncate">Digital Sukoon</p>
            <p className="text-[10px] text-ink-4 leading-tight">Management Portal</p>
          </div>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-0.5">
        {primaryNav.map(item => (
          <NavItem key={item.href} {...item} />
        ))}

        {/* More section */}
        {showMore && (
          <>
            <div className={cn("pt-2 pb-1", collapsed ? "px-0" : "px-1")}>
              {!collapsed && <p className="text-[10px] font-bold text-ink-4 uppercase tracking-wider px-2">More</p>}
              {collapsed && <div className="h-px bg-ink/10 mx-1" />}
            </div>
            {secondaryNav.map(item => (
              <NavItem key={item.href} href={item.href} label={item.label} icon={item.icon} />
            ))}
          </>
        )}

        {/* More toggle */}
        <button
          onClick={() => setShowMore(v => !v)}
          title={collapsed ? (showMore ? "Show less" : "More") : undefined}
          className={cn(
            "w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm text-ink-4 hover:bg-muted hover:text-ink transition-all duration-150 mt-1",
            collapsed && "justify-center"
          )}
        >
          <ClipboardList className="h-5 w-5 flex-shrink-0" strokeWidth={2} />
          {!collapsed && <span className="font-medium">{showMore ? "Show less" : "More"}</span>}
        </button>
      </nav>

      {/* Collapse toggle */}
      <button
        onClick={toggleCollapsed}
        title={collapsed ? "Expand" : "Collapse"}
        className={cn(
          "flex items-center justify-center h-9 w-9 rounded-xl border-2 border-ink/12 bg-surface hover:bg-muted transition-all btn-3d mb-4 mx-auto",
        )}
      >
        {collapsed
          ? <ChevronRight className="h-4 w-4 text-ink-3" />
          : <ChevronLeft  className="h-4 w-4 text-ink-3" />
        }
      </button>
    </aside>
  );
}
