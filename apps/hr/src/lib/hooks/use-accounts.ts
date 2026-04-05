import useSWR from "swr";
import { apiFetch } from "@/lib/api";

export function useAssignedAccounts() {
  return useSWR("/hr/accounts", (path) => apiFetch<any>(path));
}

export function useAccountGrowth(days?: number) {
  const path = days ? `/hr/growth?days=${days}` : "/hr/growth";
  return useSWR(path, (p) => apiFetch<any>(p));
}

export function useAccountGrowthDetail(accountId: string | null, days?: number) {
  const path = accountId
    ? days
      ? `/hr/growth/${accountId}?days=${days}`
      : `/hr/growth/${accountId}`
    : null;
  return useSWR(path, (p) => apiFetch<any>(p));
}
