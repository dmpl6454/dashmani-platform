import useSWR from "swr";
import { apiFetch } from "@/lib/api";

export interface Pagination { cursor?: string; has_more?: boolean }

export function useClientProjects(params?: { status?: string; search?: string }) {
  const query = new URLSearchParams();
  if (params?.status) query.set("status", params.status);
  if (params?.search) query.set("search", params.search);
  query.set("limit", "100");
  return useSWR<{ items: any[]; meta: Pagination | undefined }>(
    `/client/projects?${query.toString()}`,
    async (url: string) => {
      const env = await apiFetch<any[]>(url);
      return { items: env.data, meta: env.meta };
    }
  );
}

export function useClientProject(id: string) {
  return useSWR<any>(
    id ? `/client/projects/${id}` : null,
    async (url: string) => (await apiFetch<any>(url)).data
  );
}
