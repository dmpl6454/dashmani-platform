"use client";
/**
 * The Slack-style chat list: Channels (# name, 🔒 when private, "+ Add channels") and Direct
 * messages (initials with a green dot when online, "you" on the self-DM, "+ New message").
 *
 * Desktop (lg+): a persistent left column in app/pipeline/layout.tsx. Phones: the same list
 * as the whole page at /pipeline/chat (no id) — `variant="page"`. Inside a campaign the
 * column is CampaignSidebar instead, which reuses the pieces exported here.
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ChevronDown, Hash, Inbox, KanbanSquare, Lock, MessagesSquare, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Plus, Trash2 } from "lucide-react";
import { usePipeline } from "../provider";
import { Initials } from "../ui/Initials";
import { Skeleton } from "../ui/Skeleton";
import { chatHref, useConversations, usePresence } from "./use-chat";
import { NewChannelSheet } from "./NewChannelSheet";
import { BrowseChannelsSheet } from "./BrowseChannelsSheet";
import { NewDmSheet } from "./NewDmSheet";
import { DeleteChannelSheet, canDeleteChannel, type DeletableChannel } from "./DeleteChannelSheet";
import { HideDmSheet, type HideableDm } from "./HideDmSheet";

// ── Shared pieces (also used by CampaignSidebar) ────────────────────────────────────

export function Badge({ n }: { n: number }) {
  if (n <= 0) return null;
  return (
    <span className="ml-auto shrink-0 min-w-[20px] h-5 px-1.5 rounded-full bg-indigo text-white text-[11px] font-bold grid place-items-center">
      {n > 99 ? "99+" : n}
      <span className="sr-only"> unread</span>
    </span>
  );
}

export const ROW = "group flex items-center gap-2 h-9 px-3 mx-2 text-[14px] min-w-0";

export const rowClass = (active: boolean, unread: boolean, dim = false) =>
  `${ROW} ${active ? "bg-indigo text-white" : unread ? "text-ink font-bold hover:bg-muted" : dim ? "text-ink-4 hover:bg-muted hover:text-ink-2" : "text-ink-2 hover:bg-muted"}`;

export function SectionToggle({ label, open, onToggle, icon }: { label: string; open: boolean; onToggle: () => void; icon: React.ReactNode }) {
  return (
    <button type="button" onClick={onToggle} aria-expanded={open} className="w-full flex items-center gap-2 h-9 px-3 text-[14px] font-semibold text-ink-2 hover:text-ink">
      <ChevronDown size={14} className={`transition-transform ${open ? "" : "-rotate-90"}`} aria-hidden />
      {icon}
      {label}
    </button>
  );
}

export function AddRow({ label, onClick, expanded }: { label: string; onClick: () => void; expanded?: boolean }) {
  return (
    <button type="button" onClick={onClick} aria-expanded={expanded} className={`${ROW} w-[calc(100%-1rem)] text-ink-3 hover:bg-muted hover:text-ink`}>
      <span className="grid place-items-center w-5 h-5 bg-muted text-ink-2">
        <Plus size={14} aria-hidden />
      </span>
      {label}
    </button>
  );
}

export function ChannelIcon({ isPrivate }: { isPrivate: boolean }) {
  return isPrivate ? <Lock size={14} aria-label="Private" className="shrink-0" /> : <Hash size={15} aria-hidden className="shrink-0" />;
}

/**
 * A list row with a ⋯ button (on hover, always on touch screens) that opens a one-item danger
 * menu — "Delete channel" / "Delete conversation". `children` is the row's link.
 */
function RowWithMenu({
  children,
  actionLabel,
  menuLabel,
  active,
  onAction,
}: {
  children: React.ReactNode;
  actionLabel: string | null;
  menuLabel: string;
  active: boolean;
  onAction: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const box = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setMenu(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [menu]);

  return (
    <li ref={box} className="relative group">
      {children}
      {actionLabel && (
        <button
          type="button"
          onClick={() => setMenu((v) => !v)}
          aria-label={menuLabel}
          aria-expanded={menu}
          className={`absolute right-3 top-1/2 -translate-y-1/2 h-7 w-7 grid place-items-center opacity-0 group-hover:opacity-100 focus:opacity-100 [@media(hover:none)]:opacity-100 ${
            menu ? "opacity-100" : ""
          } ${active ? "text-white hover:bg-white/15" : "text-ink-3 hover:bg-muted hover:text-ink"}`}
        >
          <MoreHorizontal size={16} aria-hidden />
        </button>
      )}
      {menu && actionLabel && (
        <div role="menu" className="absolute right-3 top-full z-30 mt-1 w-52 border border-border bg-surface shadow-pop">
          <button
            role="menuitem"
            type="button"
            className="w-full flex items-center gap-2 text-left px-3 h-10 text-[14px] text-danger hover:bg-danger-bg"
            onClick={() => {
              setMenu(false);
              onAction();
            }}
          >
            <Trash2 size={15} aria-hidden /> {actionLabel}
          </button>
        </div>
      )}
    </li>
  );
}

/** One channel in a list: opens it; ⋯ → "Delete channel" for the owner or an admin. */
export function ChannelRow({
  id,
  name,
  isPrivate,
  active,
  unread,
  dim = false,
  title,
  ownerId,
  parentProjectId = null,
  onDelete,
}: {
  id: string;
  name: string;
  isPrivate: boolean;
  active: boolean;
  unread: number;
  dim?: boolean;
  title?: string;
  ownerId?: string;
  parentProjectId?: string | null;
  onDelete: (c: DeletableChannel) => void;
}) {
  const { meId, boot } = usePipeline();
  const deletable = canDeleteChannel(ownerId, meId, boot.me.isAdmin === true);
  return (
    <RowWithMenu
      actionLabel={deletable ? "Delete channel" : null}
      menuLabel={`More actions for #${name}`}
      active={active}
      onAction={() => onDelete({ id, name, parentProjectId })}
    >
      <Link href={chatHref(id)} className={`${rowClass(active, unread > 0, dim)} ${deletable ? "pr-9" : ""}`} aria-current={active ? "page" : undefined} title={title}>
        <ChannelIcon isPrivate={isPrivate} />
        <span className="truncate">{name}</span>
        <Badge n={unread} />
      </Link>
    </RowWithMenu>
  );
}

/** The id of the conversation open at /pipeline/chat?id=, or null elsewhere. */
export function useActiveChatId(): string | null {
  const pathname = usePathname();
  const id = useSearchParams().get("id");
  return pathname === "/pipeline/chat" ? id : null;
}

/** "Direct messages": the same list everywhere (main column, campaign column, phone page). */
export function DmSection() {
  const { meId, dirById } = usePipeline();
  const activeId = useActiveChatId();
  const { data, mutate, unreadOf } = useConversations();
  const online = usePresence();
  const [open, setOpen] = useState(true);
  const [dming, setDming] = useState(false);
  const [toHide, setToHide] = useState<HideableDm | null>(null);
  return (
    <>
      <SectionToggle label="Direct messages" open={open} onToggle={() => setOpen((v) => !v)} icon={<MessagesSquare size={15} aria-hidden />} />
      {open && (
        <ul>
          {data?.dms.map((d) => {
            const active = activeId === d.id;
            const unread = active ? 0 : unreadOf(d.id, d.unread);
            const name = d.isSelf ? dirById.get(meId)?.name ?? "You" : dirById.get(d.userId)?.name ?? "Unknown user";
            const on = online.has(d.userId);
            return (
              <RowWithMenu
                key={d.id}
                actionLabel="Delete conversation"
                menuLabel={`More actions for your conversation with ${name}`}
                active={active}
                onAction={() => setToHide({ id: d.id, name, isSelf: d.isSelf })}
              >
                <Link href={chatHref(d.id)} className={`${rowClass(active, unread > 0)} pr-9`} aria-current={active ? "page" : undefined}>
                  <span className="relative shrink-0">
                    <Initials userId={d.userId} name={name} size={22} />
                    <span
                      className={`absolute -right-0.5 -bottom-0.5 w-2.5 h-2.5 rounded-full border-2 border-bg ${on ? "bg-success" : "bg-ink-4"}`}
                      aria-label={on ? "Online" : "Away"}
                    />
                  </span>
                  <span className="truncate">{name}</span>
                  {d.isSelf && <span className={active ? "text-white/70" : "text-ink-4"}>you</span>}
                  <Badge n={unread} />
                </Link>
              </RowWithMenu>
            );
          })}
          <li>
            <AddRow label="New message" onClick={() => setDming(true)} />
          </li>
        </ul>
      )}
      <NewDmSheet open={dming} onClose={() => setDming(false)} onOpened={() => void mutate()} />
      <HideDmSheet dm={toHide} onClose={() => setToHide(null)} />
    </>
  );
}

/**
 * The collapsed column (desktop): a 52 px rail, so the board gets the width back. Shows
 * whether anything is unread, and opens the full list again.
 */
export function ChatRail({ onExpand }: { onExpand: () => void }) {
  const { data, unreadOf } = useConversations();
  const unread = [...(data?.channels ?? []), ...(data?.dms ?? [])].reduce((n, c) => n + unreadOf(c.id, c.unread), 0);
  return (
    <nav aria-label="Chat" className="py-3 flex flex-col items-center gap-1">
      <button type="button" onClick={onExpand} aria-label="Show chats" title="Show chats" className="h-10 w-10 grid place-items-center text-ink-3 hover:bg-muted hover:text-ink">
        <PanelLeftOpen size={18} aria-hidden />
      </button>
      <Link href="/pipeline" aria-label="Board" title="Board" className="h-10 w-10 grid place-items-center text-ink-3 hover:bg-muted hover:text-ink">
        <KanbanSquare size={18} aria-hidden />
      </Link>
      <button type="button" onClick={onExpand} aria-label={unread ? `Chats, ${unread} unread` : "Chats"} title="Chats" className="relative h-10 w-10 grid place-items-center text-ink-3 hover:bg-muted hover:text-ink">
        <MessagesSquare size={18} aria-hidden />
        {unread > 0 && <span className="absolute top-1.5 right-1.5 w-2.5 h-2.5 rounded-full bg-indigo" />}
      </button>
    </nav>
  );
}

/** The column's header row: a label and the "hide" button. */
export function ColumnHead({ label, onCollapse }: { label: string; onCollapse?: () => void }) {
  if (!onCollapse) return null;
  return (
    <div className="flex items-center justify-between px-4 pb-2">
      <span className="text-[12px] font-bold uppercase tracking-wide text-ink-4">{label}</span>
      <button type="button" onClick={onCollapse} aria-label="Hide chats" title="Hide chats" className="h-8 w-8 -mr-2 grid place-items-center text-ink-3 hover:bg-muted hover:text-ink">
        <PanelLeftClose size={16} aria-hidden />
      </button>
    </div>
  );
}

// ── The main (workspace) column ─────────────────────────────────────────────────────

export function ChatSidebar({ variant = "column", onCollapse }: { variant?: "column" | "page"; onCollapse?: () => void }) {
  const pathname = usePathname();
  const activeId = useActiveChatId();
  const { data, error, mutate, unreadOf } = useConversations();
  const [menu, setMenu] = useState(false);
  const [creating, setCreating] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [openCh, setOpenCh] = useState(true);
  const [toDelete, setToDelete] = useState<DeletableChannel | null>(null);

  return (
    <nav aria-label="Chat" className={variant === "page" ? "py-2" : "py-3"}>
      <ColumnHead label="Workspace" onCollapse={onCollapse} />
      <div className="pb-2 mb-2 border-b border-rule">
        <Link href="/pipeline" className={rowClass(pathname === "/pipeline", false)}>
          <KanbanSquare size={16} aria-hidden /> Board
        </Link>
        <Link href="/pipeline/my-work" className={rowClass(pathname === "/pipeline/my-work", false)}>
          <Inbox size={16} aria-hidden /> My work
        </Link>
      </div>

      {error && !data ? (
        <div className="px-4 py-3 text-[13px] text-ink-3">
          Couldn&apos;t load your chats.{" "}
          <button type="button" onClick={() => void mutate()} className="underline font-semibold text-ink-2">
            Try again
          </button>
        </div>
      ) : null}

      <SectionToggle label="Channels" open={openCh} onToggle={() => setOpenCh((v) => !v)} icon={<Hash size={15} aria-hidden />} />
      {openCh && (
        <ul>
          {!data && !error
            ? [0, 1, 2].map((i) => (
                <li key={i} className="px-5 py-2">
                  <Skeleton className="h-4 w-32" />
                </li>
              ))
            : data?.channels.map((c) => {
                const active = activeId === c.id;
                return (
                  <ChannelRow
                    key={c.id}
                    id={c.id}
                    name={c.name}
                    isPrivate={c.isPrivate}
                    active={active}
                    unread={active ? 0 : unreadOf(c.id, c.unread)}
                    ownerId={c.ownerId}
                    onDelete={setToDelete}
                  />
                );
              })}
          <li className="relative">
            <AddRow label="Add channels" onClick={() => setMenu((v) => !v)} expanded={menu} />
            {menu && (
              <div role="menu" className="absolute left-4 right-4 z-30 mt-1 border border-border bg-surface shadow-pop">
                <button
                  role="menuitem"
                  type="button"
                  className="w-full text-left px-3 h-10 text-[14px] hover:bg-muted"
                  onClick={() => {
                    setMenu(false);
                    setCreating(true);
                  }}
                >
                  Create a new channel
                </button>
                <button
                  role="menuitem"
                  type="button"
                  className="w-full text-left px-3 h-10 text-[14px] hover:bg-muted"
                  onClick={() => {
                    setMenu(false);
                    setBrowsing(true);
                  }}
                >
                  Browse channels
                </button>
              </div>
            )}
          </li>
        </ul>
      )}

      <div className="mt-3" />
      <DmSection />

      <NewChannelSheet open={creating} onClose={() => setCreating(false)} onCreated={() => void mutate()} />
      <DeleteChannelSheet channel={toDelete} onClose={() => setToDelete(null)} />
      <BrowseChannelsSheet
        open={browsing}
        onClose={() => setBrowsing(false)}
        onJoined={() => void mutate()}
        onCreate={() => {
          setBrowsing(false);
          setCreating(true);
        }}
      />
    </nav>
  );
}
