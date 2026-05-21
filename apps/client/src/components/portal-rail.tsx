"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Menu, X as CloseIcon } from "lucide-react";
import { Icon } from "./portal-icons";
import { Avatar } from "./portal-shared";
import { useClientPendingApprovals } from "@/lib/hooks/use-content";
import { useAuth } from "@/lib/auth";

const NAV = [
  { id: "dashboard", href: "/dashboard", label: "Home",      Icon: Icon.Dashboard,  key: "g d" },
  { id: "projects",  href: "/projects",  label: "Projects",  Icon: Icon.Folder,     key: "g p" },
  { id: "content",   href: "/content",   label: "Content",   Icon: Icon.Edit,       key: "g c" },
  { id: "approvals", href: "/approvals", label: "Approvals", Icon: Icon.CheckBadge, key: "g a", badge: "pending" as const },
  { id: "analytics", href: "/analytics", label: "Analytics", Icon: Icon.Chart,      key: "g n" },
  { id: "files",     href: "/files",     label: "Files",     Icon: Icon.File,       key: "g f" },
];

export function PortalRail() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout } = useAuth();
  const [collapsed, setCollapsed] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const { data: pendingApprovals } = useClientPendingApprovals();
  const pending = pendingApprovals?.length ?? 0;
  const pendingResolved = pendingApprovals !== undefined;

  useEffect(() => {
    setCollapsed(localStorage.getItem("ds.railCollapsed") === "1");
    setMounted(true);
  }, []);

  useEffect(() => { setMobileOpen(false); }, [pathname]);
  useEffect(() => {
    if (mounted) localStorage.setItem("ds.railCollapsed", collapsed ? "1" : "0");
  }, [collapsed, mounted]);

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

  const initial = (user?.name?.charAt(0) ?? "?").toUpperCase();
  const displayName = user?.name ?? "";
  const displayCompany = user?.companyName ?? "";

  const RailContent = ({ onClose }: { onClose?: () => void }) => (
    <>
      {/* Logo */}
      <div
        className={`flex items-center ${collapsed && !onClose ? "justify-center px-0" : "gap-3 px-4"} h-16 shrink-0`}
        style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}
      >
        <div className="h-8 w-8 rounded-xl bg-ink text-white grid place-items-center text-[11px] font-black tracking-widest shrink-0">
          DS
        </div>
        {(!collapsed || onClose) && (
          <div className="flex-1 min-w-0 leading-tight">
            <div className="text-[13.5px] font-bold text-ink">Digital Sukoon</div>
            <div className="text-[11px] text-ink-3 font-medium">Client Portal</div>
          </div>
        )}
        {onClose && (
          <button onClick={onClose} className="ml-auto p-1 text-ink-3 hover:text-ink">
            <CloseIcon size={18} />
          </button>
        )}
      </div>

      {/* Nav items */}
      <nav className="flex-1 px-2 py-4 space-y-0.5 overflow-y-auto">
        {NAV.map((n, i) => {
          const isActive = pathname?.startsWith(n.href) ?? false;
          const NavIcon = n.Icon;
          const badgeCount = n.badge === "pending" && pendingResolved ? pending : 0;
          return (
            <Link
              key={n.id}
              href={n.href}
              title={collapsed && !onClose ? n.label : undefined}
              className={`fade-up d${i + 1} w-full flex items-center ${collapsed && !onClose ? "justify-center px-0" : "gap-3 px-3"} h-11 rounded-xl text-[13.5px] transition-all duration-150 relative
                ${isActive ? "nav-active" : "text-ink-3 font-medium hover:bg-muted/80 hover:text-ink"}`}
            >
              <NavIcon size={18} sw={isActive ? 2.4 : 1.8} />
              {(!collapsed || onClose) && (
                <span className="flex-1 flex items-center gap-2">
                  <span className="flex-1 text-left">{n.label}</span>
                  {badgeCount > 0 && (
                    <span className={`h-5 min-w-[20px] px-1.5 rounded-full text-[10px] font-bold grid place-items-center tabular-nums
                      ${isActive ? "bg-indigo/20 text-indigo" : "bg-attention-bg text-attention"}`}>
                      {badgeCount}
                    </span>
                  )}
                </span>
              )}
              {collapsed && !onClose && badgeCount > 0 && (
                <span className="absolute top-2 right-2 h-2 w-2 rounded-full bg-attention dot-pulse" />
              )}
            </Link>
          );
        })}
      </nav>

      {/* Footer: collapse toggle + user */}
      <div className="px-2 py-3 space-y-0.5 shrink-0" style={{ borderTop: "2px solid rgba(26,26,26,0.07)" }}>
        {!onClose && (
          <button
            onClick={() => setCollapsed((v) => !v)}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className={`w-full flex items-center ${collapsed ? "justify-center px-0" : "gap-2 px-3"} h-9 rounded-xl text-[12px] font-medium text-ink-3 hover:bg-muted/80 hover:text-ink transition-colors`}
          >
            {collapsed
              ? <Icon.ChevRight size={16} />
              : <><Icon.ChevLeft size={16} /><span>Collapse</span></>
            }
          </button>
        )}
        {user ? (
          <button
            onClick={logout}
            title="Log out"
            className={`w-full flex items-center ${collapsed && !onClose ? "justify-center px-0" : "gap-3 px-2"} h-12 rounded-xl hover:bg-muted/70 transition-colors text-left`}
          >
            <Avatar initial={initial} size="sm" />
            {(!collapsed || onClose) && (
              <div className="flex-1 min-w-0 leading-tight">
                <div className="text-[13px] font-bold text-ink truncate">{displayName}</div>
                <div className="text-[11px] text-ink-3 font-medium truncate">{displayCompany}</div>
              </div>
            )}
          </button>
        ) : (
          <div className={`w-full flex items-center ${collapsed && !onClose ? "justify-center px-0" : "gap-3 px-2"} h-12`}>
            <div className="h-7 w-7 rounded-full bg-muted animate-pulse shrink-0" />
            {(!collapsed || onClose) && (
              <div className="flex-1 min-w-0 space-y-1.5">
                <div className="h-3 w-24 bg-muted rounded-full animate-pulse" />
                <div className="h-2.5 w-16 bg-muted rounded-full animate-pulse" />
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );

  return (
    <>
      {/* Mobile top bar (below lg) */}
      <div className="lg:hidden fixed top-0 left-0 right-0 z-40 flex items-center gap-3 px-4 h-14 bg-surface" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
        <button onClick={() => setMobileOpen(true)} className="p-1 text-ink-3 hover:text-ink" aria-label="Open menu">
          <Menu size={22} />
        </button>
        <div className="h-7 w-7 rounded-xl bg-ink text-white grid place-items-center text-[10px] font-black tracking-widest">
          DS
        </div>
        <span className="text-[13px] font-bold text-ink">Digital Sukoon</span>
        {pending > 0 && (
          <span className="ml-auto h-5 min-w-[20px] px-1.5 rounded-full text-[10px] font-bold grid place-items-center bg-attention-bg text-attention tabular-nums">
            {pending}
          </span>
        )}
      </div>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-50 flex">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
          <aside className="relative z-10 w-[260px] flex flex-col bg-surface h-full overflow-y-auto" style={{ borderRight: "2px solid rgba(26,26,26,0.09)" }}>
            <RailContent onClose={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}

      {/* Desktop rail (lg and above) */}
      <aside
        className={`${collapsed ? "w-railc" : "w-rail"} hidden lg:flex shrink-0 flex-col bg-surface transition-[width] duration-200`}
        style={{ borderRight: "2px solid rgba(26,26,26,0.09)" }}
      >
        <RailContent />
      </aside>
    </>
  );
}
