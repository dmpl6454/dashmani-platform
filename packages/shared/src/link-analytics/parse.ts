// Link Analytics — URL intake (sales portal /links; spec docs/link-analytics/SPEC.md §1).
//
// Pure and shared: the API decides with it, and the portal runs the SAME code while staff paste,
// so the counts on screen before "Add" equal what the server stores.
//
// RULES (kept in step with canonicalKey / extractFacebookPostId, which the rest of the platform
// dedupes on):
//  - Instagram shortcodes are CASE-SENSITIVE, never lowercased. /p/X, /reel/X and /tv/X with the same
//    code are the SAME post (key ig:X).
//  - Facebook: only NUMERIC ids are keyed by id (fb:<n>). Opaque links (/share/…, pfbid…, fb.watch)
//    are keyed by their normalised URL (fbx:<url>) so two different opaque links are never merged;
//    the worker may later resolve one to a numeric id.
//  - Anything we cannot read through Meta's API is INVALID with a reason, never silently dropped.

export type LinkPlatform = "instagram" | "facebook";
export type LinkPostType = "post" | "reel" | "video" | "photo" | "unknown";

export interface ParsedLink {
  raw: string;
  ok: boolean;
  platform: LinkPlatform | null;
  postType: LinkPostType | null;
  /** ig:<shortcode> | fb:<numeric id> | fbx:<normalised url>. Null when invalid. */
  postKey: string | null;
  normalizedUrl: string | null;
  /** The post id inside the key (shortcode / numeric id), or null for an opaque link. */
  postId: string | null;
  /** IG username or FB page slug carried by the URL itself (/<user>/reel/<code>). */
  accountHint: string | null;
  /** True for an FB link whose post id is not in the URL (share links, pfbid, fb.watch). */
  opaque: boolean;
  reason: string | null;
}

export const LINK_LIMITS = {
  /** Lines per paste or upload. */
  maxEntriesPerAdd: 5000,
  /** Items (all lines ever added) per batch. */
  maxItemsPerBatch: 20000,
  /** Upload size read in the browser. */
  maxUploadBytes: 2 * 1024 * 1024,
  maxRawLength: 2000,
} as const;

const IG_HOSTS = new Set(["instagram.com", "instagr.am"]);
const FB_HOSTS = new Set(["facebook.com", "fb.com", "fb.watch"]);
/** First path segments that are never an Instagram username. */
const IG_RESERVED = new Set(["p", "reel", "reels", "tv", "stories", "explore", "accounts", "direct", "about", "legal", "developer", "s"]);
/** First path segments that are never a Facebook Page slug. */
const FB_RESERVED = new Set([
  "share", "reel", "reels", "watch", "videos", "video.php", "photo.php", "photo", "photos", "permalink.php",
  "story.php", "groups", "events", "profile.php", "pages", "marketplace", "gaming", "login", "hashtag", "people", "stories",
]);
const IG_CODE = /^[A-Za-z0-9_-]{5,64}$/;
const NUMERIC = /^\d{5,25}$/;

function invalid(raw: string, reason: string, platform: LinkPlatform | null = null): ParsedLink {
  return { raw, ok: false, platform, postType: null, postKey: null, normalizedUrl: null, postId: null, accountHint: null, opaque: false, reason };
}

function valid(raw: string, platform: LinkPlatform, postType: LinkPostType, postKey: string, normalizedUrl: string, postId: string | null, accountHint: string | null, opaque = false): ParsedLink {
  return { raw, ok: true, platform, postType, postKey, normalizedUrl, postId, accountHint, opaque, reason: null };
}

/** Parse one pasted link. Never throws. */
export function parseLink(input: string): ParsedLink {
  const raw = String(input ?? "").trim();
  if (!raw) return invalid(raw, "Empty line");
  if (raw.length > LINK_LIMITS.maxRawLength) return invalid(raw.slice(0, 200), "Too long to be a post link");

  let s = raw.replace(/^[<("'\[]+|[>)"'\],.;]+$/g, "");
  if (!/^https?:\/\//i.test(s)) {
    if (/^(www\.|m\.|web\.|mbasic\.)?(instagram\.com|instagr\.am|facebook\.com|fb\.com|fb\.watch)\//i.test(s)) s = `https://${s}`;
    else return invalid(raw, "Not a link");
  }
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return invalid(raw, "Not a link");
  }
  const host = url.hostname.toLowerCase().replace(/^(www\.|m\.|mobile\.|web\.|mbasic\.|business\.)/, "");
  const segs = url.pathname.split("/").filter(Boolean);

  if (IG_HOSTS.has(host)) return parseInstagram(raw, segs);
  if (FB_HOSTS.has(host)) return parseFacebook(raw, host, url, segs);
  if (/(^|\.)(tiktok|youtube|youtu|x|twitter|threads|snapchat|linkedin)\.(com|be|net)$/.test(host)) {
    return invalid(raw, "Only Facebook and Instagram links are supported for now");
  }
  return invalid(raw, "Not a Facebook or Instagram link");
}

function parseInstagram(raw: string, segs: string[]): ParsedLink {
  let i = 0;
  let user: string | null = null;
  if (segs[0] === "stories") return invalid(raw, "Stories expire after 24 hours and have no lasting metrics", "instagram");
  if (segs[0] && !IG_RESERVED.has(segs[0].toLowerCase())) {
    // /<user>/reel/<code> or /<user>/p/<code>
    if (segs[1] && ["p", "reel", "reels", "tv"].includes(segs[1].toLowerCase())) {
      user = segs[0].toLowerCase();
      i = 1;
    } else {
      return invalid(raw, "This is a profile link, not a post", "instagram");
    }
  }
  const kind = (segs[i] ?? "").toLowerCase();
  const code = segs[i + 1] ?? "";
  if (!["p", "reel", "reels", "tv"].includes(kind)) return invalid(raw, "Not an Instagram post, reel or video link", "instagram");
  if (!IG_CODE.test(code)) return invalid(raw, "The post code in this link is not valid", "instagram");
  const postType: LinkPostType = kind === "p" ? "post" : kind === "tv" ? "video" : "reel";
  const path = postType === "post" ? "p" : postType === "video" ? "tv" : "reel";
  if (user && !/^[a-z0-9._]{1,30}$/.test(user)) user = null;
  return valid(raw, "instagram", postType, `ig:${code}`, `https://www.instagram.com/${path}/${code}/`, code, user);
}

function parseFacebook(raw: string, host: string, url: URL, segs: string[]): ParsedLink {
  const q = (k: string) => url.searchParams.get(k);
  const first = (segs[0] ?? "").toLowerCase();
  const fb = (path: string) => `https://www.facebook.com${path}`;
  const numeric = (type: LinkPostType, id: string, norm: string, hint: string | null = null) => valid(raw, "facebook", type, `fb:${id}`, norm, id, hint);
  const opaque = (type: LinkPostType, norm: string, hint: string | null = null) => valid(raw, "facebook", type, `fbx:${norm}`, norm, null, hint, true);

  if (host === "fb.watch") {
    if (!segs[0]) return invalid(raw, "Not a Facebook video link", "facebook");
    return opaque("video", `https://fb.watch/${segs[0]}/`);
  }

  // watch?v=N, /watch/?v=N, video.php?v=N
  if (first === "watch" || first === "video.php") {
    const v = q("v");
    if (v && NUMERIC.test(v)) return numeric("video", v, fb(`/watch/?v=${v}`));
    return invalid(raw, "Not a Facebook video link", "facebook");
  }
  if (first === "reel" || first === "reels") {
    const id = segs[1] ?? "";
    if (NUMERIC.test(id)) return numeric("reel", id, fb(`/reel/${id}`));
    return invalid(raw, "Not a Facebook reel link", "facebook");
  }
  if (first === "share") {
    // /share/r/<code>, /share/v/<code>, /share/p/<code>, /share/<code>
    const letter = segs.length >= 3 ? segs[1].toLowerCase() : "";
    const code = segs.length >= 3 ? segs[2] : segs[1];
    if (!code) return invalid(raw, "Not a Facebook share link", "facebook");
    const type: LinkPostType = letter === "r" ? "reel" : letter === "v" ? "video" : letter === "p" ? "post" : "unknown";
    return opaque(type, fb(`/share/${letter ? `${letter}/` : ""}${code}/`));
  }
  if (first === "permalink.php" || first === "story.php") {
    const sid = q("story_fbid");
    const pid = q("id");
    if (sid && NUMERIC.test(sid)) return numeric("post", sid, fb(`/permalink.php?story_fbid=${sid}${pid ? `&id=${pid}` : ""}`));
    if (sid && pid) return opaque("post", fb(`/permalink.php?story_fbid=${sid}&id=${pid}`));
    return invalid(raw, "Not a Facebook post link", "facebook");
  }
  if (first === "photo.php" || first === "photo") {
    const f = q("fbid");
    if (f && NUMERIC.test(f)) return numeric("photo", f, fb(`/photo/?fbid=${f}`));
    return invalid(raw, "Not a Facebook photo link", "facebook");
  }
  if (first === "groups") return invalid(raw, "Group posts can't be read through Meta's API", "facebook");
  if (first === "events") return invalid(raw, "Events are not posts", "facebook");
  if (first === "profile.php") return invalid(raw, "This is a profile link, not a post", "facebook");
  if (first === "stories") return invalid(raw, "Stories expire after 24 hours and have no lasting metrics", "facebook");
  if (first === "videos") {
    const id = segs[1] ?? "";
    if (NUMERIC.test(id)) return numeric("video", id, fb(`/watch/?v=${id}`));
    return invalid(raw, "Not a Facebook video link", "facebook");
  }

  // /<page>/posts/<id>, /<page>/videos/<id>, /<page>/videos/<title>/<id>, /<page>/photos/<album>/<id>
  if (first && !FB_RESERVED.has(first)) {
    const page = segs[0];
    const kind = (segs[1] ?? "").toLowerCase();
    if (!kind) return invalid(raw, "This is a Page or profile link, not a post", "facebook");
    const rest = segs.slice(2);
    const lastNumeric = [...rest].reverse().find((x) => NUMERIC.test(x));
    if (kind === "posts") {
      const id = rest[0] ?? "";
      if (NUMERIC.test(id)) return numeric("post", id, fb(`/${page}/posts/${id}`), page);
      if (id) return opaque("post", fb(`/${page}/posts/${id}`), page);
    }
    if (kind === "videos" && lastNumeric) return numeric("video", lastNumeric, fb(`/watch/?v=${lastNumeric}`), page);
    if (kind === "reel" && lastNumeric) return numeric("reel", lastNumeric, fb(`/reel/${lastNumeric}`), page);
    if (kind === "photos" && lastNumeric) return numeric("photo", lastNumeric, fb(`/photo/?fbid=${lastNumeric}`), page);
    return invalid(raw, "Not a Facebook post, reel, video or photo link", "facebook");
  }
  return invalid(raw, "Not a Facebook post, reel, video or photo link", "facebook");
}

const URLISH = /(?:https?:\/\/)?(?:www\.|m\.|web\.|mbasic\.)?(?:instagram\.com|instagr\.am|facebook\.com|fb\.com|fb\.watch)\/[^\s,;"'<>]+|https?:\/\/[^\s,;"'<>]+/gi;

/**
 * Split pasted text or an uploaded TXT/CSV into entries, one per link.
 * - Paste / TXT: every non-empty line is at least one entry; a line with no link at all is kept as
 *   one INVALID entry ("Not a link") so the invalid count is honest.
 * - CSV: only cells that hold a link are entries (headers and other columns are skipped).
 */
export function splitEntries(text: string, mode: "paste" | "csv" = "paste"): string[] {
  const out: string[] = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const found = t.match(URLISH);
    if (found && found.length) out.push(...found);
    else if (mode === "paste") out.push(t);
  }
  return out;
}

export type EntryValidity = "valid" | "invalid" | "duplicate";

export interface IntakeEntry extends ParsedLink {
  validity: EntryValidity;
  /** Index (in this intake + already-known keys) of the first entry with the same post. */
  duplicateOfIndex: number | null;
}

export interface IntakeCounts {
  total: number;
  valid: number;
  invalid: number;
  unique: number;
  duplicate: number;
}

/**
 * Validate and de-duplicate. `knownKeys` are the post keys already in the batch, so adding links to
 * an existing batch also catches duplicates of what it holds. With keepDuplicates a repeat stays
 * VALID (it still shares one post and one fetch); without it, it is "duplicate".
 */
export function intake(entries: string[], opts: { keepDuplicates?: boolean; knownKeys?: Iterable<string> } = {}): { entries: IntakeEntry[]; counts: IntakeCounts } {
  const seen = new Map<string, number>();
  for (const k of opts.knownKeys ?? []) seen.set(k, -1);
  const out: IntakeEntry[] = [];
  const counts: IntakeCounts = { total: 0, valid: 0, invalid: 0, unique: 0, duplicate: 0 };
  entries.forEach((e, i) => {
    const p = parseLink(e);
    counts.total++;
    if (!p.ok || !p.postKey) {
      counts.invalid++;
      out.push({ ...p, validity: "invalid", duplicateOfIndex: null });
      return;
    }
    const prev = seen.get(p.postKey);
    if (prev !== undefined) {
      if (opts.keepDuplicates) counts.valid++;
      else counts.duplicate++;
      out.push({ ...p, validity: opts.keepDuplicates ? "valid" : "duplicate", duplicateOfIndex: prev >= 0 ? prev : null });
      return;
    }
    seen.set(p.postKey, i);
    counts.valid++;
    counts.unique++;
    out.push({ ...p, validity: "valid", duplicateOfIndex: null });
  });
  return { entries: out, counts };
}
