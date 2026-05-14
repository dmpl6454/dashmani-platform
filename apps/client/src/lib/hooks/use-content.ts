import useSWR from "swr";
import { apiFetch } from "@/lib/api";

export function useClientContent(params?: { projectId?: string; status?: string; search?: string }) {
  const query = new URLSearchParams();
  if (params?.projectId) query.set("projectId", params.projectId);
  if (params?.status) query.set("status", params.status);
  if (params?.search) query.set("search", params.search);
  query.set("limit", "100");
  return useSWR(`/client/content?${query.toString()}`, (url) => apiFetch(url));
}

export function useClientContentPost(id: string) {
  return useSWR(id ? `/client/content/${id}` : null, (url) => apiFetch(url));
}

export function useClientContentCalendar(year: number, month: number, projectId?: string) {
  const query = new URLSearchParams();
  query.set("year", String(year));
  query.set("month", String(month));
  if (projectId) query.set("projectId", projectId);
  return useSWR(`/client/content/calendar?${query.toString()}`, (url) => apiFetch(url));
}
