import useSWR from "swr";
import { apiFetch } from "@/lib/api";

export function useProjects(params?: { clientId?: string; status?: string; search?: string }) {
  const query = new URLSearchParams();
  if (params?.clientId) query.set("clientId", params.clientId);
  if (params?.status) query.set("status", params.status);
  if (params?.search) query.set("search", params.search);
  query.set("limit", "100");
  return useSWR(`/projects?${query.toString()}`, (url) => apiFetch(url));
}

export function useProject(id: string) {
  return useSWR(id ? `/projects/${id}` : null, (url) => apiFetch(url));
}
