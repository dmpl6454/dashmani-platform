import useSWR from "swr";
import { apiFetch } from "@/lib/api";

export function useAccounts(params?: { platformId?: string; status?: string; search?: string }) {
  const query = new URLSearchParams();
  if (params?.platformId) query.set("platformId", params.platformId);
  if (params?.status) query.set("status", params.status);
  if (params?.search) query.set("search", params.search);
  query.set("limit", "100");

  return useSWR(`/accounts?${query.toString()}`, (url) => apiFetch(url));
}

export function useAccount(id: string) {
  return useSWR(id ? `/accounts/${id}` : null, (url) => apiFetch(url));
}

export function usePlatforms() {
  return useSWR("/platforms", (url) => apiFetch(url));
}

export function useWorkload() {
  return useSWR("/workload", (url) => apiFetch(url));
}

export function useAccountLinkStats(id?: string, startDate?: string, endDate?: string) {
  const params = new URLSearchParams();
  if (startDate) params.set("startDate", startDate);
  if (endDate) params.set("endDate", endDate);
  const query = params.toString() ? `?${params.toString()}` : "";
  return useSWR(
    id ? `/accounts/${id}/link-stats${query}` : null,
    (url) => apiFetch(url),
    { revalidateOnFocus: false, dedupingInterval: 120_000 },
  );
}
