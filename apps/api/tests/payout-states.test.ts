import { describe, it, expect } from "vitest";
import {
  PAUSABLE_STATUSES,
  PAYOUT_STATUSES,
  TRANSITIONS,
  canMove,
  isMoneyAtRisk,
  isPausable,
  isPayoutStatus,
  isTerminal,
  mapTransferEvent,
  nextStatuses,
  reservesItemPrice,
  type PayoutStatus,
  type TransferFacts,
} from "../src/services/creator/payout-states";

/**
 * The payout state machine (services/creator/payout-states.ts), pure. The expected edge list
 * below is written out by hand, NOT derived from TRANSITIONS: it is the independent oracle, so a
 * move added to or dropped from the table by accident fails here instead of passing silently.
 */

const EXPECTED: Record<PayoutStatus, PayoutStatus[]> = {
  planned: ["transfer_requested", "void", "manual_required"],
  transfer_requested: ["held", "failed", "needs_attention"],
  held: ["release_requested", "reversal_requested", "needs_attention"],
  release_requested: ["released", "held", "needs_attention"],
  released: ["settled", "settlement_failed", "reversal_requested", "held", "needs_attention"],
  settlement_failed: ["settled", "reversal_requested", "needs_attention"],
  reversal_requested: ["reversed", "held", "released", "needs_attention"],
  reversed: ["manual_required"],
  failed: ["transfer_requested", "manual_required", "void", "needs_attention"],
  needs_attention: ["transfer_requested", "held", "released", "settled", "settlement_failed", "failed", "reversal_requested", "reversed", "manual_required", "void"],
  manual_required: ["paid_manual", "void"],
  settled: [],
  paid_manual: [],
  void: [],
};

describe("payout statuses", () => {
  it("are exactly the plan's Phase 4 table", () => {
    expect([...PAYOUT_STATUSES].sort()).toEqual(
      [
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
      ].sort(),
    );
    expect(PAYOUT_STATUSES).toHaveLength(14);
  });

  it("isPayoutStatus accepts only those", () => {
    for (const s of PAYOUT_STATUSES) expect(isPayoutStatus(s)).toBe(true);
    for (const bad of ["", "Held", "paid", "transfer.processed", null, undefined, 3]) expect(isPayoutStatus(bad)).toBe(false);
  });
});

describe("transition matrix", () => {
  it("canMove agrees with the hand-written oracle for all 196 pairs", () => {
    for (const from of PAYOUT_STATUSES) {
      for (const to of PAYOUT_STATUSES) {
        expect(canMove(from, to), `${from} -> ${to}`).toBe(EXPECTED[from].includes(to));
      }
    }
  });

  it("the table has no edge the oracle lacks and the oracle has no edge the table lacks", () => {
    for (const from of PAYOUT_STATUSES) {
      expect([...nextStatuses(from)].sort(), from).toEqual([...EXPECTED[from]].sort());
    }
  });

  it("never skips a state: a claim sits between every pair that needs an API call", () => {
    const forbidden: Array<[PayoutStatus, PayoutStatus]> = [
      ["planned", "held"],
      ["planned", "released"],
      ["planned", "settled"],
      ["planned", "reversed"],
      ["transfer_requested", "released"],
      ["transfer_requested", "settled"],
      ["transfer_requested", "reversal_requested"],
      ["held", "released"], // via release_requested
      ["held", "settled"],
      ["held", "reversed"], // via reversal_requested
      ["held", "paid_manual"],
      ["release_requested", "settled"],
      ["release_requested", "reversal_requested"], // the release-vs-reversal race resolves by waiting
      ["released", "reversed"],
      ["released", "release_requested"],
      ["settlement_failed", "manual_required"], // the money is still in the linked account: reverse first
      ["settled", "reversal_requested"],
      ["reversal_requested", "settled"],
      ["failed", "held"],
      ["failed", "released"],
      ["manual_required", "reversed"],
      ["manual_required", "settled"],
    ];
    for (const [from, to] of forbidden) expect(canMove(from, to), `${from} -> ${to}`).toBe(false);
  });

  it("a status never moves to itself (re-applying a fact is a no-op, not a move)", () => {
    for (const s of PAYOUT_STATUSES) expect(canMove(s, s), s).toBe(false);
  });

  it("unknown statuses move nowhere and nothing moves to them", () => {
    expect(canMove("held", "paid")).toBe(false);
    expect(canMove("nonsense", "held")).toBe(false);
    expect(canMove("", "")).toBe(false);
    expect(nextStatuses("nonsense")).toEqual([]);
  });

  it("every edge says where the plan or Razorpay's docs justify it", () => {
    for (const from of PAYOUT_STATUSES) {
      for (const tr of TRANSITIONS[from]) {
        expect(tr.source.length, `${from} -> ${tr.to}`).toBeGreaterThan(20);
        expect(["forward", "rollback", "park", "resolve", "retry"]).toContain(tr.kind);
      }
    }
  });

  it("rollbacks exist only where a definite rejection puts a claim back", () => {
    const rollbacks = PAYOUT_STATUSES.flatMap((from) => TRANSITIONS[from].filter((x) => x.kind === "rollback").map((x) => `${from}>${x.to}`)).sort();
    expect(rollbacks).toEqual(["release_requested>held", "released>held", "reversal_requested>held", "reversal_requested>released"].sort());
  });
});

describe("terminal states", () => {
  it("settled, paid_manual and void have no exits at all", () => {
    for (const s of ["settled", "paid_manual", "void"] as const) {
      expect(isTerminal(s), s).toBe(true);
      expect(nextStatuses(s), s).toEqual([]);
      for (const to of PAYOUT_STATUSES) expect(canMove(s, to), `${s} -> ${to}`).toBe(false);
    }
  });

  it("every other status has an exit (reversed's single exit is manual_required)", () => {
    for (const s of PAYOUT_STATUSES) {
      if (["settled", "paid_manual", "void"].includes(s)) continue;
      expect(isTerminal(s), s).toBe(false);
      expect(nextStatuses(s).length, s).toBeGreaterThan(0);
    }
    expect(nextStatuses("reversed")).toEqual(["manual_required"]);
  });

  it("isTerminal is false for unknown input", () => {
    expect(isTerminal("nonsense")).toBe(false);
  });

  it("every status is reachable from planned, and every status can reach a terminal one", () => {
    const reach = new Set<PayoutStatus>(["planned"]);
    const queue: PayoutStatus[] = ["planned"];
    while (queue.length) {
      const s = queue.shift()!;
      for (const n of nextStatuses(s)) if (!reach.has(n)) (reach.add(n), queue.push(n));
    }
    expect([...reach].sort()).toEqual([...PAYOUT_STATUSES].sort());

    for (const start of PAYOUT_STATUSES) {
      const seen = new Set<PayoutStatus>([start]);
      const q: PayoutStatus[] = [start];
      let terminal = isTerminal(start);
      while (q.length && !terminal) {
        const s = q.shift()!;
        for (const n of nextStatuses(s)) {
          if (isTerminal(n)) terminal = true;
          if (!seen.has(n)) (seen.add(n), q.push(n));
        }
      }
      expect(terminal, `${start} can end`).toBe(true);
    }
  });
});

describe("money predicates", () => {
  it("isMoneyAtRisk: only while the share may sit outside our balance with the outcome open", () => {
    const atRisk = ["transfer_requested", "held", "release_requested", "released", "settlement_failed", "reversal_requested", "needs_attention"];
    for (const s of PAYOUT_STATUSES) expect(isMoneyAtRisk(s), s).toBe(atRisk.includes(s));
    expect(isMoneyAtRisk("nonsense")).toBe(false);
  });

  it("reservesItemPrice: a creator item's price is refundable only once its payout is reversed or void", () => {
    for (const s of PAYOUT_STATUSES) expect(reservesItemPrice(s), s).toBe(s !== "reversed" && s !== "void");
    expect(reservesItemPrice("nonsense")).toBe(false);
  });

  it("isPausable: nothing in flight means nothing to pause", () => {
    for (const s of PAYOUT_STATUSES) expect(isPausable(s), s).toBe(!["settled", "paid_manual", "void", "reversed"].includes(s));
  });

  it("PAUSABLE_STATUSES is exactly the statuses isPausable accepts (the one list every writer of paused_at filters on)", () => {
    expect([...PAUSABLE_STATUSES].sort()).toEqual(PAYOUT_STATUSES.filter((s) => isPausable(s)).sort());
    expect([...PAUSABLE_STATUSES].sort()).toEqual(
      ["planned", "transfer_requested", "held", "release_requested", "released", "settlement_failed", "reversal_requested", "failed", "needs_attention", "manual_required"].sort(),
    );
    for (const s of ["settled", "paid_manual", "void", "reversed"]) expect(PAUSABLE_STATUSES as readonly string[], s).not.toContain(s);
  });
});

// ── mapTransferEvent ────────────────────────────────────────────────────────────

const facts = (over: Partial<TransferFacts> = {}): TransferFacts => ({
  status: null,
  onHold: null,
  onHoldUntil: null,
  amount: null,
  amountReversed: null,
  settlementStatus: null,
  recipientSettlementStatus: null,
  ...over,
});

const PROCESSED_HELD = facts({ status: "processed", onHold: true, amount: 50000, amountReversed: 0 });

/** Every facts shape the mapper has a rule for, plus junk. */
const CATALOG: Array<[string, TransferFacts]> = [
  ["processed, on hold", PROCESSED_HELD],
  ["processed, not on hold", facts({ status: "processed", onHold: false, amount: 50000, amountReversed: 0 })],
  ["processed, hold expires", facts({ status: "processed", onHold: true, onHoldUntil: 1893456000, amount: 50000, amountReversed: 0 })],
  ["processed, on_hold unreported", facts({ status: "processed" })],
  ["failed", facts({ status: "failed", onHold: false, amount: 50000 })],
  ["created", facts({ status: "created" })],
  ["pending", facts({ status: "pending" })],
  ["settlement processed", facts({ recipientSettlementStatus: "processed" })],
  ["settlement failed", facts({ recipientSettlementStatus: "failed" })],
  ["reversed", facts({ status: "reversed", amount: 50000, amountReversed: 50000 })],
  ["fully reversed by amounts", facts({ status: "processed", onHold: true, amount: 50000, amountReversed: 50000 })],
  ["partially reversed", facts({ status: "partially_reversed", amount: 50000, amountReversed: 100 })],
  ["partly reversed by amounts", facts({ status: "processed", onHold: true, amount: 50000, amountReversed: 100 })],
  ["nothing", facts()],
  ["unknown status", facts({ status: "whatever" })],
];

describe("mapTransferEvent", () => {
  it("processed + on_hold:true + no on_hold_until moves ONLY transfer_requested -> held", () => {
    expect(mapTransferEvent("transfer_requested", PROCESSED_HELD)).toEqual({ to: "held", reason: "held" });
    expect(mapTransferEvent("held", PROCESSED_HELD)).toEqual({ reason: "unchanged" });
    for (const s of ["planned", "release_requested", "released", "settlement_failed", "reversal_requested", "reversed", "failed", "needs_attention", "manual_required"] as const) {
      expect(mapTransferEvent(s, PROCESSED_HELD), s).toEqual({ reason: "stale" });
    }
    for (const s of ["settled", "paid_manual", "void"] as const) expect(mapTransferEvent(s, PROCESSED_HELD), s).toEqual({ reason: "terminal" });
  });

  it("processed but NOT on hold is never 'held': it parks the payout and raises an alert", () => {
    expect(mapTransferEvent("transfer_requested", facts({ status: "processed", onHold: false }))).toEqual({ to: "needs_attention", reason: "processed_not_held", alert: true });
    expect(mapTransferEvent("held", facts({ status: "processed", onHold: false }))).toEqual({ reason: "stale" });
  });

  it("a processed transfer Razorpay will auto-release is not held either", () => {
    expect(mapTransferEvent("transfer_requested", facts({ status: "processed", onHold: true, onHoldUntil: 1893456000 }))).toEqual({
      to: "needs_attention",
      reason: "processed_hold_expires",
      alert: true,
    });
  });

  it("an unreported on_hold is not read as true or false", () => {
    for (const s of PAYOUT_STATUSES.filter((x) => !isTerminal(x))) {
      expect(mapTransferEvent(s, facts({ status: "processed" })), s).toEqual({ reason: "on_hold_unreported" });
    }
  });

  it("failed moves only transfer_requested -> failed", () => {
    const f = facts({ status: "failed" });
    expect(mapTransferEvent("transfer_requested", f)).toEqual({ to: "failed", reason: "failed" });
    expect(mapTransferEvent("failed", f)).toEqual({ reason: "unchanged" });
    for (const s of ["planned", "held", "release_requested", "released", "needs_attention", "manual_required", "reversed"] as const) {
      expect(mapTransferEvent(s, f), s).toEqual({ reason: "stale" });
    }
  });

  it("created and pending say nothing yet", () => {
    for (const s of PAYOUT_STATUSES.filter((x) => !isTerminal(x))) {
      expect(mapTransferEvent(s, facts({ status: "created" })), s).toEqual({ reason: "in_flight" });
      expect(mapTransferEvent(s, facts({ status: "pending" })), s).toEqual({ reason: "in_flight" });
    }
  });

  it("a processed recipient settlement moves released (and a failed one) -> settled, never from earlier states", () => {
    const f = facts({ recipientSettlementStatus: "processed" });
    expect(mapTransferEvent("released", f)).toEqual({ to: "settled", reason: "settled" });
    expect(mapTransferEvent("settlement_failed", f)).toEqual({ to: "settled", reason: "settled" });
    for (const s of ["planned", "transfer_requested", "held", "release_requested", "reversal_requested", "failed", "needs_attention", "manual_required", "reversed"] as const) {
      expect(mapTransferEvent(s, f), s).toEqual({ reason: "stale" });
    }
    expect(mapTransferEvent("settled", f)).toEqual({ reason: "terminal" });
  });

  it("a failed recipient settlement moves released -> settlement_failed with an alert", () => {
    const f = facts({ recipientSettlementStatus: "failed" });
    expect(mapTransferEvent("released", f)).toEqual({ to: "settlement_failed", reason: "settlement_failed", alert: true });
    expect(mapTransferEvent("settlement_failed", f)).toEqual({ reason: "unchanged" });
    expect(mapTransferEvent("held", f)).toEqual({ reason: "stale" });
  });

  it("our own reversal completing moves reversal_requested -> reversed", () => {
    for (const f of [facts({ status: "reversed", amount: 50000, amountReversed: 50000 }), facts({ status: "processed", onHold: true, amount: 50000, amountReversed: 50000 })]) {
      expect(mapTransferEvent("reversal_requested", f)).toEqual({ to: "reversed", reason: "reversed" });
      expect(mapTransferEvent("reversed", f)).toEqual({ reason: "unchanged" });
    }
  });

  it("a reversal we did not ask for parks the payout", () => {
    const f = facts({ status: "reversed", amount: 50000, amountReversed: 50000 });
    for (const s of ["transfer_requested", "held", "release_requested", "released", "settlement_failed"] as const) {
      expect(mapTransferEvent(s, f), s).toEqual({ to: "needs_attention", reason: "reversed_outside_flow", alert: true });
    }
    for (const s of ["planned", "failed", "manual_required"] as const) expect(mapTransferEvent(s, f), s).toEqual({ reason: "stale" });
    expect(mapTransferEvent("needs_attention", f)).toEqual({ reason: "unchanged" });
  });

  it("a partial reversal parks a payout we did not partly reverse, and waits while ours is in flight", () => {
    const f = facts({ status: "partially_reversed", amount: 50000, amountReversed: 100 });
    expect(mapTransferEvent("held", f)).toEqual({ to: "needs_attention", reason: "partially_reversed", alert: true });
    expect(mapTransferEvent("reversal_requested", f)).toEqual({ reason: "reversal_in_flight" });
    expect(mapTransferEvent("planned", f)).toEqual({ reason: "stale" });
  });

  it("facts with nothing usable change nothing", () => {
    for (const s of PAYOUT_STATUSES.filter((x) => !isTerminal(x))) {
      expect(mapTransferEvent(s, facts()), s).toEqual({ reason: "no_facts" });
      expect(mapTransferEvent(s, facts({ status: "whatever" })), s).toEqual({ reason: "no_facts" });
    }
  });

  it("settlement facts outrank transfer facts when both are present", () => {
    const f = facts({ status: "failed", recipientSettlementStatus: "processed" });
    expect(mapTransferEvent("released", f).to).toBe("settled");
  });

  it("an unknown current status moves nowhere", () => {
    expect(mapTransferEvent("nonsense", PROCESSED_HELD)).toEqual({ reason: "unknown_status" });
    expect(mapTransferEvent("", PROCESSED_HELD)).toEqual({ reason: "unknown_status" });
  });

  it("every move it proposes is a legal edge, and never to the same status", () => {
    for (const current of PAYOUT_STATUSES) {
      for (const [label, f] of CATALOG) {
        const m = mapTransferEvent(current, f);
        if (m.to) {
          expect(canMove(current, m.to), `${current} + ${label} -> ${m.to}`).toBe(true);
          expect(m.to, `${current} + ${label}`).not.toBe(current);
        }
        expect(m.reason.length).toBeGreaterThan(0);
      }
    }
  });

  it("applying the same facts twice is the same as once (idempotent re-application)", () => {
    for (const start of PAYOUT_STATUSES) {
      for (const [label, f] of CATALOG) {
        const once = mapTransferEvent(start, f).to ?? start;
        const twice = mapTransferEvent(once, f).to ?? once;
        expect(twice, `${start} + ${label}`).toBe(once);
      }
    }
  });

  it("a replayed or reordered sequence ends where the in-order one does", () => {
    // transfer.processed, a late duplicate of it, then a stale transfer.failed for the same row.
    const step = (s: PayoutStatus, f: TransferFacts): PayoutStatus => mapTransferEvent(s, f).to ?? s;
    const failed = facts({ status: "failed" });
    let s: PayoutStatus = "transfer_requested";
    s = step(s, PROCESSED_HELD);
    s = step(s, PROCESSED_HELD);
    s = step(s, failed);
    expect(s).toBe("held");
    // And in the opposite order the failure wins, then the late "processed" cannot undo it.
    let r: PayoutStatus = "transfer_requested";
    r = step(r, failed);
    r = step(r, PROCESSED_HELD);
    expect(r).toBe("failed");
  });
});
