import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";

// Production API. Point at http://<your-mac-ip>:4000/v1 for local dev.
export const API_URL = "https://api.digitalsukoon.com/v1";
/** Base URL without /v1 — used for static file URLs like /uploads/ */
export const API_BASE = API_URL.replace(/\/v1\/?$/, "");

/** Which portal the session belongs to — mirrors the two web portals:
 *  "hr"    → hr.digitalsukoon.com     (employee portal, /hr/* endpoints)
 *  "admin" → portal.digitalsukoon.com (internal portal, /admin/* + RBAC endpoints)
 */
export type PortalMode = "hr" | "admin";

const KEYS = {
  mode: "portalMode",
  hr: { access: "hrAccessToken", refresh: "hrRefreshToken", user: "hrUser" },
  admin: { access: "accessToken", refresh: "refreshToken", user: "adminUser" },
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
  phone?: string | null;
  profileImageUrl: string | null;
  roles: string[];
};

// ---- Mode ----
let modeCache: PortalMode | null = null;

export async function getMode(): Promise<PortalMode> {
  if (modeCache) return modeCache;
  const m = await store.get(KEYS.mode);
  modeCache = m === "admin" ? "admin" : "hr";
  return modeCache;
}

export async function setMode(mode: PortalMode) {
  modeCache = mode;
  await store.set(KEYS.mode, mode);
}

function keysFor(mode: PortalMode) {
  return mode === "admin" ? KEYS.admin : KEYS.hr;
}

// ---- Session ----
export async function getStoredUser(mode?: PortalMode): Promise<SessionUser | null> {
  const m = mode ?? (await getMode());
  try {
    const raw = await store.get(keysFor(m).user);
    return raw ? (JSON.parse(raw) as SessionUser) : null;
  } catch {
    return null;
  }
}

export async function storeSession(mode: PortalMode, accessToken: string, refreshToken: string, user?: SessionUser) {
  const k = keysFor(mode);
  await store.set(k.access, accessToken);
  await store.set(k.refresh, refreshToken);
  if (user) await store.set(k.user, JSON.stringify(user));
}

export async function clearSession(mode?: PortalMode) {
  const m = mode ?? (await getMode());
  const k = keysFor(m);
  await store.remove(k.access);
  await store.remove(k.refresh);
  await store.remove(k.user);
}

export async function hasSession(mode?: PortalMode): Promise<boolean> {
  const m = mode ?? (await getMode());
  const t = await store.get(keysFor(m).access);
  return !!t;
}

// ---- Single-flight token refresh (per portal) ----
// Refresh tokens are SINGLE-USE on the server (rotated on every refresh).
// If several requests 401 at once, only ONE refresh call may fire — the rest
// must await the same promise, or the losers would burn the rotated token
// and log the user out (the exact parallel-401 bug fixed on web, PR #138).
const refreshInFlight: Partial<Record<PortalMode, Promise<boolean> | null>> = {};

async function tryRefresh(mode: PortalMode): Promise<boolean> {
  const existing = refreshInFlight[mode];
  if (existing) return existing;
  const p = (async () => {
    try {
      const k = keysFor(mode);
      const refreshToken = await store.get(k.refresh);
      if (!refreshToken) return false;
      const endpoint = mode === "admin" ? "/auth/refresh" : "/hr/auth/refresh";
      const res = await fetch(`${API_URL}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      if (!data?.success || !data?.data?.accessToken) return false;
      await storeSession(mode, data.data.accessToken, data.data.refreshToken ?? refreshToken, data.data.user);
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => {
        refreshInFlight[mode] = null;
      }, 0);
    }
  })();
  refreshInFlight[mode] = p;
  return p;
}

/** Set by AuthProvider — called when the session is unrecoverable (refresh failed). */
let onSessionExpired: (() => void) | null = null;
export function setSessionExpiredHandler(fn: () => void) {
  onSessionExpired = fn;
}

export async function apiFetch<T = any>(path: string, options: RequestInit = {}, _retried = false): Promise<T> {
  const mode = await getMode();
  const token = await store.get(keysFor(mode).access);

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
    const ok = await tryRefresh(mode);
    if (ok) return apiFetch<T>(path, options, true);
    await clearSession(mode);
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
export async function loginWithPassword(mode: PortalMode, identifier: string, password: string) {
  const endpoint = mode === "admin" ? "/auth/login" : "/hr/auth/login";
  const body =
    mode === "admin" ? { email: identifier, password } : { identifier, password };
  let res: Response;
  try {
    res = await fetch(`${API_URL}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError("Couldn't reach the server. Check your connection and try again.", "NETWORK_ERROR");
  }
  const data = await res.json().catch(() => null);
  if (!data?.success) {
    throw new ApiError(data?.error?.message || "Invalid credentials", data?.error?.code, data?.error?.details);
  }
  const { accessToken, refreshToken, user } = data.data;
  const sessionUser: SessionUser = {
    id: user.id,
    name: user.name,
    email: user.email ?? null,
    phone: user.phone ?? null,
    profileImageUrl: user.profileImageUrl ?? null,
    roles: Array.isArray(user.roles)
      ? user.roles.map((r: any) => (typeof r === "string" ? r : r?.role?.name ?? r?.name ?? "")).filter(Boolean)
      : [],
  };
  await storeSession(mode, accessToken, refreshToken, sessionUser);
  await setMode(mode);
  return sessionUser;
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

/** N days before today (IST), as YYYY-MM-DD */
export function daysAgoIST(n: number): string {
  const now = new Date();
  const ist = new Date(now.getTime() + (330 + now.getTimezoneOffset()) * 60000 - n * 86400000);
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

export function fmtCompact(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "b";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "m";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}
