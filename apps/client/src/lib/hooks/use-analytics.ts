import useSWR from "swr";
import { apiFetch } from "@/lib/api";

export interface ClientAnalytics {
  totalPosts: number;
  postsByStatus: Record<string, number>;
  postsByFormat: Record<string, number>;
  approvalTurnaround: number;
  scheduledThisWeek: number;
  liveThisWeek: number;
  projectSummaries: {
    projectId: string;
    name: string;
    healthScore: number | null;
    postCount: number;
    pendingCount: number;
  }[];
}

export function useClientAnalytics() {
  return useSWR<ClientAnalytics>(
    "/client/analytics",
    async (url: string) => (await apiFetch<ClientAnalytics>(url)).data,
    { refreshInterval: 60000 }
  );
}
