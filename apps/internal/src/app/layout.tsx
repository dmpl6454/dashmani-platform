"use client";
import { useState, useEffect, useCallback } from "react";
import { usePathname, useRouter } from "next/navigation";
import { AuthContext } from "@/lib/auth";
import { apiFetch } from "@/lib/api";
import { Sidebar } from "@/components/sidebar";
import { TopNav } from "@/components/top-nav";
import { CommandPalette } from "@/components/command-palette";
import "./globals.css";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [cmdOpen, setCmdOpen] = useState(false);
  const pathname = usePathname();
  const router = useRouter();

  const publicRoutes = ["/login", "/admin-signup", "/reset-password"];
  const isPublicPage = publicRoutes.includes(pathname);

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
    setIsLoading(false);
  }, []);

  // Redirect to login once loading is done and there's no authenticated user.
  // Must be in useEffect — calling router.push() during render causes a React warning
  // and can silently no-op when the token exists but the user object is missing.
  useEffect(() => {
    if (!isLoading && !user && !isPublicPage) {
      router.push("/login");
    }
  }, [isLoading, user, isPublicPage, router]);

  /* Global Ctrl+K / Cmd+K handler */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setCmdOpen(v => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res: any = await apiFetch("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    localStorage.setItem("accessToken", res.data.accessToken);
    localStorage.setItem("refreshToken", res.data.refreshToken);
    localStorage.setItem("user", JSON.stringify(res.data.user));
    setUser(res.data.user);
    router.push("/dashboard");
  }, [router]);

  const logout = useCallback(() => {
    localStorage.removeItem("accessToken");
    localStorage.removeItem("refreshToken");
    localStorage.removeItem("user");
    setUser(null);
    router.push("/login");
  }, [router]);

  if (isLoading) {
    return (
      <html lang="en">
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1" />
        </head>
        <body>
          <div className="flex items-center justify-center min-h-screen bg-bg">
            <div
              className="h-8 w-8 rounded-full border-[3px] border-ink/10 border-t-indigo"
              style={{ animation: "spin 0.7s linear infinite" }}
            />
          </div>
        </body>
      </html>
    );
  }

  if (!user && !isPublicPage) {
    // useEffect above handles the redirect — just show spinner while it fires.
    return (
      <html lang="en">
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1" />
        </head>
        <body>
          <div className="flex items-center justify-center min-h-screen bg-bg">
            <div
              className="h-8 w-8 rounded-full border-[3px] border-ink/10 border-t-indigo"
              style={{ animation: "spin 0.7s linear infinite" }}
            />
          </div>
        </body>
      </html>
    );
  }

  return (
    <html lang="en">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Dashmani Portal</title>
      </head>
      <body className="bg-bg">
        <AuthContext.Provider value={{ user, login, logout, isLoading }}>
          {isPublicPage ? (
            children
          ) : (
            <div className="flex min-h-screen bg-bg">
              {/* Collapsible left rail */}
              <Sidebar />

              {/* Main column */}
              <div className="flex flex-col flex-1 min-w-0 pt-[57px] lg:pt-0">
                {/* Thin topstrip */}
                <TopNav onOpenSearch={() => setCmdOpen(true)} />

                {/* Page content */}
                <main className="flex-1 px-4 sm:px-6 py-6 overflow-y-auto overflow-x-hidden">
                  {children}
                </main>
              </div>

              {/* Global command palette */}
              <CommandPalette open={cmdOpen} onClose={() => setCmdOpen(false)} />
            </div>
          )}
        </AuthContext.Provider>
      </body>
    </html>
  );
}
