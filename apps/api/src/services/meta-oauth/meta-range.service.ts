/**
 * Calendar-month / arbitrary-range channel metrics, served from meta_asset_daily.
 *
 * ⚠️ WHY A STORE AND NOT LIVE GRAPH CALLS. Meta cannot answer a custom range in
 * one call: Facebook's `period` vocabulary is day | week | days_28 only
 * (period=month is a ROLLING 30-day window stamped daily — live-probed
 * 2026-08-31, NOT calendar months), and Instagram hard-fails any since/until
 * span over 30 days. Stitching live chunks per request would cost
 * assets × chunks calls per page view. Daily rows are written free by the
 * 3-hourly sync and backfilled once; a range is then one GROUP BY.
 *
 * ⚠️ REACH IS DELIBERATELY ABSENT FROM RANGE TOTALS. It counts UNIQUE people;
 * summing days double-counts everyone who returned (measured 56% overstatement
 * when daily reach was summed). Meta publishes no unique-people figure for a
 * custom span, so the honest answer is null — an em-dash — never a sum.
 *
 * ⚠️ COVERAGE IS PART OF THE ANSWER. History only reaches as far as the backfill
 * (FB ~2 years, IG 90 days) and accrues daily after that, so a range can be
 * partially covered. Every per-asset result carries coveredDays so the UI can
 * say "312 of 365 days" instead of presenting a partial sum as the whole.
 */

import { prisma } from "@dashmani/db";
import { resolveContestedOwners } from "./meta-channels.service";

export interface AssetRangeTotals {
  views: number | null;
  engagements: number | null;
  profileViews: number | null;
  reactions: number | null;
  earningsCents: number | null;
  follows: number | null;
  unfollows: number | null;
  videoViewTimeMs: number | null;
  saves: number | null;
  shares: number | null;
  /** Days inside the range that actually have a stored row. */
  coveredDays: number;
  /** Newest covered day, ISO date — the "data through" for this asset. */
  latestDay: string | null;
}

export interface RangeFollowerDelta {
  delta: number;
  /** Days the delta actually spans (last snapshot − first snapshot in range). */
  days: number;
}

const DAY_MS = 86_400_000;

export function rangeDayCount(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS) + 1;
}

/**
 * Per-asset sums over [start, end] (inclusive, ISO dates).
 *
 * One SQL GROUP BY over the date index — never per-asset queries, never rows
 * hydrated into Node beyond one aggregate per asset (~500 rows).
 */
async function computeRangeTotals(start: string, end: string): Promise<Map<string, AssetRangeTotals>> {
  const gte = new Date(`${start}T00:00:00Z`);
  const lte = new Date(`${end}T00:00:00Z`);
  const grouped = await prisma.metaAssetDaily.groupBy({
    by: ["assetId"],
    where: { date: { gte, lte } },
    // ⚠️ Every field here is a FLOW (summable). reach and accountsEngaged are
    // deliberately absent — both count UNIQUE people and cannot be added up.
    _sum: {
      views: true, engagements: true, profileViews: true, reactions: true, earningsCents: true,
      follows: true, unfollows: true, videoViewTimeMs: true, saves: true, shares: true,
    },
    _count: { date: true },
    _max: { date: true },
  });
  const out = new Map<string, AssetRangeTotals>();
  const n = (v: bigint | number | null) => (v === null || v === undefined ? null : Number(v));
  for (const g of grouped) {
    out.set(g.assetId, {
      views: n(g._sum.views),
      engagements: n(g._sum.engagements),
      profileViews: n(g._sum.profileViews),
      reactions: n(g._sum.reactions),
      earningsCents: n(g._sum.earningsCents),
      follows: n(g._sum.follows),
      unfollows: n(g._sum.unfollows),
      videoViewTimeMs: n(g._sum.videoViewTimeMs),
      saves: n(g._sum.saves),
      shares: n(g._sum.shares),
      coveredDays: g._count.date,
      latestDay: g._max.date ? g._max.date.toISOString().slice(0, 10) : null,
    });
  }
  return out;
}

/**
 * 60s single-flight TTL cache — the documented pattern (true-links / coverage
 * caches): concurrent cold requests share one in-flight promise, a failure
 * self-evicts, entries are bounded. Tests MUST call invalidateRangeCache() in
 * beforeEach — module caches leaking between tests is a documented bug class.
 */
const cache = new Map<string, { at: number; promise: Promise<Map<string, AssetRangeTotals>> }>();
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 50;

export function invalidateRangeCache(): void {
  cache.clear();
}

export function getRangeTotals(start: string, end: string): Promise<Map<string, AssetRangeTotals>> {
  const key = `${start}|${end}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.promise;
  if (cache.size >= CACHE_MAX) {
    for (const [k, v] of cache) if (Date.now() - v.at >= CACHE_TTL_MS) cache.delete(k);
    if (cache.size >= CACHE_MAX) cache.clear();
  }
  const promise = computeRangeTotals(start, end).catch((e) => {
    cache.delete(key); // a failure must not be served for 60s
    throw e;
  });
  cache.set(key, { at: Date.now(), promise });
  return promise;
}

/**
 * Follower change across [start, end] per ASSET, from API snapshots.
 *
 * Same rules as the live route, generalised to a historical span:
 *  - api-sourced snapshots only (verified-data-only surface);
 *  - ⚠️ CONTESTED channel rows get NO delta at all — their snapshot series is
 *    shared by two different Pages and provably switches between them
 *    mid-history (the fabricated +5.1m incident);
 *  - the delta is last-in-range − first-in-range, and `days` reports the span
 *    those snapshots actually cover, so the UI labels it truthfully instead of
 *    asserting the requested range.
 */
export async function getRangeFollowerDeltas(start: string, end: string): Promise<Map<string, RangeFollowerDelta>> {
  const gte = new Date(`${start}T00:00:00Z`);
  // Snapshots are stored at IST midnight, so the same calendar day can carry a
  // small time component — include the whole end day.
  const lt = new Date(Date.parse(`${end}T00:00:00Z`) + DAY_MS);

  const assets = await prisma.metaAsset.findMany({
    where: { disconnectedAt: null, socialAccountId: { not: null } },
    select: { id: true, socialAccountId: true },
  });
  const accountIds = [...new Set(assets.map((a) => a.socialAccountId!))];
  if (accountIds.length === 0) return new Map();

  const snaps = await prisma.accountGrowthSnapshot.findMany({
    where: { accountId: { in: accountIds }, source: "api", date: { gte, lt } },
    orderBy: { date: "asc" },
    select: { accountId: true, date: true, followerCount: true },
  });
  const firstLast = new Map<string, { first: { d: Date; v: number }; last: { d: Date; v: number } }>();
  for (const sn of snaps) {
    const cur = firstLast.get(sn.accountId);
    if (!cur) firstLast.set(sn.accountId, { first: { d: sn.date, v: sn.followerCount }, last: { d: sn.date, v: sn.followerCount } });
    else cur.last = { d: sn.date, v: sn.followerCount };
  }

  const owners = await resolveContestedOwners();
  const out = new Map<string, RangeFollowerDelta>();
  for (const a of assets) {
    if (owners.has(a.socialAccountId!)) continue; // shared history — unattributable
    const fl = firstLast.get(a.socialAccountId!);
    if (!fl) continue;
    const days = Math.round((fl.last.d.getTime() - fl.first.d.getTime()) / DAY_MS);
    if (days < 1) continue; // same-day pair asserts nothing about change
    out.set(a.id, { delta: fl.last.v - fl.first.v, days });
  }
  return out;
}

// How many trailing days to inspect when deciding which day is genuinely complete.
export const END_PROBE_DAYS = 8;
// A day counts as closed once this share of the estate's best-covered day reported it.
export const END_COVERAGE_SHARE = 0.8;

/**
 * The newest day ≤ `upTo` that is complete for the whole estate — shared by the
 * overview (which derives its window end from it) and Account Growth's custom range
 * (which clamps a user-picked end to it).
 *
 * Instagram closes at UTC midnight and Facebook at Pacific midnight, and the sweep that
 * writes meta_asset_daily runs every ~3h — so the newest day in the table is routinely a
 * PARTIAL one holding only the platform that closed first. Counting reporting assets per
 * day over the probe window and taking the newest day within END_COVERAGE_SHARE of the
 * best-covered day picks the last day BOTH platforms closed, without hard-coding either
 * boundary. Measured on prod: a 7-day range ending on the unclosed day understated views
 * by 7.2% because all 313 Facebook Pages were missing it.
 *
 * ⚠️ `minAssets` IS A STATISTICAL FLOOR, NOT A TEST DODGE. The rule compares SHARES of
 * the estate, and a share needs a denominator: with 2 assets, one sparse Instagram
 * account with a single stored day makes every other day read as "20% covered" and would
 * shorten a range nothing is wrong with. Below the floor the caller's `upTo` is returned
 * untouched and the per-channel coverage chips carry the disclosure, exactly as before.
 * The overview passes no floor (its end is always derived, never user-picked, and its
 * tests seed 2 assets and rely on the clamp); Account Growth passes 20 because it is
 * overriding an explicit user choice and must not do so on noise.
 *
 * Fails open to `upTo` when there is nothing to measure — a brand-new estate must render.
 */
export async function resolveClosedEnd(
  assetIds: string[],
  upTo: string,
  opts: { minAssets?: number } = {},
): Promise<string> {
  if (assetIds.length === 0) return upTo;
  if (opts.minAssets && assetIds.length < opts.minAssets) return upTo;
  const rows = await prisma.metaAssetDaily.groupBy({
    by: ["date"],
    where: {
      assetId: { in: assetIds },
      date: {
        gte: new Date(`${shiftDay(upTo, -(END_PROBE_DAYS - 1))}T00:00:00Z`),
        lte: new Date(`${upTo}T00:00:00Z`),
      },
    },
    _count: { _all: true },
    orderBy: { date: "desc" },
  });
  if (rows.length === 0) return upTo;
  const best = Math.max(...rows.map((r) => r._count._all));
  if (best === 0) return upTo;
  // rows are newest-first, so the first adequately-covered day is the newest one.
  for (const r of rows) {
    if (r._count._all >= best * END_COVERAGE_SHARE) return r.date.toISOString().slice(0, 10);
  }
  return upTo;
}

/** The equal-length range immediately BEFORE [start, end] — for trend chips. */
export function previousRange(start: string, end: string): { start: string; end: string } {
  const span = rangeDayCount(start, end);
  const prevEnd = new Date(Date.parse(`${start}T00:00:00Z`) - DAY_MS);
  const prevStart = new Date(prevEnd.getTime() - (span - 1) * DAY_MS);
  return { start: prevStart.toISOString().slice(0, 10), end: prevEnd.toISOString().slice(0, 10) };
}

/** `day` shifted by `days` (negative = earlier), as an ISO date. */
export function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The last calendar day a live window's figures actually COVER, from the
 * `periodEnd` Meta stamped on it.
 *
 * ⚠️ periodEnd is the instant the period CLOSED — the midnight AFTER its last
 * day. Facebook closes at Pacific midnight (2026-09-10T07:00Z), Instagram is
 * asked for a UTC-midnight `until` (2026-09-10T00:00Z); both land on the UTC
 * date after the day they describe, so the covered day is that date minus one
 * (the same rule fbDayCovered applies to daily points). Reading the date
 * straight off periodEnd is the off-by-one that made "Figures run through
 * 9 Sep" sit above numbers that stopped at Sep 8, and made the 1-day trend
 * baseline land on the very day it was meant to precede (a permanent 0.0%).
 */
export function coveredDayOf(periodEnd: Date): string {
  return shiftDay(periodEnd.toISOString().slice(0, 10), -1);
}
