import crypto from "crypto";
import { prisma, Prisma, type CampaignPayment, type CampaignRefund } from "@dashmani/db";
import { formatPaise } from "@dashmani/shared";
import { AppError } from "../../middleware/error-handler";
import { notifyAdminByEmail } from "../email.service";
import { scrubPayoutSecrets } from "../../utils/payout-scrub";
import { razorpayConfig } from "./config";
import * as rzp from "./razorpay";
import { assertCreativeReady, transitionBooking, logBookingEvent, type Actor } from "./booking.service";
import { notifyStaffPaid, sendStatusEmail } from "./delivery.service";
import { priceFor } from "./rate-card.service";
import { handleRouteEvent, isRouteEvent } from "./route-webhooks";
import { pausePayoutsOfPayment } from "../creator/payout-pause";

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
//  • A capture is CLAIMED first and the booking moved in the same transaction (see onCaptured);
//    refunds are CLAIMED first on a ledger (campaign_refunds) and sent with an idempotency key
//    (see claimRefund / sendRefund). Razorpay is only called after the claim has committed.
//  • A refund key is ONE amount. What a `refund_due` payment still owes is refunded under
//    `rf-stale-<id>`, and when it is owed AGAIN (another refund failed after the first was issued)
//    under `rf-stale-<id>-g2`, `-g3` … (see staleRefundNext); `-r<N>` marks the retries of one of them.
//  • LOCK ORDER: a transaction that touches both locks the campaign_payments row FIRST and the
//    campaign_refunds rows after (reconcileRefunds, releaseRefundClaim and recordRefund all do).
//    Any new code that takes them in the other order can deadlock with a reconcile.

/** Pure: the booking total from its items. */
export function computeTotal(items: Array<{ pricePaise: number }>): number {
  return items.reduce((s, i) => s + i.pricePaise, 0);
}

/**
 * Checkout. In "razorpay" mode it creates the order and the booking waits for the webhook. In
 * "offline" mode (no gateway configured — the state while Razorpay is deferred) the SAME
 * re-pricing and price freeze happen, and the booking goes straight to review
 * (`paid_pending_review`) with no payment row and no `paidAt`; the amount is collected by hand.
 */
export async function checkout(clientId: string, bookingId: string) {
  const mode = razorpayConfig.paymentMode();
  const b = await prisma.campaignBooking.findFirst({
    where: { id: bookingId, clientId },
    select: { id: true, status: true, name: true, launchFrom: true, format: true, campaignType: true, audioIntegration: true, audioTrack: true, items: { select: { id: true, rateCardId: true, pricePaise: true, platform: true, format: true, accountName: true } } },
  });
  if (!b) throw new AppError(404, "NOT_FOUND", "Campaign not found");
  if (!["draft", "awaiting_payment"].includes(b.status)) {
    // Never "paid": an offline booking was submitted, not paid, and a double submit lands here.
    throw new AppError(
      409,
      "INVALID_STATE",
      ["cancelled", "expired"].includes(b.status) ? "This campaign is closed — start a new one any time." : "This campaign has already been submitted.",
    );
  }
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

  if (mode === "offline") {
    await prisma.$transaction(async (tx) => {
      for (const i of priced) await tx.campaignBookingItem.update({ where: { id: i.id }, data: { pricePaise: i.pricePaise, audioAddonPaise: i.audioAddonPaise } });
      // No payment row and no paidAt: the webhook is the only writer of paidAt, and every
      // "was this paid online?" decision (refunds, email wording) keys on it.
      await transitionBooking(b.id, ["draft", "awaiting_payment"], "paid_pending_review", { type: "client", id: clientId }, {
        tx,
        note: `Submitted for review without online payment (offline mode) — ${total} paise to be collected by hand`,
        data: { totalPaise: total, pricingSnapshot: snapshot as unknown as Prisma.InputJsonValue, submittedAt: new Date() },
      });
    });
    void sendStatusEmail(b.id, "paid").catch((e) => console.error("[campaign] submitted email failed", e));
    void notifyStaffPaid(b.id).catch((e) => console.error("[campaign] staff email failed", e));
    return { offline: true as const, amount: total, currency: "INR", name: b.name, status: "paid_pending_review" };
  }

  const order = await rzp.createOrder(total, `cb_${b.id.slice(0, 30)}`, { bookingId: b.id, clientId });
  if (order.amount !== total || order.currency !== "INR") throw new AppError(502, "PAYMENT_ERROR", "Payment setup failed. Please try again.");

  await prisma.$transaction(async (tx) => {
    for (const i of priced) await tx.campaignBookingItem.update({ where: { id: i.id }, data: { pricePaise: i.pricePaise, audioAddonPaise: i.audioAddonPaise } });
    await tx.campaignPayment.create({ data: { bookingId: b.id, razorpayOrderId: order.id, amountPaise: total } });
    if (b.status === "draft") {
      await transitionBooking(b.id, ["draft"], "awaiting_payment", { type: "client", id: clientId }, {
        tx,
        data: { totalPaise: total, pricingSnapshot: snapshot as unknown as Prisma.InputJsonValue },
      });
    } else {
      await tx.campaignBooking.update({ where: { id: b.id }, data: { totalPaise: total, pricingSnapshot: snapshot as unknown as Prisma.InputJsonValue } });
    }
  });

  return { offline: false as const, orderId: order.id, amount: total, currency: "INR", keyId: razorpayConfig.keyId(), name: b.name };
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
/** What the Route handler reports. `retry` = "an infrastructure error lost this event: ask Razorpay to redeliver it". */
type RouteResult = { handled: boolean; note?: string; retry?: boolean };

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
  } else if (event === "refund.created" || event === "refund.processed" || event === "refund.failed") {
    // ⚠️ refund.created is subscribed too, and for a reason: a refund staff make from the Razorpay
    // DASHBOARD can sit `pending` for days before refund.processed arrives, and until it is on our
    // ledger the sweep's item-refund retry cannot tell the brand has already been repaid (see
    // resendFailedItemRefunds). Created, processed and failed all do the same thing: re-read the
    // payment's refund list (onRefundEvent), never trust the single event.
    const r = evt?.payload?.refund?.entity;
    if (r) result = await onRefundEvent(r, event);
  } else {
    // Route (transfers, settlements, linked accounts) and dispute events. ⚠️ Whatever happens in
    // there, THIS endpoint still answers 2xx: Razorpay disables a webhook that keeps failing for
    // 24 hours, and this same URL is what marks brand payments paid. Only the event NAME is
    // logged, never the body (it can carry bank details).
    // The ONE exception is `retry`: the handler sets it when an infrastructure error (a pool
    // timeout, a deadlock) lost an event that nothing else re-reads (a dispute: it is only ever
    // learned from this webhook). Then the event is NOT stamped processed and the answer is a
    // retryable 5xx; the redelivery finds the unstamped row and processes it again. A brief outage
    // cannot get the webhook disabled, and an event that can never be understood is not retried.
    let retryRoute = false;
    try {
      if (isRouteEvent(event)) {
        const { retry, ...rest }: RouteResult = await handleRouteEvent(event, evt, eventId);
        result = rest;
        retryRoute = retry === true;
      }
    } catch (err) {
      console.error(`[razorpay-webhook] route event ${event.slice(0, 64)} failed (${(err as Error)?.name ?? "Error"})`);
      result = { handled: false, note: "route handler error" };
    }
    if (retryRoute) throw new AppError(503, "TEMPORARY", "This event could not be processed right now; please redeliver it.");
  }

  await prisma.razorpayWebhookEvent.update({ where: { eventId }, data: { processedAt: new Date() } });
  return result;
}

// ── Capture ─────────────────────────────────────────────────────────────────────

type Tx = Prisma.TransactionClient;
type CaptureOutcome = { kind: "unknown" } | { kind: "duplicate" } | { kind: "paid"; bookingId: string } | { kind: "refund_due"; paymentId: string };

const PAYABLE_BOOKING_STATUSES = ["awaiting_payment", "draft", "cancelled", "expired"] as const;

/**
 * payment.captured and order.paid both land here, and Razorpay redelivers on any non-2xx, so the
 * same capture arrives two or three times, sometimes concurrently.
 *
 * ⚠️ ONE transaction, and the payment row is CLAIMED FIRST. The claim is a conditional update
 * (`status IN ('created','failed')` → captured): exactly one delivery changes a row, every other
 * one changes none and returns as a duplicate. Only the winner's payment id is ever used, so
 * `payment.captured` + `order.paid` can never both move the booking or both refund it. Before
 * this, the payment was read, then marked captured, then the booking was moved in a separate
 * step: a crash between the two left a captured payment on a booking that never reached review,
 * and the redelivery was then dismissed as a duplicate.
 *
 * Everything that talks to Razorpay or sends an email happens AFTER the commit. If anything
 * throws before it, the claim rolls back with the rest and Razorpay's retry runs cleanly.
 */
async function onCaptured(p: any, event: string): Promise<WebhookResult> {
  const orderId = String(p?.order_id ?? "");
  const razorpayPaymentId = String(p?.id ?? "");
  if (!orderId || !razorpayPaymentId || razorpayPaymentId.length > 64) return { handled: false, note: "unreadable payment" };
  const reportedAmount = Number(p.amount);
  const currency = String(p.currency ?? "");

  const outcome = await prisma.$transaction(async (tx): Promise<CaptureOutcome> => {
    const claim = await tx.campaignPayment.updateMany({
      where: { razorpayOrderId: orderId, status: { in: ["created", "failed"] } },
      data: { status: "captured", razorpayPaymentId, lastEvent: event },
    });
    if (claim.count === 0) {
      const known = await tx.campaignPayment.findUnique({ where: { razorpayOrderId: orderId }, select: { id: true } });
      return known ? { kind: "duplicate" } : { kind: "unknown" };
    }
    const pay = await tx.campaignPayment.findUniqueOrThrow({ where: { razorpayOrderId: orderId } });
    // The booking row is locked for the comparison and the move, so a client edit or a staff
    // action cannot slip in between "it matches" and "it is paid".
    await tx.$queryRaw`SELECT id FROM campaign_bookings WHERE id = ${pay.bookingId} FOR UPDATE`;
    const booking = await tx.campaignBooking.findUnique({ where: { id: pay.bookingId }, select: { status: true, totalPaise: true } });

    const matches = reportedAmount === pay.amountPaise && currency === "INR" && booking?.totalPaise === pay.amountPaise;
    const payable = !!booking && (PAYABLE_BOOKING_STATUSES as readonly string[]).includes(booking.status);
    if (matches && payable) {
      await transitionBooking(pay.bookingId, PAYABLE_BOOKING_STATUSES, "paid_pending_review", { type: "system" }, {
        tx,
        note: `Payment ${razorpayPaymentId} captured`,
        data: { paidAt: new Date(), submittedAt: new Date() },
      });
      // Phase 4 (creator pages): insert one `planned` creator_payouts row per creator item HERE, in
      // this same transaction, carrying `razorpayPaymentId` — the capture that won the claim above.
      return { kind: "paid", bookingId: pay.bookingId };
    }

    // Paid an outdated order, or paid twice: the money is ours to return. It is recorded as
    // refund_due INSIDE the transaction, so it can never be forgotten; the refund itself is made
    // after the commit and, if that is interrupted, by the sweep. What Razorpay actually captured
    // is what comes back, so a differing amount replaces the order amount on this dead row.
    const captured = Number.isSafeInteger(reportedAmount) && reportedAmount > 0 ? reportedAmount : pay.amountPaise;
    await tx.campaignPayment.update({ where: { id: pay.id }, data: { status: "refund_due", amountPaise: captured } });
    await logBookingEvent(
      pay.bookingId,
      { type: "system" },
      `Payment ${razorpayPaymentId} (${captured} paise) did not match the current booking and is being refunded.`,
      tx,
    );
    return { kind: "refund_due", paymentId: pay.id };
  });

  if (outcome.kind === "unknown") return { handled: false, note: "unknown order" };
  if (outcome.kind === "duplicate") return { handled: true, duplicate: true };
  if (outcome.kind === "paid") {
    void sendStatusEmail(outcome.bookingId, "paid").catch((e) => console.error("[campaign] paid email failed", e));
    void notifyStaffPaid(outcome.bookingId).catch((e) => console.error("[campaign] staff email failed", e));
    return { handled: true };
  }

  // refund_due: committed, now give the money back. A failure here must not fail the webhook (the
  // claim above is final and a redelivery would only be told "duplicate"): the sweep retries it.
  // Razorpay gives a webhook 5 seconds [R28] and one that keeps timing out gets disabled, so a slow
  // refund call is left to finish in the background (it is claimed and keyed, so it cannot be repeated).
  try {
    const refunding = issueDueRefund(outcome.paymentId, { type: "system" });
    const first = await withinDeadline(refunding, refundTuning.inlineDeadlineMs);
    if (!first.done) return { handled: true, note: "refund in progress" };
    return { handled: true, note: first.value?.state === "confirming" ? "refund confirming" : "refunded mismatch" };
  } catch (err) {
    console.error(`[campaign] refund of an unmatched payment will be retried: ${(err as Error)?.message ?? "error"}`);
    return { handled: true, note: "refund will be retried" };
  }
}

/** Tests shorten this; production keeps the webhook comfortably inside Razorpay's 5 seconds. */
export const refundTuning = { inlineDeadlineMs: 3_000 };

/** Resolves with the result, or `{done:false}` once `ms` have passed (the work keeps running). A rejection before then propagates. */
async function withinDeadline<T>(work: Promise<T>, ms: number): Promise<{ done: true; value: T } | { done: false }> {
  let timer: NodeJS.Timeout | undefined;
  const slow = new Promise<{ done: false }>((resolve) => {
    timer = setTimeout(() => resolve({ done: false }), ms);
  });
  try {
    return await Promise.race([work.then((value) => ({ done: true as const, value })), slow]);
  } finally {
    clearTimeout(timer);
  }
}

// ── Refunds ─────────────────────────────────────────────────────────────────────

/** Payment statuses in which the payment still holds money that may be returned. */
const REFUNDABLE_STATUSES = ["captured", "refund_pending", "refund_failed", "refund_due"] as const;
/** The ones an ITEM refund may draw on: refund_due money is owed in full, never spent on an item. */
const ITEM_REFUNDABLE_STATUSES = ["captured", "refund_pending", "refund_failed"] as const;
/** Marker on a payment whose refund list could not be read when a refund event arrived: the sweep re-reads it. */
const RECONCILE_MARKER = "refund.reconcile_pending";

/** The copy staff see when Razorpay definitely refused a refund: nothing moved, nothing was lost. */
const REFUND_REFUSED = "Razorpay refused the refund, so no money moved. The reason is in the booking history; try again in a few minutes.";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Staff alert. Provider text is escaped (notifyAdminByEmail does not), and it never blocks or throws. */
function alertStaff(subject: string, details: Array<{ label: string; value: string }>, path?: string) {
  void notifyAdminByEmail(subject, details.map((d) => ({ label: esc(d.label), value: esc(d.value) })), path).catch((e) =>
    console.error("[campaign] staff alert failed", e),
  );
}

const errorText = (err: unknown) => scrubPayoutSecrets(err instanceof Error ? err.message : String(err)).slice(0, 500);

/** A deadlock or write conflict: Postgres killed THIS transaction so another could go on. It rolled back whole. */
export function isContention(err: any): boolean {
  const pg = err?.meta?.code ?? err?.code;
  return err?.code === "P2034" || pg === "40P01" || pg === "40001" || /deadlock detected/i.test(String(err?.message ?? ""));
}

/** Run a transaction again ONCE if it lost to contention. Only for work that is safe to repeat from the start (every use below is conditional or idempotent). */
export async function retryOnContention<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (!isContention(err)) throw err;
    return work();
  }
}

/**
 * What is still refundable on a captured payment: captured − refunded − reserved. THE one place
 * that rule lives; refundPaymentRow, capturedPaymentFor, reject and the sweep all go through it.
 * `reserved` is money earmarked for a creator's share (see reservedOn); it is 0 until Phase 4.
 */
export function refundableOn(pay: { amountPaise: number; refundedPaise: number }, reservedPaise = 0): number {
  return Math.max(0, pay.amountPaise - pay.refundedPaise - reservedPaise);
}

/**
 * Phase 4 fills this in: the item price of every creator item on this payment whose payout is not
 * yet `reversed` or `void`. Such money has left our balance for the creator's linked account and
 * comes back only after the transfer is reversed, so it must not be refunded to the brand first.
 */
async function reservedOn(_db: Tx | typeof prisma, _paymentId: string): Promise<number> {
  return 0;
}

export interface RefundIntent {
  /** campaign_payments.id */
  paymentId: string;
  amountPaise: number;
  /** Goes to Razorpay as the receipt (cut to 40 characters). */
  receipt: string;
  /**
   * STABLE per intent ("rf-item-<itemId>", "rf-stale-<paymentId>", "rf-rej-<bookingId>-<paymentId>"):
   * 10 to 128 of [A-Za-z0-9_-] [R30]. The same key on a retry makes Razorpay return the original
   * refund instead of creating a second one. After a DEFINITE refusal the intent may be tried
   * again; that attempt gets "-r2", "-r3" … because nothing was refunded under the first key.
   * One key is ONE amount: a payment that is owed again after part of it was refunded (see
   * staleRefundNext) is a NEW intent and gets its own key, never the first one's.
   */
  key: string;
  /** Why, for the ledger: item_refunded | booking_rejected | outdated_order | duplicate_payment … (at most 60). */
  reason: string;
  itemId?: string | null;
}

export interface RefundResult {
  /** processed / pending: Razorpay answered. confirming: we asked and have not heard — the claim is kept and the sweep settles it. */
  state: "processed" | "pending" | "confirming";
  refundId: string | null;
  ledgerId: string;
  amountPaise: number;
  /** True when nothing was claimed or sent: this intent already had a live row and that row is what `state` describes. */
  existing?: boolean;
}

type RefundRow = CampaignRefund;
type Claim = { kind: "claimed"; row: RefundRow } | { kind: "existing"; row: RefundRow };

/**
 * Is this ledger key an attempt of THIS intent: the key itself, or the key plus `-r<digits>`? It is
 * deliberately ONE intent (one amount) wide. The generations of a stale refund (`…-g2`) are other
 * intents; the sweep reads them together through staleGenerationOf.
 */
const isAttemptOf = (rowKey: string | null, key: string) =>
  rowKey !== null && (rowKey === key || (rowKey.startsWith(`${key}-r`) && /^\d+$/.test(rowKey.slice(key.length + 2))));

const toResult = (row: RefundRow, refundId: string | null = row.razorpayRefundId): RefundResult => ({
  state: row.status === "processed" ? "processed" : row.status === "pending" ? "pending" : "confirming",
  refundId,
  ledgerId: row.id,
  amountPaise: row.amountPaise,
});

/**
 * Claim a refund durably BEFORE calling Razorpay: one transaction inserts the ledger row
 * (`campaign_refunds`, status requested, idempotency key UNIQUE) and increments refundedPaise under
 * a conditional update. A double click, a retry or a second worker finds the row and does not claim
 * again; a loser of the race hits the unique key and re-reads it.
 */
async function claimRefund(intent: RefundIntent, retried = false): Promise<Claim> {
  if (!Number.isSafeInteger(intent.amountPaise) || intent.amountPaise <= 0) throw new AppError(400, "INVALID_AMOUNT", "The refund amount must be a positive number of paise.");
  try {
    return await prisma.$transaction(async (tx): Promise<Claim> => {
      const pay = await tx.campaignPayment.findUnique({ where: { id: intent.paymentId } });
      if (!pay?.razorpayPaymentId) throw new AppError(409, "NOT_CAPTURED", "There is no captured payment to refund.");

      const prior = (await tx.campaignRefund.findMany({ where: { idempotencyKey: { startsWith: intent.key } }, orderBy: { createdAt: "asc" } })).filter((r) =>
        isAttemptOf(r.idempotencyKey, intent.key),
      );
      const live = prior.find((r) => r.status !== "failed");
      if (live) {
        // The same intent again: whatever it is doing, it is not claimed a second time.
        if (live.amountPaise !== intent.amountPaise) throw new AppError(409, "REFUND_CONFLICT", "A different refund for this is already in progress.");
        return { kind: "existing", row: live };
      }
      // Only after the existing-intent check: an intent that already finished stays answerable once the payment is fully refunded.
      if (!(REFUNDABLE_STATUSES as readonly string[]).includes(pay.status)) throw new AppError(409, "NOT_CAPTURED", "There is no captured payment to refund.");

      if (refundableOn(pay, await reservedOn(tx, pay.id)) < intent.amountPaise) {
        throw new AppError(409, "REFUND_CONFLICT", "This refund is larger than what's left, or another refund is in progress.");
      }
      const key = prior.length === 0 ? intent.key : `${intent.key}-r${prior.length + 1}`;
      const row = await tx.campaignRefund.create({
        data: {
          idempotencyKey: key,
          paymentId: pay.id,
          razorpayPaymentId: pay.razorpayPaymentId,
          bookingId: pay.bookingId,
          bookingItemId: intent.itemId ?? null,
          amountPaise: intent.amountPaise,
          receipt: intent.receipt.slice(0, 40),
          status: "requested",
          origin: "ours",
          reason: intent.reason.slice(0, 60),
        },
      });
      const claim = await tx.campaignPayment.updateMany({
        where: { id: pay.id, refundedPaise: pay.refundedPaise, status: { in: [...REFUNDABLE_STATUSES] } },
        // A payment that is owed in full stays refund_due while the refund is in flight, so the sweep keeps owning it.
        data: { refundedPaise: { increment: intent.amountPaise }, status: pay.status === "refund_due" ? "refund_due" : "refund_pending" },
      });
      if (claim.count !== 1) throw new AppError(409, "REFUND_CONFLICT", "This refund is larger than what's left, or another refund is in progress.");
      return { kind: "claimed", row };
    });
  } catch (err: any) {
    // Two callers with the same intent computed the same key; the loser re-reads the winner's row.
    if (err?.code === "P2002" && !retried) return claimRefund(intent, true);
    throw err;
  }
}

/**
 * Derive a payment's status from its ledger instead of trusting whoever wrote last:
 *   everything refunded and nothing in flight → refunded; anything in flight → refund_pending;
 *   otherwise it goes back to captured. `refund_due` (owed in full) only ends by being refunded, and
 *   `refund_failed` stays until a later refund replaces it.
 */
async function resyncPaymentStatus(tx: Tx, paymentId: string, opts: { failed?: boolean } = {}) {
  const pay = await tx.campaignPayment.findUnique({ where: { id: paymentId }, select: { status: true, amountPaise: true, refundedPaise: true } });
  if (!pay || !((REFUNDABLE_STATUSES as readonly string[]).includes(pay.status) || pay.status === "refunded")) return;
  const inflight = (await tx.campaignRefund.count({ where: { paymentId, status: { in: ["requested", "pending"] } } })) > 0;
  const full = pay.refundedPaise >= pay.amountPaise;
  let next: string;
  if (full) next = inflight ? (pay.status === "refund_due" ? "refund_due" : "refund_pending") : "refunded";
  else if (pay.status === "refund_due") next = "refund_due";
  else if (inflight) next = "refund_pending";
  else if (opts.failed || pay.status === "refunded") next = "refund_failed";
  else next = pay.status === "refund_pending" ? "captured" : pay.status;
  if (next !== pay.status) await tx.campaignPayment.update({ where: { id: paymentId }, data: { status: next } });
}

/**
 * Give back a claim after Razorpay DEFINITELY refused (nothing was refunded). The ledger row is
 * kept as `failed` for the audit trail; a later attempt of the same intent gets a fresh key.
 */
async function releaseRefundClaim(row: RefundRow, reason: string, actor: Actor, refundId?: string) {
  await retryOnContention(() =>
    prisma.$transaction(async (tx) => {
      // ⚠️ LOCK ORDER: the payment row FIRST, then the refund row: the order reconcileRefunds (and
      // recordRefund) take them in. The other way round, a release and a reconcile of the same
      // payment can each hold what the other waits for, and Postgres kills one of them.
      if (row.paymentId) await tx.$queryRaw`SELECT id FROM campaign_payments WHERE id = ${row.paymentId} FOR UPDATE`;
      const flipped = await tx.campaignRefund.updateMany({
        where: { id: row.id, status: { in: ["requested", "pending"] } },
        data: { status: "failed", lastError: reason.slice(0, 500), lastCheckedAt: new Date(), ...(refundId ? { razorpayRefundId: refundId } : {}) },
      });
      if (flipped.count === 1 && row.paymentId) {
        await tx.campaignPayment.update({ where: { id: row.paymentId }, data: { refundedPaise: { decrement: row.amountPaise } } });
        await resyncPaymentStatus(tx, row.paymentId);
      }
      if (row.bookingId) await logBookingEvent(row.bookingId, actor, `Refund of ${row.amountPaise} paise FAILED: ${reason}`.slice(0, 500), tx);
    }),
  );
}

/**
 * releaseRefundClaim after Razorpay DEFINITELY refused. If giving the claim back fails (a pool
 * timeout, a second lost deadlock), that is logged and swallowed: the caller must still report
 * the refusal (a raw database error would replace it), and the row stays `requested`, which the
 * sweep reconciles and re-sends under the same key.
 */
async function releaseAfterRefusal(row: RefundRow, reason: string, actor: Actor, refundId?: string) {
  try {
    await releaseRefundClaim(row, reason, actor, refundId);
  } catch (err) {
    console.error(`[campaign] refund ${row.id} was refused by Razorpay but its claim could not be released yet (the sweep settles it): ${errorText(err)}`);
  }
}

/** Razorpay did not answer (timeout, 5xx, 409, unreadable body): the claim STAYS, and nobody is told it failed. */
async function keepRefundClaim(row: RefundRow, err: unknown, actor: Actor): Promise<RefundResult> {
  await prisma.campaignRefund.update({ where: { id: row.id }, data: { lastError: errorText(err) } }).catch(() => undefined);
  if (row.bookingId) await logBookingEvent(row.bookingId, actor, `Refund of ${row.amountPaise} paise requested — confirming with Razorpay.`).catch(() => undefined);
  return { state: "confirming", refundId: null, ledgerId: row.id, amountPaise: row.amountPaise };
}

/** Razorpay answered: record the refund id and status on the ledger row and move the payment on. */
async function recordRefund(row: RefundRow, refund: rzp.RazorpayRefund, actor: Actor): Promise<RefundResult> {
  const processed = refund.status === "processed";
  await prisma.$transaction(async (tx) => {
    // Payment row first, as everywhere (see releaseRefundClaim).
    if (row.paymentId) await tx.$queryRaw`SELECT id FROM campaign_payments WHERE id = ${row.paymentId} FOR UPDATE`;
    // A webhook (reconcile) may have seen this refund before our own answer arrived and, unable to
    // tie it to this row, filed it as external: fold the two into one.
    const holder = await tx.campaignRefund.findUnique({ where: { razorpayRefundId: refund.id } });
    if (holder && holder.id !== row.id && holder.origin === "external") await tx.campaignRefund.delete({ where: { id: holder.id } });
    await tx.campaignRefund.update({
      where: { id: row.id },
      data: { razorpayRefundId: refund.id, status: processed ? "processed" : "pending", processedAt: processed ? new Date() : null, lastCheckedAt: new Date(), lastError: null },
    });
    if (row.paymentId) {
      await tx.campaignPayment.update({ where: { id: row.paymentId }, data: { refundId: refund.id } });
      await resyncPaymentStatus(tx, row.paymentId);
    }
    if (row.bookingId) await logBookingEvent(row.bookingId, actor, `Refund of ${row.amountPaise} paise issued (${refund.id}, ${refund.status}).`, tx);
  });
  if (row.bookingId) await maybeMarkRefunded(row.bookingId);
  return { state: processed ? "processed" : "pending", refundId: refund.id, ledgerId: row.id, amountPaise: row.amountPaise };
}

/**
 * Call Razorpay for a claimed ledger row. ⚠️ Three outcomes, never two:
 *   • answered      → recorded (processed / pending);
 *   • DEFINITELY refused (a 4xx, nothing sent) → the claim is released and the caller gets a 502;
 *   • anything else (timeout, 5xx, 409, unreadable 2xx) → the claim is KEPT and `confirming` is
 *     returned. Rolling back here would let the same money be refunded again while the first
 *     request may still land; the key makes a re-send safe, and reconcileRefunds settles it.
 */
async function sendRefund(row: RefundRow, actor: Actor): Promise<RefundResult> {
  let refund: rzp.RazorpayRefund;
  try {
    refund = await rzp.refundPayment(row.razorpayPaymentId, row.amountPaise, row.receipt ?? "", row.idempotencyKey ?? undefined);
  } catch (err) {
    if (rzp.isDefinitelyRejected(err)) {
      await releaseAfterRefusal(row, errorText(err), actor);
      throw new AppError(502, "REFUND_FAILED", REFUND_REFUSED);
    }
    return keepRefundClaim(row, err, actor);
  }
  if (refund.status === "failed") {
    await releaseAfterRefusal(row, "Razorpay reported the refund as failed.", actor, refund.id);
    throw new AppError(502, "REFUND_FAILED", REFUND_REFUSED);
  }
  try {
    return await recordRefund(row, refund, actor);
  } catch (err) {
    // The refund exists at Razorpay and only our bookkeeping failed: leave the claim and let reconcile link it.
    console.error(`[campaign] refund ${refund.id} issued but not recorded: ${errorText(err)}`);
    return { state: "confirming", refundId: refund.id, ledgerId: row.id, amountPaise: row.amountPaise };
  }
}

/**
 * Refund part or all of one captured payment: claim durably (see claimRefund), call Razorpay with
 * the intent's idempotency key, record the answer. A retry of the same intent finds its row and
 * never refunds twice. See sendRefund for the three outcomes.
 */
export async function refundPaymentRow(paymentId: string, amountPaise: number, receipt: string, actor: Actor, opts: { key: string; reason: string; itemId?: string | null }): Promise<RefundResult> {
  const claim = await claimRefund({ paymentId, amountPaise, receipt, key: opts.key, reason: opts.reason, itemId: opts.itemId });
  if (claim.kind === "existing") return { ...toResult(claim.row), existing: true };
  return sendRefund(claim.row, actor);
}

// ── The refund of what a payment still owes (`refund_due`) ──────────────────────

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Which generation of ONE payment's stale refund a ledger key belongs to, or null when it is not
 * one of that payment's. `rf-stale-<id>` is generation 1, `rf-stale-<id>-g<N>` generation N, and
 * either may carry `-r<M>` (the M-th attempt of that generation after a refusal). Anchored at both
 * ends, with the payment id escaped, so no other key (another payment's, a longer suffix) matches.
 */
export function staleGenerationOf(paymentId: string, key: string | null): number | null {
  if (key === null) return null;
  const m = new RegExp(`^rf-stale-${escapeRegExp(paymentId)}(?:-g([1-9]\\d*))?(?:-r([1-9]\\d*))?$`).exec(key);
  return m ? (m[1] ? Number(m[1]) : 1) : null;
}

/**
 * What the next stale refund of a payment is, from its ledger.
 *
 * ⚠️ A key is ONE amount, and a payment can be owed MORE THAN ONCE: a rejected booking whose item
 * refunds fail one after the other is owed 4,000 first (and that is refunded under `rf-stale-<id>`),
 * then 6,000 when the second item's refund fails at Razorpay. Under a single key the second
 * remainder collided with the first row (a conflict nobody was told about, or, when the two
 * amounts were equal, an "existing" answer that sent nothing). So a remainder is a GENERATION:
 * the next one is numbered after the newest generation that has a live (not failed) row, and keeps
 * that number while its own attempts are refused (claimRefund adds `-r<M>` for those). Retrying the
 * same remainder therefore stays idempotent; a different remainder is a different refund.
 * `attempts` are the FAILED rows of the generation about to be tried, newest first: the backoff
 * and the "keeps failing" alert count those, never the failures of an earlier remainder.
 */
async function staleRefundNext(paymentId: string) {
  const base = `rf-stale-${paymentId}`;
  const rows = (await prisma.campaignRefund.findMany({
    where: { idempotencyKey: { startsWith: base } },
    select: { idempotencyKey: true, status: true, updatedAt: true },
  })).flatMap((r) => {
    const generation = staleGenerationOf(paymentId, r.idempotencyKey);
    return generation === null ? [] : [{ generation, status: r.status, updatedAt: r.updatedAt }];
  });
  const live = rows.filter((r) => r.status !== "failed");
  const generation = live.reduce((n, r) => Math.max(n, r.generation), 0) + 1;
  const attempts = rows.filter((r) => r.generation === generation && r.status === "failed").sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  return { key: generation === 1 ? base : `${base}-g${generation}`, generation, live: live.length, attempts };
}

/**
 * Return what a payment that is `refund_due` still owes. Used right after the capture commit and by
 * the sweep. Returns null when there is nothing (left) to return; a result with `existing` set
 * means the answer is a row that was already there, and the remainder is STILL owed (see staleRefundNext).
 */
async function issueDueRefund(paymentId: string, actor: Actor): Promise<RefundResult | null> {
  const pay = await prisma.campaignPayment.findUnique({ where: { id: paymentId }, include: { booking: { select: { status: true } } } });
  if (!pay?.razorpayPaymentId || pay.status !== "refund_due") return null;
  const reserved = await reservedOn(prisma, pay.id);
  const amount = refundableOn(pay, reserved);
  if (amount <= 0) return null;
  const next = await staleRefundNext(pay.id);
  if (next.live > 0) {
    // A refund of this family is live and the payment is owed again. That is only believable when
    // the LEDGER says there is room for it: the counter on the payment can be wrong (a lost update,
    // a hand edit), and refunding on a wrong counter is how the same money goes back twice.
    const held = await prisma.campaignRefund.aggregate({ _sum: { amountPaise: true }, where: { paymentId: pay.id, status: { not: "failed" } } });
    if ((held._sum.amountPaise ?? 0) + amount > pay.amountPaise) {
      throw new AppError(409, "REFUND_LEDGER_MISMATCH", "The refunds on the ledger and the payment's refunded total disagree, so this payment is not refunded again until they do.");
    }
  }
  // ⚠️ The key depends on the payment and its remainder generation only, never on the booking's state: that can change between attempts.
  const result = await refundPaymentRow(pay.id, amount, `stale:${pay.id}`, actor, {
    key: next.key,
    reason: (PAYABLE_BOOKING_STATUSES as readonly string[]).includes(pay.booking.status) ? "outdated_order" : pay.booking.status === "rejected" ? "booking_rejected" : "duplicate_payment",
  });
  if (result.existing) {
    // Someone claimed this very refund between the read above and the claim: if that settled the
    // payment there is nothing to do. If money is STILL owed, nothing was sent for it: say so.
    const again = await prisma.campaignPayment.findUnique({ where: { id: pay.id } });
    if (!again || again.status !== "refund_due" || refundableOn(again, reserved) <= 0) return null;
  }
  return result;
}

/** Refund everything still refundable on a booking's online payments (offline bookings have none). */
export async function refundBookingInFull(bookingId: string, actor: Actor) {
  const pays = await prisma.campaignPayment.findMany({ where: { bookingId, razorpayPaymentId: { not: null } } });
  const results: RefundResult[] = [];
  for (const p of pays) {
    const left = refundableOn(p, await reservedOn(prisma, p.id));
    if (left > 0 && (ITEM_REFUNDABLE_STATUSES as readonly string[]).includes(p.status)) {
      results.push(await refundPaymentRow(p.id, left, `rej:${bookingId.slice(0, 30)}`, actor, { key: `rf-rej-${bookingId}-${p.id}`, reason: "booking_rejected" }));
    }
  }
  await maybeMarkRefunded(bookingId);
  return results;
}

/**
 * The booking's online payment that can still cover `amount`. `only` limits the search to the
 * payments named (reject uses it for the ones it has just marked refund_due); without it,
 * refund_due payments are never returned, so an item refund cannot spend money that is owed back.
 */
export async function capturedPaymentFor(bookingId: string, amount: number, opts: { only?: string[] } = {}) {
  const pays = await prisma.campaignPayment.findMany({
    where: {
      bookingId,
      razorpayPaymentId: { not: null },
      ...(opts.only ? { id: { in: opts.only }, status: { in: [...REFUNDABLE_STATUSES] } } : { status: { in: [...ITEM_REFUNDABLE_STATUSES] } }),
    },
    orderBy: { createdAt: "asc" },
  });
  for (const p of pays) if (refundableOn(p, await reservedOn(prisma, p.id)) >= amount) return p;
  return null;
}

export async function maybeMarkRefunded(bookingId: string) {
  const b = await prisma.campaignBooking.findUnique({ where: { id: bookingId }, select: { status: true, payments: { select: { status: true } } } });
  // A booking with no payment row at all (offline mode) has nothing to refund online, so it
  // stays `rejected`: "refunded" would claim money went back that we never collected here.
  const owing = ["captured", "refund_pending", "refund_failed", "refund_due"];
  if (b?.status === "rejected" && b.payments.length > 0 && b.payments.every((p) => !owing.includes(p.status))) {
    await transitionBooking(bookingId, ["rejected"], "refunded", { type: "system" }).catch(() => undefined);
  }
}

// ── Reconciling refunds with Razorpay ───────────────────────────────────────────

const ledgerStatus = (s: string) => (s === "processed" ? "processed" : s === "failed" ? "failed" : "pending");

/**
 * Make our books say what Razorpay says about one payment's refunds. Reads the payment's complete
 * refund list (exact or it throws), then in one transaction:
 *   • updates the status of every ledger row Razorpay knows;
 *   • ties a refund we asked for but never heard back about (`requested`, no id) to Razorpay's
 *     entry by amount and receipt;
 *   • files every other refund as origin `external`: a refund we did not make is a dashboard click
 *     or a dispute outcome, and it PAUSES the creator payouts of the payment that still have
 *     something in flight (the money may no longer be there) and alerts staff;
 *   • sets refundedPaise to Razorpay's total, plus claims of ours Razorpay has not listed yet.
 *     Under-counting is the dangerous direction: it would let the same money be refunded twice.
 * The payment row is locked first so a refund being claimed at the same moment is either seen or
 * made against the new total.
 */
export async function reconcileRefunds(paymentId: string): Promise<{ refundedPaise: number; external: number }> {
  const head = await prisma.campaignPayment.findUnique({ where: { id: paymentId }, select: { id: true, razorpayPaymentId: true } });
  const razorpayPaymentId = head?.razorpayPaymentId;
  if (!head || !razorpayPaymentId) return { refundedPaise: 0, external: 0 };
  const list = await rzp.fetchPaymentRefunds(razorpayPaymentId);
  const now = new Date();

  const run = () =>
    prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM campaign_payments WHERE id = ${paymentId} FOR UPDATE`;
      const pay = await tx.campaignPayment.findUniqueOrThrow({ where: { id: paymentId } });
      const rows = await tx.campaignRefund.findMany({ where: { razorpayPaymentId } });
      const byRefundId = new Map(rows.filter((r) => r.razorpayRefundId).map((r) => [r.razorpayRefundId as string, r]));
      const unlinked = rows.filter((r) => r.status === "requested" && !r.razorpayRefundId && r.origin === "ours");
      const external: Array<{ id: string; amount: number }> = [];
      const failedNow: Array<{ id: string; amount: number }> = [];

      for (const r of list) {
        const status = ledgerStatus(r.status);
        const known = byRefundId.get(r.id);
        if (known) {
          const regress = known.status === "processed" && status === "pending";
          if (known.status !== status && !regress) {
            await tx.campaignRefund.update({ where: { id: known.id }, data: { status, processedAt: status === "processed" ? known.processedAt ?? now : known.processedAt, lastCheckedAt: now } });
            if (status === "failed" && known.origin === "ours") failedNow.push({ id: r.id, amount: r.amount });
          } else if (known.status !== "failed") {
            // ⚠️ Never on a FAILED row: its updatedAt is "when it failed", which the sweep's retry
            // backoff (steps 1 and 4) measures from. A failed row is not something the sweep polls
            // (it selects requested and pending only), but a sibling refund that stays pending
            // makes the sweep reconcile this payment every 10 minutes, and stamping the failed
            // rows each time would push their backoff back for as long as the sibling is in flight.
            await tx.campaignRefund.update({ where: { id: known.id }, data: { lastCheckedAt: now } });
          }
          continue;
        }
        const idx = unlinked.findIndex((u) => u.amountPaise === r.amount && (!r.receipt || u.receipt === r.receipt.slice(0, 40)));
        if (idx >= 0) {
          const [ours] = unlinked.splice(idx, 1);
          await tx.campaignRefund.update({ where: { id: ours.id }, data: { razorpayRefundId: r.id, status, processedAt: status === "processed" ? now : null, lastCheckedAt: now, lastError: null } });
          if (status === "failed") failedNow.push({ id: r.id, amount: r.amount });
          continue;
        }
        await tx.campaignRefund.create({
          data: {
            razorpayRefundId: r.id,
            paymentId: pay.id,
            razorpayPaymentId,
            bookingId: pay.bookingId,
            amountPaise: r.amount,
            receipt: r.receipt ? r.receipt.slice(0, 100) : null,
            status,
            origin: "external",
            reason: "external",
            processedAt: status === "processed" ? now : null,
            lastCheckedAt: now,
          },
        });
        if (status !== "failed") external.push({ id: r.id, amount: r.amount });
      }

      // Our own claims Razorpay has not listed: counted, never dropped (the list can lag), and stamped so the sweep paces itself.
      const listed = new Set(list.map((r) => r.id));
      let total = rzp.refundedTotalPaise(list);
      for (const r of rows) {
        if (r.razorpayRefundId && !listed.has(r.razorpayRefundId) && r.status !== "failed") total += r.amountPaise;
      }
      for (const u of unlinked) {
        total += u.amountPaise;
        await tx.campaignRefund.update({ where: { id: u.id }, data: { lastCheckedAt: now } });
      }
      await tx.campaignPayment.update({
        where: { id: pay.id },
        data: { refundedPaise: total, ...(pay.lastEvent === RECONCILE_MARKER ? { lastEvent: "refund.reconciled" } : {}) },
      });
      await resyncPaymentStatus(tx, pay.id, { failed: failedNow.length > 0 });

      if (external.length > 0) {
        // ⚠️ Same transaction as the ledger row: once the refund is on the ledger it counts as known, so the pause must not be able to be lost.
        // The dispute handler's rule, in one shared place: only payouts with something in flight, and a
        // payout that is already paused keeps its first reason (see services/creator/payout-pause.ts).
        const paused = await pausePayoutsOfPayment(tx, razorpayPaymentId, {
          reason: "external_refund",
          actorType: "system",
          note: "Paused: a refund we did not issue was found on the payment.",
          at: now,
        });
        await logBookingEvent(
          pay.bookingId,
          { type: "system" },
          `Refund of ${external.reduce((s, e) => s + e.amount, 0)} paise found on the payment that we did not issue${paused > 0 ? `; ${paused} creator payout(s) paused` : ""}.`,
          tx,
        );
      }
      for (const f of failedNow) await logBookingEvent(pay.bookingId, { type: "system" }, `Refund ${f.id} (${f.amount} paise) failed at Razorpay.`, tx);
      return { bookingId: pay.bookingId, total, external, failedNow };
    });

  let out: Awaited<ReturnType<typeof run>>;
  try {
    out = await run();
  } catch (err: any) {
    // The same external refund filed by a concurrent reconcile (unique refund id): the second pass sees it as known.
    // A deadlock or write conflict rolled the whole pass back: it is run again, once.
    if (err?.code === "P2002" || isContention(err)) out = await run();
    else throw err;
  }

  if (out.external.length > 0 || out.failedNow.length > 0) {
    const booking = await prisma.campaignBooking.findUnique({ where: { id: out.bookingId }, select: { name: true } });
    for (const e of out.external) {
      alertStaff(
        "Refund found on a campaign payment that we did not issue",
        [
          { label: "Campaign", value: booking?.name ?? out.bookingId },
          { label: "Refund", value: e.id },
          { label: "Amount", value: formatPaise(e.amount) },
          { label: "Creator payouts", value: "Paused until someone reviews this." },
        ],
        `/campaigns/${out.bookingId}`,
      );
    }
    for (const f of out.failedNow) {
      alertStaff(
        "A campaign refund failed at Razorpay",
        [
          { label: "Campaign", value: booking?.name ?? out.bookingId },
          { label: "Refund", value: f.id },
          { label: "Amount", value: formatPaise(f.amount) },
          // Honest about what the system does and does not do: an item refund is issued again by the sweep (see resendFailedItemRefunds); nothing else is.
          { label: "What happens next", value: "An item refund is issued again automatically (up to 5 attempts) and you are told if it keeps failing. If the brand has still not been repaid, check the payment in Razorpay." },
        ],
        `/campaigns/${out.bookingId}`,
      );
    }
  }
  await maybeMarkRefunded(out.bookingId);
  return { refundedPaise: out.total, external: out.external.length };
}

async function onRefundEvent(r: any, event: string): Promise<WebhookResult> {
  const razorpayPaymentId = String(r?.payment_id ?? "");
  const pay = razorpayPaymentId ? await prisma.campaignPayment.findFirst({ where: { razorpayPaymentId } }) : null;
  if (!pay) return { handled: false, note: "unknown payment" };
  // Leave a marker: the sweep re-reads this payment until a reconcile succeeds (and a reconcile that runs clears it).
  const defer = async (): Promise<WebhookResult> => {
    await prisma.campaignPayment.update({ where: { id: pay.id }, data: { lastEvent: RECONCILE_MARKER } }).catch(() => undefined);
    return { handled: true, note: "reconcile deferred" };
  };
  try {
    // Razorpay's list is the truth, not the single event: a refund event can be late, out of order or about a refund we never made.
    // ⚠️ It reads up to five pages from Razorpay, 15 s each, and Razorpay gives a webhook 5 seconds [R28]
    // (a slow answer is a failed delivery, and a webhook that keeps failing is disabled), so it gets the
    // same deadline as the refund call in onCaptured. A reconcile that is still running keeps going in
    // the background (it is idempotent and takes the payment lock); the marker covers it if it fails.
    const reconciling = reconcileRefunds(pay.id);
    const first = await withinDeadline(reconciling, refundTuning.inlineDeadlineMs);
    if (first.done) return { handled: true };
    void reconciling.catch((err) => console.error(`[campaign] refund event ${event} reconcile failed after the deadline: ${errorText(err)}`));
    return await defer();
  } catch (err) {
    // The list could not be read right now. Answer 2xx anyway (a failing webhook gets disabled).
    console.error(`[campaign] refund event ${event} could not be reconciled yet: ${errorText(err)}`);
    return defer();
  }
}

// ── The refund sweep ────────────────────────────────────────────────────────────

/**
 * CAMPAIGN_REFUND_SWEEP_ENABLED=0 is the incident kill switch for the sweep below. THE one place
 * that reads it: the cron decides whether to schedule the sweep with it, and the notices staff are
 * shown after an unanswered refund decide whether "we're checking" is true with it. The env only
 * changes with a restart, so reading it at call time equals the cron's boot-time read.
 */
export const refundSweepEnabled = () => process.env.CAMPAIGN_REFUND_SWEEP_ENABLED !== "0";

const DUE_MIN_AGE_MS = 60_000; // let the request that just made a payment refund_due finish its own refund first
const REQUESTED_FIRST_LOOK_MS = 2 * 60_000;
const REQUESTED_EVERY_MS = 3 * 60_000;
const PENDING_EVERY_MS = 10 * 60_000;
const RESUME_AFTER_MS = 5 * 60_000;
const DUE_ALERT_AFTER_ATTEMPTS = 3;
/** Consecutive ticks on which step 1 failed for a payment WITHOUT a refusal (a refusal has its own backoff and alert) before staff are told it is stuck. */
const DUE_STUCK_AFTER_TICKS = 3;

export interface RefundSweepStats {
  issued: number;
  reconciled: number;
  resumed: number;
  errors: number;
}

/** Per payment, in this process: how many ticks in a row step 1 failed for it without a refusal. */
const dueErrorTicks = new Map<string, number>();

/** Step 1 failed for this payment and will not fix itself: sent once per payment per process (not once a minute). */
function alertStaleStuck(p: CampaignPayment, why: string) {
  if (!firstTime(`due-stuck:${p.id}`)) return;
  alertStaff(
    "A campaign refund is stuck",
    [
      { label: "Payment", value: p.razorpayPaymentId ?? p.id },
      { label: "Amount still owed", value: formatPaise(refundableOn(p)) },
      { label: "What is wrong", value: why },
      { label: "What to do", value: "Check the payment in Razorpay. If the brand has not been repaid, refund the rest from the Razorpay dashboard. The sweep keeps trying, but it cannot settle this by itself." },
    ],
    `/campaigns/${p.bookingId}`,
  );
}

/** Send a payment step 1 could not settle to the back of the queue (it is ordered by updatedAt). Never throws. */
const touchDue = (paymentId: string) =>
  prisma.campaignPayment.updateMany({ where: { id: paymentId, status: "refund_due" }, data: { updatedAt: new Date() } }).catch(() => undefined);

/**
 * Finish refunds that were interrupted. Bounded and idempotent: every refund goes through the same
 * claim, the same stable keys and the same reconcile as a request would, so running it twice, or
 * while a request is in flight, cannot refund anything twice.
 *   1. A payment left `refund_due` (a crash after the commit, or a refusal, or an item refund that
 *      failed) is refunded for what it still owes (see staleRefundNext: each remainder is its own
 *      refund). After a refusal it backs off 5 minutes per failure (cap 1 hour) and staff are told at
 *      the third; any other error is reported once it has happened three ticks running.
 *   2. A refund we asked for and never heard back about, or that Razorpay has not finished, is
 *      reconciled against Razorpay's list; one Razorpay does not list after 5 minutes is re-sent
 *      with the SAME key (safe, and the list says it never arrived).
 *   3. A payment marked by a refund event whose list could not be read is reconciled.
 *   4. An ITEM refund that failed (refused on a re-send, or accepted and then failed at Razorpay) is
 *      issued again, under the same intent, with the same backoff and alert as step 1. See
 *      resendFailedItemRefunds for why it keys off the ledger and when it stands down.
 */
export async function sweepRefundDue(opts: { limit?: number; now?: Date } = {}): Promise<RefundSweepStats> {
  const stats: RefundSweepStats = { issued: 0, reconciled: 0, resumed: 0, errors: 0 };
  // No keys, no online payments, nothing to finish; and a missing key must not be mistaken for a refusal.
  if (!razorpayConfig.configured()) return stats;
  const now = opts.now ?? new Date();
  const limit = Math.max(1, Math.min(opts.limit ?? 10, 50));
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const system: Actor = { type: "system" };

  // 1. Owed in full.
  // ⚠️ A payment this step cannot settle must not sit at the head of this query for ever, or it uses up
  // one of the `limit` places every tick and starves the payments behind it. Two things keep it moving:
  // a payment whose whole remainder is already claimed is not selected at all (nothing to issue), and
  // one that errors without a refusal gets its updatedAt bumped (below), which sends it to the back.
  const due = await prisma.campaignPayment.findMany({
    where: { status: "refund_due", razorpayPaymentId: { not: null }, refundedPaise: { lt: prisma.campaignPayment.fields.amountPaise }, updatedAt: { lt: ago(DUE_MIN_AGE_MS) } },
    orderBy: { updatedAt: "asc" },
    take: limit,
  });
  for (const p of due) {
    if (refundableOn(p) <= 0) continue; // a refund for all of it is already in flight
    // The failed rows of the remainder about to be tried (see staleRefundNext): earlier remainders' failures are not this one's.
    const { attempts } = await staleRefundNext(p.id);
    if (attempts.length > 0 && attempts[0].updatedAt.getTime() + Math.min(60, 5 * attempts.length) * 60_000 > now.getTime()) continue;
    try {
      const done = await issueDueRefund(p.id, system);
      if (done?.existing) {
        // Money is owed and the answer was a refund that was already there: nothing was sent for it. Not an "issued".
        stats.errors++;
        alertStaleStuck(p, "A refund for this amount was already on the ledger, yet the payment still owes it.");
        await touchDue(p.id);
      } else {
        // Issued, or nothing is owed any more: either way the run of failures is over.
        if (done) stats.issued++;
        dueErrorTicks.delete(p.id);
      }
    } catch (err) {
      stats.errors++;
      await touchDue(p.id);
      const code = err instanceof AppError ? err.code : "";
      if (code === "REFUND_FAILED") {
        // Refused: it left a failed row, so the backoff above paces it, and staff are told at the third refusal.
        dueErrorTicks.delete(p.id);
        if (attempts.length + 1 === DUE_ALERT_AFTER_ATTEMPTS) {
          alertStaff(
            "A campaign refund keeps failing",
            [
              { label: "Payment", value: p.razorpayPaymentId ?? p.id },
              { label: "Amount", value: formatPaise(refundableOn(p)) },
              { label: "Last error", value: errorText(err) },
            ],
            `/campaigns/${p.bookingId}`,
          );
        }
      } else {
        // Anything else leaves no row behind, so nothing paces it and nothing else would ever say so.
        // A ledger that disagrees with the payment is certain; the rest (a claim that lost a race with a
        // reconcile, a database error) can be a one-off, so those are reported once they keep happening.
        if (dueErrorTicks.size > 500) dueErrorTicks.clear();
        const ticks = (dueErrorTicks.get(p.id) ?? 0) + 1;
        dueErrorTicks.set(p.id, ticks);
        if (code === "REFUND_LEDGER_MISMATCH" || ticks >= DUE_STUCK_AFTER_TICKS) alertStaleStuck(p, errorText(err));
      }
    }
  }

  // 2 + 3. Reconcile what is in flight, or was flagged.
  const inflight = await prisma.campaignRefund.findMany({
    where: {
      origin: "ours",
      paymentId: { not: null },
      OR: [
        { status: "requested", createdAt: { lt: ago(REQUESTED_FIRST_LOOK_MS) }, OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: ago(REQUESTED_EVERY_MS) } }] },
        { status: "pending", OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: ago(PENDING_EVERY_MS) } }] },
      ],
    },
    select: { paymentId: true },
    distinct: ["paymentId"],
    take: limit,
  });
  const marked = await prisma.campaignPayment.findMany({ where: { lastEvent: RECONCILE_MARKER, updatedAt: { lt: ago(DUE_MIN_AGE_MS) } }, select: { id: true }, take: limit });
  const ids = [...new Set([...inflight.map((r) => r.paymentId as string), ...marked.map((p) => p.id)])].slice(0, limit);
  for (const id of ids) {
    try {
      await reconcileRefunds(id);
      stats.reconciled++;
      const stuck = await prisma.campaignRefund.findMany({ where: { paymentId: id, origin: "ours", status: "requested", razorpayRefundId: null, createdAt: { lt: ago(RESUME_AFTER_MS) } } });
      for (const row of stuck) {
        try {
          await sendRefund(row, system);
          stats.resumed++;
        } catch (err) {
          stats.errors++;
          alertStaff(
            "A campaign refund could not be completed",
            [
              { label: "Campaign", value: row.bookingId ?? "" },
              { label: "Amount", value: formatPaise(row.amountPaise) },
              { label: "Reason", value: errorText(err) },
            ],
            row.bookingId ? `/campaigns/${row.bookingId}` : undefined,
          );
        }
      }
    } catch (err) {
      stats.errors++;
      console.error(`[campaign-refunds] reconcile failed: ${errorText(err)}`);
    }
  }

  // 4. After 2 + 3, so a refund those steps just found failed is seen in this same tick.
  try {
    await resendFailedItemRefunds(now, limit, stats);
  } catch (err) {
    stats.errors++;
    console.error(`[campaign-refunds] item refund retry failed: ${errorText(err)}`);
  }
  return stats;
}

// ── Failed item refunds ─────────────────────────────────────────────────────────

/** A failed item refund is retried for this long after its last failure, and then left to staff (the alert has long since gone out). */
const ITEM_REFUND_RETRY_WINDOW_MS = 14 * 24 * 3600_000;
/** After this many failed attempts of one item refund staff are told to refund it by hand and the sweep stops. */
const ITEM_REFUND_MAX_AUTO_ATTEMPTS = 5;

/** Alerts that skip or give up on an item refund are sent once per row per process, not once a minute. */
const itemRefundAlerted = new Set<string>();
function firstTime(key: string): boolean {
  if (itemRefundAlerted.has(key)) return false;
  if (itemRefundAlerted.size > 500) itemRefundAlerted.clear();
  itemRefundAlerted.add(key);
  return true;
}

/**
 * Step 4 of the sweep. An item that staff refunded stays `refunded` for good, so if the refund then
 * FAILS (Razorpay accepted it and failed it later, or refused a re-send of an unanswered one) nothing
 * else would ever return that money: the item has no retry button, and the payment is not
 * `refund_due`. The ledger is what knows, so this keys off it, never off the item's status alone.
 *
 * A failed, item-bound `item_refunded` row whose intent (`rf-item-<id>`, `-r2` …) has no LATER attempt
 * that is not failed is issued again through the same claim and keys as a click would (the claim
 * gives the new attempt its `-rN`). It stands down, and says so once, when
 *   • the item is no longer `refunded` (staff reopened it: they retry from the portal), or
 *   • the payment is owed in full (`refund_due`: step 1 refunds the whole remainder, this item
 *     included, so refunding it here too would pay it twice) or nothing is left to refund, or
 *   • a refund we did not issue was filed on the payment after the failed attempt began (staff
 *     probably refunded it from the Razorpay dashboard: a re-send could pay the brand twice).
 * Backoff is 5 minutes per failure (cap 1 hour); staff are alerted at the third failed attempt; it
 * gives up after ITEM_REFUND_MAX_AUTO_ATTEMPTS, because an asynchronously failed refund is usually
 * a destination problem that retrying will not fix.
 *
 * ⚠️ THE LAST STAND-DOWN CHECK READS RAZORPAY, NOT JUST OUR LEDGER. A dashboard refund made after
 * the failure is on our ledger only once something has reconciled the payment, and nothing does
 * that for a payment whose own refunds have all settled (steps 2 and 3 look at requested/pending
 * rows and flagged payments only). So just before a re-send the payment is reconciled (Razorpay's
 * exact refund list, which files an unknown refund as external), the rows are read again, and only
 * then is the stand-down rule evaluated. Without it the retry would refund the item a second time
 * against the headroom Razorpay still has. A reconcile that cannot read the list skips the item
 * for this tick; it is tried again on the next one.
 *
 * What a tick spends: `limit` is a cap on Razorpay READS (one per item that is about to be sent
 * again), so a Razorpay outage cannot turn one tick into hundreds of slow calls. Items that give
 * up, or stand down on what the ledger already shows, cost no read and use none of it, and the
 * candidates come newest-failure first: parked rows stay selected for 14 days and used to fill the
 * budget (and the 200 candidates) ahead of every refund that still needs a retry.
 */
async function resendFailedItemRefunds(now: Date, limit: number, stats: RefundSweepStats) {
  const system: Actor = { type: "system" };
  const failedRecently = await prisma.campaignRefund.findMany({
    where: {
      origin: "ours",
      status: "failed",
      reason: "item_refunded",
      bookingItemId: { not: null },
      paymentId: { not: null },
      updatedAt: { gt: new Date(now.getTime() - ITEM_REFUND_RETRY_WINDOW_MS) },
    },
    orderBy: { updatedAt: "desc" },
    select: { bookingItemId: true },
    distinct: ["bookingItemId"],
    take: 200,
  });
  const itemIds = failedRecently.map((r) => r.bookingItemId as string);
  if (itemIds.length === 0) return;

  type Found = { item: { status: string; accountName: string; bookingId: string }; pay: CampaignPayment; attempts: RefundRow[]; last: RefundRow };
  type Verdict = { kind: "skip" } | ({ kind: "giveup" | "external" | "send" } & Found);
  const skip: Verdict = { kind: "skip" };

  /** What to do about one item's failed refund, judged from the ledger rows given (the sweep's own batch, then a fresh read after the reconcile). */
  const assess = async (itemId: string, rows: RefundRow[]): Promise<Verdict> => {
    const key = `rf-item-${itemId}`;
    const attempts = rows.filter((r) => r.bookingItemId === itemId && isAttemptOf(r.idempotencyKey, key));
    // A later attempt that is not failed (in flight or done) means the money is, or is being, returned.
    if (attempts.length === 0 || attempts.some((r) => r.status !== "failed")) return skip;
    const last = attempts.reduce((a, b) => (b.updatedAt.getTime() > a.updatedAt.getTime() ? b : a));
    // Given up on and staff already told: nothing to look up.
    if (attempts.length >= ITEM_REFUND_MAX_AUTO_ATTEMPTS && itemRefundAlerted.has(`giveup:${last.id}`)) return skip;
    if (last.updatedAt.getTime() + Math.min(60, 5 * attempts.length) * 60_000 > now.getTime()) return skip;

    const [item, pay] = await Promise.all([
      prisma.campaignBookingItem.findUnique({ where: { id: itemId }, select: { status: true, accountName: true, bookingId: true } }),
      prisma.campaignPayment.findUnique({ where: { id: last.paymentId as string } }),
    ]);
    if (!item || !pay || item.status !== "refunded") return skip;
    if (!(ITEM_REFUNDABLE_STATUSES as readonly string[]).includes(pay.status)) return skip;
    const found: Found = { item, pay, attempts, last };
    if (attempts.length >= ITEM_REFUND_MAX_AUTO_ATTEMPTS) return { kind: "giveup", ...found };
    const externalAfter = await prisma.campaignRefund.count({ where: { paymentId: pay.id, origin: "external", status: { not: "failed" }, createdAt: { gt: last.createdAt } } });
    return { kind: externalAfter > 0 ? "external" : "send", ...found };
  };

  const detail = async (v: Found, what: string) => [
    { label: "Campaign", value: (await prisma.campaignBooking.findUnique({ where: { id: v.item.bookingId }, select: { name: true } }))?.name ?? v.item.bookingId },
    { label: "Account", value: v.item.accountName },
    { label: "Amount", value: formatPaise(v.last.amountPaise) },
    { label: "What to do", value: what },
  ];
  const standDown = async (v: Found) => {
    if (!firstTime(`external:${v.last.id}`)) return;
    alertStaff(
      "A failed campaign item refund was not re-sent",
      await detail(v, "A refund we did not issue was found on the payment after this one failed, so sending it again could refund the brand twice. Check the payment in Razorpay."),
      `/campaigns/${v.item.bookingId}`,
    );
  };

  const all = await prisma.campaignRefund.findMany({ where: { bookingItemId: { in: itemIds }, origin: "ours" }, orderBy: { createdAt: "asc" } });
  let reads = 0;
  for (const itemId of itemIds) {
    if (reads >= limit) break;
    let v = await assess(itemId, all);
    if (v.kind === "skip") continue;
    if (v.kind === "giveup") {
      if (firstTime(`giveup:${v.last.id}`)) {
        alertStaff("A campaign item refund needs a manual refund", await detail(v, `It failed ${v.attempts.length} times and is no longer retried automatically. Refund it from the Razorpay dashboard.`), `/campaigns/${v.item.bookingId}`);
      }
      continue;
    }
    if (v.kind === "external") {
      await standDown(v);
      continue;
    }

    // About to send it again: first ask Razorpay what has happened to this payment (see above).
    reads++;
    try {
      await reconcileRefunds(v.pay.id);
    } catch (err) {
      stats.errors++;
      console.error(`[campaign-refunds] item refund ${itemId} not re-sent this tick: the payment's refunds could not be read (${errorText(err)})`);
      continue;
    }
    v = await assess(itemId, await prisma.campaignRefund.findMany({ where: { bookingItemId: itemId, origin: "ours" }, orderBy: { createdAt: "asc" } }));
    if (v.kind === "external") {
      await standDown(v);
      continue;
    }
    if (v.kind !== "send") continue;

    const path = `/campaigns/${v.item.bookingId}`;
    try {
      await logBookingEvent(v.item.bookingId, system, `Re-sending the refund for ${v.item.accountName} (attempt ${v.attempts.length + 1}) after the last one failed.`);
      await refundPaymentRow(v.pay.id, v.last.amountPaise, `item:${itemId.slice(0, 30)}`, system, { key: `rf-item-${itemId}`, reason: "item_refunded", itemId });
      stats.issued++;
    } catch (err) {
      stats.errors++;
      // A refusal is a failed attempt (it left a row); anything else (no headroom, a database error) left nothing behind.
      const refused = err instanceof AppError && err.code === "REFUND_FAILED";
      if (refused ? v.attempts.length + 1 === DUE_ALERT_AFTER_ATTEMPTS : firstTime(`blocked:${v.last.id}`)) {
        alertStaff("A campaign refund keeps failing", [...(await detail(v, "Check the payment in Razorpay and refund it by hand if needed.")), { label: "Last error", value: errorText(err) }], path);
      }
    }
  }
}
