"use client";
import { createContext, useContext } from "react";

interface User {
  id: string;
  name: string;
  email: string;
  roles: string[];
  profileImageUrl?: string | null;
}

export interface InternalSession {
  accessToken: string;
  refreshToken: string;
  user: User;
}

interface AuthContextType {
  user: User | null;
  login: (email: string, password: string, rememberMe?: boolean) => Promise<void>;
  /** Adopt a session minted elsewhere (Sign in with Google) exactly as password login does. */
  adoptSession: (session: InternalSession) => void;
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

export const useAuth = () => useContext(AuthContext);
