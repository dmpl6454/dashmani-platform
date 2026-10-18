/**
 * Refunding a creator's post: REVERSE BEFORE REFUND (payout plan Phase 4, "Reverse before refunding").
 *
 * A creator item's price was paid by the brand and, minutes after the capture, the creator's share of it was moved
 * out of our Razorpay balance into their linked account (held). Refunding the brand for that post while that
 * share still sits there would repay the brand with money that is still the creator's, out of OUR balance. So no
 * creator item is refunded until its payout can no longer pay anyone.
 *
 *   1. CLAIM  the callers do this, in one short transaction, and it is what stops everything else:
 *             the item → `refund_due`, the creator's offer withdrawn (closeOffer, refundItem, reject, approve).
 *             `refund_due` is the claim: it means "this post will not happen and the brand is owed its money".
 *   2. UNWIND progressCreatorItemRefund → reverseForRefund (payout.service): a planned payout is voided, a held
 *             transfer is reversed (the explicit amount that is left, never "all"), and anything that is not
 *             settled yet waits. NEVER inside a transaction: it talks to Razorpay.
 *   3. REFUND only once the payout reads void or reversed AND no payout of the payment can still turn into a transfer
 *             (a refund on a payment stops any later transfer [R4]): the item is claimed `refunded`, then refunded
 *             under its own ledger key (rf-item-<id>), which Razorpay and our ledger both treat as ONE refund.
 *
 * An item that cannot get through step 2 or 3 yet (a transfer still being made, a reversal Razorpay has not
 * confirmed, a sibling payout still planned) simply STAYS `refund_due`. Nothing is lost and nothing is refunded early:
 * the reconciliation worker (cron/creator-payouts.cron.ts, job 10) asks again every few minutes, in the same order.
 * A person is told when something needs a decision (a payout that is already released or paid out).
 *
 * Every function here is safe to repeat: the claims are conditional, the payout steps are idempotent, and the refund
 * has a stable key.
 */
import { prisma } from "@dashmani/db";
import { CREATOR_TARGET_TYPE, formatPaise } from "@dashmani/shared";
import { AppError } from "../../middleware/error-handler";
import { logBookingEvent, settleBooking, type Actor } from "../campaign/booking.service";
import { capturedPaymentFor, maybeMarkRefunded, refundPaymentRow, type RefundResult } from "../campaign/payment.service";
import { sendDeliveryEmail } from "../campaign/delivery.service";
import { alertStaffOncePerHour } from "./payout-alert";
import { refundAllowanceForPayment, reverseForRefund, type PayoutActor, type RefundReadiness } from "./payout.service";

/** Who is doing it. A creator's own decline runs as the creator for the payout's audit trail and as the system for the booking's. */
export type RefundActor = { type: "staff" | "system" | "creator"; id?: string | null };

export type CreatorRefundState =
  /** The brand's refund was issued and Razorpay confirmed it. */
  | "refunded"
  /** The refund was asked for and Razorpay has not confirmed it yet: the ledger row and the sweep own it now. */
  | "refund_pending"
  /** Not yet, and nothing is wrong: a transfer is still being made, a reversal is unconfirmed, a sibling payout is not set aside yet. */
  | "waiting"
  /** A person has to decide (the payout is already released or paid out, or its facts are in doubt). */
  | "blocked"
  /** Nothing to do: not a creator item, not refund_due, or someone else already did it. */
  | "skipped"
  /** The refund was refused or failed; `error` says how. The item is back to refund_due. */
  | "error";

export interface CreatorRefundOutcome {
  state: CreatorRefundState;
  /** A stable code: in_flight, reversal_pending, transfers_pending, no_refundable_balance, payout_released, already_refunded, … */
  reason: string;
  /** Razorpay requests made (the payout steps' own count, plus one for a refund request that was sent). */
  calls: number;
  refund?: RefundResult;
  /** state "error" only: what the refund failed with (our own AppError, never a provider body). */
  error?: unknown;
}

const toActor = (a: RefundActor): Actor => ({ type: a.type === "staff" ? "staff" : "system", id: a.id ?? null });
const toPayoutActor = (a: RefundActor): PayoutActor => ({ type: a.type, id: a.id ?? null });

function alertBlocked(item: { id: string; bookingId: string; accountName: string; pricePaise: number }, why: string): void {
  alertStaffOncePerHour(
    `creator-refund-blocked:${item.id}`,
    "A creator's post can't be refunded yet",
    [
      { label: "Campaign", value: item.bookingId },
      { label: "Post", value: item.accountName },
      { label: "Amount owed to the client", value: formatPaise(item.pricePaise) },
      { label: "Why", value: why },
      {
        label: "What to do",
        value: "The client is owed this refund, but it is not issued while the creator's payout could still pay out. Open the payout queue, look at this payout, take it back (Reverse) or pay the creator by hand, and the refund then goes out by itself.",
      },
    ],
    `/campaigns/${item.bookingId}`,
  );
}

const BLOCKED_TEXT: Record<string, string> = {
  payout_released: "The creator's payout has already been released to their account.",
  payout_settled: "The creator's payout has already been paid out to their bank.",
  payout_settlement_failed: "The creator's payout was released and its bank settlement failed: the money may still be in their account.",
  payout_paid_manual: "The creator has already been paid by bank transfer.",
  payout_release_requested: "A release of the creator's payout is in flight.",
  payout_needs_attention: "The creator's payout is parked: Razorpay's facts and ours disagree.",
  manual_required_unproven: "The creator's payout is waiting to be paid by hand and money may already be out.",
  payout_moved: "The creator's payout changed while the refund was being prepared.",
  reversal_refused: "Razorpay refused to take the creator's share back.",
  reversal_refused_after_release: "Razorpay refused to take back money that was already released.",
  transfer_not_processed: "Razorpay has not finished making the creator's transfer.",
};

/**
 * Move ONE claimed creator item as far along as it can go right now: unwind its payout, then refund the brand.
 * The item must be `refund_due` (claim it first). Never throws: every outcome, including a refund Razorpay refused,
 * is a `state` (the caller that wants an exception raises `error` itself).
 */
export async function progressCreatorItemRefund(
  itemId: string,
  o: {
    actor: RefundActor;
    /** Why the payout ends (declined, expired, withdrawn, missed_window, booking_rejected, item_refunded, page_changed, …): written on a voided payout. */
    reason: string;
    /** The ledger reason of the refund: `item_refunded` (the sweep retries those) or `booking_rejected`. */
    refundReason?: "item_refunded" | "booking_rejected";
    /** Reject: refund from these payments (the ones it just marked refund_due). */
    only?: string[];
    now?: Date;
  },
): Promise<CreatorRefundOutcome> {
  const item = await prisma.campaignBookingItem.findUnique({
    where: { id: itemId },
    select: { id: true, bookingId: true, status: true, pricePaise: true, targetType: true, accountName: true },
  });
  if (!item || item.targetType !== CREATOR_TARGET_TYPE) return { state: "skipped", reason: "not_a_creator_item", calls: 0 };
  if (item.status === "refunded") return { state: "skipped", reason: "already_refunded", calls: 0 };
  if (item.status !== "refund_due") return { state: "skipped", reason: `item_${item.status}`, calls: 0 };

  // 2. UNWIND. After the claim, outside any transaction.
  let ready: RefundReadiness;
  try {
    ready = await reverseForRefund(item.id, { actor: toPayoutActor(o.actor), reason: o.reason, now: o.now });
  } catch (err) {
    console.error(`[creator-refund] unwinding the payout of ${item.id} failed: ${(err as Error)?.message ?? "error"}`.slice(0, 240));
    return { state: "waiting", reason: "unwind_failed", calls: 0 };
  }
  let calls = ready.calls;
  if (!ready.refundable) {
    if (ready.state === "blocked") {
      alertBlocked(item, BLOCKED_TEXT[ready.reason ?? ""] ?? "The creator's payout is in a state a refund must not touch.");
      return { state: "blocked", reason: ready.reason ?? "blocked", calls };
    }
    return { state: "waiting", reason: ready.state === "in_flight" ? "in_flight" : ready.reason === "unknown" || ready.reason === "partial" ? "reversal_pending" : ready.state, calls };
  }
  if (calls > 0 || ready.state === "voided") {
    await logBookingEvent(
      item.bookingId,
      toActor(o.actor),
      `Creator post on ${item.accountName}: the creator's payout was ${ready.state === "voided" ? "cancelled (nothing had been transferred)" : "taken back from their payout account"}; the client's refund follows.`.slice(0, 500),
    ).catch(() => undefined);
  }

  // 3. REFUND. Only on a payment that can cover it and on which no transfer can still be created.
  const pay = await capturedPaymentFor(item.bookingId, item.pricePaise, o.only ? { only: o.only } : {});
  if (!pay || !pay.razorpayPaymentId) {
    const online = await prisma.campaignPayment.count({ where: { bookingId: item.bookingId, razorpayPaymentId: { not: null } } });
    return online > 0 ? { state: "waiting", reason: "no_refundable_balance", calls } : { state: "blocked", reason: "no_online_payment", calls };
  }
  const allowance = await refundAllowanceForPayment(pay.razorpayPaymentId);
  if (!allowance.allowed) return { state: "waiting", reason: "transfers_pending", calls };

  const claim = await prisma.campaignBookingItem.updateMany({
    where: { id: item.id, status: "refund_due", OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date() } }] },
    data: { status: "refunded", lastError: null },
  });
  if (claim.count !== 1) return { state: "skipped", reason: "lost_claim", calls };

  let refund: RefundResult;
  try {
    refund = await refundPaymentRow(pay.id, item.pricePaise, `item:${item.id.slice(0, 30)}`, toActor(o.actor), {
      key: `rf-item-${item.id}`,
      reason: o.refundReason ?? "item_refunded",
      itemId: item.id,
    });
    calls += 1;
  } catch (err) {
    calls += 1;
    // Nothing was refunded (Razorpay refused, or the claim itself failed): the item is owed again. The one exception is a
    // refund that is still claimed on the ledger (Razorpay refused but giving the claim back failed too): then the sweep
    // re-sends it, and re-opening the item would let it be handled twice, so it stays refunded.
    const stillClaimed = await prisma.campaignRefund.count({ where: { bookingItemId: item.id, origin: "ours", status: { in: ["requested", "pending"] } } }).catch(() => 0);
    if (stillClaimed === 0) await prisma.campaignBookingItem.updateMany({ where: { id: item.id, status: "refunded" }, data: { status: "refund_due" } }).catch(() => undefined);
    // A refund that has to wait for the payment's transfers is not a failure: the claim refused before writing anything.
    if (err instanceof AppError && err.code === "REFUND_WAITING") return { state: "waiting", reason: "transfers_pending", calls };
    return { state: "error", reason: err instanceof AppError ? err.code : "refund_error", calls, error: err };
  }

  // The item is settled one way or the other: move the booking on (it may have just finished) and tell the brand if so.
  try {
    if (await settleBooking(item.bookingId, toActor(o.actor))) void sendDeliveryEmail(item.bookingId).catch((e) => console.error("[campaign] delivery email failed", e));
    await maybeMarkRefunded(item.bookingId);
  } catch (err) {
    console.error(`[creator-refund] settling booking ${item.bookingId} failed: ${(err as Error)?.message ?? "error"}`.slice(0, 200));
  }
  return { state: refund.state === "processed" ? "refunded" : "refund_pending", reason: refund.state, calls, refund };
}

/** progressCreatorItemRefund for several items, one after the other, never throwing. */
export async function progressCreatorItemRefunds(itemIds: readonly string[], o: Parameters<typeof progressCreatorItemRefund>[1]): Promise<Map<string, CreatorRefundOutcome>> {
  const out = new Map<string, CreatorRefundOutcome>();
  for (const id of itemIds) {
    try {
      out.set(id, await progressCreatorItemRefund(id, o));
    } catch (err) {
      console.error(`[creator-refund] ${id}: ${(err as Error)?.message ?? "error"}`.slice(0, 240));
      out.set(id, { state: "waiting", reason: "unexpected_error", calls: 0 });
    }
  }
  return out;
}

// ── In the background: a creator's own decline must not wait on Razorpay ─────────────────────────

const pending = new Set<Promise<unknown>>();

/**
 * Run progressCreatorItemRefunds without making the caller wait: a creator declining an offer (or a webhook) must
 * not sit through a Razorpay reversal. The claim is already committed, the worker is the backstop, and every failure
 * is logged, never thrown.
 */
export function progressCreatorItemRefundsInBackground(itemIds: readonly string[], o: Parameters<typeof progressCreatorItemRefund>[1]): void {
  const work = progressCreatorItemRefunds(itemIds, o).catch(() => undefined);
  pending.add(work);
  void work.finally(() => pending.delete(work));
}

/** Tests only: resolves once every background refund started so far has finished. */
export async function settleCreatorRefundsForTests(): Promise<void> {
  while (pending.size > 0) await Promise.all([...pending]);
}

// ── Reconciliation job 10 ────────────────────────────────────────────────────────────────────────

/** A creator item that became refund_due this recently is left to the request that made it (it is making its own refund). */
export const REFUND_DUE_MIN_AGE_MS = 2 * 60_000;
/** A refund_due creator post that has waited this many worker ticks (5 minutes each) is named in the daily digest. */
export const REFUND_DUE_STUCK_ATTEMPTS = 12;
/** The most Razorpay requests one item can use (a reversal reads, asks and lists; the refund is one more). */
export const REFUND_DUE_ITEM_COST = 4;

export interface RefundDueSummary {
  checked: number;
  refunded: number;
  pending: number;
  waiting: number;
  blocked: number;
  errors: number;
  calls: number;
}

/**
 * Job 10 of the reconciliation worker: every creator item still `refund_due` is moved on (unwind its payout, refund the
 * brand once it is allowed). Oldest first; an item that cannot move yet is sent to the back of the queue (its updated_at
 * is bumped), so a few stuck ones can never starve the rest. Bounded by `limit` items and by the Razorpay `budget`.
 */
export async function runRefundDueJob(o: { now?: Date; limit?: number; budget?: number; actor?: RefundActor } = {}): Promise<RefundDueSummary> {
  const now = o.now ?? new Date();
  const limit = Math.max(1, Math.min(o.limit ?? 20, 100));
  const budget = o.budget ?? 20;
  const sum: RefundDueSummary = { checked: 0, refunded: 0, pending: 0, waiting: 0, blocked: 0, errors: 0, calls: 0 };
  const rows = await prisma.campaignBookingItem.findMany({
    where: { targetType: CREATOR_TARGET_TYPE, status: "refund_due", updatedAt: { lt: new Date(now.getTime() - REFUND_DUE_MIN_AGE_MS) } },
    orderBy: { updatedAt: "asc" },
    select: { id: true },
    take: limit,
  });
  for (const row of rows) {
    if (sum.calls + REFUND_DUE_ITEM_COST > budget) break;
    sum.checked++;
    const r = await progressCreatorItemRefund(row.id, { actor: o.actor ?? { type: "system" }, reason: "refund_due", now: o.now }).catch(
      (): CreatorRefundOutcome => ({ state: "waiting", reason: "unexpected_error", calls: 0 }),
    );
    sum.calls += r.calls;
    if (r.state === "refunded") sum.refunded++;
    else if (r.state === "refund_pending") sum.pending++;
    else if (r.state === "blocked") sum.blocked++;
    else if (r.state === "error") sum.errors++;
    else if (r.state === "waiting") sum.waiting++;
    // Still owed: to the back of the queue (the write moves updated_at, which is the order), and counted. `attempts` is otherwise
    // unused on a creator's post (the publisher never touches one), so it counts the ticks this refund has waited: the digest names
    // a post that has waited REFUND_DUE_STUCK_ATTEMPTS of them (about an hour).
    if (r.state !== "refunded" && r.state !== "refund_pending" && r.state !== "skipped") {
      await prisma.campaignBookingItem.updateMany({ where: { id: row.id, status: "refund_due" }, data: { attempts: { increment: 1 } } }).catch(() => undefined);
    }
  }
  return sum;
}
