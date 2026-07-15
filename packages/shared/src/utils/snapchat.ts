// Snapchat Spotlight id extraction.
//
// Mirrors `extractFacebookPostId` (./facebook.ts) and the `sc:` branch of
// canonicalKey: parse with `new URL` in a try/catch, validate the host, and
// extract ONLY a spotlight id from a /spotlight/<id> path segment.
//
// WHY SPOTLIGHT-ONLY:
// Submitted Snapchat links are `snapchat.com/t/<code>` SHARE redirects. Their code
// is a tracking token, not a content id, so this returns null for them (they must
// be redirect-resolved first — see resolveSnapchatShareUrl in snapchat.provider.ts).
// After resolution a share link becomes EITHER `.../spotlight/<id>` (a Spotlight —
// we extract the id) OR `.../p/<uuid>/<storyId>` (an ephemeral Story — no public
// stats; we return null so the cron skips it, exactly like an opaque FB /share/).
//
// The spotlight id is the `W7_...`-style opaque base64url token in the /spotlight/
// path segment. It is CASE-SENSITIVE (like IG shortcodes / YT video ids) → never
// lowercased. Both `.../spotlight/<id>` and `.../p/<uuid>/spotlight/<id>` forms
// carry it; we match the last `/spotlight/<id>` segment in either shape.
//
// GUARANTEES (kept in lock-step with canonicalKey's `sc:` branch):
//  - `/spotlight/<id>` (with or without a `/p/<uuid>` prefix, with or without query)
//    → the id.
//  - `/t/<code>` share, `/p/<uuid>/<storyId>` story, `/add/<h>`, `/@<h>` → null.
//  - Non-URL or non-Snapchat host → null.

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
