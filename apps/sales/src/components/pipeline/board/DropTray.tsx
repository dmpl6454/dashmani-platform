"use client";
/**
 * Phones, while dragging: a sticky, WRAPPING tray listing every phase as a 44 px drop
 * target (spec §9.5). Dropping on one moves the card to the end of that phase.
 */
import { useDroppable } from "@dnd-kit/core";
import type { PipelinePhase } from "@dashmani/shared";

export const TRAY_PREFIX = "tray:";

function TrayTarget({ phase, current }: { phase: PipelinePhase; current: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: `${TRAY_PREFIX}${phase.id}` });
  return (
    <div
      ref={setNodeRef}
      className={`min-w-0 flex items-center justify-center h-11 px-2 rounded-xl border-2 border-dashed text-[13px] font-semibold ${
        isOver ? "border-indigo bg-indigo-soft text-indigo" : current ? "border-border bg-muted text-ink-4" : "border-border bg-surface text-ink-2"
      }`}
    >
      <span className="min-w-0 truncate">{phase.name}</span>
    </div>
  );
}

export function DropTray({ phases, currentPhaseId }: { phases: PipelinePhase[]; currentPhaseId: string | null }) {
  return (
    <div className="sticky top-0 z-10 bg-bg border-b border-rule px-3 py-2" aria-label="Drop on a phase to move there">
      <p className="text-[11.5px] font-semibold text-ink-3 mb-1.5">Drop on a phase to move it there</p>
      <div className="grid grid-cols-3 gap-1.5">
        {phases.map((ph) => (
          <TrayTarget key={ph.id} phase={ph} current={ph.id === currentPhaseId} />
        ))}
      </div>
    </div>
  );
}
