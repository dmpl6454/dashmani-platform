import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  ApiError,
  type SessionUser,
  type PortalMode,
  getMode,
  setMode as persistMode,
  getStoredUser,
  hasSession,
  clearSession,
  loginWithPassword,
  loginWithGoogle,
  setSessionExpiredHandler,
} from "./api";

/** What the signed-in person may do, derived from their role names. */
export type Caps = { isAdmin: boolean; isHr: boolean; isLead: boolean; canUseAdminPortal: boolean };

const NO_CAPS: Caps = { isAdmin: false, isHr: false, isLead: false, canUseAdminPortal: false };

/** Admin | Super Admin → isAdmin; HR Manager | HR → isHr; Team Lead → isLead. */
export function capsFor(roles: readonly string[] | undefined): Caps {
  if (!roles || roles.length === 0) return NO_CAPS;
  const names = roles.map((r) => (typeof r === "string" ? r.trim().toLowerCase() : ""));
  const has = (...want: string[]) => want.some((w) => names.includes(w));
  const isAdmin = has("admin", "super admin");
  const isHr = has("hr manager", "hr");
  const isLead = has("team lead");
  return { isAdmin, isHr, isLead, canUseAdminPortal: isAdmin || isHr };
}

type AuthState = {
  user: SessionUser | null;
  mode: PortalMode;
  loading: boolean;
  caps: Caps;
  /** Screen to return to after signing in again (memory only, never persisted). */
  resumePath: string | null;
  setResumePath: (p: string | null) => void;
  login: (mode: PortalMode, identifier: string, password: string) => Promise<void>;
  /** Sign in with a Google ID token from the app's own Google client. */
  loginGoogle: (mode: PortalMode, credential: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Switch active portal. Returns true (and switches) only if the target portal already has a session;
   *  otherwise returns false and changes nothing — the caller sends the person to /login. */
  switchMode: (mode: PortalMode) => Promise<boolean>;
};

const AuthContext = createContext<AuthState>({
  user: null,
  mode: "hr",
  loading: true,
  caps: NO_CAPS,
  resumePath: null,
  setResumePath: () => {},
  login: async () => {},
  loginGoogle: async () => {},
  logout: async () => {},
  switchMode: async () => false,
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [mode, setModeState] = useState<PortalMode>("hr");
  const [loading, setLoading] = useState(true);
  const [resumePath, setResumePathState] = useState<string | null>(null);

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

  const setResumePath = useCallback((p: string | null) => {
    setResumePathState(p);
  }, []);

  const login = useCallback(async (m: PortalMode, identifier: string, password: string) => {
    const previousMode = await getMode();
    const u = await loginWithPassword(m, identifier.trim(), password);
    if (m === "admin" && !capsFor(u.roles).canUseAdminPortal) {
      await clearSession("admin");
      await persistMode(previousMode);
      throw new ApiError(
        "This account can't use the Admin portal. Switch to Employee and sign in there.",
        "FORBIDDEN_PORTAL",
      );
    }
    setModeState(m);
    setUser(u);
  }, []);

  const loginGoogle = useCallback(async (m: PortalMode, credential: string) => {
    const previousMode = await getMode();
    const u = await loginWithGoogle(m, credential);
    if (m === "admin" && !capsFor(u.roles).canUseAdminPortal) {
      await clearSession("admin");
      await persistMode(previousMode);
      throw new ApiError(
        "This account can't use the Admin portal. Switch to Employee and sign in there.",
        "FORBIDDEN_PORTAL",
      );
    }
    setModeState(m);
    setUser(u);
  }, []);

  const logout = useCallback(async () => {
    await clearSession(mode);
    setResumePathState(null);
    setUser(null);
  }, [mode]);

  const switchMode = useCallback(async (m: PortalMode) => {
    if (!(await hasSession(m))) return false;
    await persistMode(m);
    setModeState(m);
    setUser(await getStoredUser(m));
    return true;
  }, []);

  const caps = useMemo(() => capsFor(user?.roles), [user]);

  const value = useMemo<AuthState>(
    () => ({ user, mode, loading, caps, resumePath, setResumePath, login, loginGoogle, logout, switchMode }),
    [user, mode, loading, caps, resumePath, setResumePath, login, loginGoogle, logout, switchMode],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
