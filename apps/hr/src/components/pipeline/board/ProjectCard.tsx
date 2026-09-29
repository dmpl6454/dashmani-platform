"use client";
/**
 * One board card (spec §9.5). An <li><article>; the title is a real <button> stretched
 * over the card with ::after. The ⋯ button and the keyboard grip are SIBLINGS of the
 * title (never nested), 44×44 and always visible — no hover-only controls.
 *
 * Drag activation is split by input: mouse (distance 6) and touch (250 ms long-press)
 * start from anywhere on the card; the keyboard (Space) only from the grip, so Enter on
 * the title still opens the project.
 */
import { memo } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AlertCircle, CalendarClock, Ellipsis, GripVertical } from "lucide-react";
import type { PipelineCard, PipelineDirectoryEntry, PipelineMineEntry } from "@dashmani/shared";
import { Initials } from "../ui/Initials";
import { dueState, shortDay } from "./due";

export interface CardViewProps {
  card: PipelineCard;
  mine: PipelineMineEntry | undefined;
  dirById: ReadonlyMap<string, PipelineDirectoryEntry>;
  isTerminal: boolean;
  checking?: boolean;
  onOpen?: (id: string) => void;
  onMenu?: (card: PipelineCard) => void;
}

function nameOf(dir: ReadonlyMap<string, PipelineDirectoryEntry>, id: string): string | null {
  return dir.get(id)?.name ?? null;
}

export function CardFace({
  card,
  mine,
  dirById,
  isTerminal,
  checking,
  onOpen,
  onMenu,
  grip,
  overlay = false,
}: CardViewProps & { grip?: React.ReactNode; overlay?: boolean }) {
  const due = dueState(card.dueDate, isTerminal);
  const owner = dirById.get(card.ownerId);
  const members = card.preview.filter((id) => id !== card.ownerId).slice(0, 3);
  // memberCount includes the owner (the owner always holds a MEMBER row).
  const extra = Math.max(0, card.memberCount - 1 - members.length);
  const unread = mine?.unread ?? 0;
  return (
    <article
      className={`pl-card relative flex gap-1 rounded-xl bg-surface border p-3 pr-1 ${
        overlay ? "border-indigo shadow-pop" : "border-rule shadow-card"
      }`}
    >
      <div className="min-w-0 flex-1">
        <button
          type="button"
          data-card-title={card.id}
          onClick={() => onOpen?.(card.id)}
          className="pl-stretch block w-full text-left text-[14px] font-semibold text-ink leading-snug pl-clamp2 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo rounded-md"
        >
          {card.title}
        </button>
        <div className="mt-2 flex flex-wrap items-center gap-1.5 min-w-0">
          {due === "overdue" && (
            <span className="inline-flex items-center gap-1 h-6 px-2 rounded-full bg-danger-bg text-danger text-[11.5px] font-bold">
              <AlertCircle size={12} aria-hidden /> Overdue
            </span>
          )}
          {due === "tomorrow" && (
            <span className="inline-flex items-center gap-1 h-6 px-2 rounded-full bg-attention-bg text-attention text-[11.5px] font-bold">
              <CalendarClock size={12} aria-hidden /> Due tomorrow
            </span>
          )}
          {due === "later" && card.dueDate && (
            <span className="inline-flex items-center h-6 px-2 rounded-full bg-muted text-ink-3 text-[11.5px] font-semibold">
              Due {shortDay(card.dueDate)}
            </span>
          )}
          {owner && !owner.active && (
            <span className="inline-flex items-center h-6 px-2 rounded-full bg-muted text-ink-3 text-[11.5px] font-semibold">
              Owner inactive
            </span>
          )}
          {checking && (
            <span className="inline-flex items-center h-6 px-2 rounded-full bg-action-soft text-ink text-[11.5px] font-semibold">
              Checking…
            </span>
          )}
        </div>
        <div className="mt-2 flex items-center gap-2 min-w-0">
          <div className="flex items-center -space-x-1.5" role="img" aria-label={`${card.memberCount} member${card.memberCount === 1 ? "" : "s"}`}>
            <Initials userId={card.ownerId} name={nameOf(dirById, card.ownerId)} initials={owner?.initials} size={24} className="ring-2 ring-surface" />
            {members.map((id) => (
              <Initials key={id} userId={id} name={nameOf(dirById, id)} initials={dirById.get(id)?.initials} size={24} className="ring-2 ring-surface" />
            ))}
            {extra > 0 && (
              <span className="inline-grid place-items-center h-6 min-w-6 px-1 rounded-full bg-muted text-ink-3 text-[10.5px] font-bold ring-2 ring-surface">
                +{extra}
              </span>
            )}
          </div>
          {unread > 0 && (
            <span className="ml-auto inline-grid place-items-center h-6 min-w-6 px-1.5 rounded-full bg-indigo text-white text-[11px] font-bold" aria-label={`${unread} unread`}>
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </div>
      </div>
      <div className="relative z-10 flex flex-col items-center">
        <button
          type="button"
          aria-label={`Actions for ${card.title}`}
          onClick={() => onMenu?.(card)}
          onMouseDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
          className="h-11 w-11 grid place-items-center rounded-xl text-ink-3 hover:bg-muted"
        >
          <Ellipsis size={18} />
        </button>
        {grip}
      </div>
    </article>
  );
}

function SortableCardImpl(props: CardViewProps & { disabled?: boolean }) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: props.card.id,
    disabled: props.disabled,
  });
  const style: React.CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0.35 : 1,
  };
  const pointer = listeners
    ? { onMouseDown: listeners.onMouseDown as React.MouseEventHandler, onTouchStart: listeners.onTouchStart as React.TouchEventHandler }
    : {};
  return (
    <li ref={setNodeRef} style={style} data-card-id={props.card.id} {...pointer} className="list-none">
      <CardFace
        {...props}
        grip={
          <button
            type="button"
            ref={setActivatorNodeRef}
            {...attributes}
            onKeyDown={listeners?.onKeyDown as React.KeyboardEventHandler | undefined}
            aria-label={`Move ${props.card.title} (press Space to pick up)`}
            className="h-11 w-11 grid place-items-center rounded-xl text-ink-4 hover:bg-muted cursor-grab"
          >
            <GripVertical size={16} />
          </button>
        }
      />
    </li>
  );
}

export const SortableCard = memo(SortableCardImpl);
