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
// Small page size used ONLY by fetchPublicInstagramFollowerMap's "find one IG node"
// discovery. With the prod token's 87 administered Pages, asking Meta to resolve the
// instagram_business_account node for 100 Pages in a single page returns HTTP 500
// after ~30s (verified live); limit=5 returns 200 in ~2.6s with IG nodes present.
// We only need the FIRST IG id (the loop breaks at it), so a small page + paging is
// both faster and avoids the 500. Do NOT raise this — and do NOT apply it to
// fetchInstagramFollowerMap, which must page ALL administered IG accounts.
const IG_DISCOVERY_PAGE_LIMIT = 5;

// Injectable Graph fetcher. Defaults to the real implementation; tests swap it via
// __setGraphFetchForTesting so they need neither a token nor the network.
let graphFetchImpl: GraphFetchFn = defaultGraphFetch;

export function __setGraphFetchForTesting(fn: GraphFetchFn | null): void {
  graphFetchImpl = fn ?? defaultGraphFetch;
}

// ── Graph response shapes (only the fields we request) ───────────────────────

// STEP 1 (me/accounts) response. The Graph API ONLY reliably returns the nested
// instagram_business_account *id* here — deep sub-field selection
// (username/followers_count) is NOT honored (the nested object comes back as just
// {id} and the field name even gets mangled to `instagram_business_accountid` in
// the paging cursor). So we request only the id and resolve the rest per-id in
// STEP 2. Mirrors IgAccountsResponse in instagram.provider.ts.
interface IgFollowersAccountsResponse {
  data?: Array<{ instagram_business_account?: { id?: string } }>;
  paging?: { next?: string };
}

// STEP 2 (GET /{ig-id}) response — the per-account node DOES honor these flat
// fields (verified live: {"username":...,"followers_count":...,"media_count":...,
// "follows_count":...}).
interface IgUserResponse {
  id?: string;
  username?: string;
  followers_count?: number;
  media_count?: number;
  follows_count?: number;
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
// index both.)
//
// TWO-STEP (the live API forces this). me/accounts deep sub-field expansion
// (instagram_business_account{username,followers_count,...}) is NOT honored — the
// nested object returns ONLY {id}. So:
//   STEP 1: page me/accounts?fields=instagram_business_account → collect IG ids
//           (mirrors discoverIgUserIds() in instagram.provider.ts).
//   STEP 2: GET /{ig-id}?fields=username,followers_count,media_count,follows_count
//           per id → the flat fields ARE honored here (verified live).
// Honors the rateLimited sentinel at BOTH stages (stop, return partial map) and
// never throws — a per-id error or non-numeric count just skips that id.
export async function fetchInstagramFollowerMap(): Promise<Map<string, IgFollowerCounts>> {
  const map = new Map<string, IgFollowerCounts>();

  // DARK: no token → empty map, NEVER touch the network.
  if (!metaConfigured()) return map;

  // ── STEP 1: discover the IG business account ids via me/accounts paging ──────
  const igUserIds: string[] = [];
  {
    let path: string | null = "me/accounts";
    let params: Record<string, string | number | undefined> | undefined = {
      fields: "instagram_business_account",
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

      // Rate-limited → stop, return whatever we have (empty here). Any other failure → break.
      if (res.rateLimited) return map;
      if (!res.ok || !res.data) break;

      for (const page of res.data.data ?? []) {
        const igId = page.instagram_business_account?.id;
        if (igId) igUserIds.push(igId);
      }

      // Follow paging cursor (absolute URL already carries its params + token).
      path = res.data.paging?.next ?? null;
      params = undefined;
    }
  }

  // ── STEP 2: per IG id, fetch the flat profile fields ─────────────────────────
  // One Graph call per IG account. The count is bounded by STEP 1's page guard
  // (MAX_DISCOVERY_PAGES × PAGE_SIZE), and the rateLimited early-return below is
  // the real backstop against the shared ~200-call/hr Meta budget — fine for an
  // hourly cron over the handful of IG accounts the System User token administers.
  for (const igId of igUserIds) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await graphFetchImpl<IgUserResponse>(
        `${igId}`,
        { fields: "username,followers_count,media_count,follows_count" },
        { signal: controller.signal },
      );
    } finally {
      clearTimeout(timer);
    }

    // Rate-limited mid-step-2 → stop, return the partial map. Other failures → skip this id.
    if (res.rateLimited) return map;
    if (!res.ok || !res.data) continue;

    const username = res.data.username;
    const followers = res.data.followers_count;
    if (username && typeof followers === "number") {
      const counts: IgFollowerCounts = {
        followers,
        following: typeof res.data.follows_count === "number" ? res.data.follows_count : null,
        posts: typeof res.data.media_count === "number" ? res.data.media_count : null,
      };
      // Multi-key: findable by lowercased username OR the IG business account id.
      map.set(username.toLowerCase(), counts);
      map.set(igId, counts);
    }
  }

  return map;
}

// ── Instagram public (business_discovery) ─────────────────────────────────

// Response shape for the business_discovery edge. Only the fields we request.
interface BusinessDiscoveryResponse {
  business_discovery?: {
    username?: string;
    followers_count?: number;
    media_count?: number;
    id?: string;
  };
}

export interface IgPublicCounts {
  followers: number;
  mediaCount: number | null;
}

// Resolve follower counts for PUBLIC Instagram business/creator accounts we do
// NOT administer, via the Graph API business_discovery edge. Used as a fallback
// for IG rows the administered-account map (fetchInstagramFollowerMap) didn't
// cover.
//
// Endpoint shape (proven live):
//   GET /{ourIgId}?fields=business_discovery.username({handle}){followers_count,media_count}
//
// where {ourIgId} is the numeric id of ANY ONE IG business account we
// administer — used as the "requesting" node. The %7B/%7D URL-encoding of the
// curly braces is handled by graphFetch's URL-building (URLSearchParams encodes
// them automatically, graphFetch passes the fields param as a plain value).
//
// Skip cases (no throw, absent from map):
//   - HTTP 400 code 110 (error_subcode 2207013): private/personal/renamed account.
//   - Any other non-OK non-rate-limit result: also skipped (defensive).
//
// Fail-open: NEVER throws; returns whatever it resolved.
// Budget note: processes handles sequentially so we share the ~200-call/hr Meta
// budget with the administered-account sync and harvest crons.
//
// @param handles bare usernames (no leading @). Caller should strip '@'.
// @returns Map keyed by lowercased handle → counts. Rate-limited early-return
//          preserves whatever was collected up to that point.
export async function fetchPublicInstagramFollowerMap(
  handles: string[],
): Promise<Map<string, IgPublicCounts>> {
  const map = new Map<string, IgPublicCounts>();

  // DARK: no token → empty map, NEVER touch the network.
  if (!metaConfigured()) return map;

  // ── Normalise handles: strip '@', lowercase, deduplicate ─────────────────
  const normalised = [...new Set(handles.map((h) => h.replace(/^@/, "").toLowerCase()))].filter(
    Boolean,
  );
  if (normalised.length === 0) return map;

  // ── Discover ONE administered IG node (the "requesting" node for business_discovery) ──
  // We only need the FIRST id; abort as soon as we find it. Mirrors STEP 1 of
  // fetchInstagramFollowerMap — same bare-field pattern (no nested sub-selection) —
  // but with a SMALL page limit: resolving 100 Pages' IG node in one page 500s on
  // the prod token (87 Pages). limit=5 + paging finds the first IG id fast.
  let ourIgId: string | null = null;
  {
    let path: string | null = "me/accounts";
    let params: Record<string, string | number | undefined> | undefined = {
      fields: "instagram_business_account",
      limit: IG_DISCOVERY_PAGE_LIMIT,
    };
    let guard = 0;

    while (path && guard < MAX_DISCOVERY_PAGES && ourIgId === null) {
      guard++;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      let res;
      try {
        res = await graphFetchImpl<IgFollowersAccountsResponse>(path, params, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }

      if (res.rateLimited) return map; // rate-limited during discovery → empty, never throw
      if (!res.ok || !res.data) break;

      for (const page of res.data.data ?? []) {
        const igId = page.instagram_business_account?.id;
        if (igId) {
          ourIgId = igId;
          break;
        }
      }

      path = res.data.paging?.next ?? null;
      params = undefined;
    }
  }

  // No administered IG account found → can't use business_discovery. Return empty, fail-open.
  if (!ourIgId) return map;

  // ── Per-handle: call business_discovery edge ──────────────────────────────
  // The field syntax (curly-brace sub-selection) is passed as a plain string
  // value in the `fields` param; URLSearchParams inside graphFetch encodes the
  // braces as %7B/%7D automatically.
  for (const handle of normalised) {
    const fields = `business_discovery.username(${handle}){followers_count,media_count}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await graphFetchImpl<BusinessDiscoveryResponse>(
        ourIgId,
        { fields },
        { signal: controller.signal },
      );
    } finally {
      clearTimeout(timer);
    }

    // Rate-limited → stop, return partial map. Never throw.
    if (res.rateLimited) return map;

    if (!res.ok) {
      // HTTP 400 code 110 = private/personal/renamed account — expected skip case.
      // Any other non-OK result is also skipped (defensive).
      continue;
    }

    const disc = res.data?.business_discovery;
    if (!disc) continue;

    const followers = disc.followers_count;
    if (typeof followers !== "number") continue;

    map.set(handle, {
      followers,
      mediaCount: typeof disc.media_count === "number" ? disc.media_count : null,
    });
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
// unmatchable. We therefore index each administered Page's follower count under:
//   • the page id (lowercased)
//   • the page username (lowercased, if present) — a stable URL slug
//   • the page name (lowercased, if present) — to match stale SocialAccount rows
//     whose handle was stored as the human-readable display name (e.g. "Bollywood
//     Society") rather than a URL slug. Name keys risk silent collisions between
//     pages, but the practical gain (matching ~6 stale administered rows out of 87
//     that the slug key missed) outweighs the low collision probability for the
//     handful of pages a System User administers. Last-write-wins if two pages
//     share a lowercased name (harmless: both are administered pages we own).
// Discovers administered Pages via me/accounts (extending the field list the FB
// provider uses); only Pages with a non-empty tasks array (admin role) and an id
// are kept. Prefers followers_count, falling back to fan_count; an entry with no
// numeric count is skipped. Follows paging.next until exhausted.
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
        // Multi-key: page id + username + name (all lowercased). The name key lets
        // stale SocialAccount rows stored under a display name (e.g. "Bollywood
        // Society") match their administered Page without a URL slug. Last-write-wins
        // on name collisions between administered pages (acceptable — both are ours).
        map.set(pg.id.toLowerCase(), counts);
        if (pg.username) map.set(pg.username.toLowerCase(), counts);
        if (pg.name) map.set(pg.name.toLowerCase(), counts);
      }
    }

    path = res.data.paging?.next ?? null;
    params = undefined;
  }

  return map;
}

// ── Facebook lookup-key helper ────────────────────────────────────────────────

// Reserved path segments in facebook.com URLs that are NOT usernames.
// Segments matching these should not be pushed as candidate keys.
const FB_RESERVED_SEGMENTS = new Set(["share", "profile.php", "pages", "people", "groups"]);

/**
 * Given a stored FB account's handle + profileUrl, return an ordered list of
 * lowercased candidate keys to try against the administered-FB-page map
 * (keyed by id, username, and name). Pure function — no network.
 *
 * Extracts:
 *   - profile.php?id=<numeric> → the numeric id string
 *   - facebook.com/<username>  → the slug (if not a reserved segment)
 *   - the raw handle (trimmed + lowercased) — covers display-name match against
 *     the new name key in fetchFacebookFollowerMap
 *   - /share/... URLs: do NOT emit a key from the share token (opaque, can't
 *     resolve to a page id without a redirect — accepted as unresolvable)
 *
 * Output is deduped and empty strings are dropped. URL-derived identifiers
 * (id, username) are pushed before the handle so they take priority when the
 * caller tries each key in order.
 */
export function fbLookupKeys(handle: string, profileUrl: string): string[] {
  const keys: string[] = [];
  const seen = new Set<string>(); // dedup guard only
  const push = (key: string) => {
    const k = key.trim().toLowerCase();
    if (k && !seen.has(k)) {
      seen.add(k);
      keys.push(k);
    }
  };

  const url = profileUrl.trim();

  if (url) {
    // Extract a numeric id from ?id=<digits> (profile.php?id=... pattern).
    const idMatch = url.match(/[?&]id=(\d+)/);
    if (idMatch) push(idMatch[1]);

    // Extract the URL path segment after facebook.com/ (if not reserved).
    // Works for both http and https, with or without www.
    const segMatch = url.match(/facebook\.com\/([^/?#]+)/);
    if (segMatch) {
      const seg = segMatch[1];
      // Skip reserved segments (share, profile.php, pages, people, groups)
      // so we don't emit a meaningless or unsafe key.
      if (!FB_RESERVED_SEGMENTS.has(seg.toLowerCase())) {
        push(seg);
      }
    }
  }

  // Always include the handle itself (lowercased). This covers display-name
  // matches against the name key added to fetchFacebookFollowerMap.
  push(handle);

  return keys;
}
