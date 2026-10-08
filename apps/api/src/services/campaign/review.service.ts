import { prisma } from "@dashmani/db";
import { isPlatformPostUrl, type CampaignPlatform } from "@dashmani/shared";
import { AppError } from "../../middleware/error-handler";
import { transitionBooking, settleBooking, logBookingEvent } from "./booking.service";
import { refundBookingInFull, refundPaymentRow, capturedPaymentFor } from "./payment.service";
import { sendDeliveryEmail, sendItemLiveEmail, sendStatusEmail } from "./delivery.service";
import { campaignConfig } from "./config";
import { checkEligibility, launchAt, planPublishing } from "./publish.service";

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
      items: { orderBy: { createdAt: "asc" } },
      payments: { orderBy: { createdAt: "asc" } },
      events: { orderBy: { createdAt: "desc" }, take: 100 },
    },
  });
  if (!b) throw new AppError(404, "NOT_FOUND", "Campaign not found");
  return {
    ...b,
    autoPublish: { enabled: campaignConfig.publishEnabled(), dueAt: launchAt(b.launchFrom) },
    launchFrom: ymd(b.launchFrom),
    launchTo: ymd(b.launchTo),
    media: b.media.map((m) => ({
      id: m.id,
      position: m.position,
      kind: m.kind,
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
  // Phase 2: items the API can publish are queued for the launch day; everything else (and
  // everything while CAMPAIGN_PUBLISH_ENABLED is off) is posted by our team, as in Phase 1.
  const plan = await planPublishing(id);
  await prisma.$transaction(async (tx) => {
    await transitionBooking(id, ["paid_pending_review"], "approved", staff(staffId), {
      tx,
      data: { approvedAt: new Date(), reviewedById: staffId, reviewNote: null },
    });
    for (const p of plan) {
      await tx.campaignBookingItem.updateMany({
        where: { id: p.itemId, status: "pending" },
        data: p.auto
          ? { status: "queued", nextAttemptAt: p.at, attempts: 0, containerId: null, lastError: null }
          : { status: "manual_pending" },
      });
    }
    // Anything the plan didn't see (it can't miss any, but never leave an item pending).
    await tx.campaignBookingItem.updateMany({ where: { bookingId: id, status: "pending" }, data: { status: "manual_pending" } });
  });
  if (campaignConfig.publishEnabled()) {
    for (const p of plan.filter((x) => !x.auto)) {
      await logBookingEvent(id, staff(staffId), `Post by hand on ${p.accountName}: ${p.reason}`);
    }
  }
  void sendStatusEmail(id, "approved").catch((e) => console.error("[campaign] approved email failed", e));
  return getBookingForStaff(id);
}

export async function requestChanges(id: string, staffId: string, note: string) {
  await transitionBooking(id, ["paid_pending_review"], "changes_requested", staff(staffId), {
    note,
    data: { reviewNote: note, reviewedById: staffId },
  });
  void sendStatusEmail(id, "changes_requested").catch((e) => console.error("[campaign] changes email failed", e));
  return getBookingForStaff(id);
}

/** Reject and refund in full. The booking moves to `refunded` once Razorpay confirms. */
export async function reject(id: string, staffId: string, note: string) {
  await transitionBooking(id, ["paid_pending_review", "changes_requested", "approved"], "rejected", staff(staffId), {
    note,
    data: { reviewNote: note, reviewedById: staffId },
  });
  await prisma.campaignBookingItem.updateMany({ where: { bookingId: id, status: { in: ["pending", "manual_pending", "queued"] } }, data: { status: "refunded" } });
  let refundError: string | null = null;
  try {
    await refundBookingInFull(id, staff(staffId));
  } catch (err) {
    refundError = err instanceof Error ? err.message : String(err);
  }
  void sendStatusEmail(id, "rejected").catch((e) => console.error("[campaign] rejected email failed", e));
  return { ...(await getBookingForStaff(id)), refundError };
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

/** Staff posted it by hand: record the link. The link must point at the item's platform. */
export async function markPosted(bookingId: string, itemId: string, staffId: string, url: string) {
  const item = await itemOf(bookingId, itemId);
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
  if (!editingLink) {
    void sendItemLiveEmail(itemId).catch((e) => console.error("[campaign] live email failed", e));
    await afterItemChange(bookingId, staffId);
  }
  return getBookingForStaff(bookingId);
}

export async function markFailed(bookingId: string, itemId: string, staffId: string, note: string) {
  const item = await itemOf(bookingId, itemId);
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
  if (!["manual_pending", "failed", "queued", "pending"].includes(item.status)) {
    throw new AppError(409, "INVALID_STATE", "Only an item that wasn't posted can be refunded.");
  }
  const pay = await capturedPaymentFor(bookingId, item.pricePaise);
  if (!pay) throw new AppError(409, "NOTHING_TO_REFUND", "There is no captured payment that can cover this refund.");
  // Claim the item first so two clicks cannot refund it twice.
  const claim = await prisma.campaignBookingItem.updateMany({
    where: { id: itemId, status: item.status, OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date() } }] },
    data: { status: "refunded" },
  });
  if (claim.count !== 1) throw new AppError(409, "INVALID_STATE", "This item changed — refresh and try again.");
  try {
    await refundPaymentRow(pay.id, item.pricePaise, `item:${itemId.slice(0, 30)}`, staff(staffId));
  } catch (err) {
    await prisma.campaignBookingItem.update({ where: { id: itemId }, data: { status: item.status } });
    throw err;
  }
  await afterItemChange(bookingId, staffId);
  return getBookingForStaff(bookingId);
}

/** Staff: publish a queued item now (skipping the launch-day wait), or move a hand-posted item
 *  to auto-publish if the API can do it. */
export async function publishNow(bookingId: string, itemId: string, staffId: string) {
  const item = await itemOf(bookingId, itemId);
  const b = await prisma.campaignBooking.findUnique({
    where: { id: bookingId },
    select: { status: true, audioIntegration: true, media: { where: { purgedAt: null }, select: { kind: true } } },
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
    data: { status: "manual_pending", nextAttemptAt: null, lastError: null },
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
