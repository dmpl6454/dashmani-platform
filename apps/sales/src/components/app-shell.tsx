"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogOut, Menu, X } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { PortalSwitcher } from "./portal-switcher";
import { CompanySwitcher } from "./company-switcher";
import { COMPANY_LOGO, useCompany } from "@/lib/company";

// The signed-in frame: brand, the billing company, the ten sections, the portal switcher and sign-out. Nav wraps rather than scrolls so
// nothing overflows at 390px.
const NAV = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/inventory", label: "Inventory" },
  { href: "/clients", label: "Clients" },
  { href: "/quotes", label: "Quotes" },
  { href: "/orders", label: "Orders" },
  { href: "/bookings", label: "Bookings" },
  { href: "/invoices", label: "Invoices" },
  { href: "/recurring", label: "Recurring" },
  { href: "/payments", label: "Payments" },
  { href: "/pipeline", label: "Pipeline" },
  { href: "/creators", label: "Creators" },
  { href: "/settings", label: "Settings" },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()?.replace(/\/+$/, "") || "/";
  const { user, logout } = useAuth();
  const { info } = useCompany();
  // The Pipeline (board + thread) scrolls inside its own panes, like the HR portal's fitViewport
  // shell: the frame is exactly the visible height, with no footer and no page padding.
  const fit = pathname === "/pipeline" || pathname.startsWith("/pipeline/");
  // On the Pipeline, below lg the nav (which wraps to several rows) and the billing-company
  // switcher (irrelevant there) fold behind a Menu button, so the board gets the screen.
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => setMenuOpen(false), [pathname]);
  const folded = fit && !menuOpen;
  return (
    <div
      className={fit ? "flex flex-col overflow-hidden" : "min-h-screen flex flex-col"}
      style={fit ? { height: "var(--pl-vh, 100dvh)" } : undefined}
    >
      <header className="border-b-2 border-border">
        <div
          className={`mx-auto max-w-7xl px-4 sm:px-6 flex items-center ${
            folded ? "flex-nowrap gap-x-3 py-2 lg:flex-wrap lg:gap-x-6 lg:gap-y-3 lg:py-3" : "flex-wrap gap-x-6 gap-y-3 py-3"
          }`}
        >
          <Link href="/dashboard" className="flex items-center gap-2.5 font-extrabold tracking-tight text-[17px] whitespace-nowrap min-w-0">
            <img src={COMPANY_LOGO[info.key]} alt="" className="w-8 h-8 shrink-0" />
            <span className="truncate">{info.short} <span className="text-indigo-light">Sales</span></span>
          </Link>
          <div className={folded ? "hidden lg:block" : undefined}>
            <CompanySwitcher />
          </div>
          <nav
            id="sales-nav"
            aria-label="Sales portal"
            className={`order-3 w-full lg:order-none lg:w-auto flex-wrap gap-1 ${folded ? "hidden lg:flex" : "flex"}`}
          >
            {NAV.map((n) => {
              const active = pathname === n.href || pathname.startsWith(`${n.href}/`);
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  aria-current={active ? "page" : undefined}
                  className={`px-3 py-2 text-[13px] uppercase tracking-[0.08em] border-2 ${active ? "bg-indigo border-indigo text-white font-bold" : "border-transparent text-ink-3 hover:text-white hover:border-border"}`}
                >
                  {n.label}
                </Link>
              );
            })}
          </nav>
          <div className={`ml-auto flex items-center min-w-0 ${folded ? "gap-2 shrink-0 lg:gap-3" : "gap-3"}`}>
            <div className="hidden md:flex flex-col items-end min-w-0">
              <span className="text-sm font-bold truncate max-w-[220px]">{user?.name}</span>
              <span className="text-[11px] uppercase tracking-[0.1em] text-ink-3">{user?.roles?.join(" · ")}</span>
            </div>
            {fit && (
              <button
                type="button"
                onClick={() => setMenuOpen((o) => !o)}
                aria-expanded={menuOpen}
                aria-controls="sales-nav"
                aria-label={menuOpen ? "Close menu" : "Menu"}
                className="btn btn-ghost btn-sm lg:hidden"
              >
                {menuOpen ? <X size={14} aria-hidden /> : <Menu size={14} aria-hidden />} <span className="hidden sm:inline">Menu</span>
              </button>
            )}
            <PortalSwitcher />
            <button type="button" onClick={logout} className="btn btn-ghost btn-sm" aria-label="Sign out">
              <LogOut size={14} aria-hidden /> <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </div>
      </header>
      <p className="sr-only" aria-live="polite">Billing as {info.name}</p>
      {fit ? (
        <main className="flex-1 w-full min-w-0 min-h-0 flex flex-col overflow-hidden">{children}</main>
      ) : (
        <main className="flex-1 w-full mx-auto max-w-7xl px-4 sm:px-6 py-8 sm:py-10 min-w-0">{children}</main>
      )}
      {!fit && <footer className="border-t-2 border-border">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 py-5 text-[13px] text-ink-3">© {new Date().getFullYear()} Digital Sukoon · internal</div>
      </footer>}
    </div>
  );
}
