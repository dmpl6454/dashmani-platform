"use client";
/**
 * The non-drag path (spec §9.5): every card's ⋯ opens this sheet — Open, and "Move to…"
 * any phase, top or bottom. Works with any input, including screen readers.
 */
import Link from "next/link";
import type { PipelineCard, PipelinePhase } from "@dashmani/shared";
import { Sheet } from "../ui/Sheet";

export function MoveSheet({
  card,
  phases,
  onClose,
  onMove,
}: {
  card: PipelineCard | null;
  phases: PipelinePhase[];
  onClose: () => void;
  onMove: (card: PipelineCard, toPhaseId: string, where: "top" | "bottom") => void;
}) {
  return (
    <Sheet open={!!card} onClose={onClose} title={card ? card.title : ""}>
      {card && (
        <div className="space-y-4">
          <Link
            href={`/pipeline/${card.id}`}
            className="flex items-center justify-center h-11 rounded-xl bg-ink text-white text-[14px] font-semibold"
            data-autofocus
          >
            Open project
          </Link>
          <div>
            <p className="text-[12.5px] font-semibold text-ink-2 mb-2">Move to…</p>
            <ul className="space-y-1.5">
              {phases.map((ph) => (
                <li key={ph.id} className="flex items-center gap-2 min-w-0">
                  <span className="min-w-0 flex-1 truncate text-[14px] text-ink">
                    {ph.name}
                    {ph.id === card.phaseId && <span className="text-ink-4"> · current</span>}
                  </span>
                  <button
                    type="button"
                    onClick={() => onMove(card, ph.id, "top")}
                    className="h-11 px-3 rounded-xl border border-border text-[13px] font-semibold text-ink hover:bg-muted"
                    aria-label={`Move to the top of ${ph.name}`}
                  >
                    Top
                  </button>
                  <button
                    type="button"
                    onClick={() => onMove(card, ph.id, "bottom")}
                    className="h-11 px-3 rounded-xl border border-border text-[13px] font-semibold text-ink hover:bg-muted"
                    aria-label={`Move to the bottom of ${ph.name}`}
                  >
                    Bottom
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </Sheet>
  );
}
