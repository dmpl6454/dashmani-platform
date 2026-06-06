import useSWR from "swr";
import { apiFetch } from "@/lib/api";

export function useAccounts(params?: { platformId?: string; status?: string; search?: string }) {
  const query = new URLSearchParams();
  if (params?.platformId) query.set("platformId", params.platformId);
  if (params?.status) query.set("status", params.status);
  if (params?.search) query.set("search", params.search);
  // Backend caps `limit` at 500 (apps/api/src/utils/pagination.ts). Prod has ~451
  // accounts, so 500 returns the whole list in one request — no silent truncation.
  // If the account count ever exceeds 500, the page surfaces a "narrow your search"
  // warning off `meta.has_more`, and this should move to cursor pagination.
  query.set("limit", "500");

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
