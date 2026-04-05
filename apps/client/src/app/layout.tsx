"use client";
import { useState, useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import "@dashmani/ui/src/globals.css";
import { AuthContext } from "@/lib/auth";
import { apiFetch } from "@/lib/api";
import { ClientSidebar } from "@/components/client-sidebar";
import { ClientHeader } from "@/components/client-header";

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
    } else if (pathname !== "/login") {
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

  const isLoginPage = pathname === "/login";

  return (
    <html lang="en">
      <body>
        <AuthContext.Provider value={{ user, login, logout, isLoading }}>
          {isLoginPage ? (
            children
          ) : (
            <div className="flex min-h-screen">
              <ClientSidebar />
              <div className="flex-1 flex flex-col">
                <ClientHeader />
                <main className="flex-1 p-6 bg-gray-50">{children}</main>
              </div>
            </div>
          )}
        </AuthContext.Provider>
      </body>
    </html>
  );
}
