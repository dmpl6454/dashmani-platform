import useSWR from "swr";
import { apiFetch } from "@/lib/api";

export function useNotifications(unreadOnly?: boolean) {
  const query = unreadOnly ? "?unreadOnly=true" : "";
  return useSWR(`/hr/notifications${query}`, (url: string) => apiFetch(url), { refreshInterval: 30000 });
}

export function useUnreadCount() {
  return useSWR("/hr/notifications/count", (url: string) => apiFetch(url), { refreshInterval: 30000 });
}
