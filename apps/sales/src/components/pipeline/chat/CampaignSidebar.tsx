"use client";
/**
 * The left column INSIDE a campaign (a Pipeline project): ← All campaigns, the campaign's name
 * with its phase and due date, its channels — "# general" is the campaign's own thread, then
 * the channels created in it — "+ Add channel", and Direct messages below.
 *
 * Shown on /pipeline/view?id=<campaign> and on /pipeline/chat?id=<a channel of that campaign>
 * (app/pipeline/layout.tsx decides). Phones get the channel list as a tab on the project page
 * (CampaignChannelList).
 */
import { useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ChevronLeft, Hash } from "lucide-react";
import { dayMonthShort } from "@dashmani/shared";
import { usePipeline, usePhases } from "../provider";
import { useStoreSelector } from "../store";
import { useLocalDayKey } from "../hooks/use-local-day-key";
import { useCampaignChannels } from "./use-chat";
import { NewChannelSheet } from "./NewChannelSheet";
import { AddRow, ChannelRow, ColumnHead, DmSection, SectionToggle, rowClass, useActiveChatId } from "./ChatSidebar";
import { DeleteChannelSheet, type DeletableChannel } from "./DeleteChannelSheet";

/** The campaign's channel list: "# general" (its thread) + its channels + "Add channel". */
export function CampaignChannelList({
  campaignId,
  campaignTitle,
  onOpenGeneral,
}: {
  campaignId: string;
  campaignTitle: string;
  /** Phones: "# general" is the Conversation tab of the page already open. */
  onOpenGeneral?: () => void;
}) {
  const pathname = usePathname();
  const viewId = useSearchParams().get("id");
  const activeChat = useActiveChatId();
  const { data, error, mutate, unreadOf } = useCampaignChannels(campaignId);
  const [creating, setCreating] = useState(false);
  const [toDelete, setToDelete] = useState<DeletableChannel | null>(null);
  const onGeneral = pathname === "/pipeline/view" && viewId === campaignId;
  return (
    <>
      <ul>
        <li>
          {onOpenGeneral ? (
            <button type="button" onClick={onOpenGeneral} className={`${rowClass(false, false)} w-[calc(100%-1rem)]`}>
              <Hash size={15} aria-hidden className="shrink-0" />
              <span className="truncate">general</span>
            </button>
          ) : (
            <Link href={`/pipeline/view?id=${encodeURIComponent(campaignId)}`} className={rowClass(onGeneral, false)} aria-current={onGeneral ? "page" : undefined}>
              <Hash size={15} aria-hidden className="shrink-0" />
              <span className="truncate">general</span>
            </Link>
          )}
        </li>
        {error && !data ? (
          <li className="px-5 py-2 text-[12.5px] text-ink-3">
            Couldn&apos;t load channels.{" "}
            <button type="button" className="underline" onClick={() => void mutate()}>
              Retry
            </button>
          </li>
        ) : null}
        {data?.channels.map((c) => {
          const active = activeChat === c.id;
          return (
            <ChannelRow
              key={c.id}
              id={c.id}
              name={c.name}
              isPrivate={c.isPrivate}
              active={active}
              unread={active || !c.joined ? 0 : unreadOf(c.id, c.unread)}
              dim={!c.joined}
              title={c.joined ? undefined : "You're not in this channel yet — open it to join"}
              ownerId={c.ownerId}
              parentProjectId={campaignId}
              onDelete={setToDelete}
            />
          );
        })}
        <li>
          <AddRow label="Add channel" onClick={() => setCreating(true)} />
        </li>
      </ul>
      <NewChannelSheet open={creating} onClose={() => setCreating(false)} onCreated={() => void mutate()} campaign={{ id: campaignId, title: campaignTitle }} />
      <DeleteChannelSheet channel={toDelete} onClose={() => setToDelete(null)} />
    </>
  );
}

export function CampaignSidebar({ campaignId, fallbackTitle, onCollapse }: { campaignId: string; fallbackTitle?: string | null; onCollapse?: () => void }) {
  const { store } = usePipeline();
  const phases = usePhases();
  const today = useLocalDayKey();
  const header = useStoreSelector(store, (s) => s.projects[campaignId]?.header ?? null);
  const [open, setOpen] = useState(true);
  const title = header?.title ?? fallbackTitle ?? "Campaign";
  const phase = header ? phases.find((p) => p.id === header.phaseId)?.name : null;
  const due = header?.dueDate ? dayMonthShort(header.dueDate, today) : null;

  return (
    <nav aria-label={`${title} channels`} className="py-3">
      <ColumnHead label="Campaign" onCollapse={onCollapse} />
      <div className="pb-3 mb-2 border-b border-rule">
        <Link href="/pipeline" className="flex items-center gap-1 h-8 px-3 mx-2 text-[13px] text-ink-3 hover:text-ink">
          <ChevronLeft size={15} aria-hidden /> All campaigns
        </Link>
        <Link href={`/pipeline/view?id=${encodeURIComponent(campaignId)}`} className="block px-5 pt-1">
          <span className="block truncate text-[16px] font-bold text-ink" title={title}>
            {title}
          </span>
          {(phase || due) && (
            <span className="block truncate text-[12.5px] text-ink-3">
              {phase}
              {phase && due ? " · " : ""}
              {due ? `due ${due}` : ""}
            </span>
          )}
        </Link>
      </div>

      <SectionToggle label="Channels" open={open} onToggle={() => setOpen((v) => !v)} icon={<Hash size={15} aria-hidden />} />
      {open && <CampaignChannelList campaignId={campaignId} campaignTitle={title} />}

      <div className="mt-3" />
      <DmSection />
    </nav>
  );
}
