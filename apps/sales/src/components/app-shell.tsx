"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogOut } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { PortalSwitcher } from "./portal-switcher";
import { CompanySwitcher } from "./company-switcher";
import { COMPANY_LOGO, useCompany } from "@/lib/company";

// The signed-in frame: brand, the billing company, the nine sections, the portal switcher and sign-out. Nav wraps rather than scrolls so
// nothing overflows at 390px.
const NAV = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/inventory", label: "Inventory" },
  { href: "/clients", label: "Clients" },
  { href: "/quotes", label: "Quotes" },
  { href: "/orders", label: "Orders" },
  { href: "/bookings", label: "Bookings" },
  { href: "/invoices", label: "Invoices" },
  { href: "/payments", label: "Payments" },
  { href: "/settings", label: "Settings" },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()?.replace(/\/+$/, "") || "/";
  const { user, logout } = useAuth();
  const { info } = useCompany();
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b-2 border-border">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 py-3 flex flex-wrap items-center gap-x-6 gap-y-3">
          <Link href="/dashboard" className="flex items-center gap-2.5 font-extrabold tracking-tight text-[17px] whitespace-nowrap min-w-0">
            <img src={COMPANY_LOGO[info.key]} alt="" className="w-8 h-8 shrink-0" />
            <span className="truncate">{info.short} <span className="text-indigo-light">Sales</span></span>
          </Link>
          <CompanySwitcher />
          <nav aria-label="Sales portal" className="order-3 w-full lg:order-none lg:w-auto flex flex-wrap gap-1">
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
          <div className="ml-auto flex items-center gap-3 min-w-0">
            <div className="hidden md:flex flex-col items-end min-w-0">
              <span className="text-sm font-bold truncate max-w-[220px]">{user?.name}</span>
              <span className="text-[11px] uppercase tracking-[0.1em] text-ink-3">{user?.roles?.join(" · ")}</span>
            </div>
            <PortalSwitcher />
            <button type="button" onClick={logout} className="btn btn-ghost btn-sm" aria-label="Sign out">
              <LogOut size={14} aria-hidden /> <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </div>
      </header>
      <p className="sr-only" aria-live="polite">Billing as {info.name}</p>
      <main className="flex-1 w-full mx-auto max-w-7xl px-4 sm:px-6 py-8 sm:py-10 min-w-0">{children}</main>
      <footer className="border-t-2 border-border">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 py-5 text-[13px] text-ink-3">© {new Date().getFullYear()} Digital Sukoon · internal</div>
      </footer>
    </div>
  );
}
