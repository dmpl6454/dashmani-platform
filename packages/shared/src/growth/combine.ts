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
  /** ± error bar on followerDelta from rounded counts. 0 = exact (Meta). */
  uncertainty: number;
  /** |followerDelta| < uncertainty: show it as approximate, with the ± beside it. */
  followerDeltaApprox: boolean;
  views: number | null;
  viewsChannels: number | null;
  /** false = the platform publishes no period view count at all (Snapchat). */
  viewsPublished: boolean;
  /**
   * The dates this platform's period figures are anchored to.
   *   Meta: its native window — the last covered day back period−1 days (also the window
   *         its follower-change rule is measured against).
   *   YouTube/Snapchat: the IST snapshot dates its follower change covers.
   * null when there is nothing dated to state (not loaded, or no contributor yet).
   */
  span: GrowthSpan | null;
  /**
   * The dates the views figure covers — separate because YouTube's view counter has a
   * shorter stored history than its subscriber count. Meta: the window. Snapchat: null.
   */
  viewsSpan: GrowthSpan | null;
  spanKind: GrowthSpanKind;
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
  /** Summed rounding error bars of the loaded boards (Meta adds none). */
  uncertainty: number;
  followerDeltaApprox: boolean;
  views: number | null;
  viewsChannels: number;
  viewsPlatforms: GrowthPlatform[];
  /** Loaded platforms WITH channels that publish views but have no figure for this period yet. */
  viewsPendingPlatforms: GrowthPlatform[];
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
    viewsSpan: null,
    spanKind: SPAN_KIND[platform],
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
  let followers = 0, followersReported = 0;
  let views = 0, viewsChannels = 0;
  let delta = 0, deltaChannels = 0;
  let stale = 0;
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
    if (d !== null && days !== null && days >= minDays) { delta += d; deltaChannels++; }
    if (i.metricsError) stale++;
  }

  // ⚠️ The window is the platform's OWN last covered day back period−1 days. Facebook and
  // Instagram close on different boundaries, so one shared end date would mislabel one.
  const end = src.dataThroughDayByPlatform?.[platform] ?? null;
  const span = isGapDayKey(end) ? { from: gapShiftDay(end, -(periodDays - 1)), to: end } : null;
  const followerDelta = deltaChannels > 0 ? delta : null;

  return {
    platform,
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
    viewsSpan: span,
    spanKind: SPAN_KIND[platform],
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

  return {
    platform,
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
    span: validSpan(t.followerDeltaSpan),
    viewsSpan: isYouTube ? validSpan(t.viewsDeltaSpan) : null,
    spanKind: "ist-snapshot",
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
    uncertainty,
    followerDeltaApprox: approx(followerDelta.value, uncertainty),
    views: views.value,
    viewsChannels: included.reduce((acc, p) => acc + (platforms[p].viewsPublished ? (platforms[p].viewsChannels ?? 0) : 0), 0),
    viewsPlatforms: views.from,
    // A platform with no channels has nothing to be pending — naming it would read as a gap.
    viewsPendingPlatforms: included.filter((p) =>
      platforms[p].viewsPublished && platforms[p].views === null && (platforms[p].channels ?? 0) > 0),
    viewsUnpublishedPlatforms: included.filter((p) => !platforms[p].viewsPublished),
  };

  return { periodDays, platforms, combined, channels };
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
