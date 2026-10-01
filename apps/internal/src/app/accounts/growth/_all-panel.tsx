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
 * labels every figure with its source and the exact dates it covers. The composition is
 * the pure `combineGrowth` in @dashmani/shared (unit-tested in apps/api).
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
 */

import { useMemo, useState, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import {
  combineGrowth,
  filterGrowthChannels,
  growthChannelSortValue,
  growthMetaWindow,
  fmtGrowthDay,
  fmtGrowthSpan,
  fmtGrowthIstClock,
  GROWTH_ALL_PERIODS,
  DEFAULT_GROWTH_ALL_PERIOD,
  GROWTH_PLATFORMS,
  GROWTH_PLATFORM_LABEL,
  type GrowthAllPeriod,
  type GrowthPlatform,
  type GrowthPlatformAggregate,
  type GrowthChannelRow,
  type GrowthChannelSortKey,
  type GrowthCombined,
  type GrowthCombination,
  type GrowthSourceInput,
} from "@dashmani/shared";
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

const SPAN_KIND_LABEL: Record<GrowthPlatform, string> = {
  facebook: "Pacific days — Meta's day for Facebook",
  instagram: "UTC days — Meta's day for Instagram",
  youtube: "our daily snapshots, IST dates",
  snapchat: "our daily snapshots, IST dates",
};

/** The source request behind each platform: Facebook and Instagram share Meta's. */
type SourceKey = "meta" | "youtube" | "snapchat";
const SOURCE_OF: Record<GrowthPlatform, SourceKey> = {
  facebook: "meta", instagram: "meta", youtube: "youtube", snapchat: "snapchat",
};

/** The sibling tab each platform lives on — Facebook and Instagram are both on "Meta". */
const TAB_NAME: Record<GrowthPlatform, string> = {
  facebook: "Meta", instagram: "Meta", youtube: "YouTube", snapchat: "Snapchat",
};

/** "Facebook", "Facebook and YouTube", "Facebook, Instagram and YouTube". */
function listNames(ps: readonly GrowthPlatform[]): string {
  const n = ps.map((p) => GROWTH_PLATFORM_LABEL[p]);
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
 * access. This one states only what is true for every platform.
 */
function RefreshMark({ message, platform }: { message: string; platform: GrowthPlatform }) {
  return (
    <span title={`This channel's most recent refresh failed, so any figures shown are from its last successful one. The ${TAB_NAME[platform]} tab says more. The platform's reply: ${message}`}>
      <AlertTriangle className="h-3 w-3 text-[#C2861D] shrink-0" />
    </span>
  );
}

export function AllPanel({ onOpenTab }: { onOpenTab?: (tab: SiblingTab) => void }) {
  const [days, setDays] = useState<GrowthAllPeriod>(DEFAULT_GROWTH_ALL_PERIOD);
  const [q, setQ] = useState("");
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
  const refreshFailed: Record<SourceKey, boolean> = {
    meta: metaQ.data !== undefined && !!metaQ.error,
    youtube: ytQ.data !== undefined && !!ytQ.error,
    snapchat: scQ.data !== undefined && !!scQ.error,
  };
  const retry: Record<SourceKey, () => void> = {
    meta: () => void metaQ.mutate(),
    youtube: () => void ytQ.mutate(),
    snapchat: () => void scQ.mutate(),
  };
  const retrySources = (ps: readonly GrowthPlatform[]) => {
    for (const s of new Set(ps.map((p) => SOURCE_OF[p]))) retry[s]();
  };

  const periodDays = combo.periodDays;
  const c = combo.combined;
  // Day keys are formatted against the viewer's own year (client-only render: every value
  // shown here comes from SWR, so this never runs during prerender).
  const currentYear = new Date().getFullYear();
  const fbDayEnd = fmtGrowthIstClock(metaQ.data?.dayStarts?.facebook);

  const filtered = useMemo(
    () => filterGrowthChannels(combo.channels, { q, platform: platformFilter }),
    [combo.channels, q, platformFilter],
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
            Every number here is the one that platform&apos;s own tab shows —{" "}
            <strong className="font-medium text-[#8A8A8A]">Meta&apos;s API</strong> for Facebook and
            Instagram, <strong className="font-medium text-[#8A8A8A]">YouTube&apos;s Data API</strong>,
            and <strong className="font-medium text-[#8A8A8A]">Snapchat&apos;s public profile
            pages</strong> — added together. Nothing is re-measured or estimated, and each figure
            says which dates it covers.
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
            as zero.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px]">
            <thead>
              <tr className="text-[11px] text-[#7A7A7A] border-b border-[#F0EAE0]">
                <PlainTh label="Platform" align="left" pad="px-5" />
                <PlainTh label="Channels" />
                <PlainTh
                  label={<>Followers <span className="text-[#B0B0B0] font-normal">(now)</span></>}
                  title="A live total, not a period figure — how many followers (and YouTube subscribers) the channels have right now."
                />
                <PlainTh
                  label={`Change · ${periodDays}d`}
                  title={`Follower change over the period, counting only channels whose own history covers at least ${combo.platforms.facebook.followerDeltaMinDays} of the ${periodDays} days.`}
                />
                <PlainTh
                  label={`Views · ${periodDays}d`}
                  title="Views over the period, as each platform counts them. Snapchat publishes no period view count."
                />
                <PlainTh label="Period covered" align="left" title="The exact dates each platform's figures cover, and whose calendar they are on." />
                <PlainTh label="Source" align="left" pad="px-5" />
              </tr>
            </thead>
            <tbody>
              {GROWTH_PLATFORMS.map((p) => (
                <PlatformRow
                  key={p}
                  a={combo.platforms[p]}
                  periodDays={periodDays}
                  currentYear={currentYear}
                  refreshFailed={refreshFailed[SOURCE_OF[p]]}
                  onRetry={retry[SOURCE_OF[p]]}
                />
              ))}
              <TotalRow c={c} periodDays={periodDays} />
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
          whose own history covers at least {combo.platforms.facebook.followerDeltaMinDays} of the{" "}
          {periodDays} days — a shorter history is left out rather than counted as flat. For Facebook and
          Instagram it runs from our daily API follower snapshots to each channel&apos;s current count;
          YouTube and Snapchat publish rounded counts, so their part carries the ± shown.{" "}
          <strong className="font-medium text-[#7A7A7A]">Followers</strong> is a live total and reads
          the same on both periods. <strong className="font-medium text-[#7A7A7A]">Views</strong> are
          each platform&apos;s own count: Meta counts every time content was shown or played, including
          repeats; YouTube&apos;s is the growth of its exact lifetime view counter; Snapchat publishes
          no period view count, so it is left out. A dash means a platform published no figure — never
          zero. Engagements, reach and revenue are Meta-only — see the{" "}
          {onOpenTab ? (
            <button onClick={() => onOpenTab("meta")} className="underline hover:text-[#1A1A1A]">Meta tab</button>
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
            {/* ⚠️ Never "0 channels" before anything has loaded — only a loaded response may claim emptiness. */}
            {combo.channels.length === 0 && !c.settled ? (
              "Loading…"
            ) : (
              <>
                {sorted.length} channel{sorted.length === 1 ? "" : "s"}
                {sorted.length !== combo.channels.length && (
                  <span className="text-[#B0B0B0]"> of {combo.channels.length}</span>
                )}
                {!c.settled && <span className="text-[#B0B0B0]"> so far</span>}
              </>
            )}
          </span>
        </div>

        {(c.loadingPlatforms.length > 0 || c.failedPlatforms.length > 0) && (
          <p className="px-5 py-2 border-b border-[#F6F2EA] text-[10px] text-[#7A7A7A] leading-snug">
            {c.loadingPlatforms.length > 0 && (
              <>Still loading: <strong className="font-medium text-[#5A5A5A]">{listNames(c.loadingPlatforms)}</strong>. </>
            )}
            {c.failedPlatforms.length > 0 && (
              <>
                <span className="text-[#C0504D]">
                  Not listed: {listNames(c.failedPlatforms)} — couldn&apos;t load.
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
            under a value is that row&apos;s own span when it is not the period. A{" "}
            <span className="line-through decoration-[#C2861D]">struck-through</span> change jumped
            between two different channels and is left out of every total and of the Change sort.
            Snapchat publishes no period view count, so its views are a dash.
          </p>
        )}

        <div className="overflow-x-auto">
          <ChannelsTable
            combo={combo}
            rows={sorted}
            platformFilter={platformFilter}
            searching={q.trim() !== ""}
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
  const missing = c.failedPlatforms.length > 0 ? ` · excluding ${listNames(c.failedPlatforms)} — couldn't load` : "";
  // Every source answered and none loaded: say that once rather than "across 0 platforms".
  const noneLoaded = settled && c.includedPlatforms.length === 0;
  const NONE = "no board could be loaded — see By platform below";

  const syncedLine = (["youtube", "snapchat"] as const)
    .filter((p) => P[p].latestSyncedAt)
    .map((p) => `${GROWTH_PLATFORM_LABEL[p]} ${relativeTime(P[p].latestSyncedAt)}`)
    .join(", ");

  const spanText = (p: GrowthPlatform) =>
    P[p].span ? fmtGrowthSpan(P[p].span, currentYear, p === "youtube" || p === "snapchat" ? " → " : " – ") : "no dated figure";

  // Why no change can be shown, from the data: a full-period measurement finer than the
  // rounding step is a different absence from "not tracked long enough" — never say the latter for both.
  const belowStep = c.includedPlatforms.reduce((acc, p) => acc + (P[p].followerDeltaSuppressed ?? 0), 0);
  const noChangeNote = belowStep > 0
    ? `${belowStep} channel${belowStep === 1 ? "" : "s"} moved less than the rounding step; none has a countable change`
    : `no channel has ${n} days of history yet`;

  const tiles: Array<{ id: string; label: string; value: string; tone: string; note: ReactNode; title: string }> = [
    {
      id: "channels",
      label: "Channels",
      value: settled ? fmtExact(c.channels) : "—",
      tone: "text-[#1A1A1A]",
      note: !settled ? "Loading…" : noneLoaded ? NONE : `across ${c.includedPlatforms.length} platform${c.includedPlatforms.length === 1 ? "" : "s"}${missing}`,
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
          : `as of the latest sync · ${c.followersReported} of ${c.followersTotal} channels publish a count${missing}`,
      title:
        "A live total, not a period figure — how many followers (and YouTube subscribers) these channels " +
        "have right now, so it reads the same on both periods by design. YouTube rounds subscriber counts " +
        "to three significant figures and Snapchat to the nearest 100, and a Snapchat profile can withhold " +
        "its count entirely — which is why fewer channels publish one than the boards hold." +
        (syncedLine ? ` Latest syncs: ${syncedLine}; Meta's counts are as of its latest sync.` : ""),
    },
    {
      id: "change",
      label: `Follower change · ${n}d`,
      value: settled ? fmtChange(c.followerDelta, c.followerDeltaApprox) : "—",
      tone: settled ? changeTone(c.followerDelta, c.followerDeltaApprox) : "text-[#1A1A1A]",
      note: !settled
        ? "Loading…"
        : noneLoaded
          ? NONE
          : c.followerDelta === null
            ? `${noChangeNote}${missing}`
            : `${listNames(c.followerDeltaPlatforms)} · ${c.followerDeltaChannels} channels` +
              (c.uncertainty > 0 ? ` · ±${fmtMetric(c.uncertainty)} from rounded counts` : "") +
              missing,
      title:
        `Follower change over the ${n} days, summed only over channels whose own history covers at least ` +
        `${P.facebook.followerDeltaMinDays} of them. Facebook and Instagram: Meta's exact counts. YouTube ` +
        `(${spanText("youtube")}) and Snapchat (${spanText("snapchat")}): our daily snapshots of counts the ` +
        "platforms publish rounded, so the sum carries a ± error bar" +
        (c.followerDeltaApprox
          ? " — and this figure is smaller than it, so it is shown as approximate."
          : ".") +
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
              c.viewsPlatforms.length > 0 ? listNames(c.viewsPlatforms) : "no platform has a figure yet",
              c.viewsPendingPlatforms.length > 0 ? `${listNames(c.viewsPendingPlatforms)}: not enough history yet` : null,
              c.viewsUnpublishedPlatforms.length > 0 ? `${listNames(c.viewsUnpublishedPlatforms)} publishes none` : null,
            ].filter(Boolean).join(" · ") + missing,
      title:
        "Views over the period, as each platform counts them, added together. Facebook and Instagram " +
        `(${spanText("facebook")} and ${spanText("instagram")}): every time content was shown or played, ` +
        `including repeats. YouTube (${P.youtube.viewsSpan ? fmtGrowthSpan(P.youtube.viewsSpan, currentYear, " → ") : "no dated figure yet"}): ` +
        "the growth of each channel's exact lifetime view counter. Snapchat publishes no period view count, " +
        "so it is never part of this sum.",
    },
  ];

  return (
    // 4 tiles: two columns, then four from `xl` — the column count divides 4 at every
    // breakpoint, so no tile is ever orphaned onto a row of its own. ⚠️ Four across only at
    // `xl`: the sidebar takes ~340px, so at 1024px four columns would ellipsise the values.
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
              settled ? t.tone : "text-[#C4C4C4] animate-pulse"}`}
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
  );
}

// ─── By platform ─────────────────────────────────────────────────────────────────

const SUB = "block text-[10px] font-normal text-[#B0B0B0] leading-tight";

function PlatformRow({ a, periodDays, currentYear, refreshFailed, onRetry }: {
  a: GrowthPlatformAggregate;
  periodDays: number;
  currentYear: number;
  refreshFailed: boolean;
  onRetry: () => void;
}) {
  const label = GROWTH_PLATFORM_LABEL[a.platform];
  const platformCell = (
    <td className="px-5 py-2 align-top">
      <PlatformPill platform={a.platform} />
      {a.state === "ready" && refreshFailed && (
        <span className="block mt-1 text-[10px] text-[#C2861D] leading-tight">
          couldn&apos;t refresh — showing figures loaded earlier ·{" "}
          <button onClick={onRetry} className="underline hover:text-[#1A1A1A]">Retry</button>
        </span>
      )}
    </td>
  );

  if (a.state === "loading") {
    return (
      <tr className="border-b border-[#F8F5EF]">
        {platformCell}
        <td colSpan={6} className="px-2 py-2 text-xs text-[#B0B0B0]">Loading {label}…</td>
      </tr>
    );
  }

  if (a.state === "error") {
    return (
      <tr className="border-b border-[#F8F5EF]">
        {platformCell}
        <td colSpan={6} className="px-2 py-2 text-xs text-[#C0504D] leading-snug">
          {/* ⚠️ Worded by KIND, never the raw API text: the owner asked that "too many
              requests", "something went wrong" and "unexpected error" never appear, and the
              raw 429/500/HTML-page messages are exactly those. The mismatch sentence is this
              tab's own and explains itself. */}
          {a.errorKind === "forbidden" ? (
            "Only administrators can see Account Growth."
          ) : (
            <>
              {a.errorKind === "mismatch"
                ? a.error
                : a.errorKind === "busy"
                  ? <>{label} asked us to slow down for a moment, so it is left out of every total rather than counted as zero. Wait a minute, then retry.</>
                  : <>{label} couldn&apos;t be loaded just now, so it is left out of every total rather than counted as zero. Its channels and their history are safe — this is a loading problem, not a data problem.</>}{" "}
              <button onClick={onRetry} className="underline hover:text-[#1A1A1A]">Retry</button>
            </>
          )}
        </td>
      </tr>
    );
  }

  const isMeta = a.platform === "facebook" || a.platform === "instagram";
  const isBoard = !isMeta;

  // Followers sub-line: coverage, the platform's rounding, and how fresh the board is.
  const followersSub = [
    (a.followersReported ?? 0) < (a.followersTotal ?? 0) ? `${a.followersReported} of ${a.followersTotal} publish a count` : null,
    a.platform === "youtube" ? "rounded by YouTube" : a.platform === "snapchat" ? "rounded to 100s" : null,
    a.latestSyncedAt ? `synced ${relativeTime(a.latestSyncedAt)}` : isMeta ? "as of the latest sync" : null,
  ].filter(Boolean).join(" · ");

  // Why a change is absent — told apart from the data, never guessed at.
  const changeAbsent =
    isBoard && (a.followerDeltaSuppressed ?? 0) > 0
      ? `${a.followerDeltaSuppressed} moved less than the rounding step`
      : isBoard && (a.followerDeltaExcluded ?? 0) > 0
        ? `${a.followerDeltaExcluded} excluded as unreliable`
        : (a.channels ?? 0) === 0
          ? null
          : `no channel has ${periodDays} days of history yet`;

  // A real date range never breaks across lines; the longer "why there is none" text may.
  const spanOrWhy = (span: GrowthPlatformAggregate["span"], why: string) =>
    span
      ? <span className="whitespace-nowrap">{fmtGrowthSpan(span, currentYear, isBoard ? " → " : " – ")}</span>
      : (a.channels ?? 0) === 0 ? "—" : why;
  const followerSpanText = spanOrWhy(
    a.span,
    isMeta
      ? "no completed window published yet"
      : `not enough history yet${a.historyFrom ? ` · collecting since ${fmtGrowthDay(a.historyFrom, currentYear)}` : ""}`,
  );

  return (
    <tr className="border-b border-[#F8F5EF] hover:bg-[#FCFBF8] align-top">
      {platformCell}
      <td className="px-2 py-2 text-right text-xs text-[#1A1A1A]">
        {fmtExact(a.channels)}
        {isMeta && a.channels === 0 && <span className={SUB}>none connected</span>}
      </td>
      <td className="px-2 py-2 text-right text-xs font-semibold text-[#1A1A1A]" title={a.followers !== null ? a.followers.toLocaleString() : undefined}>
        {fmtMetric(a.followers)}
        {followersSub && <span className={SUB}>{followersSub}</span>}
      </td>
      <td
        className="px-2 py-2 text-right text-xs"
        title={
          isMeta
            ? `Summed over the ${a.followerDeltaChannels ?? 0} channel(s) whose own API follower history covers at least ${a.followerDeltaMinDays} of the ${periodDays} days, up to each channel's current count. Meta's counts are exact.`
            : `Summed by the ${label} board over the ${a.followerDeltaChannels ?? 0} channel(s) whose own snapshots span at least ${a.followerDeltaMinDays} of the ${periodDays} days.` +
              (a.uncertainty > 0 ? ` ${label} publishes rounded counts, so this carries ±${fmtMetric(a.uncertainty)}.` : "")
        }
      >
        <span className={a.followerDelta === null ? "text-[#B0B0B0]" : changeTone(a.followerDelta, a.followerDeltaApprox)}>
          {fmtChange(a.followerDelta, a.followerDeltaApprox)}
        </span>
        <span className={SUB}>
          {a.followerDelta === null
            ? changeAbsent
            : [
                `${a.followerDeltaChannels} of ${a.channels} channels`,
                a.uncertainty > 0 ? `±${fmtMetric(a.uncertainty)}` : null,
                isBoard && (a.followerDeltaExcluded ?? 0) > 0 ? `${a.followerDeltaExcluded} excluded` : null,
              ].filter(Boolean).join(" · ")}
        </span>
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
        {a.platform === "youtube" ? (
          <>
            <span className="block"><span className="text-[#7A7A7A]">Subscribers</span> {followerSpanText}</span>
            <span className="block">
              <span className="text-[#7A7A7A]">Views</span> {spanOrWhy(a.viewsSpan, "not enough view history yet")}
            </span>
          </>
        ) : a.platform === "snapchat" ? (
          <span className="block"><span className="text-[#7A7A7A]">Followers</span> {followerSpanText}</span>
        ) : (
          <span className="block">{followerSpanText}</span>
        )}
        <span className={SUB}>{SPAN_KIND_LABEL[a.platform]}</span>
        {(a.staleChannels ?? 0) > 0 && (
          <span
            className="block text-[10px] text-[#C2861D] leading-tight"
            title="These channels' latest refresh failed, so their figures are from an earlier window than the dates shown. The Meta tab marks each one."
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

function TotalRow({ c, periodDays }: { c: GrowthCombined; periodDays: number }) {
  if (!c.settled) {
    return (
      <tr className="border-t border-[#F0EAE0]">
        <td className="px-5 py-2 text-xs font-semibold text-[#1A1A1A]">Total</td>
        <td colSpan={6} className="px-2 py-2 text-xs text-[#B0B0B0]">
          Loading… the total waits for every platform so it does not change as each one arrives.
        </td>
      </tr>
    );
  }
  const excluding = c.failedPlatforms.length > 0 ? `excluding ${listNames(c.failedPlatforms)}` : null;
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
      <td className="px-2 py-2 text-right text-xs font-semibold">
        <span className={c.followerDelta === null ? "text-[#B0B0B0]" : changeTone(c.followerDelta, c.followerDeltaApprox)}>
          {fmtChange(c.followerDelta, c.followerDeltaApprox)}
        </span>
        {c.followerDelta !== null && (
          <span className={SUB}>
            {c.uncertainty > 0 ? `±${fmtMetric(c.uncertainty)} from rounded counts` : "exact"}
          </span>
        )}
      </td>
      <td className="px-2 py-2 text-right text-xs font-semibold text-[#1A1A1A]">
        {fmtMetric(c.views)}
        {c.views !== null && <span className={SUB}>{listNames(c.viewsPlatforms)}</span>}
      </td>
      <td className="px-2 py-2 text-left text-xs text-[#B0B0B0]" colSpan={2}>
        each platform&apos;s own dates, above · {periodDays}-day period
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
  const c = combo.combined;
  const n = combo.periodDays;
  const empty = "px-5 py-8 text-center text-xs text-[#7A7A7A]";

  // ⚠️ Only a LOADED response may claim emptiness. A board still loading or failed is
  // said to be so — never rendered as "No channels".
  if (rows.length === 0) {
    if (platformFilter !== "all") {
      const st = combo.platforms[platformFilter].state;
      const label = GROWTH_PLATFORM_LABEL[platformFilter];
      if (st === "loading") return <p className={empty}>Loading {label} channels…</p>;
      if (st === "error") return <p className={`${empty} text-[#C0504D]`}>{label} couldn&apos;t be loaded — see the note above.</p>;
      return <p className={empty}>{searching ? "No channels match that search." : `No ${label} channels on this board.`}</p>;
    }
    if (combo.channels.length > 0) return <p className={empty}>No channels match that search.</p>;
    if (c.loadingPlatforms.length > 0) return <p className={empty}>Loading channels…</p>;
    if (c.includedPlatforms.length === 0) {
      return <p className={`${empty} text-[#C0504D]`}>No board could be loaded, so there are no channels to list — see the note above.</p>;
    }
    return <p className={empty}>No channels tracked yet — add them on each platform&apos;s tab.</p>;
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
            title="A live total, not a period figure — how many followers (or subscribers) the channel has right now."
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
        title={`This change (${fmtDelta(v)}) is larger than the figure it was measured from, so it cannot be growth — the stored history for this channel spans two different channels. It is excluded from every total and from the Change sort; the ${TAB_NAME[r.platform]} tab is where the handle gets fixed.`}
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
