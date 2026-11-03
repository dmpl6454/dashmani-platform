"use client";
/**
 * Chat data for the sidebar and the conversation page (sales portal only).
 *
 * - The conversation LIST comes from GET /pipeline/conversations (SWR, request-once like the
 *   directory). Its unread counts are then overlaid LIVE from the sync's `mine` overlay, which
 *   already carries every channel and DM I'm in — so no extra polling for unread.
 * - A conversation the list doesn't know yet (someone DMs me for the first time) shows up in
 *   `mine` with kind channel/dm: that re-fetches the list once.
 * - Presence (green dots) is the one poll here: GET /pipeline/presence every 30 s while the
 *   tab is visible. It is answered from memory on the API (no database statement).
 */
import { useEffect, useMemo } from "react";
import useSWR from "swr";
import type { PipelineCampaignChannelsResponse, PipelineConversations } from "@dashmani/shared";
import { PL_SWR } from "@/lib/pipeline-swr";
import { usePipeline } from "../provider";
import { useStoreSelector } from "../store";
import { plApi } from "../api";

export const chatHref = (id: string) => `/pipeline/chat?id=${encodeURIComponent(id)}`;

export function useConversations() {
  const { meId, store } = usePipeline();
  const swr = useSWR<PipelineConversations>(["/pipeline/conversations", meId], () => plApi.conversations(), {
    ...PL_SWR,
    revalidateOnFocus: true,
  });
  const mine = useStoreSelector(store, (s) => s.mine?.entries ?? null);

  // A channel or DM in the live overlay that the list doesn't have yet → refresh the list.
  const known = useMemo(() => {
    const ids = new Set<string>();
    for (const c of swr.data?.channels ?? []) ids.add(c.id);
    for (const d of swr.data?.dms ?? []) ids.add(d.id);
    for (const c of swr.data?.campaignChannelIds ?? []) ids.add(c);
    for (const d of swr.data?.hiddenDmIds ?? []) ids.add(d);
    return ids;
  }, [swr.data]);
  const hidden = useMemo(() => new Set(swr.data?.hiddenDmIds ?? []), [swr.data]);
  const unknown = useMemo(() => {
    if (!mine || !swr.data) return "";
    return Object.values(mine)
      // New to the list, or a DM I deleted that has a new (unread) message — it comes back.
      .filter((e) => (e.kind === "channel" || e.kind === "dm") && (!known.has(e.projectId) || (hidden.has(e.projectId) && e.unread > 0)))
      .map((e) => e.projectId)
      .sort()
      .join(",");
  }, [mine, known, hidden, swr.data]);
  const { mutate } = swr;
  useEffect(() => {
    if (unknown) void mutate();
  }, [unknown, mutate]);

  /** Live unread for a conversation: the overlay when it has the row, else the list's count. */
  const unreadOf = (id: string, fallback: number) => mine?.[id]?.unread ?? fallback;
  return { ...swr, unreadOf };
}

/** A campaign's channels (its own sidebar), with the same live unread overlay. */
export function useCampaignChannels(projectId: string | null) {
  const { meId, store } = usePipeline();
  const swr = useSWR<PipelineCampaignChannelsResponse>(
    projectId ? ["/pipeline/campaign-channels", meId, projectId] : null,
    () => plApi.campaignChannels(projectId!),
    { ...PL_SWR, revalidateOnFocus: true },
  );
  const mine = useStoreSelector(store, (s) => s.mine?.entries ?? null);
  const unreadOf = (id: string, fallback: number) => mine?.[id]?.unread ?? fallback;
  return { ...swr, unreadOf };
}

export function usePresence(): ReadonlySet<string> {
  const { meId } = usePipeline();
  const { data } = useSWR(["/pipeline/presence", meId], () => plApi.presence(), {
    ...PL_SWR,
    refreshInterval: 30_000,
    refreshWhenHidden: false,
    dedupingInterval: 10_000,
  });
  return useMemo(() => new Set(data?.online ?? []), [data]);
}
