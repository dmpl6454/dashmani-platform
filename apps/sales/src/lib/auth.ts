"use client";
import { createContext, useContext } from "react";
import type { StaffSession, StaffUser } from "./types";

interface AuthContextType {
  user: StaffUser | null;
  login: (email: string, password: string) => Promise<void>;
  /** Adopt a session minted elsewhere (a handoff from another portal) exactly as login does. */
  adoptSession: (session: StaffSession) => void;
  logout: () => void;
  isLoading: boolean;
}

export const AuthContext = createContext<AuthContextType>({
  user: null,
  login: async () => {},
  adoptSession: () => {},
  logout: () => {},
  isLoading: true,
});

export function useAuth() {
  return useContext(AuthContext);
}
