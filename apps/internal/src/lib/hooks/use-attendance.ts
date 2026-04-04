import useSWR from "swr";
import { apiFetch } from "@/lib/api";

export function useAttendance(params?: { employeeId?: string; startDate?: string; endDate?: string }) {
  const query = new URLSearchParams();
  if (params?.employeeId) query.set("employeeId", params.employeeId);
  if (params?.startDate) query.set("startDate", params.startDate);
  if (params?.endDate) query.set("endDate", params.endDate);

  return useSWR(`/attendance?${query.toString()}`, (url) => apiFetch(url));
}
