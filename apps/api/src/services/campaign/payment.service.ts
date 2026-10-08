import crypto from "crypto";
import { prisma, Prisma } from "@dashmani/db";
import { AppError } from "../../middleware/error-handler";
import { razorpayConfig } from "./config";
import * as rzp from "./razorpay";
import { assertCreativeReady, transitionBooking, logBookingEvent, type Actor } from "./booking.service";
import { notifyStaffPaid, sendStatusEmail } from "./delivery.service";
import { priceFor } from "./rate-card.service";

// Checkout, the Razorpay webhook, and refunds.
//
// ⚠️ Money rules:
//  • The amount is ALWAYS computed here from the frozen item prices — nothing the client sends
//    is used as a price.
//  • Only the webhook (HMAC-verified over the raw body) marks a booking paid. The checkout
//    handler's verify call only drives the UI.
//  • A webhook event is processed once (razorpay_webhook_events.event_id is unique).
//  • A captured payment whose amount doesn't match the booking (the client edited after
//    checkout and then paid an old order) is refunded, never accepted.

/** Pure: the booking total from its items. */
export function computeTotal(items: Array<{ pricePaise: number }>): number {
  return items.reduce((s, i) => s + i.pricePaise, 0);
}

export async function checkout(clientId: string, bookingId: string) {
  if (!razorpayConfig.configured()) throw new AppError(503, "PAYMENTS_UNAVAILABLE", "Online payment isn't available right now. Please contact us.");
  const b = await prisma.campaignBooking.findFirst({
    where: { id: bookingId, clientId },
    select: { id: true, status: true, name: true, launchFrom: true, format: true, campaignType: true, audioIntegration: true, audioTrack: true, items: { select: { id: true, rateCardId: true, pricePaise: true, platform: true, format: true, accountName: true } } },
  });
  if (!b) throw new AppError(404, "NOT_FOUND", "Campaign not found");
  if (!["draft", "awaiting_payment"].includes(b.status)) throw new AppError(409, "INVALID_STATE", "This campaign has already been paid for.");
  if (!b.launchFrom) throw new AppError(400, "NO_INFO", "Add the campaign details first.");
  if (b.items.length === 0) throw new AppError(400, "NO_ITEMS", "Pick at least one account.");
  await assertCreativeReady(bookingId);

  // Re-price from the CURRENT rate cards: a price that changed since the client picked it is
  // what they pay now, and an account withdrawn since then blocks checkout.
  const cards = await prisma.campaignRateCard.findMany({ where: { id: { in: b.items.map((i) => i.rateCardId) }, active: true } });
  // The campaign type picks the Brand or Entertainment price; reel audio integration adds the
  // account's audio add-on (see priceFor).
  const cardById = new Map(cards.map((c) => [c.id, c]));
  const priced = b.items.map((i) => {
    const card = cardById.get(i.rateCardId);
    const p = card ? priceFor(card, b) : null;
    if (!p) throw new AppError(409, "RATE_CARD_UNAVAILABLE", `${i.accountName} is no longer available for this campaign. Remove it and try again.`);
    return { ...i, pricePaise: p.total, basePaise: p.base, audioAddonPaise: p.addon };
  });
  const total = computeTotal(priced);
  if (total < 100) throw new AppError(400, "AMOUNT_TOO_LOW", "The total is below the minimum payment.");

  const order = await rzp.createOrder(total, `cb_${b.id.slice(0, 30)}`, { bookingId: b.id, clientId });
  if (order.amount !== total || order.currency !== "INR") throw new AppError(502, "PAYMENT_ERROR", "Payment setup failed. Please try again.");

  await prisma.$transaction(async (tx) => {
    for (const i of priced) await tx.campaignBookingItem.update({ where: { id: i.id }, data: { pricePaise: i.pricePaise, audioAddonPaise: i.audioAddonPaise } });
    await tx.campaignPayment.create({ data: { bookingId: b.id, razorpayOrderId: order.id, amountPaise: total } });
    const snapshot = {
      campaignType: b.campaignType,
      audioIntegration: b.audioIntegration,
      audioTrack: b.audioTrack,
      items: priced.map((i) => ({
        itemId: i.id,
        rateCardId: i.rateCardId,
        platform: i.platform,
        format: i.format,
        accountName: i.accountName,
        basePaise: i.basePaise,
        audioAddonPaise: i.audioAddonPaise,
        pricePaise: i.pricePaise,
      })),
    };
    if (b.status === "draft") {
      await transitionBooking(b.id, ["draft"], "awaiting_payment", { type: "client", id: clientId }, {
        tx,
        data: { totalPaise: total, pricingSnapshot: snapshot as unknown as Prisma.InputJsonValue },
      });
    } else {
      await tx.campaignBooking.update({ where: { id: b.id }, data: { totalPaise: total, pricingSnapshot: snapshot as unknown as Prisma.InputJsonValue } });
    }
  });

  return { orderId: order.id, amount: total, currency: "INR", keyId: razorpayConfig.keyId(), name: b.name };
}

/** Checkout success callback. Confirms the signature for the UI; the webhook does the real work. */
export async function verifyCheckout(clientId: string, bookingId: string, body: { orderId?: string; paymentId?: string; signature?: string }) {
  const pay = await prisma.campaignPayment.findFirst({
    where: { razorpayOrderId: String(body.orderId ?? ""), booking: { id: bookingId, clientId } },
    select: { id: true },
  });
  if (!pay) throw new AppError(404, "NOT_FOUND", "Payment not found");
  const ok = rzp.verifyCheckoutSignature(String(body.orderId), String(body.paymentId ?? ""), String(body.signature ?? ""));
  if (!ok) throw new AppError(400, "BAD_SIGNATURE", "We couldn't confirm this payment. If money was taken, it will be confirmed or refunded automatically.");
  const b = await prisma.campaignBooking.findUnique({ where: { id: bookingId }, select: { status: true } });
  return { verified: true, status: b?.status };
}

// ── Webhook ─────────────────────────────────────────────────────────────────────

type WebhookResult = { handled: boolean; duplicate?: boolean; note?: string };

export async function handleWebhook(rawBody: Buffer, signature: string | undefined, eventIdHeader: string | undefined): Promise<WebhookResult> {
  if (!rzp.verifyWebhookSignature(rawBody, signature)) throw new AppError(400, "BAD_SIGNATURE", "Invalid signature");
  let evt: any;
  try {
    evt = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw new AppError(400, "BAD_JSON", "Invalid body");
  }
  const event = String(evt?.event ?? "");
  // Razorpay sends x-razorpay-event-id; fall back to a hash of the body for older setups.
  const eventId = (eventIdHeader || "").slice(0, 100) || `sha:${crypto.createHash("sha256").update(rawBody).digest("hex").slice(0, 64)}`;

  try {
    await prisma.razorpayWebhookEvent.create({ data: { eventId, event: event.slice(0, 64) } });
  } catch (err: any) {
    if (err?.code === "P2002") {
      const prev = await prisma.razorpayWebhookEvent.findUnique({ where: { eventId }, select: { processedAt: true } });
      // A previous delivery that crashed half-way is re-processed; a finished one is a no-op.
      if (prev?.processedAt) return { handled: true, duplicate: true };
    } else throw err;
  }

  let result: WebhookResult = { handled: false };
  if (event === "payment.captured" || event === "order.paid") {
    const p = evt?.payload?.payment?.entity;
    if (p) result = await onCaptured(p, event);
  } else if (event === "payment.failed") {
    const p = evt?.payload?.payment?.entity;
    if (p?.order_id) {
      await prisma.campaignPayment.updateMany({ where: { razorpayOrderId: p.order_id, status: "created" }, data: { status: "failed", lastEvent: event } });
      result = { handled: true };
    }
  } else if (event === "refund.processed" || event === "refund.failed") {
    const r = evt?.payload?.refund?.entity;
    if (r) result = await onRefundEvent(r, event);
  }

  await prisma.razorpayWebhookEvent.update({ where: { eventId }, data: { processedAt: new Date() } });
  return result;
}

async function onCaptured(p: any, event: string): Promise<WebhookResult> {
  const pay = await prisma.campaignPayment.findUnique({ where: { razorpayOrderId: String(p.order_id ?? "") } });
  if (!pay) return { handled: false, note: "unknown order" };
  if (pay.status === "captured" || pay.status.startsWith("refund")) return { handled: true, duplicate: true };

  const amount = Number(p.amount);
  const currency = String(p.currency ?? "");
  const booking = await prisma.campaignBooking.findUnique({ where: { id: pay.bookingId }, select: { status: true, totalPaise: true } });

  await prisma.campaignPayment.update({
    where: { id: pay.id },
    data: { status: "captured", razorpayPaymentId: String(p.id), lastEvent: event },
  });

  const matches = amount === pay.amountPaise && currency === "INR" && booking?.totalPaise === pay.amountPaise;
  const payable = booking && ["awaiting_payment", "draft", "cancelled", "expired"].includes(booking.status);
  if (!matches || !payable) {
    // Paid an outdated order, or paid twice: money goes straight back.
    await refundPaymentRow(pay.id, amount, `stale:${pay.id}`, { type: "system" });
    await logBookingEvent(pay.bookingId, { type: "system" }, `Payment ${p.id} (${amount} paise) did not match the current booking and was refunded.`);
    return { handled: true, note: "refunded mismatch" };
  }

  await transitionBooking(pay.bookingId, ["awaiting_payment", "draft", "cancelled", "expired"], "paid_pending_review", { type: "system" }, {
    note: `Payment ${p.id} captured`,
    data: { paidAt: new Date(), submittedAt: new Date() },
  });
  void sendStatusEmail(pay.bookingId, "paid").catch((e) => console.error("[campaign] paid email failed", e));
  void notifyStaffPaid(pay.bookingId).catch((e) => console.error("[campaign] staff email failed", e));
  return { handled: true };
}

async function onRefundEvent(r: any, event: string): Promise<WebhookResult> {
  const pay = await prisma.campaignPayment.findFirst({ where: { razorpayPaymentId: String(r.payment_id ?? "") } });
  if (!pay) return { handled: false, note: "unknown payment" };
  if (event === "refund.processed") {
    await prisma.campaignPayment.update({ where: { id: pay.id }, data: { status: pay.refundedPaise >= pay.amountPaise ? "refunded" : pay.status, lastEvent: event } });
    await maybeMarkRefunded(pay.bookingId);
  } else {
    await prisma.campaignPayment.update({ where: { id: pay.id }, data: { status: "refund_failed", lastEvent: event } });
    await logBookingEvent(pay.bookingId, { type: "system" }, `Refund ${r.id} failed — retry it from the booking page.`);
  }
  return { handled: true };
}

async function maybeMarkRefunded(bookingId: string) {
  const b = await prisma.campaignBooking.findUnique({ where: { id: bookingId }, select: { status: true, payments: { select: { status: true } } } });
  if (b?.status === "rejected" && b.payments.every((p) => p.status !== "captured" && p.status !== "refund_pending" && p.status !== "refund_failed")) {
    await transitionBooking(bookingId, ["rejected"], "refunded", { type: "system" }).catch(() => undefined);
  }
}

// ── Refunds ─────────────────────────────────────────────────────────────────────

/**
 * Refund part or all of one captured payment. The DB row is updated FIRST (refundedPaise is
 * claimed atomically), so a double click or a retry can never refund twice; if Razorpay then
 * fails, the claim is rolled back.
 */
export async function refundPaymentRow(paymentId: string, amountPaise: number, receipt: string, actor: Actor) {
  const pay = await prisma.campaignPayment.findUnique({ where: { id: paymentId } });
  if (!pay?.razorpayPaymentId) throw new AppError(409, "NOT_CAPTURED", "There is no captured payment to refund.");
  const claim = await prisma.campaignPayment.updateMany({
    where: { id: paymentId, refundedPaise: pay.refundedPaise, amountPaise: { gte: pay.refundedPaise + amountPaise } },
    data: { refundedPaise: { increment: amountPaise }, status: "refund_pending" },
  });
  if (claim.count !== 1) throw new AppError(409, "REFUND_CONFLICT", "This refund is larger than what's left, or another refund is in progress.");
  try {
    const refund = await rzp.refundPayment(pay.razorpayPaymentId, amountPaise, receipt);
    const full = pay.refundedPaise + amountPaise >= pay.amountPaise;
    await prisma.campaignPayment.update({
      where: { id: paymentId },
      data: { refundId: refund.id, status: refund.status === "processed" ? (full ? "refunded" : "captured") : full ? "refund_pending" : "captured" },
    });
    await logBookingEvent(pay.bookingId, actor, `Refund of ${amountPaise} paise issued (${refund.id}, ${refund.status}).`);
    return refund;
  } catch (err) {
    await prisma.campaignPayment.update({
      where: { id: paymentId },
      data: { refundedPaise: { decrement: amountPaise }, status: pay.status === "refund_pending" ? "captured" : pay.status },
    });
    await logBookingEvent(pay.bookingId, actor, `Refund of ${amountPaise} paise FAILED: ${(err as Error).message}`.slice(0, 500));
    throw new AppError(502, "REFUND_FAILED", "The refund couldn't be issued. Try again, or refund from the Razorpay dashboard.");
  }
}

/** Refund everything still refundable on a booking (used by reject). */
export async function refundBookingInFull(bookingId: string, actor: Actor) {
  const pays = await prisma.campaignPayment.findMany({ where: { bookingId, razorpayPaymentId: { not: null } } });
  for (const p of pays) {
    const left = p.amountPaise - p.refundedPaise;
    if (left > 0 && (p.status === "captured" || p.status === "refund_failed")) {
      await refundPaymentRow(p.id, left, `rej:${bookingId.slice(0, 30)}`, actor);
    }
  }
  await maybeMarkRefunded(bookingId);
}

/** The booking's captured payment that can still cover `amount`. */
export async function capturedPaymentFor(bookingId: string, amount: number) {
  const pays = await prisma.campaignPayment.findMany({ where: { bookingId, razorpayPaymentId: { not: null }, status: { in: ["captured", "refund_failed"] } } });
  return pays.find((p) => p.amountPaise - p.refundedPaise >= amount) ?? null;
}
