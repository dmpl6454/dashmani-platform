import useSWR from "swr";
import { apiFetch } from "@/lib/api";
import type { Pagination } from "./use-projects";

export function useClientContent(params?: { projectId?: string; status?: string; search?: string }) {
  const query = new URLSearchParams();
  if (params?.projectId) query.set("projectId", params.projectId);
  if (params?.status) query.set("status", params.status);
  if (params?.search) query.set("search", params.search);
  query.set("limit", "100");
  return useSWR<{ items: any[]; meta: Pagination | undefined }>(
    `/client/content?${query.toString()}`,
    async (url: string) => {
      const env = await apiFetch<any[]>(url);
      return { items: env.data, meta: env.meta };
    },
    { revalidateOnFocus: false, dedupingInterval: 60_000 }
  );
}

// Single-source-of-truth pending approvals hook.
// Both the Approvals page and the sidebar badge consume this — SWR de-dupes the request.
export const PENDING_APPROVALS_KEY = "/client/content?status=PENDING_APPROVAL&limit=100";

export function useClientPendingApprovals() {
  return useSWR<any[]>(
    PENDING_APPROVALS_KEY,
    async (url: string) => (await apiFetch<any[]>(url)).data
  );
}

export function useClientContentPost(id: string) {
  return useSWR<any>(
    id ? `/client/content/${id}` : null,
    async (url: string) => (await apiFetch<any>(url)).data
  );
}

export function useClientContentCalendar(year: number, month: number, projectId?: string) {
  const query = new URLSearchParams();
  query.set("year", String(year));
  query.set("month", String(month));
  if (projectId) query.set("projectId", projectId);
  return useSWR<{ year: number; month: number; days: Record<string, any[]> }>(
    `/client/content/calendar?${query.toString()}`,
    async (url: string) => (await apiFetch<{ year: number; month: number; days: Record<string, any[]> }>(url)).data
  );
}

export function useClientPostComments(postId: string) {
  return useSWR<any[]>(
    postId ? `/client/content/${postId}/comments` : null,
    async (url: string) => (await apiFetch<any[]>(url)).data
  );
}
