"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogOut, Menu, X } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { PortalSwitcher } from "./portal-switcher";
import { CompanySwitcher } from "./company-switcher";
import { COMPANY_LOGO, useCompany } from "@/lib/company";

// The signed-in frame: brand, the billing company, the sections, the portal switcher and sign-out.
// The sixteen sections are grouped by what the person is doing (sell → bill → finance → more).
// From `lg` up the groups sit on one row under the brand; below `lg` they fold behind a Menu
// button on EVERY page (before 2026-11-06 only the Pipeline folded, and the open list took
// 415 of a phone's 812 px on every page).
type NavItem = { href: string; label: string };
type NavGroup = { label: string; items: NavItem[] };
const NAV_GROUPS: NavGroup[] = [
  {
    label: "Sell",
    items: [
      { href: "/dashboard", label: "Dashboard" },
      { href: "/inventory", label: "Inventory" },
      { href: "/clients", label: "Clients" },
      { href: "/quotes", label: "Quotes" },
      { href: "/orders", label: "Orders" },
      { href: "/bookings", label: "Bookings" },
    ],
  },
  {
    label: "Bill",
    items: [
      { href: "/invoices", label: "Invoices" },
      { href: "/recurring", label: "Recurring" },
      { href: "/payments", label: "Payments" },
    ],
  },
  {
    label: "Finance",
    items: [
      // smart-invoicing: bank (PR 4)
      { href: "/bank", label: "Bank" },
      // smart-invoicing: accounts (PR 1)
      { href: "/accounts", label: "Accounts" },
      // smart-invoicing: reconcile (PR 5)
      { href: "/reconcile", label: "Reconcile" },
      // smart-invoicing: tally (PR 2)
      { href: "/tally", label: "Tally" },
    ],
  },
  {
    label: "More",
    items: [
      { href: "/pipeline", label: "Pipeline" },
      { href: "/creators", label: "Creators" },
      { href: "/settings", label: "Settings" },
    ],
  },
];
const NAV = NAV_GROUPS.flatMap((g) => g.items);
const NAV_ROWS: NavGroup[][] = [NAV_GROUPS.slice(0, 2), NAV_GROUPS.slice(2)];

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()?.replace(/\/+$/, "") || "/";
  const { user, logout } = useAuth();
  const { info } = useCompany();
  // The Pipeline (board + thread) scrolls inside its own panes, like the HR portal's fitViewport
  // shell: the frame is exactly the visible height, with no footer and no page padding.
  const fit = pathname === "/pipeline" || pathname.startsWith("/pipeline/");
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => setMenuOpen(false), [pathname]);
  const current = NAV.find((n) => isActive(pathname, n.href));
  return (
    <div
      className={fit ? "flex flex-col overflow-hidden" : "min-h-screen flex flex-col"}
      style={fit ? { height: "var(--pl-vh, 100dvh)" } : undefined}
    >
      <header className="border-b-2 border-border">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 flex items-center flex-nowrap gap-x-3 py-2 lg:gap-x-6 lg:py-3">
          <Link href="/dashboard" className="flex items-center gap-2 sm:gap-2.5 font-extrabold tracking-tight text-[15px] sm:text-[17px] whitespace-nowrap min-w-0">
            <img src={COMPANY_LOGO[info.key]} alt="" className="w-7 h-7 sm:w-8 sm:h-8 shrink-0" />
            {/* Phones: company over a small "Sales" label, so a long company name never cuts off. */}
            <span className="min-w-0 flex flex-col leading-[1.1] sm:block sm:leading-normal sm:truncate">
              <span className="truncate">{info.short}</span>{" "}
              <span className="text-indigo-light text-[10.5px] uppercase tracking-[0.14em] sm:text-[17px] sm:normal-case sm:tracking-normal">Sales</span>
            </span>
          </Link>
          {/* The billing company: in the top row from md up; inside the menu on phones (it is irrelevant on the Pipeline). */}
          <div className="hidden md:block">
            <CompanySwitcher />
          </div>
          <div className="ml-auto flex items-center min-w-0 gap-2 shrink-0 lg:gap-3">
            <div className="hidden md:flex flex-col items-end min-w-0">
              <span className="text-sm font-bold truncate max-w-[220px]">{user?.name}</span>
              <span className="text-[11px] uppercase tracking-[0.1em] text-ink-3">{user?.roles?.join(" · ")}</span>
            </div>
            <button
              type="button"
              onClick={() => setMenuOpen((o) => !o)}
              aria-expanded={menuOpen}
              aria-controls="sales-nav"
              aria-label={menuOpen ? "Close menu" : "Menu"}
              className="btn btn-ghost btn-sm lg:hidden"
            >
              {menuOpen ? <X size={14} aria-hidden /> : <Menu size={14} aria-hidden />}{" "}
              <span className="hidden sm:inline">{menuOpen ? "Close" : current?.label ?? "Menu"}</span>
            </button>
            <PortalSwitcher />
            <button type="button" onClick={logout} className="btn btn-ghost btn-sm" aria-label="Sign out">
              <LogOut size={14} aria-hidden /> <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </div>
        {/* Desktop: one row of grouped links. Phone: the same groups as a sheet behind Menu. */}
        <nav
          id="sales-nav"
          aria-label="Sales portal"
          className={`mx-auto max-w-7xl px-4 sm:px-6 ${menuOpen ? "block" : "hidden"} lg:block pb-3 lg:pb-0`}
        >
          <div className="md:hidden pt-1 pb-3 lg:hidden"><CompanySwitcher /></div>
          {/* Two rows from lg up (Sell + Bill, then Finance + More): sixteen links never fit one 1280 px row,
              so the break is chosen here rather than left to wrapping. On phones every group stacks. */}
          <div className="flex flex-col gap-3 lg:gap-0 lg:border-t lg:border-border lg:py-1.5">
            {NAV_ROWS.map((row, r) => (
              <div key={r} className="flex flex-col gap-3 lg:flex-row lg:items-center lg:gap-x-6 lg:gap-y-1 lg:flex-wrap">
                {row.map((g) => (
                  <div key={g.label} className="flex flex-col gap-1 lg:flex-row lg:items-center lg:gap-1.5">
                    <span className="text-[10px] uppercase tracking-[0.14em] text-ink-3 font-bold lg:w-14">{g.label}</span>
                    <div className="flex flex-wrap gap-1">
                      {g.items.map((n) => {
                        const active = isActive(pathname, n.href);
                        return (
                          <Link
                            key={n.href}
                            href={n.href}
                            aria-current={active ? "page" : undefined}
                            className={`px-2.5 py-1.5 text-[12px] uppercase tracking-[0.06em] border-2 ${active ? "bg-indigo border-indigo text-white font-bold" : "border-transparent text-ink-3 hover:text-white hover:border-border"}`}
                          >
                            {n.label}
                          </Link>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </nav>
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
