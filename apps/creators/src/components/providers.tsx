"use client";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { SWRConfig } from "swr";
import { AuthContext } from "@/lib/auth";
import { apiFetch, clearSession, isPrivatePath, PENDING_CONNECT_KEY, storeSession, TOKEN_KEYS } from "@/lib/api";
import { safeNext } from "@/lib/safe-next";
import type { CreatorMe, CreatorSession } from "@/lib/types";
import { AppShell } from "./app-shell";

// Client-side auth guard. The app is a static export, so there is no server to check a session:
// the signed-in pages (PRIVATE_ROUTES: /dashboard, /connect, /payouts, /settings and anything under them)
// render a placeholder until we have read localStorage, and a visitor without a session is sent
// to /login?next=<where they were going>. Every other path — the public pages and unknown URLs,
// so the 404 page can show — renders as is. The API is the real gate — every signed-in request
// carries the creator's access token and 401s without it.
//
// /connect can open with a URL fragment after Facebook (`#state=…&code=…`); `next` carries only
// the path and query, so a signed-out visitor's fragment is dropped on the way to /login.

/**
 * ⚠️ SWR's cache lives in memory for the life of the tab, and a router push does not reload the page, so
 * without a reset the next person to sign in on a shared computer could see the previous creator's
 * account for a moment (including their payout status and masked bank account) before the fresh answer
 * arrives. Signing out therefore swaps in a brand-new cache: <SWRConfig key={cacheEpoch}> remounts with a
 * fresh Map as its provider. (A global mutate-everything is NOT enough: it left a fetch the previous
 * session had just started in SWR's dedupe window, and the next sign-in then waited on a result that was
 * thrown away. A new cache carries its own request bookkeeping.)
 */
const freshCache = () => new Map();

const normalise = (p: string | null) => (p && p.length > 1 ? p.replace(/\/+$/, "") : p || "/");

function readStoredCreator(): CreatorMe | null {
  try {
    if (!localStorage.getItem(TOKEN_KEYS.access)) return null;
    const raw = localStorage.getItem(TOKEN_KEYS.user);
    return raw ? (JSON.parse(raw) as CreatorMe) : null;
  } catch {
    return null; // storage blocked or a malformed stored user: treat as signed out
  }
}

export function Providers({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = normalise(usePathname());
  const isPublic = !isPrivatePath(pathname);
  const [creator, setCreator] = useState<CreatorMe | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  // Bumped on sign-out: a new epoch is a new SWR cache (see freshCache).
  const [cacheEpoch, setCacheEpoch] = useState(0);

  useEffect(() => {
    const stored = readStoredCreator();
    setCreator(stored);
    if (!stored && !isPublic) {
      // Back from Facebook but signed out: keep the result for /connect to finish after sign-in
      // (it is never put in ?next=, so it stays out of the URL and any server log).
      const hash = window.location.hash.replace(/^#/, "");
      if (pathname === "/connect" && /(^|&)state=/.test(hash) && /(^|&)code=/.test(hash)) {
        try {
          sessionStorage.setItem(PENDING_CONNECT_KEY, hash);
        } catch {
          // storage blocked: the creator simply starts the connection again
        }
      }
      const here = pathname + window.location.search;
      router.replace(`/login?next=${encodeURIComponent(here)}`);
    }
    setIsLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  function adoptSession(session: CreatorSession) {
    storeSession(session);
    setCreator(session.creator);
    // replace, not push: Back from the dashboard must not land on the sign-in form again.
    router.replace(safeNext() ?? "/dashboard");
  }

  async function login(email: string, password: string) {
    const res = await apiFetch<CreatorSession>("/creator/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    adoptSession(res.data);
  }

  function updateCreator(next: CreatorMe) {
    setCreator(next);
    try { localStorage.setItem(TOKEN_KEYS.user, JSON.stringify(next)); } catch { /* storage blocked */ }
  }

  function logout() {
    let refreshToken: string | null = null;
    try { refreshToken = localStorage.getItem(TOKEN_KEYS.refresh); } catch { /* storage blocked */ }
    if (refreshToken) {
      apiFetch("/creator/auth/logout", { method: "POST", body: JSON.stringify({ refreshToken }) }).catch(() => {});
    }
    clearSession();
    setCacheEpoch((n) => n + 1);
    setCreator(null);
    router.push("/login");
  }

  let content: React.ReactNode;
  if (isPublic) content = children;
  else if (isLoading || !creator) content = <GuardPlaceholder />;
  else content = <AppShell>{children}</AppShell>;

  return (
    <AuthContext.Provider value={{ creator, login, adoptSession, updateCreator, logout, isLoading }}>
      <SWRConfig key={cacheEpoch} value={{ provider: freshCache }}>
        {content}
      </SWRConfig>
    </AuthContext.Provider>
  );
}

function GuardPlaceholder() {
  return (
    <main className="min-h-screen grid place-items-center px-4">
      <div className="flex items-center gap-3 text-ink-3 text-sm" role="status">
        <span className="spinner" aria-hidden /> Opening your creator account…
      </div>
    </main>
  );
}
