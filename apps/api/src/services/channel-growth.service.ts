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
    /** Channels with a delta spanning the whole window — the like-for-like denominator. */
    withHistory: number;
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
  for (const s of snaps) {
    if (!first.has(s.accountId)) first.set(s.accountId, s);
    last.set(s.accountId, s);
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
      const step =
        a.followersPrecision ??
        (platform === "youtube" && followers != null ? (subscriberPrecisionFor(followers) ?? 0) : 0);
      followerDelta = Math.abs(raw) < step ? null : raw;
    }

    let viewsDelta: number | null = null;
    let viewsDeltaDays: number | null = null;
    if (spans) {
      const fv = num(f!.totalViews);
      const lv = num(l!.totalViews);
      if (fv != null && lv != null) {
        viewsDelta = lv - fv; // exact — no suppression needed
        viewsDeltaDays = daysBetween(f!.date, l!.date);
      }
    }

    // ⚠️ EITHER delta counts as history. Counting only the follower delta made the YouTube
    // board print "no channel has N days of history yet, we are still collecting" on a
    // board where every Views Δ cell held a real number — blaming collection lag for what
    // is actually YouTube's rounding, and contradicting the note directly beneath it.
    if (followerDelta != null || viewsDelta != null) withHistory++;

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
    },
    historyFrom: earliest ? earliest.toISOString().slice(0, 10) : null,
    generatedAt: new Date().toISOString(),
  };
}

export function getChannelBoard(platform: ChannelPlatform, days: number): Promise<ChannelBoard> {
  return _memo.memo(`${platform}:${days}`, () => buildBoard(platform, days));
}
