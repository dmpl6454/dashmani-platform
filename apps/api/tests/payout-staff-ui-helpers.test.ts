/**
 * payout-staff-ui-helpers.test.ts — the staff payout UI's money DECISIONS, held against the API's own rules.
 *
 *   packages/shared/src/payouts/staff-ui.ts — the pure logic behind /campaigns/payouts and the payout panel on a campaign: what reads as
 *   "Paid", which buttons a payout offers, which view a payout belongs to, how a bank reference is checked, how a failed money request is
 *   told apart from a refusal. It lives in @dashmani/shared because the internal portal runs it and this suite is the only test runner in
 *   the repo (apps/internal has none).
 *
 * The UI decides nothing about money (the engine re-checks every click), but it can MISLEAD: a relabelled "Paid", a "Release now" that is
 * enabled while releases are paused, a "Reverse" on a finished row, or a view list that drifted from the API's. Each of those is wording
 * or a button, so no API test can see it. What this file locks:
 *  - only `settled` and `paid_manual` ever read as paid (pill, word, sentence, timeline), and `released` never does;
 *  - the actions offered per status are a SUBSET of the engine's legal moves (canMove / isPausable from payout-states), and a status the
 *    engine knows that this file has no row for fails the test, so a new status forces a decision;
 *  - "Release now" is disabled, with a printed reason, for every reason the release gate has that the UI can know;
 *  - the three copies of the view list (the API's PAYOUT_FILTERS, the UI's keys, the chips) are equal, and payoutInFilter returns the same
 *    payouts as the API's whereForFilter, against a database;
 *  - referenceProblem agrees with the engine's own check on a table that includes a PAN and an IFSC spaced, hyphenated and dotted;
 *  - a gateway error / dropped connection / 5xx is "it may have gone through", only a readable 4xx is "nothing was changed";
 *  - pausing never claims money is set aside except for a held payout.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prisma } from "@dashmani/db";
import { LIVE_ITEM_STATUSES } from "@dashmani/shared";
import "./setup";

vi.mock("../src/services/email.service", async (orig) => {
  const actual = await orig<typeof import("../src/services/email.service")>();
  return { ...actual, sendEmail: vi.fn(async () => ({ messageId: "test" })), notifyAdminByEmail: vi.fn(async () => ({ messageId: "test" })) };
});

import {
  LIVE_ITEM,
  PAYOUT_ATTENTION_KEYS,
  PAYOUT_CHIPS,
  PAYOUT_FILTER_KEYS,
  UNCONFIRMED_TEXT,
  actionsFor,
  ageShort,
  ago,
  attentionCount,
  buildTimeline,
  classifyActionFailure,
  eventTitle,
  isOwedAfterReversal,
  isPayoutFilterKey,
  pauseEffect,
  payoutCounts,
  payoutHint,
  payoutInFilter,
  payoutStatusView,
  payoutViewOrder,
  referenceProblem,
  releaseChangeLine,
  releaseOnOf,
  sortPayoutsForView,
  splitRefusal,
  statusWord,
  switchBars,
  type FilterInput,
  type PayoutActionKey,
  type PayoutFilterKey,
  type PayoutRow,
  type PayoutSwitches,
  type TimelineInput,
} from "@dashmani/shared/src/payouts/staff-ui";
import { PAYOUT_STATUSES, canMove, isPausable } from "../src/services/creator/payout-states";
import { PAYOUT_FILTERS, STAFF_REFUSAL_WORDS, listPayoutQueue } from "../src/services/creator/payout-staff.service";
import { RELEASE_REFUSALS } from "../src/services/creator/payout-policy";
import { referenceProblem as engineReferenceProblem } from "../src/services/creator/payout.service";
import { settlePayoutKicksForTests } from "../src/services/campaign/payment.service";
import { settleCreatorRefundsForTests } from "../src/services/creator/creator-refund.service";
import { clearPayoutAlertMarkersForTests, flushPayoutAlertsForTests, resetPayoutAlertsForTests } from "../src/services/creator/payout-alert";
import { FakeRazorpay } from "./fake-razorpay-route";
import { capture, mkWorld, stubPayoutEnv } from "./payout-fixtures";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const NOW = Date.parse("2026-10-18T10:00:00.000Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const H = 3_600_000;

/** A row as the queue lists it, with only the fields these helpers read set to something meaningful. */
function row(o: Partial<PayoutRow> & { status: string }): PayoutRow {
  return {
    id: "p1", bookingId: "b1", bookingName: "Campaign", bookingItemId: "i1", creatorId: "c1", creatorName: "Asha", pageName: "Page", platform: "instagram", format: "post",
    pausedAt: null, pausedReason: null, itemPricePaise: 250_000, grossPaise: 100_000, tdsPaise: 0, amountPaise: 100_000, amountReversedPaise: 0, destinationHint: null,
    releaseAfter: null, heldAt: null, releasedAt: null, settledAt: null, reversedAt: null, errorCode: null, attempts: 1, settlementUtr: null, manualReference: null, manualPaidAt: null,
    itemStatus: "posted_manual", linkVerifiedAt: null, createdAt: iso(-48 * H), updatedAt: iso(-H), lastEvent: null, ...o,
  };
}

const keys = (r: PayoutRow, ctx: Partial<{ releaseOn: boolean | null | undefined; postVerified: boolean }> = {}) =>
  actionsFor(r, { releaseOn: true, now: NOW, ...ctx }).map((a) => a.key);

// ── "Paid" is never a guess ─────────────────────────────────────────────────────────────────────

describe("what reads as paid", () => {
  const PAID = ["settled", "paid_manual"];

  it("only settled and paid_manual are labelled paid, in the pill and as a word", () => {
    for (const status of PAYOUT_STATUSES) {
      for (const releaseAfter of [null, iso(H)]) {
        const v = payoutStatusView({ status, releaseAfter });
        expect(v.label, status).not.toBe("Unknown");
        expect(/\bpaid\b/i.test(v.label), `${status}: "${v.label}"`).toBe(PAID.includes(status));
      }
      expect(/\bpaid\b/i.test(statusWord(status)), status).toBe(PAID.includes(status));
    }
    // A status the page doesn't know is shown as the API wrote it, never as paid.
    expect(payoutStatusView({ status: "brand_new_state", releaseAfter: null }).label).toBe("Brand New State");
  });

  it("released says it is settling and counts as paid only once settled; no other sentence starts with Paid", () => {
    const released = payoutHint(row({ status: "released", releasedAt: iso(-H) }), NOW);
    expect(released).toMatch(/counts as paid only once it has/);
    expect(released.startsWith("Paid")).toBe(false);
    for (const status of PAYOUT_STATUSES) {
      const h = payoutHint(row({ status, releaseAfter: iso(-H), releasedAt: iso(-H), settledAt: iso(-H), reversedAt: iso(-H) }), NOW);
      expect(h.startsWith("Paid"), `${status}: ${h}`).toBe(PAID.includes(status));
    }
  });

  it("a settled payout names its bank reference and destination; a hand payment names its reference", () => {
    const settled = payoutHint(row({ status: "settled", settledAt: iso(-H), destinationHint: "HDFC ••••1234", settlementUtr: "UTR998877" }), NOW);
    expect(settled).toContain("HDFC ••••1234");
    expect(settled).toContain("Bank reference UTR998877");
    const manual = payoutHint(row({ status: "paid_manual", manualReference: "NEFT55512", manualPaidAt: iso(-H) }), NOW);
    expect(manual).toContain("Reference NEFT55512");
    expect(manual).toMatch(/outside Razorpay/);
  });

  it("the timeline draws the settled step as done only for a settled payout", () => {
    const tl = (status: string, extra: Partial<TimelineInput> = {}) =>
      buildTimeline({ status, createdAt: iso(-48 * H), heldAt: null, releasedAt: null, settledAt: null, reversedAt: null, releaseAfter: null, errorCode: null, destinationHint: null, ...extra });
    for (const status of PAYOUT_STATUSES) {
      const settledStep = tl(status).find((s) => s.key === "settled")!;
      expect(settledStep.state === "done", `${status}: settled step is ${settledStep.state}`).toBe(status === "settled");
    }
    // A released payout's settled step is still ahead of it, with no detail claiming otherwise.
    const released = tl("released", { releasedAt: iso(-H) });
    expect(released.find((s) => s.key === "settled")).toMatchObject({ state: "todo", detail: null });
    expect(released.find((s) => s.key === "released")).toMatchObject({ state: "current" });
    // The settled step carries the bank reference.
    expect(tl("settled", { settledAt: iso(-H), settlementUtr: "UTR1", destinationHint: "HDFC ••••1234" }).find((s) => s.key === "settled")!.detail).toBe("HDFC ••••1234 · bank reference UTR1");
    // A hand payment is its own branch step and says so.
    expect(tl("paid_manual", { manualReference: "NEFT55512" }).at(-1)).toMatchObject({ key: "manual", label: "Paid by bank transfer", state: "done", detail: "Recorded by staff · reference NEFT55512" });
    // Steps a finished-without-paying payout can no longer reach are skipped, not drawn as done.
    expect(tl("void").filter((s) => s.state === "skipped").length).toBeGreaterThan(0);
    expect(tl("void").some((s) => s.key === "settled" && s.state === "done")).toBe(false);
  });

  it("a taken-back payout says whether the creator is still owed", () => {
    const base = { status: "reversed", reversedAt: iso(-H) };
    expect(payoutHint(row({ ...base, itemStatus: "posted_manual" }), NOW)).toMatch(/still owed their share/);
    expect(payoutHint(row({ ...base, itemStatus: "published" }), NOW)).toMatch(/pay them by bank transfer/);
    expect(payoutHint(row({ ...base, itemStatus: "refunded" }), NOW)).toMatch(/nothing is owed/);
    expect(payoutHint(row({ ...base, itemStatus: "refund_due" }), NOW)).toMatch(/nothing is owed/);
    expect(payoutHint(row({ ...base, itemStatus: null }), NOW)).not.toMatch(/owed/);
    const tl = (itemStatus: string | null) =>
      buildTimeline({ status: "reversed", createdAt: iso(-48 * H), heldAt: null, releasedAt: null, settledAt: null, reversedAt: iso(-H), releaseAfter: null, errorCode: null, destinationHint: null, itemStatus }).at(-1)!;
    expect(tl("posted_manual")).toMatchObject({ state: "warn" });
    expect(tl("posted_manual").detail).toMatch(/still owed it/);
    expect(tl("refunded")).toMatchObject({ state: "done" });
    expect(tl("refunded").detail).toMatch(/nothing is owed/);
    // The old sentence ("The creator is not paid for this post") was false for a delivered post: it must not appear for a live one.
    expect(tl("posted_manual").detail).not.toMatch(/is not paid/);
  });
});

// ── Hints never predict what a pause is holding back ────────────────────────────────────────────

describe("hints", () => {
  it("a held, due payout promises a release only when nothing is holding it back", () => {
    const due = row({ status: "held", releaseAfter: iso(-2 * H) });
    expect(payoutHint(due, NOW)).toMatch(/worker releases it on its next run/);
    expect(payoutHint(due, NOW, { releaseOn: true })).toMatch(/worker releases it on its next run/);
    // Releases paused globally: no prediction, and it says why.
    const paused = payoutHint(due, NOW, { releaseOn: false });
    expect(paused).not.toMatch(/worker releases/);
    expect(paused).toMatch(/all releases are paused/);
    const later = payoutHint(row({ status: "held", releaseAfter: iso(20 * H) }), NOW, { releaseOn: false });
    expect(later).toMatch(/scheduled for/);
    expect(later).toMatch(/all releases are paused/);
    // A paused payout is not released by the worker either.
    const own = payoutHint(row({ status: "held", releaseAfter: iso(-2 * H), pausedAt: iso(-H) }), NOW);
    expect(own).not.toMatch(/worker releases/);
    expect(own).toMatch(/paused/);
  });

  it("an unscheduled held payout says what it waits for, and a verified one says the release is missing", () => {
    expect(payoutHint(row({ status: "held" }), NOW)).toMatch(/waits for staff to verify/);
    expect(payoutHint(row({ status: "held" }), NOW, { postVerified: true })).toMatch(/no release is scheduled/);
  });

  it("a planned payout offers the way out, and does not predict a transfer while paused", () => {
    expect(payoutHint(row({ status: "planned" }), NOW)).toMatch(/pay the creator by bank transfer instead/);
    expect(payoutHint(row({ status: "planned", pausedAt: iso(-H) }), NOW)).toMatch(/none will be while it is paused/);
  });

  it("a parked payout explains the codes whose next step differs, and shows any other code", () => {
    expect(payoutHint(row({ status: "needs_attention", errorCode: "listing_unreadable" }), NOW)).toMatch(/re-checked automatically/);
    expect(payoutHint(row({ status: "needs_attention", errorCode: "duplicate_transfer" }), NOW)).toMatch(/exactly one live transfer/);
    expect(payoutHint(row({ status: "needs_attention", errorCode: "something_new" }), NOW)).toMatch(/\(something_new\)/);
  });

  it("ago / ageShort are plain and never negative", () => {
    expect(ago(iso(H), NOW)).toBe("just now");
    expect(ago(iso(-5 * 60_000), NOW)).toBe("5 min ago");
    expect(ago(iso(-3 * H), NOW)).toBe("3 h ago");
    expect(ago(iso(-72 * H), NOW)).toBe("3 d ago");
    expect(ago(null, NOW)).toBe("—");
    expect(ageShort(iso(-12 * 60_000), NOW)).toBe("12m");
    expect(ageShort(iso(-5 * H), NOW)).toBe("5h");
    expect(ageShort(iso(-96 * H), NOW)).toBe("4d");
    expect(eventTitle({ kind: "release", toStatus: "released" })).toBe("Release → released · settling");
  });
});

// ── Which buttons ───────────────────────────────────────────────────────────────────────────────

describe("the action matrix", () => {
  /** What an unpaused, due, verified payout of a LIVE post offers, per status. EVERY engine status must have a row. */
  const EXPECTED: Record<string, PayoutActionKey[]> = {
    planned: ["retry", "require_manual", "pause"],
    transfer_requested: ["pause"],
    held: ["release", "reverse", "pause"],
    release_requested: ["pause"],
    released: ["reverse", "pause"],
    settled: [],
    settlement_failed: ["reverse", "pause"],
    reversal_requested: [],
    reversed: ["require_manual"], // the post is live: the creator is owed their share
    failed: ["retry", "require_manual", "pause"],
    needs_attention: ["reverse", "require_manual", "pause"],
    manual_required: ["mark_paid", "pause"],
    paid_manual: [],
    void: [],
  };

  it("has a row for every status the engine knows (a new status forces a decision here)", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...PAYOUT_STATUSES].sort());
  });

  it("offers exactly these buttons per status", () => {
    for (const status of PAYOUT_STATUSES) {
      expect(keys(row({ status, releaseAfter: iso(-2 * H) })), status).toEqual(EXPECTED[status]);
    }
  });

  it("offers Resume first (and no Pause) on a paused payout that is still in flight, and nothing on a finished one", () => {
    const FINISHED = ["settled", "paid_manual", "void", "reversed"];
    for (const status of PAYOUT_STATUSES) {
      const k = keys(row({ status, releaseAfter: iso(-2 * H), pausedAt: iso(-H) }));
      if (FINISHED.includes(status)) {
        // A paused overlay on a finished payout means nothing (the engine never writes one); its buttons are the unpaused ones.
        expect(k, status).not.toContain("resume");
        expect(k, status).not.toContain("pause");
        continue;
      }
      expect(k[0], status).toBe("resume");
      expect(k, status).not.toContain("pause");
    }
    // A payout whose reversal is under way is never offered Pause, but if it is paused it can be resumed.
    expect(keys(row({ status: "reversal_requested" }))).toEqual([]);
    expect(keys(row({ status: "reversal_requested", pausedAt: iso(-H) }))).toEqual(["resume"]);
  });

  it("never offers a move the engine's state table does not allow, and Pause only where the engine pauses", () => {
    const TARGET: Partial<Record<PayoutActionKey, string>> = { reverse: "reversal_requested", require_manual: "manual_required", mark_paid: "paid_manual", retry: "transfer_requested", release: "release_requested" };
    for (const status of PAYOUT_STATUSES) {
      for (const paused of [false, true]) {
        for (const itemStatus of ["posted_manual", "refunded", null]) {
          for (const a of actionsFor(row({ status, itemStatus, releaseAfter: iso(-2 * H), pausedAt: paused ? iso(-H) : null }), { releaseOn: true, now: NOW })) {
            if (TARGET[a.key]) expect(canMove(status, TARGET[a.key]!), `${a.key} on ${status}`).toBe(true);
            if (a.key === "pause") expect(isPausable(status), `pause on ${status}`).toBe(true);
          }
        }
      }
    }
  });

  it("Reverse is never offered on a finished row, or on one that is already being taken back or has nothing to take back", () => {
    for (const status of ["settled", "paid_manual", "void", "reversed", "reversal_requested", "planned", "transfer_requested", "release_requested", "failed", "manual_required"]) {
      expect(keys(row({ status })), status).not.toContain("reverse");
    }
    // A parked payout that has no Razorpay transfer has nothing to take back (the API refuses it: no_transfer).
    expect(keys(row({ status: "needs_attention", errorCode: "transfer_unknown_after_retry" }))).not.toContain("reverse");
    expect(keys(row({ status: "needs_attention", errorCode: "listing_unreadable" }))).not.toContain("reverse");
    expect(keys(row({ status: "needs_attention", errorCode: "duplicate_transfer" }))).toContain("reverse");
    expect(keys(row({ status: "needs_attention", errorCode: null }))).toContain("reverse");
  });

  it("Mark paid is offered only on manual_required; Retry only on failed and planned; Release only on held", () => {
    for (const status of PAYOUT_STATUSES) {
      const k = keys(row({ status, releaseAfter: iso(-2 * H) }));
      expect(k.includes("mark_paid"), status).toBe(status === "manual_required");
      expect(k.includes("retry"), status).toBe(status === "failed" || status === "planned");
      expect(k.includes("release"), status).toBe(status === "held");
    }
  });

  it("a taken-back payout offers 'pay by bank transfer instead' only while the post is live", () => {
    for (const itemStatus of LIVE_ITEM) expect(keys(row({ status: "reversed", itemStatus })), itemStatus).toEqual(["require_manual"]);
    for (const itemStatus of ["refunded", "refund_due", "failed", "pending", "awaiting_creator", "manual_pending", "queued", null]) {
      expect(keys(row({ status: "reversed", itemStatus })), String(itemStatus)).toEqual([]);
    }
    expect(isOwedAfterReversal({ status: "reversed", itemStatus: "published" })).toBe(true);
    expect(isOwedAfterReversal({ status: "reversed", itemStatus: "refunded" })).toBe(false);
    expect(isOwedAfterReversal({ status: "held", itemStatus: "published" })).toBe(false);
    // The copy of the live statuses kept here (so the module imports nothing) equals the shared one.
    expect([...LIVE_ITEM].sort()).toEqual([...LIVE_ITEM_STATUSES].sort());
  });

  describe("Release now: disabled, with a printed reason, for everything the UI can know", () => {
    const release = (r: PayoutRow, ctx: Partial<{ releaseOn: boolean | null | undefined; postVerified: boolean }> = {}) => actionsFor(r, { releaseOn: true, now: NOW, ...ctx }).find((a) => a.key === "release")!;

    it("is enabled only for a held, unpaused, scheduled payout whose hold has run out, with releases not paused", () => {
      const ok = release(row({ status: "held", releaseAfter: iso(-H) }));
      expect(ok).toMatchObject({ enabled: true, why: null });
      expect(release(row({ status: "held", releaseAfter: iso(-H) }), { releaseOn: undefined }).enabled).toBe(true); // unknown: the API decides
      expect(release(row({ status: "held", releaseAfter: iso(-H) }), { releaseOn: null }).enabled).toBe(true);
    });

    it("is disabled while ALL releases are paused, and the reason does not point at a banner that may not be on the page", () => {
      const r = release(row({ status: "held", releaseAfter: iso(-H) }), { releaseOn: false });
      expect(r.enabled).toBe(false);
      expect(r.why).toMatch(/All releases are paused/);
      expect(r.why).not.toMatch(/banner/i);
    });

    it("is disabled while the payout is paused, unscheduled (verified or not) or its hold has not run out", () => {
      expect(release(row({ status: "held", releaseAfter: iso(-H), pausedAt: iso(-H) }))).toMatchObject({ enabled: false, why: "Paused: resume it first." });
      expect(release(row({ status: "held" }))).toMatchObject({ enabled: false, why: expect.stringMatching(/hasn't been verified yet/) });
      expect(release(row({ status: "held" }), { postVerified: true })).toMatchObject({ enabled: false, why: expect.stringMatching(/no release is scheduled/) });
      expect(release(row({ status: "held", releaseAfter: iso(5 * H) }))).toMatchObject({ enabled: false, why: expect.stringMatching(/The hold runs until/) });
    });

    it("every disabled button has a reason", () => {
      for (const status of PAYOUT_STATUSES) {
        for (const releaseOn of [true, false, undefined]) {
          for (const releaseAfter of [null, iso(-H), iso(H)]) {
            for (const pausedAt of [null, iso(-H)]) {
              for (const a of actionsFor(row({ status, releaseAfter, pausedAt }), { releaseOn, now: NOW })) expect(a.enabled || !!a.why, `${a.key} on ${status}`).toBe(true);
            }
          }
        }
      }
    });
  });
});

// ── What pausing says ───────────────────────────────────────────────────────────────────────────

describe("pausing one payout", () => {
  it("says money stays set aside only for a held payout", () => {
    for (const status of PAYOUT_STATUSES) {
      const t = pauseEffect(status).text;
      if (status === "held") expect(t).toMatch(/stays on hold at Razorpay/);
      else expect(t, status).not.toMatch(/set aside|stays on hold|stays set aside/i);
    }
  });

  it("warns, rather than reassures, once a release was requested or made", () => {
    for (const status of ["released", "release_requested"]) {
      const e = pauseEffect(status);
      expect(e.warn, status).toBe(true);
      expect(e.text).toMatch(/Pausing does not stop that/);
    }
    for (const status of PAYOUT_STATUSES.filter((s) => s !== "released" && s !== "release_requested")) expect(pauseEffect(status).warn, status).toBe(false);
  });

  it("does not describe an unconfirmed outcome as safe, and says a planned transfer is not made", () => {
    for (const status of ["transfer_requested", "needs_attention"]) expect(pauseEffect(status).text).toMatch(/isn't confirmed/);
    expect(pauseEffect("planned").text).toMatch(/No transfer will be made/);
    for (const status of ["failed", "manual_required"]) expect(pauseEffect(status).text).toMatch(/Nothing is retried or paid out/);
  });
});

// ── The views ───────────────────────────────────────────────────────────────────────────────────

describe("the queue's views", () => {
  it("the UI's filter keys, the chips and the API's PAYOUT_FILTERS are the same list", () => {
    expect([...PAYOUT_FILTER_KEYS].sort()).toEqual([...PAYOUT_FILTERS].sort());
    expect(new Set(PAYOUT_FILTER_KEYS).size).toBe(PAYOUT_FILTER_KEYS.length);
    // Every view has exactly one chip.
    expect(PAYOUT_CHIPS.map((c) => c.key).sort()).toEqual([...PAYOUT_FILTERS].sort());
    for (const k of PAYOUT_FILTERS) expect(isPayoutFilterKey(k), k).toBe(true);
    for (const bad of ["", "everything", "OPEN", null, undefined, 3]) expect(isPayoutFilterKey(bad)).toBe(false);
  });

  it("every chip says what it is, and the attention views are the disjoint ones a person acts on", () => {
    for (const c of PAYOUT_CHIPS) {
      expect(c.label.length, c.key).toBeGreaterThan(0);
      expect(c.blurb.length, c.key).toBeGreaterThan(10);
      expect(c.attention, c.key).toBe((PAYOUT_ATTENTION_KEYS as readonly string[]).includes(c.key));
    }
    // The history views come last and list newest first; the work lists list oldest first.
    expect(PAYOUT_CHIPS.filter((c) => c.group === "history").map((c) => c.key)).toEqual(["finished", "all"]);
    const firstHistory = PAYOUT_CHIPS.findIndex((c) => c.group === "history");
    expect(PAYOUT_CHIPS.slice(firstHistory).every((c) => c.group === "history")).toBe(true);
    for (const c of PAYOUT_CHIPS) expect(payoutViewOrder(c.key), c.key).toBe(c.group === "history" ? "newest" : "oldest");
  });

  it("the attention count adds up the four views, and is unknown until the counts load", () => {
    expect(attentionCount(undefined)).toBeUndefined();
    expect(attentionCount({})).toBe(0);
    expect(attentionCount({ needs_attention: 2, manual_required: 1, failed: 3, owed_after_reversal: 4, open: 99, paused: 7 })).toBe(10);
  });

  /** One payout of every kind, to count. */
  const ROWS: FilterInput[] = [
    { status: "planned", pausedAt: null, releaseAfter: null },
    { status: "transfer_requested", pausedAt: null, releaseAfter: null },
    { status: "held", pausedAt: null, releaseAfter: null },
    { status: "held", pausedAt: null, releaseAfter: iso(H) },
    { status: "held", pausedAt: iso(-H), releaseAfter: iso(H) },
    { status: "release_requested", pausedAt: null, releaseAfter: iso(-H) },
    { status: "released", pausedAt: null, releaseAfter: iso(-H) },
    { status: "settled", pausedAt: null, releaseAfter: iso(-H) },
    { status: "settled", pausedAt: iso(-H), releaseAfter: iso(-H) },
    { status: "settlement_failed", pausedAt: null, releaseAfter: null },
    { status: "reversal_requested", pausedAt: null, releaseAfter: null },
    { status: "reversed", pausedAt: null, releaseAfter: null, itemStatus: "posted_manual" },
    { status: "reversed", pausedAt: null, releaseAfter: null, itemStatus: "refunded" },
    { status: "failed", pausedAt: null, releaseAfter: null },
    { status: "needs_attention", pausedAt: iso(-H), releaseAfter: null },
    { status: "manual_required", pausedAt: null, releaseAfter: null },
    { status: "paid_manual", pausedAt: null, releaseAfter: null },
    { status: "void", pausedAt: null, releaseAfter: null },
  ];

  it("counts every view over a set of payouts (and a paused finished payout is not 'paused')", () => {
    const c = payoutCounts(ROWS);
    expect(c).toEqual({
      open: 12,
      needs_attention: 1,
      manual_required: 1,
      paused: 2, // the held one and the parked one; the paused settled one is finished
      held_awaiting_verify: 1,
      releasing: 3, // a scheduled held (twice: one paused) and a release_requested
      settlement_pending: 1,
      failed: 2, // failed + settlement_failed
      owed_after_reversal: 1, // only the reversed payout whose post is live
      finished: 6,
      all: 18,
    });
    expect(c.open + c.finished).toBe(c.all);
    expect(Object.keys(c).sort()).toEqual([...PAYOUT_FILTERS].sort());
  });

  it("sorts like the API: the work lists oldest first, the history views newest first, ties by id", () => {
    const rows = [
      { id: "b", createdAt: "2026-10-02T00:00:00.000Z" },
      { id: "a", createdAt: "2026-10-02T00:00:00.000Z" },
      { id: "c", createdAt: "2026-10-01T00:00:00.000Z" },
      { id: "d", createdAt: "2026-10-03T00:00:00.000Z" },
    ];
    expect(sortPayoutsForView(rows, "open").map((r) => r.id)).toEqual(["c", "a", "b", "d"]);
    expect(sortPayoutsForView(rows, "finished").map((r) => r.id)).toEqual(["d", "b", "a", "c"]);
    expect(sortPayoutsForView(rows, "all").map((r) => r.id)).toEqual(["d", "b", "a", "c"]);
    expect(rows.map((r) => r.id)).toEqual(["b", "a", "c", "d"]); // the input is not reordered
  });
});

// ── The same views as the API's, against a database ─────────────────────────────────────────────

describe("payoutInFilter returns the payouts the API's own filters return", () => {
  const fake = new FakeRazorpay();

  beforeEach(async () => {
    await prisma.systemSetting.deleteMany({ where: { key: "creatorPayouts.release" } });
    await clearPayoutAlertMarkersForTests();
    stubPayoutEnv();
    fake.reset();
    fake.install();
    resetPayoutAlertsForTests();
  });
  afterEach(async () => {
    await settlePayoutKicksForTests();
    await settleCreatorRefundsForTests();
    await flushPayoutAlertsForTests();
    fake.restore();
    vi.unstubAllEnvs();
  });

  it("agrees on every view, for a campaign holding a payout of every kind (paused and live/returned posts included)", async () => {
    const SPECS: Array<{ name: string; payout: Record<string, unknown>; item?: string }> = [
      { name: "planned", payout: { status: "planned" } },
      { name: "transfer_requested", payout: { status: "transfer_requested" } },
      { name: "held, unscheduled", payout: { status: "held", releaseAfter: null } },
      { name: "held, scheduled", payout: { status: "held", releaseAfter: new Date(Date.now() + 86_400_000) } },
      { name: "held, scheduled, paused", payout: { status: "held", releaseAfter: new Date(Date.now() + 86_400_000), pausedAt: new Date(), pausedReason: "staff" } },
      { name: "release_requested", payout: { status: "release_requested", releaseAfter: new Date(Date.now() - 3_600_000) } },
      { name: "released", payout: { status: "released" } },
      { name: "settled", payout: { status: "settled" } },
      { name: "settled, paused", payout: { status: "settled", pausedAt: new Date(), pausedReason: "staff" } },
      { name: "settlement_failed", payout: { status: "settlement_failed" } },
      { name: "reversal_requested", payout: { status: "reversal_requested" } },
      { name: "reversed, post live", payout: { status: "reversed" }, item: "posted_manual" },
      { name: "reversed, post published", payout: { status: "reversed" }, item: "published" },
      { name: "reversed, client refunded", payout: { status: "reversed" }, item: "refunded" },
      { name: "reversed, refund due", payout: { status: "reversed" }, item: "refund_due" },
      { name: "failed", payout: { status: "failed" } },
      { name: "needs_attention, paused", payout: { status: "needs_attention", pausedAt: new Date(), pausedReason: "dispute" } },
      { name: "manual_required", payout: { status: "manual_required" } },
      { name: "paid_manual", payout: { status: "paid_manual" } },
      { name: "void", payout: { status: "void" } },
    ];
    const w = await mkWorld(fake, { pages: SPECS.map(() => ({})) });
    expect((await capture(fake, w)).status).toBe(200);
    // Force each payout into the state under test (the engine's own moves are tested elsewhere; this is about how the views sort them).
    for (const [i, s] of SPECS.entries()) {
      const id = w.creators[i].id;
      await prisma.creatorPayout.update({ where: { bookingItemId: id }, data: { pausedAt: null, pausedReason: null, releaseAfter: null, ...s.payout } as never });
      await prisma.campaignBookingItem.update({ where: { id }, data: { status: s.item ?? "posted_manual" } });
    }

    const page = (filter: PayoutFilterKey) => listPayoutQueue({ filter, bookingId: w.booking.id, limit: 200 });
    // What the UI holds is the campaign's `all` page as JSON.
    const all = JSON.parse(JSON.stringify((await page("all")).rows)) as PayoutRow[];
    expect(all).toHaveLength(SPECS.length);

    for (const filter of PAYOUT_FILTERS) {
      const server = await page(filter);
      const serverIds = server.rows.map((r) => r.id);
      const mine = sortPayoutsForView(all.filter((r) => payoutInFilter(r, filter)), filter);
      expect(mine.map((r) => r.id), `view ${filter}: same payouts, same order`).toEqual(serverIds);
      expect(server.nextCursor).toBeNull();
    }
    // The UI's own counts for the campaign equal the numbers of rows each view lists (the API's `counts` are company-wide).
    const counts = payoutCounts(all);
    for (const filter of PAYOUT_FILTERS) expect(counts[filter], `count of ${filter}`).toBe((await page(filter)).rows.length);
    // Spot checks that the fixture really covered the interesting cases.
    expect(counts.owed_after_reversal).toBe(2);
    expect(counts.paused).toBe(2);
    expect(counts.finished).toBe(8); // settled ×2, reversed ×4, paid_manual, void
  });
});

// ── The bank reference ──────────────────────────────────────────────────────────────────────────

describe("referenceProblem", () => {
  const REFS = [
    "UTR123456789", "HDFCR52026101812345", "N123 4567", "NEFT/20261018/55512", "abcd", "ABCD", "ABC", "", "   ", "12345678901234",
    "x".repeat(100), "x".repeat(101), "  UTR123456  ",
    // A PAN, however it is spaced, hyphenated or dotted
    "ABCDE1234F", "abcde1234f", "ABCDE 1234 F", "ABCDE-1234-F", "ABCDE.1234.F", "ABCDE_1234_F", "PAN ABCDE1234F", "ref ABCDE/1234/F ok",
    // An IFSC, likewise
    "HDFC0001234", "hdfc0abc123", "HDFC 0001234", "HDFC-0-001234", "HDFC.0.001234", "IFSC HDFC0001234 x",
    // Characters the reference may not carry
    "UTR@123456", "UTR123456é", "UTR\n123456", "UTR\t123456", "-UTR123456", " _UTR123456", "UTR123456;",
  ];

  it("agrees with the engine's own check on every reference (the engine trims first, as markManualPaid does)", () => {
    for (const ref of REFS) {
      const engine = engineReferenceProblem(ref.trim());
      const ui = referenceProblem(ref);
      expect(ui === null, `${JSON.stringify(ref)}: ui=${ui} engine=${engine}`).toBe(engine === null);
    }
  });

  it("refuses a PAN or an IFSC with its own sentence, and a short or malformed reference with another", () => {
    expect(referenceProblem("ABCDE 1234 F")).toMatch(/PAN or an IFSC/);
    expect(referenceProblem("HDFC-0-001234")).toMatch(/PAN or an IFSC/);
    expect(referenceProblem("abc")).toMatch(/At least 4/);
    expect(referenceProblem("UTR@123456")).toMatch(/Use letters, digits/);
    expect(referenceProblem("UTR123456789")).toBeNull();
    expect(referenceProblem("  UTR123456  ")).toBeNull();
  });
});

// ── A refusal, and an answer we never got ───────────────────────────────────────────────────────

describe("a failed money request", () => {
  it("is a refusal only when the API's own envelope answered with a 4xx: its sentence is kept", () => {
    for (const status of [400, 401, 403, 404, 409, 422, 429]) {
      const f = classifyActionFailure({ status, readable: true, message: "Not done: release this payout. A dispute is open. Nothing was changed. [dispute_at_razorpay]" });
      expect(f.unconfirmed, String(status)).toBe(false);
      expect(f.text).toContain("A dispute is open");
    }
    expect(classifyActionFailure({ status: 409, readable: true, message: "  " }).text).toMatch(/Nothing was changed/);
  });

  it("says it MAY have gone through for a gateway page, a dropped connection, any 5xx (even JSON) and a request timeout", () => {
    const cases: Array<[string, { status: number | null; readable: boolean }]> = [
      ["502 html", { status: 502, readable: false }],
      ["504 html", { status: 504, readable: false }],
      ["dropped connection", { status: null, readable: false }],
      ["500 json", { status: 500, readable: true }],
      ["503 json", { status: 503, readable: true }],
      ["408 timeout", { status: 408, readable: true }],
      ["200 not json", { status: 200, readable: false }],
      ["unreadable 409", { status: 409, readable: false }],
    ];
    for (const [name, c] of cases) {
      const f = classifyActionFailure({ ...c, message: "Unexpected token '<', \"<html>…\" is not valid JSON" });
      expect(f.unconfirmed, name).toBe(true);
      expect(f.text, name).toMatch(/may have been done/);
      expect(f.text, name).toMatch(/check its status before trying again/);
      expect(f.text, name).not.toMatch(/Unexpected token|valid JSON|Nothing was changed/);
      expect(f.text).toBe(UNCONFIRMED_TEXT);
    }
  });

  it("adds that repeating is safe only for the payout actions", () => {
    const repeat = classifyActionFailure({ status: 502, readable: false, message: "" }, { repeatSafe: true });
    expect(repeat.text).toMatch(/Trying again is safe/);
    expect(classifyActionFailure({ status: 502, readable: false, message: "" }).text).not.toMatch(/safe/);
  });

  it("splits the API's trailing code off its sentence", () => {
    expect(splitRefusal("Not done: x. Nothing was changed. [release_not_due]")).toEqual({ text: "Not done: x. Nothing was changed.", code: "release_not_due" });
    expect(splitRefusal("No code here")).toEqual({ text: "No code here", code: null });
    expect(splitRefusal("Bracket [in the middle] stays")).toEqual({ text: "Bracket [in the middle] stays", code: null });
    // A code-shaped word in the MIDDLE of the sentence is part of the sentence: only the trailing one is the code.
    expect(splitRefusal("It mentions [release_not_due] midway. Nothing was changed.")).toEqual({ text: "It mentions [release_not_due] midway. Nothing was changed.", code: null });
    expect(splitRefusal("It mentions [first_one] midway. Nothing was changed. [second_one]")).toEqual({ text: "It mentions [first_one] midway. Nothing was changed.", code: "second_one" });
  });
});

// ── The sentences the API puts in a refusal ─────────────────────────────────────────────────────

describe("the API's plain-words table for a refusal", () => {
  it("has a sentence for every reason the release gate can give, and for the manual-payment and refund-ordering reasons the dialogs show", () => {
    const manualAndOrdering = [
      "not_manual_required", "transfer_unchecked", "listing_unchecked", "transfer_active", "transfer_not_failed", "transfer_exists", "not_reversed", "item_refunded",
      "transfer_not_ours", "invalid_reference", "needs_human", "post_not_live", "no_transfer", "retry_disabled", "reversal_failed_state", "not_reversible",
    ];
    const missing = [...RELEASE_REFUSALS, ...manualAndOrdering].filter((code) => !STAFF_REFUSAL_WORDS[code]);
    expect(missing, "reasons that would read 'not possible in its current state'").toEqual([]);
  });

  it("never puts a Razorpay id or a long number (an account number) in those sentences", () => {
    // (Some sentences name a PAN or an IFSC as things NOT to record; none carries one.)
    for (const [code, text] of Object.entries(STAFF_REFUSAL_WORDS)) {
      expect(text.length, code).toBeGreaterThan(10);
      expect(text, code).not.toMatch(/\b(acc|trf|pay|rfnd|setl|disp)_[A-Za-z0-9]{6,}|\d{9,}/);
    }
  });
});

// ── The switches ────────────────────────────────────────────────────────────────────────────────

describe("the switches", () => {
  it("the dedicated release-switch read wins over the queue's copy; with neither, it is unknown", () => {
    expect(releaseOnOf("off", true)).toBe(false);
    expect(releaseOnOf("on", false)).toBe(true);
    expect(releaseOnOf(undefined, false)).toBe(false);
    expect(releaseOnOf(null, true)).toBe(true);
    expect(releaseOnOf(undefined, undefined)).toBeUndefined();
    expect(releaseOnOf(undefined, null)).toBeUndefined();
  });

  it("says who paused releases only when that change is the current state", () => {
    const fmt = (iso: string) => `<${iso}>`;
    const change = { at: "2026-10-18T09:00:00.000Z", byId: "u1", byName: "Priya", from: "on" as const, to: "off" as const };
    expect(releaseChangeLine({ release: "off", updatedAt: change.at, lastChange: change }, fmt)).toBe("Paused by Priya on <2026-10-18T09:00:00.000Z>.");
    expect(releaseChangeLine({ release: "on", updatedAt: change.at, lastChange: { ...change, from: "off", to: "on" } }, fmt)).toBe("Resumed by Priya on <2026-10-18T09:00:00.000Z>.");
    expect(releaseChangeLine({ release: "off", updatedAt: change.at, lastChange: { ...change, byName: null } }, fmt)).toBe("Paused by a staff member on <2026-10-18T09:00:00.000Z>.");
    // The latest audit row says "off", but the switch is on now: someone changed it by hand since. No name is claimed.
    expect(releaseChangeLine({ release: "on", updatedAt: "2026-10-18T09:30:00.000Z", lastChange: change }, fmt)).toMatch(/not through this portal/);
    expect(releaseChangeLine({ release: "off", updatedAt: "2026-10-18T09:30:00.000Z", lastChange: null }, fmt)).toMatch(/nobody's name is on record/);
    expect(releaseChangeLine({ release: "on", updatedAt: null, lastChange: null }, fmt)).toBeNull();
    expect(releaseChangeLine(undefined, fmt)).toBeNull();
  });

  it("draws a bar for each switch that is OFF (=== false) and none for one that is unknown", () => {
    expect(switchBars(undefined)).toEqual([]);
    expect(switchBars({})).toEqual([]);
    expect(switchBars({ release: false, newTransfers: true, worker: true, razorpay: true })).toEqual([]); // the release pause has its own banner
    const all: PayoutSwitches = { razorpay: false, newTransfers: false, worker: false };
    expect(switchBars(all).map((b) => b.key)).toEqual(["razorpay_missing", "new_transfers_off", "worker_off"]);
    expect(switchBars({ razorpay: false })[0].text).toMatch(/keys are missing/);
    expect(switchBars({ razorpay: false })[0].text).not.toMatch(/CREATOR_ROUTE_ENABLED/);
    expect(switchBars({ newTransfers: false })[0].text).toMatch(/CREATOR_ROUTE_ENABLED/);
  });
});
