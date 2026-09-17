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
import { resolveDuplicateAssetIds } from "./meta-oauth/meta-channels.service";
import {
  getRangeTotals,
  getRangeFollowerDeltas,
  previousRange,
  rangeDayCount,
  shiftDay,
  type AssetRangeTotals,
} from "./meta-oauth/meta-range.service";
import * as analyticsService from "./analytics.service";

export const OVERVIEW_PERIODS = [7, 14, 30, 90] as const;
export const WIDGET_PERIODS = [7, 30, 90] as const;
export type OverviewPeriod = (typeof OVERVIEW_PERIODS)[number];
export type WidgetPeriod = (typeof WIDGET_PERIODS)[number];

export interface OverviewParams {
  days: OverviewPeriod;
  audDays: WidgetPeriod;
  revDays: WidgetPeriod;
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
    days: number;
    start: string;
    end: string;
    prevStart: string;
    prevEnd: string;
    dataThroughDay: string | null;
  };
  channels: { total: number; facebook: number; instagram: number };
  kpis: {
    followers: {
      value: number;
      delta: number | null;
      deltaDays: number | null;
      channelsWithHistory: number;
      spark: number[];
    };
    views: PeriodMetric;
    engagements: PeriodMetric;
    revenue: PeriodMetric;
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
    series: Array<{ date: string; cents: number; cumulativeCents: number }>;
    totalCents: number | null;
    previousCents: number | null;
    trend: Trend | null;
  };
  viewsByChannel: Array<{ id: string | null; name: string; views: number; share: number }>;
  topChannels: ChannelRow[];
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
    channel: { name: string; username: string | null; platform: "facebook" | "instagram"; pictureUrl: string | null };
  }>;
  activity: Array<{ kind: ActivityKind; text: string; at: string }>;
  traction: {
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
  trending: Array<{ id: string; name: string; type: string; count: number; previousCount: number }>;
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

export type CityTier = "high" | "growing" | "emerging";
export type ActivityKind = "post" | "report" | "user" | "leave" | "announcement";
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

export function getOverview(params: OverviewParams): Promise<OverviewPayload> {
  const key = `${params.days}:${params.audDays}:${params.revDays}`;
  const now = Date.now();
  const hit = _cache.get(key);
  if (hit && hit.expires > now) return hit.promise;
  const promise = buildOverview(params).catch((e) => {
    _cache.delete(key);
    throw e;
  });
  _cache.set(key, { expires: now + TTL_MS, promise });
  return promise;
}

// ───────────────────────────── builder ─────────────────────────────

async function buildOverview(params: OverviewParams): Promise<OverviewPayload> {
  const todayIso = isoDay(new Date());
  // Stored daily rows are CLOSED days; the current day is never complete.
  const end = shiftDay(todayIso, -1);
  const start = shiftDay(end, -(params.days - 1));
  const prev = previousRange(start, end);
  const longest = Math.max(params.days, params.audDays, params.revDays, 7);
  const seriesStart = shiftDay(end, -(longest - 1));
  // Daily series also need the equal-length baseline for traction/revenue trends.
  const seriesFetchStart = shiftDay(seriesStart, -longest);

  const duplicateIds = await resolveDuplicateAssetIds();
  const assets = (
    await prisma.metaAsset.findMany({
      where: { disconnectedAt: null, selected: true },
      select: {
        id: true, kind: true, metaId: true, name: true, username: true, pictureUrl: true,
        followerCount: true, socialAccountId: true,
        windowMetrics: { where: { window: { in: ["week", "days_28"] } }, select: { window: true, reach: true } },
      },
    })
  ).filter((a) => !duplicateIds.has(a.id));
  const liveIds = assets.map((a) => a.id);
  const linked = assets.map((a) => a.socialAccountId).filter((x): x is string => x !== null);
  const audStart = shiftDay(end, -(params.audDays - 1));

  // Empty `in` lists are valid Prisma filters that simply match nothing, so every
  // query below runs unconditionally and keeps one concrete result type.
  const [rangeNow, rangePrev, followerDeltas, daily, snapshots, cityRows, ageRows, genderRows, countryRows, posts, reports, newUsers, leaves, announcements, trendingNow, pendingStats] =
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
          accountId: { in: linked },
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
        where: { assetId: { in: liveIds }, postedAt: { not: null } },
        orderBy: { postedAt: "desc" },
        take: 6,
        select: {
          id: true, caption: true, permalink: true, postedAt: true, views: true, likes: true, comments: true,
          mediaProductType: true,
          asset: { select: { name: true, username: true, kind: true, pictureUrl: true } },
        },
      }),
      prisma.dailyReport.findMany({
        orderBy: { submittedAt: "desc" },
        take: 5,
        select: { submittedAt: true, employee: { select: { name: true } }, _count: { select: { links: true } } },
      }),
      prisma.user.findMany({
        where: { deletedAt: null, createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } },
        orderBy: { createdAt: "desc" },
        take: 3,
        select: { name: true, createdAt: true },
      }),
      prisma.leaveRequest.findMany({
        orderBy: { createdAt: "desc" },
        take: 3,
        select: { createdAt: true, type: true, status: true, employee: { select: { name: true } } },
      }),
      prisma.announcement.findMany({
        orderBy: { createdAt: "desc" },
        take: 2,
        select: { title: true, createdAt: true },
      }),
      prisma.linkContentEntity.groupBy({
        by: ["entityId"],
        where: { content: { status: "ok", createdAt: { gte: new Date(Date.now() - 7 * 86_400_000) } } },
        _count: { _all: true },
        orderBy: { _count: { entityId: "desc" } },
        take: 6,
      }),
      analyticsService.getOverviewStats().catch(() => null),
    ]);

  // ── KPI period metrics from stored daily rows (like-for-like with the baseline) ──
  const cur = { views: [] as Array<number | null>, engagements: [] as Array<number | null>, earnings: [] as Array<number | null> };
  const prv = { views: 0, engagements: 0, earnings: 0, coveredDays: 0, assets: 0, earningsAssets: 0, viewsAssets: 0, engAssets: 0 };
  let dataThroughDay: string | null = null;
  const perAsset = new Map<string, AssetRangeTotals>();
  for (const a of assets) {
    const t = rangeNow.get(a.id);
    if (t) {
      perAsset.set(a.id, t);
      cur.views.push(t.views);
      cur.engagements.push(t.engagements);
      cur.earnings.push(t.earningsCents);
      if (t.latestDay && (dataThroughDay === null || t.latestDay > dataThroughDay)) dataThroughDay = t.latestDay;
    }
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
  const reachWindow: "week" | "days_28" | null = params.days === 7 ? "week" : params.days === 30 ? "days_28" : null;
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
  for (const a of assets) {
    followers += a.followerCount ?? 0;
    const fd = followerDeltas.get(a.id);
    if (fd && fd.days >= span - 1) { followerDelta += fd.delta; channelsWithHistory++; }
  }

  // ── Audience growth line ──
  const audDaysList = dayRange(shiftDay(end, -(params.audDays - 1)), end);
  const filled = forwardFillFollowerSeries(
    snapshots.map((s) => ({ accountId: s.accountId, date: isoDay(s.date), followerCount: s.followerCount })),
    audDaysList,
  );
  const linkedCount = linked.length;
  const audFirst = filled.series[0]?.followers ?? null;
  const audLast = filled.series[filled.series.length - 1]?.followers ?? null;

  // ── Revenue chart (cumulative over its own period, with a like-for-like baseline) ──
  const revDaysList = dayRange(shiftDay(end, -(params.revDays - 1)), end);
  const revPrevRange = previousRange(revDaysList[0], end);
  let cumulative = 0;
  let revReported = 0;
  const revSeries = revDaysList.map((day) => {
    const d = dailyByDate.get(day);
    const cents = d ? num(d._sum.earningsCents) : null;
    if (cents != null) { cumulative += cents; revReported++; }
    return { date: day, cents: cents ?? 0, cumulativeCents: cumulative };
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
  const revTrend = trendFrom(
    revTotal,
    revPrevious != null ? { value: revPrevious, coverageShare: revPrevDaysCovered / revDaysList.length, assets: 1 } : null,
    1,
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
  const revenueByChannel = assets
    .filter((a) => (perAsset.get(a.id)?.earningsCents ?? 0) > 0)
    .sort((a, b) => (perAsset.get(b.id)!.earningsCents ?? 0) - (perAsset.get(a.id)!.earningsCents ?? 0))
    .slice(0, 5)
    .map(channelRow);
  const viewsByChannel = topWithOthers(
    byViews.map((a) => ({ id: a.id, name: a.name, value: perAsset.get(a.id)!.views ?? 0 })),
    7,
  ).map((r) => ({ id: r.item?.id ?? null, name: r.name, views: r.value, share: r.share }));

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
    .slice(0, 15)
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
    .slice(0, 5)
    .map((p) => ({
      id: p.id,
      title: firstLine(p.caption),
      permalink: p.permalink,
      postedAt: p.postedAt!.toISOString(),
      views: p.views,
      likes: p.likes,
      comments: p.comments,
      mediaProductType: p.mediaProductType,
      channel: { name: p.asset.name, username: p.asset.username, platform: platformOf(p.asset.kind), pictureUrl: p.asset.pictureUrl },
    }));

  const activity: OverviewPayload["activity"] = [
    ...latestPosts.slice(0, 4).map((p) => ({
      kind: "post" as const,
      text: `${p.channel.name} published ${p.mediaProductType === "REELS" ? "a reel" : "a post"}${p.title !== "Untitled post" ? ` — “${p.title}”` : ""}`,
      at: p.postedAt,
    })),
    ...reports.map((r) => ({
      kind: "report" as const,
      text: `${r.employee.name} submitted a daily report with ${r._count.links} link${r._count.links === 1 ? "" : "s"}`,
      at: r.submittedAt.toISOString(),
    })),
    ...newUsers.map((u) => ({ kind: "user" as const, text: `${u.name} joined the team`, at: u.createdAt.toISOString() })),
    ...leaves.map((l) => ({
      kind: "leave" as const,
      text: `${l.employee.name} requested ${String(l.type).toLowerCase().replace(/_/g, " ")} leave · ${String(l.status).toLowerCase()}`,
      at: l.createdAt.toISOString(),
    })),
    ...announcements.map((a) => ({ kind: "announcement" as const, text: `Announcement: ${a.title}`, at: a.createdAt.toISOString() })),
  ]
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, 6);

  // ── Content traction: last 7 closed days vs the 7 before, all flows ──
  const tracDays = dayRange(shiftDay(end, -6), end);
  const tracPrev = previousRange(tracDays[0], end);
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
    const curVals = sumNullable(tracDays.map((d) => flow(d, key)));
    const prevVals = sumNullable(dayRange(tracPrev.start, tracPrev.end).map((d) => flow(d, key)));
    return { key, label, value: curVals.sum, previous: prevVals.sum, pct: pctChange(curVals.sum, prevVals.sum) };
  });
  const tracSeries = tracDays.map((day) => ({
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
        prisma.entity.findMany({ where: { id: { in: trendingIds } }, select: { id: true, canonicalName: true, type: true } }),
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
  const trending = trendingNow
    .map((t) => {
      const e = entityById.get(t.entityId);
      return e ? { id: e.id, name: e.canonicalName, type: e.type, count: t._count._all, previousCount: prevCount.get(t.entityId) ?? 0 } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .slice(0, 5);

  const p = pendingStats as Record<string, unknown> | null;
  const n = (k: string) => (p && typeof p[k] === "number" ? (p[k] as number) : 0);

  return {
    generatedAt: new Date().toISOString(),
    period: { days: params.days, start, end, prevStart: prev.start, prevEnd: prev.end, dataThroughDay },
    channels: {
      total: assets.length,
      facebook: assets.filter((a) => a.kind === "FACEBOOK_PAGE").length,
      instagram: assets.filter((a) => a.kind !== "FACEBOOK_PAGE").length,
    },
    kpis: {
      followers: {
        value: followers,
        delta: channelsWithHistory > 0 ? followerDelta : null,
        deltaDays: channelsWithHistory > 0 ? span : null,
        channelsWithHistory,
        spark: filled.series.slice(-params.days).map((s) => s.followers),
      },
      views: metric(viewsSum, prv.views, prv.viewsAssets, spark((d) => num(d._sum.views))),
      engagements: metric(engSum, prv.engagements, prv.engAssets, spark((d) => num(d._sum.engagements))),
      revenue: metric(earnSum, prv.earnings, prv.earningsAssets, spark((d) => num(d._sum.earningsCents))),
      reach: { value: reachContributing > 0 ? reachSum : null, window: reachWindow, contributing: reachContributing },
    },
    audience: {
      days: params.audDays,
      series: filled.series,
      channelsUsed: filled.used,
      channelsLinked: linkedCount,
      delta: audFirst != null && audLast != null && filled.used > 0 ? audLast - audFirst : null,
    },
    revenue: { days: params.revDays, series: revSeries, totalCents: revTotal, previousCents: revPrevious, trend: revTrend },
    viewsByChannel,
    topChannels,
    revenueByChannel,
    cities: {
      total: cityTotal,
      indiaShare: cityTotal > 0 ? (indiaTotal / cityTotal) * 100 : 0,
      assets: demoAssets.size,
      items: cityItems,
    },
    latestPosts,
    activity,
    traction: { start: tracDays[0], end, prevStart: tracPrev.start, prevEnd: tracPrev.end, tiles, series: tracSeries },
    demographics: { assets: demoAssets.size, age, gender, country },
    trending,
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
