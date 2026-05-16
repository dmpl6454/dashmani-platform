import useSWR from "swr";
import { apiFetch } from "@/lib/api";

export function useAnnouncements(page = 1) {
  const { data, error, isLoading, mutate } = useSWR(
    `/admin/announcements?page=${page}&limit=20`,
    (url: string) => apiFetch<any>(url)
  );
  return {
    announcements: (data?.data?.items ?? []) as any[],
    total: (data?.data?.total ?? 0) as number,
    isLoading,
    isError: !!error,
    mutate,
  };
}
