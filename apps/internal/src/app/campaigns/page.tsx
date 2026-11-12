"use client";
import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { Tags, Youtube } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { usePageTitle } from "@/lib/hooks/use-page-title";
import { CARD, BTN_GHOST, ErrorBar, PageHead, StatusPill, fmtDate, rupees } from "./_ds";

type Row = {
  id: string;
  name: string;
  brand: string;
  client: string;
  status: string;
  format: string | null;
  campaignType: string;
  audioIntegration: boolean;
  totalPaise: number | null;
  launchFrom: string | null;
  launchTo: string | null;
  paidAt: string | null;
  itemCount: number;
  liveCount: number;
  /** The posting window closed with posts still open. */
  overdue?: boolean;
  /** When the client sent it for review. */
  submittedAt?: string | null;
  /** Our pages waiting for someone to post them. */
  toPostCount?: number;
  /** Creator pages offered to (or accepted by) their creator and not posted yet. */
  waitingOnCreatorCount?: number;
  /** Creator posts declined or not answered in time: refund or arrange another page. */
  creatorDeclinedCount?: number;
  nextCreatorDeadline?: string | null;
};

/** "3 h" / "2 d" since a timestamp, for the review clock. */
function waited(since: string, now: number): { label: string; late: boolean } {
  const h = Math.max(0, (now - +new Date(since)) / 3_600_000);
  return { label: h < 1 ? "under 1 h" : h < 48 ? `${Math.floor(h)} h` : `${Math.floor(h / 24)} d`, late: h >= 24 };
}

const FILTERS: { key: string; label: string; match: (s: string) => boolean }[] = [
  { key: "todo", label: "To do", match: (s) => ["paid_pending_review", "approved", "publishing"].includes(s) },
  { key: "changes", label: "Waiting on client", match: (s) => ["changes_requested", "awaiting_payment"].includes(s) },
  { key: "done", label: "Delivered", match: (s) => ["completed", "partially_published"].includes(s) },
  { key: "closed", label: "Rejected / refunded", match: (s) => ["rejected", "refunded"].includes(s) },
  { key: "all", label: "All", match: () => true },
];

export default function CampaignBookingsPage() {
  usePageTitle("Campaign Bookings");
  const [filter, setFilter] = useState("todo");
  const { data, error } = useSWR("/admin/campaigns", (u: string) => apiFetch<{ data: Row[] }>(u).then((r) => r.data), { refreshInterval: 60_000 });
  const active = FILTERS.find((f) => f.key === filter)!;
  const rows = (data ?? []).filter((r) => active.match(r.status));
  const needsReview = (data ?? []).filter((r) => r.status === "paid_pending_review").length;
  const live = (data ?? []).filter((r) => r.status === "approved" || r.status === "publishing" || r.status === "partially_published");
  // Counted per post, not per booking: a creator page waiting on its creator is not ours to post.
  const toPost = live.reduce((n, r) => n + (r.toPostCount ?? 0), 0);
  const waitingCreators = live.reduce((n, r) => n + (r.waitingOnCreatorCount ?? 0), 0);
  const declined = live.reduce((n, r) => n + (r.creatorDeclinedCount ?? 0), 0);
  const [now] = useState(() => Date.now());

  return (
    <div className="pb-8">
      <PageHead
        title="Campaign Bookings"
        sub={!data ? "Loading…" : [`${needsReview} to review`, `${toPost} post${toPost === 1 ? "" : "s"} to make`, waitingCreators ? `${waitingCreators} with creators` : "", declined ? `${declined} declined by creators — act on ${declined === 1 ? "it" : "them"}` : ""].filter(Boolean).join(" · ")}
        right={
          <div className="flex gap-2">
            <Link href="/campaigns/youtube" className={BTN_GHOST}>
              <Youtube className="h-4 w-4" /> YouTube
            </Link>
            <Link href="/campaigns/rate-cards" className={BTN_GHOST}>
              <Tags className="h-4 w-4" /> Rate card
            </Link>
          </div>
        }
      />

      <div className="flex gap-1.5 flex-wrap mb-4" role="tablist">
        {FILTERS.map((f) => {
          const n = (data ?? []).filter((r) => f.match(r.status)).length;
          const on = f.key === filter;
          return (
            <button
              key={f.key}
              role="tab"
              aria-selected={on}
              type="button"
              onClick={() => setFilter(f.key)}
              className={`h-9 px-3.5 rounded-full text-[12.5px] font-semibold border transition-colors ${on ? "border-ds-gold text-ds-gold bg-[rgba(233,189,98,.08)]" : "border-ds-line2 text-ds-t2 hover:text-ds-text"}`}
            >
              {f.label} <span className="tabular-nums opacity-70">{n}</span>
            </button>
          );
        })}
      </div>

      {error && <ErrorBar message="Couldn't load bookings. Refresh to try again." />}

      <section className={`${CARD} overflow-hidden`}>
        {data && rows.length === 0 && <div className="py-14 text-center text-ds-t3 text-[13px]">Nothing here.</div>}
        {!data && !error && <div className="py-14 text-center text-ds-t3 text-[13px]">Loading…</div>}
        {rows.map((r, i) => (
          <Link
            key={r.id}
            href={`/campaigns/${r.id}`}
            className={`flex flex-col md:flex-row md:items-center gap-2 md:gap-4 px-5 py-4 hover:bg-ds-hover transition-colors ${i < rows.length - 1 ? "border-b border-[#132430]" : ""}`}
          >
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-semibold text-ds-text truncate">{r.name}</div>
              <div className="text-[12px] text-ds-t3 truncate">{r.client} · {r.brand} · {r.campaignType === "entertainment" ? "Entertainment" : "Brand"} · {r.format ?? "—"}{r.audioIntegration ? " + audio" : ""} · {fmtDate(r.launchFrom)} – {fmtDate(r.launchTo)}</div>
            </div>
            <div className="flex items-center gap-4 shrink-0 text-[12.5px] text-ds-t2">
              {r.status === "paid_pending_review" && r.submittedAt && (() => {
                const w = waited(r.submittedAt, now);
                return <span className={`rounded-full px-2 py-0.5 text-[11.5px] font-semibold ${w.late ? "bg-amber-500/15 text-amber-300" : "bg-ds-hover text-ds-t2"}`} title="Time since the client submitted it — we promise a review within one working day">Waiting {w.label}</span>;
              })()}
              {(r.creatorDeclinedCount ?? 0) > 0 && <span className="rounded-full bg-red-500/15 text-red-300 px-2 py-0.5 text-[11.5px] font-semibold">Creator declined</span>}
              {(r.waitingOnCreatorCount ?? 0) > 0 && <span className="rounded-full bg-ds-hover text-ds-t2 px-2 py-0.5 text-[11.5px] font-semibold" title={r.nextCreatorDeadline ? `Next creator answer due ${new Date(r.nextCreatorDeadline).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" })} IST` : undefined}>{r.waitingOnCreatorCount} with creator</span>}
              {r.overdue && <span className="rounded-full bg-red-500/15 text-red-300 px-2 py-0.5 text-[11.5px] font-semibold">Window passed</span>}
              <span className="tabular-nums">{r.liveCount}/{r.itemCount} posted</span>
              <span className="tabular-nums font-semibold text-ds-text w-[84px] text-right">{rupees(r.totalPaise)}</span>
              <StatusPill status={r.status} />
            </div>
          </Link>
        ))}
      </section>
    </div>
  );
}
