"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Menu, X as CloseIcon } from "lucide-react";
import { Icon } from "./portal-icons";
import { Avatar } from "./portal-shared";
import { useClientPendingApprovals } from "@/lib/hooks/use-content";
import { useAuth } from "@/lib/auth";

// The site's rail: numbered "channels", a 2px divider under each, the current
// one solid accent. Same seven destinations the portal always had.
const NAV = [
  { id: "dashboard", href: "/dashboard", label: "Home",      Icon: Icon.Dashboard,  key: "g d" },
  { id: "campaigns", href: "/campaigns", label: "Campaigns", Icon: Icon.Megaphone,  key: "g m" },
  { id: "projects",  href: "/projects",  label: "Projects",  Icon: Icon.Folder,     key: "g p" },
  { id: "content",   href: "/content",   label: "Content",   Icon: Icon.Edit,       key: "g c" },
  { id: "approvals", href: "/approvals", label: "Approvals", Icon: Icon.CheckBadge, key: "g a", badge: "pending" as const },
  { id: "analytics", href: "/analytics", label: "Analytics", Icon: Icon.Chart,      key: "g n" },
  { id: "files",     href: "/files",     label: "Files",     Icon: Icon.File,       key: "g f" },
];

const pad2 = (n: number) => String(n).padStart(2, "0");

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
        const map: Record<string, string> = { d: "/dashboard", m: "/campaigns", p: "/projects", c: "/content", a: "/approvals", n: "/analytics", f: "/files" };
        if (map[e.key]) { e.preventDefault(); router.push(map[e.key]); primed = false; if (timer) clearTimeout(timer); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  const initial = (user?.name?.charAt(0) ?? "?").toUpperCase();
  const displayName = user?.name ?? "";
  const displayCompany = user?.companyName ?? "";

  const Brand = ({ small = false }: { small?: boolean }) => (
    <span className="flex items-center gap-2.5 min-w-0">
      <img src="/logo-mark.svg" alt="" className={`${small ? "h-7 w-7" : "h-8 w-8"} shrink-0`} />
      <span className="text-[17px] font-extrabold tracking-[-0.02em] text-ink whitespace-nowrap">Digital Sukoon</span>
    </span>
  );

  const RailContent = ({ onClose }: { onClose?: () => void }) => {
    const narrow = collapsed && !onClose;
    return (
      <>
        {/* Brand */}
        <div className={`flex items-center h-16 shrink-0 border-b-2 border-border ${narrow ? "justify-center px-0" : "gap-3 px-5"}`}>
          {narrow ? <img src="/logo-mark.svg" alt="Digital Sukoon" className="h-8 w-8" /> : <Brand />}
          {onClose && (
            <button onClick={onClose} className="ml-auto p-1 text-ink-3 hover:text-ink" aria-label="Close menu">
              <CloseIcon size={18} />
            </button>
          )}
        </div>
        {!narrow && (
          <div className="px-5 py-3 border-b-2 border-border kicker">Client portal</div>
        )}

        {/* Channels */}
        <nav className="flex-1 overflow-y-auto" aria-label="Portal sections">
          {NAV.map((n, i) => {
            const isActive = pathname?.startsWith(n.href) ?? false;
            const NavIcon = n.Icon;
            const badgeCount = n.badge === "pending" && pendingResolved ? pending : 0;
            return (
              <Link
                key={n.id}
                href={n.href}
                aria-current={isActive ? "page" : undefined}
                title={narrow ? n.label : undefined}
                className={`relative flex border-b-2 border-border transition-colors duration-200
                  ${narrow ? "h-14 items-center justify-center" : "min-h-[56px] flex-col justify-center gap-0.5 px-5 py-2.5"}
                  ${isActive ? "bg-indigo text-white" : "text-ink hover:bg-surface"}`}
              >
                {narrow ? (
                  <NavIcon size={18} sw={isActive ? 2.4 : 1.8} />
                ) : (
                  <>
                    <span className={`text-[11px] tracking-[0.12em] tabular-nums ${isActive ? "text-white" : "text-indigo-light"}`}>
                      CH {pad2(i + 1)}
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="text-[16px] font-bold tracking-[-0.02em] leading-tight">{n.label}</span>
                      {badgeCount > 0 && (
                        <span className={`ml-auto h-5 min-w-[20px] px-1.5 text-[10px] font-extrabold grid place-items-center tabular-nums
                          ${isActive ? "bg-white text-indigo" : "bg-attention-bg text-attention"}`}>
                          {badgeCount}
                        </span>
                      )}
                    </span>
                  </>
                )}
                {narrow && badgeCount > 0 && (
                  <span className="absolute top-2 right-2 h-2 w-2 rounded-full bg-attention dot-pulse" />
                )}
              </Link>
            );
          })}
        </nav>

        {/* Footer: collapse toggle + user */}
        <div className="shrink-0 border-t-2 border-border">
          {!onClose && (
            <button
              onClick={() => setCollapsed((v) => !v)}
              title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              className={`w-full flex items-center h-10 text-[11px] tracking-[0.1em] uppercase text-ink-4 hover:text-ink hover:bg-surface transition-colors border-b-2 border-border
                ${collapsed ? "justify-center px-0" : "gap-2 px-5"}`}
            >
              {collapsed
                ? <Icon.ChevRight size={16} />
                : <><Icon.ChevLeft size={14} /><span>Collapse</span></>
              }
            </button>
          )}
          {user ? (
            <button
              onClick={logout}
              title="Log out"
              className={`w-full flex items-center h-14 hover:bg-surface transition-colors text-left ${narrow ? "justify-center px-0" : "gap-3 px-4"}`}
            >
              <Avatar initial={initial} size="sm" />
              {!narrow && (
                <div className="flex-1 min-w-0 leading-tight">
                  <div className="text-[13px] font-bold text-ink truncate">{displayName}</div>
                  <div className="text-[11px] text-ink-3 truncate">{displayCompany} · Log out</div>
                </div>
              )}
            </button>
          ) : (
            <div className={`w-full flex items-center h-14 ${narrow ? "justify-center px-0" : "gap-3 px-4"}`}>
              <div className="h-7 w-7 bg-muted animate-pulse shrink-0" />
              {!narrow && (
                <div className="flex-1 min-w-0 space-y-1.5">
                  <div className="h-3 w-24 bg-muted animate-pulse" />
                  <div className="h-2.5 w-16 bg-muted animate-pulse" />
                </div>
              )}
            </div>
          )}
        </div>
      </>
    );
  };

  return (
    <>
      {/* Mobile top bar (below lg) */}
      <div className="lg:hidden fixed top-0 left-0 right-0 z-40 flex items-center gap-3 px-4 h-14 bg-bg border-b-2 border-border">
        <button onClick={() => setMobileOpen(true)} className="p-1 text-ink-3 hover:text-ink" aria-label="Open menu">
          <Menu size={22} />
        </button>
        <Brand small />
        {pending > 0 && (
          <span className="ml-auto h-5 min-w-[20px] px-1.5 text-[10px] font-extrabold grid place-items-center bg-attention-bg text-attention tabular-nums">
            {pending}
          </span>
        )}
      </div>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-50 flex">
          <div className="absolute inset-0 bg-black/70" onClick={() => setMobileOpen(false)} />
          <aside className="relative z-10 w-[270px] flex flex-col bg-bg h-full overflow-y-auto border-r-2 border-border">
            <RailContent onClose={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}

      {/* Desktop rail (lg and above) */}
      <aside
        className={`${collapsed ? "w-railc" : "w-rail"} hidden lg:flex shrink-0 flex-col bg-bg border-r-2 border-border transition-[width] duration-200 sticky top-0 h-screen`}
      >
        <RailContent />
      </aside>
    </>
  );
}
