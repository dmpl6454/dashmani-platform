"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import useSWR from "swr";
import { LogOut } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { fetcher, PAYOUT_ACCOUNT_PATH } from "@/lib/api";
import type { PayoutAccountResponse } from "@/lib/types";
import { useAwaitingAnswerCount } from "@/lib/use-offers";
import { CREATOR_STATUS_LABELS } from "@dashmani/shared/src/validators/creator";

// The signed-in frame: brand, the channels (Overview / Pages / Bookings / Payouts / Settings) and sign-out, in the
// site's header style. Nav wraps rather than scrolls so nothing overflows at 390px.
// "Payouts" is shown only when bank connect exists for this creator: the server says it is open
// (routeEnabled) or the creator already has a payout account. While it is dark the nav is exactly what
// it always was; a failed or pending answer shows nothing.
// "Bookings" follows the same rule with its own switch: GET /creator/marketplace-status must have answered
// `marketplaceEnabled: true`. Dark, loading or failed, there is no such entry at all. Its badge counts the offers
// waiting for an answer, and appears only once that count is known (never as a guess of zero).
const NAV: Array<{ href: string; label: string; payouts?: boolean; bookings?: boolean; also?: string[] }> = [
  { href: "/dashboard", label: "Overview" },
  { href: "/connect", label: "Pages" },
  { href: "/offers", label: "Bookings", bookings: true, also: ["/offer"] },
  { href: "/payouts", label: "Payouts", payouts: true },
  { href: "/settings", label: "Settings" },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()?.replace(/\/+$/, "") || "/";
  const { creator, logout } = useAuth();
  const status = creator?.status;
  // Same cache entry as the Payouts page: one request serves both.
  const { data: payout } = useSWR<PayoutAccountResponse>(PAYOUT_ACCOUNT_PATH, fetcher, {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });
  const showPayouts = !!payout && (payout.routeEnabled || (payout.account !== null && payout.account.status !== "not_started"));
  const { open: bookingsOpen, count: awaiting } = useAwaitingAnswerCount();
  const nav = NAV.filter((n) => (!n.payouts || showPayouts) && (!n.bookings || bookingsOpen));
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b-2 border-border">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 py-3 flex flex-wrap items-center gap-x-6 gap-y-3">
          <Link href="/dashboard" className="flex items-center gap-2.5 font-extrabold tracking-tight text-[17px] whitespace-nowrap min-w-0">
            <img src="/logo-mark.svg" alt="" className="w-8 h-8 shrink-0" />
            <span className="truncate">Digital Sukoon <span className="text-indigo-light">Creators</span></span>
          </Link>
          <nav aria-label="Creator portal" className="order-3 w-full sm:order-none sm:w-auto flex flex-wrap gap-1">
            {nav.map((n) => {
              const active = pathname === n.href || !!n.also?.includes(pathname);
              const badge = n.bookings && awaiting ? awaiting : 0;
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  aria-current={active ? "page" : undefined}
                  className={`px-3 py-2 text-[13px] uppercase tracking-[0.08em] border-2 ${active ? "bg-indigo border-indigo text-white font-bold" : "border-transparent text-ink-3 hover:text-white hover:border-border"}`}
                >
                  {n.label}
                  {badge > 0 && (
                    <>
                      <span className="ml-2 inline-grid min-w-[1.25rem] h-5 px-1 place-items-center bg-attention text-black text-[11px] font-extrabold tracking-normal" aria-hidden>{badge}</span>
                      <span className="sr-only"> ({badge} {badge === 1 ? "offer needs" : "offers need"} your answer)</span>
                    </>
                  )}
                </Link>
              );
            })}
          </nav>
          <div className="ml-auto flex items-center gap-3 min-w-0">
            <div className="hidden md:flex flex-col items-end min-w-0">
              <span className="text-sm font-bold truncate max-w-[220px]">{creator?.name}</span>
              {status && <span className="text-[11px] uppercase tracking-[0.1em] text-ink-3">{CREATOR_STATUS_LABELS[status] ?? status}</span>}
            </div>
            <button type="button" onClick={logout} className="btn btn-ghost btn-sm" aria-label="Sign out">
              <LogOut size={14} aria-hidden /> <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </div>
      </header>
      <main className="flex-1 w-full mx-auto max-w-6xl px-4 sm:px-6 py-8 sm:py-10 min-w-0">{children}</main>
      <SiteFooter />
    </div>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t-2 border-border">
      <div className="mx-auto max-w-6xl px-4 sm:px-6 py-5 flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px] text-ink-3">
        <span>© {new Date().getFullYear()} Digital Sukoon</span>
        <Link href="/terms" className="hover:text-white">Creator terms</Link>
        <Link href="/privacy" className="hover:text-white">Privacy</Link>
        <Link href="/data-deletion" className="hover:text-white">Data deletion</Link>
        <a href="mailto:creators@digitalsukoon.com" className="hover:text-white sm:ml-auto">creators@digitalsukoon.com</a>
      </div>
    </footer>
  );
}
