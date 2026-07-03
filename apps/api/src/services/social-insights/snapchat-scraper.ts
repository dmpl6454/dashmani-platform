// ── Snapchat public-profile follower-count scraper ───────────────────────────
//
// Snapchat public creator profiles expose a "Subscribers" count on their
// public profile page at https://www.snapchat.com/add/<handle>.
// The page is server-rendered and returns the count in multiple embedded
// formats (JSON-LD, __NEXT_DATA__, og:description, plain text patterns).
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
  const ldBlocks = html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g);
  for (const block of ldBlocks) {
    try {
      const ld = JSON.parse(block[1]);
      // schema.org Person / ProfilePage / interactionStatistic
      const stats: any[] = ld?.interactionStatistic ?? [];
      for (const stat of stats) {
        if (
          typeof stat?.userInteractionCount === "number" &&
          (stat?.interactionType === "https://schema.org/FollowAction" ||
           stat?.interactionType === "http://schema.org/FollowAction" ||
           String(stat?.interactionType).toLowerCase().includes("follow"))
        ) {
          if (stat.userInteractionCount > 0) return stat.userInteractionCount;
        }
      }
      // fallback: any key called subscriberCount / followerCount at top level
      const top = ld?.subscriberCount ?? ld?.followerCount ?? ld?.numberOfSubscribers;
      if (typeof top === "number" && top > 0) return top;
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
    // Indian locale: "N अनुयायी" (followers in Hindi), "N सदस्य", or
    // "N सब्स्क्राइबर" (Hindi transliteration of "subscriber" — used on
    // Snapchat's Hindi-locale profile pages, e.g. "147k सब्स्क्राइबर").
    const mHi = desc.match(/([\d,.]+[KkMmBb]?)\s*(?:अनुयायी|सदस्य|सब्स्क्राइबर)/);
    if (mHi) {
      const n = parseSnapCount(mHi[1]);
      if (n && n > 0) return n;
    }
  }

  // ── Strategy 4: inline text / JSON patterns ──────────────────────────────
  const patterns: RegExp[] = [
    /"subscriberCount"\s*:\s*(\d+)/,
    /"followerCount"\s*:\s*(\d+)/,
    /"subscriber_count"\s*:\s*(\d+)/,
    /"follower_count"\s*:\s*(\d+)/,
    // plain text: "1.2M Subscribers" or "1,234 subscribers"
    /([\d,.]+[KkMmBb]?)\s*[Ss]ubscribers?/,
    /([\d,.]+[KkMmBb]?)\s*[Ff]ollowers?/,
    // Hindi: "147k सब्स्क्राइबर" (used on Hindi-locale profile pages)
    /([\d,.]+[KkMmBb]?)\s*सब्स्क्राइबर/,
    /([\d,.]+[KkMmBb]?)\s*(?:अनुयायी|सदस्य)/,
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

// UUID format: 8-4-4-4-12 hex chars (Snapchat profile_id from /p/<uuid> URLs)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Scrape the follower/subscriber count for a public Snapchat profile.
 *
 * Accepts either a plain handle OR a profile UUID (from /p/<uuid> share URLs).
 *
 * Tries in order:
 *  — UUID input:
 *    1. https://www.snapchat.com/p/<uuid>             (direct profile page)
 *  — Handle input:
 *    1. https://www.snapchat.com/add/<handle>          (main profile page)
 *    2. https://story.snapchat.com/@<handle>            (story/public profile)
 *
 * Returns { followers: null, walled: true } if blocked, { followers: null }
 * on a parse miss (the account page loaded but had no count — likely a private
 * or non-creator account).
 */
export async function scrapeSnapchatFollowers(
  handle: string,
  fetchImpl: FetchFn = fetch,
): Promise<ScrapedSnapchatFollowers> {
  if (!SC_SCRAPER_ENABLED) return MISS;
  const clean = handle.replace(/^@/, "").split("?")[0].trim();
  if (!clean) return MISS;

  // If the input is a UUID (profile_id extracted from a /p/<uuid>/... share
  // URL), go directly to the creator's public profile page. This avoids
  // needing to know the human-readable handle for accounts whose stored
  // profileUrl is in the /p/<uuid> format rather than /add/<handle>.
  const urls = UUID_RE.test(clean)
    ? [`https://www.snapchat.com/p/${clean}`]
    : [
        `https://www.snapchat.com/add/${encodeURIComponent(clean)}`,
        `https://story.snapchat.com/@${encodeURIComponent(clean)}`,
      ];

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
        if (res.status === 404) continue; // try next URL
        return { followers: null, walled: true };
      }
      // Redirect to a login/auth page = walled
      if (/\/login|\/signup|\/accounts\/login/i.test(res.url)) {
        return { followers: null, walled: true };
      }

      const html = await res.text();
      const followers = parseSnapchatProfileHtml(html);
      if (followers !== null) return { followers };
      // Count was not found in this URL — try the next
    } catch {
      clearTimeout(timer);
      // Timeout / network error — treat as a soft wall for this URL; try next
    }
  }

  // Both URLs failed or returned no count
  return MISS;
}
