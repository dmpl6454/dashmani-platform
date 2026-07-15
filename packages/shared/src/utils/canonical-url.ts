import { extractYouTubeVideoId } from "./youtube";
import { extractSnapchatSpotlightId } from "./snapchat";

/**
 * Canonical de-duplication key for a social-media link.
 *
 * WHY THIS EXISTS
 * ---------------
 * Daily-report link dedupe used to key on `url.trim().toLowerCase()` — the full
 * URL including its query string. Instagram regenerates the `?igsh=…` share
 * token on every "Copy link", so the *same* reel copied twice produced two
 * different strings and slipped past both the in-submission and cross-day dedupe.
 * This collapses recognized platforms to a stable content id so the same post is
 * one key regardless of tracking params, while leaving everything we don't
 * recognize at exactly the old behavior.
 *
 * GUARANTEES (do not weaken these — they prevent over-collapsing distinct posts):
 *  - Instagram reel/post/tv shortcodes are CASE-SENSITIVE → never lowercased.
 *  - YouTube video ids are CASE-SENSITIVE (`dQw4w9WgXcQ` ≠ `dqw4w9wgxcq`) →
 *    never lowercased. Reuses `extractYouTubeVideoId` (validates the 11-char id).
 *  - Facebook: only unambiguous NUMERIC id forms (`/reel/123`, `/videos/123`,
 *    `watch?v=123`) are canonicalized. Opaque `/share/r/…`, `/posts/…`,
 *    `story.php`, and `pfbid…` permalinks FALL THROUGH to the full-URL fallback
 *    so two different opaque shares are never merged.
 *  - Anything unrecognized, non-URL, or empty → `url.trim().toLowerCase()`,
 *    byte-identical to the old key. Zero behavior change for those.
 *
 * The DB always stores the raw URL; this key is computed fresh on read on both
 * the write side (submit) and the read side (cross-day map), so there is no
 * migration and the change is fully reversible.
 */
export function canonicalKey(rawUrl: string | null | undefined): string {
  if (!rawUrl) return "";
  const s = String(rawUrl).trim();
  if (!s) return "";

  let url: URL;
  try {
    url = new URL(s);
  } catch {
    // Not a parseable URL → behave exactly like the old key.
    return s.toLowerCase();
  }

  // Normalize only the host (strip the mobile/www prefixes). Never touch path case.
  const host = url.hostname.toLowerCase().replace(/^(www\.|m\.|mobile\.)/, "");

  // ── Instagram ──────────────────────────────────────────────────────────
  // /reel/CODE, /reels/CODE, /p/CODE, /tv/CODE — also the /<username>/reel/CODE form.
  if (host === "instagram.com" || host.endsWith(".instagram.com")) {
    const m = url.pathname.match(/\/(?:reel|reels|p|tv)\/([^/]+)/i);
    if (m && m[1]) return `ig:${m[1]}`; // shortcode kept case-sensitive
  }

  // ── YouTube ────────────────────────────────────────────────────────────
  // Delegates to the shared extractor (handles youtu.be, watch?v, shorts, embed,
  // live, validates the 11-char id, strips www./m.).
  if (
    host === "youtube.com" ||
    host.endsWith(".youtube.com") ||
    host === "youtu.be"
  ) {
    const id = extractYouTubeVideoId(s);
    if (id) return `yt:${id}`; // video id kept case-sensitive
  }

  // ── Facebook (numeric-id forms ONLY) ─────────────────────────────────────
  // Stable numeric ids are safe to canonicalize. Opaque shares/permalinks are not,
  // and must fall through to the full-URL fallback.
  if (host === "facebook.com" || host.endsWith(".facebook.com") || host === "fb.watch") {
    const v = url.searchParams.get("v");
    if (v && /^\d+$/.test(v)) return `fb:${v}`;
    const m = url.pathname.match(/^\/(?:reel|videos|video)\/(\d+)(?:\/|$)/i);
    if (m && m[1]) return `fb:${m[1]}`;
    // /share/r/…, /posts/…, /story.php, pfbid… → intentionally fall through.
  }

  // ── Snapchat (Spotlight only) ──────────────────────────────────────────────
  // A RESOLVED spotlight url (clean /spotlight/<id> or /p/<uuid>/spotlight/<id>)
  // has a stable content id → key it sc:<id>. Case-sensitive (opaque base64url).
  // Unresolved /t/<code> shares AND /p/<uuid>/<storyId> STORY urls have no stable
  // spotlight id (extractSnapchatSpotlightId returns null) → they FALL THROUGH to
  // the full-URL fallback below, exactly like opaque FB /share/ links. This is
  // correct: a /t/ share is resolved to its clean spotlight url at submit time
  // (resolveSnapchatShareUrl) so future links come in already keyable; the
  // historical /t/ tail stays on the raw-url fallback (never over-collapsed).
  if (host === "snapchat.com" || host.endsWith(".snapchat.com")) {
    const id = extractSnapchatSpotlightId(s);
    if (id) return `sc:${id}`; // spotlight id kept case-sensitive
    // /t/ share + /p/<uuid>/<storyId> story → fall through (no stable key).
  }

  // ── Fallback ─────────────────────────────────────────────────────────────
  // Exactly the old behavior for everything we don't explicitly recognize.
  return s.toLowerCase();
}
