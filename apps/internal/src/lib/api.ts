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

/**
 * Fetches a binary file download (e.g. an .xlsx export). On success returns the
 * Blob plus the server-suggested filename (parsed from Content-Disposition).
 * On 401 it retries once after a token refresh, mirroring apiFetch. On any
 * error the API returns the normal JSON envelope, which we surface as an Error.
 */
export async function apiFetchBlob(
  path: string,
  _retried = false,
): Promise<{ blob: Blob; filename: string | null }> {
  const token = typeof window !== "undefined" ? localStorage.getItem("accessToken") : null;

  const res = await fetch(`${API_URL}${path}`, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });

  if (!res.ok) {
    if (res.status === 401 && typeof window !== "undefined" && !_retried) {
      const refreshed = await tryRefresh();
      if (refreshed) {
        return apiFetchBlob(path, true);
      }
      clearAuthAndRedirect();
      throw new Error("Session expired");
    }
    // Error responses are JSON envelopes; try to extract the message.
    let message = "Download failed";
    try {
      const data = await res.json();
      message = data?.error?.message || message;
    } catch { /* not JSON */ }
    throw new Error(message);
  }

  // Parse filename from: Content-Disposition: attachment; filename="x.xlsx"
  const cd = res.headers.get("Content-Disposition") || "";
  const match = cd.match(/filename="?([^"]+)"?/i);
  const filename = match ? match[1] : null;

  const blob = await res.blob();
  return { blob, filename };
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
