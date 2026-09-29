"use client";
/** The fixed 8-emoji palette as a portalled 4×2 grid (spec §9.6). */
import { useEffect, useRef } from "react";
import type { PipelineReactionKey, PipelineReactionOption } from "@dashmani/shared";
import { Sheet } from "../ui/Sheet";

const LABELS: Record<PipelineReactionKey, string> = {
  thumbs_up: "Thumbs up",
  heart: "Heart",
  laugh: "Laugh",
  party: "Party",
  eyes: "Eyes",
  check: "Check",
  pray: "Thanks",
  fire: "Fire",
};

export function ReactionPicker({
  open,
  options,
  mine,
  onPick,
  onClose,
}: {
  open: boolean;
  options: PipelineReactionOption[];
  mine: ReadonlySet<string>;
  onPick: (key: PipelineReactionKey) => void;
  onClose: () => void;
}) {
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) setTimeout(() => first.current?.focus(), 0);
  }, [open]);
  return (
    <Sheet open={open} onClose={onClose} title="React">
      <div className="grid grid-cols-4 gap-2" role="group" aria-label="Reactions">
        {options.map((o, i) => (
          <button
            key={o.key}
            ref={i === 0 ? first : undefined}
            type="button"
            aria-pressed={mine.has(o.key)}
            aria-label={LABELS[o.key] ?? o.key}
            onClick={() => {
              onPick(o.key);
              onClose();
            }}
            className={`h-14 rounded-xl text-[24px] grid place-items-center border ${mine.has(o.key) ? "border-indigo bg-indigo-soft" : "border-rule bg-surface hover:bg-muted"}`}
          >
            {o.emoji}
          </button>
        ))}
      </div>
    </Sheet>
  );
}
