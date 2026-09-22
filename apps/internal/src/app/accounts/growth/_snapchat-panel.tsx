"use client";

/**
 * The Snapchat board on Account Growth.
 *
 * ⚠️ THIS IS THE ONE BOARD WHOSE NUMBERS ARE NOT FROM AN API. Snapchat publishes no
 * follower or engagement API for profiles we do not own, so these figures are read from
 * each channel's PUBLIC profile page. That has two consequences the board must state
 * rather than paper over:
 *
 *   1. A profile can simply withhold its follower count — real for several of ours. That
 *      renders as a dash. It is NOT an error, and it must never render as 0, which would
 *      assert "this channel has no followers".
 *   2. Spotlight views are a partial sum. Snapchat chooses how many posts a profile page
 *      returns (a handful to a few dozen, varying per channel and per visit) and
 *      withholds the view count on most of them. So the figure is a sum over a different,
 *      unknowable slice per channel — which is exactly why this column is NOT sortable.
 *      Ranking channels by it would invent a league table out of sampling noise.
 */

import { useMemo, useState } from "react";
import type { ChannelRow } from "@/lib/hooks/use-channels";
import {
  ChannelBoardShell, ChannelLink, ErrorMark, PlainTh, RemoveCell, SortTh, SourceBadge, SyncBadge,
  compareCells, fmtDelta, fmtMetric,
  type SortDir,
} from "./_channel-shared";

/**
 * ⚠️ Deliberately NO key for Spotlight views or coverage. Sorting is a claim that the
 * column is comparable across rows, and this one is not — see the file header.
 */
type ColKey = "name" | "followers" | "followersDelta";

function colValue(c: ChannelRow, k: ColKey): number | string | null {
  switch (k) {
    case "name": return c.displayName || c.handle;
    case "followers": return c.followers;
    case "followersDelta": return c.followerDelta;
  }
}

export function SnapchatPanel() {
  const [sort, setSort] = useState<{ key: ColKey; dir: SortDir }>({ key: "followers", dir: "desc" });

  const onSort = (k: ColKey) =>
    setSort((cur) =>
      cur.key === k
        ? { key: k, dir: cur.dir === "desc" ? "asc" : "desc" }
        : { key: k, dir: k === "name" ? "asc" : "desc" });

  return (
    <ChannelBoardShell
      platform="snapchat"
      title="Snapchat channels"
      subtitle="Followers and recent Spotlight activity for the profiles we track"
      sourceNote={
        <>
          Read from each channel&apos;s{" "}
          <strong className="font-medium text-[#8A8A8A]">public Snapchat profile page</strong>.
          Snapchat publishes no API for profiles we do not own, so this is unofficial and
          best-effort — a profile can withhold a figure, and then we show a dash rather than
          guess at it.
        </>
      }
      followerNoun="followers"
      addPlaceholder="bollywoodchroni"
      addHint="Paste the profile's username. We open the public profile before saving, so a wrong spelling is rejected immediately rather than sitting here collecting nothing."
      followersAbsentNote="Snapchat does not publish a public follower count for that profile, so its Followers column will show a dash. The channel is still tracked."
      extraTotal={(b) => ({
        label: "Counts withheld",
        value: b.totals.followersWithheld,
        raw: true,
        note: b.totals.followersWithheld > 0
          ? "profiles publishing no follower number — they show a dash"
          : "every tracked profile publishes a follower count",
        title: "How many tracked profiles Snapchat publishes no public follower count for. Those rows show a dash in the Followers column — that is Snapchat's choice, not missing data on our side, and it is why the follower total above covers fewer channels than the board holds.",
      })}
      columnNote={
        <>
          <strong className="font-medium text-[#5A5A5A]">Spotlight views cannot be compared
          between channels</strong>, so this column cannot be sorted. Snapchat withholds the
          view count on most posts and chooses how many posts each profile page returns, so the
          figure is a sum over a different slice of posts for every channel. Read the Coverage
          column beside it to see how thin that slice is.
        </>
      }
      footnote={
        <>
          These figures are read from public Snapchat profile pages rather than an API, because
          Snapchat offers none for profiles we do not own — so they are best-effort and the
          badge beside each channel says how fresh each one actually is.{" "}
          <strong className="font-medium text-[#7A7A7A]">Followers</strong> is a live total and
          does not move with the period; <strong className="font-medium text-[#7A7A7A]">Change</strong>{" "}
          beside it is the movement across the selected one, measured from our own stored
          history and labelled with the span it truly covers. A dash in Followers means
          Snapchat publishes no count for that profile — not a zero, and not a fault.{" "}
          <strong className="font-medium text-[#7A7A7A]">Spotlight views</strong> is the summed
          view count of the recent Spotlight posts on the profile page that published one, and
          the <strong className="font-medium text-[#7A7A7A]">Coverage</strong> beside it says
          how many of the posts we saw that was. Because both the number of posts shown and the
          share publishing a count differ per channel, it is a rough sense of recent reach for
          one channel over time — never a ranking between channels.
        </>
      }
    >
      {({ rows, manageMode, onRemove, busy }) => (
        <SnapchatTable
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

function SnapchatTable({ rows, sort, onSort, manageMode, onRemove, busy }: {
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
    <table className="w-full min-w-[760px]">
      <thead>
        {/* ⚠️ The column COUNT is dynamic (Manage adds a Remove column), so header and
            body must gate that cell on the same flag — a mismatch shifts every cell in
            the row one column across. */}
        <tr className="text-[11px] text-[#7A7A7A] border-b border-[#F0EAE0]">
          <SortTh label="Channel" colKey="name" sort={sort} onSort={onSort} align="left" pad="px-5" />
          <SortTh
            colKey="followers" sort={sort} onSort={onSort}
            title="A live total, not a period figure — how many followers the profile has right now. A dash means Snapchat publishes no public count for it."
            label={<>Followers <span className="text-[#B0B0B0] font-normal">(now)</span></>}
          />
          <SortTh
            label="Change" colKey="followersDelta" sort={sort} onSort={onSort}
            title="Follower movement across the selected period, measured from our own stored history."
          />
          <PlainTh
            label="Spotlight views"
            title="Summed views of the recent Spotlight posts that published a count. Not a time window and not comparable between channels, which is why it cannot be sorted."
          />
          <PlainTh
            label="Coverage"
            title="How many of the Spotlight posts we saw on this profile actually published a view count. Snapchat withholds it on most of them."
          />
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
            {/* ⚠️ A withheld follower count is a dash with an explanation, never a 0.
                Several of our profiles genuinely publish none, and "0 followers" would
                be a confident statement of something that is not true. */}
            <td className="px-2 py-2 text-right text-xs font-semibold text-[#1A1A1A]">
              {c.followers === null ? (
                <span
                  title="Snapchat does not publish a public follower count for this profile. That is Snapchat's choice — the channel is tracked normally and this is not an error or a zero."
                  className="text-[#B0B0B0] font-normal"
                >
                  —
                </span>
              ) : (
                fmtMetric(c.followers)
              )}
            </td>
            <td className="px-2 py-2 text-right text-xs">
              {c.followerDelta === null || c.followerDelta === undefined ? (
                <span
                  title={c.followers === null
                    ? "No change to show: Snapchat publishes no follower count for this profile, so there is nothing to measure movement in."
                    : "No change to show for this period — there is not enough stored history yet. This is not a zero."}
                  className="text-[#B0B0B0]"
                >
                  —
                </span>
              ) : (
                <span className={
                  c.followerDelta > 0 ? "text-[#3E9B4F]"
                  : c.followerDelta < 0 ? "text-[#C0504D]"
                  : "text-[#B0B0B0]"
                }>
                  {fmtDelta(c.followerDelta)}
                  {/* ⚠️ Labelled from the change's OWN span, not the selected period —
                      stored history often starts later than a 90-day window reaches,
                      and calling a 12-day change "90d" understates growth while
                      sounding authoritative. */}
                  {c.followerDeltaDays != null && (
                    <span className="block text-[9px] font-normal text-[#B0B0B0] leading-tight">
                      {c.followerDeltaDays === 1 ? "24h" : `${c.followerDeltaDays}d`}
                    </span>
                  )}
                </span>
              )}
            </td>
            <td className="px-2 py-2 text-right text-xs">
              {c.recentViews === null ? (
                <span
                  title="None of the Spotlight posts on this profile published a view count, so there is nothing to sum. Snapchat withholds it on most posts."
                  className="text-[#B0B0B0]"
                >
                  —
                </span>
              ) : (
                fmtMetric(c.recentViews)
              )}
            </td>
            <td className="px-2 py-2 text-right text-[11px] text-[#7A7A7A] whitespace-nowrap">
              {c.recentPostsSeen === null || c.recentPostsSeen === undefined ? (
                <span className="text-[#B0B0B0]">—</span>
              ) : (
                <span title={`${c.recentViewsCovered ?? 0} of ${c.recentPostsSeen} Spotlight posts published a view count. The rest withhold it, so the Spotlight views figure covers only those ${c.recentViewsCovered ?? 0}.`}>
                  {c.recentViewsCovered ?? 0} of {c.recentPostsSeen}
                  <span className="block text-[9px] text-[#B0B0B0] leading-tight">posts w/ views</span>
                </span>
              )}
            </td>
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
