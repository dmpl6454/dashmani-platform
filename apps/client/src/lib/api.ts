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

async function tryRefresh(): Promise<boolean> {
  const refreshToken = localStorage.getItem("clientRefreshToken");
  if (!refreshToken) return false;

  try {
    const res = await fetch(`${API_URL}/client/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    const data = await res.json();
    if (data.success) {
      localStorage.setItem("clientAccessToken", data.data.accessToken);
      localStorage.setItem("clientRefreshToken", data.data.refreshToken);
      return true;
    }
  } catch { /* refresh failed */ }
  return false;
}
