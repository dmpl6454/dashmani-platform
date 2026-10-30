// Canonical de-duplication key for a social-media link.
//
// VERBATIM port (same logic, same return strings) of
//   packages/shared/src/utils/canonical-url.ts  (canonicalKey)
//   packages/shared/src/utils/youtube.ts        (extractYouTubeVideoId)
//   packages/shared/src/utils/snapchat.ts       (extractSnapchatSpotlightId)
// The server builds GET /hr/reports/my-link-urls as { [canonicalKey(url)]: "YYYY-MM-DD" },
// so the keys computed here must be byte-equal to the server's. Keep in lock-step with the
// shared package; do not "improve" this file on its own. No regex lookbehind (CI guard).
//
// GUARANTEES (do not weaken these — they prevent over-collapsing distinct posts):
//  - Instagram reel/post/tv shortcodes are CASE-SENSITIVE → never lowercased.
//  - YouTube video ids are CASE-SENSITIVE → never lowercased (11-char id validated).
//  - Facebook: only unambiguous NUMERIC id forms (`/reel/123`, `/videos/123`,
//    `watch?v=123`) are canonicalized. Opaque `/share/r/…`, `/posts/…`, `story.php`
//    and `pfbid…` permalinks FALL THROUGH to the full-URL fallback.
//  - Snapchat: only resolved spotlight urls are keyed (`sc:<id>`); `/t/<code>` shares
//    and story urls fall through.
//  - Anything unrecognized, non-URL, or empty → `url.trim().toLowerCase()`.

// ---------- YouTube ----------
// Normalised hosts (www. and m. already stripped)
const YOUTUBE_HOSTS = new Set(["youtube.com", "youtu.be"]);

function isValidVideoId(id: string): boolean {
  // YouTube video IDs are exactly 11 characters: [A-Za-z0-9_-]
  return /^[A-Za-z0-9_-]{11}$/.test(id);
}

export function extractYouTubeVideoId(rawUrl: string): string | null {
  if (!rawUrl) return null;
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return null;
  }

  // Strip www. and m. prefixes before matching
  const host = url.hostname.toLowerCase().replace(/^(www\.|m\.)/, "");

  // youtu.be/<videoId>
  if (host === "youtu.be") {
    const id = url.pathname.slice(1).split("/")[0];
    return isValidVideoId(id) ? id : null;
  }

  if (!YOUTUBE_HOSTS.has(host)) return null;

  const path = url.pathname;

  // /watch?v=<videoId>
  const vParam = url.searchParams.get("v");
  if (vParam && isValidVideoId(vParam)) return vParam;

  // /shorts/<videoId>, /embed/<videoId>, /live/<videoId>
  const segments = path.split("/").filter(Boolean);
  const prefixes = ["shorts", "embed", "live", "e"];
  for (let i = 0; i < segments.length - 1; i++) {
    if (prefixes.includes(segments[i])) {
      const id = segments[i + 1];
      if (isValidVideoId(id)) return id;
    }
  }

  return null;
}

// ---------- Snapchat ----------
const SNAPCHAT_HOST = "snapchat.com";

export function extractSnapchatSpotlightId(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;
  let url: URL;
  try {
    url = new URL(String(rawUrl).trim());
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(www\.|m\.|mobile\.)/, "");
  if (host !== SNAPCHAT_HOST && !host.endsWith("." + SNAPCHAT_HOST)) return null;

  // Match a /spotlight/<id> segment anywhere in the path (covers both the clean
  // /spotlight/<id> form and the resolved /p/<uuid>/spotlight/<id> form).
  const m = url.pathname.match(/\/spotlight\/([A-Za-z0-9_-]{8,})/);
  return m && m[1] ? m[1] : null; // case-sensitive — never lowercase
}

// ---------- canonicalKey ----------
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
  if (host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be") {
    const id = extractYouTubeVideoId(s);
    if (id) return `yt:${id}`; // video id kept case-sensitive
  }

  // ── Facebook (numeric-id forms ONLY) ─────────────────────────────────────
  if (host === "facebook.com" || host.endsWith(".facebook.com") || host === "fb.watch") {
    const v = url.searchParams.get("v");
    if (v && /^\d+$/.test(v)) return `fb:${v}`;
    const m = url.pathname.match(/^\/(?:reel|videos|video)\/(\d+)(?:\/|$)/i);
    if (m && m[1]) return `fb:${m[1]}`;
    // /share/r/…, /posts/…, /story.php, pfbid… → intentionally fall through.
  }

  // ── Snapchat (Spotlight only) ──────────────────────────────────────────────
  if (host === "snapchat.com" || host.endsWith(".snapchat.com")) {
    const id = extractSnapchatSpotlightId(s);
    if (id) return `sc:${id}`; // spotlight id kept case-sensitive
    // /t/ share + /p/<uuid>/<storyId> story → fall through (no stable key).
  }

  // ── Fallback ─────────────────────────────────────────────────────────────
  return s.toLowerCase();
}
