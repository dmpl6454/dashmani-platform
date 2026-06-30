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

export function useInsightsSummary(startDate?: string, endDate?: string, employeeId?: string) {
  const params = new URLSearchParams();
  if (startDate) params.set("startDate", startDate);
  if (endDate) params.set("endDate", endDate);
  if (employeeId) params.set("employeeId", employeeId);
  const query = params.toString() ? `?${params.toString()}` : "";
  return useSWR(`/admin/reports/insights-summary${query}`, (url) => apiFetch(url), {
    revalidateOnFocus: false,
    dedupingInterval: 300_000,
  });
}

export function useTopYouTubeLinks(startDate?: string, endDate?: string, limit = 20) {
  const params = new URLSearchParams();
  if (startDate) params.set("startDate", startDate);
  if (endDate) params.set("endDate", endDate);
  params.set("limit", String(limit));
  const query = `?${params.toString()}`;
  return useSWR(`/admin/reports/top-youtube-links${query}`, (url) => apiFetch(url), {
    revalidateOnFocus: false,
    dedupingInterval: 300_000,
  });
}

export function useTopSnapchatLinks(startDate?: string, endDate?: string, limit = 20) {
  const params = new URLSearchParams();
  if (startDate) params.set("startDate", startDate);
  if (endDate) params.set("endDate", endDate);
  params.set("limit", String(limit));
  const query = `?${params.toString()}`;
  return useSWR(`/admin/reports/top-snapchat-links${query}`, (url) => apiFetch(url), {
    revalidateOnFocus: false,
    dedupingInterval: 300_000,
  });
}

// Generalized top-links hook — one per platform (youtube|instagram|facebook).
// YouTube sorts by views server-side; instagram/facebook by likes+comments.
// A platform with no links in the window returns [] and its panel simply hides.
export function useTopLinks(platform: string, startDate?: string, endDate?: string, limit = 20) {
  const params = new URLSearchParams();
  params.set("platform", platform);
  if (startDate) params.set("startDate", startDate);
  if (endDate) params.set("endDate", endDate);
  params.set("limit", String(limit));
  const query = `?${params.toString()}`;
  return useSWR(`/admin/reports/top-links${query}`, (url) => apiFetch(url), {
    revalidateOnFocus: false,
    dedupingInterval: 300_000,
  });
}
