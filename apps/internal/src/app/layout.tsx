"use client";
import { useState, useEffect, useCallback } from "react";
import { usePathname, useRouter } from "next/navigation";
import { AuthContext } from "@/lib/auth";
import { apiFetch } from "@/lib/api";
import { clearSwrCache } from "@/lib/swr-cache";
import { CommandPalette } from "@/components/command-palette";
import { DsSidebar } from "@/components/ds/ds-sidebar";
import { DsTopNav } from "@/components/ds/ds-topnav";
import { isDsRoute } from "@/lib/ds-routes";
import { BoxesLoader } from "@/components/boxes-loader";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
import "./globals.css";

/** Minimum time the startup loader stays visible (ms). */
const MIN_LOADER_MS = 2500;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [cmdOpen, setCmdOpen] = useState(false);
  const pathname = usePathname();
  const router = useRouter();

  const publicRoutes = ["/login", "/admin-signup", "/reset-password"];
  const isPublicPage = publicRoutes.includes(pathname);
  // Full-bleed pages draw their own chrome (the /overview command centre has its
  // own dark rail and header), but stay behind the same auth guard as everything else.
  const fullBleedRoutes = ["/overview"];
  const isFullBleed = fullBleedRoutes.some((r) => pathname === r || pathname.startsWith(`${r}/`));

  useEffect(() => {
    const token = localStorage.getItem("accessToken");
    const storedUser = localStorage.getItem("user");
    if (token && storedUser) {
      try {
        setUser(JSON.parse(storedUser));
      } catch {
        localStorage.removeItem("user");
      }
    }
    // Keep the boxes loader on screen for a minimum time so it is visible
    // instead of flashing for a few milliseconds. Auth is resolved above
    // immediately; only the reveal of the page is held back.
    const t = setTimeout(() => setIsLoading(false), MIN_LOADER_MS);
    return () => clearTimeout(t);
  }, []);

  // Redirect to login once loading is done and there's no authenticated user.
  // Must be in useEffect — calling router.push() during render causes a React warning
  // and can silently no-op when the token exists but the user object is missing.
  useEffect(() => {
    if (!isLoading && !user && !isPublicPage) {
      router.push("/login");
    }
  }, [isLoading, user, isPublicPage, router]);

  /* Global Ctrl+K / Cmd+K handler — not on full-bleed routes, which render no
     CommandPalette; without this the shortcut would toggle state nothing consumes
     and swallow the browser's own Cmd+K. */
  useEffect(() => {
    if (isFullBleed) return;
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setCmdOpen(v => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isFullBleed]);

  const login = useCallback(async (email: string, password: string, rememberMe = false) => {
    // rememberMe stretches the refresh token 7d -> 30d server-side; the choice
    // survives rotation because it rides inside the token (see auth.service).
    const res: any = await apiFetch("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password, rememberMe }),
    });
    localStorage.setItem("accessToken", res.data.accessToken);
    localStorage.setItem("refreshToken", res.data.refreshToken);
    localStorage.setItem("user", JSON.stringify(res.data.user));
    // Forget the previous user's cached SWR responses (bell list above all) —
    // navigation is client-side, so the cache survives a user switch. lib/swr-cache.ts.
    void clearSwrCache();
    setUser(res.data.user);
    router.push("/dashboard");
  }, [router]);

  const logout = useCallback(() => {
    localStorage.removeItem("accessToken");
    localStorage.removeItem("refreshToken");
    localStorage.removeItem("user");
    void clearSwrCache();
    setUser(null);
    router.push("/login");
  }, [router]);

  if (isLoading) {
    return (
      <html lang="en" suppressHydrationWarning>
        <head>
          {/* Applies the remembered light/dark theme before first paint — see lib/theme.ts. */}
          <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
        </head>
        <body>
          <div className={`flex items-center justify-center min-h-screen ${isDsRoute(pathname) ? "bg-ds-bg" : "bg-bg"}`}>
            <BoxesLoader />
          </div>
        </body>
      </html>
    );
  }

  if (!user && !isPublicPage) {
    // useEffect above handles the redirect — just show spinner while it fires.
    return (
      <html lang="en" suppressHydrationWarning>
        <head>
          {/* Applies the remembered light/dark theme before first paint — see lib/theme.ts. */}
          <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
        </head>
        <body>
          <div className={`flex items-center justify-center min-h-screen ${isDsRoute(pathname) ? "bg-ds-bg" : "bg-bg"}`}>
            <BoxesLoader />
          </div>
        </body>
      </html>
    );
  }

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
          {/* Applies the remembered light/dark theme before first paint — see lib/theme.ts. */}
          <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Dashmani Portal</title>
      </head>
      <body className="bg-bg">
        <AuthContext.Provider value={{ user, login, logout, isLoading }}>
          {isPublicPage ? (
            children
          ) : isFullBleed ? (
            // ⚠️ No CommandPalette here. It indexes all 28 classic-portal pages, so
            // Cmd+K inside the overview plane surfaced a light-themed overlay that
            // navigates straight out of it — the same cross-plane leak as the old
            // nav rail, from a second source. The overview has its own channel search.
            children
          ) : (
            // Premium dark shell — every authenticated route, including unknown ones (404s),
            // so no page ever renders in the old cream theme.
            // ⚠️ The content column is its own scroll container on purpose: globals.css sets
            // overflow-x:hidden on html/body, which silently disables position:sticky for
            // anything scrolling with the page (see the /overview rail note in CLAUDE.md).
            // Scrolling inside this column keeps the sidebar fixed and the top bar sticky.
            <div className="ds-root flex h-[100dvh] overflow-hidden">
              <DsSidebar />
              <div className="flex flex-col flex-1 min-w-0 mt-14 h-[calc(100dvh-3.5rem)] lg:mt-0 lg:h-[100dvh] overflow-y-auto">
                <DsTopNav onOpenSearch={() => setCmdOpen(true)} />
                <main className="flex-1 px-4 sm:px-6 pb-6 overflow-x-hidden">
                  {children}
                </main>
              </div>
              <CommandPalette open={cmdOpen} onClose={() => setCmdOpen(false)} />
            </div>
          )}
        </AuthContext.Provider>
      </body>
    </html>
  );
}
