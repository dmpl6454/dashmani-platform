"use client";
/**
 * A project's activity timeline (2026-11-24): who did what and when — created, phase moves,
 * documents, reviews, pages live, status notes, new versions — newest first. It is kept apart
 * from the chat, so deleting messages never changes it.
 *
 * GET /pipeline/projects/:id/activity (wording comes from the shared activityText). Fetched on
 * mount and on focus; no polling.
 */
import useSWR from "swr";
import { ExternalLink } from "lucide-react";
import { relativeAgo, type PipelineActivityItem } from "@dashmani/shared";
import { PL_SWR } from "@/lib/pipeline-swr";
import { describeError, plApi } from "../api";
import { Skeleton } from "../ui/Skeleton";
import { useMinuteClock } from "../ui/Ago";

const DOT: Record<string, string> = {
  created: "bg-indigo",
  moved: "bg-indigo",
  doc_added: "bg-attention",
  doc_status: "bg-attention",
  doc_deleted: "bg-danger",
  review_requested: "bg-attention",
  review_decided: "bg-success",
  page_published: "bg-success",
  note: "bg-ink-3",
  version_added: "bg-ink-3",
};

function fullTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const h = d.getHours();
  return `${d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" })}, ${h % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

function Item({ it, now }: { it: PipelineActivityItem; now: number }) {
  const ago = relativeAgo(now - Date.parse(it.at)) || "just now";
  return (
    <li className="relative pl-5 pb-4 last:pb-0">
      <span className={`absolute left-0 top-1.5 h-2.5 w-2.5 rounded-full ${DOT[it.kind] ?? "bg-ink-3"}`} aria-hidden />
      <p className="text-[13.5px] text-ink-2 [overflow-wrap:anywhere]">
        <span className="font-semibold text-ink">{it.actor?.name ?? "Someone"}</span> {it.text}
      </p>
      <p className="mt-0.5 flex items-center gap-2 text-[12px] text-ink-4">
        <time dateTime={it.at} title={fullTime(it.at)}>
          {ago}
        </time>
        {it.href && (
          <a href={it.href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-indigo hover:underline">
            <ExternalLink size={11} aria-hidden /> Open
          </a>
        )}
      </p>
    </li>
  );
}

export function ActivityPanel({ projectId }: { projectId: string }) {
  const now = useMinuteClock();
  const { data, error, mutate } = useSWR(`pl-activity:${projectId}`, () => plApi.activity(projectId), {
    ...PL_SWR,
    revalidateOnFocus: true,
  });

  if (!data) {
    if (error) {
      return (
        <div className="p-4" role="alert">
          <p className="text-[13.5px] text-ink-2">{describeError(error)}</p>
          <button type="button" className="mt-3 h-11 px-3.5 border border-border text-[13px] font-semibold" onClick={() => void mutate()}>
            Try again
          </button>
        </div>
      );
    }
    return (
      <div className="p-4 space-y-3" role="status" aria-label="Loading the activity">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    );
  }

  return (
    <section className="px-4 py-4" aria-label="Activity">
      <h2 className="text-[13px] font-bold uppercase tracking-wide text-ink-3 mb-1">Activity</h2>
      <p className="text-[12.5px] text-ink-4 mb-3">Everything that happened on this project. It stays even if chat messages are deleted.</p>
      <ol className="relative border-l border-border ml-1 pl-0">
        {data.items.map((it) => (
          <Item key={it.id} it={it} now={now} />
        ))}
      </ol>
    </section>
  );
}
