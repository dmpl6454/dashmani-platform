// Daily-report link helpers — pure functions, no React, no regex lookbehind.
//
// - extractUrls / splitGlued / toUrl: ported from the original report.tsx paste parser;
//   extractUrls now also counts non-empty lines that produced no link.
// - detectPlatform / matchAccount: auto-assign a pasted link to an account.
// - mergeServerRows: fold the links already submitted today into the form (never removes).
// - toPayloadLink (= toSubmitLink) / toDraftLink: the ONLY builders of link payloads.
//   reportLinkSchema accepts `undefined` but REJECTS `null` for description, mediaUrl,
//   likes, comments, shares and views, so those keys are omitted when empty.
// - parsePriorUrls: GET /hr/reports/my-link-urls → Map<canonicalKey, "YYYY-MM-DD">.
import type { IoniconName } from "@/components/ui";
import type { TintKey } from "@/lib/theme";
import { canonicalKey } from "@/lib/canonical-url";

// ---------- types ----------
/** GET /hr/accounts (daily-report.service.ts getAssignedAccounts). */
export type Account = {
  id: string;
  displayName: string;
  handle: string;
  platform: string;
  platformSlug: string;
  profileUrl?: string | null;
  followerCount?: number | null;
  clientName?: string | null;
};

/** A link as the server returns it (GET /hr/reports/today → links[]). */
export type ServerLink = {
  id?: string;
  url: string | null;
  accountId?: string | null;
  platform?: string | null;
  platformSlug?: string | null;
  accountName?: string | null;
  description?: string | null;
  mediaUrl?: string | null;
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
  views?: number | null;
  isScheduled?: boolean | null;
  scheduledFor?: string | null;
};

export type LinkRow = {
  key: string;
  url: string;
  accountId?: string;
  source: "local" | "server";
  server?: ServerLink;
  auto?: "single" | "host" | "default";
  mismatch?: boolean;
  priorDate?: string | null;
  error?: string;
};

/** One link of POST /hr/reports (never carries `null` for the six optional stats fields). */
export type SubmitLink = {
  url: string | null;
  accountId: string;
  platform: string;
  description?: string;
  mediaUrl?: string;
  likes?: number;
  comments?: number;
  shares?: number;
  views?: number;
  isScheduled?: boolean;
  scheduledFor?: string | null;
};

/** One link of PUT /hr/reports/draft. */
export type DraftLink = { url: string; accountId?: string; platform?: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---------- paste parsing ----------
/** Normalise one candidate to an https URL, or null when it isn't a link. */
export function toUrl(candidate: string): string | null {
  let url = candidate.replace(/[,;)\]]+$/, "");
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  if (/\s/.test(url)) return null;
  try {
    const u = new URL(url);
    return u.hostname.includes(".") ? url : null;
  } catch {
    return null;
  }
}

/**
 * Split two links pasted with no separator ("…/reel/Ahttps://…") at the second scheme — except
 * when the scheme follows "?", "=" or "&": that is a link INSIDE another link's query string
 * (e.g. l.php?u=https://…) and must stay one link. Mirrors the HR portal's parsePastedLine.
 */
export function splitGlued(token: string): string[] {
  const out: string[] = [];
  let start = 0;
  const re = /https?:\/\//gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(token))) {
    if (m.index === 0) continue;
    const prev = token[m.index - 1];
    if (prev === "?" || prev === "=" || prev === "&") continue;
    out.push(token.slice(start, m.index));
    start = m.index;
  }
  out.push(token.slice(start));
  return out;
}

/**
 * Extract every link from pasted text — tolerant of list numbering, commas, bare domains
 * ("instagram.com/reel/…"), several links on one line, and links glued together.
 * `skippedLines` counts non-empty lines that contained no link.
 */
export function extractUrls(text: string): { urls: string[]; skippedLines: number } {
  const urls: string[] = [];
  let skippedLines = 0;
  for (const raw of (text || "").split(/[\n\r]+/)) {
    const line = raw.trim().replace(/^\d+[.)]\s*/, "");
    if (!line) continue;
    let found = 0;
    for (const word of line.split(/[\s,;]+/)) {
      if (!word) continue;
      for (const piece of splitGlued(word)) {
        if (!/^https?:\/\//i.test(piece) && !/^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+\//i.test(piece)) continue;
        const url = toUrl(piece);
        if (url) {
          urls.push(url);
          found += 1;
        }
      }
    }
    if (found === 0) skippedLines += 1;
  }
  return { urls, skippedLines };
}

// ---------- platforms ----------
export const PLATFORM_HOSTS: Record<string, string[]> = {
  instagram: ["instagram.com", "instagr.am"],
  facebook: ["facebook.com", "fb.com", "fb.watch", "m.facebook.com"],
  youtube: ["youtube.com", "youtu.be"],
  twitter: ["x.com", "twitter.com"],
  linkedin: ["linkedin.com"],
  snapchat: ["snapchat.com"],
  threads: ["threads.net"],
  tiktok: ["tiktok.com"],
};

const SLUG_ALIASES: Record<string, string> = {
  x: "twitter",
  "x-twitter": "twitter",
  ig: "instagram",
  fb: "facebook",
  yt: "youtube",
};

/** Lowercased slug with common aliases folded ("x" → "twitter"); for comparisons only. */
function normSlug(s: string | null | undefined): string {
  const l = (s || "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(SLUG_ALIASES, l) ? SLUG_ALIASES[l] : l;
}

function hostOf(url: string): string | null {
  const s = (url || "").trim();
  if (!s) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Platform slug from the link's hostname (suffix match), or null when unknown. */
export function detectPlatform(url: string): string | null {
  const host = hostOf(url);
  if (!host) return null;
  for (const slug of Object.keys(PLATFORM_HOSTS)) {
    if (PLATFORM_HOSTS[slug].some((h) => host === h || host.endsWith(`.${h}`))) return slug;
  }
  return null;
}

function accountSlug(a: Account | undefined): string {
  if (!a) return "";
  const raw = a.platformSlug || (typeof a.platform === "string" ? a.platform : "") || "";
  return raw.trim().toLowerCase();
}

/** The `platform` value the server expects for a link: the account's slug, lowercased. */
export function platformSlugOf(a: Account | undefined, url?: string): string {
  return accountSlug(a) || (url ? detectPlatform(url) : null) || "unknown";
}

/** "Bollywood Society · Instagram" (truncated to 34 characters). */
export function accountLabel(a: Account): string {
  const platform = typeof a.platform === "string" ? a.platform : "";
  const handle = (a.handle || "").split("?")[0].replace(/^@/, "");
  const name = a.displayName || handle;
  const label = platform ? `${name} · ${platform}` : name;
  return label.length > 34 ? label.slice(0, 33) + "…" : label;
}

/** Icon + tile tint for a platform slug. */
export function platformIcon(slug: string | null | undefined): { icon: IoniconName; tint: TintKey } {
  switch (normSlug(slug)) {
    case "instagram":
      return { icon: "logo-instagram", tint: "pink" };
    case "facebook":
      return { icon: "logo-facebook", tint: "blue" };
    case "youtube":
      return { icon: "logo-youtube", tint: "red" };
    case "twitter":
      return { icon: "logo-twitter", tint: "gray" };
    case "linkedin":
      return { icon: "logo-linkedin", tint: "blue" };
    case "snapchat":
      return { icon: "logo-snapchat", tint: "yellow" };
    case "threads":
      return { icon: "at", tint: "gray" };
    case "tiktok":
      return { icon: "logo-tiktok", tint: "gray" };
    default:
      return { icon: "link", tint: "brand" };
  }
}

/**
 * Pick an account for a link:
 *  - exactly one account → it ("single")
 *  - exactly one account whose platform matches the link's host → it ("host")
 *  - else `defaultId` when it is one of the accounts ("default")
 * `mismatch` = the link's platform is known and differs from the chosen account's platform.
 */
export function matchAccount(
  url: string,
  accounts: Account[],
  defaultId?: string,
): { accountId?: string; auto?: LinkRow["auto"]; mismatch: boolean } {
  const detected = detectPlatform(url);
  const mismatchFor = (a: Account): boolean => {
    const s = normSlug(accountSlug(a));
    return !!detected && !!s && s !== detected;
  };
  if (accounts.length === 0) return { mismatch: false };
  if (accounts.length === 1) {
    const only = accounts[0];
    return { accountId: only.id, auto: "single", mismatch: mismatchFor(only) };
  }
  if (detected) {
    const matches = accounts.filter((a) => normSlug(accountSlug(a)) === detected);
    if (matches.length === 1) return { accountId: matches[0].id, auto: "host", mismatch: false };
  }
  if (defaultId) {
    const def = accounts.find((a) => a.id === defaultId);
    if (def) return { accountId: def.id, auto: "default", mismatch: mismatchFor(def) };
  }
  return { mismatch: false };
}

// ---------- keys ----------
function isScheduledServer(s: ServerLink): boolean {
  return s.isScheduled === true || !(s.url ?? "").trim();
}

/** Stable key of a scheduled / url-less server row (never canonicalKey("")). */
function scheduledKey(s: ServerLink): string {
  if (s.id) return `id:${s.id}`;
  return `sched:${[s.scheduledFor ?? "", s.accountId ?? "", s.description ?? "", s.mediaUrl ?? ""].join("|")}`;
}

/** True for a row that came from the server as scheduled (or url-less): shown read-only, re-sent as-is. */
export function isScheduledRow(row: LinkRow): boolean {
  return !!row.server && isScheduledServer(row.server);
}

/**
 * Key used for the in-form and cross-day dedupe: canonicalKey(url), or null for scheduled /
 * url-less rows (those are never deduped — mirrors the server).
 */
export function dedupeKey(row: LinkRow): string | null {
  if (isScheduledRow(row)) return null;
  const u = (row.url || "").trim();
  return u ? canonicalKey(u) : null;
}

function mergeKeyOfRow(row: LinkRow): string | null {
  if (row.server && isScheduledServer(row.server)) return scheduledKey(row.server);
  const u = (row.url || "").trim();
  return u ? canonicalKey(u) : null;
}

function mergeKeyOfServer(s: ServerLink): string {
  return isScheduledServer(s) ? scheduledKey(s) : canonicalKey(s.url);
}

/**
 * Fold the server's links into the form rows. Server rows that the form does not have go in
 * FRONT (source "server"); rows already present gain `server` (and its accountId when they
 * have none). Never removes a row.
 */
export function mergeServerRows(
  local: LinkRow[],
  server: ServerLink[],
  newKey: () => string,
): { rows: LinkRow[]; added: number } {
  const serverByKey = new Map<string, ServerLink>();
  (Array.isArray(server) ? server : []).forEach((s) => {
    if (!isRecord(s)) return;
    const k = mergeKeyOfServer(s);
    if (!k || serverByKey.has(k)) return;
    serverByKey.set(k, s);
  });

  const seen = new Set<string>();
  const rows = local.map((r) => {
    const k = mergeKeyOfRow(r);
    if (k === null) return r;
    seen.add(k);
    const s = serverByKey.get(k);
    if (!s) return r;
    return { ...r, server: s, accountId: r.accountId ?? (s.accountId || undefined) };
  });

  const added: LinkRow[] = [];
  serverByKey.forEach((s, k) => {
    if (seen.has(k)) return;
    seen.add(k);
    added.push({
      key: newKey(),
      url: (s.url ?? "").trim(),
      accountId: s.accountId || undefined,
      source: "server",
      server: s,
    });
  });

  return { rows: [...added, ...rows], added: added.length };
}

// ---------- payloads ----------
function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v !== "";
}

function finiteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * The single builder of a POST /hr/reports link:
 *  - platform = the account's platformSlug (lowercase) → else the server row's slug/platform
 *    (lowercase) → else the link's detected platform → else "unknown"
 *  - url trimmed; null only for scheduled rows without a url
 *  - description / mediaUrl / likes / comments / shares / views echoed from the server row,
 *    OMITTED when null, undefined or "" (the schema rejects null)
 *  - isScheduled / scheduledFor echoed as the server gave them
 */
export function toPayloadLink(row: LinkRow, accountsById: Map<string, Account>): SubmitLink {
  const s = row.server;
  const accountId = row.accountId || s?.accountId || "";
  const acc = accountId ? accountsById.get(accountId) : undefined;
  const trimmed = (row.url || "").trim();
  const scheduled = s?.isScheduled === true;
  const fromAccount = accountSlug(acc);
  const fromServer = (s?.platformSlug || s?.platform || "").trim().toLowerCase();
  const platform = fromAccount || fromServer || (trimmed ? detectPlatform(trimmed) : null) || "unknown";

  const out: SubmitLink = { url: scheduled ? trimmed || null : trimmed, accountId, platform };
  if (s) {
    if (nonEmptyString(s.description)) out.description = s.description;
    if (nonEmptyString(s.mediaUrl)) out.mediaUrl = s.mediaUrl;
    if (finiteNumber(s.likes)) out.likes = s.likes;
    if (finiteNumber(s.comments)) out.comments = s.comments;
    if (finiteNumber(s.shares)) out.shares = s.shares;
    if (finiteNumber(s.views)) out.views = s.views;
    if (typeof s.isScheduled === "boolean") out.isScheduled = s.isScheduled;
    if (nonEmptyString(s.scheduledFor)) out.scheduledFor = s.scheduledFor;
  }
  return out;
}

/** Alias of toPayloadLink (the POST /hr/reports link). */
export function toSubmitLink(row: LinkRow, accountsById: Map<string, Account>): SubmitLink {
  return toPayloadLink(row, accountsById);
}

/** PUT /hr/reports/draft link: `platform` only when the account resolves. */
export function toDraftLink(row: LinkRow, accountsById: Map<string, Account>): DraftLink {
  const url = (row.url || "").trim();
  const out: DraftLink = { url };
  if (row.accountId) {
    out.accountId = row.accountId;
    const acc = accountsById.get(row.accountId);
    if (acc) out.platform = platformSlugOf(acc, url);
  }
  return out;
}

// ---------- prior days ----------
/**
 * GET /hr/reports/my-link-urls returns a MAP { [canonicalKey]: "YYYY-MM-DD" }.
 * Returns Map<canonicalKey, date>. Non-object input → empty map. (A list of
 * { url, date } is also tolerated and keyed through canonicalKey.)
 */
export function parsePriorUrls(raw: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (Array.isArray(raw)) {
    (raw as unknown[]).forEach((item) => {
      if (!isRecord(item)) return;
      const url = item.url;
      const date = item.date;
      if (typeof url === "string" && typeof date === "string" && url.trim()) {
        out.set(canonicalKey(url), date.slice(0, 10));
      }
    });
    return out;
  }
  if (!isRecord(raw)) return out;
  Object.keys(raw).forEach((k) => {
    const v = raw[k];
    if (k && typeof v === "string" && v) out.set(k, v.slice(0, 10));
  });
  return out;
}

/** The earlier day a link was submitted on (YYYY-MM-DD), or null. */
export function priorDateOf(url: string, prior: Map<string, string>): string | null {
  const u = (url || "").trim();
  if (!u) return null;
  return prior.get(canonicalKey(u)) ?? null;
}
