import type { Prisma } from "@dashmani/db";
import { PAYOUT_STATUSES, isPausable, type PayoutStatus } from "./payout-states";

// The ONE rule for pausing a creator's payouts because something on the brand's payment changed
// (a dispute opened, a refund we did not make appeared). Kept in its own tiny module so the
// webhook handlers (route-webhooks.ts) and the refund reconciler (payment.service.ts) share it
// without importing each other.
//
// ⚠️ The rule, and why it is not "pause everything of the payment":
//  • Only payouts that still have something in flight are paused (`isPausable`). Pausing a
//    settled, paid_manual, void or reversed payout would only put "payout paused" in front of a
//    creator who has been paid.
//  • The pause time and the reason are written TOGETHER, in one conditional update that matches
//    only a payout that is not paused yet. A payout already paused (for a dispute, a bank change,
//    or by staff) keeps its first reason: the single reason column cannot hold two.
//  • The audit row is written only for a payout this call actually paused.
//  • Un-pausing is never automatic and is not done here.

type Tx = Prisma.TransactionClient;

/** Statuses a pause means something for. */
export const PAUSABLE_PAYOUT_STATUSES: PayoutStatus[] = PAYOUT_STATUSES.filter((s) => isPausable(s));

export interface PauseSpec {
  /** creator_payouts.paused_reason: dispute | external_refund | … */
  reason: string;
  /** creator_payout_events.actor_type: system | razorpay … */
  actorType: string;
  /** The audit row's note. */
  note: string;
  /** x-razorpay-event-id when a webhook caused the pause (kept on the audit row). */
  eventId?: string | null;
  /** The pause time; defaults to now. */
  at?: Date;
}

/**
 * Pause every pausable, not-yet-paused payout of one Razorpay payment, inside the caller's
 * transaction. Returns how many payouts this call actually paused.
 */
export async function pausePayoutsOfPayment(tx: Tx, razorpayPaymentId: string, spec: PauseSpec): Promise<number> {
  const rows = await tx.creatorPayout.findMany({
    where: { razorpayPaymentId, pausedAt: null, status: { in: PAUSABLE_PAYOUT_STATUSES } },
    select: { id: true, bookingId: true, status: true, amountPaise: true },
  });
  let paused = 0;
  for (const r of rows) {
    // Re-checked in the statement itself: a concurrent pause or a settle between the read and here changes nothing.
    const u = await tx.creatorPayout.updateMany({
      where: { id: r.id, pausedAt: null, status: { in: PAUSABLE_PAYOUT_STATUSES } },
      data: { pausedAt: spec.at ?? new Date(), pausedReason: spec.reason },
    });
    if (u.count !== 1) continue;
    await tx.creatorPayoutEvent.create({
      data: {
        payoutId: r.id,
        bookingId: r.bookingId,
        kind: "pause",
        fromStatus: r.status,
        toStatus: r.status,
        amountPaise: r.amountPaise,
        actorType: spec.actorType,
        razorpayEventId: spec.eventId ? spec.eventId.slice(0, 100) : null,
        note: spec.note,
      },
    });
    paused++;
  }
  return paused;
}
