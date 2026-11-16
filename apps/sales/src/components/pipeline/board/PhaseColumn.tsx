"use client";
/** Tablet / desktop: one 288 px phase column with its own vertical scroller (spec §9.5). */
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { PipelineCard, PipelineDirectoryEntry, PipelineMineEntry, PipelinePhase, PipelinePhaseCount } from "@dashmani/shared";
import { SortableCard } from "./ProjectCard";
import { phaseIcon } from "./phase-icon";

export const COLUMN_PREFIX = "col:";

export function TruncationNote({ count }: { count: PipelinePhaseCount | undefined }) {
  if (!count?.truncated) return null;
  return (
    <p className="px-1 py-2 text-[12px] text-ink-3">
      Showing {count.shown} of {count.total} — archive finished ones to see the rest
    </p>
  );
}

export function CardList({
  phase,
  cards,
  mine,
  dirById,
  today,
  checking,
  onOpen,
  onMenu,
  emptyText,
}: {
  phase: PipelinePhase;
  cards: PipelineCard[];
  mine: Record<string, PipelineMineEntry> | null;
  dirById: ReadonlyMap<string, PipelineDirectoryEntry>;
  /** The browser-local today key (useLocalDayKey) for the due chips. */
  today: string;
  checking: ReadonlySet<string>;
  onOpen: (id: string) => void;
  onMenu: (c: PipelineCard) => void;
  emptyText: string;
}) {
  const Icon = phaseIcon(phase.name);
  return (
    <SortableContext id={phase.id} items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
      <ul className="flex flex-col gap-2.5">
        {cards.length === 0 ? (
          <li className="list-none px-4 py-7 flex flex-col items-center text-center border-2 border-dashed border-border">
            <Icon size={22} className="text-indigo-light" aria-hidden />
            <span className="mt-3 text-[13.5px] font-semibold text-ink-2">{emptyText}</span>
            <span className="mt-1 text-[12px] text-ink-4">Drag a project here</span>
          </li>
        ) : (
          cards.map((c) => (
            <SortableCard
              key={c.id}
              card={c}
              mine={mine?.[c.id]}
              dirById={dirById}
              isTerminal={phase.isTerminal}
              today={today}
              checking={checking.has(c.id)}
              onOpen={onOpen}
              onMenu={onMenu}
            />
          ))
        )}
      </ul>
    </SortableContext>
  );
}

export function PhaseColumn(props: {
  phase: PipelinePhase;
  cards: PipelineCard[];
  total: number;
  count: PipelinePhaseCount | undefined;
  mine: Record<string, PipelineMineEntry> | null;
  dirById: ReadonlyMap<string, PipelineDirectoryEntry>;
  today: string;
  checking: ReadonlySet<string>;
  onOpen: (id: string) => void;
  onMenu: (c: PipelineCard) => void;
  emptyText: string;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `${COLUMN_PREFIX}${props.phase.id}` });
  const Icon = phaseIcon(props.phase.name);
  return (
    <section
      aria-label={props.phase.name}
      className={`w-[288px] shrink-0 h-full min-h-0 flex flex-col border-2 transition-colors ${isOver ? "bg-indigo-soft border-indigo" : "bg-surface border-rule"}`}
    >
      <header className="flex items-center gap-2.5 px-4 h-14 shrink-0 border-b-2 border-rule">
        <Icon size={18} className="shrink-0 text-ink-2" aria-hidden />
        <h2 className="min-w-0 flex-1 truncate text-[14.5px] font-bold text-ink">{props.phase.name}</h2>
        <span
          className={`inline-grid place-items-center h-7 min-w-7 px-2 rounded-full text-[12px] font-bold tabular-nums ${props.total > 0 ? "bg-indigo-soft text-indigo-light" : "bg-muted text-ink-3"}`}
        >
          {props.total}
        </span>
      </header>
      <div ref={setNodeRef} className="pl-scroll flex-1 p-3">
        <CardList {...props} />
        <TruncationNote count={props.count} />
      </div>
    </section>
  );
}
