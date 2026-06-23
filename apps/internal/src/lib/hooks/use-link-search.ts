import useSWR from "swr";
import { apiFetch } from "@/lib/api";

export interface LinkSearchData {
  entity: { id: string; canonicalName: string; type: string; aliases: string[] } | null;
  disambiguation?: Array<{ id: string; canonicalName: string; type: string }>;
  totalPosts: number;
  uniquePosts: number;
  duplicatePosts: number;
  channelCount: number;
  channels: Array<{ accountId: string; handle: string; displayName: string; platform: string; postCount: number }>;
  posts: Array<{ canonicalKey: string; url: string; platform: string; account: { id: string; handle: string; displayName: string }; employee: { id: string; name: string }; date: string; dupCount: number }>;
  coverage: { enriched: number; notYetEnriched: number; total: number; byPlatform: Record<string, { enriched: number; total: number; since?: string }> };
  truncated?: boolean;
}

export function useLinkSearch(q: string) {
  const trimmed = q.trim();
  const query = trimmed ? `?q=${encodeURIComponent(trimmed)}` : "";
  // Always fetch (even empty q) so the coverage banner shows before the first search.
  return useSWR<LinkSearchData>(
    `/admin/link-search${query}`,
    (url) => apiFetch(url).then((r: any) => r.data ?? r),
    { revalidateOnFocus: false, dedupingInterval: 30_000, keepPreviousData: true },
  );
}

export interface EntitySuggestion { id: string; canonicalName: string; type: string }

export function useEntitySuggestions(q: string) {
  const trimmed = q.trim();
  return useSWR<EntitySuggestion[]>(
    trimmed.length >= 2 ? `/admin/entities?q=${encodeURIComponent(trimmed)}` : null,
    (url) => apiFetch(url).then((r: any) => r.data ?? r),
    { revalidateOnFocus: false, dedupingInterval: 30_000 },
  );
}
