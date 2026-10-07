"use client";
// Premium dark sidebar ("ds" redesign). Same nav items, routes, badge source and
// persisted collapse/More state as the classic Sidebar — only the look differs.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect } from "react";
import { cn } from "@dashmani/ui";
import { ChevronLeft, ChevronRight, LayoutGrid, Menu, X as CloseIcon } from "lucide-react";
import { useOverviewStats } from "@/lib/hooks/use-analytics";
import { primaryNav, moreNav } from "@/components/sidebar";

export function DsSidebar() {
  const pathname = usePathname();
  const { data } = useOverviewStats();
  const stats = (data as any)?.data;
  const [collapsed, setCollapsed] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  // Same storage keys as the classic sidebar, so the choice carries across both shells.
  useEffect(() => {
    try {
      const saved = localStorage.getItem("int-rail-collapsed");
      if (saved !== null) setCollapsed(saved === "true");
      const savedMore = localStorage.getItem("int-more-open");
      if (savedMore !== null) setMoreOpen(savedMore === "1");
    } catch {}
  }, []);

  useEffect(() => { setMobileOpen(false); }, [pathname]);

  function toggleCollapsed() {
    setCollapsed((v) => {
      try { localStorage.setItem("int-rail-collapsed", String(!v)); } catch {}
      return !v;
    });
  }
  function toggleMore() {
    setMoreOpen((v) => {
      try { localStorage.setItem("int-more-open", v ? "0" : "1"); } catch {}
      return !v;
    });
  }

  const isActive = (href: string) => pathname === href || (href !== "/" && pathname.startsWith(href + "/"));
  // "/accounts" must not light up while "/accounts/growth" (its own row) is open,
  // nor "/reports" while "/reports/link-search" is.
  const activeHref = (() => {
    const all = [...primaryNav.map((n) => n.href), ...moreNav.map((n) => n.href)];
    return all.filter(isActive).sort((a, b) => b.length - a.length)[0] ?? null;
  })();
  const isMoreActive = moreNav.some((n) => n.href === activeHref);

  // A render function, NOT an inner component: <Body/> would be a new component type
  // on every render, remounting the nav (and losing its scroll position) on each click.
  const renderBody = (mobile?: boolean) => {
    const expanded = !collapsed || !!mobile;
    let prevGroup: string | null = null;
    return (
      <aside
        className={cn(
          "flex flex-col h-[100dvh] bg-ds-rail border-r border-ds-line overflow-hidden shrink-0 transition-[width] duration-200 ease-out",
          mobile ? "w-[280px]" : expanded ? "w-[220px]" : "w-[64px]",
        )}
      >
        {/* Brand */}
        <div className={cn("h-16 flex items-center gap-2.5 border-b border-ds-line shrink-0", expanded ? "px-4" : "justify-center")}>
          <img src="/logo-ds.svg" alt="Digital Sukoon" className="h-9 w-9 rounded-full shrink-0 ring-1 ring-ds-gold/30" />
          {expanded && (
            <div className="min-w-0">
              <p className="text-[11.5px] font-bold tracking-[.12em] uppercase leading-tight text-ds-text truncate">Digital Sukoon</p>
              <p className="text-[10px] text-ds-t3 leading-snug truncate">Management Portal</p>
            </div>
          )}
        </div>

        {/* Overview — the separate command-centre plane, styled apart from the nav rows */}
        <div className="px-2 pt-3">
          <Link
            href="/overview"
            title="Overview — company command centre"
            className={cn(
              "flex items-center h-10 rounded-[6px] border border-ds-gold/30 bg-ds-gold/[.06] text-ds-text text-[12.5px] font-semibold transition-colors hover:bg-ds-gold/[.12] hover:border-ds-gold/50",
              expanded ? "gap-3 px-[13px]" : "justify-center",
            )}
          >
            <LayoutGrid className="h-[18px] w-[18px] shrink-0 text-ds-gold" strokeWidth={1.8} />
            {expanded && <span className="flex-1 truncate">Overview</span>}
          </Link>
        </div>

        <nav className="flex-1 min-h-0 overflow-y-auto px-2 pt-2 pb-3">
          {primaryNav.map((item) => {
            const active = item.href === activeHref;
            const showGroup = expanded && item.group && item.group !== prevGroup;
            if (item.group) prevGroup = item.group;
            const badge = item.badgeKey && stats ? (stats[item.badgeKey] ?? 0) : 0;
            const Icon = item.icon;
            return (
              <div key={item.href}>
                {showGroup && (
                  <p className="px-[13px] pt-3.5 pb-1.5 text-[10px] font-semibold tracking-[.12em] uppercase text-ds-t4">{item.group}</p>
                )}
                <Link
                  href={item.href}
                  title={!expanded ? item.label : undefined}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "group relative flex items-center h-[38px] mb-0.5 rounded-[6px] border text-[12.5px] whitespace-nowrap transition-colors",
                    expanded ? "gap-3 px-[13px]" : "justify-center",
                    active
                      ? "border-ds-gold/55 bg-ds-gold/[.14] text-ds-text font-semibold"
                      : "border-transparent text-ds-t2 font-medium hover:bg-ds-gold/[.08] hover:text-ds-text",
                  )}
                >
                  {active && <span className="absolute -left-px top-2 bottom-2 w-0.5 rounded-[4px] bg-ds-gold" />}
                  <Icon className={cn("h-[18px] w-[18px] shrink-0", active && "text-ds-gold")} strokeWidth={active ? 2.2 : 1.8} />
                  {expanded && <span className="flex-1 truncate">{item.label}</span>}
                  {expanded && badge > 0 && (
                    <span className="h-[18px] min-w-[20px] px-1.5 rounded-full bg-ds-red/15 text-ds-redsoft text-[10px] font-bold grid place-items-center">{badge}</span>
                  )}
                  {!expanded && badge > 0 && <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-ds-red" />}
                  {!expanded && (
                    <span className="pointer-events-none absolute left-full ml-3 top-1/2 -translate-y-1/2 z-50 opacity-0 group-hover:opacity-100 transition-opacity px-2.5 py-1 rounded-[6px] bg-ds-inset border border-ds-line2 text-ds-text text-xs font-medium whitespace-nowrap shadow-lg">
                      {item.label}
                    </span>
                  )}
                </Link>
              </div>
            );
          })}

          <div className="h-px bg-ds-line mx-[13px] my-2.5" />

          {/* More */}
          <button
            onClick={expanded ? toggleMore : () => setMoreOpen((v) => !v)}
            title="More"
            aria-expanded={moreOpen}
            className={cn(
              "w-full flex items-center h-[38px] rounded-[6px] border text-[12.5px] font-medium transition-colors",
              expanded ? "gap-3 px-[13px]" : "justify-center",
              isMoreActive ? "border-ds-gold/55 bg-ds-gold/[.14] text-ds-text" : "border-transparent text-ds-t2 hover:bg-ds-gold/[.08] hover:text-ds-text",
            )}
          >
            <LayoutGrid className="h-[18px] w-[18px] shrink-0" strokeWidth={1.8} />
            {expanded && (
              <>
                <span className="flex-1 text-left">More</span>
                <span className="text-[10px] text-ds-t3">{moreNav.length}</span>
                <ChevronRight className={cn("h-3.5 w-3.5 text-ds-t3 transition-transform", moreOpen && "rotate-90")} />
              </>
            )}
          </button>

          {expanded && moreOpen && (
            <div className="mt-1 mx-0.5 rounded-[6px] border border-ds-line bg-ds-card p-1.5 grid grid-cols-3 gap-1">
              {moreNav.map((item) => {
                const active = item.href === activeHref;
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex flex-col items-center gap-1.5 px-1 py-2.5 rounded-[6px] text-center transition-colors",
                      active ? "bg-ds-gold/[.14] text-ds-gold" : "text-ds-t2 hover:bg-ds-hover hover:text-ds-text",
                    )}
                  >
                    <Icon className="h-4 w-4" strokeWidth={1.8} />
                    <span className="text-[9.5px] font-semibold leading-tight line-clamp-2">{item.label}</span>
                  </Link>
                );
              })}
            </div>
          )}
        </nav>

        {!mobile && (
          <div className="shrink-0 border-t border-ds-line p-2">
            <button
              onClick={toggleCollapsed}
              title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              className="w-full h-8 flex items-center justify-center gap-2 rounded-[6px] border border-ds-line bg-ds-card text-ds-t3 text-[11px] transition-colors hover:text-ds-gold hover:border-ds-line4"
            >
              {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <><ChevronLeft className="h-3.5 w-3.5" /><span>Collapse</span></>}
            </button>
          </div>
        )}
      </aside>
    );
  };

  return (
    <>
      {/* Phone top bar */}
      <div className="lg:hidden fixed top-0 inset-x-0 z-40 h-14 flex items-center gap-3 px-4 border-b border-ds-line bg-ds-rail/95 backdrop-blur-md">
        <button onClick={() => setMobileOpen(true)} className="p-1 text-ds-t2 hover:text-ds-text" aria-label="Open menu">
          <Menu className="h-5 w-5" />
        </button>
        <img src="/logo-ds.svg" alt="" className="h-7 w-7 rounded-full" />
        <span className="text-[11px] font-bold tracking-[.12em] uppercase text-ds-text">Digital Sukoon</span>
      </div>

      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-50 flex">
          <div className="absolute inset-0 bg-black/60" onClick={() => setMobileOpen(false)} />
          <div className="relative z-10 h-full">
            <button
              onClick={() => setMobileOpen(false)}
              aria-label="Close menu"
              className="absolute top-4 right-3 z-10 p-1.5 rounded-[6px] bg-ds-card border border-ds-line text-ds-t2 hover:text-ds-text"
            >
              <CloseIcon className="h-4 w-4" />
            </button>
            {renderBody(true)}
          </div>
        </div>
      )}

      <div className="hidden lg:block h-[100dvh] shrink-0">
        {renderBody()}
      </div>
    </>
  );
}
