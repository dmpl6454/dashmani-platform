"use client";
import { useState, useEffect, useCallback, ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { HrAuthContext, HrUser } from "@/lib/auth";

export function HrAuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<HrUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const pathname = usePathname();
  const router = useRouter();

  // Load user from localStorage on mount
  useEffect(() => {
    const token = localStorage.getItem("hrAccessToken");
    const storedUser = localStorage.getItem("hrUser");
    if (token && storedUser) {
      try {
        setUser(JSON.parse(storedUser));
      } catch {
        // invalid stored user
      }
    }
    setIsLoading(false);
  }, []);

  // Redirect unauthenticated users to login
  useEffect(() => {
    if (!isLoading && !user && pathname !== "/login") {
      router.push("/login");
    }
  }, [isLoading, user, pathname, router]);

  // Login: save tokens + user to localStorage AND update state
  const login = useCallback((accessToken: string, refreshToken: string, userData: HrUser) => {
    localStorage.setItem("hrAccessToken", accessToken);
    localStorage.setItem("hrRefreshToken", refreshToken);
    localStorage.setItem("hrUser", JSON.stringify(userData));
    setUser(userData);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem("hrAccessToken");
    localStorage.removeItem("hrRefreshToken");
    localStorage.removeItem("hrUser");
    setUser(null);
    router.push("/login");
  }, [router]);

  return (
    <HrAuthContext.Provider value={{ user, isLoading, login, logout }}>
      {children}
    </HrAuthContext.Provider>
  );
}
