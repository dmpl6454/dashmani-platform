"use client";
import { RotateCw } from "lucide-react";

/**
 * A failed load, said in words, with a Retry. Never an empty list.
 *
 * Only the WORDS are the live region (role="alert" is assertive and atomic). The button sits
 * outside it: its label flips "Retry" ↔ "Retrying…" on every automatic or background retry
 * (SWR's error retries, the pages' timed retries, the gate's ~3-minute re-check), and inside
 * the alert each flip would re-read the whole message, interrupting the user. Same layout.
 */
export function LoadError({
  title,
  reason,
  onRetry,
  retrying = false,
  compact = false,
}: {
  title: string;
  reason?: string | null;
  onRetry?: () => void;
  retrying?: boolean;
  compact?: boolean;
}) {
  return (
    <div className={`flex ${compact ? "flex-row items-center gap-3 py-3" : "flex-col items-center text-center gap-2 py-10"} px-4`}>
      <div role="alert" className={compact ? "min-w-0 flex-1" : ""}>
        <p className="text-[14px] font-bold text-ink">{title}</p>
        {reason && <p className="text-[12.5px] text-ink-3 mt-0.5">{reason}</p>}
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className="inline-flex items-center gap-1.5 h-11 px-4 rounded-xl bg-ink text-white text-[13px] font-semibold disabled:opacity-60"
        >
          <RotateCw size={14} className={retrying ? "animate-spin" : ""} />
          {retrying ? "Retrying…" : "Retry"}
        </button>
      )}
    </div>
  );
}
