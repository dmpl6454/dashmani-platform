// YouTube Data API v3 — channel subscriber-count resolver.
//
// Resolution cascade (proven live against prod):
//   1. Channel ID known (handle matches /^UC[\w-]{20,}$/ OR profile_url contains
//      /channel/UC…) → channels.list?id=  (1 quota unit; batched 50/call).
//      Empty items = deleted/terminated channel → skip (no value).
//   2. Handle present, no channel ID → channels.list?forHandle= (1 unit).
//      NOTE: forHandle OFTEN returns empty for real channels → fall through to 3.
//   3. Last resort: search.list?type=channel&q= (100 units — expensive!) →
//      take items[0].snippet.channelId → channels.list?id= (1 unit).
//      Capped via opts.maxSearchLookups (default 25) to protect the daily
//      10,000-unit quota.
//
// subscriberCount is a STRING in the API — always parse to int.
// hiddenSubscriberCount: true → channel hides count → skip (don't return 0).
//
// Fail-open: NEVER throws. Accounts that can't be resolved (deleted, hidden
// subs, quota exhausted, no API key, network error) are simply absent from the
// result array.

import { recordApiUsage } from "../api-usage.service";

const BATCH_SIZE = 50; // YouTube hard cap for channels.list?id=
const TIMEOUT_MS = 10_000;
const DEFAULT_MAX_SEARCH_LOOKUPS = 25;

const YT_BASE = "https://www.googleapis.com/youtube/v3";

// ── Types ────────────────────────────────────────────────────────────────────

export interface YtAccountRef {
  /** Our SocialAccount.id — passed through so the caller can map results back. */
  id: string;
  /** Whatever is stored in SocialAccount.handle — may be a UC… id, @Handle, or display name. */
  handle: string;
  /** profile_url stored on SocialAccount. May contain /channel/UC… or /@Handle. */
  profileUrl: string;
}

export interface YtFollowerResult {
  accountId: string;
  subscribers: number;
}

// ── Internal API response shapes ──────────────────────────────────────────────

interface YtChannelStatistics {
  subscriberCount?: string;
  hiddenSubscriberCount?: boolean;
}

interface YtChannelItem {
  id: string;
  statistics?: YtChannelStatistics;
}

interface YtChannelsResponse {
  items?: YtChannelItem[];
  error?: { code: number; errors?: Array<{ reason: string }> };
}

interface YtSearchItem {
  snippet?: { channelId?: string };
}

interface YtSearchResponse {
  items?: YtSearchItem[];
  error?: { code: number; errors?: Array<{ reason: string }> };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns true if the string looks like a YouTube channel ID (UC…). */
function isChannelId(s: string): boolean {
  return /^UC[\w-]{20,}$/.test(s);
}

/** Extracts a UC… channel ID from a profile URL, or null. */
function channelIdFromUrl(profileUrl: string): string | null {
  const match = profileUrl.match(/\/channel\/(UC[\w-]+)/);
  return match ? match[1] : null;
}

/** Strips a leading @ from a handle string. */
function stripAt(handle: string): string {
  return handle.replace(/^@/, "");
}

/**
 * Perform a fetch with timeout; returns null on any network/abort error (fail-open).
 */
async function safeFetch(url: string): Promise<Response | null> {
  // Cost Sheet: record the call + its QUOTA UNITS. YouTube Data API is free within
  // a 10,000-unit/day quota, but the cost VARIES sharply by endpoint — search.list
  // is 100 units, channels.list/videos.list are 1 — so a few searches can blow the
  // quota silently. Recording units (not just calls) makes that cliff visible.
  // Fire-and-forget + fail-open. operation by endpoint.
  const isSearch = /\/search\?/.test(url);
  const op = isSearch ? "youtube-search" : url.includes("/channels?") ? "youtube-channels" : "youtube-other";
  recordApiUsage({ provider: "youtube", operation: op, calls: 1, units: isSearch ? 100 : 1 });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Call channels.list for a batch of channel IDs (up to 50).
 * Returns a map of channelId → statistics (or null for each entry, on error).
 */
async function fetchChannelStatsBatch(
  ids: string[],
  apiKey: string,
): Promise<Map<string, YtChannelStatistics | null>> {
  const result = new Map<string, YtChannelStatistics | null>();

  const url =
    `${YT_BASE}/channels?part=statistics&id=${encodeURIComponent(ids.join(","))}&key=${apiKey}`;

  const res = await safeFetch(url);
  if (!res) {
    for (const id of ids) result.set(id, null);
    return result;
  }

  let data: YtChannelsResponse;
  try {
    data = (await res.json()) as YtChannelsResponse;
  } catch {
    for (const id of ids) result.set(id, null);
    return result;
  }

  // Build a map from items returned
  const itemById = new Map<string, YtChannelItem>();
  for (const item of data.items ?? []) {
    itemById.set(item.id, item);
  }

  for (const id of ids) {
    const item = itemById.get(id);
    // Not in response → deleted/terminated → set null so caller knows it was tried
    result.set(id, item ? (item.statistics ?? {}) : null);
  }

  return result;
}

/**
 * Try channels.list?forHandle= for a single handle (no @ prefix).
 * Returns the statistics object if the channel was found, or null otherwise.
 * Also returns the resolved channel ID from the response (to avoid re-fetching).
 */
async function fetchByForHandle(
  handle: string,
  apiKey: string,
): Promise<{ channelId: string; statistics: YtChannelStatistics } | null> {
  const url =
    `${YT_BASE}/channels?part=statistics&forHandle=${encodeURIComponent(handle)}&key=${apiKey}`;

  const res = await safeFetch(url);
  if (!res) return null;

  let data: YtChannelsResponse;
  try {
    data = (await res.json()) as YtChannelsResponse;
  } catch {
    return null;
  }

  const item = data.items?.[0];
  if (!item) return null; // empty → channel not found via forHandle

  return { channelId: item.id, statistics: item.statistics ?? {} };
}

/**
 * Use search.list to find a channel ID for a query string (handle or name).
 * Returns the resolved channelId or null.
 * Cost: 100 quota units.
 */
async function searchForChannelId(query: string, apiKey: string): Promise<string | null> {
  const url =
    `${YT_BASE}/search?part=snippet&type=channel&q=${encodeURIComponent(query)}&maxResults=1&key=${apiKey}`;

  const res = await safeFetch(url);
  if (!res) return null;

  let data: YtSearchResponse;
  try {
    data = (await res.json()) as YtSearchResponse;
  } catch {
    return null;
  }

  return data.items?.[0]?.snippet?.channelId ?? null;
}

/**
 * Convert a statistics object to a subscriber count, or null if hidden/missing.
 */
function extractSubscribers(stats: YtChannelStatistics | null): number | null {
  if (!stats) return null;
  if (stats.hiddenSubscriberCount === true) return null; // hidden — don't return 0
  if (stats.subscriberCount == null) return null;
  const n = parseInt(stats.subscriberCount, 10);
  return Number.isFinite(n) ? n : null;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Resolve current YouTube subscriber counts via the Data API v3.
 *
 * Fail-open: never throws; accounts that can't be resolved (deleted, hidden
 * subs, quota exhausted, no API key) are simply absent from the result array.
 *
 * @param accounts  Our tracked YouTube accounts (id + handle + profileUrl)
 * @param opts.maxSearchLookups  Cap on expensive search.list (100-unit) calls; default 25
 */
export async function fetchYouTubeSubscriberCounts(
  accounts: YtAccountRef[],
  opts?: { maxSearchLookups?: number },
): Promise<YtFollowerResult[]> {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return []; // DARK: no key → no network

  const maxSearchLookups = opts?.maxSearchLookups ?? DEFAULT_MAX_SEARCH_LOOKUPS;
  const results: YtFollowerResult[] = [];

  // ── Partition accounts into "known channel ID" vs "need resolution" ──────
  //
  // Step 1 candidates: UC… in handle OR extractable from profile_url.
  // We batch all step-1 accounts together (50 per channels.list call).
  //
  // Step 2+3 candidates: everything else.

  type AccountWithId = { acc: YtAccountRef; channelId: string };
  type AccountNeedResolution = { acc: YtAccountRef };

  const step1: AccountWithId[] = [];
  const needResolution: AccountNeedResolution[] = [];

  for (const acc of accounts) {
    // Priority: handle is a channel ID
    if (isChannelId(acc.handle)) {
      step1.push({ acc, channelId: acc.handle });
      continue;
    }
    // Fallback: extract from profile_url
    const idFromUrl = channelIdFromUrl(acc.profileUrl);
    if (idFromUrl) {
      step1.push({ acc, channelId: idFromUrl });
      continue;
    }
    needResolution.push({ acc });
  }

  // ── Step 1: batch channels.list?id= for known channel IDs ───────────────

  // Build a map from channelId → accountId so we can map back after batching
  const channelIdToAccountId = new Map<string, string>();
  for (const { acc, channelId } of step1) {
    channelIdToAccountId.set(channelId, acc.id);
  }

  const allChannelIds = step1.map(({ channelId }) => channelId);

  for (let i = 0; i < allChannelIds.length; i += BATCH_SIZE) {
    const batchIds = allChannelIds.slice(i, i + BATCH_SIZE);
    const statsMap = await fetchChannelStatsBatch(batchIds, apiKey);

    for (const [channelId, stats] of statsMap) {
      const accountId = channelIdToAccountId.get(channelId);
      if (!accountId) continue;

      const subscribers = extractSubscribers(stats);
      if (subscribers != null) {
        results.push({ accountId, subscribers });
      }
      // null → deleted/terminated/hidden → simply absent from results (fail-open)
    }
  }

  // ── Steps 2+3: per-account resolution for handles without channel IDs ────

  let searchLookupsUsed = 0;

  for (const { acc } of needResolution) {
    const handle = stripAt(acc.handle);

    // Step 2: channels.list?forHandle=
    const forHandleResult = await fetchByForHandle(handle, apiKey);
    if (forHandleResult) {
      const subscribers = extractSubscribers(forHandleResult.statistics);
      if (subscribers != null) {
        results.push({ accountId: acc.id, subscribers });
      }
      continue; // resolved (or hidden — absent)
    }

    // Step 3: search.list (expensive — respect the cap)
    if (searchLookupsUsed >= maxSearchLookups) {
      // Cap reached — skip this account
      continue;
    }

    searchLookupsUsed++;
    const resolvedChannelId = await searchForChannelId(handle, apiKey);
    if (!resolvedChannelId) continue; // search found nothing

    // Re-fetch stats for the resolved channel ID
    const statsMap = await fetchChannelStatsBatch([resolvedChannelId], apiKey);
    const stats = statsMap.get(resolvedChannelId) ?? null;
    const subscribers = extractSubscribers(stats);
    if (subscribers != null) {
      results.push({ accountId: acc.id, subscribers });
    }
  }

  return results;
}
