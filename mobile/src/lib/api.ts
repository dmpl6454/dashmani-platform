import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";

// Production API. Point at http://<your-mac-ip>:4000/v1 for local dev.
export const API_URL = "https://api.digitalsukoon.com/v1";
/** Base URL without /v1 — used for static file URLs like /uploads/ */
export const API_BASE = API_URL.replace(/\/v1\/?$/, "");

const KEYS = {
  access: "hrAccessToken",
  refresh: "hrRefreshToken",
  user: "hrUser",
};

// Storage adapter: SecureStore is native-only — on web fall back to localStorage
// (wrapped in try/catch: private windows / blocked site data throw on access).
const store = {
  async get(key: string): Promise<string | null> {
    if (Platform.OS === "web") {
      try {
        return typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
      } catch {
        return null;
      }
    }
    try {
      return await SecureStore.getItemAsync(key);
    } catch {
      return null;
    }
  },
  async set(key: string, value: string): Promise<void> {
    if (Platform.OS === "web") {
      try {
        if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
      } catch {}
      return;
    }
    try {
      await SecureStore.setItemAsync(key, value);
    } catch {}
  },
  async remove(key: string): Promise<void> {
    if (Platform.OS === "web") {
      try {
        if (typeof localStorage !== "undefined") localStorage.removeItem(key);
      } catch {}
      return;
    }
    try {
      await SecureStore.deleteItemAsync(key);
    } catch {}
  },
};

export class ApiError extends Error {
  code?: string;
  details?: Array<{ field: string; message: string }>;
  constructor(message: string, code?: string, details?: Array<{ field: string; message: string }>) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.details = details;
  }
}

export type SessionUser = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  profileImageUrl: string | null;
  roles: string[];
};

export async function getStoredUser(): Promise<SessionUser | null> {
  try {
    const raw = await store.get(KEYS.user);
    return raw ? (JSON.parse(raw) as SessionUser) : null;
  } catch {
    return null;
  }
}

export async function storeSession(accessToken: string, refreshToken: string, user?: SessionUser) {
  await store.set(KEYS.access, accessToken);
  await store.set(KEYS.refresh, refreshToken);
  if (user) await store.set(KEYS.user, JSON.stringify(user));
}

export async function clearSession() {
  await store.remove(KEYS.access);
  await store.remove(KEYS.refresh);
  await store.remove(KEYS.user);
}

export async function hasSession(): Promise<boolean> {
  const t = await store.get(KEYS.access);
  return !!t;
}

// ---- Single-flight token refresh ----
// Refresh tokens are SINGLE-USE on the server (rotated on every refresh).
// If several requests 401 at once, only ONE refresh call may fire — the rest
// must await the same promise, or the losers would burn the rotated token
// and log the user out (the exact parallel-401 bug fixed on web, PR #138).
let refreshInFlight: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const refreshToken = await store.get(KEYS.refresh);
      if (!refreshToken) return false;
      const res = await fetch(`${API_URL}/hr/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      if (!data?.success || !data?.data?.accessToken) return false;
      await storeSession(data.data.accessToken, data.data.refreshToken ?? refreshToken, data.data.user);
      return true;
    } catch {
      return false;
    } finally {
      // allow the next expiry to refresh again
      setTimeout(() => {
        refreshInFlight = null;
      }, 0);
    }
  })();
  return refreshInFlight;
}

/** Set by AuthProvider — called when the session is unrecoverable (refresh failed). */
let onSessionExpired: (() => void) | null = null;
export function setSessionExpiredHandler(fn: () => void) {
  onSessionExpired = fn;
}

export async function apiFetch<T = any>(path: string, options: RequestInit = {}, _retried = false): Promise<T> {
  const token = await store.get(KEYS.access);

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers as Record<string, string>),
      },
    });
  } catch {
    throw new ApiError("Couldn't reach the server. Check your connection and try again.", "NETWORK_ERROR");
  }

  if (res.status === 401 && !_retried) {
    const ok = await tryRefresh();
    if (ok) return apiFetch<T>(path, options, true);
    await clearSession();
    onSessionExpired?.();
    throw new ApiError("Session expired. Please sign in again.", "UNAUTHORIZED");
  }

  const bodyText = await res.text();
  let data: any;
  try {
    data = JSON.parse(bodyText);
  } catch {
    if (res.status >= 500)
      throw new ApiError("The server returned an error. Please try again.", "SERVER_ERROR");
    throw new ApiError(`Unexpected server response (status ${res.status}).`, "NON_JSON_RESPONSE");
  }

  if (!data.success) {
    throw new ApiError(
      data.error?.message || (typeof data.error === "string" ? data.error : "API error"),
      data.error?.code,
      data.error?.details,
    );
  }
  return data.data as T;
}

// ---- Auth calls ----
export async function loginWithPassword(identifier: string, password: string) {
  const res = await fetch(`${API_URL}/hr/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier, password }),
  });
  const data = await res.json().catch(() => null);
  if (!data?.success) {
    throw new ApiError(data?.error?.message || "Invalid credentials", data?.error?.code, data?.error?.details);
  }
  const { accessToken, refreshToken, user } = data.data;
  await storeSession(accessToken, refreshToken, user);
  return user as SessionUser;
}

// ---- Date helpers (IST — matches server-side todayIST) ----
export function todayIST(): string {
  const now = new Date();
  const ist = new Date(now.getTime() + (330 + now.getTimezoneOffset()) * 60000);
  const y = ist.getFullYear();
  const m = String(ist.getMonth() + 1).padStart(2, "0");
  const d = String(ist.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso).slice(0, 10);
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return d.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

export const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function fmtMoney(n: number | null | undefined): string {
  if (n == null) return "—";
  return "₹" + n.toLocaleString("en-IN");
}
