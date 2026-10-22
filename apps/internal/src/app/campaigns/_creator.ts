// Creator-page helpers shared by the Campaign pages (rate card + booking detail). `_` keeps Next from routing it.
// Everything here is STAFF-side display logic: the figures it prints (share, payout, our cut) must never reach the
// client or creator portals, and nothing here decides money: the API's computePayout and its checks are the authority.

import { CREATOR_MIN_PAYOUT_PAISE, CREATOR_SHARE_MAX_BPS, CREATOR_TARGET_TYPE } from "@dashmani/shared/src/validators/campaign";
import type { PayoutSummary } from "@dashmani/shared/src/payouts/staff-ui";

export { CREATOR_MIN_PAYOUT_PAISE, CREATOR_SHARE_MAX_BPS, CREATOR_TARGET_TYPE };

// ── What a creator is paid ──────────────────────────────────────────────────────────────────────

const BPS = 10_000;
/** floor(a / b) for non-negative integers, with no floating-point quotient (same trick as the API's payout-math). */
const floorDiv = (a: number, b: number) => (a - (a % b)) / b;

export interface PayoutPreview {
  /** The creator's share of the price, before tax. */
  grossPaise: number;
  /** Withheld from that share as tax at source. */
  tdsPaise: number;
  /** What the creator is paid: gross − TDS. */
  amountPaise: number;
  /** What stays with us out of the price: price − gross. Our own Razorpay fees are paid from this; whether Razorpay also takes anything from the creator's settlement is NOT confirmed yet (plan question c), so nothing here promises it doesn't. */
  ourCutPaise: number;
}

/**
 * A PREVIEW of apps/api's computePayout (services/creator/payout-math.ts), which is the authority: the API recomputes
 * everything when the card is saved, at checkout and at capture. Same arithmetic, same rounding (everything rounds
 * down, so a remainder stays with us). Kept as a mirror because that module lives in the API app; if it ever moves into
 * packages/shared, import it from there and delete this.
 */
export function previewPayout(pricePaise: number, shareBps: number, tdsBps: number): PayoutPreview {
  const grossPaise = floorDiv(pricePaise * shareBps, BPS);
  const tdsPaise = floorDiv(grossPaise * tdsBps, BPS);
  return { grossPaise, tdsPaise, amountPaise: grossPaise - tdsPaise, ourCutPaise: pricePaise - grossPaise };
}

/** "12.5" → 1250 basis points. null when it is not a number with at most two decimals. */
export function percentToBps(raw: string): number | null {
  const s = raw.trim().replace(/%$/, "").trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

/** 7500 → "75", 7525 → "75.25". */
export const bpsToPercent = (bps: number) => String(bps / 100);

/** "1,500" / "₹1500" → 150000 paise; null for empty or unusable. */
export function rupeesToPaise(raw: string): number | null {
  const s = raw.trim().replace(/[,₹\s]/g, "");
  if (s === "") return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.round(n * 100);
}

// ── Why a creator page isn't (yet) visible to clients ───────────────────────────────────────────

export type NotBookable = "no_payout_account" | "payout_not_activated" | "bookable_later" | "bank_change";

export const NOT_BOOKABLE_TEXT: Record<NotBookable, string> = {
  no_payout_account: "The creator hasn't connected a bank account yet.",
  payout_not_activated: "The creator's bank account isn't activated yet.",
  bookable_later: "The creator's bank account was activated recently: clients can book it after a 24-hour wait.",
  bank_change: "The creator asked to change their bank account. Clients can't book it until you mark that change processed (and 72 hours pass).",
};

// ── The booking page: offers ────────────────────────────────────────────────────────────────────

export type OfferStatus = "offered" | "accepted" | "declined" | "expired" | "withdrawn" | "completed";

/** One row of `creatorOffers[]` on the staff booking (GET /admin/campaigns/:id). Dates arrive as ISO strings. */
export interface StaffOffer {
  id: string;
  itemId: string;
  creatorId: string;
  status: OfferStatus | string;
  closedReason: string | null;
  pageName: string;
  platform: string;
  format: string;
  payoutPaise: number;
  /** DATE columns: the posting window as IST calendar days ("2026-10-20T00:00:00.000Z" → 2026-10-20). */
  windowFrom: string | null;
  windowTo: string | null;
  offeredAt: string;
  expiresAt: string;
  /** When the offer email was handed to the mailer: null = the creator has not been emailed (yet). */
  notifiedAt: string | null;
  acceptedAt: string | null;
  declinedAt: string | null;
  expiredAt: string | null;
  withdrawnAt: string | null;
  creatorNote: string | null;
  linkUrl: string | null;
  /**
   * The identity of the link the creator sent, as the API computed it. A verify request must quote it back, so the API can
   * tell when the creator sent a different link after staff opened the dialog. null only on a row the API never keyed.
   */
  linkCanonicalKey: string | null;
  linkSubmittedAt: string | null;
  linkPostedAt: string | null;
  ownershipCheck: string | null;
  ownershipDetail: string | null;
  ownershipCheckedAt: string | null;
  linkVerifiedAt: string | null;
  postMissingAt: string | null;
  /**
   * The compact summary of this post's payout, whatever state it is in (Paid with its bank reference, Taken back, Paid by hand…). null = no
   * payout was created for the post; undefined = an older API. The campaign page prefers its full payout read and falls back to this.
   */
  payout?: PayoutSummary | null;
}

/** A link a creator typed is shown as a link only when it is plainly http(s): never a javascript: or data: URL in a staff browser. */
export const safeHref = (u: string | null | undefined) => (u && /^https?:\/\//i.test(u) ? u : null);

export const dayOf = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : null);

export const OFFER_STATUS: Record<string, { label: string; color: string }> = {
  offered: { label: "Offered", color: "#238BFF" },
  accepted: { label: "Accepted", color: "#00D7A0" },
  declined: { label: "Declined", color: "#FB7185" },
  expired: { label: "Expired", color: "#A7B3C2" },
  withdrawn: { label: "Withdrawn", color: "#A7B3C2" },
  completed: { label: "Completed", color: "#00D7A0" },
};

const CLOSED_REASON: Record<string, string> = {
  declined: "The creator declined.",
  expired: "Nobody accepted before the offer expired.",
  withdrawn: "The offer was withdrawn.",
  missed_window: "The creator didn't send a link by the end of the posting window.",
  booking_rejected: "The booking was rejected.",
  page_taken_over: "The page changed hands, so the creator who was booked no longer owns it.",
  // Their account is suspended or closed: not that they chose not to answer or post. (Same sentence the API writes on the item row.)
  creator_unavailable: "The creator's account is suspended or closed, so they couldn't act on this offer.",
};
/**
 * Why an offer closed, in staff words. An offer that expired and was NEVER emailed is not "nobody accepted": nobody was asked
 * (the API words it the same way on the item row).
 */
export const closedReasonText = (r: string | null, notifiedAt?: string | null) =>
  r === "expired" && notifiedAt === null ? "The creator was never emailed this offer, so it expired unseen." : r ? CLOSED_REASON[r] ?? r.replace(/_/g, " ") : null;

/** An offer is open while the creator can still act on it. */
export const isOpenOffer = (o: Pick<StaffOffer, "status"> | undefined | null) => !!o && (o.status === "offered" || o.status === "accepted");

/** `offered` past its expiry reads as expired even before the worker closes it (the worker runs every few minutes). */
export const offerExpiredNow = (o: Pick<StaffOffer, "status" | "expiresAt">, now: number = Date.now()) =>
  o.status === "offered" && new Date(o.expiresAt).getTime() <= now;

const OWNERSHIP_REASON: Record<string, string> = {
  token_lapsed: "the creator's Meta login has lapsed",
  permission: "Meta refused permission to read their page",
  rate_limited: "Meta was busy",
  unreachable: "Meta couldn't be reached",
  graph_error: "Meta returned an error",
  no_page: "their page is no longer connected",
  connection_lapsed: "their connection needs reconnecting",
  no_token: "there is no saved login for their page",
  token_unreadable: "their saved login couldn't be read",
  // A share link (instagram.com/share/…, facebook.com/share/…) names no post, so there is nothing to compare. The creator
  // is told to send the post's own link; a hand check of this one is still possible.
  share_link: "it is a share link, which names no post",
  link_shape: "it is a kind of link we can't compare automatically (for example fb.watch)",
  feed_shape: "their page lists its posts in a form we can't compare with this link",
  // Not found in the newest posts the check reads: the post is probably older than that, so this is NOT "not on their page".
  page_too_busy: "their page posts so often that this post is further back than the check reads",
  no_timestamp: "Meta gave no time for the post",
};

export type OwnershipTone = "ok" | "bad" | "warn" | "none";
export interface OwnershipView {
  tone: OwnershipTone;
  headline: string;
  detail: string | null;
  /** The check passed (automatically, or staff ticked it by hand): no tick is needed to verify. */
  passed: boolean;
}

/** What the page-ownership check said, in staff words. `passed` mirrors the API: only auto_ok / manual_ok pass. */
export function ownershipView(check: string | null, detail: string | null): OwnershipView {
  switch (check) {
    case "auto_ok":
      return { tone: "ok", headline: "Found on the creator's page, inside the posting window", detail: "Checked automatically through the creator's own connection.", passed: true };
    case "manual_ok":
      return { tone: "ok", headline: "Checked by hand by our team", detail: null, passed: true };
    case "auto_failed":
      return detail === "outside_window"
        ? { tone: "bad", headline: "Posted outside the posting window", detail: "It is on the creator's page, but its time is before or after the window. Open it and decide.", passed: false }
        : { tone: "bad", headline: "Not found on the creator's page", detail: "Their recent posts don't include this link. It may be someone else's post, or too old to be in the list we read. Open it and check.", passed: false };
    case "unverifiable":
      return {
        tone: "warn",
        headline: "Couldn't be checked automatically",
        detail: `${detail ? `Because ${OWNERSHIP_REASON[detail] ?? detail.replace(/_/g, " ")}. ` : ""}${
          detail === "share_link" ? "The creator was asked to send the post's own link, so a new link may follow. " : ""
        }Open the link and check it yourself.`,
        passed: false,
      };
    default:
      return { tone: "none", headline: "Not checked yet", detail: "Open the link and check it yourself.", passed: false };
  }
}

/** The frozen creator terms of an item, from the booking's pricingSnapshot (checkout wrote them). Defensive: anything odd is skipped. */
export interface FrozenCreatorItem {
  creatorName: string | null;
  /** What the creator is paid for this post, after TDS (frozen at checkout). */
  amountPaise: number | null;
}
export function frozenCreatorItems(snapshot: unknown): Map<string, FrozenCreatorItem> {
  const out = new Map<string, FrozenCreatorItem>();
  const items = (snapshot as { items?: unknown } | null | undefined)?.items;
  if (!Array.isArray(items)) return out;
  for (const raw of items) {
    if (typeof raw !== "object" || raw === null) continue;
    const e = raw as Record<string, unknown>;
    if (typeof e.itemId !== "string" || typeof e.creatorId !== "string") continue; // a network entry
    out.set(e.itemId, {
      creatorName: typeof e.creatorName === "string" && e.creatorName.trim() ? e.creatorName.trim() : null,
      amountPaise: typeof e.amountPaise === "number" && Number.isFinite(e.amountPaise) ? e.amountPaise : null,
    });
  }
  return out;
}

/**
 * The pill for a creator's post: the item's status read together with its offer, because the item alone can't tell
 * "accepted, waiting for the post" from "link in, waiting for us" (both are manual_pending).
 */
export function creatorItemStatus(status: string, offer: StaffOffer | undefined, now: number = Date.now()): { label: string; color: string } {
  switch (status) {
    case "pending":
      return { label: "Awaiting approval", color: "#738395" };
    case "awaiting_creator":
      return offer && offerExpiredNow(offer, now)
        ? { label: "Offer expired — closing", color: "#A7B3C2" }
        : { label: "Waiting for the creator", color: "#238BFF" };
    case "manual_pending":
      if (offer?.status === "accepted") {
        return offer.linkSubmittedAt ? { label: "Link to verify", color: "#E9BD62" } : { label: "Accepted — creator is posting", color: "#238BFF" };
      }
      return { label: "No open offer", color: "#F59E66" };
    case "posted_manual":
    case "published":
      // Only reached once staff verified the creator's own link (a creator's post is never marked posted any other way).
      return { label: "Posted by the creator", color: "#00D7A0" };
    case "refund_due":
      return { label: "Being returned", color: "#F59E66" };
    case "refunded":
      return { label: "Refunded", color: "#A7B3C2" };
    case "failed":
      return { label: "Failed", color: "#FB7185" };
    default:
      return { label: status.replace(/_/g, " "), color: "#738395" };
  }
}

// ── Was the creator emailed their offer? ────────────────────────────────────────────────────────

/**
 * The offer email is sent once, fire-and-forget, when the campaign is approved; `notifiedAt` is stamped only when the mailer
 * took it. A failed first send is retried by the offers worker, and staff are emailed once after enough failed retries. The
 * worker keeps no counter on the offer, so each failed retry and the staff alert are written to the booking's History as
 * fixed lines. ⚠️ Mirrors OFFER_EMAIL / retryMarker / alertMarker in apps/api (services/creator/creator-offers-config.ts): if
 * that wording or those numbers change, change them here too. Nothing below claims more than a line on the page proves:
 * "staff alerted" is said only when the alert's own line is in the History we were given (the newest 100 lines).
 */
const OFFER_EMAIL_FIRST_SEND_MS = 10 * 60_000;
const OFFER_EMAIL_MAX_RETRIES = 5;
const RETRY_LINE = /could not be sent \(offer ([0-9a-f-]{36}), retry (\d+)\)$/;
const alertLine = (offerId: string) => `Staff alerted [undelivered] (offer ${offerId})`;

export type OfferEmailState =
  | { kind: "sent"; at: string }
  /** Not stamped yet, and still inside the minutes the first send is allowed to take. */
  | { kind: "pending" }
  /** Nothing recorded as sent after the first-send window: `retries` failed re-sends so far, `staffAlerted` once our alert went out. */
  | { kind: "failed"; retries: number; staffAlerted: boolean; stopped: boolean };

/** Only an offer still waiting for an answer has an email state: an accepted offer was plainly seen, a closed one is over. */
export function offerEmailState(
  o: Pick<StaffOffer, "id" | "status" | "offeredAt" | "notifiedAt">,
  events: ReadonlyArray<{ note: string | null }>,
  now: number = Date.now(),
): OfferEmailState | null {
  if (o.status !== "offered") return null;
  if (o.notifiedAt) return { kind: "sent", at: o.notifiedAt };
  const offered = new Date(o.offeredAt).getTime();
  const retries = events.reduce((n, e) => {
    const m = e.note ? RETRY_LINE.exec(e.note) : null;
    return m && m[1] === o.id ? Math.max(n, Number(m[2])) : n;
  }, 0);
  const staffAlerted = events.some((e) => e.note === alertLine(o.id));
  if (Number.isFinite(offered) && now - offered < OFFER_EMAIL_FIRST_SEND_MS && retries === 0) return { kind: "pending" };
  return { kind: "failed", retries, staffAlerted, stopped: retries >= OFFER_EMAIL_MAX_RETRIES };
}

// ── "Verify" is bound to the link staff looked at ───────────────────────────────────────────────

/**
 * Thrown by the page's verify call when the creator's link (or the check on it) is no longer what the dialog showed: the API
 * answered 409 LINK_CHANGED, or the freshly loaded offer differs from what the verify request quoted. `offer` is the offer as
 * it now stands (undefined if it could not be read again). Nothing was verified.
 */
export class LinkChangedError extends Error {
  constructor(public offer: StaffOffer | undefined) {
    super("The creator sent a different link since you opened this.");
    this.name = "LinkChangedError";
  }
}

/** apiFetch throws a plain Error carrying only the API's message, so the 409 is recognised by that sentence (the key comparison after a reload is the other, code-free, signal). */
export const isLinkChangedMessage = (e: unknown) => e instanceof Error && /different link since you opened/i.test(e.message);
