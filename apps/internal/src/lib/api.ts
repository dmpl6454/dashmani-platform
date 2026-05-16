const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/v1";
/** Base URL without /v1 — used for static file URLs like /uploads/ */
export const API_BASE = API_URL.replace(/\/v1\/?$/, "");

let isRefreshing = false;

function clearAuthAndRedirect() {
  if (typeof window === "undefined") return;
  localStorage.removeItem("accessToken");
  localStorage.removeItem("refreshToken");
  localStorage.removeItem("user");
  window.location.href = "/login";
}

export async function apiFetch<T>(path: string, options: RequestInit = {}, _retried = false): Promise<T> {
  const token = typeof window !== "undefined" ? localStorage.getItem("accessToken") : null;

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
    if (res.status === 401 && typeof window !== "undefined" && !_retried) {
      const refreshed = await tryRefresh();
      if (refreshed) {
        return apiFetch(path, options, true);
      }
      clearAuthAndRedirect();
      throw new Error("Session expired");
    }
    throw new Error(data.error?.message || "API error");
  }

  return data;
}

export async function apiUpload<T>(path: string, formData: FormData, _retried = false): Promise<T> {
  const token = typeof window !== "undefined" ? localStorage.getItem("accessToken") : null;

  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: formData,
  });

  const data = await res.json();

  if (!data.success) {
    if (res.status === 401 && typeof window !== "undefined" && !_retried) {
      const refreshed = await tryRefresh();
      if (refreshed) {
        return apiUpload(path, formData, true);
      }
      clearAuthAndRedirect();
      throw new Error("Session expired");
    }
    throw new Error(data.error?.message || "Upload failed");
  }

  return data;
}

async function tryRefresh(): Promise<boolean> {
  if (isRefreshing) return false;
  const refreshToken = typeof window !== "undefined" ? localStorage.getItem("refreshToken") : null;
  if (!refreshToken) return false;

  isRefreshing = true;
  try {
    const res = await fetch(`${API_URL}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    const data = await res.json();
    if (data.success) {
      localStorage.setItem("accessToken", data.data.accessToken);
      localStorage.setItem("refreshToken", data.data.refreshToken);
      return true;
    }
  } catch { /* refresh failed */ }
  finally { isRefreshing = false; }
  return false;
}
