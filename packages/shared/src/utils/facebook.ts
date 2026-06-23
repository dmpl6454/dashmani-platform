// Facebook numeric post-id extraction.
//
// Mirrors `extractYouTubeVideoId` in ./youtube.ts and the `fb:` branch of
// canonicalKey: parse with `new URL` in a try/catch, validate the host, and
// extract ONLY an unambiguous NUMERIC id.
//
// WHY NUMERIC-ONLY:
// Only stable numeric ids are safe to resolve against the Graph API
// (`GET /{post-id}`). Opaque permalinks — `/share/r/<code>`, `/posts/<code>`,
// `story.php`, and `pfbid…` — are deliberately NOT extracted: there is no public,
// reliable opaque→id lookup, and collapsing them risks merging distinct posts
// (that is also why canonicalKey lets them fall through to the full-URL fallback —
// 84% of our FB links are opaque /share/ URLs). Returning null here means the cron
// simply skips the link as "could not extract targetId" — correct and bounded.
//
// A SEPARATE, opt-in best-effort resolver for opaque URLs lives in the Facebook
// provider (resolveOpaqueFacebookUrl) — it does ONE redirect:manual fetch and only
// succeeds if Facebook redirects to a clean numeric /reel|/videos URL. It is NOT
// wired into the cron and needs the Meta token + careful rate control.
//
// GUARANTEES (kept in lock-step with canonicalKey's `fb:` branch):
//  - `/reel/123`, `/videos/123`, `/video/123` and `watch?v=123` → the digits.
//  - Opaque `/share/r/…`, `/posts/…`, `story.php`, `pfbid…` → null.
//  - Non-URL or non-Facebook host → null.

const FACEBOOK_HOST = "facebook.com";
const FB_WATCH_HOST = "fb.watch";

export function extractFacebookPostId(rawUrl: string | null | undefined): string | null {
  if (!rawUrl) return null;

  let url: URL;
  try {
    url = new URL(String(rawUrl).trim());
  } catch {
    return null;
  }

  // Strip www. / m. / mobile. prefixes before matching.
  const host = url.hostname.toLowerCase().replace(/^(www\.|m\.|mobile\.)/, "");
  const isFacebook =
    host === FACEBOOK_HOST || host.endsWith(`.${FACEBOOK_HOST}`) || host === FB_WATCH_HOST;
  if (!isFacebook) return null;

  // watch?v=123 (numeric only)
  const v = url.searchParams.get("v");
  if (v && /^\d+$/.test(v)) return v;

  // /reel/123, /videos/123, /video/123 (numeric only)
  const m = url.pathname.match(/^\/(?:reel|videos|video)\/(\d+)(?:\/|$)/i);
  if (m && m[1]) return m[1];

  // Everything else — /share/r/…, /posts/…, story.php, pfbid… — is opaque. Give up.
  return null;
}
