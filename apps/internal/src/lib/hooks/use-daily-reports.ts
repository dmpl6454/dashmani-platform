import useSWR from "swr";
import { apiFetch } from "@/lib/api";

/** Submitted written daily reports for a given date (default: today). */
export function useDailyReports(date?: string, employeeId?: string) {
  const q = new URLSearchParams();
  if (date) q.set("date", date);
  if (employeeId) q.set("employeeId", employeeId);
  const key = `/admin/poa?${q.toString()}`;
  return useSWR(key, (url) => apiFetch(url), {
    revalidateOnFocus: false,
    dedupingInterval: 30_000,
  });
}

/** Today's submission status: who submitted, who hasn't. */
export function useDailyReportStatus(date?: string) {
  const q = new URLSearchParams();
  if (date) q.set("date", date);
  const key = `/admin/daily-reports/status?${q.toString()}`;
  return useSWR(key, (url) => apiFetch(url), {
    revalidateOnFocus: false,
    dedupingInterval: 30_000,
  });
}
