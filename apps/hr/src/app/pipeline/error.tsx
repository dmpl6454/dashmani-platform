"use client";
/** Pipeline error boundary (spec §9.9): own copy, a Reload button, drafts untouched. */
import { useEffect } from "react";
import { reloadOnceForChunkError } from "@/lib/chunk-reload";

export default function PipelineError({ error }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    reloadOnceForChunkError(error);
  }, [error]);
  return (
    <div role="alert" className="flex flex-col items-center justify-center text-center gap-3 px-6 py-16">
      <p className="text-[16px] font-bold text-ink">Something on this page failed to load.</p>
      <p className="text-[13px] text-ink-3">Your drafts are saved.</p>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="h-11 px-5 rounded-xl bg-ink text-white text-[13px] font-semibold"
      >
        Reload
      </button>
    </div>
  );
}
