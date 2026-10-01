import { isGapDayKey, gapShiftDay } from "../utils/submission-gaps";

/**
 * Account Growth — the "All" tab's combination logic (pure, shared).
 *
 * The owner asked on 2026-10-01 for "a fourth tab that depicts 'All' the data in a combined
 * format … with clear labels … with accurate date depicted e2e". The page header recorded
 * an earlier owner rule: cross-platform roll-ups were REMOVED (2026-08-24) because they came
 * from follower SNAPSHOTS rather than each platform's own metrics. This module is how the
 * All tab satisfies both: it re-measures NOTHING. It only composes the three boards' own
 * figures —
 *
 *   Meta     /admin/meta/channels          — Meta's API, Facebook + Instagram
 *   YouTube  /admin/channels?platform=youtube  — YouTube's Data API
 *   Snapchat /admin/channels?platform=snapchat — public profile pages
 *
 * — and adds them up ONLY where a figure means the same thing on every platform: channels,
 * followers (a stock), follower change and views over the same 7 or 28 days. Engagements,
 * reach, revenue and profile views are Meta-only and are deliberately not combined.
 *
 * ⚠️ RULES THAT MAKE THE SUMS HONEST — each was a measured failure somewhere in this repo:
 *  - A null is "the platform published nothing", never a 0. A sum over nothing is null.
 *  - Meta's follower change uses the Meta tab's own 90% full-span rule, over its own rows.
 *    YouTube's and Snapchat's come from their servers' guarded totals, never re-summed
 *    from rows (that would undo the artifact guard and the rounding suppression).
 *  - Snapchat publishes no period view count. Its recentViews is a sample — never summed.
 *  - A source that answered for a different period than asked is an ERROR, not data: a
 *    board coerced from 28 back to 30 days would otherwise render 30 days under "28d".
 *  - Combined figures sum only the platforms that loaded and name the rest.
 *
 * Kept free of React and the DOM so the API's vitest suite (the only test runner in the
 * repo) can lock it, and free of regex lookbehind (scripts/ci/guards.sh scans shared src).
 */

// ─── Platforms and periods ───────────────────────────────────────────────────────

export const GROWTH_PLATFORMS = ["facebook", "instagram", "youtube", "snapchat"] as const;
export type GrowthPlatform = (typeof GROWTH_PLATFORMS)[number];

export const GROWTH_PLATFORM_LABEL: Record<GrowthPlatform, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  youtube: "YouTube",
  snapchat: "Snapchat",
};

/** The Account Growth tab each platform lives on — Facebook and Instagram are both on "Meta". */
export const GROWTH_PLATFORM_TAB: Record<GrowthPlatform, string> = {
  facebook: "Meta",
  instagram: "Meta",
  youtube: "YouTube",
  snapchat: "Snapchat",
};

/** The request each platform's figures come from: Facebook and Instagram share Meta's. */
export type GrowthSource = "meta" | "youtube" | "snapchat";
export const GROWTH_SOURCE_OF: Record<GrowthPlatform, GrowthSource> = {
  facebook: "meta",
  instagram: "meta",
  youtube: "youtube",
  snapchat: "snapchat",
};

/** "YouTube", "Facebook and Instagram", "Facebook, Instagram and YouTube" (or "…or…"). */
export function growthListNames(ps: readonly GrowthPlatform[], conj: "and" | "or" = "and"): string {
  const n = ps.map((p) => GROWTH_PLATFORM_LABEL[p]);
  if (n.length <= 1) return n[0] ?? "";
  return `${n.slice(0, -1).join(", ")} ${conj} ${n[n.length - 1]}`;
}

/**
 * The only periods every platform can measure over the same span.
 *
 * ⚠️ NOT EXTENSIBLE BY US. Meta answers only its native rolling windows — `week` and
 * `days_28` (Facebook's `period` has no 30 or 90, and Instagram rejects spans over 30
 * days) — while the YouTube/Snapchat boards measure any day count from stored snapshots.
 * 7 and 28 are therefore the intersection; a "30d" here would put Meta's 28 days beside
 * the boards' 30 under one label.
 */
export const GROWTH_ALL_PERIODS = [7, 28] as const;
export type GrowthAllPeriod = (typeof GROWTH_ALL_PERIODS)[number];
export const DEFAULT_GROWTH_ALL_PERIOD: GrowthAllPeriod = 28;

export type GrowthMetaWindow = "week" | "days_28";

/** The Meta window a period maps to — the SAME key the Meta tab requests, so the cache is shared. */
export function growthMetaWindow(days: GrowthAllPeriod): GrowthMetaWindow {
  return days === 7 ? "week" : "days_28";
}

/** The period a Meta payload's echoed `window` describes, or null for any other window. */
export function growthPeriodOfMetaWindow(window: string | null | undefined): GrowthAllPeriod | null {
  return window === "week" ? 7 : window === "days_28" ? 28 : null;
}

/**
 * How many days a channel's OWN change must span to count in a period total: 90% of it,
 * the Meta tab's rule (and the YouTube/Snapchat server's). Not 100% — snapshots are written
 * by a cron whose start time drifts, so a complete 28-day history routinely measures 27.
 * 7 → 7, 28 → 26.
 */
export function growthFullSpanMin(periodDays: number): number {
  return Math.max(1, Math.ceil(periodDays * 0.9));
}

// ─── Inputs (structural: only the fields this module reads) ──────────────────────

/** An inclusive range of calendar day keys ("YYYY-MM-DD"). */
export interface GrowthSpan {
  from: string;
  to: string;
}

/**
 * Which calendar a span's days belong to — they differ, and the UI must say so:
 *   pacific-day  — Facebook: Meta's day ends at Pacific midnight (~12:30 PM IST).
 *   utc-day      — Instagram: Meta's day ends at midnight UTC (5:30 AM IST).
 *   ist-snapshot — YouTube/Snapchat: our own daily snapshots, dated on the IST calendar.
 */
export type GrowthSpanKind = "pacific-day" | "utc-day" | "ist-snapshot";

/** One row of GET /admin/meta/channels (live mode). */
export interface GrowthMetaItemInput {
  id: string;
  platform: "facebook" | "instagram";
  metaId: string;
  name: string;
  username: string | null;
  followers: number | null;
  followerDelta: number | null;
  followerDeltaDays?: number | null;
  /**
   * The IST date of the API snapshot the change is measured FROM — it runs from there to
   * the channel's current count. null = Meta's own accounting for the window (Instagram's
   * follows − unfollows, which spans the window), or no change. Absent (undefined) on a
   * response that predates the field, which states no start date rather than guess one.
   */
  followerDeltaFrom?: string | null;
  /** ⚠️ Despite the name, the VALUE follows the requested window (wire-compatible name). */
  views28d: number | null;
  /** The channel's latest refresh failed; its figures are the last good ones. */
  metricsError?: string | null;
}

/** GET /admin/meta/channels?window=week|days_28 — the Meta tab's own payload. */
export interface GrowthMetaInput {
  /** The window the SERVER says it answered for. Labels and periods follow this. */
  window: string;
  items: GrowthMetaItemInput[];
  /** Each platform's last covered day (Facebook a Pacific day, Instagram a UTC day). */
  dataThroughDayByPlatform?: { facebook: string | null; instagram: string | null } | null;
  /**
   * Each platform's NEWEST covered day. Later than dataThroughDayByPlatform while a sync is
   * part-way through moving that platform's channels onto the next window.
   */
  newestCoveredDayByPlatform?: { facebook: string | null; instagram: string | null } | null;
}

/** One row of GET /admin/channels (YouTube or Snapchat). */
export interface GrowthBoardRowInput {
  id: string;
  handle: string;
  displayName: string;
  profileUrl: string | null;
  followers: number | null;
  followerDelta: number | null;
  followerDeltaDays: number | null;
  followerDeltaUnreliable?: boolean;
  lastSyncedAt: string | null;
  metricsError?: string | null;
  viewsDelta: number | null;
  viewsDeltaDays: number | null;
}

/** GET /admin/channels?platform=youtube|snapchat&days=7|28. */
export interface GrowthBoardInput {
  platform: string;
  /** The period the SERVER measured (it coerces values it does not serve). */
  days: number;
  rows: GrowthBoardRowInput[];
  totals: {
    channels: number;
    followers: number | null;
    followersReported: number;
    followersWithheld: number;
    // Optional: an older cached response predates them, and must degrade to "no figure".
    followerDelta?: number | null;
    followerDeltaChannels?: number;
    followerDeltaSuppressed?: number;
    followerDeltaExcluded?: number;
    followerDeltaUncertainty?: number;
    viewsDelta?: number | null;
    viewsDeltaChannels?: number;
    followerDeltaSpan?: GrowthSpan | null;
    viewsDeltaSpan?: GrowthSpan | null;
  };
  historyFrom: string | null;
}

/** A source that failed to load, with the API's message verbatim. */
export interface GrowthLoadError {
  error: string;
}

/** Not loaded yet (undefined/null), failed (GrowthLoadError), or loaded. */
export type GrowthSourceInput<T> = T | GrowthLoadError | null | undefined;

export function isGrowthLoadError(x: unknown): x is GrowthLoadError {
  return typeof x === "object" && x !== null && typeof (x as { error?: unknown }).error === "string";
}

/**
 * Whether a load failure is the admin-only gate rather than an outage.
 *
 * ⚠️ Matched on the MESSAGE because the internal portal's apiFetch throws only
 * `error.message` — no HTTP status. Both gates on these endpoints can answer:
 * requirePermission → "No permission: manage on reports", requireAdminRole → "Admin role
 * required". If either message changes, the panel degrades to the generic error, never to
 * a misleading "no data".
 */
export function growthErrorIsForbidden(message: string | null | undefined): boolean {
  if (!message) return false;
  return /^No permission:/i.test(message) || /Admin role required/i.test(message);
}

/**
 * What kind of failure a source had — so the panel can say it in calm, honest words.
 *
 *   forbidden — the admin-only gate (a 403): "Only administrators can see Account Growth".
 *   busy      — the API's rate limiter (a 429): wait a moment, then retry.
 *   mismatch  — the source answered for a different period than asked (this module's own
 *               message, which explains itself and is safe to show).
 *   failed    — anything else: a 500, a timeout, a 502 page that is not JSON.
 *
 * ⚠️ The panel never prints a raw message for `busy` or `failed`. The owner asked that
 * "too many requests", "something went wrong" and "unexpected error" never appear, and the
 * raw texts are exactly those ("Too many requests, please try again later", "An unexpected
 * error occurred", or a JSON parser's "Unexpected token '<'" for an HTML error page).
 */
export type GrowthErrorKind = "forbidden" | "busy" | "mismatch" | "failed";

export function growthErrorKind(message: string | null | undefined): Exclude<GrowthErrorKind, "mismatch"> {
  if (growthErrorIsForbidden(message)) return "forbidden";
  if (message && (/too many requests/i.test(message) || /rate.?limit/i.test(message))) return "busy";
  return "failed";
}

// ─── Outputs ─────────────────────────────────────────────────────────────────────

export type GrowthSourceState = "loading" | "error" | "ready";

/**
 * One platform's row in the All tab.
 *
 * ⚠️ Every figure is null — never 0 — when its source has not loaded, failed, or published
 * nothing. A 0 means a platform loaded and reported a real zero.
 */
export interface GrowthPlatformAggregate {
  platform: GrowthPlatform;
  /** The period this aggregate was built for (7 or 28). */
  periodDays: number;
  state: GrowthSourceState;
  /** The load failure, verbatim, when state is "error" — for logs and tests, NOT for the
   *  screen (see growthErrorKind: render `errorKind`, never this, unless it is "mismatch"). */
  error: string | null;
  /** What kind of failure it was, when state is "error". */
  errorKind: GrowthErrorKind | null;
  /** The failure is the admin-only gate (403), not an outage. */
  forbidden: boolean;
  channels: number | null;
  /** Summed follower/subscriber counts of the channels that publish one. */
  followers: number | null;
  /** How many channels that is … */
  followersReported: number | null;
  /** … out of how many on the board. */
  followersTotal: number | null;
  /** Channels whose count the platform withholds (YouTube/Snapchat boards). */
  followersWithheld: number | null;
  /** Follower change over the period, summed over full-span channels only. */
  followerDelta: number | null;
  followerDeltaChannels: number | null;
  /** The span a channel's own change must cover to count: growthFullSpanMin(period). */
  followerDeltaMinDays: number;
  /** Full-span channels whose movement was finer than the platform's rounding (boards). */
  followerDeltaSuppressed: number | null;
  /** Full-span channels left out because their change exceeds their own baseline (boards). */
  followerDeltaExcluded: number | null;
  /** ± error bar on followerDelta from rounded counts. 0 = no rounding (Meta). */
  uncertainty: number;
  /** |followerDelta| < uncertainty: show it as approximate, with the ± beside it. */
  followerDeltaApprox: boolean;
  views: number | null;
  viewsChannels: number | null;
  /** false = the platform publishes no period view count at all (Snapchat). */
  viewsPublished: boolean;
  /**
   * The dates this platform's period figures are anchored to.
   *   Meta: its native views window — the platform's earliest healthy covered day back
   *         period−1 days. ⚠️ NOT the follower change's dates: that runs from our API
   *         snapshots to each channel's current count (see changeSince / changeUntil).
   *   YouTube/Snapchat: the IST snapshot dates its follower change covers.
   * null when there is nothing dated to state (not loaded, or no contributor yet).
   */
  span: GrowthSpan | null;
  /**
   * Meta only: the range of days this platform's channels' windows END on, earliest to
   * newest. Equal ends = every channel is on one window. Different ends = a sync is moving
   * channels onto the next window (or a restored channel lags), so the total mixes windows
   * and the UI must say so rather than print `span` alone. null when not known.
   */
  spanEnds: GrowthSpan | null;
  /**
   * The dates the views figure covers — separate because YouTube's view counter has a
   * shorter stored history than its subscriber count. Meta: the window. Snapchat: null.
   */
  viewsSpan: GrowthSpan | null;
  spanKind: GrowthSpanKind;
  /**
   * The earliest day the follower change is measured FROM, over the channels in the sum.
   *   Boards: their snapshot span's first day.
   *   Meta: the earliest API snapshot (IST date) a contributor's change starts at, or the
   *         window's first day for Meta's own accounting (Instagram's follows − unfollows).
   * null when nothing contributed, or a contributor did not say (an older response).
   */
  changeSince: string | null;
  /**
   * The last day the change is measured TO, where that is a stored date.
   *   Boards: their snapshot span's last day.
   *   Meta: null — a snapshot-measured change runs to each channel's CURRENT count
   *         (Facebook: as of the latest sync; Instagram: as of the last channel refresh).
   *         Only an all-accounting Instagram change has a dated end: the window's last day.
   */
  changeUntil: string | null;
  /** Meta contributors whose change is Meta's own follows − unfollows for the window. */
  followerDeltaAccounting: number | null;
  /** The board's earliest snapshot (YouTube/Snapchat), for "not enough history yet (since …)". */
  historyFrom: string | null;
  /** Newest lastSyncedAt on the board (YouTube/Snapchat). Meta: null — it carries no
   *  per-row instant for its follower counts, so the UI says "as of the latest sync". */
  latestSyncedAt: string | null;
  /** Meta channels whose latest refresh failed: their figures predate the stated span. */
  staleChannels: number | null;
}

export interface GrowthCombined {
  /** Platforms whose data loaded. Every combined figure sums these ONLY. */
  includedPlatforms: GrowthPlatform[];
  /** Platforms left out of every sum — still loading or failed. Name them beside the sums. */
  missingPlatforms: GrowthPlatform[];
  loadingPlatforms: GrowthPlatform[];
  failedPlatforms: GrowthPlatform[];
  /** Every source has answered (ready or error). Until then a sum would jump as data lands. */
  settled: boolean;
  channels: number | null;
  followers: number | null;
  followersReported: number;
  followersTotal: number;
  /** Platforms whose follower count is in `followers`. */
  followersPlatforms: GrowthPlatform[];
  followerDelta: number | null;
  followerDeltaChannels: number;
  followerDeltaPlatforms: GrowthPlatform[];
  /** Full-span channels, across the loaded boards, that moved less than their rounding step. */
  followerDeltaSuppressed: number;
  /** Full-span channels, across the loaded boards, left out as unreliable. */
  followerDeltaExcluded: number;
  /** Summed rounding error bars of the loaded boards (Meta adds none). */
  uncertainty: number;
  /** The loaded platforms that error bar comes from — named beside it, never left implied. */
  uncertaintyPlatforms: GrowthPlatform[];
  followerDeltaApprox: boolean;
  views: number | null;
  viewsChannels: number;
  viewsPlatforms: GrowthPlatform[];
  /**
   * Loaded BOARDS (YouTube) with channels whose period view figure needs more stored
   * history. ⚠️ Boards only: Meta's views need no history of ours, so a Meta platform with
   * no figure is in viewsUnreportedPlatforms instead — "not enough history" would be false.
   */
  viewsPendingPlatforms: GrowthPlatform[];
  /** Loaded Meta platforms with channels where Meta reported no view figure for the window. */
  viewsUnreportedPlatforms: GrowthPlatform[];
  /** Loaded platforms that publish no period view count at all (Snapchat). */
  viewsUnpublishedPlatforms: GrowthPlatform[];
}

/** One channel in the All tab's table — the platform's own figures, unchanged. */
export interface GrowthChannelRow {
  /** Unique across platforms (`${platform}:${id}`) — two boards can share an id shape. */
  key: string;
  id: string;
  platform: GrowthPlatform;
  name: string;
  handle: string | null;
  href: string | null;
  followers: number | null;
  followerDelta: number | null;
  /** The span the change actually covers — often shorter than the period. */
  followerDeltaDays: number | null;
  /** The change exceeds its own baseline: shown struck through, never summed or ranked. */
  followerDeltaUnreliable: boolean;
  /** Measured across a span but finer than the platform's rounding (YouTube/Snapchat). */
  followerDeltaSuppressed: boolean;
  views: number | null;
  /** The span the views figure covers: Meta the period; YouTube its own counter's span. */
  viewsDays: number | null;
  /** false = this platform publishes no period view count (Snapchat). */
  viewsPublished: boolean;
  /** The channel's latest refresh failed; its figures are the last good ones. */
  refreshError: string | null;
}

export interface GrowthCombination {
  periodDays: GrowthAllPeriod;
  platforms: Record<GrowthPlatform, GrowthPlatformAggregate>;
  combined: GrowthCombined;
  /** Every channel of every LOADED platform. Only a loaded response may list (or not list) a channel. */
  channels: GrowthChannelRow[];
}

// ─── Combination ─────────────────────────────────────────────────────────────────

function finiteOrNull(n: number | null | undefined): number | null {
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function validSpan(s: GrowthSpan | null | undefined): GrowthSpan | null {
  return s && isGapDayKey(s.from) && isGapDayKey(s.to) && s.from <= s.to ? { from: s.from, to: s.to } : null;
}

function isMetaPlatform(p: GrowthPlatform): p is "facebook" | "instagram" {
  return p === "facebook" || p === "instagram";
}

const SPAN_KIND: Record<GrowthPlatform, GrowthSpanKind> = {
  facebook: "pacific-day",
  instagram: "utc-day",
  youtube: "ist-snapshot",
  snapchat: "ist-snapshot",
};

/** A platform that is not ready: every figure null, nothing dated. */
function blankAggregate(
  platform: GrowthPlatform,
  periodDays: number,
  state: "loading" | "error",
  error: string | null,
  kind?: GrowthErrorKind,
): GrowthPlatformAggregate {
  const errorKind = state === "error" ? (kind ?? growthErrorKind(error)) : null;
  return {
    platform,
    periodDays,
    state,
    error,
    errorKind,
    forbidden: errorKind === "forbidden",
    channels: null,
    followers: null,
    followersReported: null,
    followersTotal: null,
    followersWithheld: null,
    followerDelta: null,
    followerDeltaChannels: null,
    followerDeltaMinDays: growthFullSpanMin(periodDays),
    followerDeltaSuppressed: null,
    followerDeltaExcluded: null,
    uncertainty: 0,
    followerDeltaApprox: false,
    views: null,
    viewsChannels: null,
    viewsPublished: platform !== "snapchat",
    span: null,
    spanEnds: null,
    viewsSpan: null,
    spanKind: SPAN_KIND[platform],
    changeSince: null,
    changeUntil: null,
    followerDeltaAccounting: null,
    historyFrom: null,
    latestSyncedAt: null,
    staleChannels: null,
  };
}

function approx(delta: number | null, uncertainty: number): boolean {
  return delta !== null && uncertainty > 0 && Math.abs(delta) < uncertainty;
}

function periodMismatch(source: string, got: string, periodDays: number): string {
  return (
    `${source} answered for ${got}, not the ${periodDays} days asked for, so its figures are not shown ` +
    `under a ${periodDays}d label. Reload the page; if it persists, the server may still be updating.`
  );
}

/** Facebook or Instagram, from the ONE Meta payload both come from. */
function metaAggregate(
  platform: "facebook" | "instagram",
  src: GrowthMetaInput,
  periodDays: GrowthAllPeriod,
): GrowthPlatformAggregate {
  const minDays = growthFullSpanMin(periodDays);
  const items = src.items.filter((i) => i.platform === platform);

  // ⚠️ The window is the platform's OWN last covered day back period−1 days. Facebook and
  // Instagram close on different boundaries, so one shared end date would mislabel one.
  const end = src.dataThroughDayByPlatform?.[platform] ?? null;
  const span = isGapDayKey(end) ? { from: gapShiftDay(end, -(periodDays - 1)), to: end } : null;
  // While a sync moves channels onto the next window, ends differ — see spanEnds.
  const newest = src.newestCoveredDayByPlatform?.[platform] ?? null;
  const spanEnds = span && isGapDayKey(newest) && newest >= span.to ? { from: span.to, to: newest } : null;

  let followers = 0, followersReported = 0;
  let views = 0, viewsChannels = 0;
  let delta = 0, deltaChannels = 0;
  let stale = 0;
  // The change's own dates, over the channels in the sum only (see changeSince).
  let since: string | null = null;
  let sinceKnown = true;
  let accounting = 0;
  for (const i of items) {
    const f = finiteOrNull(i.followers);
    if (f !== null) { followers += f; followersReported++; }
    const v = finiteOrNull(i.views28d);
    if (v !== null) { views += v; viewsChannels++; }
    // ⚠️ The Meta tab's rule exactly (_meta-panel.tsx): a change counts only when its OWN
    // span covers ~the whole period. A channel with 5 days of API history contributing a
    // 5-day change to a "28d" sum is the measured 45% understatement this guards against.
    const d = finiteOrNull(i.followerDelta);
    const days = finiteOrNull(i.followerDeltaDays);
    if (d !== null && days !== null && days >= minDays) {
      delta += d;
      deltaChannels++;
      // Snapshot-measured: starts at its snapshot's IST date. Meta's accounting (null):
      // spans the window, so starts on its first day. Absent or malformed: unknown — and
      // one unknown start makes the whole start unknown rather than quietly later.
      const from = i.followerDeltaFrom === null ? (span?.from ?? null)
        : isGapDayKey(i.followerDeltaFrom) ? i.followerDeltaFrom : null;
      if (i.followerDeltaFrom === null) accounting++;
      if (from === null) sinceKnown = false;
      else if (since === null || from < since) since = from;
    }
    if (i.metricsError) stale++;
  }
  const followerDelta = deltaChannels > 0 ? delta : null;
  const changeSince = deltaChannels > 0 && sinceKnown ? since : null;
  // Only a change made entirely of Meta's own accounting ends on a stored date (the
  // window's last day); a snapshot-measured one runs to each channel's current count.
  const changeUntil = deltaChannels > 0 && accounting === deltaChannels && changeSince !== null ? (span?.to ?? null) : null;

  return {
    platform,
    periodDays,
    state: "ready",
    error: null,
    errorKind: null,
    forbidden: false,
    channels: items.length,
    followers: followersReported > 0 ? followers : null,
    followersReported,
    followersTotal: items.length,
    followersWithheld: null,
    followerDelta,
    followerDeltaChannels: deltaChannels,
    followerDeltaMinDays: minDays,
    followerDeltaSuppressed: null,
    followerDeltaExcluded: null,
    uncertainty: 0,
    followerDeltaApprox: false,
    views: viewsChannels > 0 ? views : null,
    viewsChannels,
    viewsPublished: true,
    span,
    spanEnds,
    viewsSpan: span,
    spanKind: SPAN_KIND[platform],
    changeSince,
    changeUntil,
    followerDeltaAccounting: accounting,
    historyFrom: null,
    latestSyncedAt: null,
    staleChannels: stale,
  };
}

/** YouTube or Snapchat, from that board's own server totals. */
function boardAggregate(
  platform: "youtube" | "snapchat",
  src: GrowthBoardInput,
  periodDays: GrowthAllPeriod,
): GrowthPlatformAggregate {
  const t = src.totals;
  const isYouTube = platform === "youtube";
  // ⚠️ The SERVER'S guarded totals — never a re-sum of rows, which would bring back the
  // corrupted-series rows the artifact guard excluded and the sub-step movements it hid.
  const followerDelta = finiteOrNull(t.followerDelta);
  const uncertainty = finiteOrNull(t.followerDeltaUncertainty) ?? 0;
  let latest: number | null = null;
  let latestIso: string | null = null;
  for (const r of src.rows) {
    const ms = r.lastSyncedAt ? Date.parse(r.lastSyncedAt) : NaN;
    if (Number.isFinite(ms) && (latest === null || ms > latest)) { latest = ms; latestIso = r.lastSyncedAt; }
  }
  const historyKey = typeof src.historyFrom === "string" ? src.historyFrom.slice(0, 10) : null;
  const span = validSpan(t.followerDeltaSpan);

  return {
    platform,
    periodDays,
    state: "ready",
    error: null,
    errorKind: null,
    forbidden: false,
    channels: t.channels,
    followers: finiteOrNull(t.followers),
    followersReported: t.followersReported,
    followersTotal: t.channels,
    followersWithheld: t.followersWithheld,
    followerDelta,
    followerDeltaChannels: t.followerDeltaChannels ?? 0,
    followerDeltaMinDays: growthFullSpanMin(periodDays),
    followerDeltaSuppressed: t.followerDeltaSuppressed ?? 0,
    followerDeltaExcluded: t.followerDeltaExcluded ?? 0,
    uncertainty,
    followerDeltaApprox: approx(followerDelta, uncertainty),
    // ⚠️ Snapchat publishes NO period view count. Its recentViews is a sample of whatever
    // posts the profile page chose to show — summing it would invent a figure.
    views: isYouTube ? finiteOrNull(t.viewsDelta) : null,
    viewsChannels: isYouTube ? (t.viewsDeltaChannels ?? 0) : null,
    viewsPublished: isYouTube,
    span,
    spanEnds: null,
    viewsSpan: isYouTube ? validSpan(t.viewsDeltaSpan) : null,
    spanKind: "ist-snapshot",
    changeSince: span?.from ?? null,
    changeUntil: span?.to ?? null,
    followerDeltaAccounting: null,
    historyFrom: isGapDayKey(historyKey) ? historyKey : null,
    latestSyncedAt: latestIso,
    staleChannels: null,
  };
}

function metaRows(
  src: GrowthMetaInput,
  periodDays: GrowthAllPeriod,
  metaHref: ((c: GrowthMetaItemInput) => string | null) | undefined,
): GrowthChannelRow[] {
  return src.items.map((i) => {
    const views = finiteOrNull(i.views28d);
    return {
      key: `${i.platform}:${i.id}`,
      id: i.id,
      platform: i.platform,
      name: i.name,
      handle: i.username,
      href: metaHref ? metaHref(i) : null,
      followers: finiteOrNull(i.followers),
      followerDelta: finiteOrNull(i.followerDelta),
      followerDeltaDays: finiteOrNull(i.followerDeltaDays),
      // Meta has no artifact flag: the server already drops the contested rows that would need one.
      followerDeltaUnreliable: false,
      followerDeltaSuppressed: false,
      views,
      viewsDays: views !== null ? periodDays : null,
      viewsPublished: true,
      refreshError: i.metricsError ?? null,
    };
  });
}

function boardRows(platform: "youtube" | "snapchat", src: GrowthBoardInput): GrowthChannelRow[] {
  const isYouTube = platform === "youtube";
  return src.rows.map((r) => {
    const delta = finiteOrNull(r.followerDelta);
    const deltaDays = finiteOrNull(r.followerDeltaDays);
    const views = isYouTube ? finiteOrNull(r.viewsDelta) : null;
    return {
      key: `${platform}:${r.id}`,
      id: r.id,
      platform,
      name: r.displayName || r.handle,
      handle: r.handle || null,
      href: r.profileUrl,
      followers: finiteOrNull(r.followers),
      followerDelta: delta,
      followerDeltaDays: deltaDays,
      followerDeltaUnreliable: r.followerDeltaUnreliable === true,
      // The server stamps the span even when it suppresses the change, so "span but no
      // change" is exactly "finer than the rounding step" (channel-growth.service.ts).
      followerDeltaSuppressed: delta === null && deltaDays !== null,
      views,
      viewsDays: views !== null ? finiteOrNull(r.viewsDeltaDays) : null,
      viewsPublished: isYouTube,
      refreshError: r.metricsError ?? null,
    };
  });
}

/**
 * Compose the three boards into the All tab.
 *
 * Each source is `undefined` while loading, a `{ error }` marker when it failed, or the
 * endpoint's payload. `metaHref` builds a Meta channel's link — the UI passes the Meta
 * tab's own `channelHref`, so there is one implementation of that rule, not two.
 */
export function combineGrowth(input: {
  meta: GrowthSourceInput<GrowthMetaInput>;
  youtube: GrowthSourceInput<GrowthBoardInput>;
  snapchat: GrowthSourceInput<GrowthBoardInput>;
  periodDays: GrowthAllPeriod;
  metaHref?: (c: GrowthMetaItemInput) => string | null;
}): GrowthCombination {
  const { periodDays } = input;
  const platforms = {} as Record<GrowthPlatform, GrowthPlatformAggregate>;
  const channels: GrowthChannelRow[] = [];

  // ── Meta: Facebook and Instagram share one payload, so they load and fail together.
  const meta = input.meta;
  if (meta === undefined || meta === null) {
    platforms.facebook = blankAggregate("facebook", periodDays, "loading", null);
    platforms.instagram = blankAggregate("instagram", periodDays, "loading", null);
  } else if (isGrowthLoadError(meta)) {
    platforms.facebook = blankAggregate("facebook", periodDays, "error", meta.error);
    platforms.instagram = blankAggregate("instagram", periodDays, "error", meta.error);
  } else if (growthPeriodOfMetaWindow(meta.window) !== periodDays) {
    const msg = periodMismatch("Meta", `its "${meta.window}" window`, periodDays);
    platforms.facebook = blankAggregate("facebook", periodDays, "error", msg, "mismatch");
    platforms.instagram = blankAggregate("instagram", periodDays, "error", msg, "mismatch");
  } else {
    platforms.facebook = metaAggregate("facebook", meta, periodDays);
    platforms.instagram = metaAggregate("instagram", meta, periodDays);
    channels.push(...metaRows(meta, periodDays, input.metaHref));
  }

  // ── YouTube and Snapchat: one board each.
  for (const platform of ["youtube", "snapchat"] as const) {
    const src = input[platform];
    if (src === undefined || src === null) {
      platforms[platform] = blankAggregate(platform, periodDays, "loading", null);
    } else if (isGrowthLoadError(src)) {
      platforms[platform] = blankAggregate(platform, periodDays, "error", src.error);
    } else if (src.platform !== platform) {
      platforms[platform] = blankAggregate(
        platform, periodDays, "error",
        `The ${GROWTH_PLATFORM_LABEL[platform]} board answered with ${src.platform} data. Reload the page.`,
        "mismatch",
      );
    } else if (src.days !== periodDays) {
      platforms[platform] = blankAggregate(
        platform, periodDays, "error",
        periodMismatch(`The ${GROWTH_PLATFORM_LABEL[platform]} board`, `${src.days} days`, periodDays),
        "mismatch",
      );
    } else {
      platforms[platform] = boardAggregate(platform, src, periodDays);
      channels.push(...boardRows(platform, src));
    }
  }

  // ── Combined: sum the LOADED platforms only, and say which those are.
  const all = [...GROWTH_PLATFORMS];
  const included = all.filter((p) => platforms[p].state === "ready");
  const loading = all.filter((p) => platforms[p].state === "loading");
  const failed = all.filter((p) => platforms[p].state === "error");

  const sumOf = (pick: (a: GrowthPlatformAggregate) => number | null) => {
    let sum = 0;
    const from: GrowthPlatform[] = [];
    for (const p of included) {
      const v = pick(platforms[p]);
      if (v !== null) { sum += v; from.push(p); }
    }
    return { value: from.length > 0 ? sum : null, from };
  };

  const followers = sumOf((a) => a.followers);
  const followerDelta = sumOf((a) => a.followerDelta);
  const views = sumOf((a) => (a.viewsPublished ? a.views : null));
  // ⚠️ Every LOADED board's error bar counts, contributor or not: a board whose full-span
  // channels all moved below the rounding step contributes no figure, but the estate's true
  // change is still unknown within its ±. A failed board's is unknown and it is named instead.
  const uncertainty = included.reduce((acc, p) => acc + platforms[p].uncertainty, 0);

  const combined: GrowthCombined = {
    includedPlatforms: included,
    missingPlatforms: [...loading, ...failed].sort((a, b) => all.indexOf(a) - all.indexOf(b)),
    loadingPlatforms: loading,
    failedPlatforms: failed,
    settled: loading.length === 0,
    channels: included.length > 0 ? included.reduce((acc, p) => acc + (platforms[p].channels ?? 0), 0) : null,
    followers: followers.value,
    followersReported: included.reduce((acc, p) => acc + (platforms[p].followersReported ?? 0), 0),
    followersTotal: included.reduce((acc, p) => acc + (platforms[p].followersTotal ?? 0), 0),
    followersPlatforms: followers.from,
    followerDelta: followerDelta.value,
    followerDeltaChannels: included.reduce((acc, p) => acc + (platforms[p].followerDeltaChannels ?? 0), 0),
    followerDeltaPlatforms: followerDelta.from,
    followerDeltaSuppressed: included.reduce((acc, p) => acc + (platforms[p].followerDeltaSuppressed ?? 0), 0),
    followerDeltaExcluded: included.reduce((acc, p) => acc + (platforms[p].followerDeltaExcluded ?? 0), 0),
    uncertainty,
    uncertaintyPlatforms: included.filter((p) => platforms[p].uncertainty > 0),
    followerDeltaApprox: approx(followerDelta.value, uncertainty),
    views: views.value,
    viewsChannels: included.reduce((acc, p) => acc + (platforms[p].viewsPublished ? (platforms[p].viewsChannels ?? 0) : 0), 0),
    viewsPlatforms: views.from,
    // A platform with no channels has nothing to be pending — naming it would read as a gap.
    viewsPendingPlatforms: included.filter((p) =>
      !isMetaPlatform(p) && platforms[p].viewsPublished && platforms[p].views === null && (platforms[p].channels ?? 0) > 0),
    viewsUnreportedPlatforms: included.filter((p) =>
      isMetaPlatform(p) && platforms[p].views === null && (platforms[p].channels ?? 0) > 0),
    viewsUnpublishedPlatforms: included.filter((p) => !platforms[p].viewsPublished),
  };

  return { periodDays, platforms, combined, channels };
}

// ─── Display rules ───────────────────────────────────────────────────────────────
//
// Pure, so the API suite can lock them: apps/internal has no test runner, which is how the
// first build shipped a board figure inside its own error bar, a "not enough history"
// over a rounding absence, and "0 channels" over sources that never loaded.

/**
 * Why a follower change cannot be shown. Each is a different absence and the copy must
 * name the right one: "not enough history" over a ROUNDING absence blames collection lag
 * for the platform's rounding — fixed once already on the YouTube board (954c253).
 */
export type GrowthChangeAbsence = "not-loaded" | "no-channels" | "below-step" | "excluded" | "no-history";

/**
 * How a follower change may be shown.
 *   value      — a measured figure. `approx` (the COMBINED figure only, plan decision 3) =
 *                it sits inside the summed rounding error bar: shown with "≈", ± leading.
 *   unresolved — a YouTube/Snapchat board's change smaller than its OWN error bar.
 *                ⚠️ NO NUMBER. The board's own tab prints the limit instead (PR #166,
 *                ChangeLine), and the server's contract says to: "Render the value only when
 *                |followerDelta| >= followerDeltaUncertainty". "≈ +1.5k" beside ±186.3k would
 *                state a figure the board says it cannot resolve, and disagree with its tab.
 *   absent     — nothing to show, and why.
 */
export type GrowthChangeView =
  | { kind: "value"; value: number; approx: boolean }
  | { kind: "unresolved"; uncertainty: number }
  | { kind: "absent"; reason: GrowthChangeAbsence };

function changeAbsence(channels: number | null, suppressed: number | null, excluded: number | null): GrowthChangeAbsence {
  if ((channels ?? 0) === 0) return "no-channels";
  if ((suppressed ?? 0) > 0) return "below-step";
  if ((excluded ?? 0) > 0) return "excluded";
  return "no-history";
}

/** One platform's change, gated exactly as that platform's own tab gates it. */
export function growthPlatformChangeView(a: GrowthPlatformAggregate): GrowthChangeView {
  if (a.state !== "ready") return { kind: "absent", reason: "not-loaded" };
  const v = a.followerDelta;
  if (v === null) return { kind: "absent", reason: changeAbsence(a.channels, a.followerDeltaSuppressed, a.followerDeltaExcluded) };
  // Meta's uncertainty is 0 (exact counts), so only the boards can be gated here.
  if (a.uncertainty > 0 && Math.abs(v) < a.uncertainty) return { kind: "unresolved", uncertainty: a.uncertainty };
  return { kind: "value", value: v, approx: false };
}

/**
 * The combined change. Not settled = not loaded: a sum that moves as each request lands
 * reads as data changing.
 */
export function growthCombinedChangeView(c: GrowthCombined): GrowthChangeView {
  if (!c.settled || c.includedPlatforms.length === 0) return { kind: "absent", reason: "not-loaded" };
  if (c.followerDelta === null) return { kind: "absent", reason: changeAbsence(c.channels, c.followerDeltaSuppressed, c.followerDeltaExcluded) };
  return { kind: "value", value: c.followerDelta, approx: c.followerDeltaApprox };
}

/**
 * The 90% full-span rule in words: "the 7 days" (7 of 7), "at least 26 of the 28 days".
 * "No channel has 28 days of history" misstates a rule that admits 26.
 */
export function growthHistoryRequirement(periodDays: number): string {
  const min = growthFullSpanMin(periodDays);
  return min >= periodDays ? `the ${periodDays} days` : `at least ${min} of the ${periodDays} days`;
}

/** What a platform's "Period covered" says. One implementation, for the table and the phone list. */
export interface GrowthPeriodText {
  /** The follower change's dates, or null — then `changeWhy` says why (null too with no channels). */
  change: string | null;
  changeWhy: string | null;
  /** The views figure's dates, or null — then `viewsWhy` says why. */
  views: string | null;
  viewsWhy: string | null;
  /** Whose calendar those dates are on. */
  calendar: string;
}

/**
 * The exact dates a platform's two period figures cover, in words.
 *
 * ⚠️ Meta's follower change is NOT dated by its views window. It runs from our API follower
 * snapshots (IST dates) to each channel's current count — Facebook's re-read every sync,
 * Instagram's only when the channels are refreshed — so it gets its own line, never the
 * window's dates. Printing "2 Sep – 29 Sep" over it was the first build's mistake.
 */
export function growthPeriodText(a: GrowthPlatformAggregate, currentYear: number): GrowthPeriodText {
  const isMeta = isMetaPlatform(a.platform);
  const acc = a.followerDeltaAccounting ?? 0;
  const allAccounting = acc > 0 && acc === (a.followerDeltaChannels ?? 0);
  const calendar =
    a.platform === "facebook"
      ? "views on Pacific days · change from our API follower snapshots (IST dates)"
      : a.platform === "instagram"
        ? allAccounting
          ? "UTC days · change is Meta's follows − unfollows for the same window"
          : `views on UTC days · change from our API follower snapshots (IST dates)` +
            (acc > 0 ? `; ${acc} by Meta's follows − unfollows for the views window` : "")
        : "our daily snapshots, IST dates";
  if (a.state !== "ready" || (a.channels ?? 0) === 0) {
    return { change: null, changeWhy: null, views: null, viewsWhy: null, calendar };
  }

  let views: string | null = null;
  let viewsWhy: string | null = null;
  if (!a.viewsPublished) {
    viewsWhy = "not published";
  } else if (isMeta) {
    // Channels part-way between two windows: say so, never print one window over both.
    if (a.spanEnds && a.spanEnds.from !== a.spanEnds.to) {
      views = `${a.periodDays}-day windows ending ${fmtGrowthSpan(a.spanEnds, currentYear)}`;
    } else if (a.span) {
      views = fmtGrowthSpan(a.span, currentYear);
    } else {
      viewsWhy = "no completed window published yet";
    }
  } else if (a.viewsSpan) {
    views = fmtGrowthSpan(a.viewsSpan, currentYear, " → ");
  } else {
    viewsWhy = "not enough view history yet";
  }

  let change: string | null = null;
  let changeWhy: string | null = null;
  const view = growthPlatformChangeView(a);
  if (view.kind === "absent") {
    changeWhy =
      view.reason === "below-step" ? "measured, but every channel moved less than the rounding step"
      : view.reason === "excluded" ? "every full-period change was left out as unreliable"
      : view.reason === "no-history"
        ? isMeta
          ? `no API history covers ${growthHistoryRequirement(a.periodDays)} yet`
          : `not enough history yet${a.historyFrom ? ` · collecting since ${fmtGrowthDay(a.historyFrom, currentYear)}` : ""}`
        : null;
  } else if (a.changeSince && a.changeUntil) {
    // Boards' snapshot pairs read "→"; Meta's accounting window reads "–", like its views.
    change = fmtGrowthSpan({ from: a.changeSince, to: a.changeUntil }, currentYear, isMeta ? " – " : " → ");
  } else if (a.changeSince && isMeta) {
    change = `${fmtGrowthDay(a.changeSince, currentYear)} → ${a.platform === "instagram" ? "last channel refresh" : "latest sync"}`;
  } else {
    // A contributor did not say where its change starts (an older response): no guess.
    changeWhy = "start date not reported";
  }

  return { change, changeWhy, views, viewsWhy, calendar };
}

/** A source that failed to load, worded for the screen. */
export interface GrowthSourceProblem {
  source: GrowthSource;
  /** The platforms it takes out of every total (both of Meta's for "meta"). */
  platforms: GrowthPlatform[];
  kind: GrowthErrorKind;
  /**
   * Calm, honest words. ⚠️ NEVER the raw API text for "busy" or "failed": those are exactly
   * the phrases the owner banned ("Too many requests…", "An unexpected error occurred", a
   * JSON parser's "Unexpected token '<'"). A "mismatch" is this module's own sentence.
   */
  text: string;
}

/** One entry per source that failed, in platform order. Empty when every source answered. */
export function growthSourceProblems(combo: GrowthCombination): GrowthSourceProblem[] {
  const out: GrowthSourceProblem[] = [];
  for (const source of ["meta", "youtube", "snapchat"] as const) {
    const ps = GROWTH_PLATFORMS.filter((p) => GROWTH_SOURCE_OF[p] === source);
    const a = combo.platforms[ps[0]];
    if (a.state !== "error") continue;
    const kind: GrowthErrorKind = a.errorKind ?? "failed";
    const names = growthListNames(ps);
    const they = ps.length > 1 ? "they are" : "it is";
    const text =
      kind === "forbidden" ? "Only administrators can see Account Growth."
      : kind === "mismatch" ? (a.error ?? `${names} answered for a different period than asked. Reload the page.`)
      : kind === "busy"
        ? `${names} asked us to slow down for a moment, so ${they} left out of every total rather than counted as zero. Wait a minute, then retry.`
        : `${names} couldn't be loaded just now, so ${they} left out of every total rather than counted as zero. ` +
          `${ps.length > 1 ? "Their" : "Its"} channels and history are safe — this is a loading problem, not a data problem.`;
    out.push({ source, platforms: ps, kind, text });
  }
  return out;
}

/**
 * The channel table's counter.
 *
 * ⚠️ Only a LOADED response may claim a count. "0 channels" over sources that are still
 * loading or failed reads as an empty estate — the first build printed exactly that during
 * an outage and for a failed platform's chip.
 */
export function growthTableCountLabel(
  combo: GrowthCombination,
  opts: { shown: number; platform: GrowthPlatform | "all" },
): string {
  const { shown, platform } = opts;
  const total = combo.channels.length;
  const counted = `${shown} channel${shown === 1 ? "" : "s"}${shown !== total ? ` of ${total}` : ""}`;
  const soFar = combo.combined.settled ? "" : " so far";
  if (platform !== "all") {
    const st = combo.platforms[platform].state;
    const label = GROWTH_PLATFORM_LABEL[platform];
    if (st === "loading") return `Loading ${label}…`;
    if (st === "error") return `${label} couldn't load`;
    return `${counted}${soFar}`;
  }
  if (combo.combined.includedPlatforms.length === 0) return combo.combined.settled ? "none loaded" : "Loading…";
  return `${counted}${soFar}`;
}

/** What an empty channel table says — and whether it is reporting a failure. */
export function growthTableEmpty(
  combo: GrowthCombination,
  opts: { platform: GrowthPlatform | "all"; searching: boolean },
): { text: string; error: boolean } {
  const c = combo.combined;
  if (opts.platform !== "all") {
    const label = GROWTH_PLATFORM_LABEL[opts.platform];
    const st = combo.platforms[opts.platform].state;
    if (st === "loading") return { text: `Loading ${label} channels…`, error: false };
    if (st === "error") return { text: `${label} couldn't be loaded — see the note above.`, error: true };
    return { text: opts.searching ? "No channels match that search." : `No ${label} channels on this board.`, error: false };
  }
  if (combo.channels.length > 0) return { text: "No channels match that search.", error: false };
  if (c.loadingPlatforms.length > 0) return { text: "Loading channels…", error: false };
  if (c.includedPlatforms.length === 0) {
    return { text: "No board could be loaded, so there are no channels to list — see the note above.", error: true };
  }
  // ⚠️ Some boards loaded EMPTY while others failed: an empty list is not "no channels".
  if (c.failedPlatforms.length > 0) {
    return {
      text: `No ${growthListNames(c.includedPlatforms, "or")} channels to list, and ` +
        `${growthListNames(c.failedPlatforms)} couldn't load — see the note above.`,
      error: true,
    };
  }
  return { text: "No channels tracked yet — add them on each platform's tab.", error: false };
}

/**
 * What kind of failure a channel's own last refresh had (its stored metricsError).
 *
 *   access    — the platform no longer lets the connected account read it (Meta (#10),
 *               admin/2FA requirements, an expired session).
 *   gone      — the platform no longer finds it (renamed, deleted, a 404 handle).
 *   temporary — a transient fault the next scheduled sync retries (Meta's (#2) "unexpected
 *               error", rate limits, timeouts, a stripped page).
 *   other     — anything unrecognised.
 */
export type GrowthRefreshFailure = "access" | "gone" | "temporary" | "other";

export function growthRefreshFailureKind(message: string | null | undefined): GrowthRefreshFailure {
  const m = message ?? "";
  if (/permission|administrator|moderator|two.?factor|access token|session has|\(#(10|190|200)\)/i.test(m)) return "access";
  if (/renamed|deleted|terminated|does not exist|not found|\b404\b|identity mismatch|no channel for this handle|unsupported get request/i.test(m)) return "gone";
  if (
    /unexpected error|retry|try again|temporar|timed? ?out|abort|rate.?limit|too many|request limit|fetch failed|network|\bHTTP 5\d\d\b|\(#(1|2|4|17|32|341|613)\)|page too small|__NEXT_DATA__|no spotlight content/i.test(m)
  ) return "temporary";
  return "other";
}

/**
 * The tooltip for a channel whose latest refresh failed.
 *
 * ⚠️ Worded by kind and NEVER quoting the platform's reply: about 1% of Meta's calls fail
 * with "(#2) An unexpected error has occurred. Please retry your request later." — a phrase
 * the owner banned from the screen. The channel's own tab is where the raw reply lives.
 */
export function growthRefreshFailureText(message: string | null | undefined, platform: GrowthPlatform): string {
  const tab = GROWTH_PLATFORM_TAB[platform];
  const lead = "This channel's most recent refresh failed, so the figures shown are from its last successful one.";
  switch (growthRefreshFailureKind(message)) {
    case "access":
      return `${lead} The platform no longer lets the connected account read it — usually lost admin access, which someone has to restore. The ${tab} tab has the details.`;
    case "gone":
      return `${lead} The platform no longer finds this channel — it may have been renamed or removed. The ${tab} tab has the details.`;
    case "temporary":
      return `${lead} The platform had a temporary problem; the next scheduled sync tries again on its own.`;
    default:
      return `${lead} The ${tab} tab shows the platform's own reply.`;
  }
}

// ─── Table helpers ───────────────────────────────────────────────────────────────

export type GrowthChannelSortKey = "name" | "platform" | "followers" | "change" | "views";

/**
 * The value a column sorts by. ⚠️ null for anything that must not RANK: an unreliable
 * change (a series that jumped between two channels — the largest "gain" on a board is
 * usually one of these) and Snapchat's views (not published). The table's compareCells
 * sorts nulls last in both directions.
 */
export function growthChannelSortValue(row: GrowthChannelRow, key: GrowthChannelSortKey): number | string | null {
  switch (key) {
    case "name": return row.name;
    case "platform": return GROWTH_PLATFORM_LABEL[row.platform];
    case "followers": return row.followers;
    case "change": return row.followerDeltaUnreliable ? null : row.followerDelta;
    case "views": return row.viewsPublished ? row.views : null;
  }
}

/**
 * Client-side search and platform filter for the channel TABLE.
 *
 * ⚠️ Never sent to the server: the Meta endpoint's `q` is a server filter that also
 * narrows its totals (and costs a request per keystroke), while the All tab's totals cover
 * every channel. A leading "@" is ignored so a pasted handle still matches.
 */
export function filterGrowthChannels(
  rows: GrowthChannelRow[],
  opts: { q?: string | null; platform?: GrowthPlatform | "all" | null },
): GrowthChannelRow[] {
  const needle = (opts.q ?? "").trim().replace(/^@+/, "").trim().toLowerCase();
  const platform = opts.platform && opts.platform !== "all" ? opts.platform : null;
  return rows.filter((r) =>
    (platform === null || r.platform === platform) &&
    (needle === "" || r.name.toLowerCase().includes(needle) || (r.handle ?? "").toLowerCase().includes(needle)));
}

// ─── Dates ───────────────────────────────────────────────────────────────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A day key as "3 Sep", or "30 Sep 2025" outside `currentYear`.
 *
 * ⚠️ Built from the key's own digits — never `toLocaleDateString`, which would let the
 * browser's locale reorder or translate it, and never a local-time Date, which shifts a
 * day west of UTC. The All tab's dates are the owner's explicit requirement.
 */
export function fmtGrowthDay(key: string | null | undefined, currentYear: number): string {
  if (!isGapDayKey(key)) return "—";
  const [y, m, d] = key.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]}${y === currentYear ? "" : ` ${y}`}`;
}

/** A span as "2 Sep – 29 Sep" (each side gets its year when it is not the current one). */
export function fmtGrowthSpan(span: GrowthSpan | null | undefined, currentYear: number, separator = " – "): string {
  if (!span) return "—";
  if (span.from === span.to) return fmtGrowthDay(span.from, currentYear);
  return `${fmtGrowthDay(span.from, currentYear)}${separator}${fmtGrowthDay(span.to, currentYear)}`;
}

/** IST is a fixed UTC+5:30 — no daylight saving. */
const IST_OFFSET_MS = 330 * 60_000;

/**
 * An instant as an IST wall-clock time, "12:30 PM".
 *
 * Used for Facebook's day boundary, which is Pacific midnight and so MOVES in IST with
 * Pacific daylight saving (12:30 PM in summer, 1:30 PM in winter). Formatting the server's
 * `dayStarts.facebook` instant states the real boundary instead of hard-coding one.
 */
export function fmtGrowthIstClock(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const ist = new Date(ms + IST_OFFSET_MS);
  const h = ist.getUTCHours();
  const m = ist.getUTCMinutes();
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}
