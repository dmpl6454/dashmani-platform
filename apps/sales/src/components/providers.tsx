"use client";
import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { AuthContext } from "@/lib/auth";
import { apiFetch, clearSession, isPrivatePath, readStoredUser, storeSession } from "@/lib/api";
import { isSalesUser } from "@/lib/access";
import { safeNext } from "@/lib/safe-next";
import type { StaffSession, StaffUser } from "@/lib/types";
import { AppShell } from "./app-shell";

// Client-side auth guard for a static export: there is no server to check a session, so the
// signed-in pages render a placeholder until localStorage has been read, and a visitor without
// a session goes to /login?next=<where they were going>. The API is the real gate — every
// request carries the staff token and 401s/403s without the right role.

const normalise = (p: string | null) => (p && p.length > 1 ? p.replace(/\/+$/, "") : p || "/");

export function Providers({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = normalise(usePathname());
  const isPublic = !isPrivatePath(pathname);
  const [user, setUser] = useState<StaffUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const stored = readStoredUser();
    setUser(stored);
    if (!stored && !isPublic) {
      const here = pathname + window.location.search;
      router.replace(`/login?next=${encodeURIComponent(here)}`);
    }
    setIsLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  async function login(email: string, password: string) {
    const res = await apiFetch<StaffSession>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
    storeSession(res.data);
    setUser(res.data.user);
    router.replace(safeNext() ?? "/dashboard");
  }

  function logout() {
    let refreshToken: string | null = null;
    try { refreshToken = localStorage.getItem("refreshToken"); } catch { /* storage blocked */ }
    if (refreshToken) {
      apiFetch("/auth/logout", { method: "POST", body: JSON.stringify({ refreshToken }) }).catch(() => {});
    }
    clearSession();
    setUser(null);
    router.push("/login");
  }

  let content: React.ReactNode;
  if (isPublic) content = children;
  else if (isLoading || !user) content = <GuardPlaceholder />;
  else if (!isSalesUser(user)) content = <NotForRole onLogout={logout} name={user.name} />;
  else content = <AppShell>{children}</AppShell>;

  return <AuthContext.Provider value={{ user, login, logout, isLoading }}>{content}</AuthContext.Provider>;
}

function GuardPlaceholder() {
  return (
    <main className="min-h-screen grid place-items-center px-4">
      <div className="flex items-center gap-3 text-ink-3 text-sm" role="status">
        <span className="spinner" aria-hidden /> Opening the sales portal…
      </div>
    </main>
  );
}

function NotForRole({ name, onLogout }: { name: string; onLogout: () => void }) {
  return (
    <main className="min-h-screen grid place-items-center px-4">
      <div className="card p-8 max-w-md w-full">
        <p className="text-[11px] uppercase tracking-[0.12em] text-ink-3 mb-2">Sales portal</p>
        <h1 className="text-2xl font-extrabold mb-3">This portal is for the sales team.</h1>
        <p className="text-ink-3 text-sm mb-6">
          {name}, your account doesn&apos;t carry the Sales role. Ask an admin to add it on the staff portal, or sign in with another account.
        </p>
        <button type="button" className="btn" onClick={onLogout}>Sign out</button>
      </div>
    </main>
  );
}
