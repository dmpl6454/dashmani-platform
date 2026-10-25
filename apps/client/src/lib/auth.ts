"use client";
import { createContext, useContext } from "react";

interface ClientUser {
  id: string;
  name: string;
  companyName: string;
  email: string;
}

export interface ClientSession {
  accessToken: string;
  refreshToken: string;
  user: ClientUser;
}

interface AuthContextType {
  user: ClientUser | null;
  login: (email: string, password: string) => Promise<void>;
  /** Store a session the API already issued (Google sign-in, signup) and go to ?next= or the dashboard. */
  adoptSession: (session: ClientSession) => void;
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
