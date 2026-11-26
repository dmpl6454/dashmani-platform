"use client";
/**
 * The Pipeline section of the sales Dashboard (2026-11-23): one screen for managers.
 * GET /pipeline/dashboard (shapes: packages/shared/src/pipeline/dashboard.ts).
 *
 *   - Four tiles: active projects, overdue, waiting on the client (documents Sent, no answer),
 *     waiting for review. A tile with work in it is coloured.
 *   - Projects per phase, as one strip of equal cells in board order.
 *   - Four bordered panels (header + count, equal height per row): overdue, waiting on the
 *     client, waiting for review, this week's go-lives.
 *   - "Latest from chats" (full width, last): each project's newest message (its thread or a
 *     public campaign channel), newest first. The message itself, no AI.
 *   - Every row opens the project.
 *
 * Hidden when the Pipeline is off or not available to this account (the API answers 403/503):
 * the rest of the Dashboard never depends on it. Refreshes every 60 s, like the Dashboard.
 */
import Link from "next/link";
import useSWR from "swr";
import { dayMonthShort, relativeAgo, type PipelineDashboardDto } from "@dashmani/shared";
import { fetcher } from "@/lib/api";
import { Stat } from "@/components/sales-ui";

const open = (id: string) => `/pipeline/view?id=${encodeURIComponent(id)}`;

/**
 * One bordered panel: a header bar (title + count) over a list. Panels in the same grid row
 * stretch to the same height, so the four lists line up whatever they hold.
 */
function Panel({ title, count, tone, empty, children }: {
  title: string;
  count?: number;
  tone?: "danger" | "attention";
  empty: string;
  children: React.ReactNode[];
}) {
  const badge =
    count && tone === "danger" ? "border-danger text-danger" : count && tone === "attention" ? "border-attention text-attention" : "border-border text-ink-3";
  return (
    <div className="flex flex-col min-w-0 border border-border">
      <div className="flex items-center justify-between gap-2 h-10 px-3 border-b border-border bg-muted/40">
        <h3 className="text-[11px] uppercase tracking-[0.12em] text-ink-2 font-semibold truncate">{title}</h3>
        {count !== undefined && (
          <span className={`shrink-0 min-w-[1.75rem] h-5 px-1.5 inline-flex items-center justify-center border text-[11px] font-bold tabular-nums ${badge}`}>
            {count}
          </span>
        )}
      </div>
      {children.length ? (
        <ul className="divide-y divide-rule">{children}</ul>
      ) : (
        <p className="flex-1 grid place-items-center px-3 py-6 text-sm text-ink-4 text-center">{empty}</p>
      )}
    </div>
  );
}

function Row({ id, title, right, sub, rightTone }: { id: string; title: string; right: React.ReactNode; sub?: string; rightTone?: string }) {
  return (
    <li>
      <Link href={open(id)} className="flex items-center justify-between gap-3 px-3 py-2.5 min-w-0 hover:bg-muted">
        <span className="min-w-0">
          <span className="block text-sm font-semibold truncate">{title}</span>
          {sub && <span className="block text-xs text-ink-4 truncate mt-0.5">{sub}</span>}
        </span>
        <span className={`shrink-0 text-xs text-right tabular-nums ${rightTone ?? "text-ink-3"}`}>{right}</span>
      </Link>
    </li>
  );
}

/** Where a chat row opens: the project page, or the channel, at that message. */
function chatHref(x: PipelineDashboardDto["latestChats"][number]): string {
  const m = `&m=${encodeURIComponent(x.messageId)}`;
  return x.channel ? `/pipeline/chat?id=${encodeURIComponent(x.conversationId)}${m}` : `${open(x.project.id)}${m}`;
}

function LatestChats({ rows, ago }: { rows: PipelineDashboardDto["latestChats"]; ago: (iso: string) => string }) {
  return (
    <Panel title="Latest from chats" empty="No messages in any campaign yet.">
      {rows.map((x) => (
        <li key={x.messageId}>
          <Link href={chatHref(x)} className="flex items-start gap-3 px-3 py-2.5 min-w-0 hover:bg-muted">
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline gap-1.5 min-w-0">
                <span className="font-semibold text-sm truncate">{x.project.title}</span>
                {x.channel && <span className="shrink-0 text-xs text-ink-4">#{x.channel}</span>}
              </span>
              <span className="block text-sm text-ink-3 mt-0.5 [overflow-wrap:anywhere] line-clamp-2">
                <span className="font-semibold text-ink-2">{x.author}:</span> {x.text}
              </span>
            </span>
            <span className="shrink-0 text-xs text-ink-3 pt-0.5 tabular-nums">{ago(x.at)}</span>
          </Link>
        </li>
      ))}
    </Panel>
  );
}

export function PipelineDashboard() {
  const { data } = useSWR<PipelineDashboardDto>("/pipeline/dashboard", fetcher, { refreshInterval: 60_000, shouldRetryOnError: false });
  if (!data) return null; // loading, or the Pipeline is off for this account: show nothing
  const d = data;
  const now = Date.now();
  const ago = (iso: string) => relativeAgo(now - Date.parse(iso)) || "just now";
  const when = (iso: string) => {
    const t = new Date(iso);
    const h = t.getHours();
    return `${t.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}, ${h % 12 || 12}:${String(t.getMinutes()).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
  };

  return (
    <section className="card p-4 mb-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-4">
        <h2 className="font-bold">
          Pipeline <span className="text-ink-3 font-normal text-xs">campaigns on the board · same for both companies</span>
        </h2>
        <Link href="/pipeline" className="text-sm hover:text-indigo-light">
          Open the board →
        </Link>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Link href="/pipeline" className="min-w-0 hover:opacity-90">
          <Stat label="Active projects" value={d.counts.active} sub={`${d.counts.thisWeek} going live or due this week`} />
        </Link>
        <Stat label="Overdue" value={d.counts.overdue} sub="past their due date" tone={d.counts.overdue ? "danger" : undefined} />
        <Stat label="Waiting on client" value={d.counts.waitingClient} sub="sent, no answer yet" tone={d.counts.waitingClient ? "attention" : undefined} />
        <Stat label="Waiting for review" value={d.counts.waitingReview} sub="asked, not decided" tone={d.counts.waitingReview ? "attention" : undefined} />
      </div>

      {/* Projects per phase: one strip, equal cells, in board order (scrolls sideways on a phone). */}
      <div
        className="mt-3 grid grid-flow-col auto-cols-[minmax(7.5rem,1fr)] overflow-x-auto md:grid-flow-row md:auto-cols-auto md:grid-cols-[repeat(var(--n),minmax(0,1fr))] border-l border-t border-border"
        style={{ "--n": Math.max(1, d.phases.length) } as React.CSSProperties}
        aria-label="Projects per phase"
      >
        {d.phases.map((p) => (
          <div key={p.id} className="min-w-0 px-3 py-2 border-r border-b border-border">
            <p className="text-[10.5px] uppercase tracking-[0.1em] text-ink-3 truncate" title={p.name}>{p.name}</p>
            <p className={`text-lg font-extrabold tabular-nums leading-tight ${p.count ? "text-ink" : "text-ink-4"}`}>{p.count}</p>
          </div>
        ))}
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <Panel title="Overdue" count={d.counts.overdue} tone="danger" empty="Nothing overdue.">
          {d.overdue.map((p) => (
            <Row key={p.id} id={p.id} title={p.title} sub={p.phaseName} right={`${p.days}d late`} rightTone="text-danger font-semibold" />
          ))}
        </Panel>
        <Panel title="Waiting on client" count={d.counts.waitingClient} tone="attention" empty="Nothing waiting on a client.">
          {d.waitingClient.map((x, i) => (
            <Row key={`${x.project.id}-${i}`} id={x.project.id} title={x.project.title} sub={`${x.docType}: ${x.docTitle}`} right={`sent ${ago(x.since)}`} />
          ))}
        </Panel>
        <Panel title="Waiting for review" count={d.counts.waitingReview} tone="attention" empty="No reviews waiting.">
          {d.waitingReview.map((x, i) => (
            <Row key={`${x.project.id}-${i}`} id={x.project.id} title={x.project.title} sub={`Reviewer: ${x.reviewer}`} right={`asked ${ago(x.since)}`} />
          ))}
        </Panel>
        <Panel title="This week" count={d.counts.thisWeek} empty="Nothing scheduled or due in the next 7 days.">
          {d.thisWeek.map((x, i) => (
            <Row
              key={`${x.project.id}-${i}`}
              id={x.project.id}
              title={x.project.title}
              sub={x.label}
              right={x.kind === "page" ? when(x.at) : `due ${dayMonthShort(x.day, d.today)}`}
            />
          ))}
        </Panel>
      </div>

      <div className="mt-3">
        <LatestChats rows={d.latestChats} ago={ago} />
      </div>
    </section>
  );
}
