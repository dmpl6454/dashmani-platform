"use client";
import Link from "next/link";
import { useAuth } from "@/lib/auth";
import { SiteFooter } from "./app-shell";

// The public frame for the landing page and the legal pages: brand, sign-in links (or a way back
// into the account when already signed in), and the shared footer.
export function SiteShell({ children }: { children: React.ReactNode }) {
  const { creator, isLoading } = useAuth();
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b-2 border-border">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 py-3 flex items-center gap-4">
          <Link href="/" className="flex items-center gap-2.5 font-extrabold tracking-tight text-[17px] min-w-0">
            <img src="/logo-mark.svg" alt="" className="w-8 h-8 shrink-0" />
            <span className="truncate">Digital Sukoon <span className="text-indigo-light">Creators</span></span>
          </Link>
          <div className="ml-auto flex items-center gap-2 shrink-0">
            {!isLoading && creator ? (
              <Link href="/dashboard" className="btn btn-sm">Your account</Link>
            ) : (
              <>
                <Link href="/login" className="btn btn-ghost btn-sm">Sign in</Link>
                <Link href="/signup" className="btn btn-sm hidden sm:inline-flex">Join</Link>
              </>
            )}
          </div>
        </div>
      </header>
      <main className="flex-1 w-full min-w-0">{children}</main>
      <SiteFooter />
    </div>
  );
}

/** Long-form page (terms, privacy, data deletion). */
export function LegalPage({ kicker, title, updated, children }: {
  kicker: string; title: string; updated?: string; children: React.ReactNode;
}) {
  return (
    <SiteShell>
      <article className="mx-auto max-w-3xl px-4 sm:px-6 py-10 sm:py-16">
        <p className="kicker">{kicker}</p>
        <h1 className="mt-3 text-[clamp(34px,6vw,56px)] font-extrabold tracking-[-0.04em] leading-[1]">{title}</h1>
        {updated && <p className="mt-4 text-sm text-ink-3">Last updated {updated}</p>}
        <div className="prose-ds mt-8">{children}</div>
      </article>
    </SiteShell>
  );
}
