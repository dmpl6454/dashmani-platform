// API envelope contract:
// `apiFetch<T>()` returns the full `{success, data, meta?}` envelope.
// Hooks under `lib/hooks/` are responsible for unwrapping:
//   - Non-paginated routes: hook returns `data` (the unwrapped T).
//   - Paginated routes: hook returns `{ items: T[], meta }`.
// Pages and components consume hook return values directly — no `?.data` reads.
const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/v1";

export interface ApiEnvelope<T> {
  success: true;
  data: T;
  meta?: { cursor?: string; has_more?: boolean };
}

export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<ApiEnvelope<T>> {
  const token = typeof window !== "undefined" ? localStorage.getItem("clientAccessToken") : null;

  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });

  const data = await res.json();

  if (!data.success) {
    if (res.status === 401 && typeof window !== "undefined") {
      const refreshed = await tryRefresh();
      if (refreshed) return apiFetch(path, options);
      localStorage.removeItem("clientAccessToken");
      localStorage.removeItem("clientRefreshToken");
      window.location.href = "/login";
    }
    throw new Error(data.error?.message || "API error");
  }

  return data as ApiEnvelope<T>;
}

/** Upload a file via multipart/form-data. Returns the unwrapped data on success. */
export async function uploadFile<T>(path: string, formData: FormData): Promise<T> {
  const token = typeof window !== "undefined" ? localStorage.getItem("clientAccessToken") : null;
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: formData,
  });
  const data = await res.json();
  if (!data.success) {
    throw new Error(data.error?.message || "Upload failed");
  }
  return data.data as T;
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
let refreshInFlight: Promise<boolean> | null = null;

function tryRefresh(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = doRefresh().finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

async function doRefresh(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  const staleAccess = localStorage.getItem("clientAccessToken");
  const run = async (): Promise<boolean> => {
    // Another tab may have refreshed while we waited on the lock — its new
    // tokens are already in localStorage. Use them rather than consuming the
    // rotated (already-spent) refresh token and logging everyone out.
    if (localStorage.getItem("clientAccessToken") !== staleAccess) return true;
    const refreshToken = localStorage.getItem("clientRefreshToken");
    if (!refreshToken) return false;
    try {
      const res = await fetch(`${API_URL}/client/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
      // Guard the parse — a 502 HTML page is not JSON, and an unguarded
      // res.json() here is the documented "Load failed" crash class.
      let data: { success?: boolean; data?: { accessToken: string; refreshToken: string } };
      try { data = await res.json(); } catch { return false; }
      if (data?.success && data.data) {
        localStorage.setItem("clientAccessToken", data.data.accessToken);
        localStorage.setItem("clientRefreshToken", data.data.refreshToken);
        return true;
      }
    } catch { /* refresh failed */ }
    return false;
  };
  try {
    const locks = (navigator as unknown as { locks?: { request: (name: string, cb: () => Promise<boolean>) => Promise<boolean> } }).locks;
    if (locks?.request) return await locks.request("dashmani-token-refresh", run);
  } catch { /* Web Locks unavailable — per-tab single flight still applies */ }
  return run();
}
