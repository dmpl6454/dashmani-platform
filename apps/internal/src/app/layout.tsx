"use client";
import { useState, useEffect, useCallback } from "react";
import { usePathname, useRouter } from "next/navigation";
import { AuthContext } from "@/lib/auth";
import { apiFetch } from "@/lib/api";
import { Sidebar } from "@/components/sidebar";
import { Header } from "@/components/header";
import "@dashmani/ui/src/globals.css";

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

  const isLoginPage = pathname === "/login";

  if (isLoading) {
    return <html lang="en"><body><div className="flex items-center justify-center min-h-screen">Loading...</div></body></html>;
  }

  if (!user && !isLoginPage) {
    if (typeof window !== "undefined") router.push("/login");
    return null;
  }

  return (
    <html lang="en">
      <body>
        <AuthContext.Provider value={{ user, login, logout, isLoading }}>
          {isLoginPage ? (
            children
          ) : (
            <div className="flex min-h-screen">
              <Sidebar />
              <div className="flex-1 flex flex-col">
                <Header />
                <main className="flex-1 p-6 bg-gray-50">{children}</main>
              </div>
            </div>
          )}
        </AuthContext.Provider>
      </body>
    </html>
  );
}
