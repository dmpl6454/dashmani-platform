import useSWR from "swr";
import { apiFetch } from "@/lib/api";

export function useTodayReport() {
  return useSWR("/hr/reports/today", (path) => apiFetch<any>(path), {
    refreshInterval: 60000,
  });
}

export function useMyReports(startDate?: string, endDate?: string) {
  let path = "/hr/reports";
  const params = new URLSearchParams();
  if (startDate) params.set("startDate", startDate);
  if (endDate) params.set("endDate", endDate);
  const query = params.toString();
  if (query) path += `?${query}`;
  return useSWR(path, (p) => apiFetch<any>(p));
}
