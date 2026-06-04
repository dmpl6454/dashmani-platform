"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useHrAuth } from "@/lib/auth";
import { useState, useEffect } from "react";
import {
  LayoutDashboard, FileText, Clock, Trophy, Users, UserCircle,
  Wallet, FolderOpen, Calendar, PlaneTakeoff, Home, Gift, ListTodo, Receipt,
  Presentation, ClipboardList, Timer, Award, AlertCircle, Building2, ScrollText,
  FileCheck, Bug, Mail, ChevronLeft, ChevronRight, ChevronDown, Grid3x3,
  LogOut, Menu, X as CloseIcon,
} from "lucide-react";

type NavItem = { href: string; label: string; icon: React.ElementType; group?: string };

const NAV_MAIN: NavItem[] = [
  { href: "/dashboard",    label: "Dashboard",      icon: LayoutDashboard },
  { href: "/report",       label: "Submit Links",   icon: FileText,        group: "Daily" },
  { href: "/history",      label: "Link History",   icon: Clock },
  { href: "/leaderboard",  label: "Leaderboard",    icon: Trophy },
  { href: "/team",         label: "My Team",        icon: Users,           group: "People" },
  { href: "/leave",        label: "Leave Request",  icon: PlaneTakeoff,    group: "Time Off" },
  { href: "/wfh",          label: "Work from Home", icon: Home },
  { href: "/comp-off",     label: "Comp Off",       icon: Gift },
  { href: "/salary-slips", label: "Salary Slips",   icon: Wallet,          group: "Money" },
  { href: "/expenses",     label: "Expense Claims", icon: Receipt },
  { href: "/documents",    label: "Documents",      icon: FolderOpen,      group: "Resources" },
  { href: "/tasks",        label: "My Tasks",       icon: ListTodo },
  { href: "/profile",      label: "My Profile",     icon: UserCircle },
];

const NAV_MORE: NavItem[] = [
  { href: "/offer-letters", label: "Offer Letters",  icon: Mail },
  { href: "/presentations", label: "Presentations",  icon: Presentation },
  { href: "/plan",          label: "Daily Update",   icon: ClipboardList },
  { href: "/calendar",      label: "Calendar",       icon: Calendar },
  { href: "/extra-hours",   label: "Extra Hours",    icon: Timer },
  { href: "/reviews",       label: "My Reviews",     icon: Award },
  { href: "/complaints",    label: "Complaints",     icon: AlertCircle },
  { href: "/company",       label: "About Company",  icon: Building2 },
  { href: "/sop",           label: "SOPs & Terms",   icon: ScrollText },
  { href: "/contract",      label: "My Contract",    icon: FileCheck },
  { href: "/bug-report",    label: "Report Bug",     icon: Bug },
];

function MoreGrid({ expanded, pathname }: { expanded: boolean; pathname: string }) {
  const [open, setOpen] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("hr.moreOpen") === "1";
  });

  useEffect(() => {
    localStorage.setItem("hr.moreOpen", open ? "1" : "0");
  }, [open]);

  const hasActive = NAV_MORE.some(i => pathname.startsWith(i.href));

  if (!expanded) {
    return (
      <Link href="/calendar" title="More"
        className={`w-full flex justify-center items-center h-10 rounded-xl transition-all mb-0.5 ${
          hasActive ? "nav-active" : "text-ink-3 hover:bg-muted/80 hover:text-ink"
        }`}>
        <Grid3x3 size={16} strokeWidth={1.8} />
      </Link>
    );
  }

  return (
    <div className="mb-1">
      <button onClick={() => setOpen(v => !v)}
        className={`w-full flex items-center gap-3 px-3 h-10 rounded-xl text-[13px] font-medium transition-all mb-0.5 ${
          hasActive ? "nav-active" : "text-ink-3 hover:bg-muted/80 hover:text-ink"
        }`}>
        <Grid3x3 size={16} strokeWidth={1.8} />
        <span className="flex-1 text-left">More</span>
        <span className="h-5 px-1.5 rounded-full bg-muted text-ink-4 text-[10px] font-bold grid place-items-center tabular-nums">
          {NAV_MORE.length}
        </span>
        <ChevronDown size={12} className={`text-ink-4 transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
      </button>

      <div className={`overflow-hidden transition-all duration-250 ease-in-out ${open ? "max-h-[400px] opacity-100" : "max-h-0 opacity-0"}`}>
        <div className="mx-1 mb-1 rounded-xl overflow-hidden"
             style={{ background: "#F3EED8", border: "1.5px solid rgba(26,26,26,0.09)" }}>
          <div className="px-3 py-2" style={{ borderBottom: "1px solid rgba(26,26,26,0.07)" }}>
            <span className="text-[9.5px] font-bold text-ink-4 uppercase tracking-widest">All Features</span>
          </div>
          <div className="grid grid-cols-3 gap-1 p-2">
            {NAV_MORE.map(item => {
              const isActive = pathname.startsWith(item.href);
              const I = item.icon;
              return (
                <Link key={item.href} href={item.href}
                  className={`group flex flex-col items-center gap-1.5 px-1 py-2.5 rounded-lg text-center transition-all duration-150 ${
                    isActive ? "bg-indigo text-white shadow-sm" : "hover:bg-white/70 text-ink-3 hover:text-ink"
                  }`}>
                  <div className={`h-7 w-7 rounded-lg grid place-items-center shrink-0 transition-colors ${
                    isActive ? "bg-white/20" : "bg-white/50 group-hover:bg-white/80"
                  }`}>
                    <I size={14} strokeWidth={isActive ? 2.2 : 1.8} />
                  </div>
                  <span className="text-[9.5px] font-semibold leading-tight text-center w-full break-words">{item.label}</span>
                </Link>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

interface SidebarInnerProps {
  collapsed: boolean;
  mobile?: boolean;
  pathname: string;
  userName?: string;
  userEmail?: string;
  initial: string;
  onCollapse?: () => void;
  onClose?: () => void;
  onLogout: () => void;
}

function SidebarInner({ collapsed, mobile, pathname, userName, userEmail, initial, onCollapse, onClose, onLogout }: SidebarInnerProps) {
  const expanded = !collapsed || !!mobile;
  let lastGroup: string | undefined;

  return (
    <>
      {/* Logo */}
      <div
        className={`flex items-center ${expanded ? "gap-3 px-4" : "justify-center px-0"} h-16 shrink-0`}
        style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}
      >
        <div className="h-8 w-8 rounded-xl bg-ink text-white grid place-items-center text-[11px] font-black tracking-widest shrink-0">
          DS
        </div>
        {expanded && (
          <div className="flex-1 min-w-0 leading-tight">
            <div className="text-[13.5px] font-bold text-ink">Digital Sukoon</div>
            <div className="text-[11px] text-ink-3 font-medium">Employee Portal</div>
          </div>
        )}
        {onClose && (
          <button onClick={onClose} className="ml-auto p-1 text-ink-3 hover:text-ink" aria-label="Close menu">
            <CloseIcon size={18} />
          </button>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 px-2 py-3 overflow-y-auto min-h-0">
        {NAV_MAIN.map((n) => {
          const isActive = pathname.startsWith(n.href);
          const I = n.icon;
          const showGroup = expanded && n.group && n.group !== lastGroup;
          if (n.group) lastGroup = n.group;

          return (
            <div key={n.href}>
              {showGroup && (
                <div className="px-3 pt-4 pb-1.5">
                  <span className="text-[9.5px] font-bold text-ink-4 uppercase tracking-widest">{n.group}</span>
                </div>
              )}
              <Link href={n.href} title={!expanded ? n.label : undefined}
                className={`w-full flex items-center ${expanded ? "gap-3 px-3" : "justify-center px-0"} h-10 rounded-xl text-[13px] transition-all duration-150 relative mb-0.5 ${
                  isActive ? "nav-active" : "text-ink-3 font-medium hover:bg-muted/80 hover:text-ink"
                }`}>
                <I size={16} strokeWidth={isActive ? 2.4 : 1.8} />
                {expanded && <span className="flex-1 text-left">{n.label}</span>}
              </Link>
            </div>
          );
        })}

        <div className="mx-3 my-2" style={{ borderTop: "1px dashed rgba(26,26,26,0.1)" }} />
        <MoreGrid expanded={expanded} pathname={pathname} />
      </nav>

      {/* Footer */}
      <div className="px-2 py-3 shrink-0 space-y-0.5" style={{ borderTop: "2px solid rgba(26,26,26,0.07)" }}>
        {onCollapse && (
          <button onClick={onCollapse}
            className={`w-full flex items-center ${expanded ? "gap-2 px-3" : "justify-center px-0"} h-9 rounded-xl text-[12px] font-medium text-ink-3 hover:bg-muted/80 hover:text-ink transition-colors`}>
            {collapsed
              ? <ChevronRight size={16} />
              : <><ChevronLeft size={16} /><span>Collapse</span></>
            }
          </button>
        )}

        <div className={`w-full flex items-center ${expanded ? "gap-3 px-2" : "justify-center px-0"} h-12 rounded-xl hover:bg-muted/70 transition-colors`}>
          <div className="h-7 w-7 rounded-full grid place-items-center text-white text-xs font-bold shrink-0"
               style={{ background: "linear-gradient(135deg,#5D5FEF,#4547D4)" }}>
            {initial}
          </div>
          {expanded && (
            <div className="flex-1 min-w-0 leading-tight">
              <div className="text-[12.5px] font-bold text-ink truncate">{userName}</div>
              <div className="text-[10.5px] text-ink-3 font-medium truncate">{userEmail}</div>
            </div>
          )}
        </div>

        {expanded && (
          <button onClick={onLogout}
            className="w-full flex items-center gap-2 px-3 h-9 rounded-xl text-[12px] font-medium text-ink-3 hover:bg-muted/80 hover:text-ink transition-colors">
            <LogOut size={14} />
            <span>Log out</span>
          </button>
        )}
      </div>
    </>
  );
}

export function HrSidebar() {
  const pathname = usePathname();
  const { user, logout } = useHrAuth();
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("hr.railCollapsed") === "1";
  });
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    localStorage.setItem("hr.railCollapsed", collapsed ? "1" : "0");
  }, [collapsed]);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  const initial = user?.name?.charAt(0)?.toUpperCase() || "U";
  const sharedProps = { pathname, userName: user?.name, userEmail: user?.email, initial, onLogout: logout };

  return (
    <>
      {/* Mobile top bar */}
      <div className="lg:hidden fixed top-0 left-0 right-0 z-40 flex items-center gap-3 px-4 h-14 bg-surface"
           style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
        <button onClick={() => setMobileOpen(true)} className="p-1 text-ink-3 hover:text-ink" aria-label="Open menu">
          <Menu size={22} />
        </button>
        <div className="h-7 w-7 rounded-xl bg-ink text-white grid place-items-center text-[10px] font-black tracking-widest shrink-0">
          DS
        </div>
        <span className="text-[13px] font-bold text-ink">Digital Sukoon</span>
      </div>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-50 flex">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
          <aside className="relative z-10 w-[280px] flex flex-col bg-surface h-full overflow-y-auto"
                 style={{ borderRight: "2px solid rgba(26,26,26,0.09)" }}>
            <SidebarInner {...sharedProps} collapsed={false} mobile onClose={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}

      {/* Desktop sidebar */}
      <aside
        className={`${collapsed ? "w-[58px]" : "w-[220px]"} hidden lg:flex shrink-0 flex-col bg-surface transition-[width] duration-200`}
        style={{ borderRight: "2px solid rgba(26,26,26,0.09)" }}
      >
        <SidebarInner {...sharedProps} collapsed={collapsed} onCollapse={() => setCollapsed(v => !v)} />
      </aside>
    </>
  );
}
