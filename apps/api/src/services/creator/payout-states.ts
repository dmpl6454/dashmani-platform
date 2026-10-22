/**
 * The creator-payout state machine, as data. PURE: no database, no Razorpay, no clock, no
 * imports. The webhook handlers (campaign/route-webhooks.ts) and the reconciliation job
 * both decide through this one table, so "which move is legal" has exactly one answer.
 *
 * The statuses are the Phase 4 "Payout states" table of
 * docs/superpowers/plans/2026-10-12-creator-payouts-razorpay-route.md ("P4 table" below). Each
 * edge cites where the plan (or a Razorpay doc, [R#]) justifies it, so a reviewer can check
 * the table against the plan instead of trusting it.
 *
 * ⚠️ WHY IT IS A TABLE AND NOT `if` CHAINS. Razorpay redelivers events, delivers them out of
 * order, and a handler can crash between two writes. Every status change is therefore applied
 * as ONE conditional update (`WHERE status IN (the states this move is legal from)`), and
 * "legal from" is read from here. A duplicate or stale event then matches no row and changes
 * nothing; there is no read-then-write window for a replay to slip through.
 *
 * Moves are of five kinds (informational; canMove() does not distinguish them):
 *   forward  progress along the happy path, or to a definite outcome.
 *   rollback a CLAIM is put back after a definite rejection (release_requested → held ...).
 *   park     → needs_attention: the facts and our row disagree, or a result stayed unknown.
 *   resolve  needs_attention → anything, after a FRESH fetch shows what really happened.
 *   retry    failed → transfer_requested (staff Retry, which Phase 4 disables once a refund exists).
 *
 * "No skipping states": a claim state sits between every pair of states that need an API call
 * (held → release_requested → released), because the claim is what makes a crash between "we
 * asked Razorpay" and "Razorpay answered" recoverable. held → released directly is therefore
 * NOT an edge, and neither is planned → held or release_requested → settled.
 *
 * A move to the state a row is already in is not a move: canMove(s, s) is false, and applying
 * the same fact twice leaves the second application a no-op.
 */

export const PAYOUT_STATUSES = [
  "planned",
  "transfer_requested",
  "held",
  "release_requested",
  "released",
  "settled",
  "settlement_failed",
  "reversal_requested",
  "reversed",
  "failed",
  "needs_attention",
  "manual_required",
  "paid_manual",
  "void",
] as const;

export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

export type MoveKind = "forward" | "rollback" | "park" | "resolve" | "retry";

export interface Transition {
  to: PayoutStatus;
  kind: MoveKind;
  /** Where the plan or Razorpay's docs justify the edge. */
  source: string;
}

const t = (to: PayoutStatus, kind: MoveKind, source: string): Transition => ({ to, kind, source });

// Sources, written once. "P4" is the plan's Phase 4 section.
const SRC_CLAIM = "P4 Transfers: the status moves BEFORE Razorpay is asked, so a crash leaves a row to reconcile, never a silent transfer";
const SRC_VOID =
  "P4 table 'void: never transferred' and P4 Reject step 3 ('void planned and failed payouts'): decline, expiry, withdrawal, missed window, take-over or rejection before any money moved";
const SRC_MANUAL = "P4 'When refunds are allowed' and P4 Manual fallback: Route cannot pay this creator, so staff pay by bank transfer";
const SRC_PARK_FRESH = "P4 table 'needs_attention' and reconciliation job 9: a fresh read of the transfer disagrees with our row (for example a dashboard action)";
const SRC_RESOLVE = "P4 table 'needs_attention': staff or the cron move it on once a FRESH fetch shows what really happened";

/**
 * Every legal move out of each status. Terminal statuses (settled, paid_manual, void) have
 * none. `reversed` has one, manual_required, for the "reverse first, then pay by hand" path.
 */
export const TRANSITIONS: Readonly<Record<PayoutStatus, readonly Transition[]>> = {
  planned: [
    t("transfer_requested", "forward", SRC_CLAIM),
    t("void", "forward", SRC_VOID),
    t("manual_required", "forward", SRC_MANUAL),
  ],
  transfer_requested: [
    t("held", "forward", "P4 table 'held': Razorpay reports processed, on_hold:true and no on_hold_until [R10][R11]"),
    t("failed", "forward", "P4 table 'failed': a definite rejection, or the transfer.failed event [R10]"),
    t("needs_attention", "park", "P4 table 'needs_attention': an unknown result after the retry cap, a duplicate transfer, or processed-but-not-held [R11]"),
  ],
  held: [
    t("release_requested", "forward", "P4 Release: the claim is updateMany WHERE status='held' AND paused_at IS NULL"),
    t("reversal_requested", "forward", "P4 Reversal and 'Reverse before refunding': every unwind claims the reversal first"),
    t("needs_attention", "park", SRC_PARK_FRESH),
  ],
  release_requested: [
    t("released", "forward", "P4 table: 'release claimed, then confirmed'"),
    t("held", "rollback", "P4 Release: a definite rejection puts the claim back (same rule as the Reversal's definite 4xx)"),
    t("needs_attention", "park", "P4 reconciliation job 6: a stale release that cannot be resolved by re-reading the transfer"),
  ],
  released: [
    t("settled", "forward", "R21 / P4 table: recipient_settlement.status processed, with its bank UTR"),
    t("settlement_failed", "forward", "R21 / P4 table: recipient_settlement.status failed"),
    t("reversal_requested", "forward", "P4 Disputes and Manual fallback: a released payout that has not settled is reversed while settlement is still pending [R17]"),
    t("held", "rollback", "P4 Disputes: re-held with PATCH on_hold:true (UNVERIFIED, plan question d)"),
    t("needs_attention", "park", SRC_PARK_FRESH),
  ],
  settlement_failed: [
    t("settled", "forward", "UNVERIFIED: the bank rejected the settlement and Razorpay later settled it (plan question c); settled is only ever set from a processed settlement"),
    t("reversal_requested", "forward", "P4 Manual fallback: the money is still in the linked account, so reverse first, then pay by hand"),
    t("needs_attention", "park", SRC_PARK_FRESH),
  ],
  reversal_requested: [
    t("reversed", "forward", "P4 table: 'reversal claimed, then confirmed'"),
    t("held", "rollback", "P4 Reversal: 'a definite 4xx puts the payout back in held and alerts staff'"),
    t("released", "rollback", "P4 Reversal, same rule, when the payout was released at the moment the reversal was claimed (disputes)"),
    t("needs_attention", "park", "P4 Reversal: an unknown result stays reversal_requested and is reconciled; past the cap it needs a human"),
  ],
  reversed: [
    t("manual_required", "forward", "P4 Manual fallback: 'if an account is suspended while holding money, reverse first, then pay by hand'"),
  ],
  failed: [
    t("transfer_requested", "retry", "P4 table: 'failed' is a definite rejection; staff may Retry (disabled once any refund exists on the payment)"),
    t("manual_required", "forward", SRC_MANUAL),
    t("void", "forward", SRC_VOID),
    t("needs_attention", "park", "P4 Transfers: a duplicate transfer carrying this payout_id was found"),
  ],
  needs_attention: [
    t("transfer_requested", "resolve", SRC_RESOLVE),
    t("held", "resolve", SRC_RESOLVE),
    t("released", "resolve", SRC_RESOLVE),
    t("settled", "resolve", SRC_RESOLVE),
    t("settlement_failed", "resolve", SRC_RESOLVE),
    t("failed", "resolve", SRC_RESOLVE),
    t("reversal_requested", "resolve", SRC_RESOLVE),
    t("reversed", "resolve", SRC_RESOLVE),
    t("manual_required", "resolve", SRC_RESOLVE),
    t("void", "resolve", SRC_RESOLVE),
  ],
  manual_required: [
    t("paid_manual", "forward", "P4 Manual fallback; the CALLER enforces its three conditions (no transfer ever created, a fresh fetch shows failed with no other active transfer, or the payout is reversed)"),
    t("void", "forward", "P4 Reject: nothing is due once the booking is rejected before money moved"),
    t("needs_attention", "park", "A live transfer carrying this payout's id turned up after all (a create call that landed late): it must be reversed, so a person looks"),
  ],
  settled: [],
  paid_manual: [],
  void: [],
};

export function isPayoutStatus(v: unknown): v is PayoutStatus {
  return typeof v === "string" && (PAYOUT_STATUSES as readonly string[]).includes(v);
}

/** The legal next statuses of `from` (empty for a terminal or unknown one). */
export function nextStatuses(from: string): PayoutStatus[] {
  return isPayoutStatus(from) ? TRANSITIONS[from].map((x) => x.to) : [];
}

/** True when `to` is a legal move out of `from`. A status never moves to itself. */
export function canMove(from: string, to: string): boolean {
  if (!isPayoutStatus(from) || !isPayoutStatus(to)) return false;
  return TRANSITIONS[from].some((x) => x.to === to);
}

/** No exit at all: settled, paid_manual and void. (`reversed` has one, to manual_required.) */
export function isTerminal(status: string): boolean {
  return isPayoutStatus(status) && TRANSITIONS[status].length === 0;
}

const MONEY_AT_RISK: ReadonlySet<string> = new Set([
  "transfer_requested",
  "held",
  "release_requested",
  "released",
  "settlement_failed",
  "reversal_requested",
  "needs_attention",
]);

/**
 * True while the creator's share may be sitting OUTSIDE our Razorpay balance with the outcome
 * still open: in a linked account (held or released), in flight to or from it, or of unknown
 * state (transfer_requested and needs_attention are counted because the create call may have
 * succeeded). These are the states that need a reversal before the item can be refunded, and
 * that the "suspended account holding money" alert is about.
 *
 * Not at risk: planned (nothing moved), failed (Razorpay refused), void and reversed (nothing
 * out, or it came back), settled and paid_manual (delivered, done), manual_required (nothing
 * out, or it came back; the money is owed, not at risk).
 */
export function isMoneyAtRisk(status: string): boolean {
  return MONEY_AT_RISK.has(status);
}

/**
 * P4 "Reserved amount": a creator item's price is refundable only once its payout is reversed
 * or void. Every other status (even failed, manual_required and settled) still reserves it.
 */
export function reservesItemPrice(status: string): boolean {
  return isPayoutStatus(status) && status !== "reversed" && status !== "void";
}

/**
 * Whether the paused_at overlay means anything. A payout with nothing in flight (settled,
 * paid_manual, void, reversed) is left alone: pausing it would only put "payout paused" in
 * front of a creator who has been paid.
 */
export function isPausable(status: string): boolean {
  return isPayoutStatus(status) && !["settled", "paid_manual", "void", "reversed"].includes(status);
}

/**
 * Every status isPausable() accepts, as a list a WHERE clause can use. One definition, so the
 * dispute handler and the external-refund reconcile, which both pause through
 * services/creator/payout-pause.ts, pause exactly the same rows. A pause is only ever written to a
 * row still in one of these AND not already paused: the first reason wins, and a settled or void
 * payout never shows "paused".
 */
export const PAUSABLE_STATUSES: readonly PayoutStatus[] = PAYOUT_STATUSES.filter((s) => isPausable(s));

// ── Mapping what Razorpay reports onto a move ───────────────────────────────────

/**
 * What Razorpay says about one transfer, normalised. Built from a webhook payload or from a
 * fresh fetch: the decision below is the same for both, which is the point. null means "not
 * reported", and nothing here ever treats an unreported field as false or zero.
 */
export interface TransferFacts {
  /** The transfer's status: created | pending | processed | failed | reversed | partially_reversed. */
  status: string | null;
  onHold: boolean | null;
  onHoldUntil: number | null;
  amount: number | null;
  amountReversed: number | null;
  /** The transfer's settlement_status: pending | on_hold | settled. Informational here. */
  settlementStatus: string | null;
  /** recipient_settlement.status: processed | failed. What moves a payout to settled. */
  recipientSettlementStatus: string | null;
}

export interface TransferMove {
  /** The status to move to. Absent: nothing to do (see `reason`). */
  to?: PayoutStatus;
  /** A stable code: why it moves, or why it does not. Safe to store and to show staff. */
  reason: string;
  /** Staff should hear about it now. */
  alert?: boolean;
}

// The only states each fact may move a row OUT of. Narrower than the table on purpose: a late
// or replayed event must never drag a row that has moved on, and a needs_attention row is only
// ever resolved by a human or a fresh fetch, never by an event.
const SETTLED_FROM: readonly PayoutStatus[] = ["released", "settlement_failed"];
const SETTLEMENT_FAILED_FROM: readonly PayoutStatus[] = ["released"];
const HELD_FROM: readonly PayoutStatus[] = ["transfer_requested"];
const FAILED_FROM: readonly PayoutStatus[] = ["transfer_requested"];
const REVERSED_FROM: readonly PayoutStatus[] = ["reversal_requested"];
// Where a full or partial reversal we did not ask for is an anomaly worth a human (it happened
// outside our flow: a dashboard action, or Razorpay itself).
const OUTSIDE_REVERSAL_FROM: readonly PayoutStatus[] = ["transfer_requested", "held", "release_requested", "released", "settlement_failed"];

/**
 * The move that Razorpay's facts imply for a payout currently in `current`.
 *
 * Priority, because facts can overlap: a processed recipient settlement, a failed one, a full
 * reversal, a partial reversal, a failed transfer, and only then a processed transfer. The
 * result is always either nothing (with a reason) or a move that canMove() allows; the tests
 * check that invariant for every status.
 *
 * "held" is claimed ONLY for processed + on_hold:true + no on_hold_until [P4 table]: an
 * unreported on_hold is never read as true, and a transfer that is processed but not held
 * (or that Razorpay will auto-release) parks the payout in needs_attention instead, because
 * saying "held" there would let a release later "confirm" something that already left.
 */
export function mapTransferEvent(current: string, facts: TransferFacts): TransferMove {
  if (!isPayoutStatus(current)) return { reason: "unknown_status" };
  if (isTerminal(current)) return { reason: "terminal" };

  /** `to` if the row is in one of `from`, else the right "nothing to do" reason. */
  const move = (to: PayoutStatus, from: readonly PayoutStatus[], reason: string, alert = false): TransferMove => {
    if (current === to) return { reason: "unchanged" };
    if (!from.includes(current)) return { reason: "stale" };
    return alert ? { to, reason, alert: true } : { to, reason };
  };

  const status = facts.status;
  const amount = facts.amount;
  const reversed = facts.amountReversed;

  if (facts.recipientSettlementStatus === "processed") return move("settled", SETTLED_FROM, "settled");
  if (facts.recipientSettlementStatus === "failed") return move("settlement_failed", SETTLEMENT_FAILED_FROM, "settlement_failed", true);

  const fullyReversed = status === "reversed" || (amount !== null && amount > 0 && reversed !== null && reversed >= amount);
  if (fullyReversed) {
    if (current === "reversal_requested" || current === "reversed") return move("reversed", REVERSED_FROM, "reversed");
    return move("needs_attention", OUTSIDE_REVERSAL_FROM, "reversed_outside_flow", true);
  }

  const partlyReversed = status === "partially_reversed" || (reversed !== null && reversed > 0 && amount !== null && reversed < amount);
  if (partlyReversed) {
    if (current === "reversal_requested") return { reason: "reversal_in_flight" };
    return move("needs_attention", OUTSIDE_REVERSAL_FROM, "partially_reversed", true);
  }

  if (status === "failed") return move("failed", FAILED_FROM, "failed");

  if (status === "processed") {
    if (facts.onHold === null) return { reason: "on_hold_unreported" };
    if (facts.onHold === false) return move("needs_attention", HELD_FROM, "processed_not_held", true);
    if (facts.onHoldUntil !== null) return move("needs_attention", HELD_FROM, "processed_hold_expires", true);
    return move("held", HELD_FROM, "held");
  }

  if (status === "created" || status === "pending") return { reason: "in_flight" };
  return { reason: "no_facts" };
}
