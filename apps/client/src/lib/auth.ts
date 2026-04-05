"use client";
import { createContext, useContext } from "react";

interface ClientUser {
  id: string;
  name: string;
  companyName: string;
  email: string;
}

interface AuthContextType {
  user: ClientUser | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  isLoading: boolean;
}

export const AuthContext = createContext<AuthContextType>({
  user: null,
  login: async () => {},
  logout: () => {},
  isLoading: true,
});

export function useAuth() {
  return useContext(AuthContext);
}
