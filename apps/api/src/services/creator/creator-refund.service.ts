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
 * ⚠️ THE ITEM BECOMES `refunded` LAST, only after the refund's ledger row exists (refundPaymentRow has returned). It used to be
 * flipped before the claim, and a restart (every deploy restarts the process) or a second database error in that window left an
 * item that read "refunded" with no refund anywhere: the client never repaid, nothing alerting. Now every point of failure leaves
 * `refund_due`, which job 10 owns: a crash before the ledger row leaves nothing to undo, and a crash after it leaves a live row
 * that the next pass finds ("existing") and only then marks the item. `refund_due` already keeps every other flow off the item,
 * and rf-item-<id> already makes the refund one refund, so the early flip bought nothing.
 *
 * ⚠️ THE AUTOMATIC PATH DOES NOT RE-SEND A REFUND RAZORPAY REFUSED BLINDLY. A refused refund is retried by job 10 with a backoff and
 * at most ITEM_REFUND_MAX_AUTO_ATTEMPTS times, and before every re-send the payment's refund list is READ: a refund nobody here
 * issued (a staff member repaid the client from the Razorpay dashboard after the refusal) stands the automatic path down, because a
 * re-send would repay the client twice out of the headroom that belongs to the payment's other posts. The stand-down is stamped
 * on the item (lastError says why in words, nextAttemptAt parks it, attempts is pinned so the digest names it) and a person is told
 * once. The staff Refund click is the deliberate override and skips these guards; markCreatorItemRefundedByHand is the way out when
 * the client WAS repaid outside the portal.
 *
 * Every function here is safe to repeat: the claims are conditional, the payout steps are idempotent, and the refund
 * has a stable key.
 */
import { prisma } from "@dashmani/db";
import type { CampaignRefund } from "@dashmani/db";
import { CREATOR_TARGET_TYPE, formatPaise } from "@dashmani/shared";
import { AppError } from "../../middleware/error-handler";
import { logBookingEvent, settleBooking, type Actor } from "../campaign/booking.service";
import { ITEM_REFUND_MAX_AUTO_ATTEMPTS, capturedPaymentFor, isAttemptOf, maybeMarkRefunded, reconcileRefunds, refundPaymentRow, type RefundResult } from "../campaign/payment.service";
import { sendDeliveryEmail } from "../campaign/delivery.service";
import { alertStaffDurably, alertStaffOncePerHour } from "./payout-alert";
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

const DAY_MS = 24 * 3_600_000;

/** One reminder a day per blocked post, kept across restarts (the daily digest names it too): an hourly repeat of the same words trains people to stop reading. */
async function alertBlocked(item: { id: string; bookingId: string; accountName: string; pricePaise: number }, why: string): Promise<void> {
  await alertStaffDurably(
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
    { quietMs: DAY_MS },
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

// ── A refund Razorpay refused: backoff, a read before every re-send, a cap, and a stand-down ─────

/** After a refusal the automatic retry waits this many minutes per failed attempt (cap 1 hour): the sweep's own pace. */
const retryBackoffMs = (failedAttempts: number) => Math.min(60, 5 * failedAttempts) * 60_000;
/** A stood-down item is parked this long (effectively "until a person acts"; the guards run again, harmlessly, if it ever comes back). */
const STAND_DOWN_MS = 30 * DAY_MS;

type StandDownReason = "refund_refused_repeatedly" | "external_refund_found";

/** Written on the item itself (staff read it on the row): what the automatic path did and what to do. Plain words, no ids. */
const STAND_DOWN_TEXT: Record<StandDownReason, string> = {
  refund_refused_repeatedly:
    "The automatic refund stopped: Razorpay refused it several times. Check the payment in Razorpay. If the client has not been repaid, press Refund to try again or refund from the Razorpay dashboard and use Mark refunded.",
  external_refund_found:
    "The automatic refund stopped: a refund we did not issue was found on the payment after Razorpay refused ours. Check Razorpay. If the client was repaid, use Mark refunded; if not, press Refund to send it.",
};

/**
 * Stop the automatic path on this item and say so ONCE. The park (nextAttemptAt + a pinned attempts counter, so job 10 skips it and
 * the digest names it) is written every time; the words on the row and the alert only when they change, so a stand-down that is
 * looked at again never emails again.
 */
async function standDown(
  item: { id: string; bookingId: string; accountName: string; pricePaise: number; attempts: number },
  reason: StandDownReason,
  now: Date,
  calls: number,
  failedAttempts: number,
): Promise<CreatorRefundOutcome> {
  const text = STAND_DOWN_TEXT[reason];
  await prisma.campaignBookingItem.updateMany({
    where: { id: item.id, status: "refund_due" },
    data: { nextAttemptAt: new Date(now.getTime() + STAND_DOWN_MS), attempts: Math.max(item.attempts, REFUND_DUE_STUCK_ATTEMPTS) },
  });
  const worded = await prisma.campaignBookingItem.updateMany({ where: { id: item.id, status: "refund_due", OR: [{ lastError: null }, { lastError: { not: text } }] }, data: { lastError: text } });
  if (worded.count === 1) {
    await logBookingEvent(item.bookingId, { type: "system" }, `Creator post on ${item.accountName}: the automatic refund stopped (${reason === "external_refund_found" ? "a refund we did not issue was found on the payment" : `Razorpay refused it ${failedAttempts} times`}).`.slice(0, 500)).catch(() => undefined);
    alertStaffOncePerHour(
      `creator-refund-standdown:${item.id}`,
      reason === "external_refund_found" ? "A creator post's refund was not re-sent" : "A creator post's refund needs a manual refund",
      [
        { label: "Campaign", value: item.bookingId },
        { label: "Post", value: item.accountName },
        { label: "Amount owed to the client", value: formatPaise(item.pricePaise) },
        { label: "What happened", value: reason === "external_refund_found" ? "Razorpay refused our refund, and a refund we did not issue has since appeared on the same payment." : `Razorpay refused the refund ${failedAttempts} times, so it is no longer retried automatically.` },
        {
          label: "What to do",
          value: "Open the payment in Razorpay first. If the client has been repaid, press Mark refunded on the post (it records that refund against the post). If not, press Refund on the post to send it again, or refund it from the Razorpay dashboard. Never do both: the client would be repaid twice.",
        },
      ],
      `/campaigns/${item.bookingId}`,
    );
  }
  return { state: "blocked", reason, calls };
}

/** Every attempt of THIS post's own refund on the ledger (`rf-item-<id>`, `-r2` …), oldest first. */
async function ownRefundAttempts(itemId: string): Promise<CampaignRefund[]> {
  const key = `rf-item-${itemId}`;
  return (await prisma.campaignRefund.findMany({ where: { bookingItemId: itemId, origin: "ours" }, orderBy: { createdAt: "asc" } })).filter((r) => isAttemptOf(r.idempotencyKey, key));
}

/**
 * The last step of a refund, shared by every way it ends: the post is marked `refunded` (conditionally: only a `refund_due` one), then the
 * booking is moved on (it may have just finished) and the brand told if so. Returns false when the post could not be marked (a database error): the
 * refund is on the ledger by then, so nothing is lost and the next pass finds it and does this again.
 */
async function markRefundedAndSettle(item: { id: string; bookingId: string }, actor: RefundActor): Promise<boolean> {
  try {
    await prisma.campaignBookingItem.updateMany({ where: { id: item.id, status: "refund_due" }, data: { status: "refunded", lastError: null, nextAttemptAt: null } });
  } catch (err) {
    console.error(`[creator-refund] ${item.id}: the refund is on the ledger but the post could not be marked refunded yet (${(err as Error)?.name ?? "error"}); the next pass does it`);
    return false;
  }
  try {
    if (await settleBooking(item.bookingId, toActor(actor))) void sendDeliveryEmail(item.bookingId).catch((e) => console.error("[campaign] delivery email failed", e));
    await maybeMarkRefunded(item.bookingId);
  } catch (err) {
    console.error(`[creator-refund] settling booking ${item.bookingId} failed: ${(err as Error)?.message ?? "error"}`.slice(0, 200));
  }
  return true;
}

/**
 * Before the AUTOMATIC path sends a refund again: has it been refused before, and if so may it go on? Returns the outcome that stops
 * it, or null to go ahead (nothing was tried yet, or an attempt is live: claimRefund then answers with that attempt and nothing is
 * sent twice).
 */
async function guardResend(
  item: { id: string; bookingId: string; accountName: string; pricePaise: number; attempts: number },
  paymentId: string,
  own: CampaignRefund[],
  now: Date,
  calls: number,
): Promise<CreatorRefundOutcome | null> {
  const attemptsOf = () => ownRefundAttempts(item.id);
  if (own.length === 0 || own.some((r) => r.status !== "failed")) return null;
  if (own.length >= ITEM_REFUND_MAX_AUTO_ATTEMPTS) return standDown(item, "refund_refused_repeatedly", now, calls, own.length);
  const last = own.reduce((a, b) => (b.updatedAt.getTime() > a.updatedAt.getTime() ? b : a));
  if (last.updatedAt.getTime() + retryBackoffMs(own.length) > now.getTime()) return { state: "waiting", reason: "refund_backoff", calls };

  // About to send it again: first ask Razorpay what has happened to this payment (it files a refund nobody here made as `external`).
  try {
    await reconcileRefunds(paymentId);
  } catch (err) {
    console.error(`[creator-refund] ${item.id} not re-sent this pass: the payment's refunds could not be read (${(err as Error)?.name ?? "error"})`);
    return { state: "waiting", reason: "refunds_unreadable", calls: calls + 2 };
  }
  calls += 2;
  const fresh = await attemptsOf();
  // The read found one of OUR attempts alive after all (it had been accepted and the answer lost): the money is on its way.
  if (fresh.some((r) => r.status !== "failed")) return null;
  const newest = fresh.reduce((a, b) => (b.createdAt.getTime() > a.createdAt.getTime() ? b : a), last);
  const external = await prisma.campaignRefund.count({ where: { paymentId, origin: "external", status: { not: "failed" }, createdAt: { gt: newest.createdAt } } });
  if (external > 0) return standDown(item, "external_refund_found", now, calls, fresh.length);
  return null;
}

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
  const now = o.now ?? new Date();
  const item = await prisma.campaignBookingItem.findUnique({
    where: { id: itemId },
    select: { id: true, bookingId: true, status: true, pricePaise: true, targetType: true, accountName: true, attempts: true },
  });
  if (!item || item.targetType !== CREATOR_TARGET_TYPE) return { state: "skipped", reason: "not_a_creator_item", calls: 0 };
  if (item.status === "refunded") return { state: "skipped", reason: "already_refunded", calls: 0 };
  if (item.status !== "refund_due") return { state: "skipped", reason: `item_${item.status}`, calls: 0 };

  // ⚠️ A refund of this very post may already be on the ledger (a previous pass wrote its row and was cut off before it marked the post, or
  // marked it and failed). Then there is nothing to unwind, find a payment for or send: it only has to be finished. This must come BEFORE the
  // payment is looked for: once the refund has consumed the payment's headroom no payment "can cover" the post any more, and a post whose refund
  // is done would wait for ever.
  const own = await ownRefundAttempts(item.id);
  const live = own.find((r) => r.status !== "failed");
  if (live) {
    // Somebody else's attempt that has no answer yet (its row is `requested`): leave the post to it, it is marked once the row settles.
    if (live.status === "requested" && !live.razorpayRefundId) return { state: "refund_pending", reason: "in_flight", calls: 0 };
    const marked = await markRefundedAndSettle(item, o.actor);
    return { state: marked && live.status === "processed" ? "refunded" : "refund_pending", reason: marked ? live.status : "item_not_marked", calls: 0 };
  }

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
      await alertBlocked(item, BLOCKED_TEXT[ready.reason ?? ""] ?? "The creator's payout is in a state a refund must not touch.");
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

  // The AUTOMATIC path only: a refusal is retried with a backoff and a cap, and never blind (see guardResend). A person's click is the override.
  if (o.actor.type === "system") {
    const stop = await guardResend(item, pay.id, own, now, calls);
    if (stop) return stop;
  }

  // Read-only on purpose (see the header): the item is marked refunded only once the refund's ledger row exists.
  const open = await prisma.campaignBookingItem.count({ where: { id: item.id, status: "refund_due", OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date() } }] } });
  if (open !== 1) return { state: "skipped", reason: "lost_claim", calls };

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
    // Nothing was refunded (Razorpay refused, or the claim itself failed) and the item was never flipped: it is still owed, there is nothing to undo.
    // A refund that has to wait for the payment's transfers is not a failure: the claim refused before writing anything.
    if (err instanceof AppError && err.code === "REFUND_WAITING") return { state: "waiting", reason: "transfers_pending", calls };
    return { state: "error", reason: err instanceof AppError ? err.code : "refund_error", calls, error: err };
  }
  // Somebody else's attempt is still in flight (its row is `requested`, no answer yet): leave the item to it. Marking it refunded now would hide a refund that
  // may yet be refused; the next pass sees the row settled and does it.
  if (refund.existing && refund.state === "confirming") return { state: "refund_pending", reason: "in_flight", calls, refund };

  // The ledger row exists: NOW the item is refunded. A failure here loses nothing (the row is the claim, the next pass finds it and marks the post).
  if (!(await markRefundedAndSettle(item, o.actor))) return { state: "refund_pending", reason: "item_not_marked", calls, refund };
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
/** The most Razorpay requests one item can use (a reversal reads, asks and lists; a re-send after a refusal reads the payment's refund list first, 2; the refund is one more). */
export const REFUND_DUE_ITEM_COST = 6;

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
    where: {
      targetType: CREATOR_TARGET_TYPE,
      status: "refund_due",
      updatedAt: { lt: new Date(now.getTime() - REFUND_DUE_MIN_AGE_MS) },
      // A stood-down item (see standDown) is parked until a person acts: it must not spend a place or a Razorpay read every tick.
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
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

// ── Repair: a post marked refunded with no refund behind it ────────────────────────────────────

export interface RepairRefundedSummary {
  found: number;
  reopened: number;
  stoodDown: number;
  calls: number;
}

/** A refunded post is only suspect once it has looked like this for a while (everything the product does itself marks the post after the ledger row). */
const REFUNDED_NO_LEDGER_AFTER_MS = 30 * 60_000;

/**
 * A creator post that reads `refunded` while NO refund of it is on the ledger (none that is not failed), its payout is out of the way
 * (void, reversed or absent) and the brand's payment still owes: the client has not been repaid and nothing says so. progressCreatorItemRefund
 * no longer produces this state (the post is marked last), so this is the net under what it cannot see: an older row, a hand edit, a crash in a path
 * that still claims first. A payment the sweep owns (`refund_due`) is NOT looked at: the reject path legitimately marks its posts refunded
 * and has the sweep repay the remainder under one payment-wide key.
 *
 * It first READS the payment's refund list (a refund filed from the Razorpay dashboard after the post was marked is on the list, not on our
 * ledger): if one appeared after the post was marked refunded, the client may well have been repaid, so the post is left alone and staff are
 * told. Otherwise it is re-opened (`refund_due`), and job 10 refunds it through the usual sequence, under the post's own key, once.
 * Bounded (`limit` posts a call, 2 Razorpay requests each) and never throws.
 */
export async function repairRefundedWithoutLedger(o: { now?: Date; limit?: number; budget?: number } = {}): Promise<RepairRefundedSummary> {
  const now = o.now ?? new Date();
  const limit = Math.max(1, Math.min(o.limit ?? 5, 20));
  const budget = o.budget ?? 20;
  const sum: RepairRefundedSummary = { found: 0, reopened: 0, stoodDown: 0, calls: 0 };
  const cutoff = new Date(now.getTime() - REFUNDED_NO_LEDGER_AFTER_MS);
  const rows = await prisma.$queryRaw<Array<{ id: string; booking_id: string; account_name: string; price_paise: number; updated_at: Date }>>`
    SELECT i.id, i.booking_id, i.account_name, i.price_paise, i.updated_at
      FROM campaign_booking_items i
     WHERE i.target_type = ${CREATOR_TARGET_TYPE} AND i.status = 'refunded' AND i.updated_at < ${cutoff}::timestamptz AT TIME ZONE 'UTC'
       AND NOT EXISTS (SELECT 1 FROM campaign_refunds r WHERE r.booking_item_id = i.id AND r.status <> 'failed')
       AND NOT EXISTS (SELECT 1 FROM creator_payouts p WHERE p.booking_item_id = i.id AND p.status NOT IN ('void', 'reversed'))
       AND EXISTS (SELECT 1 FROM campaign_payments y WHERE y.booking_id = i.booking_id AND y.razorpay_payment_id IS NOT NULL AND y.status IN ('captured', 'refund_pending', 'refund_failed'))
     ORDER BY i.updated_at ASC
     LIMIT ${limit}`;
  sum.found = rows.length;
  for (const r of rows) {
    if (sum.calls + 2 > budget) break;
    const item = { id: r.id, bookingId: r.booking_id, accountName: r.account_name, pricePaise: r.price_paise };
    try {
      const pay = await capturedPaymentFor(item.bookingId, item.pricePaise);
      if (!pay) {
        await alertRefundedNoLedger(item, "The payment has no refundable balance left for it, so it was not re-opened.", now);
        sum.stoodDown++;
        continue;
      }
      await reconcileRefunds(pay.id);
      sum.calls += 2;
      const external = await prisma.campaignRefund.count({ where: { paymentId: pay.id, origin: "external", status: { not: "failed" }, createdAt: { gt: r.updated_at } } });
      if (external > 0) {
        await alertRefundedNoLedger(item, "A refund we did not issue was found on the payment after this post was marked refunded, so it may have been repaid already. It was not re-opened.", now);
        sum.stoodDown++;
        continue;
      }
      const reopened = await prisma.campaignBookingItem.updateMany({
        where: { id: item.id, status: "refunded" },
        data: { status: "refund_due", attempts: 0, nextAttemptAt: null, lastError: "This post was marked refunded but no refund of it exists: it was re-opened and the client is refunded automatically." },
      });
      if (reopened.count === 1) {
        sum.reopened++;
        await logBookingEvent(item.bookingId, { type: "system" }, `Creator post on ${item.accountName} read refunded but no refund of it was on the ledger: re-opened so the client is refunded.`.slice(0, 500)).catch(() => undefined);
        await alertRefundedNoLedger(item, "It was re-opened, and the client is refunded automatically.", now);
      }
    } catch (err) {
      console.error(`[creator-refund] repair of ${item.id} failed: ${(err as Error)?.name ?? "error"}`);
    }
  }
  return sum;
}

async function alertRefundedNoLedger(item: { id: string; bookingId: string; accountName: string; pricePaise: number }, what: string, now: Date): Promise<void> {
  await alertStaffDurably(
    `creator-refunded-no-ledger:${item.id}`,
    "A creator post reads refunded but no refund of it was found",
    [
      { label: "Campaign", value: item.bookingId },
      { label: "Post", value: item.accountName },
      { label: "Amount", value: formatPaise(item.pricePaise) },
      { label: "What happened", value: "The post is marked refunded, yet no refund of it is on our ledger, and the brand's payment still holds the money." },
      { label: "What was done", value: what },
      { label: "What to do", value: "If the client has been repaid outside the portal, open the payment in Razorpay and use Mark refunded on the post. Otherwise nothing: it is refunded automatically." },
    ],
    `/campaigns/${item.bookingId}`,
    { quietMs: DAY_MS, now: now.getTime() },
  );
}

// ── Staff: the client WAS repaid outside the portal ────────────────────────────────────────────

/**
 * "Mark refunded": the way out of a post that is `refund_due` (or marked refunded with no refund of it on the ledger) when the client
 * has been repaid some other way (a staff member refunded the payment from the Razorpay dashboard). It records THAT refund against the
 * post instead of sending another, and nothing else:
 *   • the creator's payout must already be taken back (void or reversed): this never decides anything about the creator's money;
 *   • the payment's refund list is READ first (reconcile), and the refund recorded must be one Razorpay lists, filed as `external`, not
 *     yet attributed to any post, of at least this post's price. With more than one candidate the staff member names the refund id;
 *   • one refund can be recorded against one post only (an unattributed row is the only thing it will take).
 * Then the post is marked refunded and the booking moved on. Every refusal changes nothing.
 */
export async function markCreatorItemRefundedByHand(
  bookingId: string,
  itemId: string,
  staffId: string,
  o: { refundId?: string | null } = {},
): Promise<{ refundId: string; amountPaise: number }> {
  const item = await prisma.campaignBookingItem.findFirst({ where: { id: itemId, bookingId }, select: { id: true, bookingId: true, status: true, pricePaise: true, targetType: true, accountName: true } });
  if (!item) throw new AppError(404, "NOT_FOUND", "Item not found");
  if (item.targetType !== CREATOR_TARGET_TYPE) throw new AppError(409, "NOT_CREATOR_ITEM", "This isn't a creator's post.");
  if (item.status !== "refund_due" && item.status !== "refunded") throw new AppError(409, "INVALID_STATE", "Only a post that is waiting for its refund can be marked refunded.");
  if (item.status === "refunded" && (await prisma.campaignRefund.count({ where: { bookingItemId: item.id, status: { not: "failed" } } })) > 0) {
    throw new AppError(409, "ALREADY_REFUNDED", "This post's refund is already on record.");
  }
  const payout = await prisma.creatorPayout.findUnique({ where: { bookingItemId: item.id }, select: { status: true } });
  if (payout && payout.status !== "void" && payout.status !== "reversed") {
    throw new AppError(409, "PAYOUT_NOT_TAKEN_BACK", "The creator's payout has not been taken back yet. Take it back first (Reverse in the payout queue); the client is refunded after that. Nothing was changed.");
  }
  const pays = await prisma.campaignPayment.findMany({ where: { bookingId, razorpayPaymentId: { not: null } }, orderBy: { createdAt: "asc" }, select: { id: true } });
  if (pays.length === 0) throw new AppError(409, "NO_ONLINE_PAYMENT", "This campaign has no online payment, so there is no refund to record.");
  try {
    for (const p of pays) await reconcileRefunds(p.id);
  } catch {
    throw new AppError(502, "REFUNDS_UNREADABLE", "Razorpay's refund list could not be read just now, so nothing was recorded. Try again in a few minutes.");
  }
  const wanted = o.refundId?.trim() || null;
  const candidates = await prisma.campaignRefund.findMany({
    where: { paymentId: { in: pays.map((p) => p.id) }, origin: "external", bookingItemId: null, status: { not: "failed" }, amountPaise: { gte: item.pricePaise }, ...(wanted ? { razorpayRefundId: wanted } : {}) },
    orderBy: [{ amountPaise: "asc" }, { createdAt: "asc" }],
    select: { id: true, razorpayRefundId: true, amountPaise: true },
  });
  if (candidates.length === 0) {
    throw new AppError(
      409,
      "NO_EXTERNAL_REFUND",
      wanted
        ? "Razorpay lists no refund with that id on this campaign's payment that is large enough and not already recorded against another post. Check the id. Nothing was changed."
        : `Razorpay lists no refund of at least ${formatPaise(item.pricePaise)} on this campaign's payment that isn't already recorded against another post. Refund the client first (in Razorpay), then try again. Nothing was changed.`,
    );
  }
  const exact = candidates.filter((c) => c.amountPaise === item.pricePaise);
  const pick = wanted ? candidates[0] : exact.length === 1 ? exact[0] : candidates.length === 1 ? candidates[0] : null;
  if (!pick) {
    throw new AppError(409, "AMBIGUOUS_REFUND", `More than one refund on the payment could be this post's (${candidates.map((c) => `${c.razorpayRefundId} for ${formatPaise(c.amountPaise)}`).join(", ")}). Say which one. Nothing was changed.`);
  }
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM campaign_bookings WHERE id = ${bookingId} FOR UPDATE`;
    // One refund, one post: only an unattributed row is taken, under the lock.
    const taken = await tx.campaignRefund.updateMany({ where: { id: pick.id, origin: "external", bookingItemId: null }, data: { bookingItemId: item.id } });
    if (taken.count !== 1) throw new AppError(409, "REFUND_TAKEN", "That refund was just recorded against another post. Refresh and look again. Nothing was changed.");
    await tx.campaignBookingItem.updateMany({ where: { id: item.id, status: { in: ["refund_due", "refunded"] } }, data: { status: "refunded", lastError: null, nextAttemptAt: null } });
    await logBookingEvent(
      bookingId,
      { type: "staff", id: staffId },
      `Creator post on ${item.accountName}: marked refunded by hand. The client was repaid outside the portal (Razorpay refund ${pick.razorpayRefundId}, ${formatPaise(pick.amountPaise)}); it is recorded against this post. The creator's payout was already taken back.`.slice(0, 500),
      tx,
    );
  });
  try {
    if (await settleBooking(bookingId, { type: "staff", id: staffId })) void sendDeliveryEmail(bookingId).catch((e) => console.error("[campaign] delivery email failed", e));
    await maybeMarkRefunded(bookingId);
  } catch (err) {
    console.error(`[creator-refund] settling booking ${bookingId} failed: ${(err as Error)?.message ?? "error"}`.slice(0, 200));
  }
  return { refundId: pick.razorpayRefundId as string, amountPaise: pick.amountPaise };
}
