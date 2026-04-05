import useSWR from "swr";
import { apiFetch } from "@/lib/api";

export function useClients(params?: { search?: string; status?: string }) {
  const query = new URLSearchParams();
  if (params?.search) query.set("search", params.search);
  if (params?.status) query.set("status", params.status);
  query.set("limit", "100");
  return useSWR(`/clients?${query.toString()}`, (url) => apiFetch(url));
}

export function useClient(id: string) {
  return useSWR(id ? `/clients/${id}` : null, (url) => apiFetch(url));
}
