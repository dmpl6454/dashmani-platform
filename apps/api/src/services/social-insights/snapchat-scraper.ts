// ── Snapchat public-profile FOLLOWER-COUNT scraper ───────────────────────────
//
// Reads ONLY the creator's follower/subscriber count from their public profile
// page. Our accounts' real profile is snapchat.com/p/<uuid>, reached via the
// /t/<code> share link stored in profile_url (NOT /add/<handle> — that 404s for
// our accounts; see snapchatCandidateUrls). The count is embedded as a JSON-LD
// FollowAction (userInteractionCount) + inline "subscriberCount":"N".
//
// ⚠️⚠️ FOLLOWER COUNT IS THE ONLY SCRAPEABLE METRIC. Views/likes/shares are NOT
// available and must NEVER be parsed from this page. Live-verified from the Linode
// IP (2026-07-01): on a POST page (/p/<uuid>/<storyId>?chapterid=…) the per-post
// engagement fields are served as SENTINELS — `"viewCount":"-1"`, `"shareCount":"0"`,
// plus a literal `"{viewCount}"` UI template — and there is NO WatchAction/ViewAction/
// LikeAction. Snapchat deliberately withholds per-post engagement from logged-out/bot
// requests. The ONLY real InteractionCounter on the page is the profile-level
// FollowAction (followers). DO NOT add a views/likes parser here or key any metric on
// `viewCount`/`shareCount`/`play_count` — those are noise/sentinels (same trap as the
// Facebook carousel `play_count`). Per-post Snapchat engagement is only reachable via
// the allowlisted Snap Public Profile API (Spotlight views/shares), never by scraping —
// see docs/SNAPCHAT-CONNECTION-STEPS.md.
//
// ⚠️ VERIFICATION NOTE: This scraper must be live-verified from the Linode
// datacenter IP before relying on it. Residential success ≠ datacenter success
// (Snapchat's bot-detection may differ by origin IP). See CLAUDE.md pattern:
// "always live-probe a new scraper FROM THE LINODE IP".
//
// FAIL-OPEN contract: any non-200, login wall, parse miss, or throw returns
// null — the caller keeps the existing manual value unchanged. This scraper
// never blocks the sync run.
//
// Kill switch: SC_SCRAPER_ENABLED=0 disables the scraper entirely.
// Polite delay: SC_SCRAPER_DELAY_MS (default 500ms) between requests.

const SC_SCRAPER_ENABLED = process.env.SC_SCRAPER_ENABLED !== "0";
export const SC_SCRAPER_DELAY_MS = parseInt(process.env.SC_SCRAPER_DELAY_MS ?? "500", 10);

const SCRAPER_UA =
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const TIMEOUT_MS = 12_000;
// A real Snapchat profile page is > 50KB. A login/bot wall is much smaller.
const MIN_PAGE_LEN = 10_000;

export interface ScrapedSnapchatFollowers {
  followers: number | null;
  // True if we got a hard block / login wall — caller can count consecutive
  // blocks and short-circuit.
  walled?: boolean;
}

const MISS: ScrapedSnapchatFollowers = { followers: null };

export type FetchFn = typeof fetch;

// ── HTML parsers (exported for unit tests) ───────────────────────────────────

import { recordApiUsage } from "../api-usage.service";

// Decode numeric HTML entities like &#x38; → &
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"');
}

// Normalise "1.2M", "553K", "14,163,052", "1.41 crore" etc. → integer
function parseSnapCount(raw: string): number | null {
  const s = raw.replace(/,/g, "").trim();
  const m = s.match(/^([\d.]+)\s*([KkMmBbLlCc]|thousand|million|billion|lakh|crore)?/i);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const u = (m[2] || "").toLowerCase();
  if (u === "k") n *= 1_000;
  else if (u === "m") n *= 1_000_000;
  else if (u === "b") n *= 1_000_000_000;
  else if (u === "l") n *= 100_000;
  else if (u === "c") n *= 10_000_000;
  else if (u === "thousand") n *= 1_000;
  else if (u === "lakh") n *= 100_000;
  else if (u === "million") n *= 1_000_000;
  else if (u === "crore") n *= 10_000_000;
  else if (u === "billion") n *= 1_000_000_000;
  return Math.round(n);
}

/**
 * Parse a subscriber count out of a Snapchat public-profile HTML page.
 * Exported for unit tests with fixture HTML — pure + synchronous.
 *
 * Strategy (in priority order):
 *  1. __NEXT_DATA__ inline JSON  → subscriberCount / followerCount
 *  2. JSON-LD <script>           → interactionStatistic
 *  3. og:description             → "N Subscribers"
 *  4. Inline text patterns       → "N Subscribers" / "N followers"
 */
export function parseSnapchatProfileHtml(html: string): number | null {
  if (!html || html.length < MIN_PAGE_LEN) return null;

  // ── Strategy 1: __NEXT_DATA__ / inline JSON ───────────────────────────────
  // Snapchat's Next.js shell embeds page props as window.__NEXT_DATA__
  const nextData = html.match(/<script id="__NEXT_DATA__"[^>]*>({[\s\S]*?})<\/script>/);
  if (nextData) {
    try {
      const parsed = JSON.parse(nextData[1]);
      // Traverse common paths: pageProps.userProfile.subscriberCount etc.
      const candidates = [
        parsed?.props?.pageProps?.userProfile?.subscriberCount,
        parsed?.props?.pageProps?.profile?.subscriberCount,
        parsed?.props?.pageProps?.snapchatUser?.subscriberCount,
        parsed?.props?.pageProps?.userProfile?.followerCount,
        parsed?.props?.pageProps?.profile?.followerCount,
      ];
      for (const c of candidates) {
        if (typeof c === "number" && c > 0) return c;
        if (typeof c === "string") {
          const n = parseSnapCount(c);
          if (n && n > 0) return n;
        }
      }
    } catch { /* JSON parse fail — fall through */ }
  }

  // ── Strategy 2: JSON-LD <script type="application/ld+json"> ─────────────
  // The live /p/<uuid> public-profile page is a schema.org ProfilePage whose
  // FollowAction stat is NESTED under mainEntity (an Organization), and whose
  // interactionType is an OBJECT ({"@type":"FollowAction"}), not a string URL.
  // We therefore (a) search interactionStatistic at the top level AND under
  // mainEntity, and (b) match interactionType whether it's a string ("…/FollowAction")
  // or an object ({"@type":"FollowAction"}).
  const isFollowType = (t: unknown): boolean => {
    if (typeof t === "string") return t.toLowerCase().includes("follow");
    if (t && typeof t === "object") {
      const at = (t as any)["@type"];
      return typeof at === "string" && at.toLowerCase().includes("follow");
    }
    return false;
  };
  const followCountFromStats = (stats: unknown): number | null => {
    if (!Array.isArray(stats)) return null;
    for (const stat of stats) {
      const c = stat?.userInteractionCount;
      const n = typeof c === "number" ? c : typeof c === "string" ? parseSnapCount(c) : null;
      if (n && n > 0 && isFollowType(stat?.interactionType)) return n;
    }
    return null;
  };
  const ldBlocks = html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g);
  for (const block of ldBlocks) {
    try {
      const ld = JSON.parse(block[1]);
      // Check both top-level and mainEntity (the real page nests the stat there).
      const fromTop = followCountFromStats(ld?.interactionStatistic);
      if (fromTop) return fromTop;
      const fromMain = followCountFromStats(ld?.mainEntity?.interactionStatistic);
      if (fromMain) return fromMain;
      // fallback: any key called subscriberCount / followerCount at top level or on mainEntity
      for (const src of [ld, ld?.mainEntity]) {
        const top = src?.subscriberCount ?? src?.followerCount ?? src?.numberOfSubscribers;
        if (typeof top === "number" && top > 0) return top;
        if (typeof top === "string") {
          const n = parseSnapCount(top);
          if (n && n > 0) return n;
        }
      }
    } catch { /* ignore */ }
  }

  // ── Strategy 3: og:description ───────────────────────────────────────────
  // Snapchat often puts "N Subscribers" in the og:description meta tag.
  const ogDesc = html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/i)
    ?? html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:description"/i);
  if (ogDesc) {
    const desc = decodeEntities(ogDesc[1]);
    const m = desc.match(/([\d,.]+[KkMmBb]?)\s*[Ss]ubscribers?/);
    if (m) {
      const n = parseSnapCount(m[1]);
      if (n && n > 0) return n;
    }
    // Indian locale: "N अनुयायी" (followers in Hindi) or "N सदस्य"
    const mHi = desc.match(/([\d,.]+[KkMmBb]?)\s*(?:अनुयायी|सदस्य)/);
    if (mHi) {
      const n = parseSnapCount(mHi[1]);
      if (n && n > 0) return n;
    }
  }

  // ── Strategy 4: inline text / JSON patterns ──────────────────────────────
  // NOTE: the value may be quoted ("subscriberCount":"98100") or bare
  // ("subscriberCount":98100) — accept both. The optional quote before the digits
  // is what makes this match the real /p/<uuid> page. The `\d` requirement also
  // skips the Hindi UI-template decoys like "{subscriberCount} फ़ॉलोअर" (no digits).
  const patterns: RegExp[] = [
    /"subscriberCount"\s*:\s*"?(\d+)"?/,
    /"followerCount"\s*:\s*"?(\d+)"?/,
    /"subscriber_count"\s*:\s*"?(\d+)"?/,
    /"follower_count"\s*:\s*"?(\d+)"?/,
    // plain text: "1.2M Subscribers" or "1,234 subscribers"
    /([\d,.]+[KkMmBb]?)\s*[Ss]ubscribers?/,
    /([\d,.]+[KkMmBb]?)\s*[Ff]ollowers?/,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) {
      const n = parseSnapCount(m[1]);
      if (n && n > 0) return n;
    }
  }

  return null;
}

// ── Network fetcher ───────────────────────────────────────────────────────────

/**
 * Build the ordered list of candidate profile URLs to scrape.
 *
 * ⚠️ LIVE-VERIFIED 2026-07-01: the real Snapchat accounts we track are NOT
 * `snapchat.com/add/<username>` profiles — that path 404s for all of them. Their
 * real public profile is a `snapchat.com/p/<uuid>` page, reached via the `/t/<code>`
 * share link stored in `profile_url`. The `/p/<uuid>` page returns HTTP 200 with the
 * subscriber count in JSON-LD (FollowAction) + inline `"subscriberCount":"N"`.
 * So we try the STORED profile_url FIRST (redirect:"follow" resolves /t/ → /p/),
 * then fall back to the legacy handle-based paths for any account that happens to
 * be an /add/ profile. `t.snapchat.com/<code>` links in the data are dead (404) —
 * they're tried (harmless) and simply miss.
 */
export function snapchatCandidateUrls(handle: string, profileUrl?: string | null): string[] {
  const urls: string[] = [];
  const p = (profileUrl || "").trim();
  // Only add http(s) profile URLs; a bare handle stored in profile_url is useless here.
  if (/^https?:\/\//i.test(p)) urls.push(p);
  const clean = (handle || "").replace(/^@/, "").split("?")[0].trim();
  if (clean) {
    urls.push(`https://www.snapchat.com/add/${encodeURIComponent(clean)}`);
    urls.push(`https://story.snapchat.com/@${encodeURIComponent(clean)}`);
  }
  // De-dupe while preserving order.
  return Array.from(new Set(urls));
}

/**
 * Scrape the follower/subscriber count for a public Snapchat account.
 *
 * Pass the account's stored `profileUrl` (a `/t/<code>` or `/p/<uuid>` link) — it is
 * tried FIRST because that is where the count actually lives (see
 * snapchatCandidateUrls). The `handle` is used to build legacy `/add/` fallbacks.
 *
 * FAIL-OPEN: returns { followers: null } on any miss/timeout/parse-fail (caller keeps
 * the existing value), or { followers: null, walled: true } on a hard block/login wall.
 * Logs one line per account so a future "why is X still 0?" is answerable from pm2 logs
 * (the previous silent version is exactly why this bug went undiagnosed).
 */
export async function scrapeSnapchatFollowers(
  handle: string,
  fetchImpl: FetchFn = fetch,
  profileUrl?: string | null,
): Promise<ScrapedSnapchatFollowers> {
  if (!SC_SCRAPER_ENABLED) return MISS;

  const urls = snapchatCandidateUrls(handle, profileUrl);
  if (urls.length === 0) {
    console.log(`[snapchat-scraper] ${handle || "(no handle)"}: no candidate URL (no http profile_url, no handle) — skip`);
    return MISS;
  }

  let sawWall = false;
  for (const url of urls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, {
        headers: {
          "User-Agent": SCRAPER_UA,
          "Accept-Language": "en-US,en;q=0.9",
          Accept: "text/html,application/xhtml+xml",
        },
        redirect: "follow",
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        if (res.status === 404) continue; // dead/wrong URL — try next candidate
        sawWall = true;
        continue;
      }
      // Redirect to a login/auth page = walled
      if (/\/login|\/signup|\/accounts\/login/i.test(res.url)) {
        sawWall = true;
        continue;
      }

      const html = await res.text();
      const followers = parseSnapchatProfileHtml(html);
      if (followers !== null) {
        console.log(`[snapchat-scraper] ${handle}: ${followers} (via ${url} → ${res.url})`);
        return { followers };
      }
      // Page loaded but no count found — try the next candidate.
    } catch {
      clearTimeout(timer);
      // Timeout / network error — try next candidate.
    }
  }

  // All candidates failed or returned no count.
  console.log(`[snapchat-scraper] ${handle}: no count found (${urls.length} URL(s) tried${sawWall ? ", saw wall/error" : ", all 404/miss"})`);
  return sawWall ? { followers: null, walled: true } : MISS;
}

// ── Snapchat public Spotlight ENGAGEMENT scraper ─────────────────────────────
//
// A logged-out GET of a public Spotlight page (with a Googlebot User-Agent)
// returns the full page HTML — NO login wall — with engagement embedded in a
// Next.js `__NEXT_DATA__` JSON blob. This is the SAME technique the Facebook reel
// scraper uses (facebook-scraper.ts) and the follower scraper above uses. It reads
// only public data, no credentials.
//
// VERIFIED LIVE FROM THE LINODE DATACENTER IP (2026-07-14):
//   • https://www.snapchat.com/spotlight/<id> → HTTP 200, ~500KB HTML, no wall.
//   • __NEXT_DATA__.props.pageProps.spotlightFeed.spotlightStories[0] IS the
//     spotlight in the URL (verified: the URL's id appears in stories[0]). The
//     other ~24 stories are RECOMMENDED-FEED NEIGHBORS (different creators). So
//     we read stories[0] ONLY — never first-match viewCount across the page
//     (that gives a neighbor's number, the same trap as FB play_count).
//   • stories[0].metadata.engagementStats = { viewCount, shareCount, commentCount,
//     boostCount, recommendCount } (all STRINGS). STABLE across refetches.
//   • Ephemeral STORY pages (from /t/ shares that aren't spotlights) serve
//     viewCount:"-1" — a sentinel, NOT a real count. We map -1 → null.
//   • Snapchat exposes NO like metric for Spotlight → `likes` is ALWAYS null.
//   • caption = videoMetadata.embeddedTextCaption (fallback: .description).
//
// FAIL-OPEN by contract: any non-200, login redirect, short body, missing blob,
// parse error, or timeout returns nulls — the caller keeps whatever it had.

// Googlebot UA — verified to return the server-rendered HTML with __NEXT_DATA__.
const SPOTLIGHT_SCRAPER_UA =
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const SPOTLIGHT_SCRAPER_TIMEOUT_MS = 12_000;
// A real spotlight page is ~300-540KB. A login wall / error shell is far shorter.
const MIN_SPOTLIGHT_HTML_LEN = 50_000;

export interface ScrapedSnapEngagement {
  views: number | null;
  likes: number | null;     // ALWAYS null — Snapchat has no public Spotlight like metric.
  comments: number | null;
  shares: number | null;
  caption: string | null;
  // True when we were BLOCKED (login/checkpoint redirect or non-200), NOT "no data".
  // The provider counts consecutive walls to trip its per-run short-circuit.
  walled?: boolean;
}

const SPOTLIGHT_EMPTY: ScrapedSnapEngagement = { views: null, likes: null, comments: null, shares: null, caption: null };

// Parse a string stat → a positive integer, mapping the -1 Story sentinel and any
// non-positive / non-numeric value to null.
function toCount(v: unknown): number | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  if (typeof v === "string" && v.trim() === "") return null; // Number("") is 0, not "no data"
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null; // -1 sentinel → null
  return n;
}

// Pull the __NEXT_DATA__ JSON blob and read spotlightStories[0]. Pure + synchronous.
// Exported for unit tests with captured fixtures.
export function parseSnapchatSpotlightHtml(html: string): ScrapedSnapEngagement {
  if (!html || html.length < MIN_SPOTLIGHT_HTML_LEN) return { ...SPOTLIGHT_EMPTY };

  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m || !m[1]) return { ...SPOTLIGHT_EMPTY };

  let data: any;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return { ...SPOTLIGHT_EMPTY };
  }

  const stories = data?.props?.pageProps?.spotlightFeed?.spotlightStories;
  if (!Array.isArray(stories) || stories.length === 0) return { ...SPOTLIGHT_EMPTY };

  // TARGET IS ALWAYS index 0 (the URL's spotlight). Never scan neighbors.
  const meta = stories[0]?.metadata ?? {};
  const stats = meta.engagementStats ?? {};
  const vmeta = meta.videoMetadata ?? {};

  const caption =
    (typeof vmeta.embeddedTextCaption === "string" && vmeta.embeddedTextCaption.trim()) ||
    (typeof vmeta.description === "string" && vmeta.description.trim()) ||
    null;

  return {
    views: toCount(stats.viewCount),
    likes: null, // Snapchat has no public Spotlight like metric — honest null.
    comments: toCount(stats.commentCount),
    shares: toCount(stats.shareCount),
    caption: caption || null,
  };
}

// Fetch + parse one public Spotlight's engagement by its spotlight id. Fail-open:
// returns all-null (walled:true on a block/error) on any non-200, login redirect,
// short body, missing blob, parse miss, or timeout.
export async function scrapeSnapchatSpotlightEngagement(
  spotlightId: string,
  fetchImpl: FetchFn = fetch
): Promise<ScrapedSnapEngagement> {
  if (!spotlightId || !/^[A-Za-z0-9_-]{8,}$/.test(spotlightId)) return { ...SPOTLIGHT_EMPTY };

  // Cost Sheet: count each scrape attempt (free public fetch; $0). Fire-and-forget.
  recordApiUsage({ provider: "meta", operation: "snap-spotlight-scraper", calls: 1, units: 1 });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SPOTLIGHT_SCRAPER_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`https://www.snapchat.com/spotlight/${spotlightId}`, {
      headers: { "User-Agent": SPOTLIGHT_SCRAPER_UA, "Accept-Language": "en-US,en;q=0.9" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) return { ...SPOTLIGHT_EMPTY, walled: true };
    if (/accounts\.snapchat\.com|\/login|\/checkpoint/i.test(res.url)) return { ...SPOTLIGHT_EMPTY, walled: true };
    const html = await res.text();
    return parseSnapchatSpotlightHtml(html);
  } catch {
    return { ...SPOTLIGHT_EMPTY, walled: true };
  } finally {
    clearTimeout(timer);
  }
}
