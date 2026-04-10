const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000/v1";
export const API_BASE = API_URL.replace(/\/v1\/?$/, "");

export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const data = await res.json();
  if (!data.success) {
    throw new Error(data.error?.message || "API error");
  }
  return data;
}

export async function apiUpload<T>(path: string, formData: FormData): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    body: formData,
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error?.message || "Upload failed");
  return data;
}
