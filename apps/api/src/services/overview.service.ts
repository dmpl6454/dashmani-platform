/**
 * Overview — the single aggregated payload behind the internal portal's
 * `/overview` command centre.
 *
 * Every figure here is REAL platform data, composed from the same sources the
 * Account Growth page already trusts (Meta channel metrics, stored daily rows,
 * follower snapshots, IG audience demographics, harvested captions). Where the
 * design this page implements showed illustrative numbers, the corresponding
 * widget is wired to the closest genuine dataset, and where nothing genuine
 * exists the value is NULL — rendered as a dash — never a fabricated zero.
 *
 * Cost discipline: one bounded query per widget (the meta_asset* tables hold one
 * row per channel or per channel-day, hundreds to low tens of thousands of rows),
 * and the whole payload is memoised for 60 s with single-flight so a dashboard
 * burst from several admins costs one computation, not one per tab.
 */

import { prisma } from "@dashmani/db";
import { resolveDuplicateAssetIds, resolveContestedOwners } from "./meta-oauth/meta-channels.service";
import {
  getRangeTotals,
  getRangeFollowerDeltas,
  previousRange,
  rangeDayCount,
  shiftDay,
  resolveClosedEnd,
  type AssetRangeTotals,
} from "./meta-oauth/meta-range.service";
import * as analyticsService from "./analytics.service";
import { thumbnailIfFresh } from "./top-posts.service";

export const OVERVIEW_PERIODS = [7, 14, 30, 90] as const;

/**
 * The window the page lands on when nothing else is chosen (owner decision,
 * 2026-09-19 — it was 7).
 *
 * ⚠️ IT COSTS NOTHING, and that was measured on prod rather than assumed: a cold build
 * is 922ms at 30 days against 1,325ms at 7, the payload is 186KB against 180KB, and 90
 * days — already a shipped option — is 1,064ms. A wider default cannot introduce a cost
 * this endpoint does not already serve on demand.
 *
 * ⚠️ 30 is also the only OTHER value that carries Total Reach. Reach counts UNIQUE
 * people, so it exists only for Meta's own native windows: 7 maps to `week` and 30 to
 * `days_28`, while 14 and 90 have no such figure and correctly render a dash. Moving
 * the default 7 -> 30 therefore keeps reach populated; 7 -> 14 would have silently
 * emptied that KPI.
 *
 * ⚠️ KNOWN AND INTENDED CONSEQUENCE: Audience Growth and the Followers delta count only
 * channels whose snapshot history spans the WHOLE window, and API follower history
 * began in late August — so those two figures cover 43 of 180 linked channels at 30
 * days where they covered 148 at 7 (measured on prod the day this shipped). The numbers
 * stay correct and the existing "N of M" / `*` disclosures already say so; coverage
 * climbs on its own as snapshots accumulate. Do NOT "fix" it by detaching those cards
 * from the global default — that would break the precedence contract on WIDGET_PERIODS.
 *
 * ⚠️ This constant has TWO counterparts in the frontend (the useState literal and the
 * localStorage fallback in overview/page.tsx). All three must agree or the first paint
 * fetches one window and immediately refetches another.
 */
export const DEFAULT_OVERVIEW_PERIOD = 30 as const satisfies (typeof OVERVIEW_PERIODS)[number];
/**
 * Per-card periods offer the SAME set as the global one, plus 0.
 *
 * ⚠️ PRECEDENCE, and it is the whole contract: the global period is the default for
 * every card, and a card's own period OVERRIDES it FOR THAT CARD ONLY. `0` means
 * "follow the global", which is the default for all of them — so moving the global
 * dropdown moves every card that has not been explicitly detached, and a detached
 * card keeps its own window until it is reset. The payload echoes both the effective
 * period and whether it was overridden, so the UI labels each card from the SERVER's
 * answer and can never show one period's number under another period's label.
 */
export const WIDGET_PERIODS = [0, 7, 14, 30, 90] as const;
export type OverviewPeriod = (typeof OVERVIEW_PERIODS)[number];
export type WidgetPeriod = (typeof WIDGET_PERIODS)[number];

/**
 * Longest custom range we will serve.
 *
 * ⚠️ NOT a database limit — the GROUP BY over meta_asset_daily is cheap at any span. The
 * binding cost is that every series carries ONE POINT PER DAY (audience, revenue, traction
 * and four KPI sparklines), and the traction baseline doubles the scanned span via
 * previousRange. A two-year range would ship ~730-element arrays per series in a payload
 * that is polled every 60s. A year is more than any real question needs here.
 */
export const MAX_RANGE_DAYS = 366;

export interface OverviewParams {
  days: OverviewPeriod;
  /**
   * An explicit inclusive [start, end] window that OVERRIDES `days`.
   *
   * ⚠️ OPTIONAL, deliberately. `apps/api/tsconfig.json` excludes tests and vitest strips
   * types, so a newly REQUIRED field on this interface would be caught by nothing — not
   * the typecheck, not CI. Every existing caller keeps working unchanged.
   */
  range?: { start: string; end: string } | null;
  /** 0 = follow the global window (whether that is `days` or `range`). Same for the three below. */
  audDays: WidgetPeriod;
  revDays: WidgetPeriod;
  vbcDays: WidgetPeriod;
  tracDays: WidgetPeriod;
}

/** The effective window of one card, and whether it was detached from the global. */
export interface WidgetPeriodInfo {
  days: number;
  overridden: boolean;
  start: string;
  end: string;
}

export interface Trend {
  pct: number;
  /** False when the baseline is too incomplete to compare against honestly. */
  reliable: boolean;
}

export interface PeriodMetric {
  value: number | null;
  previous: number | null;
  trend: Trend | null;
  contributing: number;
  spark: number[];
}

export interface OverviewPayload {
  generatedAt: string;
  period: {
    /** Length of the effective window in days — derived, so a custom range reports its own span. */
    days: number;
    start: string;
    end: string;
    prevStart: string;
    prevEnd: string;
    dataThroughDay: string | null;
    /** True when this window came from an explicit start/end rather than a preset. */
    custom: boolean;
    /** The last closed day, when the requested end was later than it. Null otherwise. */
    clampedTo: string | null;
  };
  channels: {
    total: number;
    facebook: number;
    instagram: number;
    /** Channels whose stored history covers EVERY day of the window (coveredDays === span). */
    complete: number;
    /** Channels whose latest window fetch carries a Meta error (their figures still count). */
    errored: number;
  };
  /** Every live channel, followers-desc — the header search searches this, not the ranked lists. */
  allChannels: ChannelDirectoryRow[];
  kpis: {
    followers: {
      value: number;
      delta: number | null;
      deltaDays: number | null;
      channelsWithHistory: number;
      /** Follower stock of just those channels — the like-for-like denominator. */
      followersWithHistory: number | null;
      spark: number[];
    };
    views: PeriodMetric;
    engagements: PeriodMetric;
    /**
     * `contributing` = Pages that reported an earnings figure (includes exact zeros);
     * `earning` = Pages whose earnings were actually above zero. See earningChannels.
     */
    revenue: PeriodMetric & { earning: number };
    reach: { value: number | null; window: "week" | "days_28" | null; contributing: number };
  };
  audience: {
    days: number;
    series: Array<{ date: string; followers: number }>;
    channelsUsed: number;
    channelsLinked: number;
    delta: number | null;
  };
  revenue: {
    days: number;
    series: Array<{ date: string; cents: number | null; cumulativeCents: number }>;
    totalCents: number | null;
    previousCents: number | null;
    trend: Trend | null;
  };
  viewsByChannel: Array<{ id: string | null; name: string; platform: "facebook" | "instagram" | null; views: number; share: number }>;
  /** Every channel over the Views-by-Channel window, for the expanded view. */
  viewsByChannelAll: Array<{ id: string; name: string; platform: "facebook" | "instagram"; views: number; share: number }>;
  /** Effective period of that card (equals period.days unless detached). */
  viewsByChannelDays: number;
  /**
   * Total views over the Views-by-Channel card's OWN window.
   *
   * ⚠️ The donut centre must render THIS, never kpis.views.value. The card can be
   * detached from the global period, and the KPI is always the global one — at
   * days=7&vbc=90 on prod the centre read 3,034,644,872 while its own slices summed to
   * 37,154,832,135, a 12x mismatch presented as that donut's total.
   */
  viewsByChannelTotal: number;
  topChannels: ChannelRow[];
  /**
   * The same ranking restricted to one platform.
   *
   * ⚠️ These cost ZERO extra queries — they are further slices of the `byViews` array
   * that already produced `topChannels`. Do not be tempted to add a platform QUERY
   * PARAM instead: that would put a new dimension in this endpoint's 60-entry cache
   * key, which already carries five periods plus a custom range, and thrash it.
   */
  topChannelsInstagram: ChannelRow[];
  topChannelsFacebook: ChannelRow[];
  revenueByChannel: ChannelRow[];
  cities: {
    total: number;
    indiaShare: number;
    assets: number;
    items: Array<{ name: string; state: string | null; value: number; share: number; tier: CityTier }>;
  };
  latestPosts: Array<{
    id: string;
    title: string;
    permalink: string | null;
    postedAt: string;
    views: number | null;
    likes: number | null;
    comments: number | null;
    mediaProductType: string | null;
    /**
     * Meta CDN preview, and NULL unless its own signed expiry is still in the future —
     * see thumbnailIfFresh. Serving a rotted URL would put a broken image on the card,
     * which reads as a defect; serving nothing renders the designed placeholder.
     */
    thumbnailUrl: string | null;
    channel: { name: string; username: string | null; platform: "facebook" | "instagram"; pictureUrl: string | null };
  }>;
  /**
   * Real-time Activity feed. Every stream is bounded to ACTIVITY_WINDOW_DAYS.
   *
   * `postId` opens the same post drawer the Latest Posts card opens; `href` is an
   * in-portal route. Exactly one of the two is set per item, and both are nullable so a
   * future stream can be inert without widening the type.
   */
  activity: Array<{ kind: ActivityKind; text: string; at: string; postId: string | null; href: string | null }>;
  traction: {
    /** Effective period of this card (equals period.days unless detached). */
    days: number;
    start: string;
    end: string;
    prevStart: string;
    prevEnd: string;
    tiles: Array<{ key: TractionKey; label: string; value: number | null; previous: number | null; pct: number | null }>;
    series: Array<{ date: string; views: number | null; engagements: number | null; reactions: number | null; shares: number | null }>;
  };
  demographics: {
    assets: number;
    age: Array<{ bucket: string; value: number }>;
    gender: Array<{ bucket: string; label: string; value: number }>;
    country: Array<{ bucket: string; value: number }>;
  };
  trending: Array<{
    id: string; name: string; type: string; count: number; previousCount: number;
    /** Share of this week's / last week's harvested captions (null when the half is empty). */
    share: number | null; previousShare: number | null;
    /** Change in SHARE, week over week — null when there is no prior share to compare against. */
    changePct: number | null;
    /** The entity row itself was created inside the current window. */
    firstSeenThisWeek: boolean;
  }>;
  /** Denominators for the trending shares — how much was harvested in each half. */
  trendingWindow: { captionsThisWeek: number; captionsLastWeek: number };
  pending: {
    approvals: number;
    employees: number;
    leave: number;
    documents: number;
    linksToday: number;
    submittedToday: number;
  } | null;
}

export interface ChannelRow {
  id: string;
  /** Meta's own id — a Facebook Page's public URL is facebook.com/<metaId>; Instagram links by username. */
  metaId: string;
  name: string;
  username: string | null;
  platform: "facebook" | "instagram";
  pictureUrl: string | null;
  followers: number | null;
  views: number | null;
  earningsCents: number | null;
  followerDelta: number | null;
  followerDeltaDays: number | null;
}

/**
 * A directory row: everything the header search and the channel drawer read, and
 * nothing else.
 *
 * ⚠️ pictureUrl is deliberately OMITTED. It is a Meta CDN URL averaging 397 characters
 * (max 417) and populated on 102 of the 419 live prod channels — carrying it for all
 * 419 would add ~40 KB to every payload for a field neither the search list nor the
 * drawer renders. The ranked lists (topChannels / revenueByChannel) still carry it,
 * because those DO show avatars.
 */
export type ChannelDirectoryRow = Omit<ChannelRow, "pictureUrl">;

export type CityTier = "high" | "growing" | "emerging";
/**
 * ⚠️ "leave" IS DELIBERATELY ABSENT. A named person's leave type/status is
 * health-adjacent and this payload is served to every internal user (71 of 74 hold only
 * the Employee role, which has no `leave` permission). Removing it from the union makes
 * re-adding the stream a compile error rather than a quiet privacy regression.
 */
export type ActivityKind = "post" | "report" | "user" | "announcement";
export type TractionKey = "views" | "engagements" | "reactions" | "shares";

// ───────────────────────────── pure helpers ─────────────────────────────

export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function pctChange(current: number | null, previous: number | null): number | null {
  if (current == null || previous == null || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

/** Baseline is trustworthy only when its own days are complete AND it covers roughly the same channels. */
export function trendFrom(
  current: number | null,
  previous: { value: number | null; coverageShare: number; assets: number } | null,
  contributing: number,
): Trend | null {
  if (!previous) return null;
  const pct = pctChange(current, previous.value);
  if (pct == null) return null;
  const reliable = previous.coverageShare >= 0.95 && previous.assets >= Math.floor(contributing * 0.9);
  return { pct, reliable };
}

/** Meta labels Instagram audience cities as "City, State". Indian Punjab arrives as "Punjab region"; bare "Punjab" is Pakistan. */
const INDIAN_STATES = new Set([
  "andhra pradesh", "arunachal pradesh", "assam", "bihar", "chhattisgarh", "goa", "gujarat", "haryana",
  "himachal pradesh", "jharkhand", "karnataka", "kerala", "madhya pradesh", "maharashtra", "manipur",
  "meghalaya", "mizoram", "nagaland", "odisha", "orissa", "punjab region", "rajasthan", "sikkim", "tamil nadu",
  "telangana", "tripura", "uttar pradesh", "uttarakhand", "west bengal", "delhi", "national capital territory of delhi",
  "chandigarh", "puducherry", "pondicherry", "jammu and kashmir", "ladakh", "andaman and nicobar islands",
  "lakshadweep", "dadra and nagar haveli", "daman and diu", "dadra and nagar haveli and daman and diu",
]);

const CITY_ALIASES: Record<string, string> = {
  bangalore: "Bengaluru",
  gauhati: "Guwahati",
  "dehra dun": "Dehradun",
  "meerut city": "Meerut",
  "navi mumbai (new mumbai)": "Navi Mumbai",
  bombay: "Mumbai",
  calcutta: "Kolkata",
  madras: "Chennai",
  poona: "Pune",
  "new delhi": "Delhi",
  gurgaon: "Gurugram",
  cochin: "Kochi",
  mysore: "Mysuru",
  trivandrum: "Thiruvananthapuram",
  baroda: "Vadodara",
  allahabad: "Prayagraj",
  "hubli": "Hubballi",
  mangalore: "Mangaluru",
  belgaum: "Belagavi",
  tumkur: "Tumakuru",
  "ahmadabad": "Ahmedabad",
};

export function parseCityBucket(bucket: string): { name: string; state: string | null; india: boolean } {
  const idx = bucket.indexOf(", ");
  const rawName = (idx === -1 ? bucket : bucket.slice(0, idx)).trim();
  const state = idx === -1 ? null : bucket.slice(idx + 2).trim();
  const name = CITY_ALIASES[rawName.toLowerCase()] ?? rawName;
  const india = state !== null && INDIAN_STATES.has(state.toLowerCase());
  return { name, state, india };
}

export function tierForRank(rank: number): CityTier {
  if (rank <= 3) return "high";
  if (rank <= 7) return "growing";
  return "emerging";
}

export function genderLabel(bucket: string): string {
  switch (bucket.toUpperCase()) {
    case "F": return "Women";
    case "M": return "Men";
    case "U": return "Undisclosed";
    default: return bucket;
  }
}

/** Age buckets in the order Meta defines them, so a donut reads youngest → oldest. */
export const AGE_ORDER = ["13-17", "18-24", "25-34", "35-44", "45-54", "55-64", "65+"];

/**
 * Sum per-account follower snapshots into one daily total, forward-filling each
 * account's last known value across days it has no snapshot for.
 *
 * Only accounts whose history begins at (or one day after) the window start are
 * included: an account that first appears mid-window would otherwise make the
 * summed line jump by its whole audience on the day it joined, which reads as
 * growth that never happened. The number left out is disclosed as coverage.
 */
export function forwardFillFollowerSeries(
  rows: Array<{ accountId: string; date: string; followerCount: number }>,
  days: string[],
): { series: Array<{ date: string; followers: number }>; used: number } {
  if (days.length === 0) return { series: [], used: 0 };
  const byAccount = new Map<string, Map<string, number>>();
  for (const r of rows) {
    let m = byAccount.get(r.accountId);
    if (!m) { m = new Map(); byAccount.set(r.accountId, m); }
    m.set(r.date, r.followerCount);
  }
  const eligible: Array<Map<string, number>> = [];
  const latestStart = days[Math.min(1, days.length - 1)];
  for (const m of byAccount.values()) {
    let first: string | null = null;
    for (const d of m.keys()) if (first === null || d < first) first = d;
    if (first !== null && first <= latestStart) eligible.push(m);
  }
  const series = days.map((date) => ({ date, followers: 0 }));
  for (const m of eligible) {
    // The newest snapshot before the window seeds the fill so day 1 is never a zero.
    let last: number | null = null;
    let seedDate: string | null = null;
    for (const [d, v] of m) if (d < days[0] && (seedDate === null || d > seedDate)) { seedDate = d; last = v; }
    for (let i = 0; i < days.length; i++) {
      const v = m.get(days[i]);
      if (v != null) last = v;
      if (last != null) series[i].followers += last;
    }
  }
  return { series, used: eligible.length };
}

/** Index a series to its first usable point = 100, so four measures of different scale share one honest axis. */
export function indexSeries(values: Array<number | null>): Array<number | null> {
  const base = values.find((v) => v != null && v > 0) ?? null;
  if (base == null) return values.map(() => null);
  return values.map((v) => (v == null ? null : (v / base) * 100));
}

export function topWithOthers<T extends { name: string; value: number }>(
  items: T[],
  n: number,
): Array<{ name: string; value: number; share: number; item: T | null }> {
  const total = items.reduce((s, i) => s + i.value, 0);
  if (total <= 0) return [];
  const sorted = [...items].sort((a, b) => b.value - a.value);
  const head = sorted.slice(0, n);
  const tail = sorted.slice(n);
  const out: Array<{ name: string; value: number; share: number; item: T | null }> = head.map((i) => ({
    name: i.name, value: i.value, share: (i.value / total) * 100, item: i,
  }));
  const rest = tail.reduce((s, i) => s + i.value, 0);
  if (rest > 0) out.push({ name: "Others", value: rest, share: (rest / total) * 100, item: null });
  return out;
}

function num(v: bigint | number | null | undefined): number | null {
  if (v == null) return null;
  return typeof v === "bigint" ? Number(v) : v;
}

function dayRange(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = shiftDay(d, 1)) out.push(d);
  return out;
}

function sumNullable(values: Array<number | null>): { sum: number | null; contributing: number } {
  let sum = 0;
  let contributing = 0;
  for (const v of values) if (v != null) { sum += v; contributing++; }
  return { sum: contributing > 0 ? sum : null, contributing };
}

function firstLine(caption: string | null, max = 70): string {
  const line = (caption ?? "").split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? "";
  if (!line) return "Untitled post";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function platformOf(kind: string): "facebook" | "instagram" {
  return kind === "FACEBOOK_PAGE" ? "facebook" : "instagram";
}

// ───────────────────────────── cache ─────────────────────────────

const TTL_MS = 60_000;
const _cache = new Map<string, { expires: number; promise: Promise<OverviewPayload> }>();

export function invalidateOverviewCache(): void {
  _cache.clear();
}

/** Five independent periods mean many possible keys; keep the map from growing. */
const MAX_CACHE_ENTRIES = 60;

export function getOverview(params: OverviewParams): Promise<OverviewPayload> {
  // ⚠️ EVERY period must be in the key. Leave one out and a card detached to 90 days
  // would be served another request's 7-day payload under a 90-day label.
  // ⚠️ THE RANGE IS PART OF THE KEY. Leave it out and two materially different windows
  // collide for up to 60s — one range's numbers under another range's label.
  const r = params.range ? `${params.range.start}_${params.range.end}` : "-";
  const key = `${params.days}:${params.audDays}:${params.revDays}:${params.vbcDays}:${params.tracDays}:${r}`;
  const now = Date.now();
  const hit = _cache.get(key);
  if (hit && hit.expires > now) return hit.promise;
  if (_cache.size >= MAX_CACHE_ENTRIES) {
    for (const [k, v] of _cache) if (v.expires <= now) _cache.delete(k);
    if (_cache.size >= MAX_CACHE_ENTRIES) _cache.delete(_cache.keys().next().value as string);
  }
  const promise = buildOverview(params).catch((e) => {
    _cache.delete(key);
    throw e;
  });
  _cache.set(key, { expires: now + TTL_MS, promise });
  return promise;
}

// ───────────────────────────── builder ─────────────────────────────

/**
 * Recency bound for every Real-time Activity stream.
 *
 * ⚠️ The card is titled "Real-time Activity" and carries a pulsing "Live" badge, so a
 * row it shows must actually be recent. Before this bound the `leave` and `announcement`
 * streams were unbounded and held rows 50 and 59 days old on prod, outranked by live
 * posts rather than excluded — one quiet stretch away from presenting a seven-week-old
 * row as live. Seven days is deliberately shorter than the 30 the new-joiner stream used
 * to allow: "joined the team" a month ago is not activity either.
 */
const ACTIVITY_WINDOW_DAYS = 7;

/**
 * The newest day that is complete for the whole estate — see resolveClosedEnd in
 * meta-range.service.ts, which Account Growth's custom range now shares. The overview
 * passes NO minimum-estate floor: its end is always derived (never user-picked), and
 * its tests seed two assets and rely on the clamp firing.
 *
 * Fails open to the clock's yesterday when there is nothing to measure.
 */
async function resolveWindowEnd(liveIds: string[], todayIso: string): Promise<string> {
  return resolveClosedEnd(liveIds, shiftDay(todayIso, -1));
}

async function buildOverview(params: OverviewParams): Promise<OverviewPayload> {
  const nowMs = Date.now();
  const todayIso = isoDay(new Date(nowMs));

  const duplicateIds = await resolveDuplicateAssetIds();
  const assets = (
    await prisma.metaAsset.findMany({
      where: { disconnectedAt: null, selected: true },
      select: {
        id: true, kind: true, metaId: true, name: true, username: true, pictureUrl: true,
        followerCount: true, socialAccountId: true,
        windowMetrics: { where: { window: { in: ["week", "days_28"] } }, select: { window: true, reach: true, error: true } },
      },
    })
  ).filter((a) => !duplicateIds.has(a.id));
  const liveIds = assets.map((a) => a.id);
  const linked = assets.map((a) => a.socialAccountId).filter((x): x is string => x !== null);
  // A channel row claimed by two or more live Pages carries a follower history
  // that switches between them (the documented saw-tooth). Account Growth keeps
  // such rows out of every snapshot-derived figure, and so does this series.
  const contested = await resolveContestedOwners();
  const historyAccounts = linked.filter((id) => !contested.has(id));

  // ⚠️ The window END comes from the DATA, never from the clock. Facebook's day
  // closes at PACIFIC midnight (07:00Z) and the channel sweep is 3-hourly, so for a
  // large part of every UTC day "yesterday" holds Instagram rows only — and Facebook
  // is ~76% of the estate, ~85% of views and 100% of revenue. Ending on the clock's
  // yesterday therefore compared a 6-Facebook-day window against a complete
  // 7-Facebook-day baseline: measured on prod 2026-09-17 that rendered Views ↓14.2%
  // where the truth was ↓5.1%, and Revenue +3.1% where the truth was +22.8%.
  // resolveWindowEnd() picks the newest day both platforms have actually closed, so
  // every window below is complete-by-construction — the same principle as Account
  // Growth's dataThroughDay, which reports the EARLIEST covered boundary.
  const closedEnd = await resolveWindowEnd(liveIds, todayIso);
  // ⚠️ A CUSTOM RANGE IS CLAMPED TO THE LAST CLOSED DAY — this is the one place this
  // implementation deliberately differs from Account Growth's custom range, which accepts
  // whatever end the user picks and was measured understating a 7-day span by 7.2% because
  // Facebook had not closed the final day. Picking an end Meta has not published does not
  // give you fresher data, it gives you a partial day silently averaged into the total.
  // `rangeClampedTo` is echoed so the UI can say so rather than quietly showing less.
  const requestedEnd = params.range ? params.range.end : null;
  const end = requestedEnd ? (requestedEnd > closedEnd ? closedEnd : requestedEnd) : closedEnd;
  const rangeClampedTo = requestedEnd && requestedEnd > closedEnd ? closedEnd : null;
  const start = params.range
    ? (params.range.start > end ? end : params.range.start)
    : shiftDay(end, -(params.days - 1));
  // Every window below derives from this span, so a custom range and a preset behave
  // identically from here on.
  const spanDays = rangeDayCount(start, end);
  const prev = previousRange(start, end);
  // ⚠️ THE PRECEDENCE RULE, in one line each: 0 means follow the global period.
  // ⚠️ "Follow the global" now means "follow the global WINDOW", which may be a custom
  // range — so the fallback is spanDays, not params.days. A detached card still means
  // "its own N days ending at the same `end`", exactly as before.
  const audN = params.audDays || spanDays;
  const revN = params.revDays || spanDays;
  const vbcN = params.vbcDays || spanDays;
  const tracN = params.tracDays || spanDays;
  const longest = Math.max(spanDays, audN, revN, vbcN, tracN, 7);
  const seriesStart = shiftDay(end, -(longest - 1));
  // Daily series also need the equal-length baseline for traction/revenue trends.
  const seriesFetchStart = shiftDay(seriesStart, -longest);
  const audStart = shiftDay(end, -(audN - 1));
  // A "Live" feed must not be able to show a month-old row. Every activity stream is
  // bounded by this; it is a wall-clock recency window, NOT the Meta closed-day period,
  // because these are portal events rather than channel metrics.
  const activitySince = new Date(Date.now() - ACTIVITY_WINDOW_DAYS * 86_400_000);

  // Empty `in` lists are valid Prisma filters that simply match nothing, so every
  // query below runs unconditionally and keeps one concrete result type.
  const [rangeNow, rangePrev, followerDeltas, daily, snapshots, cityRows, ageRows, genderRows, countryRows, posts, reports, newUsers, announcements, trendingNow, captionsThisWeek, captionsLastWeek, pendingStats] =
    await Promise.all([
      getRangeTotals(start, end),
      getRangeTotals(prev.start, prev.end),
      getRangeFollowerDeltas(start, end),
      prisma.metaAssetDaily.groupBy({
        by: ["date"],
        where: { assetId: { in: liveIds }, date: { gte: new Date(`${seriesFetchStart}T00:00:00Z`), lte: new Date(`${end}T00:00:00Z`) } },
        _sum: { views: true, engagements: true, reactions: true, shares: true, earningsCents: true },
        _count: { _all: true },
        orderBy: { date: "asc" },
      }),
      prisma.accountGrowthSnapshot.findMany({
        where: {
          source: "api",
          accountId: { in: historyAccounts },
          date: { gte: new Date(`${shiftDay(audStart, -3)}T00:00:00Z`), lte: new Date(`${end}T00:00:00Z`) },
        },
        select: { accountId: true, date: true, followerCount: true },
        orderBy: { date: "asc" },
      }),
      demographicGroup(liveIds, "city"),
      demographicGroup(liveIds, "age"),
      demographicGroup(liveIds, "gender"),
      demographicGroup(liveIds, "country"),
      prisma.metaPost.findMany({
        // ⚠️ `lte: now` matters: a scheduled or clock-skewed post with a FUTURE
        // postedAt would sort to the top of a desc ordering and sit at the head of
        // "Latest" until its own timestamp passed.
        where: { assetId: { in: liveIds }, postedAt: { not: null, lte: new Date() } },
        orderBy: { postedAt: "desc" },
        // The card renders 5; the rest exist so the expanded view is real data rather
        // than a re-render of the same five rows.
        take: 24,
        select: {
          id: true, caption: true, permalink: true, postedAt: true, views: true, likes: true, comments: true,
          mediaProductType: true, thumbnailUrl: true,
          asset: { select: { name: true, username: true, kind: true, pictureUrl: true } },
        },
      }),
      // ⚠️ EVERY ACTIVITY STREAM IS BOUNDED TO ACTIVITY_WINDOW_DAYS. The `leave` and
      // `announcement` streams used to have NO date bound at all, so on prod they held
      // rows 50 and 59 days old — invisible only because live posts outranked them. A
      // quiet stretch (a weekend with no submissions plus a failed posts sync, both
      // documented occurrences) would have surfaced a 50-day-old row under a pulsing
      // "Live" badge. An empty feed renders the existing empty state, which is honest.
      prisma.dailyReport.findMany({
        where: { submittedAt: { gte: activitySince } },
        orderBy: { submittedAt: "desc" },
        take: 5,
        select: { submittedAt: true, employee: { select: { name: true } }, _count: { select: { links: true } } },
      }),
      prisma.user.findMany({
        // ⚠️ `status: "ACTIVE"` matters: without it a self-registered ONBOARDING account
        // that no admin has approved yet is announced estate-wide as "joined the team".
        where: { deletedAt: null, status: "ACTIVE", createdAt: { gte: activitySince } },
        orderBy: { createdAt: "desc" },
        take: 3,
        select: { name: true, createdAt: true },
      }),
      // ⚠️⚠️ THE `leave` STREAM IS DELIBERATELY GONE — DO NOT RE-ADD IT.
      // It rendered "<name> requested sick leave · pending", i.e. a named person's
      // health-adjacent status. That was acceptable while this page was admin-only, but
      // the gate was widened to EVERY internal user on 2026-09-17 and 71 of the 74 active
      // users hold only the Employee role, whose permissions are accounts/attendance/
      // employees/tasks — no `leave` at all. The owner's recorded decision covers exposing
      // REVENUE at that audience; there is no such decision for leave. Admins still get
      // the aggregate, non-identifying count in the notification bell and the full queue
      // at /approvals, so nothing actionable is lost. If a per-viewer feed is ever wanted,
      // note the payload is memoised on the period key alone and is shared by all
      // viewers — per-user filtering cannot be bolted on without re-keying that cache.
      prisma.announcement.findMany({
        // ⚠️ `orgUnitId: null` = company-wide only. A team-scoped announcement (1 of the
        // 4 on prod) must not be broadcast to the whole estate by this feed. Scope cannot
        // be honoured per-viewer here for the same shared-cache reason as above.
        where: { orgUnitId: null, createdAt: { gte: activitySince } },
        orderBy: { createdAt: "desc" },
        take: 2,
        select: { title: true, createdAt: true },
      }),
      prisma.linkContentEntity.groupBy({
        by: ["entityId"],
        where: { content: { status: "ok", createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) } } },
        _count: { _all: true },
        orderBy: { _count: { entityId: "desc" } },
        take: 20,
      }),
      // ⚠️ Both halves' caption totals, so the trending change can be a change in SHARE.
      // Weekly harvest throughput swings ~3x on prod (5,794 → 17,312 captions between two
      // measured weeks); an absolute count difference therefore rises and falls with how
      // much we HARVESTED, and a quiet harvest week rendered every topic as "declining".
      prisma.linkContent.count({ where: { status: "ok", createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) } } }),
      prisma.linkContent.count({
        where: { status: "ok", createdAt: { gte: new Date(Date.now() - 14 * 86_400_000), lt: new Date(Date.now() - 7 * 86_400_000) } },
      }),
      analyticsService.getOverviewStats().catch(() => null),
    ]);

  // ── KPI period metrics from stored daily rows (like-for-like with the baseline) ──
  const cur = { views: [] as Array<number | null>, engagements: [] as Array<number | null>, earnings: [] as Array<number | null> };
  const prv = { views: 0, engagements: 0, earnings: 0, coveredDays: 0, assets: 0, earningsAssets: 0, viewsAssets: 0, engAssets: 0 };
  // ⚠️ NOT the max of per-asset latestDay — that advertised Instagram's UTC-midnight
  // freshness across an estate that is ~76% Facebook, overstating how current the page
  // was. `end` is resolved from estate-wide coverage, so it IS the day every figure
  // here is complete through. Same rule as Account Growth: report the EARLIEST
  // boundary, never the newest.
  // ⚠️ NULL when the estate has reported NOTHING in the probe window. `end` is always a
  // date (resolveWindowEnd falls open to the clock's yesterday so an empty estate still
  // renders), but claiming "data complete through <yesterday>" for an estate with no
  // rows at all would be a fabricated assurance — the footer must show an em-dash.
  const dataThroughDay: string | null = daily.length > 0 ? end : null;
  const perAsset = new Map<string, AssetRangeTotals>();
  // ⚠️ "419 of 419 channels reporting" was true and still misleading: a channel counts as
  // reporting if it has ANY row in the window, so 6 channels contributing partial spans
  // (4 of them stuck on a permanent Meta permission error) read as complete. Account
  // Growth shows a per-channel coveredDays chip; the overview disclosed nothing. These
  // two counts let every KPI drawer say how many channels the span is COMPLETE for.
  let completeChannels = 0;
  let erroredChannels = 0;
  for (const a of assets) {
    const t = rangeNow.get(a.id);
    if (t) {
      perAsset.set(a.id, t);
      cur.views.push(t.views);
      cur.engagements.push(t.engagements);
      cur.earnings.push(t.earningsCents);
      if (t.coveredDays >= spanDays) completeChannels++;
    }
    if (a.windowMetrics.some((w) => w.error != null)) erroredChannels++;
    const p = rangePrev.get(a.id);
    if (p) {
      if (p.views != null) { prv.views += p.views; prv.viewsAssets++; }
      if (p.engagements != null) { prv.engagements += p.engagements; prv.engAssets++; }
      if (p.earningsCents != null) { prv.earnings += p.earningsCents; prv.earningsAssets++; }
      prv.coveredDays += p.coveredDays;
      prv.assets++;
    }
  }
  const span = rangeDayCount(start, end);
  const prevCoverage = prv.assets > 0 ? Math.min(1, prv.coveredDays / (prv.assets * span)) : 0;
  const viewsSum = sumNullable(cur.views);
  const engSum = sumNullable(cur.engagements);
  const earnSum = sumNullable(cur.earnings);
  /**
   * Channels that ACTUALLY EARNED, i.e. sum > 0 — not merely those that reported a figure.
   *
   * ⚠️ WHY BOTH NUMBERS EXIST. `earnSum.contributing` counts assets whose earnings are
   * non-null, which on prod is 317 — every Facebook Page — because a monetisation-enabled
   * Page that made nothing still reports a real 0.00. 260 of those 317 are exact zeros, so
   * the count reads 317 at 7, 14, 30 AND 90 days: a figure that never moves with the period
   * carries no information, yet it was the one shown, labelled "Pages reporting earnings",
   * which every reader compressed to "317 pages earning". Account Growth counts `> 0` for
   * the same estate and reports 57 over 14 days (meta.routes.ts ~569) — hence the mismatch
   * the owner reported. Both pages' revenue TOTALS were byte-identical throughout; only
   * this count differed, and only by definition. Keep both and label each for what it is.
   */
  const earningChannels = cur.earnings.filter((v) => v != null && v > 0).length;

  const dailyByDate = new Map(daily.map((d) => [isoDay(d.date), d]));
  const periodDays = dayRange(start, end);
  const spark = (pick: (d: (typeof daily)[number]) => number | null) =>
    periodDays.map((day) => { const d = dailyByDate.get(day); return d ? (pick(d) ?? 0) : 0; });

  const metric = (
    sum: { sum: number | null; contributing: number },
    prevValue: number,
    prevAssets: number,
    sparkValues: number[],
  ): PeriodMetric => ({
    value: sum.sum,
    previous: prevAssets > 0 ? prevValue : null,
    trend: trendFrom(sum.sum, prevAssets > 0 ? { value: prevValue, coverageShare: prevCoverage, assets: prevAssets } : null, sum.contributing),
    contributing: sum.contributing,
    spark: sparkValues,
  });

  // ── Reach: Meta's own unique count for the native window matching the period ──
  // ⚠️ A CUSTOM RANGE NEVER HAS A REACH FIGURE, regardless of its length. Meta publishes
  // unique-people reach only for its OWN trailing windows (`week`, `days_28`), anchored at
  // Meta's own boundary — not for an arbitrary span the user picked. Even a custom range
  // that happens to be exactly 7 days describes a different interval than Meta's `week`.
  // Account Growth's range mode returns reach: null for the same reason; matching it keeps
  // the two pages honest AND consistent.
  const reachWindow: "week" | "days_28" | null =
    params.range ? null : spanDays === 7 ? "week" : spanDays === 30 ? "days_28" : null;
  let reachSum = 0;
  let reachContributing = 0;
  if (reachWindow) {
    for (const a of assets) {
      const r = num(a.windowMetrics.find((w) => w.window === reachWindow)?.reach ?? null);
      if (r != null) { reachSum += r; reachContributing++; }
    }
  }

  // ── Followers (a stock) + change over the period from full-history channels ──
  let followers = 0;
  let followerDelta = 0;
  let channelsWithHistory = 0;
  // ⚠️ The follower stock of ONLY the channels that carry a full-period delta. The
  // growth chip must divide like by like: dividing a 146-channel delta by the
  // 419-channel stock understated real growth by 45% on prod (0.393% vs 0.711%).
  let followersWithHistory = 0;
  for (const a of assets) {
    followers += a.followerCount ?? 0;
    const fd = followerDeltas.get(a.id);
    if (fd && fd.days >= span - 1) { followerDelta += fd.delta; channelsWithHistory++; followersWithHistory += a.followerCount ?? 0; }
  }

  // ── Audience growth line ──
  const audDaysList = dayRange(shiftDay(end, -(audN - 1)), end);
  const filled = forwardFillFollowerSeries(
    snapshots.map((s) => ({ accountId: s.accountId, date: isoDay(s.date), followerCount: s.followerCount })),
    audDaysList,
  );
  const linkedCount = linked.length;
  const audFirst = filled.series[0]?.followers ?? null;
  const audLast = filled.series[filled.series.length - 1]?.followers ?? null;

  // ── Revenue chart (cumulative over its own period, with a like-for-like baseline) ──
  const revDaysList = dayRange(shiftDay(end, -(revN - 1)), end);
  const revPrevRange = previousRange(revDaysList[0], end);
  let cumulative = 0;
  let revReported = 0;
  const revSeries = revDaysList.map((day) => {
    const d = dailyByDate.get(day);
    // null = no Page has published that day's earnings yet (Meta lags a closed
    // day); the UI says so instead of showing a "+$0.00" that reads as no income.
    const cents = d ? num(d._sum.earningsCents) : null;
    if (cents != null) { cumulative += cents; revReported++; }
    return { date: day, cents, cumulativeCents: cumulative };
  });
  let revPrevTotal = 0;
  let revPrevDaysCovered = 0;
  for (const day of dayRange(revPrevRange.start, revPrevRange.end)) {
    const d = dailyByDate.get(day);
    const cents = d ? num(d._sum.earningsCents) : null;
    if (cents != null) { revPrevTotal += cents; revPrevDaysCovered++; }
  }
  const revTotal = revReported > 0 ? cumulative : null;
  const revPrevious = revPrevDaysCovered > 0 ? revPrevTotal : null;
  // ⚠️ `assets` and `contributing` must carry REAL evidence, not 1 and 1. With both
  // hard-wired to 1 the gate `previous.assets >= floor(contributing * 0.9)` reduced to
  // `1 >= 0` — always true — so this trend could never be marked unreliable. Measured on
  // prod at days=90: the KPI and this card returned the IDENTICAL -7.418514641702768%,
  // but the KPI rendered "↓ 7%*" (starred, thin baseline) and the card rendered "↓ 7%".
  // One number, two confidence claims, on the same screen.
  const revTrend = trendFrom(
    revTotal,
    revPrevious != null
      ? { value: revPrevious, coverageShare: revPrevDaysCovered / revDaysList.length, assets: prv.earningsAssets }
      : null,
    earnSum.contributing,
  );

  // ── Channel tables ──
  const channelRow = (a: (typeof assets)[number]): ChannelRow => {
    const t = perAsset.get(a.id);
    const fd = followerDeltas.get(a.id);
    return {
      id: a.id,
      metaId: a.metaId,
      name: a.name,
      username: a.username,
      platform: platformOf(a.kind),
      pictureUrl: a.pictureUrl,
      followers: a.followerCount,
      views: t?.views ?? null,
      earningsCents: t?.earningsCents ?? null,
      followerDelta: fd?.delta ?? null,
      followerDeltaDays: fd?.days ?? null,
    };
  };
  const byViews = assets
    .filter((a) => (perAsset.get(a.id)?.views ?? null) != null)
    .sort((a, b) => (perAsset.get(b.id)!.views ?? 0) - (perAsset.get(a.id)!.views ?? 0));
  const topChannels = byViews.slice(0, 5).map(channelRow);
  // ⚠️ FREE. `byViews` is already computed and already sorted, so a per-platform board
  // is a filter over an in-memory array — no query, no cache-key dimension, no extra
  // payload beyond ten more rows. The card's three tabs are therefore a pure
  // presentation choice that cannot regress this endpoint's cost.
  const topChannelsInstagram = byViews.filter((a) => platformOf(a.kind) === "instagram").slice(0, 5).map(channelRow);
  const topChannelsFacebook = byViews.filter((a) => platformOf(a.kind) === "facebook").slice(0, 5).map(channelRow);
  // ⚠️ The FULL directory, for the header search. Before this the search unioned
  // topChannels with revenueByChannel — 8 of 419 channels on prod — so searching for
  // anything outside those two truncated lists (including the estate's largest
  // channel) answered "No results". Sorted by followers so an empty query shows the
  // channels a reader is most likely to want. Carries the same ChannelRow the drawer
  // needs, so a searched channel opens with real figures rather than dashes.
  const allChannels: ChannelDirectoryRow[] = [...assets]
    .sort((a, b) => (b.followerCount ?? 0) - (a.followerCount ?? 0))
    .map((a) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { pictureUrl, ...rest } = channelRow(a);
      return rest;
    });
  const revenueByChannel = assets
    .filter((a) => (perAsset.get(a.id)?.earningsCents ?? 0) > 0)
    .sort((a, b) => (perAsset.get(b.id)!.earningsCents ?? 0) - (perAsset.get(a.id)!.earningsCents ?? 0))
    .slice(0, 5)
    .map(channelRow);
  // ⚠️ Views by Channel may be detached from the global period, in which case it needs
  // per-asset totals over ITS OWN window — reusing `perAsset` would put the global
  // window's numbers under this card's label. getRangeTotals has its own 60s cache, so
  // the extra call is cheap and is skipped entirely when the card follows the global.
  const vbcStart = shiftDay(end, -(vbcN - 1));
  const rangeVbc = vbcN === spanDays ? rangeNow : await getRangeTotals(vbcStart, end);
  const vbcRanked = assets
    .filter((a) => (rangeVbc.get(a.id)?.views ?? null) != null)
    .sort((a, b) => (rangeVbc.get(b.id)!.views ?? 0) - (rangeVbc.get(a.id)!.views ?? 0));
  const viewsByChannel = topWithOthers(
    vbcRanked.map((a) => ({ id: a.id, name: a.name, platform: platformOf(a.kind), value: rangeVbc.get(a.id)!.views ?? 0 })),
    7,
  ).map((r) => ({ id: r.item?.id ?? null, name: r.name, platform: r.item?.platform ?? null, views: r.value, share: r.share }));
  const vbcTotal = vbcRanked.reduce((t, a) => t + (rangeVbc.get(a.id)!.views ?? 0), 0);
  /** Every channel over the Views-by-Channel window — the expanded view reads this. */
  const viewsByChannelAll = vbcRanked.map((a) => ({
    id: a.id, name: a.name, platform: platformOf(a.kind),
    views: rangeVbc.get(a.id)!.views ?? 0,
    share: vbcTotal > 0 ? ((rangeVbc.get(a.id)!.views ?? 0) / vbcTotal) * 100 : 0,
  }));

  // ── Cities (Instagram follower audience) ──
  const cityTotal = cityRows.reduce((s, r) => s + (r._sum.value ?? 0), 0);
  const indian = cityRows
    .map((r) => ({ ...parseCityBucket(r.bucket), value: r._sum.value ?? 0 }))
    .filter((c) => c.india && c.value > 0);
  // Two Meta buckets can normalise to one city (e.g. "Bangalore" and "Bengaluru").
  const merged = new Map<string, { name: string; state: string | null; value: number }>();
  for (const c of indian) {
    const k = c.name.toLowerCase();
    const cur = merged.get(k);
    if (cur) cur.value += c.value; else merged.set(k, { name: c.name, state: c.state, value: c.value });
  }
  const indiaTotal = [...merged.values()].reduce((s, c) => s + c.value, 0);
  const cityItems = [...merged.values()]
    .sort((a, b) => b.value - a.value)
    .slice(0, 40)
    .map((c, i) => ({ ...c, share: cityTotal > 0 ? (c.value / cityTotal) * 100 : 0, tier: tierForRank(i + 1) }));

  // ── Demographics ──
  const demoAssets = new Set<string>();
  for (const r of [...ageRows, ...genderRows, ...countryRows]) for (const id of r.assetIds) demoAssets.add(id);
  const ageMap = new Map(ageRows.map((r) => [r.bucket, r._sum.value ?? 0]));
  const age = AGE_ORDER.filter((b) => (ageMap.get(b) ?? 0) > 0).map((b) => ({ bucket: b, value: ageMap.get(b)! }));
  const gender = genderRows
    .map((r) => ({ bucket: r.bucket, label: genderLabel(r.bucket), value: r._sum.value ?? 0 }))
    .filter((g) => g.value > 0)
    .sort((a, b) => b.value - a.value);
  const country = topWithOthers(
    countryRows.map((r) => ({ name: r.bucket, value: r._sum.value ?? 0 })),
    6,
  ).map((r) => ({ bucket: r.name, value: r.value }));

  // ── Latest posts + activity ──
  const latestPosts = posts
    .filter((p) => p.postedAt !== null)
    .map((p) => ({
      id: p.id,
      title: firstLine(p.caption),
      permalink: p.permalink,
      postedAt: p.postedAt!.toISOString(),
      views: p.views,
      likes: p.likes,
      comments: p.comments,
      mediaProductType: p.mediaProductType,
      // ⚠️ Guarded by the URL's own `oe=` expiry, never by "we stored it recently".
      // These are the NEWEST posts across every channel, so in practice they are
      // hours old and essentially always carry a live preview — but the guard is what
      // guarantees the card can never show a broken image as the feed ages or a sync
      // is missed.
      thumbnailUrl: thumbnailIfFresh(p.thumbnailUrl, nowMs),
      channel: { name: p.asset.name, username: p.asset.username, platform: platformOf(p.asset.kind), pictureUrl: p.asset.pictureUrl },
    }));

  // ⚠️ Each item now carries the ONE thing needed to act on it, because the feed used to
  // carry {kind,text,at} only and was therefore a dead end in every mode — clicking a row
  // just unfolded its truncated text. `postId` lets the client open the SAME post drawer
  // the Latest Posts card opens (no extra data: these rows come from latestPosts, which
  // already carries the id); `href` is an in-portal route for the rest.
  // ⚠️ An href here is only a NAVIGATION HINT, never an authorisation claim — the
  // destination enforces its own permissions, and most of this page's audience holds only
  // the Employee role. The client links the row and lets the target gate it.
  const activity: OverviewPayload["activity"] = [
    ...latestPosts.slice(0, 4).map((p) => ({
      kind: "post" as const,
      text: `${p.channel.name} published ${p.mediaProductType === "REELS" ? "a reel" : "a post"}${p.title !== "Untitled post" ? ` — “${p.title}”` : ""}`,
      at: p.postedAt,
      postId: p.id,
      href: null,
    })),
    ...reports.map((r) => ({
      kind: "report" as const,
      text: `${r.employee.name} submitted a daily report with ${r._count.links} link${r._count.links === 1 ? "" : "s"}`,
      at: r.submittedAt.toISOString(),
      postId: null,
      href: "/reports",
    })),
    ...newUsers.map((u) => ({
      kind: "user" as const,
      text: `${u.name} joined the team`,
      at: u.createdAt.toISOString(),
      postId: null,
      href: "/employees",
    })),
    // ⚠️ NO `leave` STREAM — see the query block above. Named health-adjacent status must
    // not ride a payload served to all 74 internal users, 71 of whom hold no leave permission.
    ...announcements.map((a) => ({
      kind: "announcement" as const,
      text: `Announcement: ${a.title}`,
      at: a.createdAt.toISOString(),
      postId: null,
      href: "/announcements",
    })),
  ]
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, 6);

  // ── Content traction: last 7 closed days vs the 7 before, all flows ──
  // Reads the `daily` groupBy already in memory, so a detached period costs no query —
  // `longest` above is what guarantees `daily` reaches back far enough for it and its
  // equal-length baseline.
  const tracDayList = dayRange(shiftDay(end, -(tracN - 1)), end);
  const tracPrev = previousRange(tracDayList[0], end);
  const flow = (day: string, key: TractionKey): number | null => {
    const d = dailyByDate.get(day);
    if (!d) return null;
    return num(d._sum[key]);
  };
  const tracKeys: Array<{ key: TractionKey; label: string }> = [
    { key: "views", label: "Views" },
    { key: "engagements", label: "Engagements" },
    { key: "reactions", label: "Reactions" },
    { key: "shares", label: "Shares" },
  ];
  const tiles = tracKeys.map(({ key, label }) => {
    const curVals = sumNullable(tracDayList.map((d) => flow(d, key)));
    const prevVals = sumNullable(dayRange(tracPrev.start, tracPrev.end).map((d) => flow(d, key)));
    return { key, label, value: curVals.sum, previous: prevVals.sum, pct: pctChange(curVals.sum, prevVals.sum) };
  });
  const tracSeries = tracDayList.map((day) => ({
    date: day,
    views: flow(day, "views"),
    engagements: flow(day, "engagements"),
    reactions: flow(day, "reactions"),
    shares: flow(day, "shares"),
  }));

  // ── Trending entities (captions harvested this week vs last) ──
  const trendingIds = trendingNow.map((t) => t.entityId);
  const [entities, trendingPrev] = trendingIds.length
    ? await Promise.all([
        prisma.entity.findMany({ where: { id: { in: trendingIds } }, select: { id: true, canonicalName: true, type: true, createdAt: true } }),
        prisma.linkContentEntity.groupBy({
          by: ["entityId"],
          where: {
            entityId: { in: trendingIds },
            content: {
              status: "ok",
              createdAt: { gte: new Date(Date.now() - 14 * 86_400_000), lt: new Date(Date.now() - 7 * 86_400_000) },
            },
          },
          _count: { _all: true },
        }),
      ])
    : [[], []];
  const entityById = new Map(entities.map((e) => [e.id, e]));
  const prevCount = new Map(trendingPrev.map((t) => [t.entityId, t._count._all]));
  const weekAgo = Date.now() - 7 * 86_400_000;
  const trending = trendingNow
    .map((t) => {
      const e = entityById.get(t.entityId);
      if (!e) return null;
      const count = t._count._all;
      const previousCount = prevCount.get(t.entityId) ?? 0;
      // Share of that week's harvested captions. NULL when the half has no captions at all
      // — never a fabricated 0%.
      const share = captionsThisWeek > 0 ? count / captionsThisWeek : null;
      const previousShare = captionsLastWeek > 0 ? previousCount / captionsLastWeek : null;
      // ⚠️ Change in SHARE, not in count — see the caption-total comment above. NULL when
      // there is no prior share to compare against (a genuinely new topic, or an empty
      // prior week), so the UI renders "new" rather than an infinite percentage.
      const changePct = share != null && previousShare != null && previousShare > 0 ? ((share - previousShare) / previousShare) * 100 : null;
      return {
        id: e.id, name: e.canonicalName, type: e.type, count, previousCount, share, previousShare, changePct,
        // ⚠️ An entity BORN this week is not evidence a topic is new — the extractor may
        // simply have rendered an old topic as a new string ("Ganpati Puja" vs "Ganpati
        // Pooja"). Surfaced so the UI can say "first seen this week" instead of a huge %.
        firstSeenThisWeek: e.createdAt.getTime() >= weekAgo,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  const p = pendingStats as Record<string, unknown> | null;
  const n = (k: string) => (p && typeof p[k] === "number" ? (p[k] as number) : 0);

  return {
    generatedAt: new Date().toISOString(),
    period: {
      days: spanDays,
      start, end, prevStart: prev.start, prevEnd: prev.end, dataThroughDay,
      /** True when the window came from an explicit start/end rather than a preset. */
      custom: params.range != null,
      /** Set when the requested end was later than the last day the estate has closed. */
      clampedTo: rangeClampedTo,
    },
    allChannels,
    channels: {
      total: assets.length,
      facebook: assets.filter((a) => a.kind === "FACEBOOK_PAGE").length,
      instagram: assets.filter((a) => a.kind !== "FACEBOOK_PAGE").length,
      complete: completeChannels,
      errored: erroredChannels,
    },
    kpis: {
      followers: {
        value: followers,
        delta: channelsWithHistory > 0 ? followerDelta : null,
        deltaDays: channelsWithHistory > 0 ? span : null,
        channelsWithHistory,
        followersWithHistory: channelsWithHistory > 0 ? followersWithHistory : null,
        spark: filled.series.slice(-spanDays).map((s) => s.followers),
      },
      views: metric(viewsSum, prv.views, prv.viewsAssets, spark((d) => num(d._sum.views))),
      engagements: metric(engSum, prv.engagements, prv.engAssets, spark((d) => num(d._sum.engagements))),
      revenue: { ...metric(earnSum, prv.earnings, prv.earningsAssets, spark((d) => num(d._sum.earningsCents))), earning: earningChannels },
      reach: { value: reachContributing > 0 ? reachSum : null, window: reachWindow, contributing: reachContributing },
    },
    audience: {
      days: audN,
      series: filled.series,
      channelsUsed: filled.used,
      channelsLinked: linkedCount,
      delta: audFirst != null && audLast != null && filled.used > 0 ? audLast - audFirst : null,
    },
    revenue: { days: revN, series: revSeries, totalCents: revTotal, previousCents: revPrevious, trend: revTrend },
    viewsByChannel,
    viewsByChannelAll,
    viewsByChannelDays: vbcN,
    viewsByChannelTotal: vbcTotal,
    topChannels,
    topChannelsInstagram,
    topChannelsFacebook,
    revenueByChannel,
    cities: {
      total: cityTotal,
      indiaShare: cityTotal > 0 ? (indiaTotal / cityTotal) * 100 : 0,
      assets: demoAssets.size,
      items: cityItems,
    },
    latestPosts,
    activity,
    traction: { days: tracN, start: tracDayList[0], end, prevStart: tracPrev.start, prevEnd: tracPrev.end, tiles, series: tracSeries },
    demographics: { assets: demoAssets.size, age, gender, country },
    trending,
    trendingWindow: { captionsThisWeek, captionsLastWeek },
    pending: p
      ? {
          approvals: n("pendingApprovals"),
          employees: n("pendingEmployees"),
          leave: n("pendingLeaveRequests"),
          documents: n("pendingDocuments"),
          linksToday: n("linksToday"),
          submittedToday: n("submittedTodayCount"),
        }
      : null,
  };
}

/**
 * One GROUP BY per dimension over the follower audience of live Instagram
 * assets. Returns per-bucket sums plus the asset ids that contributed, so the
 * page can disclose "N channels" rather than implying the whole estate.
 */
async function demographicGroup(liveIds: string[], dimension: string) {
  if (!liveIds.length) return [] as Array<{ bucket: string; _sum: { value: number | null }; assetIds: string[] }>;
  const rows = await prisma.metaAssetDemographic.findMany({
    where: { audience: "follower", dimension, assetId: { in: liveIds } },
    select: { assetId: true, bucket: true, value: true },
  });
  const byBucket = new Map<string, { sum: number; assets: Set<string> }>();
  for (const r of rows) {
    const cur = byBucket.get(r.bucket) ?? { sum: 0, assets: new Set<string>() };
    cur.sum += r.value;
    cur.assets.add(r.assetId);
    byBucket.set(r.bucket, cur);
  }
  return [...byBucket.entries()].map(([bucket, v]) => ({ bucket, _sum: { value: v.sum }, assetIds: [...v.assets] }));
}
