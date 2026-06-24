// Meta Graph API follower-count fetchers (current snapshot, not historical).
//
// Mirrors the instagram/facebook providers' discovery patterns + the injectable
// graphFetch seam, but reads ONLY the account-level follower/fan counts that come
// back on the me/accounts discovery call — no per-media/per-post paging. The cron
// that records follower-growth snapshots calls these once per run.
//
// Same DARK SWITCH as the providers: while META_SYSTEM_USER_TOKEN is absent,
// metaConfigured() is false and both functions return an empty Map without ever
// touching the network. On a rate-limit (graphFetch result.rateLimited === true)
// we STOP paging and return whatever was collected so far — never throw. Any other
// non-OK result also breaks the loop and returns the partial map.

import {
  graphFetch as defaultGraphFetch,
  metaConfigured,
  type GraphFetchFn,
} from "./meta-graph";

const TIMEOUT_MS = 10_000;
const PAGE_SIZE = 100;
// Account-discovery pagination guard. 38 IG accounts / 87 FB Pages on prod fit
// comfortably within 25 pages of 100 — this is a safety bound, not a deep-paging cap.
const MAX_DISCOVERY_PAGES = 25;

// Injectable Graph fetcher. Defaults to the real implementation; tests swap it via
// __setGraphFetchForTesting so they need neither a token nor the network.
let graphFetchImpl: GraphFetchFn = defaultGraphFetch;

export function __setGraphFetchForTesting(fn: GraphFetchFn | null): void {
  graphFetchImpl = fn ?? defaultGraphFetch;
}

// ── Graph response shapes (only the fields we request) ───────────────────────

interface IgFollowersAccountsResponse {
  data?: Array<{
    instagram_business_account?: {
      id?: string;
      username?: string;
      followers_count?: number;
      media_count?: number;
      follows_count?: number;
    };
  }>;
  paging?: { next?: string };
}

interface FbFollowersAccountsResponse {
  data?: Array<{
    id?: string;
    access_token?: string;
    followers_count?: number;
    fan_count?: number;
    username?: string;
    name?: string;
    tasks?: string[];
  }>;
  paging?: { next?: string };
}

// ── Instagram ────────────────────────────────────────────────────────────────

export interface IgFollowerCounts {
  followers: number;
  following: number | null;
  posts: number | null;
}

// Returns a map MULTI-KEYED so the caller can look up by whichever identifier a
// SocialAccount happens to store: the lowercased IG username AND the IG business
// account id both point at the SAME counts value. (A SocialAccount may hold a
// handle/username or, rarely, the numeric id — neither alone is guaranteed, so we
// index both.) Discovers IG Business accounts via me/accounts (extending the
// sub-field selection the IG provider uses), following paging.next until exhausted.
export async function fetchInstagramFollowerMap(): Promise<Map<string, IgFollowerCounts>> {
  const map = new Map<string, IgFollowerCounts>();

  // DARK: no token → empty map, NEVER touch the network.
  if (!metaConfigured()) return map;

  let path: string | null = "me/accounts";
  let params: Record<string, string | number | undefined> | undefined = {
    fields: "instagram_business_account{id,username,followers_count,media_count,follows_count}",
    limit: PAGE_SIZE,
  };
  let guard = 0;

  while (path && guard < MAX_DISCOVERY_PAGES) {
    guard++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await graphFetchImpl<IgFollowersAccountsResponse>(path, params, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }

    // Rate-limited → stop paging, return whatever we have. Any other failure → break.
    if (res.rateLimited) break;
    if (!res.ok || !res.data) break;

    for (const page of res.data.data ?? []) {
      const acct = page.instagram_business_account;
      const username = acct?.username;
      const followers = acct?.followers_count;
      if (username && typeof followers === "number") {
        const counts: IgFollowerCounts = {
          followers,
          following: typeof acct?.follows_count === "number" ? acct.follows_count : null,
          posts: typeof acct?.media_count === "number" ? acct.media_count : null,
        };
        // Multi-key: findable by lowercased username OR the IG business account id.
        map.set(username.toLowerCase(), counts);
        if (acct?.id) map.set(acct.id, counts);
      }
    }

    // Follow paging cursor (absolute URL already carries its params + token).
    path = res.data.paging?.next ?? null;
    params = undefined;
  }

  return map;
}

// ── Facebook ───────────────────────────────────────────────────────────────

export interface FbFollowerCounts {
  followers: number;
}

// Returns a map MULTI-KEYED so the caller can match by whichever identifier a
// SocialAccount stores. A SocialAccount holds a handle/profileUrl (e.g.
// facebook.com/paparazzziii) — NOT the numeric page id — and there is no
// page-id↔account mapping anywhere, so keying only by page id would be
// unmatchable. We therefore index each administered Page's follower count under
// the page id, the page username (if present), AND the page name (if present),
// all lowercased, so the caller can look it up by slug/handle or name. Discovers
// administered Pages via me/accounts (extending the field list the FB provider
// uses); only Pages with a non-empty tasks array (admin role) and an id are kept.
// Prefers followers_count, falling back to fan_count; an entry with no numeric
// count is skipped. Follows paging.next until exhausted.
export async function fetchFacebookFollowerMap(): Promise<Map<string, FbFollowerCounts>> {
  const map = new Map<string, FbFollowerCounts>();

  // DARK: no token → empty map, NEVER touch the network.
  if (!metaConfigured()) return map;

  let path: string | null = "me/accounts";
  let params: Record<string, string | number | undefined> | undefined = {
    fields: "id,access_token,followers_count,fan_count,username,name,tasks",
    limit: PAGE_SIZE,
  };
  let guard = 0;

  while (path && guard < MAX_DISCOVERY_PAGES) {
    guard++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await graphFetchImpl<FbFollowersAccountsResponse>(path, params, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }

    if (res.rateLimited) break;
    if (!res.ok || !res.data) break;

    for (const pg of res.data.data ?? []) {
      // Only administered Pages (with tasks) expose follower data we can trust.
      if (!pg.id || !Array.isArray(pg.tasks) || pg.tasks.length === 0) continue;
      const count = typeof pg.followers_count === "number"
        ? pg.followers_count
        : typeof pg.fan_count === "number"
          ? pg.fan_count
          : null;
      if (count != null) {
        const counts: FbFollowerCounts = { followers: count };
        // Multi-key: page id, username, and name (all lowercased) all point at the
        // same value so a SocialAccount can match by slug/handle or name.
        map.set(pg.id.toLowerCase(), counts);
        if (pg.username) map.set(pg.username.toLowerCase(), counts);
        if (pg.name) map.set(pg.name.toLowerCase().trim(), counts);
      }
    }

    path = res.data.paging?.next ?? null;
    params = undefined;
  }

  return map;
}
