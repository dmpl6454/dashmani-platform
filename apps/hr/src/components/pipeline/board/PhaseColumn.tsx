"use client";
/** Tablet / desktop: one 288 px phase column with its own vertical scroller (spec §9.5). */
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { PipelineCard, PipelineDirectoryEntry, PipelineMineEntry, PipelinePhase, PipelinePhaseCount } from "@dashmani/shared";
import { SortableCard } from "./ProjectCard";

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
  checking,
  onOpen,
  onMenu,
  emptyText,
}: {
  phase: PipelinePhase;
  cards: PipelineCard[];
  mine: Record<string, PipelineMineEntry> | null;
  dirById: ReadonlyMap<string, PipelineDirectoryEntry>;
  checking: ReadonlySet<string>;
  onOpen: (id: string) => void;
  onMenu: (c: PipelineCard) => void;
  emptyText: string;
}) {
  return (
    <SortableContext id={phase.id} items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
      <ul className="flex flex-col gap-2">
        {cards.length === 0 ? (
          <li className="list-none px-3 py-6 text-center text-[12.5px] text-ink-4 rounded-xl border-2 border-dashed border-rule">{emptyText}</li>
        ) : (
          cards.map((c) => (
            <SortableCard
              key={c.id}
              card={c}
              mine={mine?.[c.id]}
              dirById={dirById}
              isTerminal={phase.isTerminal}
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
  checking: ReadonlySet<string>;
  onOpen: (id: string) => void;
  onMenu: (c: PipelineCard) => void;
  emptyText: string;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `${COLUMN_PREFIX}${props.phase.id}` });
  return (
    <section
      aria-label={props.phase.name}
      className={`w-[288px] shrink-0 h-full min-h-0 flex flex-col rounded-2xl ${isOver ? "bg-indigo-soft" : "bg-muted/60"}`}
    >
      <header className="flex items-center gap-2 px-3 h-11 shrink-0">
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-bold text-ink">{props.phase.name}</h2>
        <span className="text-[12px] font-semibold text-ink-4 tabular-nums">{props.total}</span>
      </header>
      <div ref={setNodeRef} className="pl-scroll flex-1 px-2 pb-2">
        <CardList {...props} />
        <TruncationNote count={props.count} />
      </div>
    </section>
  );
}
