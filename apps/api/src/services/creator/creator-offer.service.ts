import { randomUUID } from "crypto";
import { prisma, Prisma, type CreatorOffer } from "@dashmani/db";
import { CREATOR_TARGET_TYPE, FORMAT_LABELS, isPlatformPostUrl, type CampaignPlatform } from "@dashmani/shared";
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
import { payoutAllowsLink, payoutRefundGuard, withdrawOpenOffers, type PayoutActor, type WithdrawnOffer } from "./payout-ledger";
import { progressCreatorItemRefunds, progressCreatorItemRefundsInBackground, type CreatorRefundOutcome, type RefundActor } from "./creator-refund.service";
import { GRACE_KEEP, GRACE_KEY, LINK_CHECK_MAX_PAGES, alertMarker } from "./creator-offers-config";
import { isIdentityKey, ownershipMatchKey, parseCreatorLink } from "./offer-link";

export { ownershipMatchKey } from "./offer-link";

// Creator OFFERS (payout plan Phase 3): what happens between "staff approved a campaign that books a creator's page"
// and "staff verified the post the creator made".
//
//   approve    createOffersForBooking: one offer per creator item, the creator is emailed the exact ₹ they receive
//   offered →  accepted  (creator, before the offer expires)   the item goes manual_pending: the creator posts by HAND
//           →  declined  (creator)                              item refund_due, payout voided or reversed, client refunded, staff alerted
//           →  expired   (the worker)                           same
//           →  withdrawn (staff, or the missed-window worker)   same
//   accepted   the creator pastes the post's link (submitOfferLink): it is checked against the creator's OWN recent
//              posts through their live connection; staff then verify it (verifyCreatorItem)
//           →  completed (staff verified the link)              the post is live and the offer is over: no longer open work
//   A creator who had seen an offer that is then withdrawn is emailed not to post it (sendOfferWithdrawnEmails).
//
// ⚠️ THE RULES THIS FILE KEEPS
//   • Every transition is ONE set of conditional updateMany calls under the booking's row lock, so two racing actors
//     (an accept and a withdraw, two tabs) cannot both win: the loser gets a 409 and nothing of theirs is written. The
//     writes always go item → payout → offer, the same order refundItem uses, so the two never deadlock.
//   • CLOSING AN OFFER IS TWO STEPS, AND ONLY THE FIRST IS A TRANSACTION. A declined / expired / withdrawn offer is CLAIMED in one
//     short transaction (the item → `refund_due`, the offer closed): that is what stops the creator accepting or posting. Only
//     AFTER it commits is the creator's payout unwound (a planned one voided, a held transfer reversed) and the brand refunded
//     (creator-refund.service, reverse BEFORE refund). That part talks to Razorpay, so it is never inside the transaction; an
//     item that cannot finish it yet stays `refund_due` and the reconciliation worker finishes it.
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
export const fmtDateTimeIST = (d: Date) =>
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

/**
 * A stretch of time (epoch ms) in which the offers worker was not running, so creators could not act (the marketplace was
 * switched off, or the API was down): a link deadline that fell inside [from, until] moves to `until`. The worker records
 * one when it comes back (cron/creator-offers.cron.ts); `offered` offers are extended on their `expires_at` instead.
 */
export interface GraceWindow {
  from: number;
  until: number;
}

/** The recorded grace windows. A DB error throws (a worker that cannot tell must not withdraw anything); corrupt JSON reads as none. */
export async function loadDeadlineGrace(): Promise<GraceWindow[]> {
  const row = await prisma.systemSetting.findUnique({ where: { key: GRACE_KEY } });
  if (!row) return [];
  try {
    const parsed: unknown = JSON.parse(row.value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((g): g is GraceWindow => g && Number.isFinite(g.from) && Number.isFinite(g.until) && g.until >= g.from);
  } catch {
    return [];
  }
}

export async function recordDeadlineGrace(g: GraceWindow, now: Date = new Date()): Promise<void> {
  const kept = (await loadDeadlineGrace()).filter((x) => x.until > now.getTime());
  const value = JSON.stringify([...kept, g].slice(-GRACE_KEEP));
  await prisma.systemSetting.upsert({ where: { key: GRACE_KEY }, create: { key: GRACE_KEY, value }, update: { value } });
}

/**
 * The last instant a creator can hand in their link, with any grace after an outage applied: the plain deadline, or the end
 * of the grace window it fell in. EVERY place that asks "is it too late?" uses this (the creator's submit, the offer view, the
 * missed-window worker), so they can never disagree.
 */
export function effectiveLinkDeadline(o: Pick<CreatorOffer, "windowTo">, grace: GraceWindow[]): Date | null {
  const base = linkDeadline(o);
  if (!base) return null;
  let t = base.getTime();
  for (const g of grace) if (base.getTime() >= g.from && base.getTime() <= g.until) t = Math.max(t, g.until);
  return new Date(t);
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
 *   409 NOT_READY        the booking has no `paid_at`, or a creator item's payout is not `held` yet (the transfer is still being made, or failed)
 *   409 WINDOW_ENDED     the posting window has already closed, so there is nothing left for a creator to do
 * and warns (in `warnings`) when less than 24 hours of the window remain.
 *
 * An item whose page now belongs to someone else, or whose creator is no longer approved / has no active payout account,
 * gets NO offer: it goes refund_due, and staff are alerted (alertOfferProblems, after the
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
    // Claim only. The payout (maybe `held` by now, which takes a Razorpay reversal) is made refundable by the caller
    // AFTER this transaction commits (review.approve), never in here.
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

/** What happened to one mail: it went out, there was nothing (more) to send, or the mailer did not take it. */
export type MailOutcome = "sent" | "skipped" | "failed";

const offerEmailBody = (o: CreatorOffer, creatorName: string) => {
  const w = windowDays(o);
  return (
    `<p>Hi ${esc(creatorName)},</p>` +
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
    `<p style="color:#555">If you don't accept in time the offer simply lapses, and nothing is owed either way.</p>`
  );
};

/**
 * Email ONE offer to its creator, once. `notified_at` is stamped only for a mail the mailer really took, so NULL means "not
 * delivered yet": it is what the worker retries on (cron resendOfferEmails). `skipped` = nothing to send: the offer is no longer
 * `offered`, it was mailed already, or the creator is not an approved account (a suspended or closed creator cannot answer).
 * Never throws.
 */
export async function sendOfferEmail(offerId: string): Promise<MailOutcome> {
  try {
    const o = await prisma.creatorOffer.findFirst({ where: { id: offerId, status: "offered", notifiedAt: null } });
    if (!o) return "skipped";
    const c = await prisma.creator.findUnique({ where: { id: o.creatorId }, select: { name: true, email: true, status: true } });
    if (!c || c.status !== "approved") return "skipped";
    const res = await sendCreatorEmail(c.email, `You have a booking offer: ${inr(o.payoutPaise)} for ${o.pageName}`, "You have a booking offer", offerEmailBody(o, c.name));
    if (res == null) return "failed";
    await prisma.creatorOffer.updateMany({ where: { id: o.id, notifiedAt: null }, data: { notifiedAt: new Date() } });
    return "sent";
  } catch (e) {
    console.warn(`[creator-offers] offer email failed for ${offerId}: ${scrubSecrets(String(e)).slice(0, 200)}`);
    return "failed";
  }
}

/**
 * Email the creators of freshly made offers (right after approve; a failure is retried by the worker). ⚠️ What goes in: the
 * page, the format, the window, the exact ₹ they will receive, when the offer expires, what to do, the disclosure line. What
 * never does: the brand's price, the booking total, the client, other items, other creators. Everything interpolated is
 * escaped. Never throws. Returns how many went out.
 */
export async function sendOfferEmails(offerIds: string[]): Promise<number> {
  let sent = 0;
  for (const id of offerIds) if ((await sendOfferEmail(id)) === "sent") sent++;
  return sent;
}

/** The launch-day reminder: one email to a creator whose accepted offer has no link yet. `skipped`: there is no one to remind (an account that is not approved, or an offer with no window). */
export async function sendLaunchReminder(o: CreatorOffer): Promise<MailOutcome> {
  const c = await prisma.creator.findUnique({ where: { id: o.creatorId }, select: { name: true, email: true, status: true } });
  if (!c || c.status !== "approved" || !o.windowTo) return "skipped";
  const body =
    `<p>Hi ${esc(c.name)},</p>` +
    `<p>Your posting window for <b>${esc(o.pageName)}</b> is open. Post the ${esc(PLATFORM_LABEL[o.platform] ?? o.platform)} ${esc(formatLabel(o.format).toLowerCase())} on your page by <b>${esc(fmtDay(o.windowTo))}</b> (IST), then paste its link into the offer.</p>` +
    `<p>You will receive <b>${esc(inr(o.payoutPaise))}</b> (after any tax deducted at source) once we have checked your post.</p>` +
    `<p><b>Paid partnership.</b> ${esc(CREATOR_DISCLOSURE_INSTRUCTION)}</p>` +
    `<p>${button(offerLink(o.id), "Open the offer")}</p>`;
  try {
    return (await sendCreatorEmail(c.email, `Reminder: post for ${o.pageName}`, "Your posting window is open", body)) != null ? "sent" : "failed";
  } catch (e) {
    console.warn(`[creator-offers] reminder failed for ${o.id}: ${scrubSecrets(String(e)).slice(0, 200)}`);
    return "failed";
  }
}

/**
 * Tell a creator an offer they had seen (accepted, or offered and emailed) has been withdrawn, so they do not make a post for
 * a booking that no longer exists. ⚠️ What goes in: the page and "do not post it" (remove it if already live). What never does: the
 * brand, the client, any price, the reason. Sent AFTER the withdrawing transaction committed; never throws; not retried (the
 * offer page shows the withdrawal too). Returns how many went out.
 */
export async function sendOfferWithdrawnEmails(withdrawn: WithdrawnOffer[]): Promise<number> {
  let sent = 0;
  const seen = withdrawn.filter((w) => w.status === "accepted" || w.notifiedAt != null);
  if (seen.length === 0) return 0;
  try {
    const creators = await prisma.creator.findMany({ where: { id: { in: [...new Set(seen.map((w) => w.creatorId))] } }, select: { id: true, name: true, email: true, status: true } });
    const byId = new Map(creators.map((c) => [c.id, c]));
    for (const w of seen) {
      const c = byId.get(w.creatorId);
      if (!c || c.status === "closed") continue;
      try {
        const body =
          `<p>Hi ${esc(c.name)},</p>` +
          `<p>Our team has withdrawn your booking for <b>${esc(w.pageName)}</b> (${esc(PLATFORM_LABEL[w.platform] ?? w.platform)} ${esc(formatLabel(w.format).toLowerCase())}).</p>` +
          `<p><b>Please don't post it</b> (or take it down if it is already live). Nothing is owed either way.</p>` +
          `<p style="color:#555">Questions? Reply to this email.</p>`;
        const res = await sendCreatorEmail(c.email, `Booking withdrawn: please don't post for ${w.pageName}`, "Booking withdrawn", body);
        if (res != null) sent++;
      } catch (e) {
        console.warn(`[creator-offers] withdrawn email failed for ${w.id}: ${scrubSecrets(String(e)).slice(0, 200)}`);
      }
    }
  } catch (e) {
    console.warn(`[creator-offers] withdrawn emails failed: ${scrubSecrets(String(e)).slice(0, 200)}`);
  }
  return sent;
}

// ── Transitions ─────────────────────────────────────────────────────────────────────────────────

async function ownOffer(creatorId: string, offerId: string): Promise<CreatorOffer> {
  // Another creator's offer is "not found", never "forbidden": its existence is not theirs to learn.
  const o = await prisma.creatorOffer.findFirst({ where: { id: offerId, creatorId } });
  if (!o) throw new AppError(404, "NOT_FOUND", "Offer not found");
  return o;
}

/**
 * What closed an offer, in words for staff (no call to action). An offer that expired without its creator ever being emailed
 * (every send failed, or the account could not be mailed) is NOT "the creator didn't respond": nobody asked them.
 */
export function closedOfferText(reason: string | null, neverEmailed = false): string {
  switch (reason) {
    case "declined":
      return "The creator declined this offer.";
    case "expired":
      return neverEmailed ? "The creator was never emailed this offer, so it expired unseen." : "The creator didn't respond before the offer expired.";
    case "missed_window":
      return "The creator didn't post within the posting window.";
    case "creator_unavailable":
      return "The creator's account is suspended or closed, so they couldn't act on this offer.";
    default:
      return "The offer was withdrawn.";
  }
}
type ClosedReason = "declined" | "expired" | "withdrawn" | "missed_window" | "creator_unavailable";
type CloseKind = "declined" | "expired" | "withdrawn";

/** The line on the item row (staff-only) when a closed offer sends its item to refund_due. The refund follows by itself once the creator's payout is taken back. */
const refundDueText = (reason: ClosedReason, neverEmailed: boolean) => `${closedOfferText(reason, neverEmailed)} The creator's payout is taken back and the client is refunded automatically.`;

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
  /**
   * Tell staff NOW that the item needs a refund (the creator declining does; a member of staff clicking Withdraw is already
   * looking at it). The worker passes false and sends one digest per booking instead (cron alertPending), because a per-offer
   * alert against the shared hourly ceiling drops the 13th of 15 offers that expire together.
   */
  alert: boolean;
  /** Told what became of the creator's payout and the client's refund, when the close itself waited for it (a staff withdraw). */
  onSettled?: (r: CreatorRefundOutcome | null) => void;
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
  // A verified post is live: it can never be withdrawn (checked first: a verified offer is `completed`, and that must not read as merely "closed").
  if (o.linkVerifiedAt) return new AppError(409, "ALREADY_VERIFIED", "This post has already been verified and is live. It can't be withdrawn.");
  if (o.status === "offered") return null;
  if (o.status !== "accepted") return new AppError(409, "OFFER_CLOSED", "This offer is already closed.");
  if (o.linkSubmittedAt && !a.discardSubmittedLink) {
    return new AppError(409, "LINK_SUBMITTED", "The creator has already submitted their link. Check it and verify it, or (if it is not their post) withdraw with “discard the submitted link”.");
  }
  return null;
}

/**
 * Close an open offer, in TWO steps (reverse BEFORE refund, see creator-refund.service):
 *
 *   1. CLAIM, one short transaction under the booking lock: the item → refund_due and the offer → declined | expired |
 *      withdrawn, or none of it. That is what stops the creator accepting or posting. The payout is only READ here:
 *      one that is already released or paid out (or that needs a person) refuses the whole close with a 409 and nothing
 *      changes (payoutRefundGuard: no Razorpay call, so it can sit inside the transaction).
 *   2. UNWIND and REFUND, after the commit and outside any transaction: the payout is voided (planned) or its transfer
 *      reversed (held), and only then is the client refunded for the post. Who waits for it depends on who is asking:
 *        staff    → the withdraw waits, so the person sees what happened (`onSettled`);
 *        creator  → a decline never waits on Razorpay: it runs in the background;
 *        the worker (expiry, missed window) → nothing here: job 10 of the reconciliation worker (bounded, oldest first)
 *                  does it, so a Razorpay outage can never turn a batch of 50 expiries into a 50-minute tick.
 *      An item that cannot finish yet (a transfer still being made, a reversal Razorpay has not confirmed) stays
 *      refund_due and the worker finishes it. Nothing is ever refunded before the payout is out of the way.
 */
async function closeOffer(a: CloseArgs): Promise<CreatorOffer> {
  const found = await prisma.creatorOffer.findUnique({ where: { id: a.offerId } });
  if (!found || (a.creatorId && found.creatorId !== a.creatorId)) throw new AppError(404, "NOT_FOUND", "Offer not found");
  const staffId = a.actor.type === "staff" ? a.actor.id ?? null : null;

  const { closed, before } = await prisma.$transaction(async (tx) => {
    await lockBookingRow(tx, found.bookingId);
    const o = await tx.creatorOffer.findUnique({ where: { id: a.offerId } });
    if (!o) throw new AppError(404, "NOT_FOUND", "Offer not found");
    const bad = whyNotClosable(o, a);
    if (bad) throw bad;
    const neverEmailed = a.kind === "expired" && a.closedReason === "expired" && !o.notifiedAt;

    // Item, then payout (read only), then offer: the same order refundItem takes its rows in.
    const itemFrom = a.kind === "withdrawn" ? ["awaiting_creator", "manual_pending"] : ["awaiting_creator"];
    const item = await tx.campaignBookingItem.updateMany({ where: { id: o.bookingItemId, status: { in: itemFrom } }, data: { status: "refund_due", lastError: refundDueText(a.closedReason, neverEmailed) } });
    if (item.count !== 1) throw new AppError(409, "INVALID_STATE", "This post is no longer waiting on the creator. Refresh and try again.");
    const payout = await tx.creatorPayout.findUnique({ where: { bookingItemId: o.bookingItemId }, select: { status: true, reversedAt: true, razorpayTransferId: true, attempts: true } });
    const refused = payoutRefundGuard(payout);
    // A creator is never shown the reasons of a money state; they only learn that it cannot be done from their side.
    if (refused) throw a.actor.type === "creator" ? new AppError(409, "OFFER_UNAVAILABLE", "This offer can't be changed right now. Contact us if you think that is a mistake.") : refused;

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
          ? { status: "expired", expiredAt: a.now, closedReason: a.closedReason }
          : { status: "withdrawn", withdrawnAt: a.now, withdrawnById: staffId, closedReason: a.closedReason };
    const res = await tx.creatorOffer.updateMany({ where, data });
    if (res.count !== 1) throw new AppError(409, "OFFER_CLOSED", "This offer changed while it was being closed. Refresh and try again.");

    const what = a.kind === "declined" ? "declined the offer" : a.kind === "expired" ? (neverEmailed ? "never got the offer email: the offer expired unseen" : a.closedReason === "creator_unavailable" ? "could not respond (their account is suspended or closed): the offer expired" : "did not respond: the offer expired") : a.closedReason === "missed_window" ? "did not post in the window: the offer was withdrawn" : "offer withdrawn";
    await logBookingEvent(o.bookingId, { type: staffId ? "staff" : "system", id: staffId }, `Creator post on ${o.pageName}: ${what}. The post is refund due: the creator's payout is taken back first, then the client is refunded.`.slice(0, 500), tx);
    return { closed: await tx.creatorOffer.findUniqueOrThrow({ where: { id: o.id } }), before: { status: o.status, notifiedAt: o.notifiedAt, neverEmailed } };
  });

  if (a.alert) {
    alertStaffOncePerHour(
      `creator-offer-closed:${closed.bookingItemId}`,
      "A creator's post needs a refund",
      [
        { label: "Campaign", value: closed.bookingId },
        { label: "Page", value: closed.pageName },
        { label: "What happened", value: closedOfferText(a.closedReason, before.neverEmailed) },
        ...(a.note ? [{ label: "The creator wrote", value: clip(a.note, 300) }] : []),
        { label: "What to do", value: "Nothing, unless this repeats: the creator's payout is taken back first and the client is then refunded automatically. If the post still shows “refund due” after an hour, open the campaign and press Refund on it." },
      ],
      `/campaigns/${closed.bookingId}`,
      // The marker proves the email WENT OUT; without it the worker's digest (cron alertPending) sends it again.
      { onSent: () => logBookingEvent(closed.bookingId, { type: "system" }, alertMarker("refund", closed.id)) },
    );
  }
  // The creator is told only when a person decided: the offer is withdrawn (staff, a refund, a rejected campaign), not when it lapsed, ran out of window or their own account is the reason.
  if (a.kind === "withdrawn" && a.closedReason === "withdrawn" && (before.status === "accepted" || before.notifiedAt)) {
    void sendOfferWithdrawnEmails([{ id: closed.id, creatorId: closed.creatorId, pageName: closed.pageName, platform: closed.platform, format: closed.format, status: before.status, notifiedAt: before.notifiedAt }]).catch(() => undefined);
  }

  // 2. UNWIND the payout and REFUND, outside the transaction (see above for who waits).
  const settle = { actor: { type: a.actor.type === "staff" ? "staff" : a.actor.type === "creator" ? "creator" : "system", id: a.actor.id ?? null } satisfies RefundActor, reason: a.closedReason };
  if (a.actor.type === "staff") {
    const r = await progressCreatorItemRefunds([closed.bookingItemId], settle);
    a.onSettled?.(r.get(closed.bookingItemId) ?? null);
  } else if (a.actor.type === "creator") {
    progressCreatorItemRefundsInBackground([closed.bookingItemId], settle);
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

/** The creator declines (an offer that is still `offered`). The item goes refund_due; the payout is taken back and the client refunded (in the background); staff are told. */
export async function declineOffer(creatorId: string, offerId: string, reason?: string | null, now: Date = new Date()): Promise<CreatorOffer> {
  await ownOffer(creatorId, offerId);
  return closeOffer({ offerId, kind: "declined", closedReason: "declined", actor: { type: "creator", id: creatorId }, creatorId, note: reason?.trim() || null, now, alert: true });
}

/**
 * The worker: an offer past its expiry that nobody answered. Throws 409 NOT_EXPIRED when it is not yet due. `closedReason`
 * says why nobody answered when it is not the creator's doing (their account is suspended or closed); `alert: false` leaves
 * the staff email to the worker's per-booking digest.
 */
export async function expireOffer(offerId: string, now: Date = new Date(), opts: { alert?: boolean; closedReason?: "expired" | "creator_unavailable" } = {}): Promise<CreatorOffer> {
  return closeOffer({ offerId, kind: "expired", closedReason: opts.closedReason ?? "expired", actor: { type: "system" }, now, alert: opts.alert ?? true });
}

/**
 * Staff (or the missed-window worker) withdraw an offer: `offered`, or `accepted` with NO link submitted yet.
 * `discardSubmittedLink` (staff only, explicit) also closes an accepted offer whose link was submitted but NOT verified:
 * the way out when staff have looked at the link and it is not the creator's post. A verified post can never be withdrawn.
 * A creator who had seen the offer (accepted it, or was emailed it) is emailed that it is withdrawn, unless the worker did it.
 */
export async function withdrawOffer(
  offerId: string,
  o: { staffId?: string | null; closedReason?: "withdrawn" | "missed_window" | "creator_unavailable"; discardSubmittedLink?: boolean; alert?: boolean; now?: Date; onSettled?: (r: CreatorRefundOutcome | null) => void } = {},
): Promise<CreatorOffer> {
  return closeOffer({
    offerId,
    kind: "withdrawn",
    closedReason: o.closedReason ?? "withdrawn",
    actor: o.staffId ? { type: "staff", id: o.staffId } : { type: "system" },
    now: o.now ?? new Date(),
    discardSubmittedLink: o.discardSubmittedLink === true,
    alert: o.alert ?? !o.staffId,
    onSettled: o.onSettled,
  });
}

// ── The creator's link ──────────────────────────────────────────────────────────────────────────

export interface LinkOwnership {
  check: Exclude<OwnershipCheck, "manual_ok">;
  /**
   * A short reason CODE (never a Graph body, never a token): matched | not_found | outside_window | token_lapsed | permission |
   * rate_limited | unreachable | graph_error | no_page | connection_lapsed | no_token | token_unreadable | no_timestamp |
   * share_link (an opaque share link: send the post's own link) | link_shape (a link form we cannot read) |
   * feed_shape (their page lists posts in a form we cannot compare) | page_too_busy (their page posts too often for us to
   * reach the posting window in the pages we read).
   */
  detail: string;
  /** When the matched post went live. */
  postedAt: Date | null;
  /**
   * The post's identity (ownershipMatchKey): what is stored as link_canonical_key and what "one post, one booking" compares.
   * For a Facebook /share/ link that could be followed it is the key of the post it led to, not of the share code.
   */
  key: string;
  /** Meta's own URL for the matched post (null when nothing matched): what is stored and later shown instead of the creator's string. */
  permalink: string | null;
}

interface FeedPage {
  data?: Array<{ permalink?: string; timestamp?: string; permalink_url?: string; created_time?: string }>;
  paging?: { next?: string };
}

/** A paging.next URL Meta returned, only when it really is one of Meta's (the token travels with it). */
function metaPagingUrl(next: unknown): string | null {
  if (typeof next !== "string") return null;
  try {
    const u = new URL(next);
    return u.protocol === "https:" && /(^|\.)(facebook|instagram)\.com$/i.test(u.hostname) ? next : null;
  } catch {
    return null;
  }
}

/**
 * Is this link one of the creator's OWN recent posts inside the posting window? Read through the creator's own live
 * connection: Instagram `/{ig-id}/media` with the user token, Facebook `/{page-id}/published_posts` with the Page
 * token, newest first, a few pages at most (LINK_CHECK_MAX_PAGES), never stored (the list is read and dropped).
 *
 *   found, inside the window        → auto_ok
 *   read to the window's start (or the whole feed), not there → auto_failed   (the creator is told and can send another link)
 *   could not read their page, could not reach the window's start in the pages we read, a link we cannot compare →
 *                                     unverifiable (a person decides)
 *
 * ⚠️ "Not found" is only ever claimed when the feed was read far enough to know: the booked post is older than the newest
 * page on a busy page, and that is NOT a failure of the creator's. Never throws; never logs a token or a Graph body.
 */
export async function checkLinkOwnership(offer: CreatorOffer, url: string): Promise<LinkOwnership> {
  const parsed = parseCreatorLink(offer.platform, url);
  let key = parsed.ok ? parsed.link.key : ownershipMatchKey(url);
  const unverifiable = (detail: string, permalink: string | null = null): LinkOwnership => ({ check: "unverifiable", detail, postedAt: null, key, permalink });
  if (!parsed.ok) return unverifiable("link_shape");
  const shape = parsed.link.shape;
  // These name no post we can compare, so there is nothing to look for in their page (and no call to spend).
  if (shape === "opaque") return unverifiable("link_shape");
  if (shape === "share" && offer.platform === "instagram") return unverifiable("share_link");

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
  if (shape === "share") {
    const resolved = await resolveFacebookShareUrl(url);
    const r = resolved ? parseCreatorLink("facebook", resolved) : null;
    if (!r || !r.ok || r.link.shape !== "identity") return unverifiable("share_link");
    key = r.link.key;
  }

  const want = key;
  const limit = isIg ? 50 : 25;
  const winFrom = offerWindow(offer).from?.getTime() ?? null;
  const budget = makeBudget(LINK_CHECK_MAX_PAGES);
  let cursor: string | null = null;
  let match: { link: string; stamp: string | undefined } | null = null;
  let exhausted = false;
  let reachedWindowStart = false;
  let oddRows = false;
  for (let page = 0; page < LINK_CHECK_MAX_PAGES && !match; page++) {
    const res: Awaited<ReturnType<typeof oauthGraphFetch<FeedPage>>> = await oauthGraphFetch<FeedPage>(
      cursor ?? (isIg ? `${asset.metaId}/media` : `${asset.metaId}/published_posts`),
      cursor ? {} : isIg ? { fields: "permalink,timestamp", limit } : { fields: "permalink_url,created_time", limit },
      token,
      { label: "creator-offer-link-check", budget, appSecret: creatorMetaAppSecret() },
    );
    if (!res.ok) {
      if (res.authInvalid) return unverifiable("token_lapsed");
      if (res.rateLimited) return unverifiable("rate_limited");
      if (res.status === 0) return unverifiable("unreachable");
      if (res.errorCode === 10 || (res.errorCode != null && res.errorCode >= 200 && res.errorCode < 300)) return unverifiable("permission");
      return unverifiable("graph_error");
    }
    const rows = res.data?.data ?? [];
    let oldest = Infinity;
    for (const m of rows) {
      const link = isIg ? m.permalink : m.permalink_url;
      const stamp = isIg ? m.timestamp : m.created_time;
      const ts = Date.parse(stamp ?? "");
      if (Number.isFinite(ts)) oldest = Math.min(oldest, ts);
      if (typeof link !== "string" || link === "") {
        oddRows = true;
        continue;
      }
      const k = ownershipMatchKey(link);
      if (k === want) {
        match = { link, stamp };
        break;
      }
      if (!isIdentityKey(k)) oddRows = true;
    }
    if (match) break;
    const next = metaPagingUrl(res.data?.paging?.next);
    if (rows.length === 0 || !res.data?.paging?.next) {
      exhausted = true; // Meta has no more: the whole feed was read
      break;
    }
    // Newest first: once a page reaches back before the window opened, a post made inside the window would already have shown.
    if (winFrom !== null && oldest < winFrom) {
      reachedWindowStart = true;
      break;
    }
    cursor = next;
    if (!cursor) break; // a next link that is not Meta's: do not follow it, and do not claim to have read everything
  }

  if (!match) {
    if (!exhausted && !reachedWindowStart) return unverifiable("page_too_busy");
    // Posts in a form we cannot compare may be the one we are looking for: say so, rather than "not found".
    if (oddRows) return unverifiable("feed_shape");
    return { check: "auto_failed", detail: "not_found", postedAt: null, key, permalink: null };
  }
  const ts = Date.parse(match.stamp ?? "");
  if (!Number.isFinite(ts)) return unverifiable("no_timestamp", match.link);
  const postedAt = new Date(ts);
  const win = offerWindow(offer);
  const inside = (!win.from || postedAt.getTime() >= win.from.getTime()) && (!win.to || postedAt.getTime() < win.to.getTime());
  return { check: inside ? "auto_ok" : "auto_failed", detail: inside ? "matched" : "outside_window", postedAt, key, permalink: match.link };
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
      // share_link / link_shape: a link that names no post can never be verified (verifyCreatorItem refuses it, hand tick or not), and a new
      // one is refused when it is sent (NEEDS_POST_LINK). Only a link stored before that rule can still read this way, and what helps is a new link.
      if (detail === "share_link" || detail === "link_shape") {
        return "That link doesn't tell us which post it is. Open your post and paste the post's own link (Instagram: instagram.com/reel/… or instagram.com/p/…; Facebook: facebook.com/reel/… or the post's address-bar link) so our team can verify it.";
      }
      if (detail === "page_too_busy") return "Your page posts so often that we couldn't reach this post to check it automatically, so our team will check this link by hand.";
      if (detail === "feed_shape") return "We can't compare some of the posts on your page automatically, so our team will check this link by hand. If you can, paste the post's own link.";
      return "We couldn't check your page automatically right now, so our team will check this link by hand.";
    default:
      return "";
  }
}

/** Whether the creator may still hand in (or replace) a link. `grace` is the recorded outage grace (loadDeadlineGrace). */
function assertLinkable(o: CreatorOffer, now: Date, grace: GraceWindow[]): void {
  // Verified first: a verified offer is `completed`, and that must read "already verified", not "closed".
  if (o.linkVerifiedAt) throw new AppError(409, "ALREADY_VERIFIED", "Your post has already been verified.");
  if (o.status !== "accepted") throw new AppError(409, "OFFER_NOT_ACCEPTED", o.status === "offered" ? "Accept the offer before you send the link." : "This offer is closed.");
  // Once our team has vouched for the link (checked it by hand) it is the link: it cannot be swapped for another.
  if (o.ownershipCheck === "manual_ok") throw new AppError(409, "LINK_FROZEN", "Our team has already checked your link, so it can't be changed. Contact us if it is the wrong one.");
  const deadline = effectiveLinkDeadline(o, grace);
  if (deadline && now.getTime() >= deadline.getTime()) throw new AppError(409, "POSTING_CLOSED", "The posting window for this booking has closed.");
}

/** The sentence for a link that names no post (a share or shortened link). Shown to the creator as it is. */
const NEEDS_POST_LINK_MESSAGE =
  "That link doesn't name a post (it is a share or shortened link). Open your post and paste the post's own link (Instagram: instagram.com/reel/… or instagram.com/p/…; Facebook: facebook.com/reel/… or the post's address-bar link).";

/**
 * The creator sends the link of the post they made BY HAND. It must be a post link on the item's platform, in its own form
 * (no redirect or shortened wrapper, and one that names a post: 400 NEEDS_POST_LINK for a share link), the offer must be accepted and not past the window + 24 h grace, the item must still wait
 * for the post and its payout must not be void or failed. The link is then checked against the creator's own recent posts
 * (outside any transaction: it is a network call) and stored with the verdict. The item stays `manual_pending`: only staff make
 * a post live (verifyCreatorItem).
 *
 * ⚠️ WHAT IS STORED is never the pasted string: it is Meta's own URL for the post when the check found it, else the link in its
 * clean form (https, www., no tracking query), because that is what staff verify and the client is shown.
 *
 * Re-sending replaces the link and the verdict until staff verify it (or vouch for it by hand). A post that PASSED its check on
 * another booking blocks this one (409 LINK_ALREADY_USED); a link that did not pass never blocks anyone: one creator pasting
 * another creator's post cannot lock the real owner out. The strict "one post, one booking" check is staff's verify.
 */
export async function submitOfferLink(creatorId: string, offerId: string, rawUrl: string, now: Date = new Date()) {
  const offer = await ownOffer(creatorId, offerId);
  const grace = await loadDeadlineGrace();
  assertLinkable(offer, now, grace);
  const url = rawUrl.trim();
  // creator_offers.link_url is VARCHAR(500): refuse a longer one here, cleanly, before it can become a database error.
  if (url.length > 500) throw new AppError(400, "VALIDATION_ERROR", "That link is too long.");
  const platformName = PLATFORM_LABEL[offer.platform] ?? offer.platform;
  if (!isPlatformPostUrl(offer.platform as CampaignPlatform, url)) {
    throw new AppError(400, "WRONG_PLATFORM", `That isn't a ${platformName} link.`);
  }
  const parsed = parseCreatorLink(offer.platform, url);
  if (!parsed.ok) {
    if (parsed.reason === "host") throw new AppError(400, "WRONG_PLATFORM", `That isn't a ${platformName} post link. Paste the post's own link, not a redirect or shortened one.`);
    if (parsed.reason === "redirect") throw new AppError(400, "INVALID_LINK", "That link redirects somewhere else. Paste the post's own link.");
    throw new AppError(400, "NOT_A_POST", `That isn't the link of a ${platformName} post. Open the post and paste its own link.`);
  }

  // ⚠️ A LINK THAT NAMES NO POST IS NEVER STORED. An Instagram /share/ link, an fb.watch short link and a Facebook /share/ link that
  // does not lead to a post get a `share:` / `raw:` key, which names the LINK and can never equal the `ig:` / `fb:` key of the same
  // post sent for another booking: stored, one reel could be hand-verified for two clients. So ask for the post's own link now. The
  // first two come back from checkLinkOwnership without a call to Meta; a Facebook share link is followed through its one redirect
  // there (fail-open) and is decided on the key it came back with. verifyCreatorItem refuses a non-identity key as well and does not
  // depend on this probe succeeding.
  const check = await checkLinkOwnership(offer, url);
  if (!isIdentityKey(check.key)) throw new AppError(400, "NEEDS_POST_LINK", NEEDS_POST_LINK_MESSAGE);
  const key = check.key;
  const stored = check.permalink && check.permalink.length <= 500 ? check.permalink : parsed.link.url;

  await prisma.$transaction(async (tx) => {
    await lockBookingRow(tx, offer.bookingId);
    const cur = await tx.creatorOffer.findUnique({ where: { id: offer.id } });
    if (!cur || cur.creatorId !== creatorId) throw new AppError(404, "NOT_FOUND", "Offer not found");
    assertLinkable(cur, now, grace);
    const item = await tx.campaignBookingItem.findUnique({ where: { id: cur.bookingItemId }, select: { status: true } });
    if (item?.status !== "manual_pending") throw new AppError(409, "OFFER_CLOSED", "This booking can no longer take a post.");
    const payout = await tx.creatorPayout.findUnique({ where: { bookingItemId: cur.bookingItemId }, select: { status: true } });
    if (!payout || !payoutAllowsLink(payout.status)) throw new AppError(409, "OFFER_UNAVAILABLE", "This booking can't go ahead any more. Contact us if you think that is a mistake.");
    // Only a claim that HELD UP reserves the post, and only for a link that held up itself: a link that failed its check is not
    // anyone's claim (and a 409 to it would tell a stranger that somebody else sent this post in).
    if (check.check !== "auto_failed") {
      const used = await tx.creatorOffer.count({
        where: { linkCanonicalKey: key, id: { not: cur.id }, status: { in: ["accepted", "completed"] }, linkSubmittedAt: { not: null }, ownershipCheck: { in: ["auto_ok", "manual_ok"] } },
      });
      if (used > 0) throw new AppError(409, "LINK_ALREADY_USED", "That post has already been sent in for another booking. Send the link of the post you made for this one.");
    }
    const res = await tx.creatorOffer.updateMany({
      where: { id: cur.id, creatorId, status: "accepted", linkVerifiedAt: null, OR: [{ ownershipCheck: null }, { ownershipCheck: { not: "manual_ok" } }] },
      data: {
        linkUrl: stored,
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
 * link). Refused, with nothing changed, unless ALL of these hold: an accepted offer, a link the creator submitted, the item
 * waiting in manual_pending, a payout that is not void or failed, an ownership check that PASSED (auto_ok / manual_ok), or one
 * that did not (auto_failed / unverifiable) with the staff member saying they checked by hand (`ownershipCheckedByHand`, which
 * records manual_ok and who). One post can be verified for one booking only, and only a link that NAMES a post can be verified at
 * all (409 LINK_NOT_COMPARABLE for a share or short link, hand tick or not). Stamps link_verified_at / link_verified_by_id and
 * moves the offer to `completed`: it is finished, so it no longer counts as open work. Nothing is paid here: see
 * onCreatorLinkVerified (Phase 4).
 *
 * ⚠️ BOUND TO THE LINK STAFF LOOKED AT. `expectedLinkKey` is the offer's `linkCanonicalKey` as the staff member saw it; when the
 * creator has since sent a different link it is 409 LINK_CHANGED and nothing is verified (a hand tick vouches for ONE link: the
 * creator may re-send until verification, so without this the tick could end up on a link nobody looked at). `url`, when given
 * (the generic "mark posted" route), must be that very post (400 LINK_MISMATCH).
 */
export async function verifyCreatorItem(
  bookingId: string,
  itemId: string,
  o: { staffId: string; url?: string | null; expectedLinkKey?: string | null; ownershipCheckedByHand?: boolean; now?: Date },
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
    const haveKey = offer.linkCanonicalKey ?? ownershipMatchKey(offer.linkUrl);
    if (o.expectedLinkKey != null && o.expectedLinkKey !== haveKey) {
      throw new AppError(409, "LINK_CHANGED", "The creator sent a different link since you opened this. Reload, look at the new link, and verify again.");
    }
    if (o.url) {
      const typed = ownershipMatchKey(o.url);
      if (typed !== haveKey && typed !== ownershipMatchKey(offer.linkUrl)) {
        throw new AppError(400, "LINK_MISMATCH", "A creator's post is recorded from the link the creator sent. That isn't their link.");
      }
    }
    if (!isPlatformPostUrl(item.platform as CampaignPlatform, offer.linkUrl)) throw new AppError(400, "WRONG_PLATFORM", `The creator's link isn't a ${item.platform} link.`);
    // ⚠️ THE ARBITER OF "ONE POST, ONE BOOKING" CAN ONLY COMPARE A LINK THAT NAMES A POST. A share:/raw: key (an Instagram /share/
    // link, fb.watch, a Facebook share link that never resolved) names the link, so the duplicate check below would find nothing
    // even when another booking already holds the same post under its ig:/fb: key. Refused before the hand tick is even asked
    // about: no tick can make such a link verifiable. This does not lean on the submit-time refusal, whose redirect probe is
    // fail-open and which cannot reach an offer stored before it existed.
    if (!isIdentityKey(haveKey)) {
      throw new AppError(409, "LINK_NOT_COMPARABLE", "This link doesn't name a post, so we can't tell whether it was already used for another booking. Ask the creator to send the post's own link.");
    }

    const passed = offer.ownershipCheck === "auto_ok" || offer.ownershipCheck === "manual_ok";
    if (!passed && o.ownershipCheckedByHand !== true) {
      throw new AppError(
        409,
        "OWNERSHIP_NOT_CHECKED",
        `We couldn't confirm automatically that this post is on the creator's page${offer.ownershipCheck ? ` (${offer.ownershipCheck.replace("_", " ")}${offer.ownershipDetail ? `: ${offer.ownershipDetail.replace(/_/g, " ")}` : ""})` : ""}. Open the link, check it is on their page and inside the window, then verify again with “ownership checked by hand” ticked.`,
      );
    }
    const payout = await tx.creatorPayout.findUnique({ where: { bookingItemId: itemId }, select: { status: true } });
    if (!payout || !payoutAllowsLink(payout.status)) throw new AppError(409, "OFFER_UNAVAILABLE", "This creator's payout is not set aside (held) any more, so the post can't be verified. Check the payout queue, or refund the post instead.");
    // ⚠️ SERIALISE EVERY VERIFY OF ONE POST. The booking lock above is per booking, and under READ COMMITTED a verify of ANOTHER
    // booking that has not committed yet is invisible to the count below: two staff members (or two tabs) verifying the same
    // post for two bookings at the same moment would both see 0 and both succeed. A transaction-scoped advisory lock on the
    // post's key makes the second wait for the first's commit, take a fresh snapshot, and be refused. Lock order is always the
    // booking row, then the key (nothing takes them the other way round, so no cycle). The wrapper form is needed because
    // Prisma cannot deserialize the bare `void` that pg_advisory_xact_lock returns. creator_offers_verified_link_key_idx (the
    // payouts DDL) is the database's own backstop behind this.
    await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${haveKey}, 0))) AS l`;
    const dup = await tx.creatorOffer.count({ where: { linkCanonicalKey: haveKey, id: { not: offer.id }, linkVerifiedAt: { not: null } } });
    if (dup > 0) throw new AppError(409, "LINK_ALREADY_USED", "This post has already been verified for another booking.");

    const claimed = await tx.campaignBookingItem.updateMany({
      where: { id: itemId, status: "manual_pending" },
      data: { status: "posted_manual", permalink: offer.linkUrl, postedAt: offer.linkPostedAt ?? now, postedById: o.staffId, lastError: null },
    });
    if (claimed.count !== 1) throw new AppError(409, "INVALID_STATE", "This post changed. Refresh and try again.");
    const manual = !passed;
    let stamped: { count: number };
    try {
      stamped = await tx.creatorOffer.updateMany({
        // Bound to the link just read, too: the booking lock already stops a re-send in between, and this keeps it true if that ever changes.
        where: { id: offer.id, status: "accepted", linkVerifiedAt: null, linkSubmittedAt: { not: null }, linkUrl: offer.linkUrl },
        data: {
          // The post is delivered and the offer is over: `completed` (not `accepted` forever, which would count as open work).
          status: "completed",
          linkVerifiedAt: now,
          linkVerifiedById: o.staffId,
          // Always carried on a verified row, so the partial unique index below covers it even if the key was only derived above.
          linkCanonicalKey: haveKey,
          ...(manual ? { ownershipCheck: "manual_ok", ownershipCheckedAt: now, ownershipCheckedById: o.staffId } : {}),
        },
      });
    } catch (e) {
      // The database's own backstop (a partial unique index on a verified link's key) refused a second verified row for this post:
      // the same answer as the check above, never a 500. (This statement is the only unique write in the transaction.)
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw new AppError(409, "LINK_ALREADY_USED", "This post has already been verified for another booking.");
      throw e;
    }
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

  const deadline = effectiveLinkDeadline(o, await loadDeadlineGrace());
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
      submitLink: o.status === "accepted" && !o.linkVerifiedAt && o.ownershipCheck !== "manual_ok" && (!deadline || now.getTime() < deadline.getTime()),
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
    // What a verify request must quote back (verify-creator-link's `linkCanonicalKey`): the link the staff member is looking at.
    linkCanonicalKey: o.linkCanonicalKey,
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
