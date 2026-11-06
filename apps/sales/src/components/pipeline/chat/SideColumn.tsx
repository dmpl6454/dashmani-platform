"use client";
/**
 * The Pipeline's left column (desktop), shown ONLY inside a campaign — its project page or one
 * of its channels: the campaign's own sidebar (or the collapsed rail). Everywhere else (board,
 * My work, team-wide chats) there is no column (owner, 2026-11-03).
 */
import { usePathname, useSearchParams } from "next/navigation";
import { usePipeline } from "../provider";
import { useStoreSelector } from "../store";
import { ChatRail } from "./ChatSidebar";
import { CampaignSidebar } from "./CampaignSidebar";

export function SideColumn({ collapsed, onCollapse, onExpand }: { collapsed: boolean; onCollapse: () => void; onExpand: () => void }) {
  const pathname = usePathname();
  const id = useSearchParams().get("id");
  const { store } = usePipeline();
  // A channel page: its campaign, once its header is loaded (null for a team-wide channel or a DM).
  const parent = useStoreSelector(store, (s) =>
    pathname === "/pipeline/chat" && id ? s.projects[id]?.header?.parentProjectId ?? null : null,
  );
  const parentTitle = useStoreSelector(store, (s) =>
    pathname === "/pipeline/chat" && id ? s.projects[id]?.header?.parentTitle ?? null : null,
  );
  const campaignId = pathname === "/pipeline/view" && id ? id : parent;

  if (!campaignId) return null;
  return (
    <aside className={`hidden lg:block ${collapsed ? "w-[52px]" : "w-[240px]"} shrink-0 min-h-0 border-r border-rule bg-surface pl-scroll`}>
      {collapsed ? (
        <ChatRail onExpand={onExpand} />
      ) : (
        <CampaignSidebar key={campaignId} campaignId={campaignId} fallbackTitle={parentTitle} onCollapse={onCollapse} />
      )}
    </aside>
  );
}
