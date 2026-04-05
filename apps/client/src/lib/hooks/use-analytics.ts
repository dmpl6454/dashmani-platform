import useSWR from "swr";
import { apiFetch } from "@/lib/api";

export function useClientAnalytics() {
  return useSWR("/client/analytics", (url) => apiFetch(url), {
    refreshInterval: 60000,
  });
}
