"use client";
import { useState, useEffect, useCallback, useMemo } from "react";
import { useRouter, usePathname } from "next/navigation";
import { WebVitalsReporter } from "@/components/web-vitals";
import "./globals.css";
import { AuthContext, type ClientSession } from "@/lib/auth";
import { apiFetch } from "@/lib/api";
import { PortalShell } from "@/components/portal-shell";
import { safeNext } from "@/lib/safe-next";

const publicRoutes = ["/login", "/signup", "/reset-password", "/join", "/terms"];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem("clientAccessToken");
    const stored = localStorage.getItem("clientUser");
    if (token && stored) {
      try { setUser(JSON.parse(stored)); } catch { /* malformed stored user */ }
    } else if (!publicRoutes.includes(pathname)) {
      // Keep where they were going (e.g. the website's "Start a campaign" → /campaigns/new).
      const next = pathname && pathname !== "/" ? `?next=${encodeURIComponent(pathname)}` : "";
      router.push(`/login${next}`);
    }
    setIsLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  const adoptSession = useCallback((session: ClientSession) => {
    localStorage.setItem("clientAccessToken", session.accessToken);
    localStorage.setItem("clientRefreshToken", session.refreshToken);
    localStorage.setItem("clientUser", JSON.stringify(session.user));
    setUser(session.user);
    // replace, not push: Back from the portal must not land on the sign-in form again.
    router.replace(safeNext() ?? "/dashboard");
  }, [router]);

  const login = useCallback(async (email: string, password: string) => {
    const res: any = await apiFetch("/client/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    adoptSession(res.data);
  }, [adoptSession]);

  const logout = useCallback(() => {
    apiFetch("/client/auth/logout", { method: "POST" }).catch(() => {});
    localStorage.removeItem("clientAccessToken");
    localStorage.removeItem("clientRefreshToken");
    localStorage.removeItem("clientUser");
    setUser(null);
    router.push("/login");
  }, [router]);

  // Stable while the user is unchanged: this layout re-renders on every page change.
  const auth = useMemo(() => ({ user, login, adoptSession, logout, isLoading }), [user, login, adoptSession, logout, isLoading]);

  const isPublicPage = publicRoutes.includes(pathname);

  return (
    <html lang="en">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Digital Sukoon Client Portal</title>
        {/* The body font, fetched alongside the CSS instead of after it (self-hosted, public/fonts). */}
        <link rel="preload" href="/fonts/manrope-normal-latin.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        {/* The Digital Sukoon circle logo (same artwork as digitalsukoon.com's /logo.png). */}
        <link rel="icon" href="/favicon.png" type="image/png" sizes="64x64" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180" />
      </head>
      <body>
        <WebVitalsReporter />
        <AuthContext.Provider value={auth}>
          {isPublicPage ? children : <PortalShell>{children}</PortalShell>}
        </AuthContext.Provider>
      </body>
    </html>
  );
}
