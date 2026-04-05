import useSWR from "swr";
import { apiFetch } from "@/lib/api";

export function useAdminReports(filters?: {
  employeeId?: string;
  startDate?: string;
  endDate?: string;
  accountId?: string;
}) {
  const params = new URLSearchParams();
  if (filters?.employeeId) params.set("employeeId", filters.employeeId);
  if (filters?.startDate) params.set("startDate", filters.startDate);
  if (filters?.endDate) params.set("endDate", filters.endDate);
  if (filters?.accountId) params.set("accountId", filters.accountId);
  const query = params.toString() ? `?${params.toString()}` : "";
  return useSWR(`/admin/reports${query}`, (url) => apiFetch(url), {
    refreshInterval: 30000,
  });
}

export function useReportSummary(startDate?: string, endDate?: string) {
  const params = new URLSearchParams();
  if (startDate) params.set("startDate", startDate);
  if (endDate) params.set("endDate", endDate);
  const query = params.toString() ? `?${params.toString()}` : "";
  return useSWR(`/admin/reports/summary${query}`, (url) => apiFetch(url));
}
