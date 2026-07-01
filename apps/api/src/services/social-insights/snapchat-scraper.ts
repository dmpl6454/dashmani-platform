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
