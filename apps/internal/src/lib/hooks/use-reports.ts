import useSWR from "swr";
import { apiFetch } from "@/lib/api";

export function useAdminReports(filters?: {
  employeeId?: string;
  startDate?: string;
  endDate?: string;
  accountId?: string;
  page?: number;
  pageSize?: number;
}) {
  const params = new URLSearchParams();
  if (filters?.employeeId) params.set("employeeId", filters.employeeId);
  if (filters?.startDate) params.set("startDate", filters.startDate);
  if (filters?.endDate) params.set("endDate", filters.endDate);
  if (filters?.accountId) params.set("accountId", filters.accountId);
  if (filters?.page) params.set("page", String(filters.page));
  if (filters?.pageSize) params.set("pageSize", String(filters.pageSize));
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

// True Links / cross-employee duplicates for the window. The endpoint always
// returns the TEAM-WIDE breakdown (dup detection is inherently cross-employee);
// when the page has an employee selected, the card derives that employee's view
// from their byEmployee row client-side — no extra param, one cache entry per
// window, and the server's 60s TTL cache stays maximally effective.
export function useTrueLinks(startDate?: string, endDate?: string) {
  const params = new URLSearchParams();
  if (startDate) params.set("startDate", startDate);
  if (endDate) params.set("endDate", endDate);
  const query = params.toString() ? `?${params.toString()}` : "";
  // Plausibility gate: typing a custom date fires onChange per COMMITTED segment,
  // and a mid-edit year like "0002" would otherwise mint a fresh SWR key whose
  // near-epoch window costs a full-table aggregation server-side. The platform
  // has no data before 2025, so implausible windows simply don't fetch (SWR key
  // null); the moment the typed date becomes real, the fetch fires as normal.
  const plausible =
    (!startDate || startDate >= "2025-01-01") && (!endDate || endDate >= "2025-01-01");
  return useSWR(plausible ? `/admin/reports/true-links${query}` : null, (url) => apiFetch(url), {
    revalidateOnFocus: false,
    dedupingInterval: 60_000,
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

// `enabled` (default true) lets a page keep the hook mounted while its panel is hidden
// (Links Analytics' "Submission gaps" tab): false = null SWR key = no request, so
// changing the range there does not also refetch the hidden Overview. That matters
// here: links-analytics loads every link in the window.
export function useLinksAnalytics(startDate?: string, endDate?: string, enabled = true) {
  const params = new URLSearchParams();
  if (startDate) params.set("startDate", startDate);
  if (endDate) params.set("endDate", endDate);
  const query = params.toString() ? `?${params.toString()}` : "";
  return useSWR(enabled ? `/admin/reports/links-analytics${query}` : null, (url) => apiFetch(url), {
    revalidateOnFocus: false,
    dedupingInterval: 60_000,
  });
}

export function useLinksAllAccounts(startDate?: string, endDate?: string, enabled = true) {
  const params = new URLSearchParams();
  if (startDate) params.set("startDate", startDate);
  if (endDate) params.set("endDate", endDate);
  const query = params.toString() ? `?${params.toString()}` : "";
  return useSWR(enabled ? `/admin/reports/links-by-account${query}` : null, (url) => apiFetch(url), {
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

// Fair per-platform leaderboards (YouTube/Facebook by views, Instagram by likes+comments).
// Backend: GET /admin/reports/platform-leaderboards → getPlatformLeaderboards().
// Returns Record<platformKey, Array<{rank, employee:{id,name,...}, views, likes, comments, rankMetric}>>.
export function usePlatformLeaderboards(startDate?: string, endDate?: string) {
  const params = new URLSearchParams();
  if (startDate) params.set("startDate", startDate);
  if (endDate) params.set("endDate", endDate);
  const query = params.toString() ? `?${params.toString()}` : "";
  return useSWR(`/admin/reports/platform-leaderboards${query}`, (url) => apiFetch(url), {
    revalidateOnFocus: false,
    dedupingInterval: 300_000,
  });
}

export function useTopYouTubeLinks(startDate?: string, endDate?: string, limit = 20, enabled = true) {
  const params = new URLSearchParams();
  if (startDate) params.set("startDate", startDate);
  if (endDate) params.set("endDate", endDate);
  params.set("limit", String(limit));
  const query = `?${params.toString()}`;
  return useSWR(enabled ? `/admin/reports/top-youtube-links${query}` : null, (url) => apiFetch(url), {
    revalidateOnFocus: false,
    dedupingInterval: 300_000,
  });
}

// (Removed 2026-06-30) useTopSnapchatLinks — Snapchat has no engagement-ranked Top
// Links (no server-readable views/likes); the submission-count variant was dropped.

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

// Submission gaps (Links Analytics → "Submission gaps" tab). ⚠️ LAZY by contract: the
// caller passes enabled=false until the tab is opened, so the Links Analytics page's
// normal load never fires this request. team/platform are server-side filters (they
// change the per-employee "no link on ANY channel" aggregates); name search, the
// minimum-missed filter and sorting are client-side over the loaded rows.
// Capped error retries: a 503 REPORTS_BUSY is worth two quiet retries, not a loop.
export function useSubmissionGaps(
  enabled: boolean,
  params: { startDate: string; endDate: string; teamId?: string; platform?: string },
) {
  const qs = new URLSearchParams({ startDate: params.startDate, endDate: params.endDate });
  if (params.teamId) qs.set("teamId", params.teamId);
  if (params.platform) qs.set("platform", params.platform);
  // Same plausibility gate as useTrueLinks: a half-typed custom year must not mint a
  // request (the server would 400 an over-long range anyway).
  const span =
    (Date.parse(`${params.endDate}T00:00:00Z`) - Date.parse(`${params.startDate}T00:00:00Z`)) / 86_400_000 + 1;
  const plausible =
    params.startDate >= "2025-01-01" && params.endDate >= params.startDate && span >= 1 && span <= 366;
  return useSWR(
    enabled && plausible ? `/admin/reports/submission-gaps?${qs.toString()}` : null,
    (url: string) => apiFetch(url),
    { revalidateOnFocus: false, dedupingInterval: 60_000, errorRetryCount: 2, errorRetryInterval: 4_000 },
  );
}

// Day-by-day drill-down for one (employee, channel) — fetched only when a row expands,
// then ONE small request per navigation (a month arrow, or a custom range once the
// debounced dates are valid). Months already seen come back from SWR's cache.
//
// keepPreviousData keeps the last window's days on screen while the next one loads, so
// the view never flashes empty. ⚠️ It also means `data` can describe the PREVIOUS window:
// callers must compare the response's echoed range/pair with the one they asked for
// before labelling or exporting it (see ChannelDays in _gap-days.tsx).
export function useSubmissionGapDays(
  key: { employeeId: string; accountId: string; startDate: string; endDate: string } | null,
) {
  // Same plausibility gate as useSubmissionGaps: a window the API would 400 never becomes
  // a request (the view validates first; this is the backstop).
  const span = key
    ? (Date.parse(`${key.endDate}T00:00:00Z`) - Date.parse(`${key.startDate}T00:00:00Z`)) / 86_400_000 + 1
    : 0;
  const plausible = !!key && key.startDate >= "2025-01-01" && span >= 1 && span <= 366;
  const url = plausible && key
    ? `/admin/reports/submission-gaps/days?${new URLSearchParams(key).toString()}`
    : null;
  return useSWR(url, (u: string) => apiFetch(u), {
    revalidateOnFocus: false,
    dedupingInterval: 60_000,
    errorRetryCount: 2,
    errorRetryInterval: 4_000,
    keepPreviousData: true,
  });
}
