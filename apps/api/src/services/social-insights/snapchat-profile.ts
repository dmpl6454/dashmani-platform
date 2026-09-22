/**
 * Snapchat PUBLIC PROFILE reader — `https://www.snapchat.com/@<handle>`.
 *
 * This is a different page shape from everything else in this folder, and the distinction
 * is load-bearing:
 *   • `/p/<uuid>`            — the shape `snapchat-scraper.ts` was written for. RETIRED:
 *                              live-probed 2026-09-22, every stored `/p/<uuid>` URL on prod
 *                              now returns 404, which is why four Snapchat accounts had been
 *                              frozen on August figures.
 *   • `/@<handle>`           — THIS file. Live, canonical, 34/36 of the owner's handles
 *                              resolve, verified 12/12 from the Linode datacenter IP.
 *   • `/spotlight/<id>`      — per-post engagement, handled by `parseSnapchatSpotlightHtml`.
 *
 * ── WHAT SNAPCHAT ACTUALLY PUBLISHES HERE (all live-measured 2026-09-22) ─────────────────
 *
 * `subscriberCount` is WITHHELD on 7 of the 34 resolving profiles — it comes back as the
 * string "0" while the same page reports Spotlight posts with thousands of views. That is a
 * sentinel, not a number. Proof it cannot be recovered: five surfaces were tried (Googlebot /
 * iPhone / Chrome UAs, the `/add/` alias, `?locale=en-US`) and a brute-force scan of the
 * entire ~460KB pageProps blob found no alternative key — while a control profile that DOES
 * publish carries the count in that very same field. It is a per-profile privacy setting.
 *
 * Per-post `viewCount` uses BOTH "-1" AND "0" as withholds. Proven by cross-check: a post
 * reading "0" on the profile page returned "9228" on its own dedicated page, and "-1" stayed
 * "-1" on 6/6 dedicated pages. 74% of posts across the estate are withheld, and the
 * withholding is PER CHANNEL — nine channels publish nothing at all while two publish
 * everything. So a summed "views" column is only comparable between channels alongside its
 * coverage, which is why this module returns `viewsCovered`/`postsSeen` and never a bare sum.
 *
 * ⚠️ NEVER map either sentinel to 0. `fmtMetric` renders null as "—"; a rendered 0 asserts
 * "this channel got no views", which is the documented fabricated-zero bug class (the
 * Snapchat showLikes incident, and the Meta follower-delta one before it).
 *
 * ── THE PARTIAL RESPONSE ────────────────────────────────────────────────────────────────
 *
 * Observed three times while probing: Snapchat returns 200 with a CORRECT subscriber count
 * but an EMPTY `spotlightHighlights` array, on a profile whose own `hasSpotlightHighlights`
 * flag is true. A response that looks valid but has been stripped is the most dangerous
 * failure mode here — written naively it would record "this channel has no posts" and wipe
 * good data. `parseSnapchatProfilePage` reports it as `partial`, and the caller must treat
 * that as a fetch failure and keep the previous values.
 *
 * ── SAFETY ──────────────────────────────────────────────────────────────────────────────
 *
 * These pages are 234KB–885KB Next.js shells around a ~460KB `__NEXT_DATA__` blob, parsed on
 * the API's MAIN THREAD. That is verbatim the 2026-09-08 vector that pinned the event loop
 * for 5h44m. Therefore:
 *   • the blob is located with the exported, indexOf-based `scriptBodyAfter` — NEVER a regex.
 *     There is no regex anywhere in this file that runs over page HTML.
 *   • values are read by EXACT JSON PATH, never a recursive walk and never a raw-HTML match.
 *     The page legitimately contains OTHER creators' subscriber counts — `relatedAccountsInfo`
 *     is present on 7 of 34 profiles and carries their own `publicProfileInfo.subscriberCount`,
 *     plus every post's `creator.personCreator.followerCount`. A first-match parser is correct
 *     only by ordering luck.
 *   • the parsed username is asserted against the handle we asked for before anything is
 *     returned, so a redirect or a lookalike can never be stored under the wrong channel.
 */

import { scriptBodyAfter } from "./snapchat-scraper";

type FetchFn = typeof fetch;

const SCRAPER_UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const TIMEOUT_MS = 12_000;
/**
 * ⚠️ 100KB, NOT the 10KB floor `snapchat-scraper.ts` uses. The smallest real profile page
 * measured across all 34 resolving handles was 209KB; a 10KB floor lets every error shell
 * (the 404 body is ~6KB) through to the parser.
 */
const MIN_PAGE_LEN = 100_000;
/** Defense in depth. The largest page measured was 885KB. */
const MAX_PARSE_LEN = 4 * 1024 * 1024;
/** Snapchat returns at most ~31 Spotlight entries; the cap stops an unbounded page. */
const MAX_POSTS = 60;

/**
 * A regex capture is a V8 SlicedString that pins its ENTIRE parent — retaining 36 display
 * names out of 800KB pages measured 320MB in the analogous Facebook caption case. Everything
 * we keep is flattened. (Three lines, and a primitive that cannot drift; deliberately local
 * rather than exported across scraper modules.)
 */
function flatCopy(s: string): string {
  return Buffer.from(s, "utf8").toString("utf8");
}

export interface SnapProfileResult {
  /** True only when we parsed a complete, identity-verified page. */
  ok: boolean;
  /** True on a login wall / block / non-404 HTTP failure — the caller short-circuits on a run of these. */
  walled: boolean;
  /**
   * True when the page loaded and identified correctly but had been stripped of its content
   * (see "THE PARTIAL RESPONSE"). Caller MUST treat this as a failure, not as "no posts".
   */
  partial: boolean;
  /** Real subscriber count. null when Snapchat withholds it — never 0 for a withhold. */
  followers: number | null;
  displayName: string | null;
  bio: string | null;
  pictureUrl: string | null;
  /**
   * Snapchat's own `badge` field. 1 on 13/14 of the owner's primary accounts and 0 on all 21
   * of the monitored ones. ⚠️ Stored, NOT labelled "verified" — its meaning is undocumented
   * and 21 real channels carry 0, so rendering it as verification would mark them unverified.
   */
  badge: number | null;
  /** Sum of Spotlight views Snapchat actually published. null when it published none. */
  recentViews: number | null;
  /** How many of the posts on the page carried a real view count … */
  viewsCovered: number;
  /** … out of how many posts the page returned. The pair is the coverage disclosure. */
  postsSeen: number;
  error?: string;
}

const MISS = (error: string, over: Partial<SnapProfileResult> = {}): SnapProfileResult => ({
  ok: false, walled: false, partial: false, followers: null, displayName: null,
  bio: null, pictureUrl: null, badge: null, recentViews: null,
  viewsCovered: 0, postsSeen: 0, error, ...over,
});

/**
 * Snapchat publishes counts as STRINGS, and uses "0" and "-1" as withhold sentinels.
 *
 * ⚠️ Do NOT reuse `toCount()` from snapchat-scraper.ts here — it maps "-1" to null but
 * returns a real 0 for "0", which is exactly the fabricated zero this page must never show.
 */
function publishedCount(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? raw : null;
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!/^-?\d+$/.test(t)) return null; // bounded input: a count field, not page HTML
  const n = parseInt(t, 10);
  return n > 0 ? n : null; // "0" and "-1" are both withholds
}

/**
 * Parse a Snapchat `/@handle` profile page. PURE and synchronous — exported for tests.
 *
 * `expectedHandle` is mandatory: the returned username is asserted against it, which is the
 * one line that makes storing a stranger's numbers structurally impossible.
 */
export function parseSnapchatProfilePage(html: string, expectedHandle: string): SnapProfileResult {
  if (!html || html.length < MIN_PAGE_LEN) return MISS(`page too small (${html?.length ?? 0} bytes)`);
  const capped = html.length > MAX_PARSE_LEN ? html.slice(0, MAX_PARSE_LEN) : html;

  const block = scriptBodyAfter(capped, '<script id="__NEXT_DATA__"');
  if (!block) return MISS("no __NEXT_DATA__ block");

  let root: unknown;
  try {
    root = JSON.parse(block.body);
  } catch {
    return MISS("__NEXT_DATA__ did not parse");
  }

  // EXACT path only — no walking. See the header note on relatedAccountsInfo.
  const pageProps = (root as any)?.props?.pageProps;
  const info = pageProps?.userProfile?.publicProfileInfo;
  if (!info || typeof info !== "object") return MISS("no publicProfileInfo");

  const username = typeof info.username === "string" ? info.username : null;
  if (!username) return MISS("profile carries no username");
  if (username.trim().toLowerCase() !== expectedHandle.trim().toLowerCase()) {
    // A redirect, a rename, or a lookalike. Never store it under the handle we asked for.
    return MISS(`identity mismatch: asked for @${expectedHandle}, page is @${username}`);
  }

  const followers = publishedCount(info.subscriberCount);

  // ── per-post views ────────────────────────────────────────────────────────────────────
  // Read straight down the exact path; `creator.personCreator.followerCount` on these very
  // objects is a DIFFERENT number (always "0") and must not be confused for ours.
  const meta = Array.isArray(pageProps?.spotlightStoryMetadata) ? pageProps.spotlightStoryMetadata : [];
  const highlights = Array.isArray(pageProps?.spotlightHighlights) ? pageProps.spotlightHighlights : [];
  let viewsCovered = 0;
  let viewSum = 0;
  const postsSeen = Math.min(meta.length, MAX_POSTS);
  for (let i = 0; i < postsSeen; i++) {
    const v = publishedCount(meta[i]?.videoMetadata?.viewCount);
    if (v != null) {
      viewsCovered++;
      viewSum += v;
    }
  }

  // The stripped-but-200 response: the profile itself says it has Spotlight content, yet the
  // arrays came back empty. Treat as a failure so the caller keeps its previous values.
  const partial = highlights.length === 0 && meta.length === 0 && info.hasSpotlightHighlights === true;

  const str = (v: unknown, max: number): string | null =>
    typeof v === "string" && v.trim() ? flatCopy(v.trim().slice(0, max)) : null;

  return {
    ok: !partial,
    walled: false,
    partial,
    followers,
    displayName: str(info.title, 200),
    bio: str(info.bio, 500),
    pictureUrl: str(info.profilePictureUrl, 1000),
    badge: typeof info.badge === "number" ? info.badge : null,
    recentViews: viewsCovered > 0 ? viewSum : null,
    viewsCovered,
    postsSeen,
    ...(partial ? { error: "page returned no Spotlight content though the profile claims it has some" } : {}),
  };
}

/** The canonical public-profile URL. `?locale=en-US` is honoured and pins the page language. */
export function snapchatProfileUrl(handle: string): string {
  return `https://www.snapchat.com/@${encodeURIComponent(handle.trim().replace(/^@/, ""))}?locale=en-US`;
}

/**
 * Fetch + parse one public profile. FAIL-OPEN: any miss returns ok:false and the caller keeps
 * whatever it already had. Never throws.
 *
 * ⚠️ The kill switch is read at CALL TIME, not module load. `follower-sync.service.ts:41-47`
 * records why: a module-scope `const` made `META_SCRAPERS_ENABLED` unverifiable, because the
 * tests covering the path it guards could not turn it on.
 */
export async function scrapeSnapchatProfile(
  handle: string,
  fetchImpl: FetchFn = fetch,
): Promise<SnapProfileResult> {
  if (process.env.SC_SCRAPER_ENABLED === "0") return MISS("SC_SCRAPER_ENABLED=0");
  const clean = handle.trim().replace(/^@/, "");
  if (!clean) return MISS("empty handle");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(snapchatProfileUrl(clean), {
      headers: {
        "User-Agent": SCRAPER_UA,
        "Accept-Language": "en-US,en;q=0.9",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: controller.signal,
    });

    if (!res.ok) {
      // 404 = the handle does not exist (2 of the owner's 36 were like this). That is a real
      // answer about the handle, not a block, so it must not trip the wall short-circuit.
      return res.status === 404
        ? MISS("handle does not exist (404)")
        : MISS(`HTTP ${res.status}`, { walled: true });
    }
    if (/\/login|\/signup|accounts\.snapchat\.com|\/checkpoint/i.test(res.url)) {
      return MISS("redirected to a login/checkpoint page", { walled: true });
    }

    // ⚠️ res.text() is INSIDE the abort window. `scrapeSnapchatFollowers` clears its timer
    // right after the headers arrive, which leaves an 885KB slow-drip body bounded only by
    // undici's ~300s default — 36 of those would hold a 3-hourly sync for hours.
    const html = await res.text();
    return parseSnapchatProfilePage(html, clean);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return MISS(/abort/i.test(msg) ? `timeout after ${TIMEOUT_MS}ms` : msg.slice(0, 200));
  } finally {
    clearTimeout(timer);
  }
}
