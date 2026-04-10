"use client";
import { createContext, useContext } from "react";

export interface HrUser {
  id: string;
  name: string;
  email: string;
  phone?: string;
}

interface HrAuthContextType {
  user: HrUser | null;
  isLoading: boolean;
  login: (accessToken: string, refreshToken: string, user: HrUser) => void;
  logout: () => void;
}

export const HrAuthContext = createContext<HrAuthContextType>({
  user: null,
  isLoading: true,
  login: () => {},
  logout: () => {},
});

export const useHrAuth = () => useContext(HrAuthContext);
