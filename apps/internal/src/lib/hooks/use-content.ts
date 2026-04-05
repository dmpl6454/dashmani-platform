import useSWR from "swr";
import { apiFetch } from "@/lib/api";

export function useContentPosts(params?: {
  status?: string;
  projectId?: string;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
}) {
  const query = new URLSearchParams();
  if (params?.status) query.set("status", params.status);
  if (params?.projectId) query.set("projectId", params.projectId);
  if (params?.search) query.set("search", params.search);
  if (params?.dateFrom) query.set("dateFrom", params.dateFrom);
  if (params?.dateTo) query.set("dateTo", params.dateTo);
  query.set("limit", "100");

  return useSWR(`/content?${query.toString()}`, (url) => apiFetch(url));
}

export function useContentPost(id: string) {
  return useSWR(id ? `/content/${id}` : null, (url) => apiFetch(url));
}

export function useContentCalendar(year: number, month: number, projectId?: string) {
  const query = new URLSearchParams();
  query.set("year", String(year));
  query.set("month", String(month));
  if (projectId) query.set("projectId", projectId);

  return useSWR(`/content/calendar?${query.toString()}`, (url) => apiFetch(url));
}
