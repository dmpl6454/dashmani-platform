"use client";

/**
 * The YouTube board on Account Growth.
 *
 * ⚠️ THE ONE THING TO UNDERSTAND ABOUT THIS BOARD: subscriber counts are ROUNDED and
 * lifetime views are EXACT, so the two growth columns are not equally trustworthy.
 * YouTube publishes subscribers to three significant figures, which means a channel at
 * 10,500,000 shows no movement at all until it gains 100,000 — its change column is a
 * dash for weeks at a time and that dash means "smaller than the rounding step", never
 * "did not grow". The lifetime view counter is a precise integer, so Views change is the
 * column to read growth from. Both facts are stated on screen, not left to be inferred.
 */

import { useMemo, useState } from "react";
import type { ChannelRow } from "@/lib/hooks/use-channels";
import {
  ChannelBoardShell, ChannelLink, ErrorMark, RemoveCell, SortTh, SourceBadge, SyncBadge,
  compareCells, fmtDelta, fmtExact, fmtMetric, fmtStep,
  type SortDir,
} from "./_channel-shared";

type ColKey = "name" | "subs" | "subsDelta" | "views" | "viewsDelta" | "videos";

function colValue(c: ChannelRow, k: ColKey): number | string | null {
  switch (k) {
    case "name": return c.displayName || c.handle;
    case "subs": return c.followers;
    case "subsDelta": return c.followerDelta;
    case "views": return c.totalViews;
    case "viewsDelta": return c.viewsDelta;
    case "videos": return c.videoCount;
  }
}

/** A measured change, coloured by direction. "—" when nothing was measurable. */
function DeltaLine({ value, days, absentTitle }: {
  value: number | null;
  days: number | null;
  absentTitle: string;
}) {
  if (value === null || value === undefined) {
    return <span title={absentTitle} className="text-[#B0B0B0]">—</span>;
  }
  return (
    <span
      className={
        value > 0 ? "text-[#3E9B4F]" : value < 0 ? "text-[#C0504D]" : "text-[#B0B0B0]"
      }
    >
      {fmtDelta(value)}
      {/* ⚠️ Labelled from the change's OWN span, not from the selected period. Most
          channels' stored history starts later than a 90-day window reaches, so this
          row may genuinely be a 12-day change — printing "90d" would understate growth
          while sounding authoritative. */}
      {days != null && (
        <span className="block text-[9px] font-normal text-[#B0B0B0] leading-tight">
          {days === 1 ? "24h" : `${days}d`}
        </span>
      )}
    </span>
  );
}

export function YouTubePanel() {
  const [sort, setSort] = useState<{ key: ColKey; dir: SortDir }>({ key: "subs", dir: "desc" });

  const onSort = (k: ColKey) =>
    setSort((cur) =>
      cur.key === k
        ? { key: k, dir: cur.dir === "desc" ? "asc" : "desc" }
        : { key: k, dir: k === "name" ? "asc" : "desc" });

  return (
    <ChannelBoardShell
      platform="youtube"
      title="YouTube channels"
      subtitle="Subscribers, lifetime views and video counts for the channels we track"
      sourceNote={
        <>
          Read from <strong className="font-medium text-[#8A8A8A]">YouTube&apos;s official Data
          API</strong> — the same numbers YouTube itself publishes on the channel page. Nothing
          here is scraped or entered by hand.
        </>
      }
      followerNoun="subscribers"
      addPlaceholder="@BollywoodDazzle"
      addHint="Paste the @handle, the channel URL, or the UC… channel id. We look it up before saving, so a typo is rejected immediately rather than sitting here collecting nothing."
      followersAbsentNote="YouTube published no subscriber count for it (the channel has hidden its count)."
      extraTotal={(b) => ({
        label: "Lifetime views",
        value: b.totals.totalViews,
        note: "exact — YouTube's view counter is not rounded",
        title: "The summed all-time view count of every channel on this board. Not a period figure: it is a lifetime counter, so it only ever goes up.",
        // ⚠️ THE TRUSTWORTHY GROWTH FIGURE ON THIS BOARD. Subscribers are rounded to three
        // significant figures, so their summed change hides every movement below a
        // channel's step; the lifetime view counter is an exact integer, so this total
        // conceals nothing and needs no suppression count beside it.
        change: {
          value: b.totals.viewsDelta,
          channels: b.totals.viewsDeltaChannels,
          title:
            "How many views these channels gained across the selected period, summed over the " +
            `${b.totals.viewsDeltaChannels ?? 0} channel(s) whose stored view history spans it. This counter is exact, ` +
            "so unlike the subscriber change it hides nothing — it is the figure to read growth from.",
        },
      })}
      columnNote={
        <>
          <strong className="font-medium text-[#5A5A5A]">YouTube rounds subscriber counts to
          three significant figures</strong>, so a channel at 10.5m shows no movement until it
          gains a full 100,000 — a dash under Change means the movement is smaller than that
          rounding step, not that there was none.{" "}
          <strong className="font-medium text-[#5A5A5A]">Views change is exact</strong>: the
          lifetime view counter is a precise number, so that is the column to read growth from.
        </>
      }
      footnote={
        <>
          Every figure comes from YouTube&apos;s Data API and is refreshed on a schedule, so the
          badge beside each channel says how fresh it actually is rather than implying it is
          live. <strong className="font-medium text-[#7A7A7A]">Subscribers</strong> is a live
          total and does not move with the period — it is how many the channel has right now —
          while <strong className="font-medium text-[#7A7A7A]">Change</strong> beside it is the
          movement across the selected one, measured from our own stored history and labelled
          with the span it truly covers (often shorter than the period you picked, because
          history only reaches back so far). A dash anywhere means no number was published, not
          a zero. <strong className="font-medium text-[#7A7A7A]">Views</strong> is the channel&apos;s
          all-time view count, which is why it is far larger than anything on the Meta tab —
          that one counts a chosen period, this one counts forever.
        </>
      }
    >
      {({ rows, manageMode, onRemove, busy }) => (
        <YouTubeTable
          rows={rows}
          sort={sort}
          onSort={onSort}
          manageMode={manageMode}
          onRemove={onRemove}
          busy={busy}
        />
      )}
    </ChannelBoardShell>
  );
}

function YouTubeTable({ rows, sort, onSort, manageMode, onRemove, busy }: {
  rows: ChannelRow[];
  sort: { key: ColKey; dir: SortDir };
  onSort: (k: ColKey) => void;
  manageMode: boolean;
  onRemove: (row: ChannelRow) => void;
  busy: string | null;
}) {
  const sorted = useMemo(
    () => [...rows].sort((a, b) => compareCells(colValue(a, sort.key), colValue(b, sort.key), sort.dir)),
    [rows, sort],
  );

  return (
    // min-width + the shell's overflow-x-auto: the TABLE scrolls inside its own box, so
    // the page itself never overflows at 390px.
    <table className="w-full min-w-[820px]">
      <thead>
        {/* ⚠️ The column COUNT is dynamic (Manage adds a Remove column), so header and
            body must gate that cell on the same flag — a mismatch shifts every cell in
            the row one column across. */}
        <tr className="text-[11px] text-[#7A7A7A] border-b border-[#F0EAE0]">
          <SortTh label="Channel" colKey="name" sort={sort} onSort={onSort} align="left" pad="px-5" />
          <SortTh
            colKey="subs" sort={sort} onSort={onSort}
            title="A live total, not a period figure — how many subscribers the channel has right now. YouTube publishes it rounded to three significant figures."
            label={<>Subscribers <span className="text-[#B0B0B0] font-normal">(now)</span></>}
          />
          <SortTh
            label="Change" colKey="subsDelta" sort={sort} onSort={onSort}
            title="Subscriber movement across the selected period. Often a dash: YouTube's rounding hides any change smaller than the rounding step, and a 0 here would claim no growth when the truth is that we cannot see it."
          />
          <SortTh
            label="Views" colKey="views" sort={sort} onSort={onSort}
            title="The channel's ALL-TIME view count, exact and never windowed."
          />
          <SortTh
            label="Views change" colKey="viewsDelta" sort={sort} onSort={onSort}
            title="Growth of the exact lifetime view counter across the selected period — the trustworthy growth figure on this board."
          />
          <SortTh label="Videos" colKey="videos" sort={sort} onSort={onSort} />
          <th className="text-right font-medium px-5 py-2">Synced</th>
          {manageMode && <th className="text-right font-medium px-5 py-2">Manage</th>}
        </tr>
      </thead>
      <tbody>
        {sorted.map((c) => (
          <tr key={c.id} className="border-b border-[#F8F5EF] hover:bg-[#FCFBF8]">
            <td className="px-5 py-2">
              {/* min-w-0 on the flex child AND truncate on the name: the parent can only
                  clip what its children are willing to shrink. */}
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="text-xs font-medium text-[#1A1A1A] truncate max-w-[220px]">
                  {c.displayName || c.handle}
                </span>
                <span className="text-[10px] text-[#B0B0B0] truncate">@{c.handle}</span>
                <ChannelLink url={c.profileUrl} name={c.displayName || c.handle} />
                {c.metricsError && <ErrorMark message={c.metricsError} />}
              </div>
            </td>
            <td className="px-2 py-2 text-right text-xs font-semibold text-[#1A1A1A]">
              {fmtMetric(c.followers)}
              {/* The rounding step, said out loud. Without it the reader has no way to
                  know that "10.5m" is a bucket rather than a measurement. */}
              {c.followersPrecision != null && c.followersPrecision > 1 && (
                <span
                  title={`YouTube publishes this channel's subscriber count rounded to the nearest ${c.followersPrecision.toLocaleString()}, so the true figure is within ±${fmtStep(c.followersPrecision)} of what is shown and any smaller change is invisible.`}
                  className="block font-normal text-[10px] text-[#B0B0B0] leading-tight"
                >
                  ±{fmtStep(c.followersPrecision)}
                </span>
              )}
            </td>
            <td className="px-2 py-2 text-right text-xs">
              <DeltaLine
                value={c.followerDelta}
                days={c.followerDeltaDays}
                absentTitle={
                  // ⚠️ `followerDeltaDays` is stamped even when the change is suppressed, so
                  // its presence proves we DID measure across the period and the movement
                  // was simply finer than the rounding — a different thing from having no
                  // history at all, which used to be reported for both.
                  c.followerDeltaDays != null && c.followersPrecision != null && c.followersPrecision > 1
                    ? `No subscriber change to show: YouTube rounds this channel to the nearest ${c.followersPrecision.toLocaleString()}, and it moved less than that across the period. Read Views change instead — that counter is exact.`
                    : "No subscriber change to show for this period — we have not been collecting this channel long enough yet. This is not a zero."
                }
              />
            </td>
            {/* Exact, with separators: this figure's precision is the whole point of it. */}
            <td className="px-2 py-2 text-right text-xs tabular-nums" title={c.totalViews != null ? `${c.totalViews.toLocaleString()} views all time` : undefined}>
              {fmtMetric(c.totalViews)}
            </td>
            <td className="px-2 py-2 text-right text-xs">
              <DeltaLine
                value={c.viewsDelta}
                days={c.viewsDeltaDays}
                absentTitle="No view change to show for this period — we hold fewer than two days of view-count history for this channel. It is not a zero, and it fills in on its own as history accumulates."
              />
            </td>
            <td className="px-2 py-2 text-right text-xs text-[#7A7A7A]">{fmtExact(c.videoCount)}</td>
            <td className="px-5 py-2">
              {/* flex-wrap, not shrink-0, on a cell holding two pills: at a narrow width
                  they stack instead of painting over the column beside them. */}
              <div className="flex flex-wrap items-center justify-end gap-1">
                <SyncBadge lastSyncedAt={c.lastSyncedAt} metricsFetchedAt={c.metricsFetchedAt} />
                <SourceBadge source={c.syncSource} />
              </div>
            </td>
            {manageMode && <RemoveCell row={c} busy={busy} onRemove={onRemove} />}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
