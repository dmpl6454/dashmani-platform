const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/v1";
/** Base URL without /v1 — used for static file URLs like /uploads/ */
export const API_BASE = API_URL.replace(/\/v1\/?$/, "");

/** Structured error that preserves per-field validation details from the API */
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

export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = typeof window !== "undefined" ? localStorage.getItem("hrAccessToken") : null;

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
    // fetch() itself threw — connection reset / DNS / CORS / offline.
    // In Safari this is the literal "Load failed" TypeError. Surface something actionable.
    throw new ApiError(
      "Couldn't reach the server. Check your connection and try again — your data was not saved.",
      "NETWORK_ERROR",
    );
  }

  // 401 refresh path is keyed on the HTTP STATUS, not the parsed body, so it works
  // even when the 401 response has a non-JSON body.
  if (res.status === 401 && typeof window !== "undefined") {
    const refreshed = await tryRefresh();
    if (refreshed) {
      return apiFetch(path, options);
    }
    localStorage.removeItem("hrAccessToken");
    localStorage.removeItem("hrRefreshToken");
    localStorage.removeItem("hrUser");
    window.location.href = "/login";
    throw new ApiError("Session expired. Please sign in again.", "UNAUTHORIZED");
  }

  // Read the body defensively. A proxy timeout / 5xx / 413 often returns HTML,
  // which would make res.json() throw a SyntaxError that surfaces as "Load failed".
  const bodyText = await res.text();
  let data: any;
  try {
    data = JSON.parse(bodyText);
  } catch {
    if (res.status === 413) {
      throw new ApiError("Your submission is too large for the server to accept.", "PAYLOAD_TOO_LARGE");
    }
    if (res.status >= 500) {
      throw new ApiError(
        "The server took too long or returned an error. Your data was not saved — please try again.",
        "SERVER_ERROR",
      );
    }
    throw new ApiError(`Unexpected server response (status ${res.status}). Please try again.`, "NON_JSON_RESPONSE");
  }

  if (!data.success) {
    throw new ApiError(
      data.error?.message || "API error",
      data.error?.code,
      data.error?.details,
    );
  }

  return data;
}

export async function apiUpload<T>(path: string, formData: FormData): Promise<T> {
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
    );
  }

  if (res.status === 401 && typeof window !== "undefined") {
    const refreshed = await tryRefresh();
    if (refreshed) {
      return apiUpload(path, formData);
    }
    localStorage.removeItem("hrAccessToken");
    localStorage.removeItem("hrRefreshToken");
    localStorage.removeItem("hrUser");
    window.location.href = "/login";
    throw new ApiError("Session expired. Please sign in again.", "UNAUTHORIZED");
  }

  const bodyText = await res.text();
  let data: any;
  try {
    data = JSON.parse(bodyText);
  } catch {
    if (res.status === 413) {
      throw new ApiError("Your file is too large for the server to accept.", "PAYLOAD_TOO_LARGE");
    }
    if (res.status >= 500) {
      throw new ApiError("The server returned an error. Your file was not uploaded — please try again.", "SERVER_ERROR");
    }
    throw new ApiError(`Unexpected server response (status ${res.status}). Please try again.`, "NON_JSON_RESPONSE");
  }

  if (!data.success) {
    throw new ApiError(data.error?.message || "Upload failed", data.error?.code, data.error?.details);
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
    let data: any;
    try {
      const text = await res.text();
      data = JSON.parse(text);
    } catch {
      return false;
    }
    if (data.success) {
      localStorage.setItem("hrAccessToken", data.data.accessToken);
      localStorage.setItem("hrRefreshToken", data.data.refreshToken);
      return true;
    }
  } catch { /* refresh failed */ }
  return false;
}
