"use client";
/**
 * My Work (2026-11-02): everything in the Pipeline that waits on the signed-in person, each
 * row with its next action and a link to the project.
 *
 *   Reviews to do        reviews asked of me that still cover the newest versions
 *   Changes requested    my review requests that came back with changes (until I ask again)
 *   Pages to post        pages assigned to me that are not published or cancelled
 *   My projects due      projects I own in a live phase with a due date
 *
 * Data: GET /pipeline/my-work, on mount and on focus (no polling). A failed load says so —
 * an empty list is shown only for a loaded, empty response.
 */
import Link from "next/link";
import useSWR from "swr";
import { ChevronLeft } from "lucide-react";
import { dueState, pipelineWork as W } from "@dashmani/shared";
import { PL_SWR } from "@/lib/pipeline-swr";
import { describeError, plApi } from "../api";
import { PipelineHeader } from "../header/PipelineHeader";
import { useLocalDayKey } from "../hooks/use-local-day-key";
import { Skeleton } from "../ui/Skeleton";

function when(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const day = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  const h = d.getHours();
  return `${day}, ${h % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

function dayLabel(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

function Group({ title, count, empty, children }: { title: string; count: number; empty: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className="mb-2 text-[13px] font-bold uppercase tracking-wide text-ink-3">
        {title}
        {count > 0 && <span className="ml-1.5 text-ink-4">· {count}</span>}
      </h2>
      {count === 0 ? <p className="text-[13.5px] text-ink-4 px-1">{empty}</p> : <ul className="space-y-2">{children}</ul>}
    </section>
  );
}

function Row({ href, title, project, meta, tone }: { href: string; title: string; project: string; meta: string; tone?: "late" }) {
  return (
    <li>
      <Link href={href} className="block rounded-xl border border-border bg-surface px-3.5 py-3 hover:border-ink-4 min-w-0">
        <p className="text-[14px] font-bold text-ink truncate">{title}</p>
        <p className="mt-0.5 text-[13px] text-ink-3 truncate">{project}</p>
        {meta && <p className={`mt-0.5 text-[12.5px] ${tone === "late" ? "text-danger font-semibold" : "text-ink-3"}`}>{meta}</p>}
      </Link>
    </li>
  );
}

export function MyWork() {
  const today = useLocalDayKey();
  const { data, error, mutate } = useSWR("pl-my-work", () => plApi.myWork(), { ...PL_SWR, revalidateOnFocus: true });

  const back = (
    <Link href="/pipeline" aria-label="Back to the board" className="h-11 w-11 -ml-1 grid place-items-center rounded-xl text-ink-3 hover:bg-muted">
      <ChevronLeft size={20} />
    </Link>
  );

  let body: React.ReactNode;
  if (!data) {
    body = error ? (
      <div role="alert" className="py-6">
        <p className="text-[14px] text-ink-2">Couldn&apos;t load your work — nothing is lost. {describeError(error)}</p>
        <button type="button" onClick={() => void mutate()} className="mt-3 h-11 px-4 rounded-xl border border-border text-[13px] font-semibold">
          Try again
        </button>
      </div>
    ) : (
      <div className="space-y-3" role="status" aria-label="Loading your work">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
      </div>
    );
  } else {
    const now = Date.parse(data.now);
    const shoots = data.shoots ?? [];
    const total =
      data.reviewsToDo.length + data.changesRequested.length + data.deliverables.length + data.dueProjects.length + shoots.length;
    body = (
      <>
        {total === 0 && (
          <p className="mb-6 rounded-xl bg-success-bg text-success px-3.5 py-3 text-[14px] font-semibold">Nothing waiting on you right now.</p>
        )}
        <Group title="Shoots" count={shoots.length} empty="No shoots assigned to you.">
          {shoots.map((sh) => (
            <Row
              key={sh.id}
              href="/pipeline/shoots?view=mine"
              title={sh.title}
              project={[sh.location, sh.event].filter(Boolean).join(" · ") || "Shoot"}
              meta={`${W.PIPELINE_SHOOT_STATUS_LABEL[sh.status]} · call ${when(sh.callTime)}`}
            />
          ))}
        </Group>
        <Group title="Reviews to do" count={data.reviewsToDo.length} empty="No reviews waiting for you.">
          {data.reviewsToDo.map(({ review, project }) => (
            <Row
              key={review.id}
              href={`/pipeline/${project.id}`}
              title={`Review for ${review.requestedBy.name}`}
              project={project.title}
              meta={`Asked ${when(review.createdAt)}`}
            />
          ))}
        </Group>
        <Group title="Changes requested" count={data.changesRequested.length} empty="None of your work is waiting on changes.">
          {data.changesRequested.map(({ review, project }) => (
            <Row
              key={review.id}
              href={`/pipeline/${project.id}`}
              title={`${review.reviewer.name} asked for changes`}
              project={project.title}
              meta={review.note ? review.note.split("\n")[0] : ""}
            />
          ))}
        </Group>
        <Group title="Pages to post" count={data.deliverables.length} empty="No pages assigned to you.">
          {data.deliverables.map(({ deliverable: d, project }) => {
            const late = !!d.scheduledAt && Date.parse(d.scheduledAt) < now && d.status !== "published";
            const status = W.PIPELINE_DELIVERABLE_STATUS_LABEL[d.status];
            return (
              <Row
                key={d.id}
                href={`/pipeline/${project.id}`}
                title={`${W.PIPELINE_PLATFORM_LABEL[d.platform]} · ${d.destination}`}
                project={project.title}
                meta={d.scheduledAt ? `${status} · ${late ? "was due" : "goes live"} ${when(d.scheduledAt)}` : `${status} · no time set`}
                tone={late ? "late" : undefined}
              />
            );
          })}
        </Group>
        <Group title="My projects due" count={data.dueProjects.length} empty="None of your projects has a due date coming up.">
          {data.dueProjects.map((p) => {
            const state = dueState(p.dueDate, false, today);
            const label =
              state === "overdue" ? `Overdue — was due ${dayLabel(p.dueDate)}` : state === "today" ? "Due today" : state === "tomorrow" ? "Due tomorrow" : `Due ${dayLabel(p.dueDate)}`;
            return (
              <Row key={p.id} href={`/pipeline/${p.id}`} title={p.title} project={p.phaseName} meta={label} tone={state === "overdue" ? "late" : undefined} />
            );
          })}
        </Group>
      </>
    );
  }

  return (
    <div className="flex flex-col min-h-0 flex-1 min-w-0">
      <PipelineHeader title="My Work" left={back} />
      <div className="pl-scroll flex-1 min-h-0">
        <div className="max-w-2xl mx-auto px-4 py-5">{body}</div>
      </div>
    </div>
  );
}
