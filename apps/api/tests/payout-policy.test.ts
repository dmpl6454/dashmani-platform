/**
 * The payout DECISIONS (services/creator/payout-policy.ts): pure functions, so they are tested as tables.
 *
 * What these pin, because each is a way to lose or double-pay money:
 *   - the release gate says ok ONLY when every precondition holds at once. Every refusal reason has a test
 *     that breaks exactly that one precondition, and a property test over thousands of random fact sets
 *     proves "ok" and "all preconditions hold" are the same statement;
 *   - an unread fact is a refusal of its own, never the good value;
 *   - a transfer is created again only after two empty listings far enough apart, once;
 *   - a reversal's amount is always explicit and never negative, and an unknown answer is not an outcome;
 *   - no refund while a transfer can still be created, and a refund on the payment makes a transfer manual;
 *   - paid_manual only when no transfer can still release;
 *   - a fresh read of the transfer only ever proposes a move the state table allows.
 */
import { describe, it, expect } from "vitest";
import {
  ABSENT_CHECK_GAP_MS,
  MAX_CREATE_ATTEMPTS,
  MIN_TRANSFER_PAISE,
  RELEASE_REFUSALS,
  canRetryFailedTransfer,
  decideManualFallback,
  decideRefundAllowed,
  decideRefundVerdict,
  decideResume,
  decideReversal,
  decideReversalOutcome,
  decideTransferCreation,
  decideTransferRetry,
  evaluateLocalRelease,
  evaluateRelease,
  heldAnomalyBackoffMs,
  isFullyReversed,
  mapTransferFactsToState,
  plannedWaitBackoffMs,
  releaseAfter,
  releaseRefusalBackoffMs,
  remainingToReverse,
  requestKeyOf,
  reservedPaiseOf,
  type CarrierTransfer,
  type CreateFacts,
  type ReleaseFacts,
  type ReleaseRefusal,
  type TransferRetryFacts,
} from "../src/services/creator/payout-policy";
import { PAYOUT_STATUSES, canMove, type TransferFacts } from "../src/services/creator/payout-states";

const NOW = new Date("2026-10-18T10:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MIN = 60_000;

/** Facts under which a release is allowed. Each refusal test below breaks exactly one thing. */
function good(): ReleaseFacts {
  return {
    now: NOW,
    releaseEnabled: true,
    payout: { status: "held", pausedAt: null, releaseAfter: ago(MIN), amountPaise: 50_000, transferId: "trf_A1", razorpayAccountId: "acc_A1", razorpayPaymentId: "pay_A1" },
    booking: { status: "approved" },
    item: { status: "posted_manual" },
    offer: { status: "completed", linkVerifiedAt: ago(2 * MIN), ownershipCheck: "auto_ok" },
    disputeStatuses: [],
    bankChangeBlocks: false,
    creatorStatus: "approved",
    byStaff: false,
    accountActivation: "activated",
    transfer: { id: "trf_A1", status: "processed", onHold: true, onHoldUntil: null, amount: 50_000, amountReversed: 0, recipient: "acc_A1", source: "pay_A1" },
    duplicateTransfers: "none",
    razorpayDisputes: "clear",
    razorpayRefunds: "clear",
    account: "activated",
  };
}

const withPayout = (f: ReleaseFacts, over: Partial<ReleaseFacts["payout"]>): ReleaseFacts => ({ ...f, payout: { ...f.payout, ...over } });
const withTransfer = (f: ReleaseFacts, over: Partial<NonNullable<ReleaseFacts["transfer"]>>): ReleaseFacts => ({ ...f, transfer: { ...f.transfer!, ...over } });
const withOffer = (f: ReleaseFacts, over: Partial<NonNullable<ReleaseFacts["offer"]>>): ReleaseFacts => ({ ...f, offer: { ...f.offer!, ...over } });

/** One refusal reason → facts that break exactly that precondition. */
const BREAKS: Record<ReleaseRefusal, (f: ReleaseFacts) => ReleaseFacts> = {
  release_paused: (f) => ({ ...f, releaseEnabled: false }),
  payout_not_held: (f) => withPayout(f, { status: "release_requested" }),
  payout_paused: (f) => withPayout(f, { pausedAt: ago(MIN) }),
  no_transfer: (f) => withPayout(f, { transferId: null }),
  creator_not_active: (f) => ({ ...f, creatorStatus: "suspended" }),
  booking_not_releasable: (f) => ({ ...f, booking: { status: "rejected" } }),
  item_not_live: (f) => ({ ...f, item: { status: "manual_pending" } }),
  offer_missing: (f) => ({ ...f, offer: null }),
  offer_not_completed: (f) => withOffer(f, { status: "accepted" }),
  link_not_verified: (f) => withOffer(f, { linkVerifiedAt: null }),
  ownership_unchecked: (f) => withOffer(f, { ownershipCheck: "auto_failed" }),
  dispute_recorded: (f) => ({ ...f, disputeStatuses: ["open"] }),
  bank_change_pending: (f) => ({ ...f, bankChangeBlocks: true }),
  release_not_scheduled: (f) => withPayout(f, { releaseAfter: null }),
  release_not_due: (f) => withPayout(f, { releaseAfter: new Date(NOW.getTime() + MIN) }),
  transfer_unreadable: (f) => ({ ...f, transfer: null }),
  transfer_mismatch: (f) => withTransfer(f, { amount: 49_999 }),
  transfer_not_processed: (f) => withTransfer(f, { status: "pending" }),
  transfer_not_on_hold: (f) => withTransfer(f, { onHold: false }),
  transfer_hold_expires: (f) => withTransfer(f, { onHoldUntil: 1_800_000_000 }),
  transfer_reversed: (f) => withTransfer(f, { amountReversed: 1 }),
  duplicate_transfer: (f) => ({ ...f, duplicateTransfers: "found" }),
  duplicate_unchecked: (f) => ({ ...f, duplicateTransfers: "unchecked" }),
  dispute_at_razorpay: (f) => ({ ...f, razorpayDisputes: "blocking" }),
  dispute_unchecked: (f) => ({ ...f, razorpayDisputes: "unchecked" }),
  refund_at_razorpay: (f) => ({ ...f, razorpayRefunds: "unaccounted" }),
  refund_unchecked: (f) => ({ ...f, razorpayRefunds: "unchecked" }),
  account_not_activated: (f) => ({ ...f, account: "not_activated" }),
  account_unchecked: (f) => ({ ...f, account: "unchecked" }),
};

describe("evaluateRelease: the release gate", () => {
  it("allows a release when every precondition holds", () => {
    expect(evaluateRelease(good())).toEqual({ ok: true });
  });

  it("has a test for every refusal reason, and no reason outside the closed set", () => {
    expect(Object.keys(BREAKS).sort()).toEqual([...RELEASE_REFUSALS].sort());
  });

  it("refuses each reason, and names exactly it, when only that one precondition is broken", () => {
    for (const reason of RELEASE_REFUSALS) {
      const d = evaluateRelease(BREAKS[reason](good()));
      expect(d, reason).toEqual({ ok: false, reason });
    }
  });

  it("treats every dispute status except won as blocking, locally and at Razorpay", () => {
    for (const s of ["open", "under_review", "action_required", "lost", "closed", "", "something_new"]) {
      expect(evaluateRelease({ ...good(), disputeStatuses: [s] }), s).toEqual({ ok: false, reason: "dispute_recorded" });
    }
    expect(evaluateRelease({ ...good(), disputeStatuses: ["won"] })).toEqual({ ok: true });
    // One lost dispute among several won ones still blocks.
    expect(evaluateRelease({ ...good(), disputeStatuses: ["won", "lost", "won"] })).toEqual({ ok: false, reason: "dispute_recorded" });
  });

  it("only releases for a booking that was approved on, and only for a live item", () => {
    for (const s of ["draft", "awaiting_payment", "paid_pending_review", "changes_requested", "rejected", "refunded", "cancelled", "expired", "unknown"]) {
      expect(evaluateRelease({ ...good(), booking: { status: s } }), s).toEqual({ ok: false, reason: "booking_not_releasable" });
    }
    for (const s of ["approved", "publishing", "completed", "partially_published"]) expect(evaluateRelease({ ...good(), booking: { status: s } }), s).toEqual({ ok: true });
    for (const s of ["pending", "manual_pending", "queued", "failed", "refunded", "awaiting_creator", "refund_due"]) {
      expect(evaluateRelease({ ...good(), item: { status: s } }), s).toEqual({ ok: false, reason: "item_not_live" });
    }
    for (const s of ["posted_manual", "published"]) expect(evaluateRelease({ ...good(), item: { status: s } }), s).toEqual({ ok: true });
    expect(evaluateRelease({ ...good(), booking: null })).toEqual({ ok: false, reason: "booking_not_releasable" });
    expect(evaluateRelease({ ...good(), item: null })).toEqual({ ok: false, reason: "item_not_live" });
  });

  it("needs both the completed offer status and the verified timestamp, and a passed ownership check", () => {
    for (const status of ["offered", "accepted", "declined", "expired", "withdrawn"]) expect(evaluateRelease(withOffer(good(), { status })), status).toEqual({ ok: false, reason: "offer_not_completed" });
    for (const oc of [null, "auto_failed", "unverifiable", "", "AUTO_OK"]) expect(evaluateRelease(withOffer(good(), { ownershipCheck: oc })), String(oc)).toEqual({ ok: false, reason: "ownership_unchecked" });
    expect(evaluateRelease(withOffer(good(), { ownershipCheck: "manual_ok" }))).toEqual({ ok: true });
  });

  it("releases at exactly release_after, not a moment before", () => {
    expect(evaluateRelease(withPayout(good(), { releaseAfter: NOW }))).toEqual({ ok: true });
    expect(evaluateRelease(withPayout(good(), { releaseAfter: new Date(NOW.getTime() + 1) }))).toEqual({ ok: false, reason: "release_not_due" });
  });

  it("refuses a transfer that is not exactly the one we set aside", () => {
    expect(evaluateRelease(withTransfer(good(), { id: "trf_OTHER" }))).toEqual({ ok: false, reason: "transfer_mismatch" });
    expect(evaluateRelease(withTransfer(good(), { recipient: "acc_OTHER" }))).toEqual({ ok: false, reason: "transfer_mismatch" });
    expect(evaluateRelease(withTransfer(good(), { source: "pay_OTHER" }))).toEqual({ ok: false, reason: "transfer_mismatch" });
    expect(evaluateRelease(withTransfer(good(), { amount: 50_001 }))).toEqual({ ok: false, reason: "transfer_mismatch" });
    // A transfer whose source Razorpay did not report is judged on the rest.
    expect(evaluateRelease(withTransfer(good(), { source: null }))).toEqual({ ok: true });
    for (const status of ["created", "pending", "failed", "reversed", "partially_reversed", ""]) expect(evaluateRelease(withTransfer(good(), { status })), status).toEqual({ ok: false, reason: "transfer_not_processed" });
  });

  it("a local refusal comes before anything asked of Razorpay, and evaluateLocalRelease ignores the Razorpay facts", () => {
    const unread: ReleaseFacts = { ...good(), transfer: null, duplicateTransfers: "unchecked", razorpayDisputes: "unchecked", razorpayRefunds: "unchecked", account: "unchecked" };
    expect(evaluateLocalRelease(unread)).toEqual({ ok: true });
    expect(evaluateLocalRelease({ ...unread, releaseEnabled: false })).toEqual({ ok: false, reason: "release_paused" });
    expect(evaluateRelease(unread)).toEqual({ ok: false, reason: "transfer_unreadable" });
  });

  it("PROPERTY: over 20,000 random fact sets, ok is exactly 'every precondition holds'", () => {
    // A small deterministic PRNG so a failure reproduces.
    let seed = 0x2f6e2b1;
    const rnd = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
    // Each field is drawn mostly from the good value, sometimes from a bad one, so both sides get exercised.
    const mostly = <T>(goodV: T, bad: readonly T[], p = 0.8): T => (rnd() < p ? goodV : pick(bad));

    let okCount = 0;
    for (let i = 0; i < 20_000; i++) {
      const f: ReleaseFacts = {
        now: NOW,
        releaseEnabled: mostly(true, [false]),
        payout: {
          status: mostly("held", ["planned", "released", "release_requested", "needs_attention"]),
          pausedAt: mostly<Date | null>(null, [ago(MIN)]),
          releaseAfter: mostly<Date | null>(ago(MIN), [null, new Date(NOW.getTime() + MIN)]),
          amountPaise: 50_000,
          transferId: mostly<string | null>("trf_A1", [null]),
          razorpayAccountId: "acc_A1",
          razorpayPaymentId: "pay_A1",
        },
        booking: mostly<{ status: string } | null>({ status: "approved" }, [null, { status: "rejected" }, { status: "refunded" }, { status: "paid_pending_review" }]),
        item: mostly<{ status: string } | null>({ status: "posted_manual" }, [null, { status: "manual_pending" }, { status: "refunded" }, { status: "published" }]),
        offer: mostly<ReleaseFacts["offer"]>({ status: "completed", linkVerifiedAt: ago(MIN), ownershipCheck: "auto_ok" }, [
          null,
          { status: "accepted", linkVerifiedAt: ago(MIN), ownershipCheck: "auto_ok" },
          { status: "completed", linkVerifiedAt: null, ownershipCheck: "auto_ok" },
          { status: "completed", linkVerifiedAt: ago(MIN), ownershipCheck: null },
          { status: "completed", linkVerifiedAt: ago(MIN), ownershipCheck: "manual_ok" },
        ]),
        disputeStatuses: mostly<string[]>([], [["open"], ["won"], ["lost"], ["won", "closed"]]),
        bankChangeBlocks: mostly(false, [true]),
        creatorStatus: mostly<string | null>("approved", [null, "suspended", "rejected", "closed", "in_review", "draft", "weird"], 0.9),
        byStaff: mostly(false, [true], 0.7),
        accountActivation: mostly<string | null>("activated", [null, "suspended", "needs_clarification", "under_review"], 0.9),
        transfer: mostly<ReleaseFacts["transfer"]>({ id: "trf_A1", status: "processed", onHold: true, onHoldUntil: null, amount: 50_000, amountReversed: 0, recipient: "acc_A1", source: "pay_A1" }, [
          null,
          { id: "trf_A1", status: "pending", onHold: true, onHoldUntil: null, amount: 50_000, amountReversed: 0, recipient: "acc_A1", source: "pay_A1" },
          { id: "trf_A1", status: "processed", onHold: false, onHoldUntil: null, amount: 50_000, amountReversed: 0, recipient: "acc_A1", source: "pay_A1" },
          { id: "trf_A1", status: "processed", onHold: true, onHoldUntil: 1_800_000_000, amount: 50_000, amountReversed: 0, recipient: "acc_A1", source: "pay_A1" },
          { id: "trf_A1", status: "processed", onHold: true, onHoldUntil: null, amount: 50_000, amountReversed: 100, recipient: "acc_A1", source: "pay_A1" },
          { id: "trf_A1", status: "processed", onHold: true, onHoldUntil: null, amount: 60_000, amountReversed: 0, recipient: "acc_A1", source: "pay_A1" },
          { id: "trf_A1", status: "processed", onHold: true, onHoldUntil: null, amount: 50_000, amountReversed: 0, recipient: "acc_X", source: "pay_A1" },
          { id: "trf_B", status: "processed", onHold: true, onHoldUntil: null, amount: 50_000, amountReversed: 0, recipient: "acc_A1", source: "pay_A1" },
        ]),
        duplicateTransfers: mostly<ReleaseFacts["duplicateTransfers"]>("none", ["found", "unchecked"], 0.9),
        razorpayDisputes: mostly<ReleaseFacts["razorpayDisputes"]>("clear", ["blocking", "unchecked"]),
        razorpayRefunds: mostly<ReleaseFacts["razorpayRefunds"]>("clear", ["unaccounted", "covers_item", "unchecked"], 0.9),
        account: mostly<ReleaseFacts["account"]>("activated", ["not_activated", "unchecked"]),
      };

      // The oracle: written independently of the gate, as one conjunction.
      const t = f.transfer;
      const oracle =
        f.releaseEnabled === true &&
        f.payout.status === "held" &&
        f.payout.pausedAt === null &&
        f.payout.transferId !== null &&
        (f.creatorStatus === "approved" || (f.creatorStatus === "closed" && f.byStaff === true)) &&
        f.accountActivation === "activated" &&
        f.booking !== null && ["approved", "publishing", "completed", "partially_published"].includes(f.booking.status) &&
        f.item !== null && ["posted_manual", "published"].includes(f.item.status) &&
        f.offer !== null && f.offer.status === "completed" && f.offer.linkVerifiedAt !== null && (f.offer.ownershipCheck === "auto_ok" || f.offer.ownershipCheck === "manual_ok") &&
        f.disputeStatuses.every((s) => s === "won") &&
        f.bankChangeBlocks === false &&
        f.payout.releaseAfter !== null && f.payout.releaseAfter.getTime() <= NOW.getTime() &&
        t !== null && t.id === f.payout.transferId && t.recipient === f.payout.razorpayAccountId && t.amount === f.payout.amountPaise && (t.source === null || t.source === f.payout.razorpayPaymentId) &&
        t.status === "processed" && t.onHold === true && t.onHoldUntil === null && t.amountReversed === 0 &&
        f.duplicateTransfers === "none" &&
        f.razorpayDisputes === "clear" &&
        f.razorpayRefunds === "clear" &&
        f.account === "activated";

      const d = evaluateRelease(f);
      expect(d.ok, `sample ${i}`).toBe(oracle);
      if (d.ok) okCount++;
      // A passing gate always passes its local half too (the engine relies on that order).
      if (d.ok) expect(evaluateLocalRelease(f).ok).toBe(true);
    }
    // The generator must actually reach both outcomes, or the property would hold vacuously.
    expect(okCount).toBeGreaterThan(100);
    expect(okCount).toBeLessThan(19_000);
  });
});

describe("releaseAfter", () => {
  const V = new Date("2026-10-18T10:00:00.000Z");
  const days = (d: number) => new Date(V.getTime() + d * 86_400_000);
  it("is the verification time plus the configured days, with a one-day floor unless ownership passed automatically", () => {
    expect(releaseAfter(V, "auto_ok", 0)).toEqual(V);
    expect(releaseAfter(V, "auto_ok", 3)).toEqual(days(3));
    expect(releaseAfter(V, "manual_ok", 0)).toEqual(days(1));
    expect(releaseAfter(V, "manual_ok", 0.5)).toEqual(days(1));
    expect(releaseAfter(V, "manual_ok", 5)).toEqual(days(5));
  });
  it("never trusts a missing or odd ownership value to need no hold, and ignores a nonsense holdDays", () => {
    for (const oc of [null, undefined, "", "auto_failed", "something"]) expect(releaseAfter(V, oc, 0), String(oc)).toEqual(days(1));
    for (const bad of [NaN, -3, Infinity * 0, Number.NEGATIVE_INFINITY]) expect(releaseAfter(V, "auto_ok", bad), String(bad)).toEqual(V);
  });
});

describe("decideTransferRetry: an unknown create result", () => {
  /** Every carrier here was made by the current request unless a test says otherwise. */
  const REQUEST = "1.1700000000";
  const carrier = (over: Partial<CarrierTransfer> = {}): CarrierTransfer => ({ id: "trf_1", status: "processed", amount: 50_000, amountReversed: 0, recipient: "acc_A1", createdAt: 1_700_000_000, generation: REQUEST, ...over });
  const base = (over: Partial<TransferRetryFacts> = {}): TransferRetryFacts => ({
    now: NOW,
    attempts: 1,
    absentChecks: 0,
    lastCheckedAt: null,
    refundExists: false,
    storedTransferId: null,
    requestKey: REQUEST,
    expected: { recipient: "acc_A1", amountPaise: 50_000 },
    carriers: [],
    ...over,
  });

  it("adopts the one live transfer that carries the payout id, and a lone failed one as a definite failure", () => {
    expect(decideTransferRetry(base({ carriers: [carrier()] }))).toEqual({ action: "adopt", transferId: "trf_1" });
    expect(decideTransferRetry(base({ carriers: [carrier({ status: "pending" })] }))).toEqual({ action: "adopt", transferId: "trf_1" });
    expect(decideTransferRetry(base({ carriers: [carrier({ status: "failed" })] }))).toEqual({ action: "adopt_failed", transferId: "trf_1" });
    // A failed one beside a live one: the live one is ours.
    expect(decideTransferRetry(base({ carriers: [carrier({ id: "trf_f", status: "failed" }), carrier({ id: "trf_ok" })] }))).toEqual({ action: "adopt", transferId: "trf_ok" });
  });

  it("parks a transfer that carries our id but is for someone else or another amount", () => {
    expect(decideTransferRetry(base({ carriers: [carrier({ recipient: "acc_X" })] }))).toEqual({ action: "needs_attention", reason: "transfer_mismatch" });
    expect(decideTransferRetry(base({ carriers: [carrier({ amount: 1 })] }))).toEqual({ action: "needs_attention", reason: "transfer_mismatch" });
  });

  it("parks a payout whose only carrier was reversed outside our flow", () => {
    expect(decideTransferRetry(base({ carriers: [carrier({ status: "reversed", amountReversed: 50_000 })] }))).toEqual({ action: "needs_attention", reason: "reversed_outside_flow" });
  });

  it("keeps ONE of several live transfers: the stored one, else the earliest, and lists the rest as extras", () => {
    const a = carrier({ id: "trf_b", createdAt: 200 });
    const b = carrier({ id: "trf_a", createdAt: 300 });
    expect(decideTransferRetry(base({ carriers: [a, b] }))).toEqual({ action: "duplicates", keep: "trf_b", extras: ["trf_a"] });
    expect(decideTransferRetry(base({ carriers: [a, b], storedTransferId: "trf_a" }))).toEqual({ action: "duplicates", keep: "trf_a", extras: ["trf_b"] });
    // Same creation time: the smaller id, so the choice never flips between runs.
    expect(decideTransferRetry(base({ carriers: [carrier({ id: "trf_z", createdAt: 5 }), carrier({ id: "trf_y", createdAt: 5 })] }))).toEqual({ action: "duplicates", keep: "trf_y", extras: ["trf_z"] });
  });

  it("waits on the first empty listing, and counts a second only when it is far enough from the first", () => {
    expect(decideTransferRetry(base())).toEqual({ action: "wait", countAbsent: true, absentChecks: 1 });
    const prev = ago(ABSENT_CHECK_GAP_MS - 1);
    expect(decideTransferRetry(base({ absentChecks: 1, lastCheckedAt: prev }))).toEqual({ action: "wait", countAbsent: false, absentChecks: 1 });
    expect(decideTransferRetry(base({ absentChecks: 1, lastCheckedAt: ago(ABSENT_CHECK_GAP_MS) }))).toEqual({ action: "retry" });
  });

  it("retries once, then parks for a person; with a refund on the payment it goes manual instead of retrying", () => {
    const second = { absentChecks: 1, lastCheckedAt: ago(ABSENT_CHECK_GAP_MS + MIN) };
    expect(decideTransferRetry(base({ ...second, attempts: 1 }))).toEqual({ action: "retry" });
    expect(decideTransferRetry(base({ ...second, attempts: MAX_CREATE_ATTEMPTS }))).toEqual({ action: "needs_attention", reason: "transfer_unknown_after_retry" });
    expect(decideTransferRetry(base({ ...second, attempts: 1, refundExists: true }))).toEqual({ action: "manual_required", reason: "no_transfer_after_refund" });
    // A refund never makes the first empty listing manual: one listing proves nothing.
    expect(decideTransferRetry(base({ refundExists: true }))).toEqual({ action: "wait", countAbsent: true, absentChecks: 1 });
  });

  it("NEVER retries on fewer than two counted empty listings, whatever the other facts", () => {
    for (const attempts of [0, 1, 2, 5]) {
      for (const absentChecks of [0, 1]) {
        for (const gap of [0, ABSENT_CHECK_GAP_MS - 1, ABSENT_CHECK_GAP_MS, ABSENT_CHECK_GAP_MS * 5]) {
          for (const lastChecked of [null, ago(gap)]) {
            const d = decideTransferRetry(base({ attempts, absentChecks, lastCheckedAt: lastChecked }));
            const counted = lastChecked === null || gap >= ABSENT_CHECK_GAP_MS;
            const total = absentChecks + (counted ? 1 : 0);
            if (total < 2) expect(d.action, `${attempts}/${absentChecks}/${gap}`).toBe("wait");
            else if (d.action === "retry") expect(attempts).toBeLessThan(MAX_CREATE_ATTEMPTS);
          }
        }
      }
    }
  });
});

describe("decideTransferCreation", () => {
  const ok: CreateFacts = { refundExists: false, paymentCaptured: true, bookingStatus: "paid_pending_review", itemStatus: "pending", accountActivated: true, paused: false, amountPaise: 50_000 };
  it("creates only when everything holds", () => {
    expect(decideTransferCreation(ok)).toEqual({ action: "create" });
  });
  it("waits (claims nothing) on every doubt, and goes manual when a refund exists", () => {
    expect(decideTransferCreation({ ...ok, paused: true })).toEqual({ action: "wait", reason: "paused" });
    expect(decideTransferCreation({ ...ok, paymentCaptured: false })).toEqual({ action: "wait", reason: "payment_not_captured" });
    expect(decideTransferCreation({ ...ok, bookingStatus: null })).toEqual({ action: "wait", reason: "booking_closed" });
    for (const s of ["rejected", "refunded", "cancelled", "expired", "draft", "awaiting_payment"]) expect(decideTransferCreation({ ...ok, bookingStatus: s }), s).toEqual({ action: "wait", reason: "booking_closed" });
    expect(decideTransferCreation({ ...ok, itemStatus: null })).toEqual({ action: "wait", reason: "item_closed" });
    for (const s of ["refunded", "refund_due", "failed"]) expect(decideTransferCreation({ ...ok, itemStatus: s }), s).toEqual({ action: "wait", reason: "item_closed" });
    expect(decideTransferCreation({ ...ok, accountActivated: false })).toEqual({ action: "wait", reason: "account_not_ready" });
    expect(decideTransferCreation({ ...ok, amountPaise: MIN_TRANSFER_PAISE - 1 })).toEqual({ action: "wait", reason: "amount_too_small" });
    expect(decideTransferCreation({ ...ok, amountPaise: 0 })).toEqual({ action: "wait", reason: "amount_too_small" });
    expect(decideTransferCreation({ ...ok, amountPaise: Number.NaN })).toEqual({ action: "wait", reason: "amount_too_small" });
    expect(decideTransferCreation({ ...ok, refundExists: true })).toEqual({ action: "manual_required", reason: "refund_exists" });
    // A pause wins over everything: a paused payout is not turned manual either.
    expect(decideTransferCreation({ ...ok, paused: true, refundExists: true })).toEqual({ action: "wait", reason: "paused" });
  });
  it("Retry of a failed transfer is off once any refund exists", () => {
    expect(canRetryFailedTransfer({ status: "failed", refundExists: false })).toBe(true);
    expect(canRetryFailedTransfer({ status: "failed", refundExists: true })).toBe(false);
    for (const s of PAYOUT_STATUSES.filter((x) => x !== "failed")) expect(canRetryFailedTransfer({ status: s, refundExists: false }), s).toBe(false);
  });
});

describe("decideReversal and decideReversalOutcome", () => {
  const t = (over: Partial<{ status: string; amount: number; amountReversed: number }> = {}) => ({ status: "processed", amount: 50_000, amountReversed: 0, ...over });
  const f = (over: Partial<Parameters<typeof decideReversal>[0]> = {}) => ({ payoutStatus: "held", byStaff: false, transfer: t(), ...over });

  it("reverses exactly what is left, never 'all' and never a negative amount", () => {
    expect(decideReversal(f())).toEqual({ action: "reverse", amountPaise: 50_000 });
    expect(decideReversal(f({ transfer: t({ amountReversed: 20_000, status: "partially_reversed" }) }))).toEqual({ action: "reverse", amountPaise: 30_000 });
    expect(remainingToReverse({ amount: 100, amountReversed: 150 })).toBe(0);
  });
  it("is idempotent: a transfer already fully reversed is a success, whatever its label says", () => {
    expect(decideReversal(f({ transfer: t({ status: "reversed", amountReversed: 50_000 }) }))).toEqual({ action: "already_reversed" });
    expect(decideReversal(f({ transfer: t({ status: "processed", amountReversed: 50_000 }) }))).toEqual({ action: "already_reversed" });
    expect(isFullyReversed({ status: "reversed", amount: 5, amountReversed: 0 })).toBe(true);
  });
  it("refuses states and facts it cannot act on", () => {
    for (const s of ["planned", "transfer_requested", "release_requested", "settled", "failed", "reversed", "void", "manual_required", "paid_manual"]) {
      expect(decideReversal(f({ payoutStatus: s })), s).toEqual({ action: "refuse", reason: "not_reversible_state" });
    }
    expect(decideReversal(f({ payoutStatus: "needs_attention" }))).toEqual({ action: "refuse", reason: "needs_human" });
    expect(decideReversal(f({ payoutStatus: "needs_attention", byStaff: true }))).toEqual({ action: "reverse", amountPaise: 50_000 });
    expect(decideReversal(f({ transfer: null }))).toEqual({ action: "refuse", reason: "transfer_unreadable" });
    expect(decideReversal(f({ transfer: t({ status: "failed" }) }))).toEqual({ action: "refuse", reason: "transfer_failed" });
    for (const status of ["created", "pending"]) expect(decideReversal(f({ transfer: t({ status }) })), status).toEqual({ action: "refuse", reason: "transfer_not_processed" });
    expect(decideReversal(f({ transfer: t({ amount: 0 }) }))).toEqual({ action: "refuse", reason: "bad_amounts" });
    expect(decideReversal(f({ transfer: t({ amountReversed: 60_000 }) }))).toEqual({ action: "refuse", reason: "bad_amounts" });
    expect(decideReversal(f({ transfer: t({ amountReversed: -1 }) }))).toEqual({ action: "refuse", reason: "bad_amounts" });
  });
  it("an unknown answer keeps the claim; a definite refusal goes back to held ONLY when still held and unsettled", () => {
    const o = (over: Partial<Parameters<typeof decideReversalOutcome>[0]>) => decideReversalOutcome({ priorStatus: "held", outcome: "definite_rejection", transferOnHold: true, transferSettled: false, ...over });
    expect(o({ outcome: "success" })).toMatchObject({ to: "reversed", alert: false });
    expect(o({ outcome: "unknown" })).toEqual({ to: null, alert: false, reason: "reversal_unknown" });
    expect(o({})).toMatchObject({ to: "held", alert: true });
    // Anything that might have left our control is parked, not "held".
    expect(o({ priorStatus: "released" })).toMatchObject({ to: "needs_attention", alert: true });
    expect(o({ priorStatus: "settlement_failed" })).toMatchObject({ to: "needs_attention" });
    expect(o({ transferOnHold: false })).toMatchObject({ to: "needs_attention" });
    expect(o({ transferOnHold: null })).toMatchObject({ to: "needs_attention" });
    expect(o({ transferSettled: true })).toMatchObject({ to: "needs_attention" });
    // An unknown answer is never "held" and never "reversed", for any prior.
    for (const prior of ["held", "released", "settlement_failed", "reversal_requested", "x"]) expect(o({ priorStatus: prior, outcome: "unknown" }).to).toBeNull();
  });
});

describe("refunds and the reserved amount", () => {
  it("no refund while a transfer can still be created; manual_required once a refund exists", () => {
    const p = (id: string, status: string) => ({ id, status });
    expect(decideRefundAllowed([p("a", "held"), p("b", "reversed")], false)).toEqual({ allowed: true, blockedBy: [], manualRequired: [], retryAllowed: true });
    expect(decideRefundAllowed([p("a", "planned"), p("b", "held")], false)).toMatchObject({ allowed: false, blockedBy: ["a"] });
    expect(decideRefundAllowed([p("a", "transfer_requested")], false)).toMatchObject({ allowed: false, blockedBy: ["a"] });
    // needs_attention, failed, manual_required and released do not block a refund of something else.
    for (const s of ["needs_attention", "failed", "manual_required", "released", "settled", "void", "reversal_requested"]) expect(decideRefundAllowed([p("a", s)], false).allowed, s).toBe(true);
    // Once a refund exists: failed and planned payouts can never be transferred, and Retry is off.
    expect(decideRefundAllowed([p("a", "failed"), p("b", "planned"), p("c", "held")], true)).toEqual({ allowed: false, blockedBy: ["b"], manualRequired: ["a", "b"], retryAllowed: false });
    expect(decideRefundAllowed([], true)).toEqual({ allowed: true, blockedBy: [], manualRequired: [], retryAllowed: false });
  });
  it("reserves the price of every payout that is not reversed or void", () => {
    const rows = PAYOUT_STATUSES.map((status, i) => ({ status, itemPricePaise: 1000 * (i + 1) }));
    const expected = rows.filter((r) => r.status !== "reversed" && r.status !== "void").reduce((a, r) => a + r.itemPricePaise, 0);
    expect(reservedPaiseOf(rows)).toBe(expected);
    expect(reservedPaiseOf([])).toBe(0);
    expect(reservedPaiseOf([{ status: "void", itemPricePaise: 5 }, { status: "reversed", itemPricePaise: 7 }])).toBe(0);
    expect(reservedPaiseOf([{ status: "failed", itemPricePaise: 5 }, { status: "settled", itemPricePaise: 7 }])).toBe(12);
  });
});

describe("decideManualFallback", () => {
  const base = { status: "manual_required", transferId: null as string | null, attempts: 0, reversedAt: null as Date | null, transfer: null as { status: string; amount: number; amountReversed: number } | null, transferChecked: false, activeCarriers: null as number | null };
  it("(a) no transfer was ever created", () => {
    expect(decideManualFallback(base)).toEqual({ ok: true, basis: "no_transfer" });
    // A create call WAS sent: it may have landed unseen, so only a fresh listing can say.
    expect(decideManualFallback({ ...base, attempts: 1 })).toEqual({ ok: false, reason: "listing_unchecked" });
    expect(decideManualFallback({ ...base, attempts: 1, activeCarriers: 0 })).toEqual({ ok: true, basis: "no_transfer" });
    expect(decideManualFallback({ ...base, attempts: 2, activeCarriers: 1 })).toEqual({ ok: false, reason: "transfer_active" });
  });
  it("(b) a fresh read shows the transfer failed AND no other live transfer carries the payout id", () => {
    const failed = { ...base, transferId: "trf_1", attempts: 1, transfer: { status: "failed", amount: 5, amountReversed: 0 }, transferChecked: true };
    expect(decideManualFallback({ ...failed, activeCarriers: 0 })).toEqual({ ok: true, basis: "transfer_failed" });
    expect(decideManualFallback({ ...failed, activeCarriers: 1 })).toEqual({ ok: false, reason: "transfer_active" });
    expect(decideManualFallback({ ...failed, activeCarriers: null })).toEqual({ ok: false, reason: "listing_unchecked" });
    expect(decideManualFallback({ ...failed, transferChecked: false, activeCarriers: 0 })).toEqual({ ok: false, reason: "transfer_unchecked" });
    expect(decideManualFallback({ ...failed, transfer: { status: "processed", amount: 5, amountReversed: 0 }, activeCarriers: 1 })).toEqual({ ok: false, reason: "transfer_not_failed" });
  });
  it("(c) the payout is reversed: it was, and the whole transfer is back", () => {
    const rev = { ...base, transferId: "trf_1", attempts: 1, reversedAt: ago(MIN), transfer: { status: "reversed", amount: 5, amountReversed: 5 }, transferChecked: true, activeCarriers: 0 };
    expect(decideManualFallback(rev)).toEqual({ ok: true, basis: "reversed" });
    expect(decideManualFallback({ ...rev, reversedAt: null })).toEqual({ ok: false, reason: "not_reversed" });
    expect(decideManualFallback({ ...rev, transfer: { status: "partially_reversed", amount: 5, amountReversed: 3 } })).toEqual({ ok: false, reason: "transfer_not_failed" });
  });
  it("never pays by hand while a transfer could still release, and only from manual_required", () => {
    for (const status of PAYOUT_STATUSES.filter((s) => s !== "manual_required")) expect(decideManualFallback({ ...base, status }), status).toEqual({ ok: false, reason: "not_manual_required" });
    for (const s of ["created", "pending", "processed"]) {
      expect(decideManualFallback({ ...base, transferId: "trf_1", attempts: 1, transfer: { status: s, amount: 5, amountReversed: 0 }, transferChecked: true, activeCarriers: 1 }).ok, s).toBe(false);
    }
  });
});

describe("mapTransferFactsToState: a fresh read only ever proposes a legal move", () => {
  const facts = (over: Partial<TransferFacts> = {}): TransferFacts => ({ status: "processed", onHold: true, onHoldUntil: null, amount: 50_000, amountReversed: 0, settlementStatus: "on_hold", recipientSettlementStatus: null, ...over });

  it("claims held ONLY for processed + on hold + no auto-release date; a processed transfer that is not held parks and asks for the hold back", () => {
    expect(mapTransferFactsToState("transfer_requested", facts())).toEqual({ to: "held", reason: "held" });
    expect(mapTransferFactsToState("transfer_requested", facts({ onHold: false }))).toEqual({ to: "needs_attention", reason: "processed_not_held", alert: true, action: "rehold" });
    expect(mapTransferFactsToState("transfer_requested", facts({ onHoldUntil: 1_800_000_000 }))).toEqual({ to: "needs_attention", reason: "processed_hold_expires", alert: true, action: "rehold" });
    for (const status of ["created", "pending"]) expect(mapTransferFactsToState("transfer_requested", facts({ status })).to, status).toBeUndefined();
    expect(mapTransferFactsToState("transfer_requested", facts({ status: "failed" }))).toMatchObject({ to: "failed" });
  });
  it("a held payout is re-checked: the hold gone, an auto-release date, a settlement or a failure all park it", () => {
    expect(mapTransferFactsToState("held", facts())).toEqual({ reason: "confirmed_held" });
    expect(mapTransferFactsToState("held", facts({ onHold: false }))).toMatchObject({ to: "needs_attention", reason: "released_outside_flow", action: "rehold" });
    expect(mapTransferFactsToState("held", facts({ onHoldUntil: 5 }))).toMatchObject({ to: "needs_attention", reason: "hold_expires", action: "rehold" });
    expect(mapTransferFactsToState("held", facts({ recipientSettlementStatus: "processed" }))).toMatchObject({ to: "needs_attention", reason: "settled_while_held" });
    expect(mapTransferFactsToState("held", facts({ status: "failed" }))).toMatchObject({ to: "needs_attention", reason: "failed_while_held" });
    expect(mapTransferFactsToState("held", facts({ amountReversed: 10, status: "partially_reversed" }))).toMatchObject({ to: "needs_attention" });
    expect(mapTransferFactsToState("held", facts({ amountReversed: 50_000, status: "reversed" }))).toMatchObject({ to: "needs_attention", reason: "reversed_outside_flow" });
  });
  it("a release is confirmed only by a processed transfer that is no longer on hold", () => {
    expect(mapTransferFactsToState("release_requested", facts({ onHold: false }))).toEqual({ to: "released", reason: "released" });
    expect(mapTransferFactsToState("release_requested", facts())).toEqual({ reason: "still_on_hold" });
    expect(mapTransferFactsToState("release_requested", facts({ onHold: false, amountReversed: 100, status: "partially_reversed" }))).toMatchObject({ to: "needs_attention" });
  });
  it("settlement moves come from the recipient settlement, and a re-hold of a released payout is parked", () => {
    expect(mapTransferFactsToState("released", facts({ onHold: false, recipientSettlementStatus: "processed" }))).toMatchObject({ to: "settled" });
    expect(mapTransferFactsToState("released", facts({ onHold: false, recipientSettlementStatus: "failed" }))).toMatchObject({ to: "settlement_failed", alert: true });
    expect(mapTransferFactsToState("released", facts({ onHold: false }))).toEqual({ reason: "awaiting_settlement" });
    expect(mapTransferFactsToState("released", facts())).toMatchObject({ to: "needs_attention", reason: "re_held_outside_flow" });
    expect(mapTransferFactsToState("settlement_failed", facts({ onHold: false, recipientSettlementStatus: "processed" }))).toMatchObject({ to: "settled" });
  });
  it("a parked payout is resolved only to what the facts prove, and never by a settlement", () => {
    expect(mapTransferFactsToState("needs_attention", facts())).toEqual({ to: "held", reason: "confirmed_held" });
    expect(mapTransferFactsToState("needs_attention", facts({ onHold: false }))).toEqual({ reason: "still_not_held", action: "rehold" });
    expect(mapTransferFactsToState("needs_attention", facts({ status: "reversed", amountReversed: 50_000 }))).toEqual({ to: "reversed", reason: "reversed" });
    expect(mapTransferFactsToState("needs_attention", facts({ status: "failed" }))).toEqual({ to: "failed", reason: "failed" });
    expect(mapTransferFactsToState("needs_attention", facts({ recipientSettlementStatus: "processed" }))).toEqual({ reason: "needs_human" });
    expect(mapTransferFactsToState("needs_attention", facts({ amountReversed: 5, status: "partially_reversed" }))).toEqual({ reason: "needs_human" });
  });
  it("a reversal in flight finishes only on a fully reversed transfer", () => {
    expect(mapTransferFactsToState("reversal_requested", facts({ status: "reversed", amountReversed: 50_000 }))).toMatchObject({ to: "reversed" });
    expect(mapTransferFactsToState("reversal_requested", facts({ status: "partially_reversed", amountReversed: 10 }))).toEqual({ reason: "reversal_in_flight" });
    expect(mapTransferFactsToState("reversal_requested", facts()).to).toBeUndefined();
  });
  it("never moves a status the facts do not apply to", () => {
    for (const s of ["planned", "failed", "reversed", "manual_required", "settled", "paid_manual", "void"]) expect(mapTransferFactsToState(s, facts({ status: "failed" })).to, s).toBeUndefined();
    expect(mapTransferFactsToState("nonsense", facts())).toEqual({ reason: "unknown_status" });
  });
  it("PROPERTY: every proposed move is an edge of the state table, for every status and a grid of facts", () => {
    const statuses = [null, "created", "pending", "processed", "failed", "reversed", "partially_reversed"];
    const holds = [true, false, null];
    const untils = [null, 1_800_000_000];
    const amounts: Array<[number | null, number | null]> = [[50_000, 0], [50_000, 10], [50_000, 50_000], [null, null], [50_000, null], [0, 0]];
    const settle = [null, "processed", "failed"];
    const sstat = [null, "on_hold", "pending", "settled"];
    let n = 0;
    for (const current of [...PAYOUT_STATUSES, "bogus"]) {
      for (const status of statuses) for (const onHold of holds) for (const onHoldUntil of untils) for (const [amount, amountReversed] of amounts) for (const rs of settle) for (const ss of sstat) {
        const d = mapTransferFactsToState(current, { status, onHold, onHoldUntil, amount, amountReversed, settlementStatus: ss, recipientSettlementStatus: rs });
        n++;
        if (d.to) expect(canMove(current, d.to), `${current} -> ${d.to} (${d.reason})`).toBe(true);
        // "held" is only ever claimed from a processed, held, un-dated transfer.
        if (d.to === "held") {
          expect(status).toBe("processed");
          expect(onHold).toBe(true);
          expect(onHoldUntil).toBeNull();
        }
        // A rehold request always comes with a parked move or a parked row, never from a healthy one.
        if (d.action === "rehold") expect(["needs_attention", "held", "transfer_requested"].includes(current) || d.to === "needs_attention").toBe(true);
      }
    }
    expect(n).toBeGreaterThan(10_000);
  });
});

describe("decideResume", () => {
  const ok = { paused: true, disputeStatuses: [] as string[], bankChangeBlocks: false, accountActivated: true };
  it("lifts a pause only when nothing that caused one still holds", () => {
    expect(decideResume(ok)).toEqual({ ok: true });
    expect(decideResume({ ...ok, paused: false })).toEqual({ ok: false, reason: "not_paused" });
    expect(decideResume({ ...ok, disputeStatuses: ["open"] })).toEqual({ ok: false, reason: "dispute_open" });
    expect(decideResume({ ...ok, disputeStatuses: ["lost"] })).toEqual({ ok: false, reason: "dispute_open" });
    expect(decideResume({ ...ok, disputeStatuses: ["won"] })).toEqual({ ok: true });
    expect(decideResume({ ...ok, bankChangeBlocks: true })).toEqual({ ok: false, reason: "bank_change_pending" });
    expect(decideResume({ ...ok, accountActivated: false })).toEqual({ ok: false, reason: "account_not_activated" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 4 review fixes

describe("the release gate: the creator, the stored account state and Razorpay's refunds", () => {
  it("only an approved creator is released for by the worker; one who closed the account only by a person; nobody else, ever", () => {
    expect(evaluateRelease({ ...good(), creatorStatus: "approved" })).toEqual({ ok: true });
    expect(evaluateRelease({ ...good(), creatorStatus: "approved", byStaff: true })).toEqual({ ok: true });
    // A creator who closed their account after the post was verified is owed the money: a person may release it, the worker never does.
    expect(evaluateRelease({ ...good(), creatorStatus: "closed" })).toEqual({ ok: false, reason: "creator_not_active" });
    expect(evaluateRelease({ ...good(), creatorStatus: "closed", byStaff: true })).toEqual({ ok: true });
    // A suspended, rejected, unfinished or unreadable creator is never released for: not by the worker, not by a person (reinstate first).
    for (const status of ["suspended", "rejected", "in_review", "draft", "", "APPROVED", "something_new", null]) {
      for (const byStaff of [false, true]) expect(evaluateRelease({ ...good(), creatorStatus: status, byStaff }), `${status}/${byStaff}`).toEqual({ ok: false, reason: "creator_not_active" });
    }
  });

  it("the creator check is local: it costs no Razorpay call and comes before anything is asked of Razorpay", () => {
    const unread: ReleaseFacts = { ...good(), creatorStatus: "suspended", transfer: null, duplicateTransfers: "unchecked", razorpayDisputes: "unchecked", razorpayRefunds: "unchecked", account: "unchecked" };
    expect(evaluateLocalRelease(unread)).toEqual({ ok: false, reason: "creator_not_active" });
  });

  it("the linked account must be activated as we last stored it, judged locally; Razorpay's fresh answer is still asked after", () => {
    for (const status of ["suspended", "needs_clarification", "under_review", "created", "", null]) {
      expect(evaluateLocalRelease({ ...good(), accountActivation: status }), String(status)).toEqual({ ok: false, reason: "account_not_activated" });
    }
    expect(evaluateLocalRelease({ ...good(), accountActivation: "activated" })).toEqual({ ok: true });
    // Stored as activated, but Razorpay says otherwise now: still refused.
    expect(evaluateRelease({ ...good(), account: "not_activated" })).toEqual({ ok: false, reason: "account_not_activated" });
  });

  it("a refund Razorpay shows and our books do not, or a refund of this very item, refuses; an unreadable answer refuses on its own reason", () => {
    expect(evaluateRelease({ ...good(), razorpayRefunds: "unaccounted" })).toEqual({ ok: false, reason: "refund_at_razorpay" });
    expect(evaluateRelease({ ...good(), razorpayRefunds: "covers_item" })).toEqual({ ok: false, reason: "refund_at_razorpay" });
    expect(evaluateRelease({ ...good(), razorpayRefunds: "unchecked" })).toEqual({ ok: false, reason: "refund_unchecked" });
    expect(evaluateRelease({ ...good(), razorpayRefunds: "clear" })).toEqual({ ok: true });
    // Judged after the disputes and before the account, as the engine reads them.
    expect(evaluateRelease({ ...good(), razorpayDisputes: "blocking", razorpayRefunds: "unaccounted" })).toEqual({ ok: false, reason: "dispute_at_razorpay" });
    expect(evaluateRelease({ ...good(), razorpayRefunds: "unaccounted", account: "not_activated" })).toEqual({ ok: false, reason: "refund_at_razorpay" });
  });
});

describe("decideRefundVerdict", () => {
  const ledger = (...rows: Array<[number, string | null]>) => rows.map(([amountPaise, bookingItemId]) => ({ amountPaise, bookingItemId }));
  it("is clear when Razorpay shows nothing more than our ledger, including our own refunds of OTHER items", () => {
    expect(decideRefundVerdict({ razorpayRefundedPaise: 0, ledger: [], itemId: "i1" })).toBe("clear");
    expect(decideRefundVerdict({ razorpayRefundedPaise: 30_000, ledger: ledger([30_000, "i2"]), itemId: "i1" })).toBe("clear");
    expect(decideRefundVerdict({ razorpayRefundedPaise: 30_000, ledger: ledger([10_000, "i2"], [20_000, "i3"]), itemId: "i1" })).toBe("clear");
    // A refund filed as external and not attributed to an item (staff already looked and resumed) is on the books too.
    expect(decideRefundVerdict({ razorpayRefundedPaise: 30_000, ledger: ledger([30_000, null]), itemId: "i1" })).toBe("clear");
  });
  it("is unaccounted when Razorpay shows more refunded than our books, by even one paisa", () => {
    expect(decideRefundVerdict({ razorpayRefundedPaise: 30_001, ledger: ledger([30_000, "i2"]), itemId: "i1" })).toBe("unaccounted");
    expect(decideRefundVerdict({ razorpayRefundedPaise: 1, ledger: [], itemId: "i1" })).toBe("unaccounted");
  });
  it("covers the item when our books show a refund of this very item, whatever the totals say", () => {
    expect(decideRefundVerdict({ razorpayRefundedPaise: 10_000, ledger: ledger([10_000, "i1"]), itemId: "i1" })).toBe("covers_item");
    expect(decideRefundVerdict({ razorpayRefundedPaise: 0, ledger: ledger([10_000, "i1"]), itemId: "i1" })).toBe("covers_item");
  });
});

describe("decideTransferRetry: a transfer an EARLIER request left behind is never this request's outcome", () => {
  const NOWREQ = "3.1700000500";
  const OLD = "1.1700000000";
  const c = (over: Partial<CarrierTransfer> = {}): CarrierTransfer => ({ id: "trf_x", status: "processed", amount: 50_000, amountReversed: 0, recipient: "acc_A1", createdAt: 1_700_000_000, generation: NOWREQ, ...over });
  const f = (over: Partial<TransferRetryFacts> = {}): TransferRetryFacts => ({
    now: NOW,
    attempts: 3,
    absentChecks: 0,
    lastCheckedAt: null,
    refundExists: false,
    storedTransferId: null,
    requestKey: NOWREQ,
    expected: { recipient: "acc_A1", amountPaise: 50_000 },
    carriers: [],
    ...over,
  });

  it("a failed transfer of an earlier request is history: not adopted, and the listing still counts as empty", () => {
    // Staff pressed Retry; the retry's answer was lost; the listing shows only the OLD failed transfer.
    const d = decideTransferRetry(f({ carriers: [c({ id: "trf_old", status: "failed", generation: OLD })] }));
    expect(d.action).toBe("wait");
    expect(decideTransferRetry(f({ carriers: [c({ id: "trf_old", status: "failed", generation: OLD })], absentChecks: 1, lastCheckedAt: ago(ABSENT_CHECK_GAP_MS + MIN) })).action).toBe("needs_attention");
  });
  it("a failed transfer of THIS request is its definite outcome", () => {
    expect(decideTransferRetry(f({ carriers: [c({ id: "trf_now", status: "failed" })] }))).toEqual({ action: "adopt_failed", transferId: "trf_now" });
  });
  it("a failed transfer that carries no request key at all is never trusted as an outcome; neither is any when the payout recorded no request", () => {
    expect(decideTransferRetry(f({ carriers: [c({ status: "failed", generation: null })] })).action).toBe("wait");
    expect(decideTransferRetry(f({ requestKey: null, carriers: [c({ status: "failed" })] })).action).toBe("wait");
  });
  it("a LIVE transfer always counts, whichever request made it: money is out", () => {
    expect(decideTransferRetry(f({ carriers: [c({ id: "trf_old", generation: OLD })] }))).toEqual({ action: "adopt", transferId: "trf_old" });
    expect(decideTransferRetry(f({ carriers: [c({ id: "trf_old", generation: OLD }), c({ id: "trf_now" })] }))).toMatchObject({ action: "duplicates" });
    expect(decideTransferRetry(f({ carriers: [c({ id: "trf_old", status: "failed", generation: OLD }), c({ id: "trf_live", generation: null })] }))).toEqual({ action: "adopt", transferId: "trf_live" });
  });
  it("a reversed transfer of an earlier request (a twin we took back) is not 'reversed outside our flow'", () => {
    const rev = c({ id: "trf_old", status: "reversed", amountReversed: 50_000, generation: OLD });
    expect(decideTransferRetry(f({ carriers: [rev] })).action).toBe("wait");
    expect(decideTransferRetry(f({ carriers: [c({ status: "reversed", amountReversed: 50_000 })] }))).toEqual({ action: "needs_attention", reason: "reversed_outside_flow" });
  });
});

describe("requestKeyOf", () => {
  it("names a request by how many create calls were sent and the second it was claimed, and is null without a request time", () => {
    expect(requestKeyOf(1, new Date(1_700_000_000_999))).toBe("1.1700000000");
    expect(requestKeyOf(2, new Date(1_700_000_000_999))).not.toBe(requestKeyOf(1, new Date(1_700_000_000_999)));
    expect(requestKeyOf(1, new Date(1_700_000_001_000))).not.toBe(requestKeyOf(1, new Date(1_700_000_000_000)));
    expect(requestKeyOf(1, null)).toBeNull();
    expect(requestKeyOf(1, new Date(1_700_000_000_999))).toMatch(/^[A-Za-z0-9._-]{1,40}$/);
  });
});

describe("how long a payout that cannot move is left alone", () => {
  const HOUR = 60 * MIN;
  it("a refused release waits: transient ones a quarter of an hour, persistent ones a quarter of how overdue they are (30 minutes to 6 hours)", () => {
    for (const r of ["transfer_unreadable", "duplicate_unchecked", "dispute_unchecked", "refund_unchecked", "account_unchecked"] as const) {
      expect(releaseRefusalBackoffMs(r, { now: NOW, releaseAfter: ago(10 * HOUR) }), r).toBe(15 * MIN);
    }
    for (const r of ["account_not_activated", "dispute_at_razorpay", "refund_at_razorpay", "creator_not_active", "transfer_mismatch", "transfer_not_on_hold", "bank_change_pending", "item_not_live"] as const) {
      expect(releaseRefusalBackoffMs(r, { now: NOW, releaseAfter: ago(MIN) }), r).toBe(30 * MIN);
      expect(releaseRefusalBackoffMs(r, { now: NOW, releaseAfter: ago(8 * HOUR) }), r).toBe(2 * HOUR);
      expect(releaseRefusalBackoffMs(r, { now: NOW, releaseAfter: ago(100 * HOUR) }), r).toBe(6 * HOUR);
      expect(releaseRefusalBackoffMs(r, { now: NOW, releaseAfter: null }), r).toBe(30 * MIN);
    }
  });
  it("a refusal that selects nothing again anyway is not waited on (the switch, a pause, not held, not due, not scheduled)", () => {
    for (const r of ["release_paused", "payout_not_held", "payout_paused", "no_transfer", "release_not_scheduled", "release_not_due"] as const) expect(releaseRefusalBackoffMs(r, { now: NOW, releaseAfter: ago(HOUR) }), r).toBeNull();
  });
  it("EVERY refusal reason has a defined wait or none, never a missing branch", () => {
    for (const r of RELEASE_REFUSALS) {
      const ms = releaseRefusalBackoffMs(r, { now: NOW, releaseAfter: ago(HOUR) });
      expect(ms === null || (Number.isFinite(ms) && ms >= 15 * MIN && ms <= 6 * HOUR), r).toBe(true);
    }
  });
  it("a payout parked with its hold gone is read again after 5 minutes, doubling, never over 2 hours", () => {
    expect([0, 1, 2, 3, 4, 5, 9, 50].map(heldAnomalyBackoffMs)).toEqual([5 * MIN, 10 * MIN, 20 * MIN, 40 * MIN, 80 * MIN, 2 * HOUR, 2 * HOUR, 2 * HOUR]);
    expect(heldAnomalyBackoffMs(-3)).toBe(5 * MIN);
    expect(heldAnomalyBackoffMs(Number.NaN)).toBeGreaterThan(0);
  });
  it("a planned payout that waits: 2 minutes for a capture that has not landed, else a quarter of its age between 5 and 60 minutes", () => {
    expect(plannedWaitBackoffMs("payment_not_captured", 5 * HOUR)).toBe(2 * MIN);
    expect(plannedWaitBackoffMs("account_not_ready", 0)).toBe(5 * MIN);
    expect(plannedWaitBackoffMs("account_not_ready", 2 * HOUR)).toBe(30 * MIN);
    expect(plannedWaitBackoffMs("item_closed", 100 * HOUR)).toBe(HOUR);
    expect(plannedWaitBackoffMs("booking_closed", -5)).toBe(5 * MIN);
  });
});
