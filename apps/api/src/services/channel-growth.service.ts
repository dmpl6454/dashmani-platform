/**
 * Account Growth — the YouTube and Snapchat boards.
 *
 * These are SIBLINGS of the Meta board, not part of it. The Meta tab shows only channels
 * the connected Meta account administers, read from Meta's own API (owner decision
 * 2026-08-24, and that tab is untouched by this file). These two tabs speak for a
 * different estate with different provenance, and each says so on screen.
 *
 * ── WHY THIS READS `social_accounts` RATHER THAN A NEW TABLE ──────────────────────────
 *
 * Every field a "tracked channel" needs already exists: `handle`, `displayName`,
 * `profileUrl`, `followerCount`, `lastSyncedAt`, `syncSource`, and `status` (ACTIVE /
 * PAUSED / ARCHIVED — the soft-removal flag). `AccountGrowthSnapshot` already carries
 * `@@unique([accountId, date])` with a `source` column whose documented values already
 * include "youtube_api" and "scraper". A parallel table would fork the estate: two rows
 * per channel, two syncs writing them, and two answers to "how many followers does this
 * have" that diverge the first time one path fails open. It would also be unjoinable to
 * `report_links.accountId`, so Link Search and Top Links could never see these channels.
 *
 * ── WINDOW SEMANTICS, WHICH DIFFER PER COLUMN AND MUST BE LABELLED ────────────────────
 *
 *   followers   — a STOCK ("how many right now"), window-invariant BY DEFINITION. This has
 *                 been reported as "faulty data" twice on the Meta board for exactly that
 *                 reason, so it is labelled "now" and the movement is a separate column.
 *   followerΔ   — measured from our own snapshots. ⚠️ For YouTube it is SUPPRESSED below
 *                 the rounding step (see `followersPrecision`): YouTube publishes 3
 *                 significant figures, so a channel at 10,500,000 cannot show movement
 *                 until it gains 100,000, and rendering the intervening 0 would assert
 *                 "did not grow" — which we do not know.
 *   totalViews  — YouTube LIFETIME, exact. Never windowed.
 *   viewsΔ      — the delta of that exact counter across the window. This is the only
 *                 truthful growth figure YouTube gives us, which is why the snapshot
 *                 table carries `totalViews` at all.
 *   recentViews — Snapchat: the summed views of the Spotlight posts on the profile page
 *                 that actually published one. NOT a time window — Snapchat chooses how
 *                 many posts to return (2–31 observed) — and 74% of posts withhold their
 *                 count, per channel. Always shipped with its coverage pair.
 */

import { prisma } from "@dashmani/db";
import { createSingleFlightMemo } from "../utils/single-flight-memo";
import { subscriberPrecisionFor } from "./social-insights/youtube-followers";

/** Platforms this board serves. Meta lives on its own tab and is deliberately absent. */
export const CHANNEL_PLATFORMS = ["youtube", "snapchat"] as const;
export type ChannelPlatform = (typeof CHANNEL_PLATFORMS)[number];

export const CHANNEL_PERIODS = [7, 14, 30, 90] as const;
export type ChannelPeriod = (typeof CHANNEL_PERIODS)[number];
export const DEFAULT_CHANNEL_PERIOD: ChannelPeriod = 30;

/**
 * A tripwire, not a limit. The estate is ~52 channels; an unbounded read is safe only
 * while that stays true. `meta-channels` carries the same guard for the same reason.
 */
const ROW_WARN_THRESHOLD = 2000;

const _memo = createSingleFlightMemo({ ttlMs: 60_000, maxEntries: 40 });
/** ⚠️ MANDATORY in the beforeEach of any test touching this service (cross-test pollution). */
export function invalidateChannelGrowthCache() {
  _memo.clear();
}

export interface ChannelRow {
  id: string;
  handle: string;
  displayName: string;
  profileUrl: string | null;
  status: string;
  /** null = the platform published no follower count for this channel. NEVER 0-for-absent. */
  followers: number | null;
  /** The rounding step applied to `followers`, or null when the figure is exact. */
  followersPrecision: number | null;
  /** Change across the window, or null when unmeasurable OR below the rounding step. */
  followerDelta: number | null;
  /** The span the delta actually covers — often shorter than the window asked for. */
  followerDeltaDays: number | null;
  /**
   * ⚠️ This row's own change is NOT TRUSTWORTHY: it exceeds the value it was measured from,
   * which is not growth — it is the stored series jumping between two different channels.
   * The number is still shown, because hiding it would hide the evidence that the row's
   * identity is wrong, but it must be visibly marked rather than read as a result.
   */
  followerDeltaUnreliable: boolean;
  syncSource: string | null;
  /** When a real FOLLOWER COUNT was last measured. Null for a channel that withholds it. */
  lastSyncedAt: string | null;
  /**
   * When the channel was last successfully FETCHED — which is not the same thing. The seven
   * Snapchat profiles that withhold their follower count are fetched fine every cycle and
   * still have no number to stamp on `lastSyncedAt`, so without this the UI would label a
   * healthy, actively-collected channel "Manual" (i.e. hand-entered), which is false.
   */
  metricsFetchedAt: string | null;
  metricsError: string | null;
  // YouTube
  totalViews: number | null;
  /** Exact lifetime-view growth across the window. */
  viewsDelta: number | null;
  viewsDeltaDays: number | null;
  videoCount: number | null;
  // Snapchat
  recentViews: number | null;
  recentViewsCovered: number | null;
  recentPostsSeen: number | null;
}

export interface ChannelBoard {
  platform: ChannelPlatform;
  days: number;
  rows: ChannelRow[];
  totals: {
    channels: number;
    /** Summed followers of channels that published one … */
    followers: number | null;
    /** … and how many channels that is, so the total is never mistaken for the estate. */
    followersReported: number;
    /** Channels whose follower count the platform withholds. */
    followersWithheld: number;
    totalViews: number | null;
    /**
     * Channels for which EITHER metric produced a change — the board-level "we are still
     * collecting" note is gated on this being 0.
     *
     * ⚠️ NOT a like-for-like denominator, and it deliberately does not check the span.
     * Counting only the follower delta made the board print "no channel has N days of
     * history yet" while every Views-change cell held a real number (fixed in 954c253), so
     * do not narrow it back. The TOTALS above are the span-guarded figures; this is only
     * "is there anything at all to show yet".
     */
    withHistory: number;
    /**
     * ── PERIOD MOVEMENT OF THE TWO SUMMABLE TILES ────────────────────────────────────
     *
     * ⚠️ SUMMED ONLY OVER CHANNELS WHOSE OWN DELTA SPANS ~THE WHOLE WINDOW, and the
     * contributing count ships beside it. This is the Meta board's rule and it exists
     * because the unguarded version was measured and rejected there: short-history
     * channels contributed 5-day changes labelled as 28-day ones, and dividing a
     * 146-channel delta by a 419-channel stock understated real growth by 45%. A total
     * that mixes spans is not a total, it is an average of different questions.
     *
     * null — never 0 — when no channel qualifies. A rendered 0 asserts "the estate did
     * not move", which is precisely what we do not know yet.
     */
    followerDelta: number | null;
    /** How many channels that sum is measured over … */
    followerDeltaChannels: number;
    /**
     * … and how many were EXCLUDED because their movement was smaller than the platform's
     * rounding step. ⚠️ This is load-bearing for YouTube and must be shown, not hidden:
     * measured on prod at 30d, the visible sum was +19,490 across 7 channels while 14
     * suppressed channels carried ~275,000 of invisible headroom (Inde News alone is
     * ±100,000 per step). Presenting +19,490 as "the estate's growth" without that count
     * would be a confident number standing in front of a much larger unknown.
     */
    followerDeltaSuppressed: number;
    /**
     * Channels left out of the sum because their in-window change exceeded their own
     * baseline — i.e. the series jumped between two different channels rather than grew.
     * Disclosed, never silently dropped.
     */
    followerDeltaExcluded: number;
    /**
     * ⚠️ THE ERROR BAR ON `followerDelta`, and the reason the tile must not always print a
     * number. Every reading is rounded, so a difference of two carries up to ±step; summed
     * over the full-span channels this is ±186,310 on the live YouTube board — while the
     * artifact-guarded signal is +1,500 at 7d and +19,590 at 30d, i.e. 5–124× SMALLER than
     * its own uncertainty. The envelope is set by the estate's size, not by how long we
     * have collected, so it does not shrink with time. A tile that printed "+1,500" would
     * be stating a number it cannot resolve. Render the value only when
     * |followerDelta| >= followerDeltaUncertainty; otherwise say what the limit is.
     */
    followerDeltaUncertainty: number;
    /** Exact — the lifetime view counter is not rounded, so this total hides nothing. */
    viewsDelta: number | null;
    viewsDeltaChannels: number;
  };
  /** The earliest snapshot date we hold for this platform, so the UI can say "collecting since". */
  historyFrom: string | null;
  generatedAt: string;
}

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

function num(v: bigint | number | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "bigint" ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
}

function daysBetween(a: Date, b: Date): number {
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / 86_400_000));
}

/**
 * The rounding step the PLATFORM publishes a follower count at, below which a difference
 * between two readings is quantisation, not measured movement.
 *
 * ⚠️ SNAPCHAT ROUNDS TOO, and an earlier version of this file asserted it did not. Measured
 * three independent ways on 2026-09-22: all 30 current non-archived counts are multiples of
 * 100 (only 1 of 30 is a multiple of 1,000, so it is a FLAT ×100 grid, not significant
 * figures — 396,100 would be 396,000 under 3-sig-figs); all 341 stored snapshots are
 * multiples of 100; and the smallest non-zero consecutive-day move is exactly 100 on every
 * one of the six accounts that has ever moved. The raw published value is Snapchat's own
 * (`"subscriberCount":"39300"` live from the profile page), so the grid is theirs, not our
 * parser's. Without this, a one-step reading like "+100" was rendered as measured growth.
 *
 * ⚠️ A stored `followersPrecision` always wins — it is what the platform told us at write
 * time. The fallback is derived per platform, because precision is NULL on every row until
 * a sync has written one and a 0 step would make the guard unsatisfiable.
 *
 * ⚠️ An uncharacterised platform returns 0 (fail-open). Suppressing real movement on a
 * platform we have not measured would be worse than showing it.
 */
function stepFor(platform: ChannelPlatform, followers: number | null, stored: number | null): number {
  if (stored != null) return stored;
  if (followers == null) return 0;
  if (platform === "youtube") return subscriberPrecisionFor(followers) ?? 0;
  if (platform === "snapchat") return SNAPCHAT_FOLLOWER_STEP;
  return 0;
}

/** Snapchat's flat published grid. See stepFor. */
const SNAPCHAT_FOLLOWER_STEP = 100;

/**
 * Build one platform's board.
 *
 * Read cost is bounded by CHANNEL COUNT, not by history: one `findMany` over the accounts
 * (~52 rows) plus one over their snapshots restricted to the window, selecting four
 * scalars. At 90 days that is ~4,700 tiny rows. There is deliberately no `include` of the
 * snapshot relation — a nested include is the hydration shape behind four separate
 * outages in this codebase.
 */
async function buildBoard(platform: ChannelPlatform, days: number): Promise<ChannelBoard> {
  const accounts = await prisma.socialAccount.findMany({
    where: { platform: { slug: platform }, status: { not: "ARCHIVED" } },
    select: {
      id: true, handle: true, displayName: true, profileUrl: true, status: true,
      followerCount: true, followersPrecision: true, syncSource: true, lastSyncedAt: true,
      totalViews: true, videoCount: true, recentViews: true, recentViewsCovered: true,
      recentPostsSeen: true, metricsError: true, metricsFetchedAt: true,
    },
    orderBy: { followerCount: "desc" },
  });

  if (accounts.length > ROW_WARN_THRESHOLD) {
    console.warn(
      `[channel-growth] ${platform}: ${accounts.length} channels — past the ${ROW_WARN_THRESHOLD} tripwire. ` +
        `Paginating this read is now a decision that needs making, not a discovery.`,
    );
  }

  const ids = accounts.map((a) => a.id);
  const since = new Date(Date.now() - days * 86_400_000);

  const snaps = ids.length
    ? await prisma.accountGrowthSnapshot.findMany({
        where: { accountId: { in: ids }, date: { gte: since } },
        select: { accountId: true, date: true, followerCount: true, totalViews: true },
        orderBy: { date: "asc" },
      })
    : [];

  // first/last per account, in one pass over an already-sorted list
  const first = new Map<string, (typeof snaps)[number]>();
  const last = new Map<string, (typeof snaps)[number]>();
  // ⚠️ SEPARATE first/last for the VIEW counter, restricted to snapshots that actually
  // carry one. `total_views` was added to this table later than the table itself, so every
  // snapshot written before it shipped holds NULL. Reusing `first` here meant the baseline
  // was almost always one of those NULL rows and the delta was discarded — measured on
  // prod the day after launch, 20 of 22 channels' earliest 7-day snapshot had no view
  // count, so the Views-change column was a dash at EVERY period and would have stayed one
  // until the window no longer reached back past the cutover: 29 Sep at 7d, and 21 Dec at
  // 90d. Picking the earliest snapshot that HAS the metric measures what we actually hold.
  const firstViews = new Map<string, (typeof snaps)[number]>();
  const lastViews = new Map<string, (typeof snaps)[number]>();
  for (const s of snaps) {
    if (!first.has(s.accountId)) first.set(s.accountId, s);
    last.set(s.accountId, s);
    if (s.totalViews != null) {
      if (!firstViews.has(s.accountId)) firstViews.set(s.accountId, s);
      lastViews.set(s.accountId, s);
    }
  }

  // ⚠️ Asked SEPARATELY and WITHOUT the window filter. Taking the earliest of `snaps` would
  // clip it to the selected period, so a 7-day view would claim "collecting since 15 Sep"
  // for a channel we have held since May — understating our own history to the reader.
  const oldest = ids.length
    ? await prisma.accountGrowthSnapshot.aggregate({
        where: { accountId: { in: ids } },
        _min: { date: true },
      })
    : null;
  const earliest = oldest?._min.date ?? null;

  let sumFollowers = 0;
  let followersReported = 0;
  let followersWithheld = 0;
  let sumViews = 0;
  let anyViews = false;
  let withHistory = 0;

  // ⚠️ "Spans the window" is 90% of it, matching the Meta board exactly. It cannot be
  // 100%: snapshots are written once a day by a cron whose start time drifts, so a
  // genuinely complete 30-day history routinely measures 29 days and a strict test would
  // reject every channel on the board.
  const fullSpanMin = Math.max(1, Math.ceil(days * 0.9));
  let sumFollowerDelta = 0;
  let followerDeltaChannels = 0;
  let followerDeltaSuppressed = 0;
  let followerDeltaExcluded = 0;
  let sumFollowerStep = 0;
  let sumViewsDelta = 0;
  let viewsDeltaChannels = 0;

  const rows: ChannelRow[] = accounts.map((a) => {
    const f = first.get(a.id);
    const l = last.get(a.id);

    // ⚠️ followerCount is a non-nullable Int defaulting to 0, and the sync only ever writes
    // a value it actually measured (`persistFollowerCount` refuses anything <= 0). So a 0
    // here means "never measured", never "has no followers" — which is exactly the state
    // the 7 Snapchat profiles that withhold their count are left in.
    const followers = a.followerCount > 0 ? a.followerCount : null;
    if (followers != null) {
      sumFollowers += followers;
      followersReported++;
    } else {
      followersWithheld++;
    }

    // A delta needs two DISTINCT days; comparing a day against itself is 0-by-construction
    // and would read as "flat" rather than "not measured yet".
    const spans = f && l && f.date < l.date;
    let followerDelta: number | null = null;
    let followerDeltaDays: number | null = null;
    /** True when a real measurement existed but fell below the platform's rounding step. */
    let suppressedByStep = false;
    /** The platform's rounding step for this row, for the totals' uncertainty envelope. */
    let step = 0;
    /** The value the change was measured from, for the totals' artifact guard. */
    let baseline: number | null = null;
    if (spans && f!.followerCount > 0 && l!.followerCount > 0) {
      const raw = l!.followerCount - f!.followerCount;
      followerDeltaDays = daysBetween(f!.date, l!.date);
      // ⚠️ THE QUANTISATION GUARD. YouTube rounds to 3 significant figures, so a movement
      // smaller than one step is invisible to us — reporting 0 would assert "did not grow".
      //
      // ⚠️⚠️ IT MUST NOT FALL BACK TO 0. `followersPrecision` is NULL on every row until a
      // sync has written it — which is the state of every existing YouTube channel right
      // after this ships, and the permanent state of one whose resolution keeps failing
      // (no API key, quota exhausted, terminated channel). With step 0 the comparison can
      // never be true, so a channel sitting on flat rounded snapshots renders a confident
      // "0" for a period in which it really gained tens of thousands of subscribers.
      // Rounding is a property of the PLATFORM, not of our backfill state, so derive it.
      step = stepFor(platform, followers, a.followersPrecision);
      suppressedByStep = Math.abs(raw) < step;
      followerDelta = suppressedByStep ? null : raw;
      // The baseline this change was measured FROM — used only by the totals' artifact
      // guard below, never to alter what this row displays.
      baseline = f!.followerCount;
    }

    // ⚠️ Measured over the view counter's OWN span, which is usually shorter than the
    // follower span and is labelled from its own dates (viewsDeltaDays). Borrowing the
    // follower span would print a 1-day change under a "90d" label.
    const fV = firstViews.get(a.id);
    const lV = lastViews.get(a.id);
    let viewsDelta: number | null = null;
    let viewsDeltaDays: number | null = null;
    if (fV && lV && fV.date < lV.date) {
      const fv = num(fV.totalViews);
      const lv = num(lV.totalViews);
      if (fv != null && lv != null) {
        viewsDelta = lv - fv; // exact — no suppression needed
        viewsDeltaDays = daysBetween(fV.date, lV.date);
      }
    }

    // ⚠️ EITHER delta counts as history. Counting only the follower delta made the YouTube
    // board print "no channel has N days of history yet, we are still collecting" on a
    // board where every Views Δ cell held a real number — blaming collection lag for what
    // is actually YouTube's rounding, and contradicting the note directly beneath it.
    if (followerDelta != null || viewsDelta != null) withHistory++;

    // A change larger than the value it was measured from cannot be growth. Computed once
    // here so the ROW can mark itself and the TOTAL can exclude it from the same test.
    const deltaExceedsBaseline =
      followerDelta != null && baseline != null && baseline > 0 && Math.abs(followerDelta) > baseline;

    // ── Totals movement — same-span, same-kind measurements only ────────────────────
    const fullSpan = followerDeltaDays != null && followerDeltaDays >= fullSpanMin;
    if (fullSpan) {
      // The uncertainty envelope covers every full-span channel, contributor or not: each
      // rounded reading is within ±step/2, so a difference of two carries up to ±step.
      sumFollowerStep += step;
      if (followerDelta != null) {
        // ⚠️ ARTIFACT GUARD. A change LARGER THAN ITS OWN BASELINE is not growth — it is the
        // stored series having been written from two different channels. Measured on prod:
        // `Total filmi ` holds four distinct values across 90 days (1,040,000 / 356,000 /
        // 46,300 / 10,900, a 95x range, where every other channel on both boards varies by
        // <=1.1x) and contributed +684,000 of a +687,600 fourteen-day total — 99.5% of the
        // headline from one row. It PASSES the full-span filter, so that filter is
        // necessary but not sufficient.
        //
        // ⚠️ ON THE CAUSE, stated only as far as the evidence goes: that row has no exact
        // identity path (its handle is a display name, and forHandle on it returns 0 items
        // — verified live), so it resolves through a RANKED NAME match, and the stored
        // series proves that ranking has returned at least four different channels over
        // time. It is NOT whitespace-sensitive and it is NOT unstable today: probed live,
        // "Total filmi " and "Total filmi" return an identical top-3 led by the correct
        // channel. So the exposure is the missing exact path, not a reproducible flapping
        // search — which is why the fix is to pin identity, not to distrust the search.
        //
        // ⚠️ The 100%-of-baseline bound is a HEURISTIC, not a measurement: it would also
        // drop a genuinely doubling channel from the sum. That is why the row keeps its own
        // number and the exclusion is counted and disclosed rather than silent.
        //
        // ⚠️ The row keeps showing its own change; only the SUM excludes it, and the count
        // is disclosed. Hiding the row would hide the evidence of the underlying problem.
        if (deltaExceedsBaseline) {
          followerDeltaExcluded++;
        } else {
          sumFollowerDelta += followerDelta;
          followerDeltaChannels++;
        }
      } else if (suppressedByStep) {
        // Counted separately, never as a 0: this channel DID have a full-span measurement,
        // we simply cannot see movement below its rounding step.
        followerDeltaSuppressed++;
      }
    }
    if (viewsDelta != null && viewsDeltaDays != null && viewsDeltaDays >= fullSpanMin) {
      sumViewsDelta += viewsDelta;
      viewsDeltaChannels++;
    }

    const tv = num(a.totalViews);
    if (tv != null) {
      sumViews += tv;
      anyViews = true;
    }

    return {
      id: a.id,
      handle: a.handle,
      displayName: a.displayName,
      profileUrl: a.profileUrl,
      status: a.status,
      followers,
      followersPrecision: a.followersPrecision,
      followerDelta,
      followerDeltaDays,
      followerDeltaUnreliable: deltaExceedsBaseline,
      syncSource: a.syncSource,
      lastSyncedAt: iso(a.lastSyncedAt),
      metricsFetchedAt: iso(a.metricsFetchedAt),
      metricsError: a.metricsError,
      totalViews: tv,
      viewsDelta,
      viewsDeltaDays,
      videoCount: a.videoCount,
      recentViews: num(a.recentViews),
      recentViewsCovered: a.recentViewsCovered,
      recentPostsSeen: a.recentPostsSeen,
    };
  });

  return {
    platform,
    days,
    rows,
    totals: {
      channels: accounts.length,
      // ⚠️ null, not 0, when nothing reported — a summed 0 reads as a real estate total.
      followers: followersReported > 0 ? sumFollowers : null,
      followersReported,
      followersWithheld,
      totalViews: anyViews ? sumViews : null,
      withHistory,
      // null, never 0 — "no channel qualified" is not "the estate did not move".
      followerDelta: followerDeltaChannels > 0 ? sumFollowerDelta : null,
      followerDeltaChannels,
      followerDeltaSuppressed,
      followerDeltaExcluded,
      followerDeltaUncertainty: sumFollowerStep,
      viewsDelta: viewsDeltaChannels > 0 ? sumViewsDelta : null,
      viewsDeltaChannels,
    },
    historyFrom: earliest ? earliest.toISOString().slice(0, 10) : null,
    generatedAt: new Date().toISOString(),
  };
}

export function getChannelBoard(platform: ChannelPlatform, days: number): Promise<ChannelBoard> {
  return _memo.memo(`${platform}:${days}`, () => buildBoard(platform, days));
}
