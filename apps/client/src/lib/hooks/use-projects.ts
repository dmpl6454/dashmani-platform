import useSWR from "swr";
import { apiFetch } from "@/lib/api";

export function useClientProjects(params?: { status?: string; search?: string }) {
  const query = new URLSearchParams();
  if (params?.status) query.set("status", params.status);
  if (params?.search) query.set("search", params.search);
  query.set("limit", "100");
  return useSWR(`/client/projects?${query.toString()}`, (url) => apiFetch(url));
}

export function useClientProject(id: string) {
  return useSWR(id ? `/client/projects/${id}` : null, (url) => apiFetch(url));
}

export function useClientApprovals(params?: { status?: string }) {
  const query = new URLSearchParams();
  if (params?.status) query.set("status", params.status);
  query.set("limit", "100");
  return useSWR(`/client/approvals?${query.toString()}`, (url) => apiFetch(url));
}
