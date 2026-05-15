import useSWR from "swr";
import { apiFetch } from "@/lib/api";

export interface ClientFile {
  id: string;
  name: string;
  url: string;
  size: number;
  mimeType: string | null;
  createdAt: string;
  project: { id: string; name: string };
  uploadedBy: { id: string; name: string };
}

export function useClientFiles(projectId?: string, search?: string) {
  const params = new URLSearchParams();
  if (projectId) params.set("projectId", projectId);
  if (search) params.set("search", search);
  const query = params.toString();
  return useSWR<ClientFile[]>(
    `/client/files${query ? `?${query}` : ""}`,
    async (url: string) => (await apiFetch<ClientFile[]>(url)).data
  );
}
