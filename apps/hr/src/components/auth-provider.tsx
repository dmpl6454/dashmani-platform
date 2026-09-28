"use client";
import { useState, useEffect, useCallback, useRef, ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { HrAuthContext, HrUser } from "@/lib/auth";
import { loginHrefWithNext } from "@/lib/return-path";
import { purgePipelineStorage } from "@/lib/pipeline-storage";

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

  // Set by an explicit sign-out, so the guard below does not carry the page being left
  // into ?next= (the next person to sign in on this device must not land on it).
  const explicitLogoutRef = useRef(false);

  // Redirect unauthenticated users to login, carrying the page they asked for (P5).
  // ⚠️ Read window.location, never useSearchParams(): that hook breaks the static build.
  // The login page honours ?next= only for /pipeline paths (lib/return-path.ts).
  useEffect(() => {
    if (!isLoading && !user && pathname !== "/login" && pathname !== "/reset-password") {
      router.push(explicitLogoutRef.current ? "/login" : loginHrefWithNext(window.location));
    }
  }, [isLoading, user, pathname, router]);

  // Login: save tokens + user to localStorage AND update state
  const login = useCallback((accessToken: string, refreshToken: string, userData: HrUser) => {
    explicitLogoutRef.current = false;
    localStorage.setItem("hrAccessToken", accessToken);
    localStorage.setItem("hrRefreshToken", refreshToken);
    localStorage.setItem("hrUser", JSON.stringify(userData));
    setUser(userData);
  }, []);

  const logout = useCallback(() => {
    explicitLogoutRef.current = true;
    localStorage.removeItem("hrAccessToken");
    localStorage.removeItem("hrRefreshToken");
    localStorage.removeItem("hrUser");
    purgePipelineStorage();
    setUser(null);
    router.push("/login");
  }, [router]);

  return (
    <HrAuthContext.Provider value={{ user, isLoading, login, logout }}>
      {children}
    </HrAuthContext.Provider>
  );
}
