"use client";
import { useState, useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import "./globals.css";
import { AuthContext, type ClientSession } from "@/lib/auth";
import { apiFetch } from "@/lib/api";
import { PortalShell } from "@/components/portal-shell";
import { safeNext } from "@/lib/safe-next";

const publicRoutes = ["/login", "/signup", "/reset-password"];

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

  function adoptSession(session: ClientSession) {
    localStorage.setItem("clientAccessToken", session.accessToken);
    localStorage.setItem("clientRefreshToken", session.refreshToken);
    localStorage.setItem("clientUser", JSON.stringify(session.user));
    setUser(session.user);
    router.push(safeNext() ?? "/dashboard");
  }

  async function login(email: string, password: string) {
    const res: any = await apiFetch("/client/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    adoptSession(res.data);
  }

  function logout() {
    apiFetch("/client/auth/logout", { method: "POST" }).catch(() => {});
    localStorage.removeItem("clientAccessToken");
    localStorage.removeItem("clientRefreshToken");
    localStorage.removeItem("clientUser");
    setUser(null);
    router.push("/login");
  }

  const isPublicPage = publicRoutes.includes(pathname);

  return (
    <html lang="en">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Dashmani Client Portal</title>
      </head>
      <body>
        <AuthContext.Provider value={{ user, login, adoptSession, logout, isLoading }}>
          {isPublicPage ? children : <PortalShell>{children}</PortalShell>}
        </AuthContext.Provider>
      </body>
    </html>
  );
}
