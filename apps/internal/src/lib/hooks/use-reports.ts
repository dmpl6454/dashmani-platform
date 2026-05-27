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
    revalidateOnFocus: false,
    dedupingInterval: 60_000,
  });
}

export function useEmployeePerformance(employeeId?: string) {
  return useSWR(
    employeeId ? `/admin/employees/${employeeId}/performance` : null,
    (url) => apiFetch(url),
    { refreshInterval: 60000 },
  );
}

export function useReportSummary(startDate?: string, endDate?: string) {
  const params = new URLSearchParams();
  if (startDate) params.set("startDate", startDate);
  if (endDate) params.set("endDate", endDate);
  const query = params.toString() ? `?${params.toString()}` : "";
  return useSWR(`/admin/reports/summary${query}`, (url) => apiFetch(url), {
    revalidateOnFocus: false,
    dedupingInterval: 300_000,
  });
}

export function useEmployeeReportStats(employeeId?: string, startDate?: string, endDate?: string) {
  const params = new URLSearchParams();
  if (startDate) params.set("startDate", startDate);
  if (endDate) params.set("endDate", endDate);
  const query = params.toString() ? `?${params.toString()}` : "";
  return useSWR(
    employeeId ? `/admin/reports/employee-stats/${employeeId}${query}` : null,
    (url) => apiFetch(url),
    { revalidateOnFocus: false, dedupingInterval: 60_000 },
  );
}

export function useLinksAnalytics(startDate?: string, endDate?: string) {
  const params = new URLSearchParams();
  if (startDate) params.set("startDate", startDate);
  if (endDate) params.set("endDate", endDate);
  const query = params.toString() ? `?${params.toString()}` : "";
  return useSWR(`/admin/reports/links-analytics${query}`, (url) => apiFetch(url));
}

export function useLinksAllAccounts(startDate?: string, endDate?: string) {
  const params = new URLSearchParams();
  if (startDate) params.set("startDate", startDate);
  if (endDate) params.set("endDate", endDate);
  const query = params.toString() ? `?${params.toString()}` : "";
  return useSWR(`/admin/reports/links-by-account${query}`, (url) => apiFetch(url), {
    revalidateOnFocus: false,
    dedupingInterval: 120_000,
  });
}
