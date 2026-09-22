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
  /**
   * The channel's permanent UC… id, once resolved. Worth persisting: a handle can be
   * renamed out from under us, an id cannot.
   */
  channelId: string | null;
  /**
   * Lifetime view count — EXACT, unlike `subscribers`. This is the honest basis for a
   * growth figure (see `subscriberPrecision`). Already present in the same `part=statistics`
   * response we were making anyway, so it costs zero additional quota.
   */
  totalViews: number | null;
  /** Public upload count. Exact. */
  videoCount: number | null;
  /**
   * ⚠️ How coarse `subscribers` is. YouTube rounds subscriber counts to 3 significant
   * figures (verified against all 16 of the estate's channels), so the reported figure only
   * moves when a channel crosses a bucket boundary — measured, seven channels cannot move
   * theirs for 15–19 consecutive days. A day-over-day subscriber delta is therefore a
   * quantisation staircase, not a measurement, and must be suppressed below this step
   * rather than rendered as a real 0.
   *
   * It also matters for provenance: CLAUDE.md records an audit rule that treats a
   * "mostly round" follower series as a scraped display string and DELETES it. Inde News'
   * genuine API series is 10,500,000 → 10,600,000. Storing the step is what distinguishes
   * "rounded by the official API" from "parsed off a page".
   *
   * null = exact (channels under 1,000 subscribers are not rounded).
   */
  subscriberPrecision: number | null;
}

// ── Internal API response shapes ──────────────────────────────────────────────

interface YtChannelStatistics {
  subscriberCount?: string;
  hiddenSubscriberCount?: boolean;
  /** Lifetime views. Exact — unlike subscriberCount, YouTube does not round this. */
  viewCount?: string;
  /** Public upload count. Exact. */
  videoCount?: string;
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
 * Whether the API actually ANSWERED during a run.
 *
 * ⚠️ WHY THIS EXISTS. `channels.list` returns HTTP 200 with `totalResults: 0` and no
 * `items` for a terminated channel — and the shape a caller sees when the quota is spent,
 * the key is rejected or the request times out is IDENTICAL: the account is simply absent
 * from the results array. Live-verified against two terminated ids. So "this channel is
 * gone" and "we never got to ask" are indistinguishable downstream, and a caller that
 * records the former would, on a quota-exhausted day, stamp "renamed, deleted or
 * terminated" on EVERY channel on the board at once.
 *
 * A caller passes one of these in and must refuse to record any per-channel verdict when
 * `apiUnavailable` is true. Deliberately run-scoped and conservative: ANY refusal or
 * transport failure anywhere in the run trips it, because there is no cheap way to know
 * which accounts a failed batch would have covered. The cost of being conservative is one
 * missed run of error-marking; the cost of being wrong is a board-wide false accusation.
 */
export interface YtRunHealth {
  apiUnavailable: boolean;
  /** First reason observed, for the log line. */
  reason: string | null;
}

/** Trip the run's health flag, keeping the FIRST reason (the one that started it). */
function markUnavailable(health: YtRunHealth | undefined, reason: string) {
  if (!health || health.apiUnavailable) return;
  health.apiUnavailable = true;
  health.reason = reason;
  console.warn(`[youtube-followers] API unavailable this run (${reason}) — per-channel verdicts suppressed`);
}

/** Read a Google API error body for the reasons that mean "we were refused, not answered". */
function refusalReason(data: { error?: { code?: number; message?: string; errors?: Array<{ reason?: string }> } }): string | null {
  const err = data.error;
  if (!err) return null;
  const reason = err.errors?.[0]?.reason ?? `httpError${err.code ?? ""}`;
  return reason;
}

/**
 * Perform a fetch with timeout; returns null on any network/abort error (fail-open).
 */
async function safeFetch(url: string, health?: YtRunHealth): Promise<Response | null> {
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
    const res = await fetch(url, { signal: controller.signal });
    // A 403 (quota/key) or 5xx is a REFUSAL, not an answer about any channel.
    if (!res.ok) markUnavailable(health, `http ${res.status}`);
    return res;
  } catch {
    markUnavailable(health, "network or timeout");
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
  health?: YtRunHealth,
): Promise<Map<string, YtChannelStatistics | null>> {
  const result = new Map<string, YtChannelStatistics | null>();

  const url =
    `${YT_BASE}/channels?part=statistics&id=${encodeURIComponent(ids.join(","))}&key=${apiKey}`;

  const res = await safeFetch(url, health);
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

  // ⚠️ A `quotaExceeded` / `dailyLimitExceeded` body arrives as HTTP 200 in some Google
  // client configurations, so the status check in safeFetch is not sufficient on its own.
  const refusal = refusalReason(data);
  if (refusal) {
    markUnavailable(health, refusal);
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
  health?: YtRunHealth,
): Promise<{ channelId: string; statistics: YtChannelStatistics } | null> {
  const url =
    `${YT_BASE}/channels?part=statistics&forHandle=${encodeURIComponent(handle)}&key=${apiKey}`;

  const res = await safeFetch(url, health);
  if (!res) return null;

  let data: YtChannelsResponse;
  try {
    data = (await res.json()) as YtChannelsResponse;
  } catch {
    return null;
  }

  const refusal = refusalReason(data);
  if (refusal) {
    markUnavailable(health, refusal);
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
async function searchForChannelId(query: string, apiKey: string, health?: YtRunHealth): Promise<string | null> {
  const url =
    `${YT_BASE}/search?part=snippet&type=channel&q=${encodeURIComponent(query)}&maxResults=1&key=${apiKey}`;

  const res = await safeFetch(url, health);
  if (!res) return null;

  let data: YtSearchResponse;
  try {
    data = (await res.json()) as YtSearchResponse;
  } catch {
    return null;
  }

  const refusal = refusalReason(data);
  if (refusal) {
    markUnavailable(health, refusal);
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

/** A non-negative integer out of one of YouTube's string-typed counters, else null. */
function intOrNull(raw: string | undefined): number | null {
  if (raw == null) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * The rounding step YouTube applied to a subscriber count.
 *
 * YouTube publicly rounds to 3 significant figures at and above 1,000 (verified against all
 * 16 channels in this estate: 10,500,000 / 3,690,000 / 1,040,000 / 33,400 / 8,100 — every
 * one an exact multiple of 10^(digits-3)). Below 1,000 the figure is exact.
 *
 * Exported for tests and for the renderer, which suppresses any delta smaller than this.
 */
export function subscriberPrecisionFor(subscribers: number): number | null {
  if (!Number.isFinite(subscribers) || subscribers < 1000) return null; // exact
  return 10 ** (Math.floor(Math.log10(subscribers)) - 2);
}

/** Everything beyond the subscriber count that the same response already carried. */
function extractExtras(
  stats: YtChannelStatistics | null,
  subscribers: number,
  channelId: string | null,
): Omit<YtFollowerResult, "accountId" | "subscribers"> {
  return {
    channelId,
    totalViews: intOrNull(stats?.viewCount),
    videoCount: intOrNull(stats?.videoCount),
    subscriberPrecision: subscriberPrecisionFor(subscribers),
  };
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
  opts?: {
    maxSearchLookups?: number;
    /**
     * Optional out-parameter. Pass one to learn whether the API actually answered this
     * run; see YtRunHealth. Omitting it preserves the previous behaviour exactly, which
     * is why every existing caller and test is unaffected.
     */
    health?: YtRunHealth;
  },
): Promise<YtFollowerResult[]> {
  const health = opts?.health;
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    // DARK: no key → no network. ⚠️ Every account is absent from the results, which must
    // NOT be read as "every channel is gone".
    markUnavailable(health, "no YOUTUBE_API_KEY");
    return [];
  }

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
    const statsMap = await fetchChannelStatsBatch(batchIds, apiKey, health);

    for (const [channelId, stats] of statsMap) {
      const accountId = channelIdToAccountId.get(channelId);
      if (!accountId) continue;

      const subscribers = extractSubscribers(stats);
      if (subscribers != null) {
        results.push({ accountId, subscribers, ...extractExtras(stats, subscribers, channelId) });
      }
      // null → deleted/terminated/hidden → simply absent from results (fail-open)
    }
  }

  // ── Steps 2+3: per-account resolution for handles without channel IDs ────

  let searchLookupsUsed = 0;

  for (const { acc } of needResolution) {
    const handle = stripAt(acc.handle);

    // Step 2: channels.list?forHandle=
    const forHandleResult = await fetchByForHandle(handle, apiKey, health);
    if (forHandleResult) {
      const subscribers = extractSubscribers(forHandleResult.statistics);
      if (subscribers != null) {
        results.push({
          accountId: acc.id,
          subscribers,
          ...extractExtras(forHandleResult.statistics, subscribers, forHandleResult.channelId),
        });
      }
      continue; // resolved (or hidden — absent)
    }

    // Step 3: search.list (expensive — respect the cap)
    if (searchLookupsUsed >= maxSearchLookups) {
      // Cap reached — skip this account
      continue;
    }

    searchLookupsUsed++;
    const resolvedChannelId = await searchForChannelId(handle, apiKey, health);
    if (!resolvedChannelId) continue; // search found nothing

    // Re-fetch stats for the resolved channel ID
    const statsMap = await fetchChannelStatsBatch([resolvedChannelId], apiKey, health);
    const stats = statsMap.get(resolvedChannelId) ?? null;
    const subscribers = extractSubscribers(stats);
    if (subscribers != null) {
      results.push({ accountId: acc.id, subscribers, ...extractExtras(stats, subscribers, resolvedChannelId) });
    }
  }

  return results;
}

// ── Add-flow resolver ─────────────────────────────────────────────────────────

export interface YtResolved {
  channelId: string;
  title: string;
  handle: string | null;
  subscribers: number | null;
  subscriberPrecision: number | null;
  totalViews: number | null;
  videoCount: number | null;
  thumbnailUrl: string | null;
}

/**
 * Resolve ONE channel from whatever an admin pasted — a UC… id, a `/channel/UC…` URL, an
 * `@handle`, or a `/@handle` URL — and return enough to confirm it is the right channel
 * before anything is stored.
 *
 * ⚠️ This exists so a typo fails LOUDLY at the moment of entry. Two of the 36 Snapchat
 * handles the owner supplied were wrong, and one of them (`bollywodpaps`, a missing "o")
 * hid the largest account in that estate. A row that silently never resolves is worse than
 * a rejected form.
 *
 * ⚠️ Deliberately avoids `search.list` (100 quota units). `channels.list` by id or
 * forHandle is 1 unit, and forHandle resolved 12/12 of the real handles in this estate —
 * its documented unreliability is for STALE or misspelled handles, which is precisely the
 * case we want to reject rather than guess around.
 *
 * Fail-open: returns null on any miss. Never throws.
 */
export async function resolveYouTubeChannel(input: string): Promise<YtResolved | null> {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return null;

  const raw = input.trim();
  if (!raw) return null;

  const fromUrl = channelIdFromUrl(raw);
  const handleFromUrl = raw.match(/\/@([^/?#\s]+)/)?.[1] ?? null;
  const id = fromUrl ?? (isChannelId(raw) ? raw : null);
  const handle = handleFromUrl ?? (id ? null : stripAt(raw));

  const url = id
    ? `${YT_BASE}/channels?part=snippet,statistics&id=${encodeURIComponent(id)}&key=${apiKey}`
    : `${YT_BASE}/channels?part=snippet,statistics&forHandle=${encodeURIComponent(stripAt(handle ?? ""))}&key=${apiKey}`;

  const res = await safeFetch(url);
  if (!res) return null;

  let data: {
    items?: Array<{
      id: string;
      snippet?: { title?: string; customUrl?: string; thumbnails?: { default?: { url?: string } } };
      statistics?: YtChannelStatistics;
    }>;
  };
  try {
    data = (await res.json()) as typeof data;
  } catch {
    return null;
  }

  const item = data.items?.[0];
  if (!item) return null;

  const stats = item.statistics ?? {};
  const subscribers = extractSubscribers(stats);
  return {
    channelId: item.id,
    title: item.snippet?.title ?? item.id,
    handle: item.snippet?.customUrl ? stripAt(item.snippet.customUrl) : (handle ? stripAt(handle) : null),
    subscribers,
    subscriberPrecision: subscribers != null ? subscriberPrecisionFor(subscribers) : null,
    totalViews: intOrNull(stats.viewCount),
    videoCount: intOrNull(stats.videoCount),
    thumbnailUrl: item.snippet?.thumbnails?.default?.url ?? null,
  };
}
