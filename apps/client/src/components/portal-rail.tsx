"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Icon } from "./portal-icons";
import { Avatar } from "./portal-shared";
import { useClientPendingApprovals } from "@/lib/hooks/use-content";
import { useAuth } from "@/lib/auth";

const NAV = [
  { id: "dashboard", href: "/dashboard", label: "Home",      Icon: Icon.Dashboard,   key: "g d" },
  { id: "projects",  href: "/projects",  label: "Projects",  Icon: Icon.Folder,      key: "g p" },
  { id: "content",   href: "/content",   label: "Content",   Icon: Icon.Edit,        key: "g c" },
  { id: "approvals", href: "/approvals", label: "Approvals", Icon: Icon.CheckBadge,  key: "g a", badge: "pending" as const },
  { id: "analytics", href: "/analytics", label: "Analytics", Icon: Icon.Chart,       key: "g n" },
  { id: "files",     href: "/files",     label: "Files",     Icon: Icon.File,        key: "g f" },
];

export function PortalRail() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout } = useAuth();
  const [collapsed, setCollapsed] = useState(false);
  const [mounted, setMounted] = useState(false);
  const { data: pendingApprovals } = useClientPendingApprovals();
  const pending = pendingApprovals?.length ?? 0;
  const pendingResolved = pendingApprovals !== undefined;

  useEffect(() => {
    setCollapsed(localStorage.getItem("ds.railCollapsed") === "1");
    setMounted(true);
  }, []);
  useEffect(() => {
    if (mounted) localStorage.setItem("ds.railCollapsed", collapsed ? "1" : "0");
  }, [collapsed, mounted]);

  // Global goto shortcuts: g d, g p, g c, g a, g n, g f
  useEffect(() => {
    let primed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.matches("input, textarea, select")) return;
      if (e.key === "g") {
        primed = true;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { primed = false; }, 1200);
        return;
      }
      if (primed) {
        const map: Record<string, string> = { d: "/dashboard", p: "/projects", c: "/content", a: "/approvals", n: "/analytics", f: "/files" };
        if (map[e.key]) { e.preventDefault(); router.push(map[e.key]); primed = false; if (timer) clearTimeout(timer); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  const railWidth = collapsed ? "w-railc" : "w-rail";
  const displayName = user?.name ?? "";
  const displayCompany = user?.companyName ?? "";
  const initial = (user?.name?.charAt(0) ?? "?").toUpperCase();

  return (
    <aside className={`${railWidth} shrink-0 border-r border-rule bg-bg flex flex-col transition-[width] duration-150`}>
      {/* logo */}
      <div className={`flex items-center gap-2.5 px-3 ${collapsed ? "justify-center" : ""} h-14 border-b border-rule`}>
        <div className="h-7 w-7 rounded-md bg-ink text-bg grid place-items-center font-bold text-[11px] tracking-wider shrink-0">DS</div>
        {!collapsed && (
          <div className="leading-tight">
            <div className="text-[13px] font-semibold text-ink">Digital Sukoon</div>
            <div className="text-[10.5px] text-ink-3">Client</div>
          </div>
        )}
      </div>

      {/* nav */}
      <nav className="flex-1 px-2 py-3 space-y-0.5">
        {NAV.map((n) => {
          const isActive = pathname?.startsWith(n.href) ?? false;
          const NavIcon = n.Icon;
          const badgeCount = n.badge === "pending" && pendingResolved ? pending : 0;
          return (
            <Link
              key={n.id}
              href={n.href}
              title={collapsed ? n.label : undefined}
              className={`relative w-full flex items-center ${collapsed ? "justify-center" : "gap-3"} px-2.5 h-9 rounded-md text-[13.5px] font-medium transition-colors ${isActive ? "bg-ink text-bg" : "text-ink-2 hover:bg-muted/60 hover:text-ink"}`}
            >
              <NavIcon size={20} sw={isActive ? 2 : 1.5} />
              {!collapsed && (
                <>
                  <span className="flex-1 text-left">{n.label}</span>
                  {badgeCount > 0 && (
                    <span className={`h-5 min-w-[20px] px-1.5 rounded-full text-[10.5px] font-semibold grid place-items-center ${isActive ? "bg-action text-ink" : "bg-attention text-bg"}`}>
                      {badgeCount}
                    </span>
                  )}
                </>
              )}
              {collapsed && badgeCount > 0 && (
                <span className="absolute h-1.5 w-1.5 rounded-full bg-attention top-1.5 right-1.5" />
              )}
            </Link>
          );
        })}
      </nav>

      {/* collapse toggle + user */}
      <div className="border-t border-rule px-2 py-2 space-y-0.5">
        <button
          onClick={() => setCollapsed((v) => !v)}
          className={`w-full flex items-center ${collapsed ? "justify-center" : "gap-2"} px-2.5 h-8 rounded-md text-[12px] text-ink-3 hover:bg-muted/60 hover:text-ink transition-colors`}
          title={collapsed ? "Expand" : "Collapse"}
        >
          {collapsed ? <Icon.ChevRight size={16}/> : <><Icon.ChevLeft size={16}/><span>Collapse</span></>}
        </button>
        {user ? (
          <button
            onClick={logout}
            className={`w-full flex items-center ${collapsed ? "justify-center" : "gap-2.5"} px-1.5 h-10 rounded-md hover:bg-muted/60 transition-colors text-left`}
            title="Log out"
          >
            <Avatar initial={initial} size="sm" />
            {!collapsed && (
              <div className="flex-1 min-w-0 leading-tight">
                <div className="text-[12.5px] font-medium text-ink truncate">{displayName}</div>
                <div className="text-[10.5px] text-ink-3 truncate">{displayCompany}</div>
              </div>
            )}
            {!collapsed && <Icon.Logout size={14} className="text-ink-3" />}
          </button>
        ) : (
          <div className={`w-full flex items-center ${collapsed ? "justify-center" : "gap-2.5"} px-1.5 h-10`}>
            <div className="h-7 w-7 rounded-full bg-muted animate-pulse shrink-0" />
            {!collapsed && (
              <div className="flex-1 min-w-0 space-y-1">
                <div className="h-3 w-24 bg-muted rounded animate-pulse" />
                <div className="h-2.5 w-16 bg-muted rounded animate-pulse" />
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
