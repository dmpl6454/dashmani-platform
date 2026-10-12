"use client";
import { createContext, useContext } from "react";
import type { CreatorMe, CreatorSession } from "./types";

interface AuthContextType {
  /** The cached creator (localStorage `creatorUser`); pages that need fresh state read GET /creator/me. */
  creator: CreatorMe | null;
  login: (email: string, password: string) => Promise<void>;
  /** Store a session the API already issued (signup, Google) and go to ?next= or the dashboard. */
  adoptSession: (session: CreatorSession) => void;
  /** Refresh the cached creator after a profile change. */
  updateCreator: (creator: CreatorMe) => void;
  logout: () => void;
  isLoading: boolean;
}

export const AuthContext = createContext<AuthContextType>({
  creator: null,
  login: async () => {},
  adoptSession: () => {},
  updateCreator: () => {},
  logout: () => {},
  isLoading: true,
});

export function useAuth() {
  return useContext(AuthContext);
}
