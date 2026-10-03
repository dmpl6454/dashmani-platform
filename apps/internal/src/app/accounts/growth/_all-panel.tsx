"use client";

/**
 * The All tab on Account Growth — every board added up, where a figure means the same
 * thing on every platform.
 *
 * ⚠️ IT RE-MEASURES NOTHING. The owner asked on 2026-10-01 for "a fourth tab that depicts
 * 'All' the data in a combined format … with clear labels … with accurate date depicted
 * e2e". The cross-platform roll-ups removed on 2026-08-24 were cut because they came from
 * follower SNAPSHOTS rather than each platform's own metrics, so this tab only composes the
 * three boards' OWN figures — from the same three endpoints the sibling tabs call — and
 * labels every figure with its source and the exact dates it covers. The composition and
 * every display rule (what may be shown as a number, why a figure is absent, which dates it
 * covers) are pure functions in packages/shared/src/growth/combine.ts, tested in apps/api.
 *
 * ⚠️ PERIODS ARE 7 AND 28 DAYS ONLY. They are the spans every platform can measure alike:
 * Meta answers only its native rolling windows (`week`, `days_28`) and the YouTube/
 * Snapchat boards measure any day count from stored snapshots. 28d reuses the Meta tab's
 * default key (`/admin/meta/channels?window=days_28`), so switching tabs costs no request.
 *
 * ⚠️ TOTALS COVER EVERY CHANNEL; SEARCH FILTERS THE TABLE ONLY. The YouTube/Snapchat
 * totals are computed on their server and do not follow a search, and Meta's own search is
 * a server filter that would cost a request per keystroke and narrow only its third of the
 * totals. So search here is client-side and never sent to the server, and the UI says so.
 *
 * ⚠️ No revenue anywhere on this tab — it is Meta-only and has nothing to be added to.
 * Engagements, reach and profile views likewise: one line points to the Meta tab.
 *
 * ⚠️ A null renders as an em-dash, never 0 (fmtMetric / fmtExact / fmtDelta). Do not reach
 * for use-growth's fmtCompact or DeltaBadge: no billions tier, and DeltaBadge prints a null
 * delta as "0" — the fabricated-zero class.
 *
 * ⚠️ Prose that explains a state lives OUTSIDE the tables' horizontal scrollers. Inside one,
 * the table's min-width stretches the sentence past a phone's edge and its Retry with it
 * (measured at 375px: the error text cut off at 193px, Retry at x=807px).
 */

import { useDeferredValue, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import {
  combineGrowth,
  filterGrowthChannels,
  growthChannelSortValue,
  growthMetaWindow,
  growthPlatformChangeView,
  growthCombinedChangeView,
  growthHistoryRequirement,
  growthPeriodText,
  growthSourceProblems,
  growthTableCountLabel,
  growthTableEmpty,
  growthRefreshFailureText,
  growthListNames,
  fmtGrowthIstClock,
  GROWTH_ALL_PERIODS,
  DEFAULT_GROWTH_ALL_PERIOD,
  GROWTH_PLATFORMS,
  GROWTH_PLATFORM_LABEL,
  GROWTH_PLATFORM_TAB,
  GROWTH_SOURCE_OF,
  type GrowthAllPeriod,
  type GrowthPlatform,
  type GrowthPlatformAggregate,
  type GrowthChannelRow,
  type GrowthChannelSortKey,
  type GrowthCombined,
  type GrowthCombination,
  type GrowthSource,
  type GrowthSourceInput,
  // ⚠️ The module, NOT the @dashmani/shared barrel: page.tsx imports this panel
  // statically, so the barrel would put zod and every validator into the first load of
  // ALL four tabs (measured /accounts/growth 127 → 156 kB). combine.ts is pure and has
  // only a type import. Enforced by scripts/ci/guards.sh (no-shared-barrel-growth).
} from "@dashmani/shared/src/growth/combine";
import { useMetaChannels } from "@/lib/hooks/use-meta";
import { useChannelBoard } from "@/lib/hooks/use-channels";
import { channelHref } from "./_meta-panel";
import {
  ChannelLink, PlainTh, SortTh, SourceBadge,
  compareCells, fmtDelta, fmtExact, fmtMetric, relativeTime,
  type SortDir,
} from "./_channel-shared";

/** The tabs this one can send a reader to. */
type SiblingTab = "meta" | "youtube" | "snapchat";

const CARD = "bg-white rounded-2xl border border-[#E8E0D0] shadow-[0_2px_16px_rgba(0,0,0,0.05)] overflow-hidden";

/** Soft platform pills — the same palette the reports pages and link previews use. */
const PLATFORM_PILL: Record<GrowthPlatform, string> = {
  facebook: "bg-blue-50 text-blue-600 border-blue-200",
  instagram: "bg-pink-100 text-pink-700 border-pink-200",
  youtube: "bg-red-50 text-red-700 border-red-200",
  snapchat: "bg-yellow-100 text-yellow-700 border-yellow-200",
};

/** Where each platform's figures come from — said on every row, not only in a footnote. */
const SOURCE: Record<GrowthPlatform, { badge: "api" | "scraper"; label: string }> = {
  facebook: { badge: "api", label: "Meta API" },
  instagram: { badge: "api", label: "Meta API" },
  youtube: { badge: "api", label: "YouTube Data API" },
  snapchat: { badge: "scraper", label: "Public profile pages" },
};

/** The sources in display order, with the platforms each one feeds. */
const SOURCES: readonly GrowthSource[] = ["meta", "youtube", "snapchat"];
const platformsOf = (s: GrowthSource) => GROWTH_PLATFORMS.filter((p) => GROWTH_SOURCE_OF[p] === s);

/** "YouTube's", "YouTube's and Snapchat's" — for "±X from YouTube's and Snapchat's rounded counts". */
function possessives(ps: readonly GrowthPlatform[]): string {
  const n = ps.map((p) => `${GROWTH_PLATFORM_LABEL[p]}'s`);
  if (n.length <= 1) return n[0] ?? "";
  return `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
}

/** An SWR result as a combineGrowth input: loaded data wins, then an error, else loading. */
function sourceOf<T>(data: T | undefined, error: unknown): GrowthSourceInput<T> {
  if (data !== undefined) return data;
  if (error) return { error: error instanceof Error && error.message ? error.message : "Could not load." };
  return undefined;
}

/** A signed change, prefixed "≈" when it sits inside its own rounding error bar. */
function fmtChange(v: number | null, approx: boolean): string {
  return v === null ? "—" : `${approx ? "≈ " : ""}${fmtDelta(v)}`;
}

function changeTone(v: number | null, approx: boolean): string {
  if (v === null) return "text-[#1A1A1A]";
  if (approx) return "text-[#8A8A8A]";
  return v > 0 ? "text-[#3E9B4F]" : v < 0 ? "text-[#C0504D]" : "text-[#8A8A8A]";
}

/**
 * A row's own span when it is not the period — "12d", "24h". ⚠️ Labelled from the figure's
 * OWN span: stored history often starts later than the period reaches, and printing "28d"
 * over a 12-day change understates growth while sounding authoritative.
 */
function spanSuffix(days: number | null, periodDays: number): string | null {
  if (days === null || days === periodDays) return null;
  return days === 1 ? "24h" : `${days}d`;
}

function PlatformPill({ platform }: { platform: GrowthPlatform }) {
  return (
    <span className={`inline-flex items-center text-[10px] font-medium border rounded-full px-1.5 py-0.5 leading-none whitespace-nowrap ${PLATFORM_PILL[platform]}`}>
      {GROWTH_PLATFORM_LABEL[platform]}
    </span>
  );
}

/**
 * The channel's latest refresh failed. Deliberately not the boards' ErrorMark: its tooltip
 * blames a changed handle, which is wrong for Meta, where a failure is usually lost admin
 * access. ⚠️ And worded by kind, never quoting the platform's reply — Meta's transient (#2)
 * reads "An unexpected error has occurred", a phrase the owner banned from the screen.
 */
function RefreshMark({ message, platform }: { message: string; platform: GrowthPlatform }) {
  return (
    <span title={growthRefreshFailureText(message, platform)}>
      <AlertTriangle className="h-3 w-3 text-[#C2861D] shrink-0" />
    </span>
  );
}

export function AllPanel({ onOpenTab }: { onOpenTab?: (tab: SiblingTab) => void }) {
  const [days, setDays] = useState<GrowthAllPeriod>(DEFAULT_GROWTH_ALL_PERIOD);
  const [q, setQ] = useState("");
  // ⚠️ The table holds ~470 rows. Filtering on the DEFERRED query keeps typing responsive:
  // React re-renders the table at low priority instead of inside each keystroke. Still
  // client-side only — nothing is sent to the server.
  const qDeferred = useDeferredValue(q);
  const [platformFilter, setPlatformFilter] = useState<GrowthPlatform | "all">("all");
  const [sort, setSort] = useState<{ key: GrowthChannelSortKey; dir: SortDir }>({ key: "followers", dir: "desc" });

  // ⚠️ THE SIBLING TABS' OWN HOOKS, so keys match wherever the tabs overlap and the cache is
  // shared: Meta's `?window=days_28` / `?window=week` (no platform, no q, no sort — exactly
  // what the Meta tab sends for All + no search), and the boards' `platform&days=7`. Only the
  // boards' `days=28` is this tab's own key. Three requests per period, each memoised
  // server-side; no polling (the hooks set no refreshInterval and revalidateOnFocus:false).
  const metaQ = useMetaChannels({ window: growthMetaWindow(days) });
  const ytQ = useChannelBoard("youtube", days);
  const scQ = useChannelBoard("snapchat", days);

  const combo = useMemo(
    () => combineGrowth({
      meta: sourceOf(metaQ.data, metaQ.error),
      youtube: sourceOf(ytQ.data, ytQ.error),
      snapchat: sourceOf(scQ.data, scQ.error),
      periodDays: days,
      // The Meta tab's own link rule (numeric Page id for Facebook, handle for Instagram).
      metaHref: channelHref,
    }),
    [metaQ.data, metaQ.error, ytQ.data, ytQ.error, scQ.data, scQ.error, days],
  );

  // Loaded data plus a failed REVALIDATION: the figures shown are still the last good ones.
  const refreshFailed: Record<GrowthSource, boolean> = {
    meta: metaQ.data !== undefined && !!metaQ.error,
    youtube: ytQ.data !== undefined && !!ytQ.error,
    snapchat: scQ.data !== undefined && !!scQ.error,
  };
  const retry: Record<GrowthSource, () => void> = {
    meta: () => void metaQ.mutate(),
    youtube: () => void ytQ.mutate(),
    snapchat: () => void scQ.mutate(),
  };
  const retrySources = (ps: readonly GrowthPlatform[]) => {
    for (const s of new Set(ps.map((p) => GROWTH_SOURCE_OF[p]))) retry[s]();
  };
  const openTab = (t: SiblingTab) => {
    onOpenTab?.(t);
    // ⚠️ The link sits a screen or more down the page, and switching panels keeps the
    // scroll position — the reader would land part-way through the Meta table with the tab
    // strip and its header out of view. Back to the top, where both are. Either element
    // can be the scroller (the portal's <main> is overflow-y-auto), so ask both.
    window.scrollTo({ top: 0 });
    document.querySelector("main")?.scrollTo({ top: 0 });
  };

  const periodDays = combo.periodDays;
  const c = combo.combined;
  // Day keys are formatted against the viewer's own year (client-only render: every value
  // shown here comes from SWR, so this never runs during prerender).
  const currentYear = new Date().getFullYear();
  const fbDayEnd = fmtGrowthIstClock(metaQ.data?.dayStarts?.facebook);
  const requirement = growthHistoryRequirement(periodDays);

  const filtered = useMemo(
    () => filterGrowthChannels(combo.channels, { q: qDeferred, platform: platformFilter }),
    [combo.channels, qDeferred, platformFilter],
  );
  const sorted = useMemo(
    () => [...filtered].sort((a, b) =>
      compareCells(growthChannelSortValue(a, sort.key), growthChannelSortValue(b, sort.key), sort.dir)),
    [filtered, sort],
  );
  const onSort = (k: GrowthChannelSortKey) =>
    setSort((cur) =>
      cur.key === k
        ? { key: k, dir: cur.dir === "desc" ? "asc" : "desc" }
        : { key: k, dir: k === "name" || k === "platform" ? "asc" : "desc" });

  // ⚠️ A non-admin's 403 is not an outage. Every endpoint here shares one admin-only gate,
  // so when all of them refuse, say that once instead of three "could not be loaded" boxes.
  const allForbidden = GROWTH_PLATFORMS.every((p) => combo.platforms[p].forbidden);
  if (allForbidden) {
    return (
      <section className={`${CARD} p-5 space-y-2`}>
        <h2 className="font-serif text-lg text-[#1A1A1A]">All platforms</h2>
        <p className="text-sm text-[#7A7A7A]">Only administrators can see Account Growth.</p>
        <p className="text-[11px] text-[#B0B0B0]">Ask a Super Admin or Admin if you need these figures.</p>
      </section>
    );
  }

  return (
    <div className="space-y-6">
      <section className={CARD}>
        <div className="px-5 py-4 border-b border-[#F0EAE0]">
          <h2 className="font-serif text-lg text-[#1A1A1A]">All platforms</h2>
          <p className="text-xs text-[#7A7A7A] mt-0.5">
            Facebook, Instagram, YouTube and Snapchat together — added up only where a figure means
            the same thing on every platform
          </p>
          <p className="text-[11px] text-[#B0B0B0] mt-1 leading-snug max-w-3xl">
            Every number comes from that platform&apos;s own board, under the rules its own tab uses —{" "}
            <strong className="font-medium text-[#8A8A8A]">Meta&apos;s API</strong> for Facebook and
            Instagram, <strong className="font-medium text-[#8A8A8A]">YouTube&apos;s Data API</strong>,
            and <strong className="font-medium text-[#8A8A8A]">Snapchat&apos;s public profile
            pages</strong> — added together. Nothing is re-measured, and each figure says which dates
            it covers. The YouTube and Snapchat tabs offer 7, 14, 30 and 90 days: their 7-day figures
            are the ones those tabs show, while 28 days is measured for this tab alone.
          </p>
        </div>

        <div className="px-5 py-2.5 border-b border-[#F0EAE0] flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap items-center gap-1 mr-1" role="group" aria-label="Reporting period">
            <span className="text-[11px] text-[#B0B0B0] mr-0.5">Period</span>
            {GROWTH_ALL_PERIODS.map((d) => (
              <button
                key={d}
                onClick={() => setDays(d)}
                aria-pressed={days === d}
                className={`text-[11px] rounded-full px-2.5 py-1 border ${
                  days === d
                    ? "bg-[#5B4BF5] text-white border-[#5B4BF5]"
                    : "border-[#DCDCDC] text-[#7A7A7A] hover:bg-[#FAFAFA]"}`}
              >
                {d}d
              </button>
            ))}
          </div>
          <span className="text-[10px] text-[#B0B0B0] leading-snug min-w-0">
            Only 7 and 28 days: the periods every platform can measure over the same span.
          </span>
        </div>

        <Tiles combo={combo} currentYear={currentYear} />

        <div className="px-5 pt-4 pb-2">
          <h3 className="text-xs font-medium text-[#1A1A1A]">By platform</h3>
          <p className="text-[10px] text-[#B0B0B0] mt-0.5 leading-snug max-w-3xl">
            Each row is that platform&apos;s own board, with the exact dates its figures cover. The
            Total adds the rows that loaded; a platform that did not load is named, never counted
            as zero. A change too small for its platform&apos;s rounding shows that limit instead of
            a number, and adds only its ± to the Total.
          </p>
        </div>
        <SourceStatus combo={combo} refreshFailed={refreshFailed} onRetry={(s) => retry[s]()} />
        <DatesList combo={combo} currentYear={currentYear} />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px]">
            <thead>
              <tr className="text-[11px] text-[#7A7A7A] border-b border-[#F0EAE0]">
                <PlainTh label="Platform" align="left" pad="px-5" />
                <PlainTh label="Channels" />
                <PlainTh
                  label={<>Followers <span className="text-[#B0B0B0] font-normal">(now)</span></>}
                  title="A live total, not a period figure — how many followers (and YouTube subscribers) the channels have now, as each platform last reported them."
                />
                <PlainTh
                  label={`Change · ${periodDays}d`}
                  title={`Follower change over the period, counting only channels whose own history covers ${requirement}. A YouTube or Snapchat change smaller than its rounding is shown as that limit, not as a number — as on those tabs — and the Total adds only its ±.`}
                />
                <PlainTh
                  label={`Views · ${periodDays}d`}
                  title="Views over the period, as each platform counts them. Snapchat publishes no period view count."
                />
                <PlainTh label="Period covered" align="left" title="The exact dates each platform's change and views cover, and whose calendar they are on." />
                <PlainTh label="Source" align="left" pad="px-5" />
              </tr>
            </thead>
            <tbody>
              {GROWTH_PLATFORMS.map((p) => (
                <PlatformRow
                  key={p}
                  a={combo.platforms[p]}
                  currentYear={currentYear}
                  refreshFailed={refreshFailed[GROWTH_SOURCE_OF[p]]}
                />
              ))}
              <TotalRow c={c} />
            </tbody>
          </table>
        </div>

        <p className="px-5 py-3 text-[11px] text-[#B0B0B0] leading-snug border-t border-[#F0EAE0]">
          <strong className="font-medium text-[#7A7A7A]">Whose day each date is.</strong>{" "}
          <strong className="font-medium text-[#7A7A7A]">Facebook</strong>&apos;s views are Meta&apos;s own
          rolling {periodDays}-day window on Pacific days — Facebook&apos;s day ends at Pacific
          midnight ({fbDayEnd ? `${fbDayEnd} IST` : "12:30 PM IST, 1:30 PM in winter"}).{" "}
          <strong className="font-medium text-[#7A7A7A]">Instagram</strong>&apos;s are the same window
          on UTC days — Instagram&apos;s day ends at midnight UTC (5:30 AM IST). The two can therefore
          end on different calendar days, and each row says which.{" "}
          <strong className="font-medium text-[#7A7A7A]">YouTube</strong> and{" "}
          <strong className="font-medium text-[#7A7A7A]">Snapchat</strong> are measured between our own
          daily snapshots, dated on the Indian calendar; each figure names the snapshot dates it really
          covers, which can be shorter than the period while history builds up.{" "}
          <strong className="font-medium text-[#7A7A7A]">Follower change</strong> counts only channels
          whose own history covers {requirement} — a shorter history is left out rather than counted as
          flat. For Facebook and Instagram it runs from our daily API follower snapshots to each
          channel&apos;s current count, so it has its own dates rather than the views window&apos;s:
          Facebook&apos;s count is re-read on every Meta sync, Instagram&apos;s only when the channels
          are refreshed (on connecting, or with Refresh channels on the Meta tab). An Instagram account
          without that history uses Meta&apos;s own follows-minus-unfollows for the views window. YouTube
          and Snapchat publish rounded counts, so a change smaller than their ± is shown as that limit
          rather than as a number, and the Total counts it in the ± only.{" "}
          <strong className="font-medium text-[#7A7A7A]">Followers</strong> is a live total and reads
          the same on both periods. <strong className="font-medium text-[#7A7A7A]">Views</strong> are
          each platform&apos;s own count: Meta counts every time content was shown or played, including
          repeats; YouTube&apos;s is the growth of its exact lifetime view counter; Snapchat publishes
          no period view count, so it is left out. A dash is never a zero: the platform published
          nothing, our history does not cover the period yet, or the movement is finer than the
          platform&apos;s rounding. Engagements, reach and revenue are Meta-only — see the{" "}
          {onOpenTab ? (
            <button onClick={() => openTab("meta")} className="underline hover:text-[#1A1A1A]">Meta tab</button>
          ) : (
            "Meta tab"
          )}
          .
        </p>
      </section>

      <section className={CARD}>
        <div className="px-5 py-4 border-b border-[#F0EAE0]">
          <h2 className="font-serif text-lg text-[#1A1A1A]">All channels</h2>
          <p className="text-xs text-[#7A7A7A] mt-0.5">
            Every tracked channel on one list, each with its own platform&apos;s figures
          </p>
        </div>

        <div className="px-5 py-2.5 border-b border-[#F0EAE0] flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Platform">
            {(["all", ...GROWTH_PLATFORMS] as const).map((p) => (
              <button
                key={p}
                onClick={() => setPlatformFilter(p)}
                aria-pressed={platformFilter === p}
                className={`text-[11px] rounded-full px-2.5 py-1 border ${
                  platformFilter === p
                    ? "bg-[#1A1A1A] text-white border-[#1A1A1A]"
                    : "border-[#DCDCDC] text-[#7A7A7A] hover:bg-[#FAFAFA]"}`}
              >
                {p === "all" ? "All" : GROWTH_PLATFORM_LABEL[p]}
              </button>
            ))}
          </div>
          <span className="hidden sm:block h-4 w-px bg-[#E8E0D0]" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search channels…"
            aria-label="Search channels"
            // ⚠️ 16px on phones. iOS Safari auto-zooms into any focused input below that
            // and then pans the viewport, which is how controls end up off-screen.
            className="text-[16px] sm:text-[13px] border border-[#DCDCDC] rounded-full px-3 py-1 w-40 focus:outline-none focus:border-[#B0B0B0]"
          />
          <span className="text-[10px] text-[#B0B0B0] leading-snug">
            Totals cover every channel; search and the platform filter narrow this table only.
          </span>
          <span className="text-[11px] text-[#B0B0B0] ml-auto">
            {/* ⚠️ Only a loaded response may claim a count: never "0 channels" over sources
                that are still loading or failed (growthTableCountLabel). */}
            {growthTableCountLabel(combo, { shown: sorted.length, platform: platformFilter })}
          </span>
        </div>

        {(c.loadingPlatforms.length > 0 || c.failedPlatforms.length > 0) && (
          <p className="px-5 py-2 border-b border-[#F6F2EA] text-[10px] text-[#7A7A7A] leading-snug">
            {c.loadingPlatforms.length > 0 && (
              <>Still loading: <strong className="font-medium text-[#5A5A5A]">{growthListNames(c.loadingPlatforms)}</strong>. </>
            )}
            {c.failedPlatforms.length > 0 && (
              <>
                <span className="text-[#C0504D]">
                  Not listed: {growthListNames(c.failedPlatforms)} — couldn&apos;t load.
                </span>{" "}
                <button onClick={() => retrySources(c.failedPlatforms)} className="underline hover:text-[#1A1A1A]">
                  Retry
                </button>
              </>
            )}
          </p>
        )}

        {combo.channels.length > 0 && (
          <p className="px-5 py-2 border-b border-[#F6F2EA] text-[10px] text-[#7A7A7A] leading-snug">
            Each row shows its own platform&apos;s figures, so spans differ by platform; a small figure
            under a value is that row&apos;s own span when it is not the period. A dash is never a zero:
            the channel&apos;s history doesn&apos;t cover the period yet, its movement is finer than the
            platform&apos;s rounding, or the platform publishes no such figure (Snapchat publishes no
            period view count). A{" "}
            <span className="line-through decoration-[#C2861D]">struck-through</span> change jumped
            between two different channels and is left out of every total and of the Change sort.
          </p>
        )}

        <div className="overflow-x-auto">
          <ChannelsTable
            combo={combo}
            rows={sorted}
            platformFilter={platformFilter}
            searching={qDeferred.trim() !== ""}
            sort={sort}
            onSort={onSort}
          />
        </div>
      </section>
    </div>
  );
}

// ─── Tiles ───────────────────────────────────────────────────────────────────────

function Tiles({ combo, currentYear }: { combo: GrowthCombination; currentYear: number }) {
  const c = combo.combined;
  const n = combo.periodDays;
  const P = combo.platforms;
  // ⚠️ While ANY source is loading the combined figures are not final: a sum that jumps as
  // each request lands reads as data changing. Show the loading state until all answered.
  const settled = c.settled;
  // Every source answered and none loaded: say that once rather than "across 0 platforms".
  const noneLoaded = settled && c.includedPlatforms.length === 0;
  const NONE = "no board could be loaded — see By platform below";
  // ⚠️ A PARTIAL SUM MUST NOT READ AS THE ESTATE. Meta is ~90% of the followers, so with it
  // missing the headline drops from ~368m to ~43m — which looks like wiped data. The values
  // are muted and the exclusion gets its own red line above them, not a trailing grey clause.
  const partial = settled && !noneLoaded && c.failedPlatforms.length > 0;
  const warn = partial
    ? `Partial totals — ${growthListNames(c.failedPlatforms)} couldn't load, so every figure below leaves ` +
      `${c.failedPlatforms.length > 1 ? "them" : "it"} out rather than counting ${c.failedPlatforms.length > 1 ? "them" : "it"} as zero.`
    : null;

  const syncedLine = (["youtube", "snapchat"] as const)
    .filter((p) => P[p].latestSyncedAt)
    .map((p) => `${GROWTH_PLATFORM_LABEL[p]} ${relativeTime(P[p].latestSyncedAt)}`)
    .join(", ");
  const igListed = P.instagram.state === "ready" && (P.instagram.channels ?? 0) > 0;

  /** "Facebook: 3 Sep → latest sync", from the same text the By-platform table prints. */
  const datesOf = (p: GrowthPlatform, which: "change" | "views") => {
    const t = growthPeriodText(P[p], currentYear);
    const v = which === "change" ? (t.change ?? t.changeWhy) : (t.views ?? t.viewsWhy);
    return `${GROWTH_PLATFORM_LABEL[p]}: ${v ?? "—"}`;
  };
  const datedReady = GROWTH_PLATFORMS.filter((p) => P[p].state === "ready" && (P[p].channels ?? 0) > 0);

  const pm = c.uncertainty > 0 ? `±${fmtMetric(c.uncertainty)} from ${possessives(c.uncertaintyPlatforms)} rounded counts` : null;
  const changeView = growthCombinedChangeView(c);
  const changeChannels = `${c.followerDeltaChannels} channel${c.followerDeltaChannels === 1 ? "" : "s"}`;
  // ⚠️ A board whose own change is inside its rounding shows no number on its row, so it is
  // not in this figure either — only in the ± (combine.ts). Say so, or the tile reads as if
  // that board was forgotten.
  const unresolvedPs = c.followerDeltaUnresolvedPlatforms;
  const inPmOnly = unresolvedPs.length > 0
    ? `${growthListNames(unresolvedPs)}: finer than ${unresolvedPs.length > 1 ? "their" : "its"} rounding, counted in the ± only`
    : null;
  const changeNote = (() => {
    if (!settled) return "Loading…";
    if (noneLoaded) return NONE;
    if (changeView.kind === "value") {
      // The ± leads when it is bigger than the change itself: it is the headline then.
      return (changeView.approx && pm
        ? [`${pm}, more than the change itself`, growthListNames(c.followerDeltaPlatforms), changeChannels, inPmOnly]
        : [growthListNames(c.followerDeltaPlatforms), changeChannels, pm, inPmOnly]
      ).filter(Boolean).join(" · ");
    }
    if (changeView.kind === "unresolved") {
      // Worded as the YouTube/Snapchat tabs word it: the limit, never the number inside it.
      return `movement is smaller than the ±${fmtMetric(changeView.uncertainty)} ${possessives(c.uncertaintyPlatforms)} rounding can resolve`;
    }
    if (changeView.kind === "absent" && changeView.reason === "below-step") {
      return `${c.followerDeltaSuppressed} channel${c.followerDeltaSuppressed === 1 ? "" : "s"} moved less than the rounding step; none has a countable change${pm ? ` · ${pm}` : ""}`;
    }
    if (changeView.kind === "absent" && changeView.reason === "excluded") {
      return `${c.followerDeltaExcluded} excluded as unreliable; none left to count`;
    }
    if (changeView.kind === "absent" && changeView.reason === "no-channels") return "no channels tracked yet";
    return `no channel's own history covers ${growthHistoryRequirement(n)} yet`;
  })();

  const tiles: Array<{ id: string; label: string; value: string; tone: string; note: ReactNode; title: string }> = [
    {
      id: "channels",
      label: "Channels",
      value: settled ? fmtExact(c.channels) : "—",
      tone: "text-[#1A1A1A]",
      note: !settled ? "Loading…" : noneLoaded ? NONE : `across ${c.includedPlatforms.length} platform${c.includedPlatforms.length === 1 ? "" : "s"}`,
      title:
        "How many channels the boards track: the Facebook Pages and Instagram accounts the connected " +
        "Meta account administers, plus the channels on the YouTube and Snapchat boards. Removed " +
        "channels are not counted.",
    },
    {
      id: "followers",
      // ⚠️ "(now)" is load-bearing: followers is a STOCK, window-invariant BY DEFINITION, and
      // reads the same on 7d and 28d. Reported as "faulty data" three times on the Meta board.
      label: "Followers & subscribers (now)",
      value: settled ? fmtMetric(c.followers) : "—",
      tone: "text-[#1A1A1A]",
      note: !settled
        ? "Loading…"
        : noneLoaded
          ? NONE
          : `${c.followersReported} of ${c.followersTotal} channels publish a count` +
            (igListed ? " · Instagram as of the last channel refresh" : ""),
      title:
        "A live total, not a period figure — how many followers (and YouTube subscribers) these channels " +
        "have now, as each platform last reported them, so it reads the same on both periods by design. " +
        "Facebook's counts are re-read on every Meta sync (about every 3 hours); Instagram's only when the " +
        "channels are refreshed (on connecting, or with Refresh channels on the Meta tab)" +
        (syncedLine ? `; YouTube's and Snapchat's on their own syncs (latest: ${syncedLine})` : "") +
        ". YouTube rounds subscriber counts to three significant figures and Snapchat to the nearest 100, " +
        "and a Snapchat profile can withhold its count entirely — which is why fewer channels publish one " +
        "than the boards hold.",
    },
    {
      id: "change",
      label: `Follower change · ${n}d`,
      value: settled && changeView.kind === "value" ? fmtChange(changeView.value, changeView.approx) : "—",
      tone: settled && changeView.kind === "value" ? changeTone(changeView.value, changeView.approx) : "text-[#1A1A1A]",
      note: changeNote,
      title:
        `Follower change over the ${n} days, summed only over channels whose own history covers ` +
        `${growthHistoryRequirement(n)}. Facebook and Instagram: Meta's own counts, not rounded, from our API ` +
        "follower snapshots to each channel's current count. YouTube and Snapchat: our daily snapshots of " +
        "counts the platforms publish rounded, so the sum carries a ± error bar" +
        (changeView.kind === "value" && changeView.approx
          ? " — and this figure is smaller than it, so it is shown as approximate."
          : ".") +
        " A YouTube or Snapchat change smaller than its own rounding shows that limit on its row instead of a " +
        "number, so it adds only its ± here: this figure is always the sum of the changes the rows below show." +
        (datedReady.length > 0 ? ` Dates — ${datedReady.map((p) => datesOf(p, "change")).join("; ")}.` : "") +
        " Channels we have not tracked that long are left out rather than counted as flat.",
    },
    {
      id: "views",
      label: `Views · ${n}d`,
      value: settled ? fmtMetric(c.views) : "—",
      tone: "text-[#1A1A1A]",
      note: !settled
        ? "Loading…"
        : noneLoaded
          ? NONE
          : [
              c.viewsPlatforms.length > 0 ? growthListNames(c.viewsPlatforms) : "no platform has a figure yet",
              c.viewsPendingPlatforms.length > 0 ? `${growthListNames(c.viewsPendingPlatforms)}: not enough view history yet` : null,
              c.viewsUnreportedPlatforms.length > 0 ? `${growthListNames(c.viewsUnreportedPlatforms)}: none reported` : null,
              c.viewsUnpublishedPlatforms.length > 0 ? `${growthListNames(c.viewsUnpublishedPlatforms)} publishes none` : null,
            ].filter(Boolean).join(" · "),
      title:
        "Views over the period, as each platform counts them, added together. Facebook and Instagram: every " +
        "time content was shown or played, including repeats. YouTube: the growth of each channel's exact " +
        "lifetime view counter. Snapchat publishes no period view count, so it is never part of this sum." +
        (datedReady.length > 0 ? ` Dates — ${datedReady.map((p) => datesOf(p, "views")).join("; ")}.` : ""),
    },
  ];

  return (
    <>
      {warn && <p className="px-5 pt-4 -mb-1 text-[11px] font-medium leading-snug text-[#C0504D]">{warn}</p>}
      {/* 4 tiles: two columns, then four from `xl` — the column count divides 4 at every
          breakpoint, so no tile is ever orphaned onto a row of its own. ⚠️ Four across only at
          `xl`: the sidebar takes ~340px, so at 1024px four columns would ellipsise the values. */}
      <div
        aria-busy={!settled}
        className="px-5 py-5 grid grid-cols-2 xl:grid-cols-4 gap-x-4 gap-y-5 border-b border-[#F0EAE0]"
      >
        {tiles.map((t) => (
          <div
            key={t.id}
            title={t.title}
            // Hairlines only at `xl`, where all four are guaranteed to share one row.
            className="min-w-0 xl:border-l xl:border-[#F0EAE0] xl:pl-4 xl:first:border-l-0 xl:first:pl-0"
          >
            <p
              // ⚠️ clamp with the 2.2vw coefficient, as on the sibling boards: `vw` is the WINDOW
              // and the sidebar takes ~340px of it, so a bigger coefficient ellipsises at 1024px.
              className={`font-num text-[clamp(1.5rem,2.2vw,2rem)] font-semibold tracking-tight leading-none truncate ${
                !settled ? "text-[#C4C4C4] animate-pulse" : partial ? "text-[#8A8A8A]" : t.tone}`}
            >
              {t.value}
            </p>
            {/* Labels wrap rather than truncate: a clipped "FOLLOWERS & SUBSCRI…" loses its
                meaning on a phone, where the tooltip is out of reach. */}
            <p className="mt-2 text-[10px] font-medium uppercase tracking-[0.08em] text-[#8A8A8A] leading-tight break-words">
              {t.label}
            </p>
            <p className="mt-0.5 text-[10px] leading-tight text-[#B0B0B0] break-words">{t.note}</p>
          </div>
        ))}
      </div>
    </>
  );
}

// ─── By platform ─────────────────────────────────────────────────────────────────

const SUB = "block text-[10px] font-normal text-[#B0B0B0] leading-tight";

/**
 * What is loading, what failed and why, with Retry — ABOVE the table, outside its scroller,
 * so a phone can read every word and reach every Retry. The rows keep only a short marker.
 */
function SourceStatus({ combo, refreshFailed, onRetry }: {
  combo: GrowthCombination;
  refreshFailed: Record<GrowthSource, boolean>;
  onRetry: (s: GrowthSource) => void;
}) {
  const c = combo.combined;
  const problems = growthSourceProblems(combo);
  const stale = SOURCES.filter((s) => refreshFailed[s]);
  if (c.loadingPlatforms.length === 0 && problems.length === 0 && stale.length === 0) return null;
  return (
    <div className="px-5 pb-2 space-y-1 text-[11px] leading-snug">
      {c.loadingPlatforms.length > 0 && (
        <p className="text-[#7A7A7A]">
          Loading {growthListNames(c.loadingPlatforms)}… the Total waits for every platform, so it does not
          change as each one arrives.
        </p>
      )}
      {problems.map((p) => (
        <p key={p.source} className="text-[#C0504D]">
          {p.text}
          {p.kind !== "forbidden" && (
            <>
              {" "}
              <button onClick={() => onRetry(p.source)} className="underline hover:text-[#1A1A1A]">Retry</button>
            </>
          )}
        </p>
      ))}
      {stale.map((s) => (
        <p key={s} className="text-[#C2861D]">
          Couldn&apos;t refresh {growthListNames(platformsOf(s))} just now, so the figures shown are the ones
          loaded earlier.{" "}
          <button onClick={() => onRetry(s)} className="underline hover:text-[#1A1A1A]">Retry</button>
        </p>
      ))}
    </div>
  );
}

/**
 * The same dates as the table's "Period covered" column, for screens where that column is
 * scrolled off to the right (below `xl` the table is wider than its card). One text source
 * — growthPeriodText — so the two can never disagree.
 */
function DatesList({ combo, currentYear }: { combo: GrowthCombination; currentYear: number }) {
  const ready = GROWTH_PLATFORMS.filter((p) => combo.platforms[p].state === "ready" && (combo.platforms[p].channels ?? 0) > 0);
  if (ready.length === 0) return null;
  return (
    <div className="xl:hidden px-5 pb-2 text-[10px] text-[#7A7A7A] leading-snug">
      <p className="font-medium text-[#5A5A5A]">Dates each figure covers</p>
      <ul className="mt-0.5 space-y-0.5">
        {ready.map((p) => {
          const t = growthPeriodText(combo.platforms[p], currentYear);
          return (
            <li key={p}>
              <strong className="font-medium text-[#5A5A5A]">{GROWTH_PLATFORM_LABEL[p]}</strong>{" "}
              — change {t.change ?? t.changeWhy ?? "—"} · views {t.views ?? t.viewsWhy ?? "—"}
              <span className="text-[#B0B0B0]"> ({t.calendar})</span>
              {t.windowsNote && <span className="text-[#C2861D]"> · {t.windowsNote}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function PlatformRow({ a, currentYear, refreshFailed }: {
  a: GrowthPlatformAggregate;
  currentYear: number;
  refreshFailed: boolean;
}) {
  const label = GROWTH_PLATFORM_LABEL[a.platform];
  const platformCell = (
    <td className="px-5 py-2 align-top">
      <PlatformPill platform={a.platform} />
      {a.state === "ready" && refreshFailed && (
        <span className="block mt-1 text-[10px] text-[#C2861D] leading-tight">couldn&apos;t refresh — see above</span>
      )}
    </td>
  );

  // ⚠️ Short on purpose: the explanation and its Retry are in SourceStatus, above the table.
  // A sentence here runs past a phone's edge inside the 860px scroller.
  if (a.state === "loading") {
    return (
      <tr className="border-b border-[#F8F5EF]">
        {platformCell}
        <td colSpan={6} className="px-2 py-2 text-xs text-[#B0B0B0]">Loading…</td>
      </tr>
    );
  }
  if (a.state === "error") {
    return (
      <tr className="border-b border-[#F8F5EF]">
        {platformCell}
        <td colSpan={6} className="px-2 py-2 text-xs text-[#C0504D]">
          {a.errorKind === "forbidden" ? "administrators only" : "couldn't load — see the note above"}
        </td>
      </tr>
    );
  }

  const isMeta = a.platform === "facebook" || a.platform === "instagram";

  // Followers sub-line: coverage, the platform's rounding, and how current the count is.
  // ⚠️ Instagram's count is NOT re-read on the 3-hourly sync — only discovery (connecting,
  // or Refresh channels) writes it — so "as of the latest sync" would be false for it.
  const followersSub = [
    (a.followersReported ?? 0) < (a.followersTotal ?? 0) ? `${a.followersReported} of ${a.followersTotal} publish a count` : null,
    a.platform === "youtube" ? "rounded by YouTube" : a.platform === "snapchat" ? "rounded to 100s" : null,
    a.latestSyncedAt
      ? `synced ${relativeTime(a.latestSyncedAt)}`
      : a.platform === "facebook" ? "as of Meta's latest sync" : a.platform === "instagram" ? "as of the last channel refresh" : null,
  ].filter(Boolean).join(" · ");

  // The change, gated exactly as the platform's own tab gates it (growthPlatformChangeView).
  const view = growthPlatformChangeView(a);
  const pm = a.uncertainty > 0 ? `±${fmtMetric(a.uncertainty)}` : null;
  const measured = (a.followerDeltaChannels ?? 0) > 0 ? `${a.followerDeltaChannels} of ${a.channels} channels` : null;
  const below = (a.followerDeltaSuppressed ?? 0) > 0 ? `${a.followerDeltaSuppressed} below the rounding step` : null;
  const excluded = (a.followerDeltaExcluded ?? 0) > 0 ? `${a.followerDeltaExcluded} excluded as unreliable` : null;
  const changeMain = view.kind === "value" ? fmtDelta(view.value) : "—";
  const changeClass = view.kind === "value" ? changeTone(view.value, false) : "text-[#B0B0B0]";
  // ⚠️ Every count the board discloses is shown beside a figure — "N below the rounding
  // step" included: the server documents it as load-bearing, and the board's tab shows it.
  const changeSub: Array<string | null> =
    view.kind === "value"
      ? [measured, pm, below, excluded]
      : view.kind === "unresolved"
        ? [`finer than ${label}'s ±${fmtMetric(view.uncertainty)} rounding`, measured, below, excluded]
        : view.reason === "below-step"
          ? [`${a.followerDeltaSuppressed} moved less than the rounding step`, pm, excluded]
          : view.reason === "excluded"
            ? [excluded, pm]
            : view.reason === "no-history"
              ? [`${isMeta ? "no API history" : "no channel's history"} covers ${growthHistoryRequirement(a.periodDays)} yet`]
              : [];
  const changeTitle =
    view.kind === "unresolved"
      ? `Across the channels measured over this period ${label} publishes rounded counts, and those roundings add up to ` +
        `±${fmtMetric(view.uncertainty)} — more than the movement we can see. Showing that movement as a number would state ` +
        `something we cannot resolve, so, as on the ${label} tab, it appears only once real movement is bigger than the rounding.`
      : isMeta
        ? `Summed over the ${a.followerDeltaChannels ?? 0} channel(s) whose own API follower history covers ${growthHistoryRequirement(a.periodDays)}, up to each channel's current count` +
          (a.platform === "instagram" ? " — or, for an account without that history, Meta's own follows-minus-unfollows for the period." : ".") +
          " Meta's counts are not rounded, so there is no ± here."
        : `Summed by the ${label} board over the ${a.followerDeltaChannels ?? 0} channel(s) whose own snapshots cover ${growthHistoryRequirement(a.periodDays)}.` +
          (a.uncertainty > 0 ? ` ${label} publishes rounded counts, so this carries ±${fmtMetric(a.uncertainty)}.` : "");

  const pt = growthPeriodText(a, currentYear);

  return (
    <tr className="border-b border-[#F8F5EF] hover:bg-[#FCFBF8] align-top">
      {platformCell}
      <td className="px-2 py-2 text-right text-xs text-[#1A1A1A]">
        {fmtExact(a.channels)}
        {isMeta && a.channels === 0 && <span className={SUB}>none connected</span>}
      </td>
      <td
        className="px-2 py-2 text-right text-xs font-semibold text-[#1A1A1A]"
        title={
          [
            a.followers !== null ? a.followers.toLocaleString() : null,
            a.platform === "instagram"
              ? "Instagram follower counts are read when the channels are refreshed — on connecting, or with Refresh channels on the Meta tab — not on every sync."
              : null,
          ].filter(Boolean).join(" — ") || undefined
        }
      >
        {fmtMetric(a.followers)}
        {followersSub && <span className={SUB}>{followersSub}</span>}
      </td>
      <td className="px-2 py-2 text-right text-xs" title={changeTitle}>
        <span className={changeClass}>{changeMain}</span>
        {changeSub.some(Boolean) && <span className={SUB}>{changeSub.filter(Boolean).join(" · ")}</span>}
      </td>
      <td className="px-2 py-2 text-right text-xs">
        {!a.viewsPublished ? (
          <span
            className="text-[#B0B0B0] whitespace-nowrap"
            title="Snapchat doesn't publish a period view count. Its profile pages show views for a changing handful of recent posts only — a sample, not a figure for these dates — so it is never added up."
          >
            Not published
          </span>
        ) : a.views === null ? (
          <span className="text-[#B0B0B0]">
            —
            {(a.channels ?? 0) > 0 && (
              <span className={SUB}>{a.platform === "youtube" ? "not enough view history yet" : "none reported"}</span>
            )}
          </span>
        ) : (
          <span className="text-[#1A1A1A]" title={a.views.toLocaleString()}>
            {fmtMetric(a.views)}
            {(a.viewsChannels ?? 0) < (a.channels ?? 0) && (
              <span className={SUB}>{a.viewsChannels} of {a.channels} channels</span>
            )}
          </span>
        )}
      </td>
      <td className="px-2 py-2 text-left text-xs text-[#1A1A1A]">
        {(a.channels ?? 0) === 0 ? (
          <span className="text-[#B0B0B0]">—</span>
        ) : (
          <>
            {/* ⚠️ Two lines, because the change and the views do NOT share dates: Meta's change
                runs from our API snapshots to the current count, not over its views window. */}
            <span className="block">
              <span className="text-[#7A7A7A]">Change</span>{" "}
              {pt.change ? <span className="whitespace-nowrap">{pt.change}</span> : <span className="text-[#7A7A7A]">{pt.changeWhy ?? "—"}</span>}
            </span>
            <span className="block">
              <span className="text-[#7A7A7A]">Views</span>{" "}
              {pt.views ? <span className="whitespace-nowrap">{pt.views}</span> : <span className="text-[#7A7A7A]">{pt.viewsWhy ?? "—"}</span>}
            </span>
          </>
        )}
        <span className={SUB}>{pt.calendar}</span>
        {pt.windowsNote && <span className="block text-[10px] text-[#C2861D] leading-tight">{pt.windowsNote}</span>}
        {(a.staleChannels ?? 0) > 0 && (
          <span
            className="block text-[10px] text-[#C2861D] leading-tight"
            title={`These channels' latest refresh failed, so their figures are from an earlier window than the dates shown. The ${GROWTH_PLATFORM_TAB[a.platform]} tab marks each one.`}
          >
            {a.staleChannels} channel{a.staleChannels === 1 ? "" : "s"} couldn&apos;t refresh — older figures
          </span>
        )}
      </td>
      <td className="px-5 py-2">
        <div className="flex flex-wrap items-center gap-1">
          <SourceBadge source={SOURCE[a.platform].badge} />
          <span className="text-[11px] text-[#7A7A7A] whitespace-nowrap">{SOURCE[a.platform].label}</span>
        </div>
      </td>
    </tr>
  );
}

function TotalRow({ c }: { c: GrowthCombined }) {
  if (!c.settled) {
    // Short: the "waits for every platform" explanation is in SourceStatus, above the table.
    return (
      <tr className="border-t border-[#F0EAE0]">
        <td className="px-5 py-2 text-xs font-semibold text-[#1A1A1A]">Total</td>
        <td colSpan={6} className="px-2 py-2 text-xs text-[#B0B0B0]">Loading…</td>
      </tr>
    );
  }
  const excluding = c.failedPlatforms.length > 0 ? `excluding ${growthListNames(c.failedPlatforms)}` : null;
  const view = growthCombinedChangeView(c);
  // The ± is named by its source, so it can be traced to the rows that carry it.
  const pm = c.uncertainty > 0 ? `±${fmtMetric(c.uncertainty)} from ${possessives(c.uncertaintyPlatforms)} rounded counts` : null;
  return (
    <tr className="border-t border-[#F0EAE0] bg-[#FCFBF8] align-top">
      <td className="px-5 py-2 text-xs font-semibold text-[#1A1A1A]">
        Total
        {excluding && <span className="block text-[10px] font-normal text-[#C0504D] leading-tight">{excluding}</span>}
      </td>
      <td className="px-2 py-2 text-right text-xs font-semibold text-[#1A1A1A]">{fmtExact(c.channels)}</td>
      <td className="px-2 py-2 text-right text-xs font-semibold text-[#1A1A1A]" title={c.followers !== null ? c.followers.toLocaleString() : undefined}>
        {fmtMetric(c.followers)}
        {c.followers !== null && <span className={SUB}>{c.followersReported} of {c.followersTotal} publish a count</span>}
      </td>
      <td
        className="px-2 py-2 text-right text-xs font-semibold"
        title={
          "The Total adds up the changes the rows above show. A YouTube or Snapchat change smaller than its own " +
          "rounding shows that limit on its row instead of a number, so it adds only its ± here."
        }
      >
        {view.kind === "value" ? (
          <span className={changeTone(view.value, view.approx)}>{fmtChange(view.value, view.approx)}</span>
        ) : (
          <span className="text-[#B0B0B0]">—</span>
        )}
        {/* ⚠️ Never a number when every measured change is inside its own rounding — the rows
            above print none, so the Total must not print theirs (growthCombinedChangeView). */}
        {pm && <span className={SUB}>{view.kind === "unresolved" ? `finer than the ${pm}` : pm}</span>}
        {view.kind === "value" && c.followerDeltaUnresolvedPlatforms.length > 0 && (
          <span className={SUB}>{growthListNames(c.followerDeltaUnresolvedPlatforms)}: counted in the ± only</span>
        )}
      </td>
      <td className="px-2 py-2 text-right text-xs font-semibold text-[#1A1A1A]">
        {fmtMetric(c.views)}
        {c.views !== null && <span className={SUB}>{growthListNames(c.viewsPlatforms)}</span>}
      </td>
      <td className="px-2 py-2 text-left text-xs text-[#B0B0B0]" colSpan={2}>
        each platform&apos;s own dates, above
      </td>
    </tr>
  );
}

// ─── All channels ────────────────────────────────────────────────────────────────

function ChannelsTable({ combo, rows, platformFilter, searching, sort, onSort }: {
  combo: GrowthCombination;
  rows: GrowthChannelRow[];
  platformFilter: GrowthPlatform | "all";
  searching: boolean;
  sort: { key: GrowthChannelSortKey; dir: SortDir };
  onSort: (k: GrowthChannelSortKey) => void;
}) {
  const n = combo.periodDays;

  // ⚠️ Only a LOADED response may claim emptiness. A board still loading or failed is
  // said to be so — never rendered as "No channels" (growthTableEmpty).
  if (rows.length === 0) {
    const e = growthTableEmpty(combo, { platform: platformFilter, searching });
    return <p className={`px-5 py-8 text-center text-xs ${e.error ? "text-[#C0504D]" : "text-[#7A7A7A]"}`}>{e.text}</p>;
  }

  return (
    // min-width + the overflow-x-auto wrapper: the TABLE scrolls inside its own box, so
    // the page itself never overflows at 375px.
    <table className="w-full min-w-[720px]">
      <thead>
        <tr className="text-[11px] text-[#7A7A7A] border-b border-[#F0EAE0]">
          <SortTh label="Channel" colKey="name" sort={sort} onSort={onSort} align="left" pad="px-5" />
          <SortTh label="Platform" colKey="platform" sort={sort} onSort={onSort} align="left" />
          <SortTh
            colKey="followers" sort={sort} onSort={onSort}
            title="A live total, not a period figure — how many followers (or subscribers) the channel has now, as its platform last reported."
            label={<>Followers <span className="text-[#B0B0B0] font-normal">(now)</span></>}
          />
          <SortTh
            label={`Change · ${n}d`} colKey="change" sort={sort} onSort={onSort}
            title="Follower movement across the period, labelled with the span it truly covers. Struck-through changes are excluded from this sort."
          />
          <SortTh
            label={`Views · ${n}d`} colKey="views" sort={sort} onSort={onSort} pad="px-5"
            title="Views across the period as the channel's platform counts them. Snapchat publishes none."
          />
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className="border-b border-[#F8F5EF] hover:bg-[#FCFBF8]">
            <td className="px-5 py-2">
              {/* min-w-0 on the flex child AND truncate on the name: the parent can only
                  clip what its children are willing to shrink. */}
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="text-xs font-medium text-[#1A1A1A] truncate max-w-[220px]">{r.name}</span>
                {r.handle && <span className="text-[10px] text-[#B0B0B0] truncate">@{r.handle}</span>}
                <ChannelLink url={r.href} name={r.name} />
                {r.refreshError && <RefreshMark message={r.refreshError} platform={r.platform} />}
              </div>
            </td>
            <td className="px-2 py-2"><PlatformPill platform={r.platform} /></td>
            <td
              className="px-2 py-2 text-right text-xs font-semibold text-[#1A1A1A]"
              title={r.followers !== null ? r.followers.toLocaleString() : undefined}
            >
              {r.followers === null ? (
                <span
                  className="text-[#B0B0B0] font-normal"
                  title={
                    r.platform === "snapchat"
                      ? "Snapchat does not publish a public follower count for this profile — Snapchat's choice, not an error or a zero."
                      : r.platform === "youtube"
                        ? "YouTube published no subscriber count for this channel (it can hide its count)."
                        : "Meta has not published a follower count for this channel yet."
                  }
                >
                  —
                </span>
              ) : (
                fmtMetric(r.followers)
              )}
            </td>
            <td className="px-2 py-2 text-right text-xs"><RowChange r={r} periodDays={n} /></td>
            <td className="px-5 py-2 text-right text-xs"><RowViews r={r} periodDays={n} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RowChange({ r, periodDays }: { r: GrowthChannelRow; periodDays: number }) {
  const v = r.followerDelta;
  if (v === null) {
    return (
      <span
        className="text-[#B0B0B0]"
        title={
          r.followers === null && r.platform === "snapchat"
            ? "No change to show: Snapchat publishes no follower count for this profile, so there is nothing to measure movement in."
            : r.followerDeltaSuppressed
              ? `No change to show: ${GROWTH_PLATFORM_LABEL[r.platform]} publishes rounded counts, and this channel moved less than one rounding step across the period. It is not a zero.`
              : r.platform === "facebook" || r.platform === "instagram"
                // ⚠️ Meta's absence has two causes the payload cannot tell apart: API follower
                // history too short, or a history shared with a same-named Page that the
                // server refuses to attribute. Say both rather than guess one.
                ? "No change to show for this period — our API follower history for this channel does not cover it yet, or cannot be attributed to this channel alone. This is not a zero."
                : "No change to show for this period — we have not been collecting this channel long enough yet. This is not a zero."
        }
      >
        —
      </span>
    );
  }
  if (r.followerDeltaUnreliable) {
    // ⚠️ Shown, struck through, and explained — never hidden and never plain. A change
    // bigger than the figure it was measured from is a series that jumped between two
    // channels, not growth; hiding it would hide the evidence the handle needs fixing.
    return (
      <span
        className="text-[#B0B0B0] line-through decoration-[#C2861D]"
        title={`This change (${fmtDelta(v)}) is larger than the figure it was measured from, so it cannot be growth — the stored history for this channel spans two different channels. It is excluded from every total and from the Change sort; the ${GROWTH_PLATFORM_TAB[r.platform]} tab is where the handle gets fixed.`}
      >
        {fmtDelta(v)}
      </span>
    );
  }
  const suffix = spanSuffix(r.followerDeltaDays, periodDays);
  return (
    <span className={v > 0 ? "text-[#3E9B4F]" : v < 0 ? "text-[#C0504D]" : "text-[#B0B0B0]"}>
      {fmtDelta(v)}
      {suffix && <span className="block text-[9px] font-normal text-[#B0B0B0] leading-tight">{suffix}</span>}
    </span>
  );
}

function RowViews({ r, periodDays }: { r: GrowthChannelRow; periodDays: number }) {
  if (!r.viewsPublished) {
    return (
      <span
        className="text-[#B0B0B0]"
        title="Snapchat doesn't publish a period view count — its profile pages show views for a changing handful of recent posts, not a figure for these dates."
      >
        —
      </span>
    );
  }
  if (r.views === null) {
    return (
      <span
        className="text-[#B0B0B0]"
        title={r.platform === "youtube"
          ? "No view change to show yet — we hold fewer than two days of view-count history for this channel in this period. It is not a zero."
          : "Meta published no view figure for this channel in this window. It is not a zero."}
      >
        —
      </span>
    );
  }
  const suffix = spanSuffix(r.viewsDays, periodDays);
  return (
    <span className="text-[#1A1A1A]" title={r.views.toLocaleString()}>
      {fmtMetric(r.views)}
      {suffix && <span className="block text-[9px] font-normal text-[#B0B0B0] leading-tight">{suffix}</span>}
    </span>
  );
}
