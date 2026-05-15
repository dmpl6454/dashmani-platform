"use client";
import { useState, useEffect, useCallback } from "react";
import { usePathname, useRouter } from "next/navigation";
import { AuthContext } from "@/lib/auth";
import { apiFetch } from "@/lib/api";
import { Sidebar } from "@/components/sidebar";
import { TopNav } from "@/components/top-nav";
import "./globals.css";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    const token = localStorage.getItem("accessToken");
    const storedUser = localStorage.getItem("user");
    if (token && storedUser) {
      setUser(JSON.parse(storedUser));
    }
    setIsLoading(false);
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

  const publicRoutes = ["/login", "/admin-signup"];
  const isPublicPage = publicRoutes.includes(pathname);

  if (isLoading) {
    return (
      <html lang="en">
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
    if (typeof window !== "undefined") router.push("/login");
    return null;
  }

  return (
    <html lang="en">
      <body className="bg-bg">
        <AuthContext.Provider value={{ user, login, logout, isLoading }}>
          {isPublicPage ? (
            children
          ) : (
            <div className="flex min-h-screen bg-bg">
              {/* Collapsible left rail */}
              <Sidebar />

              {/* Main column */}
              <div className="flex flex-col flex-1 min-w-0">
                {/* Thin topstrip */}
                <TopNav />

                {/* Page content */}
                <main className="flex-1 px-6 py-6 overflow-auto">
                  {children}
                </main>
              </div>
            </div>
          )}
        </AuthContext.Provider>
      </body>
    </html>
  );
}
