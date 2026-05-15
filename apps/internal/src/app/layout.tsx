"use client";
import { useState, useEffect, useCallback } from "react";
import { usePathname, useRouter } from "next/navigation";
import { AuthContext } from "@/lib/auth";
import { apiFetch } from "@/lib/api";
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
    return <html lang="en"><body><div className="flex items-center justify-center min-h-screen" style={{ background: "linear-gradient(165deg, #FDF6E3 0%, #F7ECD5 40%, #EFE2C4 100%)" }}><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#F5D547]" /></div></body></html>;
  }

  if (!user && !isPublicPage) {
    if (typeof window !== "undefined") router.push("/login");
    return null;
  }

  return (
    <html lang="en">
      <body>
        <AuthContext.Provider value={{ user, login, logout, isLoading }}>
          {isPublicPage ? (
            children
          ) : (
            <div className="min-h-screen" style={{ background: "linear-gradient(165deg, #FDF6E3 0%, #F7ECD5 40%, #EFE2C4 100%)" }}>
              <TopNav />
              <main className="max-w-[1440px] mx-auto px-4 md:px-8 py-6">{children}</main>
            </div>
          )}
        </AuthContext.Provider>
      </body>
    </html>
  );
}
