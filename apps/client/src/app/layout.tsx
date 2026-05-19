"use client";
import { useState, useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import "./globals.css";
import { AuthContext } from "@/lib/auth";
import { apiFetch } from "@/lib/api";
import { PortalShell } from "@/components/portal-shell";

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
      setUser(JSON.parse(stored));
    } else if (!publicRoutes.includes(pathname)) {
      router.push("/login");
    }
    setIsLoading(false);
  }, [pathname, router]);

  async function login(email: string, password: string) {
    const res: any = await apiFetch("/client/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    localStorage.setItem("clientAccessToken", res.data.accessToken);
    localStorage.setItem("clientRefreshToken", res.data.refreshToken);
    localStorage.setItem("clientUser", JSON.stringify(res.data.user));
    setUser(res.data.user);
    router.push("/dashboard");
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
