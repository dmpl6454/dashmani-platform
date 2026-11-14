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
// The billing portal (2026-11-07) is the Bill + Finance half of what was the sales portal's nav;
// the shell is the sales one (apps/sales/src/components/app-shell.tsx) with nine links on one row.
// From `lg` up the groups sit on one row under the brand; below `lg` they fold behind a Menu
// button on every page. Clients, quotes, orders and bookings live on the sales portal — the
// pages here reach them through PortalLink (components/portal-link.tsx), already signed in.
type NavItem = { href: string; label: string };
type NavGroup = { label: string; items: NavItem[] };
const NAV_GROUPS: NavGroup[] = [
  {
    label: "Bill",
    items: [
      { href: "/dashboard", label: "Dashboard" },
      { href: "/invoices", label: "Invoices" },
      { href: "/recurring", label: "Recurring" },
      { href: "/payments", label: "Payments" },
    ],
  },
  {
    label: "Finance",
    items: [
      { href: "/bank", label: "Bank" },
      { href: "/accounts", label: "Accounts" },
      { href: "/reconcile", label: "Reconcile" },
      { href: "/tally", label: "Tally" },
    ],
  },
  {
    label: "More",
    items: [{ href: "/settings", label: "Settings" }],
  },
];
// Desktop nav: each group is "LABEL  item item item", groups split by a hairline divider (same as sales).
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
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => setMenuOpen(false), [pathname]);
  const current = NAV.find((n) => isActive(pathname, n.href));
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b-2 border-border">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 flex items-center flex-nowrap gap-x-3 py-2 lg:gap-x-6 lg:pt-4 lg:pb-6">
          <Link href="/dashboard" className="flex items-center gap-2 sm:gap-2.5 font-extrabold tracking-tight text-[15px] sm:text-[17px] whitespace-nowrap min-w-0">
            <img src={COMPANY_LOGO[info.key]} alt="" className="w-7 h-7 sm:w-8 sm:h-8 shrink-0" />
            {/* Phones: company over a small "Billing" label, so a long company name never cuts off. */}
            <span className="min-w-0 flex flex-col leading-[1.1] sm:block sm:leading-normal sm:truncate">
              <span className="truncate">{info.short}</span>{" "}
              <span className="text-indigo-light text-[10.5px] uppercase tracking-[0.14em] sm:text-[17px] sm:normal-case sm:tracking-normal">Billing</span>
            </span>
          </Link>
          {/* The billing company: in the top row from md up; inside the menu on phones. */}
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
              aria-controls="billing-nav"
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
          id="billing-nav"
          aria-label="Billing portal"
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
          </div>
        </nav>
      </header>
      <p className="sr-only" aria-live="polite">Billing as {info.name}</p>
      <main className="flex-1 w-full mx-auto max-w-7xl px-4 sm:px-6 py-8 sm:py-10 min-w-0">{children}</main>
      <footer className="border-t-2 border-border">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 py-5 text-[13px] text-ink-3">© {new Date().getFullYear()} Digital Sukoon · internal</div>
      </footer>
    </div>
  );
}
