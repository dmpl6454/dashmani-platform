// Creator-page helpers shared by the Campaign pages (rate card + booking detail). `_` keeps Next from routing it.
// Everything here is STAFF-side display logic: the figures it prints (share, payout, our cut) must never reach the
// client or creator portals, and nothing here decides money: the API's computePayout and its checks are the authority.

import { CREATOR_MIN_PAYOUT_PAISE, CREATOR_SHARE_MAX_BPS, CREATOR_TARGET_TYPE } from "@dashmani/shared/src/validators/campaign";

export { CREATOR_MIN_PAYOUT_PAISE, CREATOR_SHARE_MAX_BPS, CREATOR_TARGET_TYPE };

/**
 * Whether "Verify link & release" also releases the creator's money today. It does not: verifying makes the creator's
 * link the live post and nothing else (the Route money leg is a later phase). The confirm dialog says so while this is
 * false, so a button called "release" never promises more than it does. The phase that wires the release flips it.
 */
export const RELEASE_ON_VERIFY = false;

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
  /** What stays with us out of the price: price − gross (Razorpay's fees come out of this, never out of the creator's side). */
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
  acceptedAt: string | null;
  declinedAt: string | null;
  expiredAt: string | null;
  withdrawnAt: string | null;
  creatorNote: string | null;
  linkUrl: string | null;
  linkSubmittedAt: string | null;
  linkPostedAt: string | null;
  ownershipCheck: string | null;
  ownershipDetail: string | null;
  ownershipCheckedAt: string | null;
  linkVerifiedAt: string | null;
  postMissingAt: string | null;
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
};
export const closedReasonText = (r: string | null) => (r ? CLOSED_REASON[r] ?? r.replace(/_/g, " ") : null);

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
  share_link: "it is a Facebook share link that couldn't be turned into a post",
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
        detail: `${detail ? `Because ${OWNERSHIP_REASON[detail] ?? detail.replace(/_/g, " ")}. ` : ""}Open the link and check it yourself.`,
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
      return { label: "Posted by hand", color: "#00D7A0" };
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
