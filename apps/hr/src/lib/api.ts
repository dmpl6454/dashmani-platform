// ⚠️ Import the module, NOT the "@dashmani/shared" barrel. This file is loaded by nearly
// every HR page, and the barrel drags in every zod validator: measured +16-17 kB of
// first-load JS on ~25 routes (e.g. /dashboard 115 -> 131 kB). The module is pure.
import { classifyRefreshOutcome, type RefreshOutcome } from "@dashmani/shared/src/pipeline/refresh";
import { purgePipelineStorage } from "./pipeline-storage";
import { loginHrefWithNext } from "./return-path";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/v1";
/** Base URL without /v1 — used for static file URLs like /uploads/ */
export const API_BASE = API_URL.replace(/\/v1\/?$/, "");

/**
 * Structured error that preserves per-field validation details from the API.
 *
 * `status` (P1) is the HTTP status, or 0 when no response arrived at all (offline, DNS,
 * CORS, connection reset). Pollers and SWR retry rules use it to tell 403, 429 and 5xx
 * apart. `retryAfterSec` is read from `body.error.retryAfterSec` when the API sends one.
 * Both are additive: `message`, `code` and `details` are unchanged.
 */
export class ApiError extends Error {
  code?: string;
  details?: Array<{ field: string; message: string }>;
  status: number;
  retryAfterSec?: number;
  constructor(
    message: string,
    code?: string,
    details?: Array<{ field: string; message: string }>,
    opts: { status?: number; retryAfterSec?: number } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.details = details;
    this.status = opts.status ?? 0;
    this.retryAfterSec = opts.retryAfterSec;
  }
}

/** Internal-only request option: set on the one retry that follows a successful refresh. */
type ApiFetchOptions = RequestInit & { _retried?: boolean };

function readRetryAfterSec(data: unknown): number | undefined {
  const v = (data as { error?: { retryAfterSec?: unknown } } | null)?.error?.retryAfterSec;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

const TRANSIENT_REFRESH_MESSAGE =
  "Couldn't reach the server to renew your session. You're still signed in — please try again in a moment. Nothing was saved.";

/** A refresh that failed for a reason that says nothing about the session (P1). */
function transientRefreshError(): ApiError {
  return new ApiError(TRANSIENT_REFRESH_MESSAGE, "NETWORK_RETRY", undefined, { status: 503 });
}

/**
 * The session is really over (the refresh endpoint refused, or a second consecutive 401).
 * Clear the HR auth keys and every Pipeline `pl:` key, then go to /login carrying the
 * page the user was on so they come back to it after signing in (P5 validates `next`).
 */
function endSession(): ApiError {
  localStorage.removeItem("hrAccessToken");
  localStorage.removeItem("hrRefreshToken");
  localStorage.removeItem("hrUser");
  purgePipelineStorage();
  window.location.href = loginHrefWithNext(window.location);
  return new ApiError("Session expired. Please sign in again.", "UNAUTHORIZED", undefined, { status: 401 });
}

export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const { _retried, ...init } = options;
  const token = typeof window !== "undefined" ? localStorage.getItem("hrAccessToken") : null;

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
  } catch {
    // fetch() itself threw — connection reset / DNS / CORS / offline.
    // In Safari this is the literal "Load failed" TypeError. Surface something actionable.
    throw new ApiError(
      "Couldn't reach the server. Check your connection and try again — your data was not saved.",
      "NETWORK_ERROR",
      undefined,
      { status: 0 },
    );
  }

  // 401 refresh path is keyed on the HTTP STATUS, not the parsed body, so it works
  // even when the 401 response has a non-JSON body.
  // ⚠️ P1: refresh AT MOST ONCE per request. Before, a request that 401'd even with a
  // freshly refreshed token looped forever, rotating the single-use refresh token and
  // burning the rate-limit bucket on every lap. A second consecutive 401 ends the session.
  if (res.status === 401 && typeof window !== "undefined") {
    if (!_retried) {
      const outcome = await tryRefresh();
      if (outcome === "ok") return apiFetch<T>(path, { ...init, _retried: true });
      // A network blip / 5xx / 429 during the refresh says nothing about the session:
      // keep the tokens and let the caller show its own retryable error.
      if (outcome === "transient") throw transientRefreshError();
    }
    throw endSession();
  }

  // Read the body defensively. A proxy timeout / 5xx / 413 often returns HTML,
  // which would make res.json() throw a SyntaxError that surfaces as "Load failed".
  const bodyText = await res.text();
  let data: any;
  try {
    data = JSON.parse(bodyText);
  } catch {
    const status = { status: res.status };
    if (res.status === 413) {
      throw new ApiError("Your submission is too large for the server to accept.", "PAYLOAD_TOO_LARGE", undefined, status);
    }
    if (res.status >= 500) {
      throw new ApiError(
        "The server took too long or returned an error. Your data was not saved — please try again.",
        "SERVER_ERROR",
        undefined,
        status,
      );
    }
    throw new ApiError(`Unexpected server response (status ${res.status}). Please try again.`, "NON_JSON_RESPONSE", undefined, status);
  }

  if (!data.success) {
    throw new ApiError(
      data.error?.message || "API error",
      data.error?.code,
      data.error?.details,
      { status: res.status, retryAfterSec: readRetryAfterSec(data) },
    );
  }

  return data;
}

export async function apiUpload<T>(path: string, formData: FormData, _retried = false): Promise<T> {
  const token = typeof window !== "undefined" ? localStorage.getItem("hrAccessToken") : null;

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: "POST",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: formData,
    });
  } catch {
    throw new ApiError(
      "Couldn't reach the server. Check your connection and try again — your file was not uploaded.",
      "NETWORK_ERROR",
      undefined,
      { status: 0 },
    );
  }

  // Same P1 rules as apiFetch: refresh at most once, keep the session on a transient failure.
  if (res.status === 401 && typeof window !== "undefined") {
    if (!_retried) {
      const outcome = await tryRefresh();
      if (outcome === "ok") return apiUpload<T>(path, formData, true);
      if (outcome === "transient") throw transientRefreshError();
    }
    throw endSession();
  }

  const bodyText = await res.text();
  let data: any;
  try {
    data = JSON.parse(bodyText);
  } catch {
    const status = { status: res.status };
    if (res.status === 413) {
      throw new ApiError("Your file is too large for the server to accept.", "PAYLOAD_TOO_LARGE", undefined, status);
    }
    if (res.status >= 500) {
      throw new ApiError("The server returned an error. Your file was not uploaded — please try again.", "SERVER_ERROR", undefined, status);
    }
    throw new ApiError(`Unexpected server response (status ${res.status}). Please try again.`, "NON_JSON_RESPONSE", undefined, status);
  }

  if (!data.success) {
    throw new ApiError(
      data.error?.message || "Upload failed",
      data.error?.code,
      data.error?.details,
      { status: res.status, retryAfterSec: readRetryAfterSec(data) },
    );
  }

  return data;
}

/**
 * Single-flight, cross-tab-safe token refresh.
 *
 * ⚠️ WHY THIS SHAPE. The refresh token is SINGLE-USE (the API rotates it and a
 * second consume gets a clean 401), and a page that loads with an expired 4h
 * access token fires many requests at once — every one 401s simultaneously.
 * Two historic bugs lived here, both ending in "I was signed out when I came
 * back to the portal":
 *
 *   1. `if (isRefreshing) return false` — the callers that LOST the in-module
 *      race were told the refresh failed and wiped localStorage, destroying the
 *      tokens the winner had just stored. Being signed out was CAUSED by the
 *      refresh succeeding in parallel.
 *   2. No gate at all (the HR/client variant) — N parallel refresh calls each
 *      consumed the same single-use token; the N-1 losers got 401 and logged
 *      the user out.
 *
 * The fix: every concurrent caller AWAITS THE SAME PROMISE and shares its
 * result. Across TABS (module state is per-tab) the Web Locks API serialises
 * refreshes, and after acquiring the lock we first re-check whether another
 * tab already rotated the tokens — if so we simply use them instead of
 * consuming the fresh token a second time. navigator.locks is supported by
 * every current browser; where absent we degrade to per-tab single-flight,
 * which is exactly the pre-existing best case.
 */
let refreshInFlight: Promise<RefreshOutcome> | null = null;

function tryRefresh(): Promise<RefreshOutcome> {
  if (!refreshInFlight) {
    refreshInFlight = doRefresh().finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

/**
 * P1: three outcomes, decided by `classifyRefreshOutcome` (packages/shared):
 *   ok         new tokens stored (or another tab already rotated them)
 *   rejected   the refresh endpoint refused with a JSON 4xx, or there is no refresh token
 *   transient  fetch threw, 429, any 5xx, or a non-JSON body — the session is NOT over
 * Never throws.
 */
async function doRefresh(): Promise<RefreshOutcome> {
  if (typeof window === "undefined") return "transient";
  const staleAccess = localStorage.getItem("hrAccessToken");
  const run = async (): Promise<RefreshOutcome> => {
    // Another tab may have refreshed while we waited on the lock — its new
    // tokens are already in localStorage. Use them rather than consuming the
    // rotated (already-spent) refresh token and logging everyone out.
    if (localStorage.getItem("hrAccessToken") !== staleAccess) return "ok";
    const refreshToken = localStorage.getItem("hrRefreshToken");
    if (!refreshToken) return "rejected";
    let res: Response;
    let data: unknown = null;
    let isJson = false;
    try {
      res = await fetch(`${API_URL}/hr/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
    } catch {
      return classifyRefreshOutcome({ threw: true });
    }
    // Guard the parse — a 502 HTML page is not JSON, and an unguarded
    // res.json() here is the documented "Load failed" crash class.
    try {
      data = JSON.parse(await res.text());
      isJson = data !== null && typeof data === "object";
    } catch { isJson = false; }
    const outcome = classifyRefreshOutcome({ threw: false, status: res.status, isJson });
    if (outcome !== "ok") return outcome;
    const body = data as { success?: boolean; data?: { accessToken?: unknown; refreshToken?: unknown } };
    const next = body.success ? body.data : undefined;
    if (typeof next?.accessToken === "string" && typeof next?.refreshToken === "string") {
      localStorage.setItem("hrAccessToken", next.accessToken);
      localStorage.setItem("hrRefreshToken", next.refreshToken);
      return "ok";
    }
    // A 2xx that carries no tokens is not a verdict on the session either.
    return "transient";
  };
  try {
    const locks = (navigator as unknown as { locks?: { request: (name: string, cb: () => Promise<RefreshOutcome>) => Promise<RefreshOutcome> } }).locks;
    if (locks?.request) return await locks.request("dashmani-token-refresh", run);
  } catch { /* Web Locks unavailable — per-tab single flight still applies */ }
  return run();
}
