// ── Facebook public-reel engagement scraper ──────────────────────────────────
//
// A logged-out GET of a public Facebook reel page (with a Googlebot User-Agent)
// returns the full reel HTML — NO login wall — with engagement embedded as JSON.
// This is the SAME technique the follower scraper already uses (www.facebook.com +
// Googlebot UA; see follower-sync commit b40b142). It is NOT a credentialed scrape
// and reads only public data.
//
// WHY THIS EXISTS ALONGSIDE THE GRAPH PROVIDER:
//   The Graph /insights path (facebook.provider.ts) only reaches reels on the ~70
//   Pages our System User administers (~5-15% of submitted reels). The remaining
//   ~85-95% are external creators' reels we don't administer — Graph returns
//   not_found for those. This scraper reads engagement for ANY public reel, so it
//   strictly DOMINATES the Graph path for view coverage. The provider uses Graph
//   first (exact + free for administered posts) and falls back to this scraper for
//   the not_found majority.
//
// VERIFIED LIVE AGAINST GROUND TRUTH (2026-06-25, from the Linode datacenter IP):
//   • 40/40 public reels returned HTTP 200 + full HTML, FIRST try, zero blocks.
//   • The TRUE view count is `video_view_count` — it appears EXACTLY ONCE in the
//     HTML and is STABLE across repeated fetches. Cross-checked against the Graph
//     API's authoritative `post_video_views` on reels we administer: 5/5 EXACT
//     (2=2, 1=1, 4=4 …). So scraped video_view_count == the real view count.
//   • ⚠️ `play_count` is NOT the view count — the reel page is a FEED carrying ~22
//     recommended reels' play_counts; the first-match is unstable across fetches
//     (saw 2309 / 43198 / 2428 for the SAME reel on 3 fetches). DO NOT use it.
//   • ⚠️ The og:title "43K views · 264 reactions" string is served INCONSISTENTLY
//     (present in one probe, absent 0/12 twenty minutes later). Reactions in it DID
//     match, but it's unreliable, so we parse the embedded JSON, not og:title.
//   • reactions/likes = `reaction_count`.count ; comments = `total_comment_count`.
//     These appear with video_view_count for the target reel (the carousel reels
//     only carry play_count, so anchoring on video_view_count's single occurrence
//     keeps us on the target's object).
//
// FAIL-OPEN by contract: any non-200, login redirect, timeout, or parse miss
// returns nulls — the caller keeps whatever the Graph path produced (or not_found).

import { recordApiUsage } from "../api-usage.service";

// Googlebot UA — the chrome UA returns the 604KB empty app-shell (no engagement);
// Googlebot/facebookexternalhit get the server-rendered HTML with the JSON.
const SCRAPER_UA =
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const SCRAPER_TIMEOUT_MS = 12_000;
// A real reel page is ~800KB-1MB. A login wall / error shell is < 50KB. Anything
// short means we did NOT get the reel HTML — treat as a miss, never parse it.
const MIN_REEL_HTML_LEN = 50_000;

export interface ScrapedFbEngagement {
  views: number | null;
  likes: number | null;
  comments: number | null;
  // The post caption — feeds Link Search name-search (entity extraction tags who's
  // in it). Prefer og:description (the post body, which carries the person's name)
  // over og:title (often just the Page name, e.g. "Paparazzi Reels"). Verified live
  // 2026-06-25: og:description is the richer name-bearing text for ~all reels.
  caption: string | null;
  // True when Facebook served a login/checkpoint wall or a non-200 (i.e. we were
  // BLOCKED, not "this reel has no data"). The provider counts consecutive walls to
  // trip its per-run scraper short-circuit. Absent/false on a real (even zero) reel.
  walled?: boolean;
}

const EMPTY: ScrapedFbEngagement = { views: null, likes: null, comments: null, caption: null };

// Injectable fetch for tests (no network). Defaults to global fetch.
export type FetchFn = typeof fetch;

// Decode the HTML entities Facebook uses in og tags (&#x915; Devanagari, &amp;, &quot;,
// numeric refs). Best-effort: an undecodable entity is left as-is.
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch { return _; }
    })
    .replace(/&#(\d+);/g, (_, d) => {
      try { return String.fromCodePoint(Number(d)); } catch { return _; }
    })
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// Normalize Devanagari digits (०-९) to ASCII so og:title numbers parse. Indian-locale
// reel pages render the engagement summary in Hindi numerals + unit words.
function devanagariToAscii(s: string): string {
  const map: Record<string, string> = { "०": "0", "१": "1", "२": "2", "३": "3", "४": "4", "५": "5", "६": "6", "७": "7", "८": "8", "९": "9" };
  return s.replace(/[०-९]/g, (d) => map[d] ?? d);
}

// Parse a "<number><unit> <keyword>" count out of the (decoded) og:title — the TARGET
// reel's own figure (what Facebook puts in the share preview), NOT a carousel value.
// Handles English K/M/B and Hindi units ह/हज़ार (1e3), लाख (1e5), कोटी/करोड़ (1e7).
// Returns a ROUNDED-but-CORRECT count (e.g. "264", or 1,800,000 for "१८ लाख"), or null.
function parseOgTitleCount(ogTitleDecoded: string, keywords: string[]): number | null {
  const t = devanagariToAscii(ogTitleDecoded);
  for (const kw of keywords) {
    const m = t.match(new RegExp(`([\\d.,]+)\\s*(ह|हज़ार|हजार|लाख|कोटी|करोड़|K|M|B|k|m|b)?\\s*${kw}`));
    if (!m) continue;
    const n = parseFloat(m[1].replace(/,/g, ""));
    if (!Number.isFinite(n)) continue;
    const mult: Record<string, number> = { "ह": 1e3, "हज़ार": 1e3, "हजार": 1e3, "लाख": 1e5, "कोटी": 1e7, "करोड़": 1e7, K: 1e3, k: 1e3, M: 1e6, m: 1e6, B: 1e9, b: 1e9 };
    return Math.round(n * (mult[m[2]] ?? 1));
  }
  return null;
}

// Pull the best caption from the reel HTML. og:description is the post body (richest,
// name-bearing); og:title is "<views> views · <n> reactions | <caption>" or just the
// Page name. So: prefer a meaningful og:description; else the og:title's post-`|` tail.
function parseFbCaption(html: string): string | null {
  const ogDesc = (html.match(/<meta property="og:description" content="([^"]*)"/) || [])[1] || "";
  const ogTitle = (html.match(/<meta property="og:title" content="([^"]*)"/) || [])[1] || "";

  const desc = decodeEntities(ogDesc).trim();
  if (desc.length > 3) return desc;

  // Fall back to og:title. Strip a leading "N views · M reactions | " engagement
  // prefix if present (keep only the caption after the last " | ").
  let title = decodeEntities(ogTitle).trim();
  if (title.includes(" | ")) {
    const tail = title.split(" | ").slice(1).join(" | ").trim();
    if (tail.length > 0) title = tail;
  }
  return title.length > 3 ? title : null;
}

// Parse engagement + caption out of a reel page's HTML. Exported for unit tests with
// captured fixtures. Pure + synchronous.
//
// ⚠️ TARGET-SCOPING (2026-06-26 likes fix): the reel page is a FEED carrying ~22
// recommended reels. So feed-wide JSON keys CANNOT be read by first-match:
//   • views   = `video_view_count` — appears EXACTLY ONCE (only the target reel has it;
//     carousel reels carry play_count). Verified vs Graph post_video_views 5/5 EXACT.
//   • comments = `total_comment_count` — also single-occurrence = the target's. ✓
//   • likes   = ❌ NOT the loose first `reaction_count.count` — that appears ~22 times
//     (one per carousel reel) and the first-match is a DIFFERENT reel's value (caused
//     the "7476 likes on 46 different reels" bug). The TARGET's reaction count is in
//     the og:title share-preview string ("… · 264 प्रतिक्रिया | <caption>"), rounded
//     but correct + target-scoped. We parse THAT; if og:title has no reactions segment
//     (low-engagement reel), likes = null (honest) — never a wrong carousel number.
export function parseFbReelHtml(html: string): ScrapedFbEngagement {
  if (!html || html.length < MIN_REEL_HTML_LEN) return { ...EMPTY };

  // Views: the single, stable `video_view_count` (NOT play_count — carousel noise).
  const vm = html.match(/"video_view_count"\s*:\s*(\d+)/);
  const views = vm ? Number(vm[1]) : null;

  // Comments: `total_comment_count` is single-occurrence = the target reel's. ✓
  const cm = html.match(/"total_comment_count"\s*:\s*(\d+)/);
  const comments = cm ? Number(cm[1]) : null;

  // Likes: parse the TARGET's reaction count from the og:title (rounded-correct,
  // target-scoped). NOT the loose `reaction_count` first-match (carousel noise).
  const ogTitle = (html.match(/<meta property="og:title" content="([^"]*)"/) || [])[1] || "";
  const likes = parseOgTitleCount(decodeEntities(ogTitle), ["प्रतिक्रिया", "reactions", "reaction"]);

  return {
    views: Number.isFinite(views as number) ? views : null,
    likes: Number.isFinite(likes as number) ? likes : null,
    comments: Number.isFinite(comments as number) ? comments : null,
    caption: parseFbCaption(html),
  };
}

// Fetch + parse one public reel's engagement by its numeric reel id. Fail-open:
// returns all-nulls on any non-200, login redirect, short body, timeout, or throw.
export async function scrapeFacebookReelEngagement(
  reelId: string,
  fetchImpl: FetchFn = fetch
): Promise<ScrapedFbEngagement> {
  if (!reelId || !/^\d+$/.test(reelId)) return { ...EMPTY };

  // Cost Sheet: count each scrape attempt (free public fetch; $0). Surfaces the
  // scraper's call VOLUME (the 17k-reel backfill + ongoing not_found fallback) so it
  // isn't invisible. Fire-and-forget, fail-open.
  recordApiUsage({ provider: "meta", operation: "fb-reel-scraper", calls: 1, units: 1 });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCRAPER_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`https://www.facebook.com/reel/${reelId}`, {
      headers: { "User-Agent": SCRAPER_UA, "Accept-Language": "en-US,en;q=0.9" },
      redirect: "follow",
      signal: controller.signal,
    });
    // Non-200 or a redirect to /login|/checkpoint = we were BLOCKED (not "no data").
    // Signal walled:true so the provider can short-circuit after N consecutive walls.
    if (!res.ok) return { ...EMPTY, walled: true };
    if (/\/login|\/checkpoint/i.test(res.url)) return { ...EMPTY, walled: true };
    const html = await res.text();
    return parseFbReelHtml(html);
  } catch {
    // Network error / timeout — could be a soft block; treat as walled (the provider's
    // consecutive-wall counter resets on the next success, so a one-off blip is benign).
    return { ...EMPTY, walled: true };
  } finally {
    clearTimeout(timer);
  }
}
