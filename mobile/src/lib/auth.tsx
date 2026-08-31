import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import {
  SessionUser,
  getStoredUser,
  hasSession,
  clearSession,
  loginWithPassword,
  setSessionExpiredHandler,
} from "./api";

type AuthState = {
  user: SessionUser | null;
  loading: boolean;
  login: (identifier: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthState>({
  user: null,
  loading: true,
  login: async () => {},
  logout: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        if (await hasSession()) {
          const u = await getStoredUser();
          setUser(u);
        }
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    setSessionExpiredHandler(() => setUser(null));
  }, []);

  const login = useCallback(async (identifier: string, password: string) => {
    const u = await loginWithPassword(identifier.trim(), password);
    setUser(u);
  }, []);

  const logout = useCallback(async () => {
    await clearSession();
    setUser(null);
  }, []);

  return <AuthContext.Provider value={{ user, loading, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
