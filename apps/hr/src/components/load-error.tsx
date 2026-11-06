"use client";
import { RefreshCw } from "lucide-react";

/** A failed load must say so — only a LOADED response may claim emptiness (CLAUDE.md rule). */
export function LoadError({ what, onRetry }: { what: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="v3-card px-5 py-8 text-center">
      <p className="text-[13.5px] font-bold text-ink">Couldn&apos;t load your {what}.</p>
      <p className="text-[12.5px] text-ink-3 font-medium mt-1">This is a loading problem, not a data problem — your records are safe. Check your connection and try again.</p>
      {onRetry && (
        <button type="button" onClick={onRetry} className="mt-4 inline-flex items-center gap-2 px-4 h-9 rounded-full bg-indigo text-white text-[12.5px] font-bold hover:bg-indigo/90 transition-colors">
          <RefreshCw size={13} /> Retry
        </button>
      )}
    </div>
  );
}
