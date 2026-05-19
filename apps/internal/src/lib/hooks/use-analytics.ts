import useSWR from "swr";
import { apiFetch } from "@/lib/api";

// Pass startDate/endDate only when they represent a real user-selected range.
// The dashboard always initialises to the default 14-day window; passing those
// dates would make isCustomRange=true in the service for the default view,
// causing a redundant "In Range" chip to appear on every page load.
export function useOverviewStats(startDate?: string, endDate?: string, isCustomRange?: boolean) {
  const params = new URLSearchParams();
  if (isCustomRange && startDate) params.set("startDate", startDate);
  if (isCustomRange && endDate) params.set("endDate", endDate);
  const query = params.toString() ? `?${params.toString()}` : "";
  return useSWR(`/analytics/overview${query}`, (url) => apiFetch(url), {
    refreshInterval: 120000,
    revalidateOnFocus: false,
    dedupingInterval: 60000,
  });
}

export function useTaskAnalytics(projectId?: string) {
  const query = projectId ? `?projectId=${projectId}` : "";
  return useSWR(`/analytics/tasks${query}`, (url) => apiFetch(url));
}

export function useContentAnalytics() {
  return useSWR("/analytics/content", (url) => apiFetch(url));
}

export function useProjectAnalytics(projectId?: string) {
  const query = projectId ? `?projectId=${projectId}` : "";
  return useSWR(`/analytics/projects${query}`, (url) => apiFetch(url));
}

export function useAttendanceAnalytics(startDate?: string, endDate?: string) {
  const params = new URLSearchParams();
  if (startDate) params.set("startDate", startDate);
  if (endDate) params.set("endDate", endDate);
  const query = params.toString() ? `?${params.toString()}` : "";
  return useSWR(`/analytics/attendance${query}`, (url) => apiFetch(url));
}
