import { prisma } from "@dashmani/db";
import { CREATOR_TARGET_TYPE, isPlatformPostUrl, LIVE_ITEM_STATUSES, type CampaignPlatform } from "@dashmani/shared";
import { AppError } from "../../middleware/error-handler";
import { transitionBooking, settleBooking, logBookingEvent } from "./booking.service";
import { refundBookingInFull, refundPaymentRow, capturedPaymentFor, maybeMarkRefunded, refundSweepEnabled } from "./payment.service";
import { sendDeliveryEmail, sendItemLiveEmail, sendStatusEmail } from "./delivery.service";
import { campaignConfig } from "./config";
import { checkEligibility, launchAt, planPublishing } from "./publish.service";
import { onCreatorLinkVerified, prepareCreatorItemRefund, reconcileCreatorOwnership, type WithdrawnOffer } from "../creator/payout-ledger";
import { alertOfferProblems, createOffersForBooking, listOffersForBooking, sendOfferEmails, sendOfferWithdrawnEmails, verifyCreatorItem, withdrawOffer as withdrawCreatorOffer, type CreatedOffers } from "../creator/creator-offer.service";

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

  const owed: string[] = [];
  const claimed: Array<{ id: string; pricePaise: number }> = [];
  const withdrawn: WithdrawnOffer[] = [];
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
      const claim = await tx.campaignBookingItem.updateMany({
        where: { id: i.id, status: i.status, OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date() } }] },
        data: { status: "refunded", lastError: null },
      });
      if (claim.count !== 1) throw new AppError(409, "BUSY", "An account is being published right now — try again in a minute.");
      // A creator's post: void its payout (or refuse), and withdraw the creator's offer, in THIS transaction. A throw
      // (the share is already on its way to the creator, or they have posted) undoes the whole rejection.
      if (i.targetType === CREATOR_TARGET_TYPE) {
        await prepareCreatorItemRefund(tx, i.id, { actor: staff(staffId), reason: "booking_rejected", closedReason: "booking_rejected", withdrawn });
      }
      claimed.push({ id: i.id, pricePaise: i.pricePaise });
    }
    const pays = await tx.campaignPayment.findMany({
      where: { bookingId: id, razorpayPaymentId: { not: null }, status: { in: ["captured", "refund_pending", "refund_failed"] } },
      select: { id: true },
    });
    owed.push(...pays.map((p) => p.id));
    await tx.campaignPayment.updateMany({ where: { id: { in: owed } }, data: { status: "refund_due" } });
  });

  // The creators who had seen their offer are told it is gone (after the commit, never blocking the refunds below).
  void sendOfferWithdrawnEmails(withdrawn).catch(() => undefined);
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
  // Nothing is paid in this phase (the seam does nothing); it must never undo a verification that already committed.
  await onCreatorLinkVerified(item.id).catch((e) => console.error("[campaign] creator link follow-up failed", e));
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

/**
 * Withdraw a creator's open offer: the post goes to refund_due, its planned payout is voided, and staff Refund it from the
 * row. NOTHING IS REFUNDED HERE. Refused (409) once the creator has submitted a link, unless staff say to discard it, and
 * always once the link has been verified.
 */
export async function withdrawOffer(bookingId: string, itemId: string, staffId: string, o: { discardSubmittedLink?: boolean } = {}) {
  await itemOf(bookingId, itemId);
  const offer = await prisma.creatorOffer.findFirst({ where: { bookingItemId: itemId, bookingId }, select: { id: true } });
  if (!offer) throw new AppError(404, "NOT_FOUND", "There is no creator offer for this post.");
  await withdrawCreatorOffer(offer.id, { staffId, closedReason: "withdrawn", discardSubmittedLink: o.discardSubmittedLink === true, alert: false });
  return {
    ...(await getBookingForStaff(bookingId)),
    withdrawNotice: "The offer is withdrawn and the post is marked refund due. Nothing has been refunded yet: press Refund on the post to return the client's money.",
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

/** Refund one item that wasn't (and won't be) posted. */
export async function refundItem(bookingId: string, itemId: string, staffId: string) {
  const item = await itemOf(bookingId, itemId);
  // awaiting_creator: withdraw the creator's offer and refund; refund_due: the refund that is owed (a page that changed hands).
  if (!["manual_pending", "failed", "queued", "pending", "awaiting_creator", "refund_due"].includes(item.status)) {
    throw new AppError(409, "INVALID_STATE", "Only an item that wasn't posted can be refunded.");
  }
  const isCreator = item.targetType === CREATOR_TARGET_TYPE;
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
  const claimItem = (db: Pick<typeof prisma, "campaignBookingItem">) =>
    db.campaignBookingItem.updateMany({
      where: { id: itemId, status: item.status, OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date() } }] },
      // The hand-post reason no longer applies to an item that will not be posted.
      data: { status: "refunded", lastError: null },
    });
  // A creator's post is claimed together with the end of its payout and its offer: ONE transaction, so a payout that
  // can't be voided (the share is already on its way to the creator) refuses the refund and leaves everything as it was.
  const withdrawn: WithdrawnOffer[] = [];
  const claim = isCreator
    ? await prisma.$transaction(async (tx) => {
        const c = await claimItem(tx);
        if (c.count === 1) await prepareCreatorItemRefund(tx, itemId, { actor: staff(staffId), reason: "item_refunded", closedReason: "withdrawn", withdrawn });
        return c;
      })
    : await claimItem(prisma);
  if (claim.count !== 1) throw new AppError(409, "INVALID_STATE", "This item changed — refresh and try again.");
  // The creator, if they had seen the offer, is told not to post (once the claim is committed, whatever Razorpay answers next).
  void sendOfferWithdrawnEmails(withdrawn).catch(() => undefined);
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
    // A creator's item cannot go back to waiting for a creator (its offer is withdrawn and its payout void): the
    // refund is simply still owed, so it is refund_due and staff press Refund again.
    if (stillClaimed === 0) await prisma.campaignBookingItem.update({ where: { id: itemId }, data: { status: isCreator ? "refund_due" : item.status } });
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
