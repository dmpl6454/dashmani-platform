import { canonicalKey } from "@dashmani/shared";

// How a creator's post link is read: which post it names (the KEY the one-post-one-booking rule and the ownership check
// compare) and what URL is kept and later shown to the client.
//
// ⚠️ WHY THIS IS NOT packages/shared canonicalKey. That function is shared with the HR daily-report dedupe, Link Search and
// a SQL copy locked to it by a test: changing it would move keys everywhere. A creator's link has stricter needs (a link
// we will pay for and show a client), so this file adds what those need and leaves canonicalKey alone:
//   • only a real post link on the platform's own host (www./m./mobile./web./mbasic. or bare): never l.facebook.com or any
//     other subdomain, never a link that carries a redirect target (u=, next=, …), because the pasted string used to be
//     delivered to the client as the post;
//   • an Instagram /share/<code> link is an opaque redirect token, NOT the post's shortcode (canonicalKey would key it as
//     ig:<sharecode>), so it gets its own key and can never match, or collide with, an ig:<shortcode>;
//   • every Facebook post shape is keyed by the post's identity token and never by page segment + path: /<page>/videos/<id>
//     is fb:<id> exactly like /reel/<id>, a pfbid permalink is fbpost:<pfbid> (case-sensitive), a photo is fbphoto:<id>.
//
// KEYS. An "identity" key names ONE post (ig: yt: fb: fbpost: fbphoto: fbstory: sc:). Only identity keys count for "one post,
// one booking". `share:` (an opaque share link) and `raw:` (a shape we cannot read) name a link, not a post, so two of them
// can never be compared and the check on them is left to a person.

export type LinkShape = "identity" | "share" | "opaque";

export interface ParsedCreatorLink {
  platform: "instagram" | "facebook";
  /** The link in its clean form (https, www., no tracking query): what is stored, shown to staff and, once verified, to the client. */
  url: string;
  key: string;
  shape: LinkShape;
}

/** host: not a post link on this platform's own host · redirect: carries a redirect target · shape: the right host, not a post. */
export type ParseFailure = "host" | "redirect" | "shape";
export type ParsedResult = { ok: true; link: ParsedCreatorLink } | { ok: false; reason: ParseFailure };

const IDENTITY_KEY = /^(ig|yt|fb|fbpost|fbphoto|fbstory|sc):/;
/** Whether a key names ONE post (and so may be compared for "one post, one booking"). */
export const isIdentityKey = (key: string): boolean => IDENTITY_KEY.test(key);

const PLAIN_PREFIXES = ["", "www.", "m.", "mobile.", "web.", "mbasic."];
const isPlainHost = (host: string, domain: string) => PLAIN_PREFIXES.some((p) => host === `${p}${domain}`);

/** Query parameters that make a link a redirect to somewhere else (l.facebook.com/l.php?u=…, login.php?next=…). */
const REDIRECT_PARAMS = ["u", "next", "url", "redirect", "redirect_uri", "continue"];
const hasRedirectParam = (u: URL) => REDIRECT_PARAMS.some((p) => u.searchParams.has(p));

const trimSlash = (p: string) => p.replace(/\/+$/, "");
const fail = (reason: ParseFailure): ParsedResult => ({ ok: false, reason });
const ok = (platform: ParsedCreatorLink["platform"], url: string, key: string, shape: LinkShape): ParsedResult => ({ ok: true, link: { platform, url, key, shape } });

function parseInstagram(u: URL, host: string): ParsedResult {
  if (!isPlainHost(host, "instagram.com")) return fail("host");
  if (hasRedirectParam(u)) return fail("redirect");
  const path = trimSlash(u.pathname);
  // /share/reel/<code> and /share/p/<code> are redirect tokens, not shortcodes.
  if (/^\/share(\/|$)/i.test(path)) return ok("instagram", `https://www.instagram.com${path}/`, `share:instagram.com${path}`, "share");
  const m = /^(?:\/[^/]+)?\/(reel|reels|p|tv)\/([^/]+)/i.exec(path);
  if (!m) return fail("shape");
  return ok("instagram", `https://www.instagram.com/${m[1].toLowerCase()}/${m[2]}/`, `ig:${m[2]}`, "identity"); // shortcodes are case-sensitive
}

function parseFacebook(u: URL, host: string): ParsedResult {
  if (hasRedirectParam(u) && (host === "fb.watch" || isPlainHost(host, "facebook.com"))) return fail("redirect");
  const path = trimSlash(u.pathname);
  const q = u.searchParams;
  // fb.watch/<code> is a short link to a video: it names no id we can read.
  if (host === "fb.watch") return path.length > 1 ? ok("facebook", `https://fb.watch${path}/`, `raw:fb.watch${path}`, "opaque") : fail("shape");
  if (!isPlainHost(host, "facebook.com")) return fail("host");
  const web = (p: string) => `https://www.facebook.com${p}`;
  const id = (key: string, url: string) => ok("facebook", url, key, "identity");

  if (/^\/share(\/|$)/i.test(path)) return ok("facebook", web(`${path}/`), `share:facebook.com${path}`, "share");
  let m: RegExpExecArray | null;
  if ((m = /^\/reel\/(\d+)(?:\/|$)/i.exec(path))) return id(`fb:${m[1]}`, web(`/reel/${m[1]}/`));
  // /<page>/videos/<id>, /videos/<id>, /<page>/videos/vb.<pageid>/<id>: the page segment is NOT part of the identity.
  if ((m = /(?:^|\/)videos?\/(?:vb\.\d+\/)?(\d+)(?:\/|$)/i.exec(path))) return id(`fb:${m[1]}`, web(`/watch/?v=${m[1]}`));
  const v = q.get("v");
  if (/^\/(?:watch|video\.php)$/i.test(path) && v && /^\d+$/.test(v)) return id(`fb:${v}`, web(`/watch/?v=${v}`));
  if ((m = /(?:^|\/)posts\/(pfbid[A-Za-z0-9]+|\d+)(?:\/|$)/.exec(path))) {
    const base = trimSlash(path.slice(0, m.index + m[0].length));
    return id(`fbpost:${m[1]}`, web(base)); // pfbid tokens are case-sensitive: never lowercased
  }
  const fbid = q.get("fbid");
  if (/^\/photo(?:\.php)?$/i.test(path) && fbid && /^\d+$/.test(fbid)) return id(`fbphoto:${fbid}`, web(`/photo.php?fbid=${fbid}`));
  if ((m = /\/photos\/(?:[a-z]+\.\d+\/)?(\d+)$/i.exec(path))) return id(`fbphoto:${m[1]}`, web(`/photo.php?fbid=${m[1]}`));
  if (/^\/(?:permalink|story)\.php$/i.test(path)) {
    const s = q.get("story_fbid");
    const owner = q.get("id");
    const token = /^[A-Za-z0-9_.-]{1,120}$/;
    if (s && owner && token.test(s) && token.test(owner)) {
      return id(`fbstory:${s}:${owner}`, web(`${path.toLowerCase()}?story_fbid=${encodeURIComponent(s)}&id=${encodeURIComponent(owner)}`));
    }
  }
  return fail("shape");
}

/**
 * Read a creator's link for a platform. `ok: false` says why it is not acceptable as a post link; `ok: true` carries the
 * clean URL and the key. Never throws.
 */
export function parseCreatorLink(platform: string, raw: string): ParsedResult {
  let u: URL;
  try {
    u = new URL(String(raw).trim());
  } catch {
    return fail("host");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return fail("host");
  const host = u.hostname.toLowerCase();
  if (platform === "instagram") return parseInstagram(u, host);
  if (platform === "facebook") return parseFacebook(u, host);
  return fail("host");
}

/**
 * What a post's link is compared on, whatever platform it is for (a creator's link and the permalinks Meta lists for their page
 * both go through this, so they always agree). An identity key when the link names a post; otherwise `share:` / `raw:` + the host
 * and path (the tracking query is ignored; the path keeps its case), which is never counted for "one post, one booking".
 */
export function ownershipMatchKey(raw: string): string {
  for (const platform of ["instagram", "facebook"]) {
    const r = parseCreatorLink(platform, raw);
    if (r.ok) return r.link.key;
  }
  const k = canonicalKey(raw);
  if (isIdentityKey(k)) return k;
  try {
    const u = new URL(String(raw).trim());
    return `raw:${u.hostname.toLowerCase().replace(/^(www\.|m\.|mobile\.|web\.)/, "")}${trimSlash(u.pathname)}`;
  } catch {
    return `raw:${k}`;
  }
}
