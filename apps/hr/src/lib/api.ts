const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/v1";

export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = typeof window !== "undefined" ? localStorage.getItem("hrAccessToken") : null;

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
      if (refreshed) {
        return apiFetch(path, options);
      }
      localStorage.removeItem("hrAccessToken");
      localStorage.removeItem("hrRefreshToken");
      localStorage.removeItem("hrUser");
      window.location.href = "/login";
    }
    throw new Error(data.error?.message || "API error");
  }

  return data;
}

async function tryRefresh(): Promise<boolean> {
  const refreshToken = localStorage.getItem("hrRefreshToken");
  if (!refreshToken) return false;

  try {
    const res = await fetch(`${API_URL}/hr/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    const data = await res.json();
    if (data.success) {
      localStorage.setItem("hrAccessToken", data.data.accessToken);
      localStorage.setItem("hrRefreshToken", data.data.refreshToken);
      return true;
    }
  } catch { /* refresh failed */ }
  return false;
}
