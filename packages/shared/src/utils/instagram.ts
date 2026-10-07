// Instagram shortcode extraction.
//
// Mirrors `extractYouTubeVideoId` in ./youtube.ts: parse with `new URL` in a
// try/catch, validate the host, and pull the post shortcode out of the path.
//
// WHY A SHORTCODE (not a media id):
// Instagram URLs only ever expose the post *shortcode* (e.g. `DZJyjhBKN5-`), the
// short base64-ish token in `/reel/<code>`, `/p/<code>`, `/tv/<code>`. The Graph
// API media endpoint needs the NUMERIC media id, and Meta deprecated the
// shortcode→media-id lookup. The Instagram provider resolves the gap by paging
// each managed IG Business account's /media (which returns both `id` and
// `shortcode`) and building a shortcode→media map per run. So the "target id"
// this extractor returns is the shortcode, and the provider does the mapping.
//
// GUARANTEES (kept in lock-step with canonicalKey's `ig:` branch):
//  - Shortcode is CASE-SENSITIVE → never lowercased (IG codes are case-significant;
//    lowercasing would merge distinct posts).
//  - Query string (incl. the rotating `?igsh=…` share token) is stripped — the URL
//    object discards it once we read `pathname`.
//  - Supports `/reel/CODE`, `/reels/CODE`, `/p/CODE`, `/tv/CODE`, and the
//    `/<username>/reel/CODE` form.
//  - Non-URL, non-Instagram host, or no recognizable post path → null.

// Normalised hosts (www., m., mobile. stripped before matching)
const INSTAGRAM_HOST = "instagram.com";

export function extractInstagramShortcode(rawUrl: string | null | undefined): string | null {
  return parseInstagramPost(rawUrl)?.code ?? null;
}

function parseInstagramPost(rawUrl: string | null | undefined): { kind: string; code: string } | null {
  if (!rawUrl) return null;

  let url: URL;
  try {
    url = new URL(String(rawUrl).trim());
  } catch {
    return null;
  }

  // Strip www. / m. / mobile. prefixes before matching (same set canonicalKey uses).
  const host = url.hostname.toLowerCase().replace(/^(www\.|m\.|mobile\.)/, "");
  if (host !== INSTAGRAM_HOST && !host.endsWith(`.${INSTAGRAM_HOST}`)) {
    return null;
  }

  // /reel/CODE, /reels/CODE, /p/CODE, /tv/CODE — also matches the
  // /<username>/reel/CODE form because the match isn't anchored to the start.
  // Pull the raw segment first, then validate its shape.
  const m = url.pathname.match(/\/(reel|reels|p|tv)\/([^/?#]+)/i);
  if (!m || !m[2]) return null;

  const code = m[2];
  return isValidShortcode(code) ? { kind: m[1].toLowerCase(), code } : null;
}

function isValidShortcode(code: string): boolean {
  // Instagram shortcodes are base64-url-style tokens: [A-Za-z0-9_-], typically
  // ~11 chars but length varies, so we validate the charset and a sane length
  // bound rather than a fixed length. CASE PRESERVED by the caller.
  return /^[A-Za-z0-9_-]{1,30}$/.test(code);
}

/**
 * The framable player page for an Instagram post / reel URL, or null when the URL is not
 * one. Instagram's `/embed/` pages are served without X-Frame-Options, so an <iframe>
 * pointed here plays the reel in place (the post page itself refuses to be framed).
 *
 * Reels keep the `/reel/` path (`/reels/` folds into it), posts `/p/`, IGTV `/tv/`; the
 * shortcode is parsed exactly as extractInstagramShortcode does, so it is validated and
 * case-preserved, and the `?igsh=` share token is gone.
 */
export function instagramEmbedUrl(rawUrl: string | null | undefined): string | null {
  const post = parseInstagramPost(rawUrl);
  if (!post) return null;
  const path = post.kind === "reel" || post.kind === "reels" ? "reel" : post.kind;
  return `https://www.instagram.com/${path}/${post.code}/embed/`;
}
