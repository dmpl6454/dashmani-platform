"use client";
/**
 * Archived and deleted lists (route #4, `useSWRInfinite`, 20 per page). Honest states:
 * a failed load says so with Retry — it never renders "No archived projects".
 */
import Link from "next/link";
import useSWRInfinite from "swr/infinite";
import { ChevronLeft } from "lucide-react";
import type { PipelineCard, PipelineListView, PipelineProjectListResponse } from "@dashmani/shared";
import { PL_SWR } from "@/lib/pipeline-swr";
import { usePipeline, usePhases } from "../provider";
import { PipelineHeader } from "../header/PipelineHeader";
import { SkeletonLines } from "../ui/Skeleton";
import { LoadError } from "../ui/LoadError";
import { EmptyState } from "../ui/EmptyState";
import { useToast } from "../ui/Toast";
import { describeError, plApi } from "../api";
import { useState } from "react";

function when(ts: string | null | undefined): string {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function ProjectListView({ view }: { view: PipelineListView }) {
  const { meId, store, engine } = usePipeline();
  const phases = usePhases();
  const toast = useToast();
  const phaseName = (id: string) => phases.find((p) => p.id === id)?.name ?? "";
  const { data, error, size, setSize, isValidating, mutate } = useSWRInfinite<PipelineProjectListResponse>(
    (i, prev: PipelineProjectListResponse | null) =>
      prev && !prev.nextCursor ? null : ["/pipeline/projects", view, meId, i === 0 ? null : prev?.nextCursor ?? null],
    (key: readonly unknown[]) => plApi.listProjects(view, key[3] as string | null, 20),
    { ...PL_SWR, revalidateFirstPage: false },
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const items: PipelineCard[] = (data ?? []).flatMap((p) => p.items);
  const hasMore = !!data && !!data[data.length - 1]?.nextCursor;
  const title = view === "archived" ? "Archived projects" : "Deleted projects";

  const act = async (c: PipelineCard) => {
    setBusyId(c.id);
    try {
      const r = view === "archived" ? await plApi.unarchive(c.id) : await plApi.restore(c.id);
      store.dispatch({ type: "cardUpsert", card: r.card });
      engine.afterWrite();
      await mutate();
      const moved = r.phaseAdjusted ? ` to ${phaseName(r.card.phaseId) || "the first phase"} (its phase was archived)` : "";
      toast.show({ text: `${view === "archived" ? "Unarchived" : "Restored"} “${c.title}”${moved}` });
    } catch (e) {
      toast.show({ text: describeError(e), tone: "error" });
    } finally {
      setBusyId(null);
    }
  };

  let body: React.ReactNode;
  if (!data && error) {
    body = <LoadError title={`Couldn't load ${title.toLowerCase()}`} reason={describeError(error)} onRetry={() => void mutate()} retrying={isValidating} />;
  } else if (!data) {
    body = <SkeletonLines rows={4} />;
  } else if (items.length === 0) {
    body = (
      <EmptyState
        title={view === "archived" ? "No archived projects" : "No deleted projects"}
        body={view === "deleted" ? "Deleted projects can be restored for 30 days." : undefined}
      />
    );
  } else {
    body = (
      <ul className="space-y-2">
        {items.map((c) => (
          <li key={c.id} className="flex items-center gap-3 rounded-xl border border-rule bg-surface p-3 min-w-0">
            <div className="min-w-0 flex-1">
              <p className="pl-clamp2 text-[14px] font-semibold text-ink">{c.title}</p>
              <p className="text-[12px] text-ink-3 mt-0.5 min-w-0 truncate">
                {phaseName(c.phaseId)}
                {view === "archived" ? ` · archived ${when(c.archivedAt)}` : ` · deleted ${when(c.deletedAt)}`}
                {(view === "archived" ? c.archivedByAdmin : c.deletedByAdmin) ? " by an admin" : ""}
              </p>
            </div>
            <button
              type="button"
              disabled={busyId === c.id}
              onClick={() => void act(c)}
              className="h-11 px-3 rounded-xl border border-border text-[13px] font-semibold text-ink hover:bg-muted disabled:opacity-60"
            >
              {busyId === c.id ? "Working…" : view === "archived" ? "Unarchive" : "Restore"}
            </button>
          </li>
        ))}
        {hasMore && (
          <li className="list-none pt-2 text-center">
            <button
              type="button"
              disabled={isValidating}
              onClick={() => void setSize(size + 1)}
              className="h-11 px-4 rounded-xl border border-border text-[13px] font-semibold text-ink hover:bg-muted disabled:opacity-60"
            >
              {isValidating ? "Loading…" : "Load more"}
            </button>
          </li>
        )}
        {error && data && (
          <li className="list-none">
            <LoadError compact title="Couldn't load more" reason={describeError(error)} onRetry={() => void setSize(size)} />
          </li>
        )}
      </ul>
    );
  }

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <PipelineHeader
        title={title}
        left={
          <Link href="/pipeline" aria-label="Back to the board" className="h-11 w-11 -ml-1 grid place-items-center rounded-xl text-ink-3 hover:bg-muted">
            <ChevronLeft size={20} />
          </Link>
        }
      />
      <div className="pl-scroll flex-1 px-3 sm:px-5 py-4 max-w-3xl w-full mx-auto">{body}</div>
    </div>
  );
}
