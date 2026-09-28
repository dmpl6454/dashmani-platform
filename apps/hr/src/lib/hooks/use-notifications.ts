import useSWR from "swr";
import { apiFetch } from "@/lib/api";

/**
 * Unread count for the bell badge. This is the ONLY bell request while the
 * panel is closed (one per 30 s per tab).
 */
export function useNotificationCount() {
  return useSWR("/hr/notifications/count", (url: string) => apiFetch(url), { refreshInterval: 30000 });
}

/** SWR key of the bell list — exported so a caller can update the cache while the panel is closed. */
export const NOTIFICATION_LIST_KEY = "/hr/notifications";

/**
 * The bell's 50-row list, fetched ONLY while the panel is open (P3).
 *
 * The list used to poll every 30 s even while the panel was closed, doubling
 * the bell's share of the site-wide rate-limit bucket that login, HR submit and
 * Link History depend on. `keepPreviousData` keeps the last loaded rows on
 * screen while a reopen revalidates, so the panel never flashes a false
 * "No notifications yet". `errorRetryCount` bounds retries on a failing API.
 */
export function useNotificationList(open: boolean) {
  return useSWR(open ? NOTIFICATION_LIST_KEY : null, (url: string) => apiFetch(url), {
    keepPreviousData: true,
    revalidateOnFocus: false,
    errorRetryCount: 3,
  });
}
