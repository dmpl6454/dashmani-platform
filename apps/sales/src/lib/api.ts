// API client for the sales portal. `apiFetch<T>()` returns the full `{success, data}` envelope;
// callers read `.data`. Never define a local apiFetch in a page — a copy reading the wrong
// storage key silently sends no Authorization header (the documented HR-portal bug class).
//
// Staff sign in with their portal account (POST /v1/auth/login); tokens live under the same
// keys the internal portal uses. This is its own origin, so storage never collides with it.
import type { StaffSession, StaffUser } from "./types";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/v1";

export const TOKEN_KEYS = {
  access: "accessToken",
  refresh: "refreshToken",
  user: "user",
} as const;

/** Everything is signed-in except these. */
export const PUBLIC_ROUTES = ["/login"];

export function isPrivatePath(path: string): boolean {
  const p = path.length > 1 ? path.replace(/\/+$/, "") : path;
  return !PUBLIC_ROUTES.some((r) => p === r || p.startsWith(`${r}/`));
}

export interface ApiEnvelope<T> {
  success: true;
  data: T;
  meta?: Record<string, unknown>;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public code?: string,
    public details?: Array<{ field?: string; message: string }>,
    public status?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** A non-JSON body (an nginx 502 page while the API restarts) must not surface as "Unexpected token <". */
function badResponse(status: number): ApiError {
  return new ApiError(
    status >= 500 ? "The server is restarting — try again in a moment." : "Unexpected response from the server — try again.",
    "BAD_RESPONSE",
    undefined,
    status,
  );
}

function apiErrorFrom(data: any, status: number): ApiError {
  const details: ApiError["details"] = Array.isArray(data?.error?.details) ? data.error.details : undefined;
  const fallback = status === 429 ? "Too many attempts — try again in a few minutes." : "Something went wrong. Please try again.";
  return new ApiError(details?.[0]?.message || data?.error?.message || fallback, data?.error?.code, details, status);
}

function read(key: string): string | null {
  try { return typeof window !== "undefined" ? localStorage.getItem(key) : null; } catch { return null; }
}

export function storeSession(session: StaffSession) {
  storeTokens(session.accessToken, session.refreshToken);
  try { localStorage.setItem(TOKEN_KEYS.user, JSON.stringify(session.user)); } catch { /* storage blocked */ }
}

export function storeTokens(accessToken: string, refreshToken: string) {
  try {
    localStorage.setItem(TOKEN_KEYS.access, accessToken);
    localStorage.setItem(TOKEN_KEYS.refresh, refreshToken);
  } catch { /* storage blocked */ }
}

export function clearSession() {
  try {
    localStorage.removeItem(TOKEN_KEYS.access);
    localStorage.removeItem(TOKEN_KEYS.refresh);
    localStorage.removeItem(TOKEN_KEYS.user);
  } catch { /* storage blocked */ }
}

export function readStoredUser(): StaffUser | null {
  try {
    if (!read(TOKEN_KEYS.access)) return null;
    const raw = read(TOKEN_KEYS.user);
    return raw ? (JSON.parse(raw) as StaffUser) : null;
  } catch {
    return null; // storage blocked or a malformed stored user: treat as signed out
  }
}

export function hasSession(): boolean {
  return !!(read(TOKEN_KEYS.access) && read(TOKEN_KEYS.user));
}

/** Public auth endpoints whose 401 means "wrong credentials / bad token", never "session expired". */
const ANSWERS_401 = new Set(["/auth/login", "/auth/refresh", "/auth/logout", "/auth/forgot-password", "/auth/reset-password"]);

function sendToLogin() {
  const here = window.location.pathname + window.location.search;
  window.location.href = isPrivatePath(window.location.pathname) ? `/login?next=${encodeURIComponent(here)}` : "/login";
}

export async function apiFetch<T>(path: string, options: RequestInit = {}, _retried = false): Promise<ApiEnvelope<T>> {
  const token = read(TOKEN_KEYS.access);

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
    });
  } catch {
    throw new ApiError("Couldn't reach the server — check your connection and try again.", "NETWORK", undefined, 0);
  }

  let data: any;
  try {
    data = await res.json();
  } catch {
    throw badResponse(res.status);
  }

  if (!data?.success) {
    // At most ONE refresh per request; a 401 from the sign-in form itself is an answer.
    if (res.status === 401 && token && !ANSWERS_401.has(path.split("?")[0]) && typeof window !== "undefined") {
      if (!_retried && (await tryRefresh())) return apiFetch<T>(path, options, true);
      clearSession();
      sendToLogin();
    }
    throw apiErrorFrom(data, res.status);
  }

  return data as ApiEnvelope<T>;
}

/**
 * A binary download (an invoice PDF, a CSV). On success returns the Blob plus the filename the
 * server suggested (Content-Disposition). On 401 it refreshes once, like apiFetch.
 */
export async function apiFetchBlob(path: string, _retried = false): Promise<{ blob: Blob; filename: string | null }> {
  const token = read(TOKEN_KEYS.access);
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  } catch {
    throw new ApiError("Couldn't reach the server — check your connection and try again.", "NETWORK", undefined, 0);
  }
  if (!res.ok) {
    if (res.status === 401 && token && typeof window !== "undefined") {
      if (!_retried && (await tryRefresh())) return apiFetchBlob(path, true);
      clearSession();
      sendToLogin();
    }
    let message = "Download failed";
    try {
      const data = await res.json();
      message = data?.error?.message || message;
    } catch { /* not JSON */ }
    throw new ApiError(message, undefined, undefined, res.status);
  }
  const cd = res.headers.get("Content-Disposition") || "";
  const match = cd.match(/filename="?([^"]+)"?/i);
  return { blob: await res.blob(), filename: match ? match[1] : null };
}

/** Triggers a browser download of a Blob with the given filename. */
export function downloadBlob(blob: Blob, filename: string) {
  if (typeof window === "undefined") return;
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
}

/**
 * Single-flight, cross-tab-safe token refresh — the pattern shared by every portal (see
 * apps/internal/src/lib/api.ts for the two historic sign-out bugs it closes). The refresh
 * token is SINGLE-USE; every concurrent caller in this tab awaits the SAME promise, the Web
 * Lock serialises tabs, and after acquiring it we first check whether another tab already
 * rotated the tokens.
 */
let refreshInFlight: Promise<boolean> | null = null;

function tryRefresh(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = doRefresh().finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

async function doRefresh(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  const staleAccess = read(TOKEN_KEYS.access);
  const run = async (): Promise<boolean> => {
    if (read(TOKEN_KEYS.access) !== staleAccess) return true; // another tab rotated already
    const refreshToken = read(TOKEN_KEYS.refresh);
    if (!refreshToken) return false;
    try {
      const res = await fetch(`${API_URL}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
      let data: { success?: boolean; data?: { accessToken: string; refreshToken: string } };
      try { data = await res.json(); } catch { return false; }
      if (data?.success && data.data) {
        storeTokens(data.data.accessToken, data.data.refreshToken);
        return true;
      }
    } catch { /* refresh failed */ }
    return false;
  };
  try {
    const locks = (navigator as unknown as { locks?: { request: (name: string, cb: () => Promise<boolean>) => Promise<boolean> } }).locks;
    if (locks?.request) return await locks.request("dashmani-sales-token-refresh", run);
  } catch { /* Web Locks unavailable — per-tab single flight still applies */ }
  return run();
}

/** SWR fetcher: unwraps the envelope. */
export const fetcher = <T,>(path: string) => apiFetch<T>(path).then((r) => r.data);
