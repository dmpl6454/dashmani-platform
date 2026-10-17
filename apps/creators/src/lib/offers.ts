// Booking offers (Phase 3 of the payouts plan): the shapes GET /v1/creator/offers and /offers/:id send, and
// the pure helpers the pages share. Everything a creator sees here comes from those two answers.
//
// ⚠️ WHAT THESE SHAPES NEVER CARRY, and what no page may therefore show: the brand's price, the booking total,
// other items of the booking, the client's company or contact, the share or the gross, another creator. The API
// builds them from an allow-list; this file only mirrors it. If a field appears here, the API sends it.

export const MARKETPLACE_STATUS_PATH = "/creator/marketplace-status";
export const OFFERS_PATH = "/creator/offers";
export const offerPath = (id: string) => `${OFFERS_PATH}/${encodeURIComponent(id)}`;
/** The offer page for one offer (a static export has no dynamic segments, so the id rides in the query). */
export const offerHref = (id: string) => `/offer?id=${encodeURIComponent(id)}`;

/** The offer states the API knows. An unknown one still renders (as a plain, neutral chip); it is never assumed to be one of these. */
export type OfferStatus = "offered" | "accepted" | "declined" | "expired" | "withdrawn" | "completed";

export interface OfferRow {
  id: string;
  status: OfferStatus | string;
  platform: "instagram" | "facebook" | string;
  format: string;
  pageName: string;
  pageHandle: string | null;
  /** The posting window as two IST calendar days ("2026-10-12"), the first and the LAST, both included. Either may be missing. */
  window: { from: string | null; to: string | null };
  /** What the creator receives, in integer paise, after any tax deducted at source. The only money figure there is. */
  payout: { paise: number; currency: "INR"; display: string };
  offeredAt: string;
  expiresAt: string;
}

export interface OfferFile {
  id: string;
  /** image | video */
  kind: string;
  /** creative | thumbnail */
  role: string;
  /** false while the file is still being prepared: it has no URL yet. */
  ready: boolean;
  /** API-relative signed path (starts with /v1/...). Short-lived. */
  url: string | null;
  downloadUrl: string | null;
}

export interface OfferBrief {
  files: OfferFile[];
  caption: string;
  /** Without the "#". */
  hashtags: string[];
  /** Instagram usernames without the "@". */
  userTags: string[];
  collaborators: string[];
  printedText: { text: string; position: string | null } | null;
}

/** How the creator's own page was checked against the link they sent (the API's `ownership_check`). */
export type LinkCheck = "auto_ok" | "manual_ok" | "auto_failed" | "unverifiable";

export interface OfferLink {
  url: string;
  submittedAt: string | null;
  check: LinkCheck | string | null;
  /** The API's own sentence about the check; fixed text, never an echo of what was sent. */
  message: string;
  /** Our team verified the post. */
  verified: boolean;
}

export interface OfferDetail extends OfferRow {
  brand: string | null;
  acceptedAt: string | null;
  /** The paid-partnership instruction. */
  disclosure: string;
  /** Only while the offer is open or finished well; declined / expired / withdrawn offers have nothing left to post. */
  brief: OfferBrief | null;
  link: OfferLink | null;
  actions: { accept: boolean; decline: boolean; submitLink: boolean };
}

/** POST /creator/offers/:id/posted answers the detail plus the verdict on the link just sent. */
export type PostedResponse = OfferDetail & { linkResult?: { check: string; detail: string | null; message: string } };

const PLATFORM_LABELS: Record<string, string> = { instagram: "Instagram", facebook: "Facebook", youtube: "YouTube" };
export const platformLabel = (p: string) => PLATFORM_LABELS[p] ?? (p ? p.charAt(0).toUpperCase() + p.slice(1) : "");

const FORMAT_LABELS: Record<string, string> = { reel: "Reel", story: "Story", post: "Post", carousel: "Carousel" };
export const formatLabel = (f: string) => FORMAT_LABELS[f] ?? (f ? f.charAt(0).toUpperCase() + f.slice(1) : "");

/** "@name" for a stored handle (which may or may not carry the "@"), or null. */
export function handleLabel(h: string | null | undefined): string | null {
  const t = (h ?? "").trim().replace(/^@/, "");
  return t ? `@${t}` : null;
}

/**
 * The status a creator reads. An open offer whose expiry has passed reads "expired" at once, on this screen, even
 * before the server's own worker has closed it (the API does the same on every read). `now` is null until the
 * clock has been read on the client, and the server's word stands until then.
 */
export function effectiveStatus(o: Pick<OfferRow, "status" | "expiresAt">, now: number | null): string {
  if (o.status === "offered" && now != null) {
    const t = Date.parse(o.expiresAt);
    if (Number.isFinite(t) && t <= now) return "expired";
  }
  return o.status;
}

export type Tone = "attention" | "info" | "success" | "muted";

const CHIPS: Record<string, { label: string; tone: Tone }> = {
  offered: { label: "Needs your answer", tone: "attention" },
  accepted: { label: "Accepted", tone: "info" },
  completed: { label: "Completed", tone: "success" },
  declined: { label: "Declined", tone: "muted" },
  expired: { label: "Expired", tone: "muted" },
  withdrawn: { label: "Withdrawn", tone: "muted" },
};

/** The chip for a list row, where all that is known is the offer's status. */
export function rowChip(status: string): { label: string; tone: Tone } {
  return CHIPS[status] ?? { label: status ? status.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "Unknown", tone: "muted" };
}

/**
 * The chip for the detail page, which also knows the link: an accepted offer is "Verified" once our team has
 * verified the post, "Link sent" once a link is in, and otherwise asks for the post.
 */
export function detailChip(status: string, link: OfferLink | null): { label: string; tone: Tone } {
  if (status === "accepted") {
    if (link?.verified) return { label: "Verified", tone: "success" };
    if (link) return { label: "Link sent", tone: "info" };
    return { label: "Accepted: post it", tone: "attention" };
  }
  return rowChip(status);
}

/** Sort and group for the list. Groups are named for what the creator has to do next. */
export type Group = "answer" | "accepted" | "completed" | "closed";
export const GROUP_ORDER: Group[] = ["answer", "accepted", "completed", "closed"];
export const GROUP_TITLES: Record<Group, string> = {
  answer: "Needs your answer",
  accepted: "Accepted",
  completed: "Completed",
  closed: "Closed",
};

export function groupOf(status: string): Group {
  if (status === "offered") return "answer";
  if (status === "accepted") return "accepted";
  if (status === "completed") return "completed";
  return "closed";
}

/** How many offers wait for an answer (not counting one whose expiry has passed). */
export function countAwaitingAnswer(rows: OfferRow[] | undefined, now: number | null): number {
  return (rows ?? []).filter((o) => effectiveStatus(o, now) === "offered").length;
}

/** A link is only ever opened if it is an http(s) address; anything else is shown as text. */
export function safeHref(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * A pasted post link, tidied for sending: trimmed, and given "https://" when it was pasted without a scheme
 * ("instagram.com/p/abc/"), which the API would otherwise read as not being a link at all.
 */
export function tidyLink(raw: string): string {
  const t = raw.trim();
  if (/^https?:\/\//i.test(t)) return t;
  if (!/\s/.test(t) && /^[\w-]+(\.[\w-]+)+\/\S*/.test(t)) return `https://${t}`;
  return t;
}

/** The `exp` (unix seconds) of a signed media path, or null. */
export function signedUrlExpiry(path: string | null | undefined): number | null {
  const m = path ? /[?&]exp=(\d+)/.exec(path) : null;
  return m ? Number(m[1]) : null;
}
