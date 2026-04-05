"use client";
import { useState, useEffect, useCallback, ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { HrAuthContext, HrUser } from "@/lib/auth";

export function HrAuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<HrUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const pathname = usePathname();
  const router = useRouter();

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

  useEffect(() => {
    if (!isLoading && !user && pathname !== "/login") {
      router.push("/login");
    }
  }, [isLoading, user, pathname, router]);

  const logout = useCallback(() => {
    localStorage.removeItem("hrAccessToken");
    localStorage.removeItem("hrRefreshToken");
    localStorage.removeItem("hrUser");
    setUser(null);
    router.push("/login");
  }, [router]);

  return (
    <HrAuthContext.Provider value={{ user, isLoading, logout }}>
      {children}
    </HrAuthContext.Provider>
  );
}
