import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import {
  SessionUser,
  PortalMode,
  getMode,
  setMode as persistMode,
  getStoredUser,
  hasSession,
  clearSession,
  loginWithPassword,
  setSessionExpiredHandler,
} from "./api";

type AuthState = {
  user: SessionUser | null;
  mode: PortalMode;
  loading: boolean;
  login: (mode: PortalMode, identifier: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Switch active portal. Returns true if the target portal already has a session. */
  switchMode: (mode: PortalMode) => Promise<boolean>;
};

const AuthContext = createContext<AuthState>({
  user: null,
  mode: "hr",
  loading: true,
  login: async () => {},
  logout: async () => {},
  switchMode: async () => false,
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [mode, setModeState] = useState<PortalMode>("hr");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const m = await getMode();
        setModeState(m);
        if (await hasSession(m)) {
          setUser(await getStoredUser(m));
        }
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    setSessionExpiredHandler(() => setUser(null));
  }, []);

  const login = useCallback(async (m: PortalMode, identifier: string, password: string) => {
    const u = await loginWithPassword(m, identifier.trim(), password);
    setModeState(m);
    setUser(u);
  }, []);

  const logout = useCallback(async () => {
    await clearSession(mode);
    setUser(null);
  }, [mode]);

  const switchMode = useCallback(async (m: PortalMode) => {
    await persistMode(m);
    setModeState(m);
    if (await hasSession(m)) {
      setUser(await getStoredUser(m));
      return true;
    }
    setUser(null);
    return false;
  }, []);

  return (
    <AuthContext.Provider value={{ user, mode, loading, login, logout, switchMode }}>{children}</AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
