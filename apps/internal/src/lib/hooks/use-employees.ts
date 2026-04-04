import useSWR from "swr";
import { apiFetch } from "@/lib/api";

export function useEmployees(params?: { search?: string; status?: string; cursor?: string }) {
  const query = new URLSearchParams();
  if (params?.search) query.set("search", params.search);
  if (params?.status) query.set("status", params.status);
  if (params?.cursor) query.set("cursor", params.cursor);

  return useSWR(`/employees?${query.toString()}`, (url) => apiFetch(url));
}

export function useEmployee(id: string) {
  return useSWR(id ? `/employees/${id}` : null, (url) => apiFetch(url));
}
