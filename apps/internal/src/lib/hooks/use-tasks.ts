import useSWR from "swr";
import { apiFetch } from "@/lib/api";

export function useTasks(params?: { status?: string; priority?: string; assigneeId?: string; search?: string }) {
  const query = new URLSearchParams();
  if (params?.status) query.set("status", params.status);
  if (params?.priority) query.set("priority", params.priority);
  if (params?.assigneeId) query.set("assigneeId", params.assigneeId);
  if (params?.search) query.set("search", params.search);
  query.set("limit", "100");

  return useSWR(`/tasks?${query.toString()}`, (url) => apiFetch(url));
}

export function useTask(id: string) {
  return useSWR(id ? `/tasks/${id}` : null, (url) => apiFetch(url));
}
