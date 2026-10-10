"use client";
import { useState, useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import "./globals.css";
import { AuthContext } from "@/lib/auth";
import { apiFetch } from "@/lib/api";
import { PortalShell } from "@/components/portal-shell";

const publicRoutes = ["/login", "/signup", "/reset-password"];

/** `?next=` from the login URL, only when it is a same-site path (never `//evil.com`). */
function safeNext(): string | null {
  if (typeof window === "undefined") return null;
  const next = new URLSearchParams(window.location.search).get("next");
  return next && /^\/(?!\/)[\w\-/?=&.%]*$/.test(next) ? next : null;
}

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

  async function login(email: string, password: string) {
    const res: any = await apiFetch("/client/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    localStorage.setItem("clientAccessToken", res.data.accessToken);
    localStorage.setItem("clientRefreshToken", res.data.refreshToken);
    localStorage.setItem("clientUser", JSON.stringify(res.data.user));
    setUser(res.data.user);
    router.push(safeNext() ?? "/dashboard");
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
        <AuthContext.Provider value={{ user, login, logout, isLoading }}>
          {isPublicPage ? children : <PortalShell>{children}</PortalShell>}
        </AuthContext.Provider>
      </body>
    </html>
  );
}
