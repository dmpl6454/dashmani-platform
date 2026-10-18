import { prisma } from "@dashmani/db";
import { CREATOR_TARGET_TYPE, isPlatformPostUrl, LIVE_ITEM_STATUSES, type CampaignPlatform } from "@dashmani/shared";
import { AppError } from "../../middleware/error-handler";
import { transitionBooking, settleBooking, logBookingEvent } from "./booking.service";
import { refundBookingInFull, refundPaymentRow, capturedPaymentFor, maybeMarkRefunded, refundSweepEnabled } from "./payment.service";
import { sendDeliveryEmail, sendItemLiveEmail, sendStatusEmail } from "./delivery.service";
import { campaignConfig } from "./config";
import { checkEligibility, launchAt, planPublishing } from "./publish.service";
import { onCreatorLinkVerified, payoutRefundGuard, prepareCreatorItemRefund, reconcileCreatorOwnership, withdrawOpenOffers, type WithdrawnOffer } from "../creator/payout-ledger";
import { alertOfferProblems, createOffersForBooking, listOffersForBooking, sendOfferEmails, sendOfferWithdrawnEmails, verifyCreatorItem, withdrawOffer as withdrawCreatorOffer, type CreatedOffers } from "../creator/creator-offer.service";
import { progressCreatorItemRefund, type CreatorRefundOutcome } from "../creator/creator-refund.service";
import { reverseForRefund, type RefundReadiness } from "../creator/payout.service";

// Staff side: the review queue, booking detail, approve / reject / request changes, and the
// per-item actions (mark posted with its link, mark failed, refund one item).

const staff = (id: string) => ({ type: "staff" as const, id });
const ymd = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

const QUEUE_ORDER = ["paid_pending_review", "approved", "publishing", "changes_requested", "partially_published", "awaiting_payment", "completed", "rejected", "refunded"];

export async function listQueue(filter: { status?: string } = {}) {
  const where = filter.status ? { status: filter.status } : { status: { notIn: ["draft", "cancelled", "expired"] } };
  const rows = await prisma.campaignBooking.findMany({
    where,
    orderBy: { updatedAt: "desc" },
    take: 300,
    select: {
      id: true,
      name: true,
      brand: true,
      status: true,
      format: true,
      campaignType: true,
      audioIntegration: true,
      totalPaise: true,
      launchFrom: true,
      launchTo: true,
      paidAt: true,
      updatedAt: true,
      client: { select: { companyName: true } },
      items: { select: { status: true } },
    },
  });
  return rows
    .map((r) => ({
      id: r.id,
      name: r.name,
      brand: r.brand,
      client: r.client.companyName,
      status: r.status,
      format: r.format,
      campaignType: r.campaignType,
      audioIntegration: r.audioIntegration,
      totalPaise: r.totalPaise,
      launchFrom: ymd(r.launchFrom),
      launchTo: ymd(r.launchTo),
      paidAt: r.paidAt,
      updatedAt: r.updatedAt,
      itemCount: r.items.length,
      liveCount: r.items.filter((i) => i.status === "posted_manual" || i.status === "published").length,
    }))
    .sort((a, b) => {
      const d = QUEUE_ORDER.indexOf(a.status) - QUEUE_ORDER.indexOf(b.status);
      return d !== 0 ? d : +b.updatedAt - +a.updatedAt;
    });
}

export async function getBookingForStaff(id: string) {
  const b = await prisma.campaignBooking.findUnique({
    where: { id },
    include: {
      client: { select: { id: true, companyName: true, contactName: true, email: true, phone: true } },
      media: { where: { purgedAt: null }, orderBy: { position: "asc" } },
      items: { orderBy: [{ createdAt: "asc" }, { accountName: "asc" }, { id: "asc" }] },
      payments: { orderBy: { createdAt: "asc" } },
      events: { orderBy: { createdAt: "desc" }, take: 100 },
    },
  });
  if (!b) throw new AppError(404, "NOT_FOUND", "Campaign not found");
  // A booking with a creator's post carries its offers (status, link, what the ownership check said) so staff can act on
  // them. Only then: a network-only booking costs no extra query and its response has no extra key.
  const creatorOffers = b.items.some((i) => i.targetType === CREATOR_TARGET_TYPE) ? await listOffersForBooking(id) : null;
  return {
    ...b,
    ...(creatorOffers ? { creatorOffers } : {}),
    autoPublish: { enabled: campaignConfig.publishEnabled(), dueAt: launchAt(b.launchFrom) },
    launchFrom: ymd(b.launchFrom),
    launchTo: ymd(b.launchTo),
    media: b.media.map((m) => ({
      id: m.id,
      position: m.position,
      kind: m.kind,
      role: m.role,
      originalName: m.originalName,
      mime: m.mime,
      bytes: Number(m.bytes),
      durationMs: m.durationMs,
      width: m.width,
      height: m.height,
      uploadStatus: m.uploadStatus,
      renderStatus: m.renderStatus,
      renderError: m.renderError,
    })),
    payments: b.payments.map((p) => ({
      id: p.id,
      razorpayOrderId: p.razorpayOrderId,
      razorpayPaymentId: p.razorpayPaymentId,
      amountPaise: p.amountPaise,
      refundedPaise: p.refundedPaise,
      status: p.status,
      createdAt: p.createdAt,
    })),
  };
}

export async function approve(id: string, staffId: string) {
  // A creator's page that changed hands since the capture can't be posted: its payout is voided and the item goes
  // refund_due BEFORE the plan below is made, so it is never planned. (Only for a booking awaiting approval.)
  // ⚠️ The items it moves to refund_due are NOT refunded here. Their payouts are unwound and the client refunded by the payout worker
  // (reverse BEFORE refund, job 10 of cron/creator-payouts.cron.ts), a few minutes later: the "approved" email below is built from the
  // items' statuses and must still find them refund_due ("won't go ahead … being returned"), which a refund finished inline would turn
  // into "refunded" items it describes as waiting for their creator.
  await reconcileCreatorOwnership(id);
  // Phase 2: items the API can publish are queued for the launch day; everything else (and
  // everything while CAMPAIGN_PUBLISH_ENABLED is off) is posted by our team, as in Phase 1.
  // ⚠️ A creator's page is neither: it is OFFERED to the creator (createOffersForBooking below), who posts it by hand
  // only if they accept. The plan never touches those items, and nothing below may turn one into manual_pending.
  const creatorItemIds = new Set(
    (await prisma.campaignBookingItem.findMany({ where: { bookingId: id, targetType: CREATOR_TARGET_TYPE }, select: { id: true } })).map((i) => i.id),
  );
  const plan = (await planPublishing(id)).filter((p) => !creatorItemIds.has(p.itemId));
  const offered: { value: CreatedOffers | null } = { value: null };
  await prisma.$transaction(async (tx) => {
    await transitionBooking(id, ["paid_pending_review"], "approved", staff(staffId), {
      tx,
      data: { approvedAt: new Date(), reviewedById: staffId, reviewNote: null },
    });
    // One offer per creator item, or a 409 that rolls the approval back (not paid, window over, switch off, payout not ready).
    offered.value = await createOffersForBooking(tx, id, staff(staffId));
    for (const p of plan) {
      await tx.campaignBookingItem.updateMany({
        where: { id: p.itemId, status: "pending" },
        // A hand-posted item carries its reason on the row itself ("Auto-publishing is switched
        // off", "the API cannot attach a song", …), so staff never have to dig through History.
        data: p.auto
          ? { status: "queued", nextAttemptAt: p.at, attempts: 0, containerId: null, lastError: null }
          : { status: "manual_pending", lastError: p.reason ? p.reason.slice(0, 500) : null },
      });
    }
    // Anything the plan didn't see (it can't miss any, but never leave an item pending). Never a creator's page.
    await tx.campaignBookingItem.updateMany({ where: { bookingId: id, status: "pending", targetType: { not: CREATOR_TARGET_TYPE } }, data: { status: "manual_pending" } });
  });
  for (const p of plan.filter((x) => !x.auto)) {
    await logBookingEvent(id, staff(staffId), `Post by hand on ${p.accountName}: ${p.reason}`);
  }
  void sendStatusEmail(id, "approved").catch((e) => console.error("[campaign] approved email failed", e));
  const made = offered.value;
  if (made) {
    alertOfferProblems(id, made.problems);
    void sendOfferEmails(made.offers.map((o) => o.id)).catch((e) => console.error("[campaign] creator offer emails failed", e));
  }
  const detail = await getBookingForStaff(id);
  // Only a booking that had creator posts gains the extra key: the response for a network-only one is exactly what it was.
  return made && made.creatorItems > 0 ? { ...detail, offerSummary: { offered: made.offers.length, refundDue: made.problems.length, warnings: made.warnings } } : detail;
}

export async function requestChanges(id: string, staffId: string, note: string) {
  await transitionBooking(id, ["paid_pending_review"], "changes_requested", staff(staffId), {
    note,
    data: { reviewNote: note, reviewedById: staffId },
  });
  void sendStatusEmail(id, "changes_requested").catch((e) => console.error("[campaign] changes email failed", e));
  return getBookingForStaff(id);
}

/**
 * What staff are told when a refund was requested and Razorpay has not answered yet.
 *
 * ⚠️ "We're checking automatically" is true only while the refund sweep runs. With
 * CAMPAIGN_REFUND_SWEEP_ENABLED=0 (the Razorpay-incident kill switch) nothing re-sends, reconciles
 * or alerts, and a refund that never reached Razorpay just sits there; the staff member who clicked
 * may not be the person who switched it off. So the text follows the switch and says what to do.
 */
function refundConfirmingNotice(): string {
  return refundSweepEnabled()
    ? "The refund was requested and Razorpay hasn't confirmed it yet. We're checking automatically: nothing needs doing, and it can't be refunded twice."
    : "The refund was requested and Razorpay hasn't confirmed it yet. The automatic refund check is switched off, so nothing will retry or settle it: look at this payment in Razorpay, and ask whoever runs the server to switch the refund check back on. It can't be refunded twice.";
}

/** The end of the message when a rejection's refund was refused: whether it is retried depends on the same switch. */
function refundRetryClause(): string {
  return refundSweepEnabled()
    ? "we retry automatically every few minutes."
    : "the automatic refund check is switched off, so it will not be retried: refund it from the Razorpay dashboard, or ask whoever runs the server to switch the refund check back on.";
}

/** Item statuses a rejection refunds: everything that was not, and now won't be, posted (a creator's open offer and an already-owed refund included). */
const NOT_POSTED_ITEM_STATUSES = ["pending", "manual_pending", "queued", "failed", "awaiting_creator", "refund_due"];

const REJECTABLE = ["paid_pending_review", "changes_requested", "approved"] as const;

/**
 * Reject. The booking moves to `refunded` once Razorpay has confirmed every refund.
 *
 * A booking with NO online payment (offline mode) keeps the old behaviour exactly: nothing is
 * refunded, it stays `rejected`.
 *
 * A booking WITH an online payment is refused (409) if any post is already live, and otherwise
 * refunds PER ITEM, each item's own price under its own idempotency key. It never refunds
 * "everything that is left": once creator pages exist, part of the payment is a creator's share.
 * ONE transaction makes the booking rejected, claims every not-posted item and marks the payment
 * `refund_due`, so a crash or a refusal from Razorpay leaves the money recorded as owed and the
 * refund sweep finishes it. If any item can't be claimed (it is being published right now) nothing
 * changes and staff are asked to try again in a minute.
 *
 * ⚠️ A booking with a CREATOR's page rejects in a RE-RUNNABLE SEQUENCE (reverse BEFORE refund), because the creator's
 * share may already sit in their linked account and taking it back is a Razorpay call, which can never be inside a
 * transaction:
 *   1. refuse, changing nothing, if a post is live, a creator has submitted their link, or a payout has already been
 *      released or paid out (rejectCreatorPrelude);
 *   2. one transaction withdraws every creator's offer (that closes the accept race) and claims the creator posts as
 *      refund_due;
 *   3. outside any transaction each creator payout is voided (planned, failed) or its transfer reversed (held);
 *   4. only when EVERY creator payout is void or reversed does the booking move to rejected (the transaction above, which
 *      re-checks that under its own lock) and each item get refunded.
 * A step that cannot finish (a transfer still being made, a reversal Razorpay has not confirmed) leaves a VISIBLE partial
 * state (offers withdrawn, posts refund due, the campaign not yet rejected) and the same button resumes from there; nothing
 * is refunded twice and nothing is refunded before its payout is out of the way.
 */
export async function reject(id: string, staffId: string, note: string) {
  const online = (await prisma.campaignPayment.count({ where: { bookingId: id, razorpayPaymentId: { not: null } } })) > 0;

  if (!online) {
    await transitionBooking(id, REJECTABLE, "rejected", staff(staffId), {
      note,
      data: { reviewNote: note, reviewedById: staffId },
    });
    await prisma.campaignBookingItem.updateMany({ where: { bookingId: id, status: { in: ["pending", "manual_pending", "queued"] } }, data: { status: "refunded", lastError: null } });
    let refundError: string | null = null;
    try {
      await refundBookingInFull(id, staff(staffId));
    } catch (err) {
      refundError = err instanceof Error ? err.message : String(err);
    }
    void sendStatusEmail(id, "rejected").catch((e) => console.error("[campaign] rejected email failed", e));
    return { ...(await getBookingForStaff(id)), refundError, refundNotice: null as string | null };
  }

  const pending = await rejectCreatorPrelude(id, staffId);
  if (pending) {
    return { ...(await getBookingForStaff(id)), refundError: null as string | null, refundNotice: pending.notice, rejectPending: true as const };
  }
  return rejectOnline(id, staffId, note);
}

/** Item statuses of a creator's post that a rejection claims as refund_due (`refunded` ones are done already). */
const CREATOR_REJECT_CLAIMABLE = ["pending", "manual_pending", "awaiting_creator", "refund_due"];

type Db = Pick<typeof prisma, "campaignBookingItem" | "creatorOffer" | "creatorPayout">;

/**
 * The refusals of a rejection that has creator posts, read from our own rows (no Razorpay call): a live post, a link a creator
 * submitted and nobody has decided on, a payout that is already released or paid out (or needs a person). Run once before anything is
 * written and again under the booking lock inside the claim.
 */
async function assertCreatorsRejectable(db: Db, bookingId: string): Promise<void> {
  const items = await db.campaignBookingItem.findMany({ where: { bookingId }, select: { id: true, status: true, targetType: true } });
  if (items.some((i) => (LIVE_ITEM_STATUSES as readonly string[]).includes(i.status))) {
    throw new AppError(409, "POSTS_LIVE", "Some posts are already live, so this campaign can't be rejected and refunded in one step. Refund the accounts that weren't posted from their own rows instead.");
  }
  const open = items.filter((i) => i.targetType === CREATOR_TARGET_TYPE && i.status !== "refunded").map((i) => i.id);
  if (open.length === 0) return;
  const submitted = await db.creatorOffer.count({ where: { bookingItemId: { in: open }, status: { in: ["offered", "accepted"] }, linkSubmittedAt: { not: null } } });
  if (submitted > 0) {
    throw new AppError(409, "CREATOR_LINK_SUBMITTED", "A creator has already submitted the link for one of the posts. Check the link and mark it posted, or withdraw that offer (discarding the link) first. Nothing has been changed.");
  }
  const payouts = await db.creatorPayout.findMany({ where: { bookingItemId: { in: open } }, select: { status: true, reversedAt: true, razorpayTransferId: true, attempts: true } });
  for (const p of payouts) {
    const refused = payoutRefundGuard(p);
    if (refused) throw refused;
  }
}

/**
 * Steps 1 to 3 of a rejection that has creator posts (see reject). Returns null when the rejection can go on (every creator
 * payout is void or reversed, or there are no creator posts), else the notice to show staff for the partial state it left.
 */
async function rejectCreatorPrelude(id: string, staffId: string): Promise<{ notice: string } | null> {
  const rows = await prisma.campaignBookingItem.findMany({ where: { bookingId: id, targetType: CREATOR_TARGET_TYPE }, select: { id: true, status: true, accountName: true } });
  if (rows.length === 0) return null;
  const b = await prisma.campaignBooking.findUnique({ where: { id }, select: { status: true } });
  if (!b) throw new AppError(404, "NOT_FOUND", "Campaign not found");
  if (!(REJECTABLE as readonly string[]).includes(b.status)) {
    throw new AppError(409, "INVALID_STATE", `This campaign can't move from "${b.status}" to "rejected" right now. Refresh and try again.`);
  }
  await assertCreatorsRejectable(prisma, id);

  const withdrawn: WithdrawnOffer[] = [];
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM campaign_bookings WHERE id = ${id} FOR UPDATE`;
    const cur = await tx.campaignBooking.findUnique({ where: { id }, select: { status: true } });
    if (!cur || !(REJECTABLE as readonly string[]).includes(cur.status)) throw new AppError(409, "INVALID_STATE", "This campaign changed. Refresh and try again.");
    await assertCreatorsRejectable(tx, id);
    const claimable = await tx.campaignBookingItem.findMany({ where: { bookingId: id, targetType: CREATOR_TARGET_TYPE, status: { in: CREATOR_REJECT_CLAIMABLE } }, select: { id: true, status: true } });
    for (const i of claimable) {
      const claim = await tx.campaignBookingItem.updateMany({ where: { id: i.id, status: i.status, OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date() } }] }, data: { status: "refund_due" } });
      if (claim.count !== 1) throw new AppError(409, "BUSY", "A creator's post changed while the campaign was being rejected — try again in a minute.");
    }
    await withdrawOpenOffers(tx, claimable.map((i) => i.id), "booking_rejected", staffId, withdrawn);
    if (claimable.length > 0) await logBookingEvent(id, staff(staffId), `Rejecting: ${claimable.length} creator post(s) claimed, their offers withdrawn. The creators' payouts are taken back before anything is refunded.`.slice(0, 500), tx);
  });
  // The creators who had seen their offer are told it is gone (after the commit, never blocking what follows).
  void sendOfferWithdrawnEmails(withdrawn).catch(() => undefined);

  // 3. UNWIND each creator payout, outside any transaction. A refunded item's payout is out of the way already.
  const waiting: RefundReadiness[] = [];
  for (const row of rows) {
    if (row.status === "refunded") continue;
    const r = await reverseForRefund(row.id, { actor: staff(staffId), reason: "booking_rejected" });
    if (!r.refundable) waiting.push(r);
  }
  if (waiting.length === 0) return null;
  const blocked = waiting.filter((r) => r.state === "blocked").length;
  return {
    notice:
      (blocked > 0
        ? `${blocked} creator payout(s) can't be taken back by themselves: open the payout queue and look at them. `
        : `${waiting.length} creator payout(s) are not taken back yet (a transfer is still being made, or Razorpay hasn't confirmed the reversal). `) +
      "The creators' offers are withdrawn and their posts are marked refund due, but the campaign is NOT rejected yet, so nothing is half-refunded. Press Reject again in a few minutes to finish: nothing is refunded twice.",
  };
}

/** Steps 4 onwards: the booking becomes rejected, every not-posted item is claimed and refunded per item. */
async function rejectOnline(id: string, staffId: string, note: string) {
  const owed: string[] = [];
  const claimed: Array<{ id: string; pricePaise: number }> = [];
  await prisma.$transaction(async (tx) => {
    await transitionBooking(id, REJECTABLE, "rejected", staff(staffId), {
      tx,
      note,
      data: { reviewNote: note, reviewedById: staffId },
    });
    const items = await tx.campaignBookingItem.findMany({ where: { bookingId: id }, select: { id: true, status: true, pricePaise: true, targetType: true } });
    if (items.some((i) => (LIVE_ITEM_STATUSES as readonly string[]).includes(i.status))) {
      throw new AppError(409, "POSTS_LIVE", "Some posts are already live, so this campaign can't be rejected and refunded in one step. Refund the accounts that weren't posted from their own rows instead.");
    }
    for (const i of items) {
      if (!NOT_POSTED_ITEM_STATUSES.includes(i.status)) continue;
      // A creator's post was claimed, its offer withdrawn and its payout unwound BEFORE this transaction (rejectCreatorPrelude).
      // It goes through only if that payout is really out of the way, checked here under the same transaction as the move to
      // rejected, so nothing can slip a transfer in between. A throw undoes the whole rejection.
      if (i.targetType === CREATOR_TARGET_TYPE) {
        const payout = await tx.creatorPayout.findUnique({ where: { bookingItemId: i.id }, select: { status: true } });
        if (payout && payout.status !== "void" && payout.status !== "reversed") {
          throw new AppError(409, "PAYOUT_BUSY", "A creator's payout is not taken back yet, so this campaign can't be rejected and refunded yet. Try again in a few minutes. Nothing has been changed.");
        }
      }
      const claim = await tx.campaignBookingItem.updateMany({
        where: { id: i.id, status: i.status, OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date() } }] },
        data: { status: "refunded", lastError: null },
      });
      if (claim.count !== 1) throw new AppError(409, "BUSY", "An account is being published right now — try again in a minute.");
      claimed.push({ id: i.id, pricePaise: i.pricePaise });
    }
    const pays = await tx.campaignPayment.findMany({
      where: { bookingId: id, razorpayPaymentId: { not: null }, status: { in: ["captured", "refund_pending", "refund_failed"] } },
      select: { id: true },
    });
    owed.push(...pays.map((p) => p.id));
    await tx.campaignPayment.updateMany({ where: { id: { in: owed } }, data: { status: "refund_due" } });
  });

  const errors: string[] = [];
  let confirming = false;
  for (const item of claimed) {
    try {
      const pay = await capturedPaymentFor(id, item.pricePaise, { only: owed });
      if (!pay) throw new AppError(409, "NOTHING_TO_REFUND", "There is no payment left that can cover this refund.");
      const r = await refundPaymentRow(pay.id, item.pricePaise, `item:${item.id.slice(0, 30)}`, staff(staffId), {
        key: `rf-item-${item.id}`,
        reason: "booking_rejected",
        itemId: item.id,
      });
      if (r.state === "confirming") confirming = true;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  await maybeMarkRefunded(id);
  void sendStatusEmail(id, "rejected").catch((e) => console.error("[campaign] rejected email failed", e));
  const refundError = errors.length === 0
    ? null
    : `${errors.length === 1 ? errors[0] : `${errors.length} refunds could not be issued (first: ${errors[0]})`} The campaign is rejected and the money is marked as owed back; ${refundRetryClause()}`;
  return { ...(await getBookingForStaff(id)), refundError, refundNotice: confirming ? refundConfirmingNotice() : null };
}

async function itemOf(bookingId: string, itemId: string) {
  const item = await prisma.campaignBookingItem.findFirst({ where: { id: itemId, bookingId } });
  if (!item) throw new AppError(404, "NOT_FOUND", "Item not found");
  return item;
}

async function afterItemChange(bookingId: string, staffId: string) {
  const finished = await settleBooking(bookingId, staff(staffId));
  if (finished) void sendDeliveryEmail(bookingId).catch((e) => console.error("[campaign] delivery email failed", e));
}

/**
 * A creator's post goes live ONLY from the link the creator sent, and only once the creator accepted and the check that the
 * post is on THEIR page passed (automatically, or by a member of staff who ticked "checked by hand"): verifyCreatorItem
 * refuses, with nothing changed, otherwise. Both the generic "posted" route and "Verify link & release" end here, so there
 * is one way a creator's post becomes live and one place its rules live.
 */
async function markCreatorPosted(
  bookingId: string,
  item: { id: string; accountName: string },
  staffId: string,
  o: { url?: string | null; expectedLinkKey?: string | null; ownershipCheckedByHand?: boolean },
) {
  const b = await prisma.campaignBooking.findUnique({ where: { id: bookingId }, select: { status: true } });
  if (!b || !["approved", "publishing", "completed", "partially_published"].includes(b.status)) {
    throw new AppError(409, "INVALID_STATE", "Approve the campaign before recording posts.");
  }
  await verifyCreatorItem(bookingId, item.id, { staffId, url: o.url ?? null, expectedLinkKey: o.expectedLinkKey ?? null, ownershipCheckedByHand: o.ownershipCheckedByHand === true });
  void sendItemLiveEmail(item.id).catch((e) => console.error("[campaign] live email failed", e));
  await afterItemChange(bookingId, staffId);
  // Schedules the release of the creator's payout (verified_at + the hold days, a day at least after a hand check). Nothing is
  // released here: the reconciliation worker does it once the whole release gate holds. It must never undo a verification that already committed.
  await onCreatorLinkVerified(item.id, staff(staffId)).catch((e) => console.error("[campaign] creator link follow-up failed", e));
  return getBookingForStaff(bookingId);
}

/**
 * "Verify link & release": make the creator's submitted link the live post (see markCreatorPosted). `linkCanonicalKey` is the
 * key of the link the staff member was looking at (the offer's `linkCanonicalKey` in the booking detail): when the creator has
 * since sent another link it is 409 LINK_CHANGED and nothing is verified, so a "checked by hand" tick can never land on a link
 * nobody looked at.
 */
export async function verifyCreatorLink(bookingId: string, itemId: string, staffId: string, o: { ownershipCheckedByHand?: boolean; linkCanonicalKey: string }) {
  const item = await itemOf(bookingId, itemId);
  if (item.targetType !== CREATOR_TARGET_TYPE) throw new AppError(409, "NOT_CREATOR_ITEM", "This isn't a creator's post: record its link with “Mark posted”.");
  return markCreatorPosted(bookingId, item, staffId, { ownershipCheckedByHand: o.ownershipCheckedByHand === true, expectedLinkKey: o.linkCanonicalKey });
}

/** What staff are told after a withdraw, from what became of the creator's payout and the client's refund. */
function withdrawNoticeFor(r: CreatorRefundOutcome | null): string {
  const head = "The offer is withdrawn and the post is marked refund due.";
  if (!r || r.state === "skipped") return `${head} The creator's payout is taken back and the client refunded automatically: nothing more to do.`;
  if (r.state === "refunded") return `${head} The creator's payout was taken back and the client's refund has been issued.`;
  if (r.state === "refund_pending") return `${head} The creator's payout was taken back and the client's refund was requested: Razorpay is confirming it.`;
  if (r.state === "blocked") return `${head} The creator's payout can't be taken back by itself: open the payout queue and look at it. The client is refunded once it has been.`;
  if (r.state === "error") return `${head} The creator's payout was taken back, but Razorpay did not accept the client's refund yet. It is retried automatically; press Refund on the post to try again now.`;
  return `${head} The creator's payout is still being taken back (Razorpay has not confirmed it). The client is refunded automatically as soon as it is: nothing more to do.`;
}

/**
 * Withdraw a creator's open offer: the post goes to refund_due, its payout is voided or reversed, and the client is then
 * refunded for it (automatically; whatever cannot finish yet is finished by the reconciliation worker). Refused (409) once the
 * creator has submitted a link, unless staff say to discard it, and always once the link has been verified.
 */
export async function withdrawOffer(bookingId: string, itemId: string, staffId: string, o: { discardSubmittedLink?: boolean } = {}) {
  await itemOf(bookingId, itemId);
  const offer = await prisma.creatorOffer.findFirst({ where: { bookingItemId: itemId, bookingId }, select: { id: true } });
  if (!offer) throw new AppError(404, "NOT_FOUND", "There is no creator offer for this post.");
  let settled: CreatorRefundOutcome | null = null;
  await withdrawCreatorOffer(offer.id, { staffId, closedReason: "withdrawn", discardSubmittedLink: o.discardSubmittedLink === true, alert: false, onSettled: (r) => (settled = r) });
  return {
    ...(await getBookingForStaff(bookingId)),
    withdrawNotice: withdrawNoticeFor(settled),
  };
}

/** Staff posted it by hand: record the link. The link must point at the item's platform. */
export async function markPosted(bookingId: string, itemId: string, staffId: string, url: string) {
  const item = await itemOf(bookingId, itemId);
  if (item.targetType === CREATOR_TARGET_TYPE) return markCreatorPosted(bookingId, item, staffId, { url });
  if (!isPlatformPostUrl(item.platform as CampaignPlatform, url)) {
    throw new AppError(400, "WRONG_PLATFORM", `That link isn't a ${item.platform} link.`);
  }
  const b = await prisma.campaignBooking.findUnique({ where: { id: bookingId }, select: { status: true } });
  if (!b || !["approved", "publishing", "completed", "partially_published"].includes(b.status)) {
    throw new AppError(409, "INVALID_STATE", "Approve the campaign before recording posts.");
  }
  const editingLink = item.status === "posted_manual" || item.status === "published";
  const res = await prisma.campaignBookingItem.updateMany({
    // Not "queued": the worker may be publishing it — staff switch it to "post by hand" first,
    // so a hand-made post and an API post can never both go out.
    where: { id: itemId, status: { in: ["manual_pending", "failed", "posted_manual", "published"] } },
    data: {
      status: editingLink ? item.status : "posted_manual",
      permalink: url,
      postedAt: item.postedAt ?? new Date(),
      postedById: staffId,
      lastError: null,
    },
  });
  if (res.count !== 1) {
    throw new AppError(409, "INVALID_STATE", item.status === "queued"
      ? "This account is set to auto-publish. Choose \"Post by hand instead\" first."
      : "This item can't be marked posted (it may have been refunded).");
  }
  await logBookingEvent(bookingId, staff(staffId), `${editingLink ? "Link updated" : "Posted"} on ${item.accountName} (${item.format}): ${url}`);
  if (editingLink && !item.permalink) {
    // Auto-published, but Meta never returned the link: the client hasn't been told it is live.
    void sendItemLiveEmail(itemId).catch((e) => console.error("[campaign] live email failed", e));
  }
  if (!editingLink) {
    void sendItemLiveEmail(itemId).catch((e) => console.error("[campaign] live email failed", e));
    await afterItemChange(bookingId, staffId);
  }
  return getBookingForStaff(bookingId);
}

export async function markFailed(bookingId: string, itemId: string, staffId: string, note: string) {
  const item = await itemOf(bookingId, itemId);
  // Marking failed refunds nothing and leaves the creator's offer and payout standing. A creator's post that won't
  // happen is refunded (which voids the payout and withdraws the offer), never parked as "failed".
  if (item.targetType === CREATOR_TARGET_TYPE) {
    // While the creator's offer is open the way out is Withdraw (it ends the offer and the planned payout, then Refund returns the money).
    const open = await prisma.creatorOffer.count({ where: { bookingItemId: itemId, status: { in: ["offered", "accepted"] } } });
    if (open > 0) {
      throw new AppError(409, "USE_WITHDRAW", "A creator's post can't be marked failed while the creator's offer is open. Withdraw the offer instead, then refund the post: marking it failed would leave the offer and the creator's payout standing.");
    }
    throw new AppError(409, "CREATOR_ITEM", "A creator's post can't be marked failed. Refund it instead: that withdraws the offer and returns the money to the client.");
  }
  const res = await prisma.campaignBookingItem.updateMany({
    // A queued item mid-publish (locked) can't be failed under the worker's feet.
    where: { id: itemId, status: { in: ["manual_pending", "queued"] }, OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date() } }] },
    data: { status: "failed", lastError: note.slice(0, 500) },
  });
  if (res.count !== 1) throw new AppError(409, "INVALID_STATE", "Only an item that is waiting to be posted can be marked failed.");
  await logBookingEvent(bookingId, staff(staffId), `Could not post on ${item.accountName}: ${note}`);
  await afterItemChange(bookingId, staffId);
  return getBookingForStaff(bookingId);
}

/** What staff are told after refunding a creator's post, from what became of the creator's payout and the client's refund. */
function creatorRefundNotice(r: CreatorRefundOutcome): string | null {
  switch (r.state) {
    case "refunded":
    case "skipped":
      return null;
    case "refund_pending":
      return refundConfirmingNotice();
    case "blocked":
      return "This post is marked refund due, but the creator's payout can't be taken back by itself (it needs a person: open the payout queue). The client is refunded as soon as it has been.";
    case "error":
      return "The creator's payout was taken back, but Razorpay did not accept the client's refund yet. It is retried automatically, and you can press Refund again to try now.";
    default:
      return r.reason === "in_flight"
        ? "This post is marked refund due. The creator's payout is still being set aside at Razorpay, so it can't be taken back yet. The client is refunded automatically as soon as it can be: nothing more to do."
        : r.reason === "transfers_pending"
          ? "This post is marked refund due. Another creator's payout on this campaign is still being set aside, and a refund can't start until it is. The client is refunded automatically a few minutes after: nothing more to do."
          : r.reason === "no_refundable_balance"
            ? "This post is marked refund due, but the payment has no refundable balance for it yet (a creator's share on it is still reserved). The client is refunded automatically as soon as it is free."
            : "This post is marked refund due. The creator's payout is being taken back and Razorpay hasn't confirmed it yet. The client is refunded automatically as soon as it has: nothing more to do.";
  }
}

/**
 * Refund a creator's post: CLAIM it (the item → refund_due, the creator's offer withdrawn, refused with nothing changed if the
 * creator has submitted a link or the payout is already released or paid out: one transaction under the booking lock), then
 * UNWIND its payout (void it, or reverse the held transfer: outside any transaction) and only then refund the client, under the
 * item's own ledger key. If the payout cannot be out of the way yet the post simply stays refund_due and the reconciliation worker
 * refunds it as soon as it can: pressing Refund again is always safe and never refunds twice.
 */
async function refundCreatorItem(bookingId: string, item: { id: string; status: string; lastError: string | null; accountName: string }, staffId: string) {
  const withdrawn: WithdrawnOffer[] = [];
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM campaign_bookings WHERE id = ${bookingId} FOR UPDATE`;
    const claim = await tx.campaignBookingItem.updateMany({
      where: { id: item.id, status: item.status, OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date() } }] },
      // The hand-post reason no longer applies to an item that will not be posted; a refund_due item keeps what it already says.
      data: { status: "refund_due", lastError: item.status === "refund_due" ? item.lastError : null },
    });
    if (claim.count !== 1) throw new AppError(409, "INVALID_STATE", "This item changed — refresh and try again.");
    await prepareCreatorItemRefund(tx, item.id, { actor: staff(staffId), reason: "item_refunded", closedReason: "withdrawn", withdrawn });
  });
  // The creator, if they had seen the offer, is told not to post (once the claim is committed, whatever Razorpay answers next).
  void sendOfferWithdrawnEmails(withdrawn).catch(() => undefined);
  const r = await progressCreatorItemRefund(item.id, { actor: staff(staffId), reason: "item_refunded" });
  if (r.state === "error") throw r.error;
  await afterItemChange(bookingId, staffId);
  return { ...(await getBookingForStaff(bookingId)), refundNotice: creatorRefundNotice(r) };
}

/** Refund one item that wasn't (and won't be) posted. */
export async function refundItem(bookingId: string, itemId: string, staffId: string) {
  const item = await itemOf(bookingId, itemId);
  // awaiting_creator: withdraw the creator's offer and refund; refund_due: the refund that is owed (a page that changed hands).
  if (!["manual_pending", "failed", "queued", "pending", "awaiting_creator", "refund_due"].includes(item.status)) {
    throw new AppError(409, "INVALID_STATE", "Only an item that wasn't posted can be refunded.");
  }
  // A creator's post is a sequence of its own (claim, unwind the payout, refund), because the creator's share may already be
  // out of our balance. It must not look for a payment that can cover it first: until its payout is out of the way that share is reserved.
  if (item.targetType === CREATOR_TARGET_TYPE) return refundCreatorItem(bookingId, item, staffId);
  const pay = await capturedPaymentFor(bookingId, item.pricePaise);
  if (!pay) {
    // A booking submitted without online payment has no payment row at all: the item is
    // dropped from the amount to collect, and the money (if any changed hands) is settled by
    // hand. A booking that DOES have an online payment which can't cover the item is a real
    // conflict and stays an error.
    const online = await prisma.campaignPayment.count({ where: { bookingId, razorpayPaymentId: { not: null } } });
    if (online > 0) throw new AppError(409, "NOTHING_TO_REFUND", "There is no captured payment that can cover this refund.");
  }
  // Claim the item first so two clicks cannot refund it twice.
  const claim = await prisma.campaignBookingItem.updateMany({
    where: { id: itemId, status: item.status, OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date() } }] },
    // The hand-post reason no longer applies to an item that will not be posted.
    data: { status: "refunded", lastError: null },
  });
  if (claim.count !== 1) throw new AppError(409, "INVALID_STATE", "This item changed — refresh and try again.");
  if (!pay) {
    await logBookingEvent(bookingId, staff(staffId), `${item.accountName} removed from the booking (${item.pricePaise} paise) — no online payment on this booking; settle by hand if the client has already paid.`);
    await afterItemChange(bookingId, staffId);
    return { ...(await getBookingForStaff(bookingId)), refundNotice: null as string | null };
  }
  let result;
  try {
    result = await refundPaymentRow(pay.id, item.pricePaise, `item:${itemId.slice(0, 30)}`, staff(staffId), {
      key: `rf-item-${itemId}`,
      reason: "item_refunded",
      itemId,
    });
  } catch (err) {
    // Nothing was refunded (Razorpay refused, or the claim itself failed): the item is open again.
    // The one exception: Razorpay refused but giving the claim back failed too, so the refund is
    // still claimed and the sweep will re-send it. Re-opening the item then would let staff post it
    // while that refund can still go through, so it stays refunded; the sweep either completes the
    // refund or, if it is refused again, issues it afresh (see resendFailedItemRefunds).
    const stillClaimed = await prisma.campaignRefund
      .count({ where: { bookingItemId: itemId, origin: "ours", status: { in: ["requested", "pending"] } } })
      .catch(() => 0);
    if (stillClaimed === 0) await prisma.campaignBookingItem.update({ where: { id: itemId }, data: { status: item.status } });
    throw err;
  }
  // An unanswered request is NOT a failure: the item stays refunded (claimed) and the ledger row
  // stays pending, so a second click can neither refund it again nor undo the claim.
  await afterItemChange(bookingId, staffId);
  return { ...(await getBookingForStaff(bookingId)), refundNotice: result.state === "confirming" ? refundConfirmingNotice() : null };
}

/** Staff: publish a queued item now (skipping the launch-day wait), or move a hand-posted item
 *  to auto-publish if the API can do it. */
export async function publishNow(bookingId: string, itemId: string, staffId: string) {
  const item = await itemOf(bookingId, itemId);
  const b = await prisma.campaignBooking.findUnique({
    where: { id: bookingId },
    select: { status: true, audioIntegration: true, media: { where: { purgedAt: null }, select: { kind: true, role: true } } },
  });
  if (!b || !["approved", "publishing"].includes(b.status)) throw new AppError(409, "INVALID_STATE", "Approve the campaign first.");
  if (item.status !== "queued" && item.status !== "manual_pending") {
    throw new AppError(409, "INVALID_STATE", "Only an item that is waiting to be posted can be published.");
  }
  const e = await checkEligibility(item, b);
  if (!e.ok) throw new AppError(409, "NOT_PUBLISHABLE", e.reason);
  const res = await prisma.campaignBookingItem.updateMany({
    where: { id: itemId, status: item.status, OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date() } }] },
    data: item.status === "queued"
      ? { nextAttemptAt: new Date() }
      : { status: "queued", nextAttemptAt: new Date(), attempts: 0, containerId: null, lastError: null },
  });
  if (res.count !== 1) throw new AppError(409, "BUSY", "This item is being published right now — try again in a minute.");
  await logBookingEvent(bookingId, staff(staffId), `Publish now: ${item.accountName} (${item.format})`);
  return getBookingForStaff(bookingId);
}

/** Staff: stop auto-publishing an item and post it by hand instead. */
export async function switchToManual(bookingId: string, itemId: string, staffId: string) {
  const item = await itemOf(bookingId, itemId);
  const res = await prisma.campaignBookingItem.updateMany({
    where: { id: itemId, status: "queued", OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date() } }] },
    data: { status: "manual_pending", nextAttemptAt: null, lastError: "Staff chose to post this by hand." },
  });
  if (res.count !== 1) throw new AppError(409, "BUSY", "This item is being published right now — try again in a minute.");
  await logBookingEvent(bookingId, staff(staffId), `Switched to posting by hand: ${item.accountName} (${item.format})`);
  return getBookingForStaff(bookingId);
}

export async function resendDelivery(bookingId: string) {
  const b = await prisma.campaignBooking.findUnique({ where: { id: bookingId }, select: { status: true } });
  if (!b || !["completed", "partially_published"].includes(b.status)) {
    throw new AppError(409, "NOT_DELIVERED", "The delivery email goes out once every post is live.");
  }
  await prisma.campaignBooking.update({ where: { id: bookingId }, data: { deliveredAt: new Date() } });
  await sendDeliveryEmail(bookingId, { force: true });
  return { sent: true };
}
