import type { Prisma } from "@dashmani/db";
import { PAUSABLE_STATUSES } from "./payout-states";

// The ONE rule for pausing a creator's payouts because something on the brand's payment changed
// (a dispute opened, a refund we did not make appeared). Kept in its own tiny module so the two
// writers of paused_at for a payment, the dispute handler (route-webhooks.ts) and the refund
// reconciler (payment.service.ts), share it without importing each other. Both call it from here;
// neither keeps a copy.
//
// ⚠️ The rule, and why it is not "pause everything of the payment":
//  • Only payouts that still have something in flight are paused (PAUSABLE_STATUSES, which is
//    exactly what isPausable() accepts). Pausing a settled, paid_manual, void or reversed payout
//    would only put "payout paused" in front of a creator who has been paid.
//  • The pause time and the reason are written TOGETHER, in one conditional update that matches
//    only a payout that is not paused yet. A payout already paused (for a dispute, a bank change,
//    or by staff) keeps its first reason: the single reason column cannot hold two.
//  • The audit row is written only for a payout this call actually paused, and its fromStatus is
//    the status read UNDER THE ROW LOCK, so it names the status the pause really sat on.
//  • Un-pausing is never automatic and is not done here.
//
// ⚠️ LOCK ORDER. The payouts are selected `ORDER BY id FOR UPDATE`, so every caller takes its row
// locks in ascending id order. A payment can carry several payouts (one per creator item), and two
// callers pausing the same payment at once (a dispute event and an external-refund reconcile) each
// lock the same rows: in any other order they can each hold one and wait for the other's, and
// Postgres kills one with a deadlock. Any other code that locks several creator_payouts rows in
// one transaction must lock them in id order too. The lock also means a transfer event cannot move
// a row between this read and this write.

type Tx = Prisma.TransactionClient;

export interface PauseSpec {
  /** creator_payouts.paused_reason: dispute | external_refund | … */
  reason: string;
  /** creator_payout_events.actor_type: system | razorpay … */
  actorType: string;
  /** The audit row's note. */
  note: string;
  /** x-razorpay-event-id when a webhook caused the pause (kept on the audit row). */
  eventId?: string | null;
  /** The staff member (creator_payout_events.actor_id) when a person caused the pause. */
  actorId?: string | null;
  /** The pause time; defaults to now. */
  at?: Date;
}

/** A payout this call paused, with the status the pause sits on. */
export interface PausedPayout {
  id: string;
  status: string;
}

/**
 * Pauses every pausable, not-yet-paused payout of one Razorpay payment, INSIDE the caller's
 * transaction, and returns the payouts it paused (empty when there was nothing to pause). The rows
 * are locked first in id order (see the lock order above), then ONE statement pauses them all and
 * ONE inserts their audit rows, so a failure anywhere rolls back with the caller's transaction.
 */
export async function pausePayoutsOfPaymentRows(tx: Tx, razorpayPaymentId: string, spec: PauseSpec): Promise<PausedPayout[]> {
  const rows = await tx.$queryRaw<Array<{ id: string; booking_id: string; status: string; amount_paise: number }>>`
    SELECT id, booking_id, status, amount_paise FROM creator_payouts
    WHERE razorpay_payment_id = ${razorpayPaymentId} AND paused_at IS NULL AND status = ANY(${[...PAUSABLE_STATUSES]})
    ORDER BY id
    FOR UPDATE`;
  if (rows.length === 0) return [];
  // The row filter is repeated in the statement itself, so the "not paused yet" and "still in
  // flight" conditions are enforced where the write happens, not only where the rows were read.
  await tx.creatorPayout.updateMany({
    where: { id: { in: rows.map((r) => r.id) }, pausedAt: null, status: { in: [...PAUSABLE_STATUSES] } },
    data: { pausedAt: spec.at ?? new Date(), pausedReason: spec.reason },
  });
  await tx.creatorPayoutEvent.createMany({
    data: rows.map((r) => ({
      payoutId: r.id,
      bookingId: r.booking_id,
      kind: "pause",
      fromStatus: r.status,
      toStatus: r.status,
      amountPaise: r.amount_paise,
      actorType: spec.actorType,
      razorpayEventId: spec.eventId ? spec.eventId.slice(0, 100) : null,
      actorId: spec.actorId ?? null,
      note: spec.note,
    })),
  });
  return rows.map((r) => ({ id: r.id, status: r.status }));
}

/**
 * The same pause for every pausable, not-yet-paused payout OF ONE CREATOR: staff suspended (or rejected) the creator, and nothing of
 * theirs may pay out until a person decides. It is the very rule above (only payouts with something in flight; a payout already
 * paused for a dispute, a bank change or by staff keeps its first reason; the audit row only for a payout this call paused; locked in
 * id order), keyed on the creator instead of the payment. It runs INSIDE the transaction that changes the creator's status, so a
 * suspension can never commit without it. Reinstating does NOT undo it: staff resume each payout deliberately.
 */
export async function pausePayoutsOfCreatorRows(tx: Tx, creatorId: string, spec: PauseSpec): Promise<PausedPayout[]> {
  const rows = await tx.$queryRaw<Array<{ id: string; booking_id: string; status: string; amount_paise: number }>>`
    SELECT id, booking_id, status, amount_paise FROM creator_payouts
    WHERE creator_id = ${creatorId} AND paused_at IS NULL AND status = ANY(${[...PAUSABLE_STATUSES]})
    ORDER BY id
    FOR UPDATE`;
  if (rows.length === 0) return [];
  await tx.creatorPayout.updateMany({
    where: { id: { in: rows.map((r) => r.id) }, pausedAt: null, status: { in: [...PAUSABLE_STATUSES] } },
    data: { pausedAt: spec.at ?? new Date(), pausedReason: spec.reason },
  });
  await tx.creatorPayoutEvent.createMany({
    data: rows.map((r) => ({
      payoutId: r.id,
      bookingId: r.booking_id,
      kind: "pause",
      fromStatus: r.status,
      toStatus: r.status,
      amountPaise: r.amount_paise,
      actorType: spec.actorType,
      razorpayEventId: spec.eventId ? spec.eventId.slice(0, 100) : null,
      actorId: spec.actorId ?? null,
      note: spec.note,
    })),
  });
  return rows.map((r) => ({ id: r.id, status: r.status }));
}

/** The same pause, reporting only how many payouts it paused. */
export async function pausePayoutsOfPayment(tx: Tx, razorpayPaymentId: string, spec: PauseSpec): Promise<number> {
  return (await pausePayoutsOfPaymentRows(tx, razorpayPaymentId, spec)).length;
}
