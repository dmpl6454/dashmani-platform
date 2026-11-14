"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowUpRight, LogOut, Menu, X } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { PortalSwitcher } from "./portal-switcher";
import { CompanySwitcher } from "./company-switcher";
import { PortalLink } from "./portal-link";
import { COMPANY_LOGO, useCompany } from "@/lib/company";

// The signed-in frame: brand, the billing company, the sections, the portal switcher and sign-out.
// Since 2026-11-07 the sales portal is the SELLING half: the Bill and Finance groups (invoices,
// recurring, payments, bank, accounts, reconcile, Tally, the seller settings) moved to the
// billing portal (apps/billing, billing.digitalsukoon.com), which the "Billing" entry opens
// already signed in (a handoff, components/portal-link.tsx). The eight links fit one row from
// `lg` up; below `lg` they fold behind a Menu button on every page.
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
    label: "More",
    items: [
      { href: "/pipeline", label: "Pipeline" },
      { href: "/creators", label: "Creators" },
    ],
  },
];
// Desktop nav: each group is "LABEL  item item item", groups split by a hairline divider.
const NAV_GROUP_CLS = "flex flex-col gap-1 lg:flex-row lg:items-center lg:gap-4";
const NAV_GROUP_SEP = "lg:ml-7 lg:pl-7 lg:border-l lg:border-border";
const NAV_LABEL_CLS = "text-[10px] leading-none uppercase tracking-[0.14em] text-ink-3 font-bold";
const NAV_LINK_CLS = "inline-flex items-center h-8 px-3 text-[12px] leading-none uppercase tracking-[0.06em] border-2";
const NAV = NAV_GROUPS.flatMap((g) => g.items);

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
        <div className="mx-auto max-w-7xl px-4 sm:px-6 flex items-center flex-nowrap gap-x-3 py-2 lg:gap-x-6 lg:pt-4 lg:pb-6">
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
            <button type="button" onClick={logout} className="btn btn-ghost btn-sm" aria-label="Log out">
              <LogOut size={14} aria-hidden /> <span className="hidden sm:inline">Log out</span>
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
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-center lg:gap-y-2 lg:flex-wrap lg:border-t lg:border-border lg:pt-5 lg:pb-4">
            {NAV_GROUPS.map((g, i) => (
              <div key={g.label} className={`${NAV_GROUP_CLS} ${i > 0 ? NAV_GROUP_SEP : ""}`}>
                <span className={NAV_LABEL_CLS}>{g.label}</span>
                <div className="flex flex-wrap gap-1">
                  {g.items.map((n) => {
                    const active = isActive(pathname, n.href);
                    return (
                      <Link
                        key={n.href}
                        href={n.href}
                        aria-current={active ? "page" : undefined}
                        className={`${NAV_LINK_CLS} ${active ? "bg-indigo border-indigo text-white font-bold" : "border-transparent text-ink-3 hover:text-white hover:border-border"}`}
                      >
                        {n.label}
                      </Link>
                    );
                  })}
                </div>
              </div>
            ))}
            {/* Invoices, payments and the finance pages: the billing portal, opened signed in. */}
            <div className={`${NAV_GROUP_CLS} ${NAV_GROUP_SEP}`}>
              <span className={NAV_LABEL_CLS}>Bill</span>
              <div className="flex flex-wrap gap-1">
                <PortalLink portal="billing" href="/dashboard" className={`${NAV_LINK_CLS} gap-1 border-transparent text-ink-3 hover:text-white hover:border-border`} title="Invoices, payments, bank, accounts, Tally — opens signed in">
                  Billing portal <ArrowUpRight size={12} aria-hidden />
                </PortalLink>
              </div>
            </div>
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
