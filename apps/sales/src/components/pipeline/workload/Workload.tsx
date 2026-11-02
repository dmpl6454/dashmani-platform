"use client";
/**
 * Team workload (2026-11-02): per person, what is on their plate in the Pipeline — open pages
 * (and how many are past their time), reviews to do, open shoots, owned live projects (and how
 * many are overdue) — with approved leave today or this week beside it. Busiest first.
 * Data: GET /pipeline/workload (aggregates only), on mount and on focus.
 */
import Link from "next/link";
import useSWR from "swr";
import { ChevronLeft } from "lucide-react";
import type { pipelineWork as W } from "@dashmani/shared";
import { PL_SWR } from "@/lib/pipeline-swr";
import { describeError, plApi } from "../api";
import { PipelineHeader } from "../header/PipelineHeader";
import { Skeleton } from "../ui/Skeleton";

function dayLabel(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

function Cell({ n, warn, label }: { n: number; warn?: number; label: string }) {
  return (
    <td className="px-2 py-2.5 text-right tabular-nums whitespace-nowrap">
      <span className={n === 0 ? "text-ink-4" : "text-ink font-semibold"} aria-label={`${n} ${label}`}>
        {n}
      </span>
      {warn ? <span className="ml-1 text-[11.5px] font-semibold text-danger">({warn} late)</span> : null}
    </td>
  );
}

function Row({ r }: { r: W.PipelineWorkloadRow }) {
  return (
    <tr className="border-t border-rule">
      <td className="px-2 py-2.5 min-w-[150px]">
        <span className="font-semibold text-ink">{r.person.name}</span>
        {r.onLeaveToday && <span className="ml-2 px-1.5 py-0.5 rounded bg-attention-bg text-attention text-[11px] font-semibold">On leave today</span>}
        {r.leaveFrom && <span className="ml-2 text-[11.5px] text-ink-3">Leave from {dayLabel(r.leaveFrom)}</span>}
      </td>
      <Cell n={r.pagesOpen} warn={r.pagesLate} label="pages" />
      <Cell n={r.reviewsToDo} label="reviews" />
      <Cell n={r.shootsOpen} label="shoots" />
      <Cell n={r.projectsOwned} warn={r.projectsOverdue} label="projects" />
    </tr>
  );
}

export function Workload() {
  const { data, error, mutate } = useSWR("pl-workload", () => plApi.workload(), { ...PL_SWR, revalidateOnFocus: true });
  const back = (
    <Link href="/pipeline" aria-label="Back to the board" className="h-11 w-11 -ml-1 grid place-items-center rounded-xl text-ink-3 hover:bg-muted">
      <ChevronLeft size={20} />
    </Link>
  );
  return (
    <div className="flex flex-col min-h-0 flex-1 min-w-0">
      <PipelineHeader title="Workload" left={back} />
      <div className="pl-scroll flex-1 min-h-0">
        <div className="max-w-3xl mx-auto px-4 py-4">
          <p className="mb-3 text-[13px] text-ink-3">
            What each person has open in the Pipeline, busiest first. Leave is approved leave only.
          </p>
          {!data ? (
            error ? (
              <div role="alert">
                <p className="text-[14px] text-ink-2">Couldn&apos;t load the workload — nothing is lost. {describeError(error)}</p>
                <button type="button" onClick={() => void mutate()} className="mt-3 h-11 px-4 rounded-xl border border-border text-[13px] font-semibold">
                  Try again
                </button>
              </div>
            ) : (
              <div className="space-y-2" role="status" aria-label="Loading the workload">
                <Skeleton className="h-10" />
                <Skeleton className="h-10" />
                <Skeleton className="h-10" />
              </div>
            )
          ) : data.rows.length === 0 ? (
            <p className="text-[14px] text-ink-3">Nobody has open Pipeline work right now.</p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-border bg-surface">
              <table className="w-full text-[13.5px]">
                <thead>
                  <tr className="text-[12px] uppercase tracking-wide text-ink-3">
                    <th className="px-2 py-2 text-left font-semibold">Person</th>
                    <th className="px-2 py-2 text-right font-semibold">Pages</th>
                    <th className="px-2 py-2 text-right font-semibold">Reviews</th>
                    <th className="px-2 py-2 text-right font-semibold">Shoots</th>
                    <th className="px-2 py-2 text-right font-semibold">Projects</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <Row key={r.person.id} r={r} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
