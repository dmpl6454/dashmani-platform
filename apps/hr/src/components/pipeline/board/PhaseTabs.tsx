"use client";
/** Phones: a sticky, horizontally scrollable phase-chip bar with counts (spec §9.5). */
import type { PipelinePhase } from "@dashmani/shared";

export function PhaseTabs({
  phases,
  counts,
  active,
  onPick,
}: {
  phases: PipelinePhase[];
  counts: Record<string, number>;
  active: string | null;
  onPick: (id: string) => void;
}) {
  return (
    <div className="sticky top-0 z-10 bg-bg border-b border-rule">
      <div className="flex gap-1.5 overflow-x-auto px-3 py-2 min-w-0" role="tablist" aria-label="Phases">
        {phases.map((ph) => {
          const on = ph.id === active;
          return (
            <button
              key={ph.id}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => onPick(ph.id)}
              className={`shrink-0 max-w-[70vw] inline-flex items-center gap-1.5 h-11 px-3.5 rounded-full text-[13px] font-semibold border ${
                on ? "bg-ink text-white border-ink" : "bg-surface text-ink-2 border-border"
              }`}
            >
              <span className="min-w-0 truncate">{ph.name}</span>
              <span className={`tabular-nums ${on ? "text-white/70" : "text-ink-4"}`}>{counts[ph.id] ?? 0}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
