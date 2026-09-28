"use client";
/**
 * Why the pipeline isn't showing — always in words (spec §5.5, §9.8). Never "Too many
 * requests", "An unexpected error occurred" or "Something went wrong".
 */
import { PipelineHeader } from "./PipelineHeader";
import { LoadError } from "../ui/LoadError";
import { Skeleton } from "../ui/Skeleton";

export type GateKind = "loading" | "load_failed" | "off" | "not_in_pilot" | "inactive" | "forbidden";

const COPY: Record<Exclude<GateKind, "loading" | "load_failed">, { title: string; body: string; retry: boolean }> = {
  off: {
    title: "Pipeline is paused",
    body: "It will come back automatically — you don't need to do anything. Your projects are safe.",
    retry: true,
  },
  not_in_pilot: {
    title: "Pipeline isn't available for your account yet",
    body: "It's being tried out with a small group first. Ask your admin if you need access.",
    retry: true,
  },
  inactive: {
    title: "Your account is inactive",
    body: "Pipeline is only available to active accounts. Contact HR if this looks wrong.",
    retry: true,
  },
  forbidden: {
    title: "Pipeline isn't available for your account",
    body: "Ask your admin if you need access.",
    retry: true,
  },
};

export function GateScreen({
  kind,
  reason,
  errorStatus,
  onRetry,
  retrying = false,
}: {
  kind: GateKind;
  reason?: string | null;
  errorStatus?: number;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  let body: React.ReactNode;
  if (kind === "loading") {
    body = (
      <div className="p-4 sm:p-6 grid grid-cols-1 sm:grid-cols-3 gap-4" role="status" aria-label="Loading the pipeline">
        {[0, 1, 2].map((i) => (
          <div key={i} className="space-y-3">
            <Skeleton className="h-6 w-32" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ))}
      </div>
    );
  } else if (kind === "load_failed") {
    const notDeployed = errorStatus === 404;
    body = (
      <LoadError
        title={notDeployed ? "Pipeline isn't available yet" : "Couldn't load the pipeline — your projects are safe."}
        reason={notDeployed ? "It hasn't been switched on for this portal." : reason}
        onRetry={onRetry}
        retrying={retrying}
      />
    );
  } else {
    const c = COPY[kind];
    body = (
      <div role="status" className="flex flex-col items-center text-center gap-2 px-6 py-14">
        <p className="text-[16px] font-bold text-ink">{c.title}</p>
        <p className="text-[13px] text-ink-3 max-w-sm">{c.body}</p>
        {c.retry && onRetry && (
          <button
            type="button"
            onClick={onRetry}
            disabled={retrying}
            className="mt-3 h-11 px-4 rounded-xl border border-border text-[13px] font-semibold text-ink hover:bg-muted disabled:opacity-60"
          >
            {retrying ? "Checking…" : "Check again"}
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col min-h-0 flex-1">
      <PipelineHeader title="Pipeline" />
      <div className="pl-scroll flex-1">{body}</div>
    </div>
  );
}

/** Shown over live content when /sync reports PIPELINE_DISABLED mid-session. */
export function PausedBanner() {
  return (
    <div role="status" className="shrink-0 px-4 py-2 bg-action-soft text-ink text-[13px] font-medium text-center">
      Pipeline is paused — it will resume automatically. Nothing you typed is lost.
    </div>
  );
}
