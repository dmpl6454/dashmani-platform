"use client";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { AuthContext } from "@/lib/auth";
import { apiFetch, clearSession, PUBLIC_ROUTES, storeSession, TOKEN_KEYS } from "@/lib/api";
import { safeNext } from "@/lib/safe-next";
import type { CreatorMe, CreatorSession } from "@/lib/types";
import { AppShell } from "./app-shell";

// Client-side auth guard. The app is a static export, so there is no server to check a session:
// signed-in pages render a placeholder until we have read localStorage, and a visitor without a
// session is sent to /login?next=<where they were going>. The API is the real gate — every
// signed-in request carries the creator's access token and 401s without it.

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
  const isPublic = PUBLIC_ROUTES.includes(pathname);
  const [creator, setCreator] = useState<CreatorMe | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const stored = readStoredCreator();
    setCreator(stored);
    if (!stored && !isPublic) {
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
    setCreator(null);
    router.push("/login");
  }

  let content: React.ReactNode;
  if (isPublic) content = children;
  else if (isLoading || !creator) content = <GuardPlaceholder />;
  else content = <AppShell>{children}</AppShell>;

  return (
    <AuthContext.Provider value={{ creator, login, adoptSession, updateCreator, logout, isLoading }}>
      {content}
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
