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
}

const EMPTY: ScrapedFbEngagement = { views: null, likes: null, comments: null };

// Injectable fetch for tests (no network). Defaults to global fetch.
export type FetchFn = typeof fetch;

// Parse the three engagement numbers out of a reel page's HTML. Exported for unit
// tests with captured fixtures. Pure + synchronous.
export function parseFbReelHtml(html: string): ScrapedFbEngagement {
  if (!html || html.length < MIN_REEL_HTML_LEN) return { ...EMPTY };

  // Views: the single, stable `video_view_count` (NOT play_count — see header note).
  const vm = html.match(/"video_view_count"\s*:\s*(\d+)/);
  const views = vm ? Number(vm[1]) : null;

  // Likes/reactions: `"reaction_count":{"count":264, ...}` — take the count.
  const rm = html.match(/"reaction_count"\s*:\s*\{[^}]*?"count"\s*:\s*(\d+)/);
  const likes = rm ? Number(rm[1]) : null;

  // Comments: `"total_comment_count":N`.
  const cm = html.match(/"total_comment_count"\s*:\s*(\d+)/);
  const comments = cm ? Number(cm[1]) : null;

  return {
    views: Number.isFinite(views as number) ? views : null,
    likes: Number.isFinite(likes as number) ? likes : null,
    comments: Number.isFinite(comments as number) ? comments : null,
  };
}

// Fetch + parse one public reel's engagement by its numeric reel id. Fail-open:
// returns all-nulls on any non-200, login redirect, short body, timeout, or throw.
export async function scrapeFacebookReelEngagement(
  reelId: string,
  fetchImpl: FetchFn = fetch
): Promise<ScrapedFbEngagement> {
  if (!reelId || !/^\d+$/.test(reelId)) return { ...EMPTY };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCRAPER_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`https://www.facebook.com/reel/${reelId}`, {
      headers: { "User-Agent": SCRAPER_UA, "Accept-Language": "en-US,en;q=0.9" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) return { ...EMPTY };
    // A redirect to /login means we got the wall, not the reel — bail.
    if (/\/login|\/checkpoint/i.test(res.url)) return { ...EMPTY };
    const html = await res.text();
    return parseFbReelHtml(html);
  } catch {
    return { ...EMPTY };
  } finally {
    clearTimeout(timer);
  }
}
