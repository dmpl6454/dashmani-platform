// API client for the creator portal. `apiFetch<T>()` returns the full `{success, data}`
// envelope; callers read `.data`. Never define a local apiFetch in a page — a copy reading the
// wrong storage key silently sends no Authorization header.
import type { CreatorSession } from "./types";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/v1";

export const TOKEN_KEYS = {
  access: "creatorAccessToken",
  refresh: "creatorRefreshToken",
  user: "creatorUser",
} as const;

/**
 * The signed-in pages (and anything under them). Only these are guarded: a signed-out visitor is
 * sent to /login?next=. Every other path renders publicly — including unknown ones, so a
 * mistyped URL shows the 404 page instead of the sign-in form.
 */
export const PRIVATE_ROUTES = ["/dashboard", "/connect", "/settings"];

export function isPrivatePath(path: string): boolean {
  const p = path.length > 1 ? path.replace(/\/+$/, "") : path;
  return PRIVATE_ROUTES.some((r) => p === r || p.startsWith(`${r}/`));
}

export interface ApiEnvelope<T> {
  success: true;
  data: T;
  meta?: Record<string, unknown>;
}

/**
 * A failed API call. `message` is the most useful line for a person (a validation failure's
 * first field message rather than the envelope's generic "Invalid request data"); `code`,
 * `details` and `status` let a caller place it on a field or swap in its own sentence.
 */
/**
 * sessionStorage key for a Facebook connect result (`state=…&code=…`) that arrived while signed
 * out: the guard keeps it across the sign-in, and /connect finishes it. Same tab only, removed
 * as soon as it is read.
 */
export const PENDING_CONNECT_KEY = "creatorPendingConnect";

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

export function storeSession(session: CreatorSession) {
  storeTokens(session.accessToken, session.refreshToken);
  localStorage.setItem(TOKEN_KEYS.user, JSON.stringify(session.creator));
}

/**
 * Replace this device's tokens and leave the cached creator as it is — for responses that issue
 * a fresh pair without a whole session (a password change signs out every other device and
 * hands this one new tokens; keeping the old pair would sign the creator out an hour later).
 */
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

export function hasSession(): boolean {
  return !!(read(TOKEN_KEYS.access) && read(TOKEN_KEYS.user));
}

/** Public auth endpoints whose 401 means "wrong credentials / bad token", never "session expired". */
const ANSWERS_401 = new Set([
  "/creator/auth/login",
  "/creator/auth/signup",
  "/creator/auth/google",
  "/creator/auth/refresh",
  "/creator/auth/logout",
  "/creator/auth/forgot-password",
  "/creator/auth/reset-password",
  "/creator/auth/verify-email",
]);

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
    throw new ApiError("Couldn't reach Digital Sukoon — check your connection and try again.", "NETWORK", undefined, 0);
  }

  let data: any;
  try {
    data = await res.json();
  } catch {
    throw badResponse(res.status);
  }

  if (!data?.success) {
    // A 401 from a sign-in form (wrong password) is an answer, not an expired session: only
    // try a refresh when we actually sent an access token to a signed-in route. At most ONE
    // refresh per request: if the retry with fresh tokens is refused too, the session is not
    // usable and the creator signs in again (never an endless refresh-and-retry loop).
    if (res.status === 401 && token && !ANSWERS_401.has(path.split("?")[0]) && typeof window !== "undefined") {
      if (!_retried && (await tryRefresh())) return apiFetch<T>(path, options, true);
      clearSession();
      const here = window.location.pathname + window.location.search;
      const keep = isPrivatePath(window.location.pathname);
      window.location.href = keep ? `/login?next=${encodeURIComponent(here)}` : "/login";
    }
    throw apiErrorFrom(data, res.status);
  }

  return data as ApiEnvelope<T>;
}

/**
 * Single-flight, cross-tab-safe token refresh (the client portal's pattern, see
 * apps/client/src/lib/api.ts for the two historic sign-out bugs it closes).
 *
 * The refresh token is SINGLE-USE and a page that loads with an expired access token fires
 * several requests that all 401 at once. Every concurrent caller in this tab awaits the SAME
 * promise; across tabs the Web Lock serialises refreshes, and after acquiring it we first check
 * whether another tab already rotated the tokens — if so we use them instead of spending the
 * (already consumed) refresh token a second time and signing everyone out.
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
    // Already rotated by another tab while we waited on the lock.
    if (read(TOKEN_KEYS.access) !== staleAccess) return true;
    const refreshToken = read(TOKEN_KEYS.refresh);
    if (!refreshToken) return false;
    try {
      const res = await fetch(`${API_URL}/creator/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
      let data: { success?: boolean; data?: { accessToken: string; refreshToken: string } };
      try { data = await res.json(); } catch { return false; }
      if (data?.success && data.data) {
        localStorage.setItem(TOKEN_KEYS.access, data.data.accessToken);
        localStorage.setItem(TOKEN_KEYS.refresh, data.data.refreshToken);
        return true;
      }
    } catch { /* refresh failed */ }
    return false;
  };
  try {
    const locks = (navigator as unknown as { locks?: { request: (name: string, cb: () => Promise<boolean>) => Promise<boolean> } }).locks;
    if (locks?.request) return await locks.request("dashmani-creator-token-refresh", run);
  } catch { /* Web Locks unavailable — per-tab single flight still applies */ }
  return run();
}

/** SWR fetcher: unwraps the envelope. */
export const fetcher = <T,>(path: string) => apiFetch<T>(path).then((r) => r.data);
