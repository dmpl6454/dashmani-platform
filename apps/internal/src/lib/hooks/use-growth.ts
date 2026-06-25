import useSWR from "swr";
import { apiFetch } from "@/lib/api";

export function useGrowthOverview(days = 30) {
  return useSWR(`/admin/growth?days=${days}`, (url) => apiFetch(url), {
    revalidateOnFocus: false,
    dedupingInterval: 300_000,
  });
}

export function useAccountGrowth(accountId: string | null, days = 30) {
  return useSWR(
    accountId ? `/admin/growth/${accountId}?days=${days}` : null,
    (url) => apiFetch(url),
    { revalidateOnFocus: false, dedupingInterval: 300_000 },
  );
}
