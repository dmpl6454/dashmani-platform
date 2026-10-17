import { randomUUID } from "crypto";
import { prisma, Prisma, type CreatorOffer } from "@dashmani/db";
import { CREATOR_TARGET_TYPE, FORMAT_LABELS, canonicalKey, isPlatformPostUrl, type CampaignPlatform } from "@dashmani/shared";
import { AppError } from "../../middleware/error-handler";
import { decryptToken, scrubSecrets } from "../../utils/token-crypto";
import { oauthGraphFetch, makeBudget } from "../meta-oauth/oauth-graph";
import { resolveFacebookShareUrl } from "../social-insights/facebook.provider";
import { signedMediaPath } from "../campaign/media-url";
import { itemOverlay, itemText, logBookingEvent, resolveItemFiles, type Actor } from "../campaign/booking.service";
import { creatorConfig } from "./creator-config";
import { creatorMetaAppSecret } from "./creator-meta-config";
import { LIVE_CONNECTION_STATUSES } from "./creator-view";
import { button, creatorLink, esc, sendCreatorEmail } from "./creator-email";
import { alertStaffOncePerHour } from "./payout-alert";
import { ensurePayoutRefundable, payoutAllowsLink, withdrawOpenOffers, type PayoutActor } from "./payout-ledger";

// Creator OFFERS (payout plan Phase 3): what happens between "staff approved a campaign that books a creator's page"
// and "staff verified the post the creator made".
//
//   approve    createOffersForBooking: one offer per creator item, the creator is emailed the exact ₹ they receive
//   offered →  accepted  (creator, before the offer expires)   the item goes manual_pending: the creator posts by HAND
//           →  declined  (creator)                              item refund_due, planned payout void, staff alerted
//           →  expired   (the worker)                           same
//           →  withdrawn (staff, or the missed-window worker)   same
//   accepted   the creator pastes the post's link (submitOfferLink): it is checked against the creator's OWN recent
//              posts through their live connection; staff then verify it (verifyCreatorItem)
//
// ⚠️ THE RULES THIS FILE KEEPS
//   • Every transition is ONE set of conditional updateMany calls under the booking's row lock, so two racing actors
//     (an accept and a withdraw, two tabs) cannot both win: the loser gets a 409 and nothing of theirs is written. The
//     writes always go item → payout → offer, the same order refundItem uses, so the two never deadlock.
//   • NOTHING REFUNDS ANYTHING HERE. A declined / expired / withdrawn offer moves its item to `refund_due`, voids the
//     payout that was only planned, and tells staff; staff then press Refund (refundItem). The money path is theirs.
//   • A creator-facing response is built from an explicit allow-list (toOfferRow / toOfferDetail): never the brand's
//     price, the booking total, another item, the client's company or contact, share_bps or the gross (share × the
//     brand's price would give the price away), or another creator. Another creator's offer is a 404, never a 403.
//   • No network call and no email inside a transaction. Mail is sent after the commit and never fails the action.

type Tx = Prisma.TransactionClient;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const IST_OFFSET_MS = 5.5 * HOUR_MS;

/** A creator may still hand in their link this long after the posting window closes. */
export const POSTING_GRACE_MS = DAY_MS;
/** Signed media links handed to a creator live this long. */
const MEDIA_TTL_SEC = 4 * 3600;

/**
 * What the creator must do about the paid-partnership rules, shown on the offer and in the email. They post by hand,
 * so the label is theirs to switch on: there is no API publishing on a creator's page in this phase.
 */
export const CREATOR_DISCLOSURE_INSTRUCTION =
  "This is a paid partnership. Before you publish, switch on the platform's paid-partnership / branded-content label (Instagram: \"Add paid partnership label\"; Facebook: the branded-content tool) and tag the brand if it asks you to. Do not publish it without the label.";

/** `ownership_check` values. 'unverifiable' means we could not read the creator's page, so a person decides. */
export type OwnershipCheck = "auto_ok" | "auto_failed" | "manual_ok" | "unverifiable";

// ── Small pure helpers ──────────────────────────────────────────────────────────────────────────

/** ₹ with Indian grouping; paise shown only when there are some. */
export function inr(paise: number): string {
  const rupees = paise / 100;
  return `₹${rupees.toLocaleString("en-IN", { minimumFractionDigits: rupees % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/** A stored IST calendar day (a DATE column, read back as that day at 00:00 UTC). */
const fmtDay = (d: Date) => new Intl.DateTimeFormat("en-IN", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" }).format(d);
const fmtDateTimeIST = (d: Date) =>
  `${new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true }).format(d)} IST`;

/**
 * The posting window as instants. launchFrom / launchTo (and an offer's window_from / window_to, which freeze them) are
 * stored as an IST calendar day at 00:00 UTC, so the window opens when launchFrom's IST day starts and closes (exclusive)
 * when launchTo's IST day ends.
 */
export function postingWindow(launchFrom: Date | null, launchTo: Date | null): { from: Date | null; to: Date | null } {
  return {
    from: launchFrom ? new Date(launchFrom.getTime() - IST_OFFSET_MS) : null,
    to: launchTo ? new Date(launchTo.getTime() + DAY_MS - IST_OFFSET_MS) : null,
  };
}

/** An offer's own (frozen) window as instants. */
export const offerWindow = (o: Pick<CreatorOffer, "windowFrom" | "windowTo">) => postingWindow(o.windowFrom, o.windowTo);

/** The last instant a creator can still submit their link: the window's end plus the grace. Null when the offer has no window. */
export function linkDeadline(o: Pick<CreatorOffer, "windowTo">): Date | null {
  const end = postingWindow(null, o.windowTo).to;
  return end ? new Date(end.getTime() + POSTING_GRACE_MS) : null;
}

/** The window as the two IST calendar days a creator reads ("post between"): the first day and the LAST day, both inclusive. */
const ymd = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const windowDays = (o: Pick<CreatorOffer, "windowFrom" | "windowTo">) => ({ from: ymd(o.windowFrom), to: ymd(o.windowTo) });

/** The row lock every booking edit takes first (the same statement as booking.service's lockBooking, which is private). */
async function lockBookingRow(tx: Tx, bookingId: string) {
  await tx.$queryRaw`SELECT id FROM campaign_bookings WHERE id = ${bookingId} FOR UPDATE`;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

// ── Approve: one offer per creator item ─────────────────────────────────────────────────────────

/** A creator item that was paid for but cannot be offered: it went refund_due and staff are told. */
export interface OfferProblem {
  itemId: string;
  accountName: string;
  /** page_changed: the page has another owner than at checkout. creator_unavailable: the creator is no longer approved, or their payout account is no longer active. */
  reason: "page_changed" | "creator_unavailable";
}

const PROBLEM_TEXT: Record<OfferProblem["reason"], string> = {
  page_changed: "The page changed hands after checkout, so the creator who was booked no longer owns it. Refund this one.",
  creator_unavailable: "The creator who was booked can no longer take this post (their account is suspended or closed, or their payout account is not active). Refund this one.",
};

export interface CreatedOffer {
  id: string;
  bookingItemId: string;
  creatorId: string;
  pageName: string;
  payoutPaise: number;
  expiresAt: Date;
}
export interface CreatedOffers {
  /** Creator items that were still pending when approval ran (0 for a network-only booking). */
  creatorItems: number;
  offers: CreatedOffer[];
  problems: OfferProblem[];
  /** For staff, in the approve response. */
  warnings: string[];
}

/**
 * Inside approve()'s transaction, AFTER the booking moved to approved: turn every still-pending creator item into an
 * offer. A booking with no creator items costs one indexed query and changes nothing.
 *
 * It REFUSES, with nothing written (the caller's transaction rolls back, so the approval itself does not happen):
 *   409 MARKETPLACE_OFF  the creator marketplace is switched off (staff refund those items from their own rows first)
 *   409 NOT_READY        the booking has no `paid_at`, or a creator item has no payout row in a usable state
 *   409 WINDOW_ENDED     the posting window has already closed, so there is nothing left for a creator to do
 * and warns (in `warnings`) when less than 24 hours of the window remain.
 *
 * An item whose page now belongs to someone else, or whose creator is no longer approved / has no active payout account,
 * gets NO offer: it goes refund_due, its planned payout is voided, and staff are alerted (alertOfferProblems, after the
 * commit). Everything else becomes one `offered` creator_offers row (payout_paise = the amount frozen at checkout) with
 * the item on `awaiting_creator`.
 */
export async function createOffersForBooking(tx: Tx, bookingId: string, actor: Actor, now: Date = new Date()): Promise<CreatedOffers> {
  const items = await tx.campaignBookingItem.findMany({
    where: { bookingId, targetType: CREATOR_TARGET_TYPE, status: "pending" },
    orderBy: { id: "asc" },
    select: { id: true, targetId: true, platform: true, format: true, accountName: true, accountHandle: true },
  });
  const out: CreatedOffers = { creatorItems: items.length, offers: [], problems: [], warnings: [] };
  if (items.length === 0) return out;

  if (!creatorConfig.marketplaceAvailable()) {
    throw new AppError(409, "MARKETPLACE_OFF", "Creator bookings are switched off, so this campaign can't be approved with a creator's post in it. Refund the creator posts from their own rows, then approve the rest.");
  }
  const booking = await tx.campaignBooking.findUnique({ where: { id: bookingId }, select: { paidAt: true, launchFrom: true, launchTo: true } });
  if (!booking?.paidAt) {
    throw new AppError(409, "NOT_READY", "This campaign has a creator's post but no recorded online payment, so no offer can be made. Nothing has been changed.");
  }
  const payouts = await tx.creatorPayout.findMany({ where: { bookingItemId: { in: items.map((i) => i.id) } } });
  const payoutOf = new Map(payouts.map((p) => [p.bookingItemId, p]));
  const notReady = items.filter((i) => {
    const p = payoutOf.get(i.id);
    return !p || !payoutAllowsLink(p.status);
  });
  if (notReady.length > 0) {
    throw new AppError(409, "NOT_READY", `The creator's payout isn't ready for: ${notReady.map((i) => i.accountName || i.id).join(", ")}. Nothing has been changed.`);
  }

  const win = postingWindow(booking.launchFrom, booking.launchTo);
  if (win.to && win.to.getTime() <= now.getTime()) {
    throw new AppError(409, "WINDOW_ENDED", "The posting window for this campaign has already ended, so a creator can no longer post for it. Refund the creator posts, or ask the client for new dates.");
  }
  if (win.to && win.to.getTime() - now.getTime() < DAY_MS) {
    out.warnings.push(`Less than 24 hours of the posting window remain (it ends ${fmtDateTimeIST(win.to)}). The creator has until then to accept and post.`);
  }
  const expiresAt = new Date(Math.min(now.getTime() + creatorConfig.offerTtlHours() * HOUR_MS, win.to?.getTime() ?? Infinity));

  // Who owns each page NOW, and whether the creator and their payout account can still take the post.
  const assets = await tx.creatorAsset.findMany({ where: { id: { in: items.map((i) => i.targetId) } }, select: { id: true, creatorId: true, name: true, username: true } });
  const assetOf = new Map(assets.map((a) => [a.id, a]));
  const creatorIds = [...new Set(payouts.map((p) => p.creatorId))];
  const creators = await tx.creator.findMany({ where: { id: { in: creatorIds } }, select: { id: true, status: true } });
  const accounts = await tx.creatorPayoutAccount.findMany({ where: { creatorId: { in: creatorIds } }, select: { creatorId: true, activationStatus: true } });
  const creatorOk = new Set(creators.filter((c) => c.status === "approved").map((c) => c.id));
  const accountOk = new Set(accounts.filter((a) => a.activationStatus === "activated").map((a) => a.creatorId));
  const already = new Set((await tx.creatorOffer.findMany({ where: { bookingItemId: { in: items.map((i) => i.id) } }, select: { bookingItemId: true } })).map((o) => o.bookingItemId));

  const rows: Prisma.CreatorOfferCreateManyInput[] = [];
  for (const item of items) {
    const p = payoutOf.get(item.id)!;
    if (already.has(item.id)) continue; // one offer per item (booking_item_id is UNIQUE): never a second
    const asset = assetOf.get(item.targetId);
    if (!asset || asset.creatorId !== p.creatorId) {
      out.problems.push({ itemId: item.id, accountName: item.accountName, reason: "page_changed" });
      continue;
    }
    if (!creatorOk.has(p.creatorId) || !accountOk.has(p.creatorId)) {
      out.problems.push({ itemId: item.id, accountName: item.accountName, reason: "creator_unavailable" });
      continue;
    }
    const id = randomUUID();
    rows.push({
      id,
      bookingId,
      bookingItemId: item.id,
      creatorId: p.creatorId,
      creatorAssetId: item.targetId,
      pageName: clip(asset.name || item.accountName, 200),
      pageHandle: asset.username ? clip(asset.username, 100) : item.accountHandle ? clip(item.accountHandle, 100) : null,
      platform: item.platform,
      format: item.format,
      status: "offered",
      payoutPaise: p.amountPaise,
      // The window is frozen as the two IST calendar days it was booked for (the columns are DATEs).
      windowFrom: booking.launchFrom,
      windowTo: booking.launchTo,
      offeredAt: now,
      expiresAt,
    });
    out.offers.push({ id, bookingItemId: item.id, creatorId: p.creatorId, pageName: clip(asset.name || item.accountName, 200), payoutPaise: p.amountPaise, expiresAt });
  }

  if (rows.length > 0) {
    const moved = await tx.campaignBookingItem.updateMany({ where: { id: { in: rows.map((r) => r.bookingItemId) }, status: "pending" }, data: { status: "awaiting_creator", lastError: null, nextAttemptAt: null } });
    if (moved.count !== rows.length) throw new AppError(409, "INVALID_STATE", "A creator post changed while the campaign was being approved. Refresh and try again.");
    await tx.creatorOffer.createMany({ data: rows });
    await logBookingEvent(bookingId, actor, `Offered to the creator: ${out.offers.map((o) => `${o.pageName} (${inr(o.payoutPaise)})`).join(", ")}`.slice(0, 500), tx);
  }
  for (const pr of out.problems) {
    const claim = await tx.campaignBookingItem.updateMany({ where: { id: pr.itemId, status: "pending" }, data: { status: "refund_due", lastError: PROBLEM_TEXT[pr.reason].slice(0, 500) } });
    if (claim.count !== 1) continue;
    // A throw here (the payout is already past `planned`) undoes the whole approval, like reconcileCreatorOwnership.
    await ensurePayoutRefundable(pr.itemId, { tx, actor: { type: actor.type === "staff" ? "staff" : "system", id: actor.id ?? null }, reason: pr.reason });
    await withdrawOpenOffers(tx, [pr.itemId], pr.reason === "page_changed" ? "page_taken_over" : "withdrawn", null);
  }
  if (out.problems.length > 0) {
    await logBookingEvent(bookingId, actor, `Creator post(s) need a refund: ${out.problems.map((p) => `${p.accountName || p.itemId} (${p.reason})`).join(", ")}`.slice(0, 500), tx);
  }
  return out;
}

/** Staff alert for the items createOffersForBooking sent to refund_due. Call AFTER the approving transaction committed. */
export function alertOfferProblems(bookingId: string, problems: OfferProblem[]): void {
  if (problems.length === 0) return;
  alertStaffOncePerHour(
    `creator-offer-problem:${bookingId}`,
    "A creator's post can't go ahead and needs a refund",
    [{ label: "Campaign", value: bookingId }, ...problems.map((p) => ({ label: p.accountName || p.itemId, value: PROBLEM_TEXT[p.reason] }))],
    `/campaigns/${bookingId}`,
  );
}

// ── Email ───────────────────────────────────────────────────────────────────────────────────────

const PLATFORM_LABEL: Record<string, string> = { instagram: "Instagram", facebook: "Facebook", youtube: "YouTube" };
const formatLabel = (f: string) => (FORMAT_LABELS as Record<string, string>)[f] ?? f;

const offerLink = (offerId: string) => creatorLink(`/booking?id=${encodeURIComponent(offerId)}`);

/**
 * Email the creators of freshly made offers. ⚠️ What goes in: the page, the format, the window, the exact ₹ they will
 * receive, when the offer expires, what to do, the disclosure line. What never does: the brand's price, the booking
 * total, the client, other items, other creators. Everything interpolated is escaped. Never throws; `notified_at` is
 * stamped only for a mail that really went out, so a failed send is simply retried by nobody (the offer is on screen).
 */
export async function sendOfferEmails(offerIds: string[]): Promise<number> {
  if (offerIds.length === 0) return 0;
  let sent = 0;
  try {
    const offers = await prisma.creatorOffer.findMany({ where: { id: { in: offerIds }, status: "offered", notifiedAt: null } });
    const creators = await prisma.creator.findMany({ where: { id: { in: [...new Set(offers.map((o) => o.creatorId))] } }, select: { id: true, name: true, email: true, status: true } });
    const byId = new Map(creators.map((c) => [c.id, c]));
    for (const o of offers) {
      const c = byId.get(o.creatorId);
      if (!c || c.status === "closed") continue;
      try {
        const w = windowDays(o);
        const body =
          `<p>Hi ${esc(c.name)},</p>` +
          `<p>You have a new booking offer for <b>${esc(o.pageName)}</b>: one ${esc(PLATFORM_LABEL[o.platform] ?? o.platform)} ${esc(formatLabel(o.format).toLowerCase())}.</p>` +
          `<table style="border-collapse:collapse;margin:8px 0 16px">` +
          `<tr><td style="padding:4px 18px 4px 0;color:#555">You will receive</td><td style="padding:4px 0"><b>${esc(inr(o.payoutPaise))}</b> <span style="color:#555">(after any tax deducted at source)</span></td></tr>` +
          (w.from && w.to ? `<tr><td style="padding:4px 18px 4px 0;color:#555">Post between</td><td style="padding:4px 0"><b>${esc(fmtDay(o.windowFrom!))}</b> and <b>${esc(fmtDay(o.windowTo!))}</b> (IST)</td></tr>` : "") +
          `<tr><td style="padding:4px 18px 4px 0;color:#555">Accept by</td><td style="padding:4px 0"><b>${esc(fmtDateTimeIST(o.expiresAt))}</b></td></tr>` +
          `</table>` +
          `<p><b>What you need to do</b></p>` +
          `<ol style="margin:0 0 16px;padding-left:20px"><li>Open the offer, check the files, the caption and the amount, and accept it before it expires.</li>` +
          `<li>Post it yourself on your page during the window, exactly as given.</li>` +
          `<li>Paste the link of your post into the offer so we can check it.</li></ol>` +
          `<p><b>Paid partnership.</b> ${esc(CREATOR_DISCLOSURE_INSTRUCTION)}</p>` +
          `<p>${button(offerLink(o.id), "View the offer")}</p>` +
          `<p style="color:#555">If you don't accept in time the offer simply lapses, and nothing is owed either way.</p>`;
        const res = await sendCreatorEmail(c.email, `You have a booking offer: ${inr(o.payoutPaise)} for ${o.pageName}`, "You have a booking offer", body);
        if (res != null) {
          await prisma.creatorOffer.updateMany({ where: { id: o.id, notifiedAt: null }, data: { notifiedAt: new Date() } });
          sent++;
        }
      } catch (e) {
        console.warn(`[creator-offers] offer email failed for ${o.id}: ${scrubSecrets(String(e)).slice(0, 200)}`);
      }
    }
  } catch (e) {
    console.warn(`[creator-offers] offer emails failed: ${scrubSecrets(String(e)).slice(0, 200)}`);
  }
  return sent;
}

/** The launch-day reminder: one email to a creator whose accepted offer has no link yet. Returns whether the mail went out. */
export async function sendLaunchReminder(o: CreatorOffer): Promise<boolean> {
  const c = await prisma.creator.findUnique({ where: { id: o.creatorId }, select: { name: true, email: true, status: true } });
  if (!c || c.status === "closed" || !o.windowTo) return false;
  const body =
    `<p>Hi ${esc(c.name)},</p>` +
    `<p>Your posting window for <b>${esc(o.pageName)}</b> is open. Post the ${esc(PLATFORM_LABEL[o.platform] ?? o.platform)} ${esc(formatLabel(o.format).toLowerCase())} on your page by <b>${esc(fmtDay(o.windowTo))}</b> (IST), then paste its link into the offer.</p>` +
    `<p>You will receive <b>${esc(inr(o.payoutPaise))}</b> (after any tax deducted at source) once we have checked your post.</p>` +
    `<p><b>Paid partnership.</b> ${esc(CREATOR_DISCLOSURE_INSTRUCTION)}</p>` +
    `<p>${button(offerLink(o.id), "Open the offer")}</p>`;
  try {
    return (await sendCreatorEmail(c.email, `Reminder: post for ${o.pageName}`, "Your posting window is open", body)) != null;
  } catch (e) {
    console.warn(`[creator-offers] reminder failed for ${o.id}: ${scrubSecrets(String(e)).slice(0, 200)}`);
    return false;
  }
}

// ── Transitions ─────────────────────────────────────────────────────────────────────────────────

async function ownOffer(creatorId: string, offerId: string): Promise<CreatorOffer> {
  // Another creator's offer is "not found", never "forbidden": its existence is not theirs to learn.
  const o = await prisma.creatorOffer.findFirst({ where: { id: offerId, creatorId } });
  if (!o) throw new AppError(404, "NOT_FOUND", "Offer not found");
  return o;
}

/** The lines on the item row (staff-only) when a closed offer sends its item to refund_due. */
const REFUND_DUE_TEXT = {
  declined: "The creator declined this offer. Refund this post.",
  expired: "The creator didn't respond before the offer expired. Refund this post.",
  withdrawn: "The offer was withdrawn. Refund this post.",
  missed_window: "The creator didn't post within the posting window. Refund this post.",
} as const;
type ClosedReason = keyof typeof REFUND_DUE_TEXT;
type CloseKind = "declined" | "expired" | "withdrawn";

interface CloseArgs {
  offerId: string;
  kind: CloseKind;
  closedReason: ClosedReason;
  actor: PayoutActor;
  now: Date;
  /** decline: only this creator's own offer. */
  creatorId?: string;
  note?: string | null;
  /** withdraw: also close an accepted offer whose submitted link has not been verified (staff decided the link is no good). */
  discardSubmittedLink?: boolean;
  /** Tell staff the item needs a refund (the workers and the creator do; a member of staff clicking Withdraw is already looking at it). */
  alert: boolean;
}

/** Why an offer can't be closed this way right now: the 409 the caller gets (checked under the lock, so it is the truth). */
function whyNotClosable(o: CreatorOffer, a: CloseArgs): AppError | null {
  if (a.kind === "declined") {
    return o.status === "offered" ? null : new AppError(409, "OFFER_CLOSED", "This offer is no longer open.");
  }
  if (a.kind === "expired") {
    if (o.status !== "offered") return new AppError(409, "OFFER_CLOSED", "This offer is no longer open.");
    return o.expiresAt.getTime() <= a.now.getTime() ? null : new AppError(409, "NOT_EXPIRED", "This offer hasn't expired yet.");
  }
  if (o.status === "offered") return null;
  if (o.status !== "accepted") return new AppError(409, "OFFER_CLOSED", "This offer is already closed.");
  if (o.linkVerifiedAt) return new AppError(409, "ALREADY_VERIFIED", "This post has already been verified and is live. It can't be withdrawn.");
  if (o.linkSubmittedAt && !a.discardSubmittedLink) {
    return new AppError(409, "LINK_SUBMITTED", "The creator has already submitted their link. Check it and verify it, or (if it is not their post) withdraw with “discard the submitted link”.");
  }
  return null;
}

/**
 * Close an open offer: its item → refund_due, its planned payout → void, the offer → declined | expired | withdrawn,
 * ALL in one transaction under the booking lock, or none of it. A payout that is already past `planned` refuses the
 * whole thing (409 PAYOUT_NOT_REVERSIBLE_YET, see ensurePayoutRefundable): nothing changes and the offer stays open.
 *
 * ⚠️ TODO(Phase 4): ensurePayoutRefundable is called INSIDE this transaction because in Phase 3 it is a database-only void.
 * The real reversal of a transferred payout is a Razorpay call, and no network call may sit inside a transaction: Phase 4
 * has to split this into "claim the offer and the item (one short transaction, offer → a closing state)", then "reverse the
 * held transfer", then "finish (void + refund_due)", with the booking lock released across the call.
 */
async function closeOffer(a: CloseArgs): Promise<CreatorOffer> {
  const found = await prisma.creatorOffer.findUnique({ where: { id: a.offerId } });
  if (!found || (a.creatorId && found.creatorId !== a.creatorId)) throw new AppError(404, "NOT_FOUND", "Offer not found");
  const staffId = a.actor.type === "staff" ? a.actor.id ?? null : null;

  const closed = await prisma.$transaction(async (tx) => {
    await lockBookingRow(tx, found.bookingId);
    const o = await tx.creatorOffer.findUnique({ where: { id: a.offerId } });
    if (!o) throw new AppError(404, "NOT_FOUND", "Offer not found");
    const bad = whyNotClosable(o, a);
    if (bad) throw bad;

    // Item, then payout, then offer: the same order refundItem takes its rows in.
    const itemFrom = a.kind === "withdrawn" ? ["awaiting_creator", "manual_pending"] : ["awaiting_creator"];
    const item = await tx.campaignBookingItem.updateMany({ where: { id: o.bookingItemId, status: { in: itemFrom } }, data: { status: "refund_due", lastError: REFUND_DUE_TEXT[a.closedReason] } });
    if (item.count !== 1) throw new AppError(409, "INVALID_STATE", "This post is no longer waiting on the creator. Refresh and try again.");
    await ensurePayoutRefundable(o.bookingItemId, { tx, actor: a.actor, reason: a.closedReason });

    const where: Prisma.CreatorOfferWhereInput =
      a.kind === "declined"
        ? { id: o.id, creatorId: o.creatorId, status: "offered" }
        : a.kind === "expired"
          ? { id: o.id, status: "offered", expiresAt: { lte: a.now } }
          : { id: o.id, OR: [{ status: "offered" }, { status: "accepted", linkVerifiedAt: null, ...(a.discardSubmittedLink ? {} : { linkSubmittedAt: null }) }] };
    const data: Prisma.CreatorOfferUpdateManyMutationInput =
      a.kind === "declined"
        ? { status: "declined", declinedAt: a.now, closedReason: "declined", creatorNote: a.note ? clip(a.note, 500) : null }
        : a.kind === "expired"
          ? { status: "expired", expiredAt: a.now, closedReason: "expired" }
          : { status: "withdrawn", withdrawnAt: a.now, withdrawnById: staffId, closedReason: a.closedReason };
    const res = await tx.creatorOffer.updateMany({ where, data });
    if (res.count !== 1) throw new AppError(409, "OFFER_CLOSED", "This offer changed while it was being closed. Refresh and try again.");

    const what = { declined: "declined the offer", expired: "did not respond: the offer expired", withdrawn: a.closedReason === "missed_window" ? "did not post in the window: the offer was withdrawn" : "offer withdrawn" }[a.kind];
    await logBookingEvent(o.bookingId, { type: staffId ? "staff" : "system", id: staffId }, `Creator post on ${o.pageName}: ${what}. The post needs a refund (nothing has been refunded).`.slice(0, 500), tx);
    return (await tx.creatorOffer.findUniqueOrThrow({ where: { id: o.id } }));
  });

  if (a.alert) {
    alertStaffOncePerHour(
      `creator-offer-closed:${closed.bookingItemId}`,
      "A creator's post needs a refund",
      [
        { label: "Campaign", value: closed.bookingId },
        { label: "Page", value: closed.pageName },
        { label: "What happened", value: REFUND_DUE_TEXT[a.closedReason].replace(/ Refund this post\.$/, "") },
        ...(a.note ? [{ label: "The creator wrote", value: clip(a.note, 300) }] : []),
        { label: "What to do", value: "Open the campaign and press Refund on that post. Nothing is refunded automatically." },
      ],
      `/campaigns/${closed.bookingId}`,
    );
  }
  return closed;
}

/** The creator accepts. Only while the offer is `offered` and not past its expiry, only while the item still waits for them. */
export async function acceptOffer(creatorId: string, offerId: string, now: Date = new Date()): Promise<CreatorOffer> {
  const found = await ownOffer(creatorId, offerId);
  await prisma.$transaction(async (tx) => {
    await lockBookingRow(tx, found.bookingId);
    // Item first (the order refundItem uses), then the payout check, then the offer: the conditional update is the arbiter.
    const item = await tx.campaignBookingItem.updateMany({ where: { id: found.bookingItemId, status: "awaiting_creator" }, data: { status: "manual_pending", lastError: null } });
    const cur = await tx.creatorOffer.findUnique({ where: { id: found.id } });
    if (item.count !== 1 || !cur || cur.status !== "offered") throw new AppError(409, "OFFER_CLOSED", "This offer is no longer open.");
    if (cur.expiresAt.getTime() <= now.getTime()) throw new AppError(409, "OFFER_EXPIRED", "This offer has expired.");
    const payout = await tx.creatorPayout.findUnique({ where: { bookingItemId: found.bookingItemId }, select: { status: true } });
    if (!payout || !payoutAllowsLink(payout.status)) throw new AppError(409, "OFFER_UNAVAILABLE", "This booking can't go ahead any more. Contact us if you think that is a mistake.");
    const res = await tx.creatorOffer.updateMany({ where: { id: found.id, creatorId, status: "offered", expiresAt: { gt: now } }, data: { status: "accepted", acceptedAt: now, closedReason: null } });
    if (res.count !== 1) throw new AppError(409, "OFFER_CLOSED", "This offer is no longer open.");
    await logBookingEvent(found.bookingId, { type: "system" }, `Creator post on ${found.pageName}: the creator accepted the offer.`, tx);
  });
  return prisma.creatorOffer.findUniqueOrThrow({ where: { id: found.id } });
}

/** The creator declines (an offer that is still `offered`). The item goes refund_due; staff are told; nothing is refunded. */
export async function declineOffer(creatorId: string, offerId: string, reason?: string | null, now: Date = new Date()): Promise<CreatorOffer> {
  await ownOffer(creatorId, offerId);
  return closeOffer({ offerId, kind: "declined", closedReason: "declined", actor: { type: "creator", id: creatorId }, creatorId, note: reason?.trim() || null, now, alert: true });
}

/** The worker: an offer past its expiry that nobody answered. Throws 409 NOT_EXPIRED when it is not yet due. */
export async function expireOffer(offerId: string, now: Date = new Date()): Promise<CreatorOffer> {
  return closeOffer({ offerId, kind: "expired", closedReason: "expired", actor: { type: "system" }, now, alert: true });
}

/**
 * Staff (or the missed-window worker) withdraw an offer: `offered`, or `accepted` with NO link submitted yet.
 * `discardSubmittedLink` (staff only, explicit) also closes an accepted offer whose link was submitted but NOT verified:
 * the way out when staff have looked at the link and it is not the creator's post. A verified post can never be withdrawn.
 */
export async function withdrawOffer(
  offerId: string,
  o: { staffId?: string | null; closedReason?: "withdrawn" | "missed_window"; discardSubmittedLink?: boolean; alert?: boolean; now?: Date } = {},
): Promise<CreatorOffer> {
  return closeOffer({
    offerId,
    kind: "withdrawn",
    closedReason: o.closedReason ?? "withdrawn",
    actor: o.staffId ? { type: "staff", id: o.staffId } : { type: "system" },
    now: o.now ?? new Date(),
    discardSubmittedLink: o.discardSubmittedLink === true,
    alert: o.alert ?? !o.staffId,
  });
}

// ── The creator's link ──────────────────────────────────────────────────────────────────────────

export interface LinkOwnership {
  check: Exclude<OwnershipCheck, "manual_ok">;
  /** A short reason CODE (never a Graph body, never a token): matched | not_found | outside_window | token_lapsed | permission | … */
  detail: string;
  /** When the matched post went live. */
  postedAt: Date | null;
  /**
   * The post's identity (ownershipMatchKey): what is stored as link_canonical_key and what "one post, one booking" compares.
   * For a Facebook /share/ link that could be followed it is the key of the post it led to, not of the share code.
   */
  key: string;
}

interface MediaRow {
  permalink?: string;
  timestamp?: string;
  permalink_url?: string;
  created_time?: string;
}

/**
 * What a post's link is compared on. canonicalKey for every form it understands (ig:/yt:/fb:/sc:); for the ones it
 * leaves as a raw URL (an opaque Facebook /posts/pfbid… or story.php link) the host and path, so a tracking query or a
 * www./m. prefix cannot hide a real match. ⚠️ The path keeps its CASE: pfbid ids are case-sensitive, and the Facebook
 * reel id (/reel/<n>) is a DIFFERENT id from the {page}_{post} composite, so canonical keys are compared, never raw strings.
 */
export function ownershipMatchKey(raw: string): string {
  const k = canonicalKey(raw);
  if (/^(ig|yt|fb|sc):/.test(k)) return k;
  try {
    const u = new URL(raw.trim());
    const host = u.hostname.toLowerCase().replace(/^(www\.|m\.|mobile\.|web\.)/, "");
    const path = u.pathname.replace(/\/+$/, "");
    if (/\/(story|permalink)\.php$/i.test(path)) return `${host}${path.toLowerCase()}?${u.searchParams.get("story_fbid") ?? ""}&${u.searchParams.get("id") ?? ""}`;
    return `${host}${path}`;
  } catch {
    return k;
  }
}

const isFacebookShareLink = (raw: string) => {
  try {
    const u = new URL(raw.trim());
    return /(^|\.)facebook\.com$/i.test(u.hostname) && /^\/share\//i.test(u.pathname);
  } catch {
    return false;
  }
};

/**
 * Is this link one of the creator's OWN recent posts inside the posting window? Read through the creator's own live
 * connection: Instagram `/{ig-id}/media` with the user token, Facebook `/{page-id}/published_posts` with the Page
 * token, ONE call, never stored (the list is read and dropped).
 *
 *   found, inside the window        → auto_ok
 *   read fine, not there / outside  → auto_failed   (the creator is told and can send another link)
 *   could not read their page       → unverifiable  (token lapsed, permission, throttled, unreachable…): a person decides
 *
 * Never throws; never logs a token or a Graph body.
 */
export async function checkLinkOwnership(offer: CreatorOffer, url: string): Promise<LinkOwnership> {
  let key = ownershipMatchKey(url);
  const unverifiable = (detail: string): LinkOwnership => ({ check: "unverifiable", detail, postedAt: null, key });
  const asset = await prisma.creatorAsset.findUnique({
    where: { id: offer.creatorAssetId },
    select: {
      creatorId: true,
      kind: true,
      metaId: true,
      pageTokenEnc: true,
      disconnectedAt: true,
      connection: { select: { userTokenEnc: true, status: true, revokedAt: true } },
    },
  });
  if (!asset || asset.creatorId !== offer.creatorId || asset.disconnectedAt) return unverifiable("no_page");
  if (asset.connection.revokedAt || !(LIVE_CONNECTION_STATUSES as readonly string[]).includes(asset.connection.status)) return unverifiable("connection_lapsed");
  const isIg = asset.kind === "instagram_account";
  const enc = isIg ? asset.connection.userTokenEnc : asset.pageTokenEnc;
  if (!enc) return unverifiable("no_token");
  let token: string;
  try {
    token = decryptToken(enc);
  } catch {
    return unverifiable("token_unreadable");
  }

  // An opaque Facebook /share/ link names no post: follow its one redirect (fail-open) to the clean /reel/<id> form.
  let compareUrl = url;
  if (!isIg && !/^fb:/.test(canonicalKey(url)) && isFacebookShareLink(url)) {
    const resolved = await resolveFacebookShareUrl(url);
    if (!resolved) return unverifiable("share_link");
    compareUrl = resolved;
    key = ownershipMatchKey(resolved);
  }

  const res = await oauthGraphFetch<{ data?: MediaRow[] }>(
    isIg ? `${asset.metaId}/media` : `${asset.metaId}/published_posts`,
    isIg ? { fields: "permalink,timestamp", limit: 50 } : { fields: "permalink_url,created_time", limit: 25 },
    token,
    { label: "creator-offer-link-check", budget: makeBudget(1), appSecret: creatorMetaAppSecret() },
  );
  if (!res.ok) {
    if (res.authInvalid) return unverifiable("token_lapsed");
    if (res.rateLimited) return unverifiable("rate_limited");
    if (res.status === 0) return unverifiable("unreachable");
    if (res.errorCode === 10 || (res.errorCode != null && res.errorCode >= 200 && res.errorCode < 300)) return unverifiable("permission");
    return unverifiable("graph_error");
  }

  const want = key;
  const match = (res.data?.data ?? []).find((m) => {
    const link = isIg ? m.permalink : m.permalink_url;
    return typeof link === "string" && link !== "" && ownershipMatchKey(link) === want;
  });
  if (!match) return { check: "auto_failed", detail: "not_found", postedAt: null, key };
  const ts = Date.parse((isIg ? match.timestamp : match.created_time) ?? "");
  if (!Number.isFinite(ts)) return unverifiable("no_timestamp");
  const postedAt = new Date(ts);
  const win = offerWindow(offer);
  const inside = (!win.from || postedAt.getTime() >= win.from.getTime()) && (!win.to || postedAt.getTime() < win.to.getTime());
  return inside ? { check: "auto_ok", detail: "matched", postedAt, key } : { check: "auto_failed", detail: "outside_window", postedAt, key };
}

/** What a creator is told about the check on the link they just sent. */
export function linkCheckMessage(check: string | null, detail: string | null): string {
  switch (check) {
    case "auto_ok":
    case "manual_ok":
      return "We found your post on your page. Our team will confirm it shortly.";
    case "auto_failed":
      return detail === "outside_window"
        ? "That post was published outside the posting window. If it is the right post, our team can still look at it; otherwise post within the window and send that link."
        : "We couldn't find that post on your connected page. Check that you pasted the link of the post itself, from the page you connected, and send it again.";
    case "unverifiable":
      return "We couldn't check your page automatically right now, so our team will check this link by hand.";
    default:
      return "";
  }
}

/** Whether the creator may still hand in (or replace) a link. */
function assertLinkable(o: CreatorOffer, now: Date): void {
  if (o.status !== "accepted") throw new AppError(409, "OFFER_NOT_ACCEPTED", o.status === "offered" ? "Accept the offer before you send the link." : "This offer is closed.");
  if (o.linkVerifiedAt) throw new AppError(409, "ALREADY_VERIFIED", "Your post has already been verified.");
  const deadline = linkDeadline(o);
  if (deadline && now.getTime() >= deadline.getTime()) throw new AppError(409, "POSTING_CLOSED", "The posting window for this booking has closed.");
}

/**
 * The creator sends the link of the post they made BY HAND. It must be a link on the item's platform, the offer must be
 * accepted and not past the window + 24 h grace, the item must still wait for the post and its payout must not be void or
 * failed. The link is then checked against the creator's own recent posts (outside any transaction: it is a network call)
 * and stored with the verdict. The item stays `manual_pending`: only staff make a post live (verifyCreatorItem).
 *
 * Re-sending replaces the link and the verdict until staff verify it. One post can pay for one booking only
 * (409 LINK_ALREADY_USED when the same post is already on another offer).
 */
export async function submitOfferLink(creatorId: string, offerId: string, rawUrl: string, now: Date = new Date()) {
  const offer = await ownOffer(creatorId, offerId);
  assertLinkable(offer, now);
  const url = rawUrl.trim();
  // creator_offers.link_url is VARCHAR(500): refuse a longer one here, cleanly, before it can become a database error.
  if (url.length > 500) throw new AppError(400, "VALIDATION_ERROR", "That link is too long.");
  if (!isPlatformPostUrl(offer.platform as CampaignPlatform, url)) {
    throw new AppError(400, "WRONG_PLATFORM", `That isn't a ${PLATFORM_LABEL[offer.platform] ?? offer.platform} link.`);
  }

  const check = await checkLinkOwnership(offer, url);
  const key = clip(check.key, 255);

  await prisma.$transaction(async (tx) => {
    await lockBookingRow(tx, offer.bookingId);
    const cur = await tx.creatorOffer.findUnique({ where: { id: offer.id } });
    if (!cur || cur.creatorId !== creatorId) throw new AppError(404, "NOT_FOUND", "Offer not found");
    assertLinkable(cur, now);
    const item = await tx.campaignBookingItem.findUnique({ where: { id: cur.bookingItemId }, select: { status: true } });
    if (item?.status !== "manual_pending") throw new AppError(409, "OFFER_CLOSED", "This booking can no longer take a post.");
    const payout = await tx.creatorPayout.findUnique({ where: { bookingItemId: cur.bookingItemId }, select: { status: true } });
    if (!payout || !payoutAllowsLink(payout.status)) throw new AppError(409, "OFFER_UNAVAILABLE", "This booking can't go ahead any more. Contact us if you think that is a mistake.");
    const used = await tx.creatorOffer.count({ where: { linkCanonicalKey: key, id: { not: cur.id }, status: { in: ["accepted", "completed"] }, linkSubmittedAt: { not: null } } });
    if (used > 0) throw new AppError(409, "LINK_ALREADY_USED", "That post has already been sent in for another booking. Send the link of the post you made for this one.");
    const res = await tx.creatorOffer.updateMany({
      where: { id: cur.id, creatorId, status: "accepted", linkVerifiedAt: null },
      data: {
        linkUrl: url,
        linkCanonicalKey: key,
        linkSubmittedAt: now,
        linkPostedAt: check.postedAt,
        ownershipCheck: check.check,
        ownershipDetail: check.detail,
        ownershipCheckedAt: now,
        ownershipCheckedById: null,
      },
    });
    if (res.count !== 1) throw new AppError(409, "OFFER_CLOSED", "This offer changed. Refresh and try again.");
    await logBookingEvent(cur.bookingId, { type: "system" }, `Creator post on ${cur.pageName}: the creator sent their link (${check.check}${check.detail ? `: ${check.detail}` : ""}).`.slice(0, 500), tx);
  });

  return { check: check.check, detail: check.detail, message: linkCheckMessage(check.check, check.detail) };
}

// ── Staff: verify the creator's link ────────────────────────────────────────────────────────────

/**
 * Staff verify the link the creator submitted, which makes the post LIVE (the item goes posted_manual with the creator's
 * link). Refused, with nothing changed, unless ALL of these hold: an accepted offer, a link the creator submitted
 * (`url`, when given, must be that very post), the item waiting in manual_pending, a payout that is not void or failed, an
 * ownership check that PASSED (auto_ok / manual_ok), or one that did not (auto_failed / unverifiable) with the staff member
 * saying they checked by hand (`ownershipCheckedByHand`, which records manual_ok and who). One post can be verified for one
 * booking only. Stamps link_verified_at / link_verified_by_id. Nothing is paid here: see onCreatorLinkVerified (Phase 4).
 */
export async function verifyCreatorItem(
  bookingId: string,
  itemId: string,
  o: { staffId: string; url?: string | null; ownershipCheckedByHand?: boolean; now?: Date },
): Promise<{ offerId: string; accountName: string; permalink: string; format: string; manual: boolean }> {
  const now = o.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    await lockBookingRow(tx, bookingId);
    const item = await tx.campaignBookingItem.findFirst({ where: { id: itemId, bookingId } });
    if (!item) throw new AppError(404, "NOT_FOUND", "Item not found");
    if (item.targetType !== CREATOR_TARGET_TYPE) throw new AppError(409, "NOT_CREATOR_ITEM", "This isn't a creator's post.");
    if (item.status === "posted_manual" || item.status === "published") throw new AppError(409, "ALREADY_VERIFIED", "This post has already been verified.");
    if (item.status === "awaiting_creator") throw new AppError(409, "OFFER_NOT_ACCEPTED", "The creator hasn't accepted this offer yet.");
    if (item.status !== "manual_pending") throw new AppError(409, "INVALID_STATE", "This post isn't waiting for a creator's link (it may have been refunded).");
    const offer = await tx.creatorOffer.findUnique({ where: { bookingItemId: itemId } });
    if (!offer || offer.status !== "accepted") throw new AppError(409, "OFFER_NOT_ACCEPTED", "There is no accepted offer for this post.");
    if (!offer.linkSubmittedAt || !offer.linkUrl) throw new AppError(409, "NO_LINK", "The creator hasn't sent their link yet.");
    if (o.url && ownershipMatchKey(o.url) !== ownershipMatchKey(offer.linkUrl)) {
      throw new AppError(400, "LINK_MISMATCH", "A creator's post is recorded from the link the creator sent. That isn't their link.");
    }
    if (!isPlatformPostUrl(item.platform as CampaignPlatform, offer.linkUrl)) throw new AppError(400, "WRONG_PLATFORM", `The creator's link isn't a ${item.platform} link.`);

    const passed = offer.ownershipCheck === "auto_ok" || offer.ownershipCheck === "manual_ok";
    if (!passed && o.ownershipCheckedByHand !== true) {
      throw new AppError(
        409,
        "OWNERSHIP_NOT_CHECKED",
        `We couldn't confirm automatically that this post is on the creator's page${offer.ownershipCheck ? ` (${offer.ownershipCheck.replace("_", " ")}${offer.ownershipDetail ? `: ${offer.ownershipDetail.replace(/_/g, " ")}` : ""})` : ""}. Open the link, check it is on their page and inside the window, then verify again with “ownership checked by hand” ticked.`,
      );
    }
    const payout = await tx.creatorPayout.findUnique({ where: { bookingItemId: itemId }, select: { status: true } });
    if (!payout || !payoutAllowsLink(payout.status)) throw new AppError(409, "OFFER_UNAVAILABLE", "This creator's payout is void or has failed, so the post can't be verified. Refund it instead.");
    if (offer.linkCanonicalKey) {
      const dup = await tx.creatorOffer.count({ where: { linkCanonicalKey: offer.linkCanonicalKey, id: { not: offer.id }, linkVerifiedAt: { not: null } } });
      if (dup > 0) throw new AppError(409, "LINK_ALREADY_USED", "This post has already been verified for another booking.");
    }

    const claimed = await tx.campaignBookingItem.updateMany({
      where: { id: itemId, status: "manual_pending" },
      data: { status: "posted_manual", permalink: offer.linkUrl, postedAt: offer.linkPostedAt ?? now, postedById: o.staffId, lastError: null },
    });
    if (claimed.count !== 1) throw new AppError(409, "INVALID_STATE", "This post changed. Refresh and try again.");
    const manual = !passed;
    const stamped = await tx.creatorOffer.updateMany({
      where: { id: offer.id, status: "accepted", linkVerifiedAt: null, linkSubmittedAt: { not: null } },
      data: {
        linkVerifiedAt: now,
        linkVerifiedById: o.staffId,
        ...(manual ? { ownershipCheck: "manual_ok", ownershipCheckedAt: now, ownershipCheckedById: o.staffId } : {}),
      },
    });
    if (stamped.count !== 1) throw new AppError(409, "INVALID_STATE", "This offer changed. Refresh and try again.");
    await logBookingEvent(bookingId, { type: "staff", id: o.staffId }, `Verified the creator's link on ${item.accountName} (${item.format})${manual ? " — ownership checked by hand" : ""}: ${offer.linkUrl}`.slice(0, 500), tx);
    return { offerId: offer.id, accountName: item.accountName, permalink: offer.linkUrl, format: item.format, manual };
  });
}

// ── What a creator sees ─────────────────────────────────────────────────────────────────────────

/** The status a creator reads: an `offered` offer past its expiry reads `expired` even before the worker closes it. */
function effectiveStatus(o: Pick<CreatorOffer, "status" | "expiresAt">, now: Date): string {
  return o.status === "offered" && o.expiresAt.getTime() <= now.getTime() ? "expired" : o.status;
}

const payoutView = (paise: number) => ({ paise, currency: "INR" as const, display: inr(paise) });

/**
 * One row of the creator's offer list. ⚠️ AN ALLOW-LIST: these keys and no others. Nothing of the brand's money, the
 * booking, the client or any other creator.
 */
export function toOfferRow(o: CreatorOffer, now: Date = new Date()) {
  return {
    id: o.id,
    status: effectiveStatus(o, now),
    platform: o.platform,
    format: o.format,
    pageName: o.pageName,
    pageHandle: o.pageHandle,
    window: windowDays(o),
    payout: payoutView(o.payoutPaise),
    offeredAt: o.offeredAt.toISOString(),
    expiresAt: o.expiresAt.toISOString(),
  };
}

export async function listOffersForCreator(creatorId: string, now: Date = new Date()) {
  const rows = await prisma.creatorOffer.findMany({ where: { creatorId }, orderBy: [{ offeredAt: "desc" }, { id: "asc" }], take: 200 });
  return rows.map((o) => toOfferRow(o, now));
}

/**
 * The creator's view of ONE offer: the row, plus the brief (files to post, caption, hashtags, tags, collaborators, the
 * printed text) while the offer is open, the disclosure instruction, their link and what it was checked as, and which
 * actions are open. ⚠️ AN ALLOW-LIST, like toOfferRow. `brand` is the campaign's brand field: the name the post promotes
 * (it is in the caption and the paid-partnership tag anyway), never the client's company or contact.
 */
export async function getOfferForCreator(creatorId: string, offerId: string, now: Date = new Date()) {
  const o = await ownOffer(creatorId, offerId);
  const status = effectiveStatus(o, now);
  const [booking, item] = await Promise.all([
    prisma.campaignBooking.findUnique({
      where: { id: o.bookingId },
      select: { brand: true, format: true, caption: true, hashtags: true, userTags: true, collaborators: true, superText: true, superTextStyle: true },
    }),
    prisma.campaignBookingItem.findUnique({
      where: { id: o.bookingItemId },
      select: { captionOverride: true, hashtagsOverride: true, superTextOverride: true, superTextStyleOverride: true },
    }),
  ]);

  let brief: {
    files: Array<{ id: string; kind: string; role: string; ready: boolean; url: string | null; downloadUrl: string | null }>;
    caption: string;
    hashtags: string[];
    userTags: string[];
    collaborators: string[];
    printedText: { text: string; position: string | null } | null;
  } | null = null;
  // Only an offer that is still alive (or finished well) carries the brief: a declined, expired or withdrawn one has nothing left to post.
  if (booking && item && (status === "offered" || status === "accepted" || status === "completed")) {
    const files = (await resolveItemFiles(o.bookingId)).get(o.bookingItemId) ?? [];
    const text = itemText(booking, { captionOverride: item.captionOverride, hashtagsOverride: item.hashtagsOverride });
    const overlay = itemOverlay(booking, item);
    brief = {
      files: files.map((f) => {
        const ready = f.status === "done";
        const url = ready ? signedMediaPath(f.mediaId, f.renderId ? `v-${f.renderId}` : "preview", MEDIA_TTL_SEC) : null;
        return { id: f.mediaId, kind: f.kind, role: f.role, ready, url, downloadUrl: url ? `${url}&download=1` : null };
      }),
      caption: text.caption,
      hashtags: text.hashtags,
      userTags: booking.userTags,
      collaborators: booking.collaborators,
      printedText: overlay.text ? { text: overlay.text, position: overlay.style } : null,
    };
  }

  const deadline = linkDeadline(o);
  const open = status === "offered";
  return {
    ...toOfferRow(o, now),
    brand: booking?.brand ?? null,
    acceptedAt: o.acceptedAt ? o.acceptedAt.toISOString() : null,
    disclosure: CREATOR_DISCLOSURE_INSTRUCTION,
    brief,
    link: o.linkUrl
      ? {
          url: o.linkUrl,
          submittedAt: o.linkSubmittedAt ? o.linkSubmittedAt.toISOString() : null,
          check: o.ownershipCheck,
          message: linkCheckMessage(o.ownershipCheck, o.ownershipDetail),
          verified: o.linkVerifiedAt != null,
        }
      : null,
    actions: {
      accept: open,
      decline: open,
      submitLink: o.status === "accepted" && !o.linkVerifiedAt && (!deadline || now.getTime() < deadline.getTime()),
    },
  };
}

/** The staff view of a booking's offers (added to getBookingForStaff for a booking with creator items). */
export async function listOffersForBooking(bookingId: string) {
  const rows = await prisma.creatorOffer.findMany({ where: { bookingId }, orderBy: [{ offeredAt: "asc" }, { id: "asc" }] });
  return rows.map((o) => ({
    id: o.id,
    itemId: o.bookingItemId,
    creatorId: o.creatorId,
    status: o.status,
    closedReason: o.closedReason,
    pageName: o.pageName,
    platform: o.platform,
    format: o.format,
    payoutPaise: o.payoutPaise,
    windowFrom: o.windowFrom,
    windowTo: o.windowTo,
    offeredAt: o.offeredAt,
    expiresAt: o.expiresAt,
    notifiedAt: o.notifiedAt,
    acceptedAt: o.acceptedAt,
    declinedAt: o.declinedAt,
    expiredAt: o.expiredAt,
    withdrawnAt: o.withdrawnAt,
    creatorNote: o.creatorNote,
    linkUrl: o.linkUrl,
    linkSubmittedAt: o.linkSubmittedAt,
    linkPostedAt: o.linkPostedAt,
    ownershipCheck: o.ownershipCheck,
    ownershipDetail: o.ownershipDetail,
    ownershipCheckedAt: o.ownershipCheckedAt,
    ownershipCheckedById: o.ownershipCheckedById,
    linkVerifiedAt: o.linkVerifiedAt,
    linkVerifiedById: o.linkVerifiedById,
    postMissingAt: o.postMissingAt,
  }));
}
