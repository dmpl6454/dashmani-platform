/**
 * Razorpay Route webhook handlers (services/campaign/route-webhooks.ts), DB-backed. Payload
 * shapes follow Razorpay's own samples where they exist (settlement.processed and the three
 * product.route.* events); transfer.* and payment.dispute.* shapes are UNVERIFIED in the docs
 * (plan question g, [R32]), so those events are built from the documented transfer entity and the
 * dispute entity as best known, and the tests lean on what MUST hold whatever the real shape is:
 * the handler never throws, only moves a payout along the state table, and stores no secrets.
 * Razorpay itself is never called; email is stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma, Prisma, PrismaClient } from "@dashmani/db";

// The mailer's contract matters here: sendEmail resolves to null when SMTP is unconfigured or the
// send failed, and to the SMTP result otherwise. So a stub that resolves null is a FAILED send.
const SENT = { messageId: "test" };
vi.mock("../src/services/email.service", async (orig) => {
  const actual = await orig<typeof import("../src/services/email.service")>();
  return { ...actual, sendEmail: vi.fn(async () => ({ messageId: "test" })), notifyAdminByEmail: vi.fn(async () => ({ messageId: "test" })) };
});

import { notifyAdminByEmail } from "../src/services/email.service";
import * as routeWebhooks from "../src/services/campaign/route-webhooks";
import { isRouteEvent, handleRouteEvent } from "../src/services/campaign/route-webhooks";
import { alertStaffOncePerHour, flushPayoutAlertsForTests, resetPayoutAlertsForTests } from "../src/services/creator/payout-alert";
import { pausePayoutsOfPayment, pausePayoutsOfPaymentRows } from "../src/services/creator/payout-pause";
import { flushRouteWebhookBackgroundForTests } from "../src/services/campaign/route-webhooks";
import { runPayoutJob, selectDuePayouts } from "../src/services/creator/payout.service";
import { FakeRazorpay, is } from "./fake-razorpay-route";

const notify = vi.mocked(notifyAdminByEmail);

const ACC = "acc_TESTLINKED0001";
const PAY = "pay_TESTPAYMENT001";
const TRF = "trf_TESTTRANSFER01";
const SETL = "setl_TESTSETTLE0001";
const PRODUCT = "acc_prd_TESTPRODUCT01";
const DISPUTE = "disp_TESTDISPUTE001";

const uid = () => crypto.randomUUID();
const nowSec = () => Math.floor(Date.now() / 1000);

async function mkPayout(over: Record<string, unknown> = {}) {
  return prisma.creatorPayout.create({
    data: {
      bookingId: uid(),
      bookingItemId: uid(),
      creatorId: uid(),
      payoutAccountId: uid(),
      razorpayAccountId: ACC,
      razorpayPaymentId: PAY,
      itemPricePaise: 100000,
      shareBps: 5000,
      grossPaise: 50000,
      amountPaise: 50000,
      status: "transfer_requested",
      razorpayTransferId: TRF,
      ...over,
    },
  });
}

const reload = (id: string) => prisma.creatorPayout.findUniqueOrThrow({ where: { id } });
const eventsOf = (id: string) => prisma.creatorPayoutEvent.findMany({ where: { payoutId: id }, orderBy: { createdAt: "asc" } });

/** The label -> value rows of one staff email (the mailer stub's second argument). */
const detailsOf = (call: unknown[]): Record<string, string> => Object.fromEntries((call[1] as Array<{ label: string; value: string }>).map((d) => [d.label, d.value]));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(check: () => Promise<boolean>, what: string, timeoutMs = 8000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ── Event builders ──────────────────────────────────────────────────────────────

function transferEvt(event: "transfer.processed" | "transfer.failed", row: { id: string }, entity: Record<string, unknown> = {}, top: Record<string, unknown> = {}) {
  return {
    entity: "event",
    account_id: "acc_PLATFORM00001",
    event,
    contains: ["transfer"],
    payload: {
      transfer: {
        entity: {
          id: TRF,
          entity: "transfer",
          status: event === "transfer.processed" ? "processed" : "failed",
          source: PAY,
          recipient: ACC,
          amount: 50000,
          currency: "INR",
          amount_reversed: 0,
          notes: { payout_id: row.id, booking_item_id: "item" },
          fees: 13,
          tax: 2,
          on_hold: true,
          on_hold_until: null,
          settlement_status: "on_hold",
          recipient_settlement_id: null,
          created_at: nowSec() - 120,
          processed_at: nowSec() - 100,
          ...entity,
        },
      },
    },
    created_at: nowSec() - 90,
    ...top,
  };
}

function settlementEvt(entity: Record<string, unknown> = {}, top: Record<string, unknown> = {}) {
  return {
    entity: "event",
    account_id: "acc_PR7UDve9UNcOxW",
    event: "settlement.processed",
    contains: ["settlement"],
    payload: { settlement: { entity: { id: SETL, entity: "settlement", amount: 1524, status: "processed", fees: 0, tax: 0, utr: "AXISCN1153863727", created_at: nowSec() - 3600, ...entity } } },
    created_at: nowSec() - 60,
    ...top,
  };
}

function productEvt(event: string, status: string, data: unknown = [], over: { accountId?: string; productId?: string; at?: number } = {}) {
  const accountId = over.accountId ?? ACC;
  return {
    entity: "event",
    account_id: accountId,
    event,
    contains: ["merchant_product"],
    payload: { merchant_product: { entity: { id: over.productId ?? PRODUCT, merchant_id: accountId, activation_status: status }, data } },
    created_at: over.at ?? nowSec() - 30,
  };
}

function disputeEvt(event: string, entity: Record<string, unknown> = {}, at = nowSec() - 20) {
  return {
    entity: "event",
    account_id: "acc_PLATFORM00001",
    event,
    contains: ["payment", "dispute"],
    payload: {
      payment: { entity: { id: PAY, entity: "payment", amount: 100000 } },
      dispute: {
        entity: {
          id: DISPUTE,
          entity: "dispute",
          payment_id: PAY,
          amount: 100000,
          currency: "INR",
          amount_deducted: 0,
          reason_code: "chargeback",
          respond_by: nowSec() + 7 * 86400,
          status: "open",
          phase: "chargeback",
          created_at: nowSec() - 3600,
          ...entity,
        },
      },
    },
    created_at: at,
  };
}

beforeEach(() => {
  resetPayoutAlertsForTests();
  // mockReset (not mockClear) so a queued mockResolvedValueOnce can never leak into the next test.
  notify.mockReset();
  notify.mockResolvedValue(SENT as never);
});

// An alert's email and its `alerted_*` stamp happen AFTER the handler returned (the webhook does
// not wait for SMTP): let them finish before the next test truncates the tables.
afterEach(async () => {
  await flushPayoutAlertsForTests();
});

// ── Routing ─────────────────────────────────────────────────────────────────────

describe("isRouteEvent / exports", () => {
  it("claims exactly transfer.*, settlement.*, product.route.* and payment.dispute.*", () => {
    for (const e of [
      "transfer.processed",
      "transfer.failed",
      "transfers.failed", // Razorpay's subscribe page spells it this way
      "settlement.processed",
      "product.route.under_review",
      "product.route.needs_clarification",
      "product.route.activated",
      "payment.dispute.created",
      "payment.dispute.lost",
      "payment.dispute.some_event_nobody_documented",
    ]) {
      expect(isRouteEvent(e), e).toBe(true);
    }
    for (const e of ["payment.captured", "order.paid", "payment.failed", "payment.authorized", "refund.processed", "refund.failed", "settlements", "product.other.thing", "", "disputes.created"]) {
      expect(isRouteEvent(e), e).toBe(false);
    }
    expect(isRouteEvent(undefined as unknown as string)).toBe(false);
    expect(isRouteEvent(42 as unknown as string)).toBe(false);
  });

  it("exports isRouteEvent and handleRouteEvent, plus the one hook a test uses to wait for the background hold confirmation", () => {
    expect(Object.keys(routeWebhooks).sort()).toEqual(["flushRouteWebhookBackgroundForTests", "handleRouteEvent", "isRouteEvent"]);
  });

  it("a non-route event is not handled", async () => {
    expect(await handleRouteEvent("payment.captured", {})).toEqual({ handled: false, note: "not a route event" });
  });
});

// ── transfer.processed / transfer.failed ────────────────────────────────────────

describe("transfer events", () => {
  it("transfer.processed with on_hold:true moves transfer_requested -> held and writes one audit row", async () => {
    const row = await mkPayout();
    const r = await handleRouteEvent("transfer.processed", transferEvt("transfer.processed", row), "evt_proc_1");
    expect(r).toEqual({ handled: true, note: "held" });
    const after = await reload(row.id);
    expect(after.status).toBe("held");
    expect(after.transferStatus).toBe("processed");
    expect(after.settlementStatus).toBe("on_hold");
    expect(after.heldAt).toBeInstanceOf(Date);
    expect(after.transferFeesPaise).toBe(13);
    expect(after.transferTaxPaise).toBe(2);
    expect(after.errorCode).toBeNull();
    // A webhook is Razorpay reporting, not a fresh fetch: the verification stamp stays for the job.
    expect(after.onHoldVerifiedAt).toBeNull();
    const ev = await eventsOf(row.id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: "transfer", fromStatus: "transfer_requested", toStatus: "held", actorType: "razorpay", razorpayEventId: "evt_proc_1", bookingId: row.bookingId, amountPaise: 50000 });
    expect(notify).not.toHaveBeenCalled(); // held is good news
  });

  it("a duplicate of the same event is a no-op: one audit row, the same heldAt", async () => {
    const row = await mkPayout();
    const evt = transferEvt("transfer.processed", row);
    await handleRouteEvent("transfer.processed", evt);
    const first = await reload(row.id);
    const again = await handleRouteEvent("transfer.processed", evt);
    expect(again).toEqual({ handled: true, note: "unchanged" });
    const second = await reload(row.id);
    expect(second.heldAt).toEqual(first.heldAt);
    expect(second.updatedAt).toEqual(first.updatedAt);
    expect(await eventsOf(row.id)).toHaveLength(1);
  });

  it("two identical events racing each other change the row exactly once", async () => {
    const row = await mkPayout();
    const evt = transferEvt("transfer.processed", row);
    const results = await Promise.all([handleRouteEvent("transfer.processed", evt), handleRouteEvent("transfer.processed", evt), handleRouteEvent("transfer.processed", evt)]);
    for (const r of results) expect(r.handled).toBe(true);
    expect(await eventsOf(row.id)).toHaveLength(1);
    expect((await reload(row.id)).status).toBe("held");
  });

  it("a stale transfer.failed after held cannot drag the row back; a late processed after failed cannot revive it", async () => {
    const held = await mkPayout({ status: "held" });
    const r1 = await handleRouteEvent("transfer.failed", transferEvt("transfer.failed", held));
    expect(r1).toEqual({ handled: true, note: "stale" });
    expect((await reload(held.id)).status).toBe("held");
    expect(await eventsOf(held.id)).toHaveLength(0);

    const requested = await mkPayout({ status: "transfer_requested", razorpayTransferId: "trf_OTHER0000001" });
    const entity = { id: "trf_OTHER0000001", notes: { payout_id: requested.id } };
    await handleRouteEvent("transfer.failed", transferEvt("transfer.failed", requested, entity));
    expect((await reload(requested.id)).status).toBe("failed");
    const late = await handleRouteEvent("transfer.processed", transferEvt("transfer.processed", requested, entity));
    expect(late).toEqual({ handled: true, note: "stale" });
    expect((await reload(requested.id)).status).toBe("failed");
  });

  it("events for rows already past held (released, settled, reversed) change nothing", async () => {
    for (const status of ["release_requested", "released", "settled", "reversed", "void", "needs_attention"]) {
      await prisma.creatorPayout.deleteMany({});
      const row = await mkPayout({ status });
      const r = await handleRouteEvent("transfer.processed", transferEvt("transfer.processed", row));
      expect(r.handled, status).toBe(true);
      expect((await reload(row.id)).status, status).toBe(status);
      expect(await eventsOf(row.id), status).toHaveLength(0);
    }
  });

  it("an event for a transfer no payout points at is ignored, silently", async () => {
    const row = await mkPayout();
    const r = await handleRouteEvent("transfer.processed", transferEvt("transfer.processed", row, { id: "trf_SOMEONEELSE001" }));
    expect(r).toEqual({ handled: false, note: "no payout for this transfer" });
    expect((await reload(row.id)).status).toBe("transfer_requested");
    expect(notify).not.toHaveBeenCalled();
  });

  it("a payout that has replaced its transfer ignores the old transfer's events", async () => {
    // The row now points at trf_NEW (the first transfer was reversed as a duplicate).
    const row = await mkPayout({ razorpayTransferId: "trf_NEW000000001" });
    const r = await handleRouteEvent("transfer.processed", transferEvt("transfer.processed", row, { id: TRF }));
    expect(r.handled).toBe(false);
    expect((await reload(row.id)).status).toBe("transfer_requested");
  });

  it("a matching transfer id with a different recipient, payment, note or amount is parked, never held", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["recipient", { recipient: "acc_SOMEONEELSE001" }],
      ["payment", { source: "pay_SOMEOTHERPAY001" }],
      ["amount", { amount: 60000 }],
    ];
    for (const [what, entity] of cases) {
      await prisma.creatorPayout.deleteMany({});
      resetPayoutAlertsForTests();
      notify.mockClear();
      const row = await mkPayout();
      const r = await handleRouteEvent("transfer.processed", transferEvt("transfer.processed", row, entity));
      expect(r.note, what).toBe("transfer_mismatch");
      const after = await reload(row.id);
      expect(after.status, what).toBe("needs_attention");
      expect(after.errorCode).toBe("transfer_mismatch");
      expect(after.heldAt).toBeNull();
      expect(notify, what).toHaveBeenCalledTimes(1);
    }
    // A different payout note too.
    await prisma.creatorPayout.deleteMany({});
    const row = await mkPayout();
    await handleRouteEvent("transfer.processed", transferEvt("transfer.processed", row, { notes: { payout_id: uid() } }));
    expect((await reload(row.id)).status).toBe("needs_attention");
  });

  it("processed but NOT on hold is flagged needs_attention, never held, and staff are told", async () => {
    const row = await mkPayout();
    const r = await handleRouteEvent("transfer.processed", transferEvt("transfer.processed", row, { on_hold: false, settlement_status: "pending" }));
    expect(r).toEqual({ handled: true, note: "processed_not_held" });
    await flushPayoutAlertsForTests(); // the alerted_* stamp is written once the mailer reports the email went out
    const after = await reload(row.id);
    expect(after.status).toBe("needs_attention");
    expect(after.errorCode).toBe("processed_not_held");
    expect(after.lastError).toMatch(/NOT on hold/);
    expect(after.heldAt).toBeNull();
    expect(after.transferStatus).toBe("processed");
    expect(after.alertedStatus).toBe("needs_attention");
    expect(after.alertedAt).toBeInstanceOf(Date);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatch(/needs attention/i);
    expect(notify.mock.calls[0][2]).toBe(`/campaigns/${row.bookingId}`);
    expect((await eventsOf(row.id))[0]).toMatchObject({ fromStatus: "transfer_requested", toStatus: "needs_attention" });
  });

  it("a transfer with an automatic release date (on_hold_until) is not held either", async () => {
    const row = await mkPayout();
    await handleRouteEvent("transfer.processed", transferEvt("transfer.processed", row, { on_hold: true, on_hold_until: nowSec() + 86400 }));
    const after = await reload(row.id);
    expect(after.status).toBe("needs_attention");
    expect(after.errorCode).toBe("processed_hold_expires");
  });

  it("transfer.failed -> failed with Razorpay's error code and a SCRUBBED description", async () => {
    const row = await mkPayout();
    const r = await handleRouteEvent(
      "transfer.failed",
      transferEvt("transfer.failed", row, {
        on_hold: false,
        error: {
          code: "BAD_REQUEST_TRANSFER_INSUFFICIENT_BALANCE",
          description: "Transfer failed for beneficiary account 123456789012 (PAN ABCDE1234F, IFSC HDFC0001234)",
          reason: "insufficient_balance",
        },
      }),
      "evt_fail_1",
    );
    expect(r).toEqual({ handled: true, note: "failed" });
    await flushPayoutAlertsForTests();
    const after = await reload(row.id);
    expect(after.status).toBe("failed");
    expect(after.transferStatus).toBe("failed");
    expect(after.errorCode).toBe("insufficient_balance");
    expect(after.lastError).toContain("[redacted]");
    for (const leak of ["123456789012", "ABCDE1234F", "HDFC0001234"]) expect(after.lastError).not.toContain(leak);
    expect(after.alertedStatus).toBe("failed");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatch(/FAILED/);
    expect((await eventsOf(row.id))[0]).toMatchObject({ kind: "transfer", toStatus: "failed", razorpayEventId: "evt_fail_1" });
  });

  it("a failed transfer with no error object still gets a code and our own wording", async () => {
    const row = await mkPayout();
    await handleRouteEvent("transfer.failed", transferEvt("transfer.failed", row, { on_hold: undefined }));
    const after = await reload(row.id);
    expect(after.status).toBe("failed");
    expect(after.errorCode).toBe("transfer_failed");
    expect(after.lastError).toBe("Razorpay reported the transfer failed.");
  });

  it("the older `transfers.failed` spelling is accepted", async () => {
    const row = await mkPayout();
    const r = await handleRouteEvent("transfers.failed", transferEvt("transfer.failed", row));
    expect(r).toEqual({ handled: true, note: "failed" });
    expect((await reload(row.id)).status).toBe("failed");
  });

  it("a flood of failures emails staff once an hour; the rows keep their status and stay un-stamped for the digest", async () => {
    const a = await mkPayout({ razorpayTransferId: "trf_FLOOD00000001" });
    const b = await mkPayout({ razorpayTransferId: "trf_FLOOD00000002" });
    await handleRouteEvent("transfer.failed", transferEvt("transfer.failed", a, { id: "trf_FLOOD00000001" }));
    await handleRouteEvent("transfer.failed", transferEvt("transfer.failed", b, { id: "trf_FLOOD00000002" }));
    expect(notify).toHaveBeenCalledTimes(1);
    await flushPayoutAlertsForTests();
    const [ra, rb] = [await reload(a.id), await reload(b.id)];
    expect([ra.status, rb.status]).toEqual(["failed", "failed"]);
    expect(ra.alertedStatus).toBe("failed");
    expect(rb.alertedStatus).toBeNull(); // not emailed, so the reconciliation digest still owes it
  });

  // A reversal WE asked for, confirmed by an event, is the happy end of that path. It must not be
  // stored the way a "needs a human" outcome is (an error code and the "needs a look" text), and it
  // must fill the columns the executor's own confirm step would: that step is a conditional update
  // on reversal_requested, so once the event has won the race it would never backfill them.
  it("a clean reversal confirmed by an event lands in reversed with no error, no alert, and the reversal columns filled", async () => {
    for (const event of ["transfer.processed", "transfer.failed"] as const) {
      await prisma.creatorPayout.deleteMany({});
      resetPayoutAlertsForTests();
      notify.mockClear();
      const row = await mkPayout({ status: "reversal_requested", errorCode: "stale_code", lastError: "a stale message" });
      const at = nowSec() - 30;
      const evt = transferEvt(event, row, { amount_reversed: 50000 }, { created_at: at });
      const r = await handleRouteEvent(event, evt, "evt_rev_1");
      expect(r, event).toEqual({ handled: true, note: "reversed" });
      await flushPayoutAlertsForTests();
      const after = await reload(row.id);
      expect(after.status, event).toBe("reversed");
      expect(after.errorCode, event).toBeNull();
      expect(after.lastError, event).toBeNull();
      expect(after.reversedAt, event).toEqual(new Date(at * 1000));
      expect(after.amountReversedPaise, event).toBe(50000);
      expect(after.transferStatus, event).toBe("reversed");
      expect(after.alertedStatus, event).toBeNull();
      expect(notify, event).not.toHaveBeenCalled();
      const ev = await eventsOf(row.id);
      expect(ev, event).toHaveLength(1);
      expect(ev[0], event).toMatchObject({ kind: "transfer", fromStatus: "reversal_requested", toStatus: "reversed", actorType: "razorpay", razorpayEventId: "evt_rev_1" });

      // A replay changes nothing: no second audit row, the same reversal time.
      expect(await handleRouteEvent(event, evt, "evt_rev_1"), event).toEqual({ handled: true, note: "unchanged" });
      expect(await eventsOf(row.id), event).toHaveLength(1);
      expect((await reload(row.id)).reversedAt, event).toEqual(after.reversedAt);
    }
  });

  it("a full reversal we did not ask for still parks the payout for a human, with its own wording, and leaves the reversal columns alone", async () => {
    const row = await mkPayout({ status: "held" });
    const r = await handleRouteEvent("transfer.processed", transferEvt("transfer.processed", row, { amount_reversed: 50000 }));
    expect(r).toEqual({ handled: true, note: "reversed_outside_flow" });
    await flushPayoutAlertsForTests();
    const after = await reload(row.id);
    expect(after.status).toBe("needs_attention");
    expect(after.errorCode).toBe("reversed_outside_flow");
    expect(after.lastError).toMatch(/reversed outside our release flow/);
    expect(after.reversedAt).toBeNull();
    expect(after.amountReversedPaise).toBe(0);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("transfer events other than processed and failed are not handled", async () => {
    const row = await mkPayout();
    const r = await handleRouteEvent("transfer.reversed", transferEvt("transfer.processed", row));
    expect(r.handled).toBe(false);
    expect(r.note).toBe("unhandled transfer.reversed");
    expect((await reload(row.id)).status).toBe("transfer_requested");
  });
});

// ── Unreadable payloads and failures never throw ────────────────────────────────

describe("malformed payloads", () => {
  const GARBAGE: unknown[] = [undefined, null, 42, "text", [], {}, { payload: null }, { payload: {} }, { payload: { transfer: null } }, { payload: { transfer: { entity: "x" } } }, { payload: { transfer: { entity: {} } } }, { payload: { transfer: { entity: { id: "../../etc" } } } }];

  it("never throws for any family, and says unreadable (or not ours) every time", async () => {
    const events = ["transfer.processed", "transfer.failed", "settlement.processed", "product.route.activated", "product.route.needs_clarification", "payment.dispute.created", "payment.dispute.lost"];
    for (const e of events) {
      for (const g of GARBAGE) {
        const r = await handleRouteEvent(e, g as never);
        expect(r.handled, `${e} ${JSON.stringify(g)}`).toBe(false);
        expect(typeof r.note).toBe("string");
      }
    }
  });

  it("an unreadable payload alerts once per event name per hour, not once per delivery", async () => {
    for (let i = 0; i < 5; i++) {
      const r = await handleRouteEvent("transfer.processed", { payload: { transfer: { entity: { nope: true } } } });
      expect(r).toEqual({ handled: false, note: "unreadable" });
    }
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain("transfer.processed");
    // A different event name is a different problem: its own email.
    await handleRouteEvent("transfer.failed", { payload: { transfer: { entity: { nope: true } } } });
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("an event whose entity contradicts its name is unreadable, not acted on", async () => {
    const row = await mkPayout();
    const r = await handleRouteEvent("transfer.failed", transferEvt("transfer.failed", row, { status: "processed" }));
    expect(r).toEqual({ handled: false, note: "unreadable" });
    expect((await reload(row.id)).status).toBe("transfer_requested");
  });

  it("transfer.processed that does not say whether it is on hold cannot claim held", async () => {
    const row = await mkPayout();
    const r = await handleRouteEvent("transfer.processed", transferEvt("transfer.processed", row, { on_hold: undefined }));
    expect(r).toEqual({ handled: false, note: "unreadable" });
    expect((await reload(row.id)).status).toBe("transfer_requested");
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("a database failure is caught, logged scrubbed, alerted, and reported as not handled", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    // (A Prisma model delegate cannot be spied on and restored, so the failure is injected at
    // $transaction, which the status change goes through.)
    const tx = vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(new Error("connection lost near 123456789012 for ABCDE1234F") as never);
    try {
      const row = await mkPayout();
      const r = await handleRouteEvent("transfer.processed", transferEvt("transfer.processed", row));
      expect(r).toEqual({ handled: false, note: "error" });
      const logged = err.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toContain("[route-webhook] transfer.processed failed");
      expect(logged).not.toMatch(/123456789012|ABCDE1234F/);
      expect(notify).toHaveBeenCalledTimes(1);
      expect((await reload(row.id)).status).toBe("transfer_requested");
    } finally {
      tx.mockRestore();
      err.mockRestore();
    }
    // The client still works afterwards.
    const again = await mkPayout({ razorpayTransferId: "trf_AFTER0000001", bookingItemId: uid() });
    expect((await handleRouteEvent("transfer.processed", transferEvt("transfer.processed", again, { id: "trf_AFTER0000001" }))).handled).toBe(true);
  });

  it("markup in an event NAME never reaches an alert: safeName replaces the name before anything is built", async () => {
    await handleRouteEvent("transfer.<script>alert(1)</script>", { payload: {} });
    await handleRouteEvent("payment.dispute.<img src=x onerror=1>", { payload: {} });
    // The second one is a dispute event with no dispute in it, so it DOES alert: with the safe name.
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain("(unrecognised event)");
    for (const call of notify.mock.calls) {
      expect(JSON.stringify(call)).not.toMatch(/<script|<img/);
    }
  });

  it("provider text that DOES reach an alert (the transfer's error code) is HTML-escaped on its way to the mailer", async () => {
    const row = await mkPayout();
    await handleRouteEvent(
      "transfer.failed",
      transferEvt("transfer.failed", row, { error: { code: `<img src="x" onerror='1'> & more`, reason: "insufficient_balance", description: "d" } }),
    );
    expect(notify).toHaveBeenCalledTimes(1);
    expect(detailsOf(notify.mock.calls[0])["Razorpay code"]).toBe("&lt;img src=&quot;x&quot; onerror=&#39;1&#39;&gt; &amp; more");
    expect(JSON.stringify(notify.mock.calls[0])).not.toMatch(/<img/);
  });
});

// ── settlement.processed ────────────────────────────────────────────────────────

describe("settlement.processed", () => {
  it("settles a released payout that carries the settlement id: UTR, id and time, nothing else", async () => {
    const row = await mkPayout({ status: "released", recipientSettlementId: SETL, errorCode: "x", lastError: "an old failure" });
    const at = nowSec() - 60;
    const r = await handleRouteEvent("settlement.processed", settlementEvt({}, { created_at: at }), "evt_setl_1");
    expect(r).toEqual({ handled: true, note: "settled 1" });
    const after = await reload(row.id);
    expect(after.status).toBe("settled");
    expect(after.settlementUtr).toBe("AXISCN1153863727"); // stored intact: a UTR is a reference, not a secret
    expect(after.recipientSettlementId).toBe(SETL);
    expect(after.recipientSettlementStatus).toBe("processed");
    expect(after.settledAt).toEqual(new Date(at * 1000));
    // The batch's amount and fee are not this payout's, so they are never copied.
    expect(after.settlementAmountPaise).toBeNull();
    expect(after.settlementFeePaise).toBeNull();
    expect(after.errorCode).toBeNull();
    expect(after.lastError).toBeNull();
    expect(await eventsOf(row.id)).toHaveLength(1);
    expect((await eventsOf(row.id))[0]).toMatchObject({ kind: "settlement", fromStatus: "released", toStatus: "settled", razorpayEventId: "evt_setl_1" });
    expect(notify).not.toHaveBeenCalled();
  });

  it("a replay is a no-op", async () => {
    const row = await mkPayout({ status: "released", recipientSettlementId: SETL });
    await handleRouteEvent("settlement.processed", settlementEvt());
    const first = await reload(row.id);
    const r = await handleRouteEvent("settlement.processed", settlementEvt());
    expect(r.handled).toBe(true);
    expect(r.note).toBe("terminal");
    expect((await reload(row.id)).updatedAt).toEqual(first.updatedAt);
    expect(await eventsOf(row.id)).toHaveLength(1);
  });

  it("settles every payout that carries the same settlement id (a settlement can batch transfers)", async () => {
    const a = await mkPayout({ status: "released", recipientSettlementId: SETL, razorpayTransferId: "trf_BATCH0000001" });
    const b = await mkPayout({ status: "released", recipientSettlementId: SETL, razorpayTransferId: "trf_BATCH0000002" });
    const c = await mkPayout({ status: "released", recipientSettlementId: "setl_ANOTHER00001", razorpayTransferId: "trf_BATCH0000003" });
    const r = await handleRouteEvent("settlement.processed", settlementEvt());
    expect(r.note).toBe("settled 2");
    expect((await reload(a.id)).status).toBe("settled");
    expect((await reload(b.id)).status).toBe("settled");
    expect((await reload(c.id)).status).toBe("released");
  });

  it("a settlement carrying no payout's id is not ours: ignored with no alert (it is the merchant's own settlement)", async () => {
    const row = await mkPayout({ status: "released", recipientSettlementId: null });
    const r = await handleRouteEvent("settlement.processed", settlementEvt());
    expect(r).toEqual({ handled: false, note: "settlement not linked to a payout" });
    expect((await reload(row.id)).status).toBe("released");
    expect(notify).not.toHaveBeenCalled();
  });

  it("a payout that is not released yet is not settled by an early settlement event", async () => {
    for (const status of ["held", "release_requested", "reversal_requested"]) {
      await prisma.creatorPayout.deleteMany({});
      const row = await mkPayout({ status, recipientSettlementId: SETL });
      const r = await handleRouteEvent("settlement.processed", settlementEvt());
      expect(r.handled, status).toBe(true);
      expect((await reload(row.id)).status, status).toBe(status);
      expect((await reload(row.id)).settlementUtr, status).toBeNull();
    }
  });

  it("settlement_failed -> settled when the bank settlement later processes", async () => {
    const row = await mkPayout({ status: "settlement_failed", recipientSettlementId: SETL, recipientSettlementStatus: "failed" });
    await handleRouteEvent("settlement.processed", settlementEvt());
    const after = await reload(row.id);
    expect(after.status).toBe("settled");
    expect(after.recipientSettlementStatus).toBe("processed");
  });

  it("a linked settlement with no usable UTR is not marked paid: alert, nothing changed", async () => {
    const row = await mkPayout({ status: "released", recipientSettlementId: SETL });
    for (const utr of [undefined, "", "N/A", "has spaces in it", 12345678]) {
      const r = await handleRouteEvent("settlement.processed", settlementEvt({ utr }));
      expect(r, String(utr)).toEqual({ handled: false, note: "unreadable" });
    }
    expect((await reload(row.id)).status).toBe("released");
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("an entity that says the settlement is not processed changes nothing", async () => {
    const row = await mkPayout({ status: "released", recipientSettlementId: SETL });
    const r = await handleRouteEvent("settlement.processed", settlementEvt({ status: "failed" }));
    expect(r).toEqual({ handled: true, note: "settlement_not_processed" });
    expect((await reload(row.id)).status).toBe("released");
  });

  it("other settlement.* events are not handled", async () => {
    const r = await handleRouteEvent("settlement.created", settlementEvt());
    expect(r).toEqual({ handled: false, note: "unhandled settlement.created" });
  });
});

// ── product.route.* ─────────────────────────────────────────────────────────────

describe("product.route.* (linked account status)", () => {
  const mkAccount = (over: Record<string, unknown> = {}) =>
    prisma.creatorPayoutAccount.create({ data: { creatorId: uid(), razorpayAccountId: ACC, razorpayProductId: PRODUCT, activationStatus: "requested", ...over } });
  const accountOf = (id: string) => prisma.creatorPayoutAccount.findUniqueOrThrow({ where: { id } });

  it("under_review updates the account by its Razorpay account id", async () => {
    const acct = await mkAccount();
    const r = await handleRouteEvent("product.route.under_review", productEvt("product.route.under_review", "under_review"));
    expect(r).toEqual({ handled: true, note: "account under_review" });
    const after = await accountOf(acct.id);
    expect(after.activationStatus).toBe("under_review");
    expect(after.requirements).toEqual([]);
    expect(after.lastCheckedAt).toBeInstanceOf(Date);
  });

  it("needs_clarification keeps requirement REFERENCES and reason codes only", async () => {
    const acct = await mkAccount();
    const sample = {
      requirements: [
        {
          field_reference: "settlements.ifsc_code",
          resolution_url: `/accounts/${ACC}/products/${PRODUCT}`,
          reason_code: "needs_clarification",
          description: "Max retry exceeded for bank account details.",
          status: "required",
        },
        { field_reference: "settlements.beneficiary_name", resolution_url: "/x", reason_code: "needs_clarification", description: "Name does not match", status: "required" },
        { field_reference: "settlements.account_number", resolution_url: "/x", reason_code: "needs_clarification", description: "Account 123456789012 was rejected", status: "required" },
      ],
    };
    await handleRouteEvent("product.route.needs_clarification", productEvt("product.route.needs_clarification", "needs_clarification", sample));
    const after = await accountOf(acct.id);
    expect(after.activationStatus).toBe("needs_clarification");
    expect(after.requirements).toEqual([
      { field_reference: "settlements.ifsc_code", reason_code: "needs_clarification", status: "required" },
      { field_reference: "settlements.beneficiary_name", reason_code: "needs_clarification", status: "required" },
      { field_reference: "settlements.account_number", reason_code: "needs_clarification", status: "required" },
    ]);
    const stored = JSON.stringify(after.requirements);
    for (const dropped of ["Max retry", "description", "resolution_url", "123456789012", ACC, "Name does not match"]) expect(stored).not.toContain(dropped);
  });

  it("echoed secrets in a reference or reason code are masked in the stored JSON", async () => {
    const acct = await mkAccount();
    const hostile = {
      requirements: [
        { field_reference: "settlements.account_number 123456789012", reason_code: "ABCDE1234F", status: "HDFC0001234" },
        { field_reference: "ABCDE1234F", reason_code: "9876 5432 1098", status: "required" },
        { field_reference: 12345, reason_code: "x", status: "y" }, // not a string: dropped
        "not an object",
        null,
      ],
    };
    await handleRouteEvent("product.route.needs_clarification", productEvt("product.route.needs_clarification", "needs_clarification", hostile));
    const stored = JSON.stringify((await accountOf(acct.id)).requirements);
    expect(stored).toContain("[redacted]");
    expect(stored).not.toMatch(/[A-Za-z]{5}\d{4}[A-Za-z]/); // no PAN shape
    expect(stored).not.toMatch(/[A-Za-z]{4}0[A-Za-z0-9]{6}/); // no IFSC shape
    expect(stored).not.toMatch(/\d{5,}/); // no account-number-length digit run
  });

  it("caps the requirement list at 30 entries", async () => {
    const acct = await mkAccount();
    const many = { requirements: Array.from({ length: 80 }, (_, i) => ({ field_reference: `field_${i}`, reason_code: "needs_clarification", status: "required" })) };
    await handleRouteEvent("product.route.needs_clarification", productEvt("product.route.needs_clarification", "needs_clarification", many));
    expect(((await accountOf(acct.id)).requirements as unknown[]).length).toBe(30);
  });

  it("activated sets activated_at from the event and bookable_after 24h later; a replay changes nothing", async () => {
    const acct = await mkAccount({ activationStatus: "under_review" });
    const at = nowSec() - 3600;
    const r = await handleRouteEvent("product.route.activated", productEvt("product.route.activated", "activated", [], { at }));
    expect(r).toEqual({ handled: true, note: "account activated" });
    const first = await accountOf(acct.id);
    expect(first.activationStatus).toBe("activated");
    expect(first.activatedAt).toEqual(new Date(at * 1000));
    expect(first.bookableAfter).toEqual(new Date(at * 1000 + 24 * 3600 * 1000));
    const again = await handleRouteEvent("product.route.activated", productEvt("product.route.activated", "activated", [], { at }));
    expect(again).toEqual({ handled: true, note: "unchanged" });
    expect((await accountOf(acct.id)).updatedAt).toEqual(first.updatedAt);
  });

  it("a later re-activation keeps the original activated_at (the cooling period is not restarted)", async () => {
    const acct = await mkAccount({ activationStatus: "under_review" });
    const t1 = nowSec() - 7200;
    await handleRouteEvent("product.route.activated", productEvt("product.route.activated", "activated", [], { at: t1 }));
    await handleRouteEvent("product.route.needs_clarification", productEvt("product.route.needs_clarification", "needs_clarification", { requirements: [] }, { at: t1 + 600 }));
    await handleRouteEvent("product.route.activated", productEvt("product.route.activated", "activated", [], { at: t1 + 1200 }));
    const after = await accountOf(acct.id);
    expect(after.activationStatus).toBe("activated");
    expect(after.activatedAt).toEqual(new Date(t1 * 1000));
    expect(after.bookableAfter).toEqual(new Date(t1 * 1000 + 24 * 3600 * 1000));
  });

  it("an event older than the last poll cannot undo what the poll saw; a newer one applies", async () => {
    const polled = new Date(Date.now() - 60_000);
    const acct = await mkAccount({ activationStatus: "activated", activatedAt: polled, bookableAfter: new Date(polled.getTime() + 86400000), lastCheckedAt: polled });
    const stale = await handleRouteEvent("product.route.under_review", productEvt("product.route.under_review", "under_review", [], { at: nowSec() - 600 }));
    expect(stale).toEqual({ handled: true, note: "stale" });
    expect((await accountOf(acct.id)).activationStatus).toBe("activated");
    const fresh = await handleRouteEvent("product.route.under_review", productEvt("product.route.under_review", "under_review", [], { at: nowSec() - 5 }));
    expect(fresh.note).toBe("account under_review");
    expect((await accountOf(acct.id)).activationStatus).toBe("under_review");
  });

  it("a linked account we do not know, or a foreign product id, is ignored with no alert", async () => {
    const acct = await mkAccount();
    expect(await handleRouteEvent("product.route.activated", productEvt("product.route.activated", "activated", [], { accountId: "acc_NOTOURS000001" }))).toEqual({ handled: false, note: "unknown linked account" });
    expect(await handleRouteEvent("product.route.activated", productEvt("product.route.activated", "activated", [], { productId: "acc_prd_FOREIGN00001" }))).toEqual({ handled: false, note: "foreign product" });
    expect((await accountOf(acct.id)).activationStatus).toBe("requested");
    expect(notify).not.toHaveBeenCalled();
  });

  it("falls back to the event's account_id when the entity has no merchant_id", async () => {
    const acct = await mkAccount();
    const evt = productEvt("product.route.under_review", "under_review");
    delete (evt.payload.merchant_product.entity as Record<string, unknown>).merchant_id;
    expect((await handleRouteEvent("product.route.under_review", evt)).handled).toBe(true);
    expect((await accountOf(acct.id)).activationStatus).toBe("under_review");
  });

  it("a status that contradicts the event name, or a missing product, is unreadable", async () => {
    const acct = await mkAccount();
    expect(await handleRouteEvent("product.route.activated", productEvt("product.route.activated", "needs_clarification"))).toEqual({ handled: false, note: "unreadable" });
    expect(await handleRouteEvent("product.route.activated", { payload: { merchant_product: null } })).toEqual({ handled: false, note: "unreadable" });
    expect((await accountOf(acct.id)).activationStatus).toBe("requested");
  });

  it("product events we do not know are not handled", async () => {
    await mkAccount();
    expect((await handleRouteEvent("product.route.suspended", productEvt("product.route.suspended", "suspended"))).handled).toBe(false);
  });

  it("never touches any other column: no PAN, bank detail or status of the payouts", async () => {
    const acct = await mkAccount({ destinationHint: "HDFC ••••1234" });
    const row = await mkPayout({ status: "held" });
    await handleRouteEvent("product.route.needs_clarification", productEvt("product.route.needs_clarification", "needs_clarification", { requirements: [{ field_reference: "settlements.ifsc_code", reason_code: "needs_clarification", status: "required" }] }));
    const after = await accountOf(acct.id);
    expect(after.destinationHint).toBe("HDFC ••••1234");
    expect((await reload(row.id)).status).toBe("held");
  });
});

// ── payment.dispute.* ───────────────────────────────────────────────────────────

describe("payment.dispute.*", () => {
  it("opening a dispute pauses every in-flight payout of that payment and records the dispute", async () => {
    const held = await mkPayout({ status: "held", razorpayTransferId: "trf_D00000000001" });
    const planned = await mkPayout({ status: "planned", razorpayTransferId: null });
    const released = await mkPayout({ status: "released", razorpayTransferId: "trf_D00000000003" });
    const settled = await mkPayout({ status: "settled", razorpayTransferId: "trf_D00000000004" });
    const voided = await mkPayout({ status: "void", razorpayTransferId: null });
    const reversed = await mkPayout({ status: "reversed", razorpayTransferId: "trf_D00000000006" });
    const bankPaused = await mkPayout({ status: "held", razorpayTransferId: "trf_D00000000007", pausedAt: new Date(Date.now() - 1000), pausedReason: "bank_change" });
    const otherPayment = await mkPayout({ status: "held", razorpayTransferId: "trf_D00000000008", razorpayPaymentId: "pay_ANOTHERPAYMENT1" });

    const r = await handleRouteEvent("payment.dispute.created", disputeEvt("payment.dispute.created"), "evt_disp_1");
    expect(r).toEqual({ handled: true, note: "dispute recorded" });

    for (const p of [held, planned, released]) {
      const after = await reload(p.id);
      expect(after.pausedAt, p.status).toBeInstanceOf(Date);
      expect(after.pausedReason, p.status).toBe("dispute");
      expect(after.status).toBe(p.status); // a pause is an overlay: the status does not move
      const ev = await eventsOf(p.id);
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ kind: "pause", fromStatus: p.status, toStatus: p.status, razorpayEventId: "evt_disp_1", actorType: "razorpay" });
    }
    for (const p of [settled, voided, reversed, otherPayment]) {
      expect((await reload(p.id)).pausedAt, p.status).toBeNull();
      expect(await eventsOf(p.id)).toHaveLength(0);
    }
    // Already paused for another reason: that reason is kept (the release check also looks at disputes).
    const keep = await reload(bankPaused.id);
    expect(keep.pausedReason).toBe("bank_change");
    expect(await eventsOf(bankPaused.id)).toHaveLength(0);

    const d = await prisma.campaignDispute.findUniqueOrThrow({ where: { razorpayDisputeId: DISPUTE } });
    expect(d).toMatchObject({ razorpayPaymentId: PAY, amountPaise: 100000, currency: "INR", status: "open", phase: "chargeback", reasonCode: "chargeback", lastEvent: "payment.dispute.created" });
    expect(d.bookingId).toBeTruthy();
    expect(d.openedAt).toBeInstanceOf(Date);
    expect(d.respondBy).toBeInstanceOf(Date);
    expect(d.closedAt).toBeNull();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatch(/dispute opened/i);
  });

  it("replaying the same event is a no-op: no second pause, no rewrite, no second email", async () => {
    const held = await mkPayout({ status: "held" });
    const evt = disputeEvt("payment.dispute.created");
    await handleRouteEvent("payment.dispute.created", evt);
    const d1 = await prisma.campaignDispute.findUniqueOrThrow({ where: { razorpayDisputeId: DISPUTE } });
    const p1 = await reload(held.id);
    const r = await handleRouteEvent("payment.dispute.created", evt);
    expect(r).toEqual({ handled: true, note: "unchanged" });
    expect(await prisma.campaignDispute.count()).toBe(1);
    expect((await prisma.campaignDispute.findUniqueOrThrow({ where: { razorpayDisputeId: DISPUTE } })).updatedAt).toEqual(d1.updatedAt);
    expect((await reload(held.id)).pausedAt).toEqual(p1.pausedAt);
    expect(await eventsOf(held.id)).toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("two copies of a new dispute handled at once: one dispute row, one pause, one email, and neither reports an error", async () => {
    const held = await mkPayout({ status: "held" });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const evt = disputeEvt("payment.dispute.created");
      const results = await Promise.all([handleRouteEvent("payment.dispute.created", evt, "evt_a"), handleRouteEvent("payment.dispute.created", evt, "evt_b")]);
      expect(results.every((r) => r.handled)).toBe(true);
      expect(results.map((r) => r.note).sort()).toEqual(["dispute recorded", "unchanged"]);
      expect(err).not.toHaveBeenCalled();
    } finally {
      err.mockRestore();
    }
    expect(await prisma.campaignDispute.count()).toBe(1);
    expect(await eventsOf(held.id)).toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatch(/dispute opened/i);
  });

  // The test pool is ONE connection (tests/setup.ts), so two handler calls in one process queue
  // for it and the second only ever sees the first's committed row: that cannot show a race. This
  // one makes the overlap real with a SECOND client on its own connections: another copy has
  // inserted the dispute row and not committed, and the handler is observed blocked on it in
  // pg_stat_activity before that copy commits. A plain INSERT that lost this race would abort the
  // whole transaction (unique violation) and report an error.
  it("a copy that loses the race for the dispute row merges onto the winner's committed row instead of failing", async () => {
    const held = await mkPayout({ status: "held" });
    const second = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL!.replace(/connection_limit=\d+/, "connection_limit=3") } } });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let inserted!: () => void;
    const insertedRow = new Promise<void>((r) => (inserted = r));
    const winner = second.$transaction(
      async (tx) => {
        await tx.campaignDispute.create({ data: { razorpayDisputeId: DISPUTE, razorpayPaymentId: PAY, amountPaise: 100000, status: "open", lastEvent: "payment.dispute.created" } });
        inserted();
        await gate;
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await Promise.race([insertedRow, winner]); // (a winner that failed to insert rejects here instead of hanging)
      const loser = handleRouteEvent("payment.dispute.created", disputeEvt("payment.dispute.created"), "evt_lost_race");
      await waitUntil(
        async () =>
          (await second.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%campaign_disputes%'`)[0].n > 0,
        "the handler to block on the other copy's uncommitted dispute row",
      );
      release();
      await winner;
      expect(await loser).toEqual({ handled: true, note: "dispute updated" });
      expect(err).not.toHaveBeenCalled();
    } finally {
      release();
      await winner.catch(() => {});
      err.mockRestore();
      await second.$disconnect();
    }
    expect(await prisma.campaignDispute.count()).toBe(1);
    const d = await prisma.campaignDispute.findUniqueOrThrow({ where: { razorpayDisputeId: DISPUTE } });
    expect(d).toMatchObject({ status: "open", phase: "chargeback", reasonCode: "chargeback" }); // the winner's row, completed by the loser
    const p = await reload(held.id);
    expect(p.pausedReason).toBe("dispute");
    const ev = await eventsOf(held.id);
    expect(ev).toHaveLength(1);
    expect(ev[0].razorpayEventId).toBe("evt_lost_race");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).not.toMatch(/failed|could not/i);
  });

  // Two events for an EXISTING dispute at once. The handler reads the row, merges the event onto it
  // and writes it back, so without a lock on the row it can merge onto a state that is about to
  // change and then overwrite the newer one (a lost update). Here another transaction LOCKS the row
  // and only moves it to a verdict ("won") after the handler is seen waiting, while a generic
  // "closed" event is in flight: the handler must wait, re-read, and keep the verdict (a generic
  // "closed" never replaces one). (The holder must not change the row before the handler arrives:
  // ON CONFLICT DO NOTHING already waits for a concurrent UPDATE, which would hide a missing lock.)
  it("an event for an existing dispute waits for a concurrent change to the row and merges onto it (no lost update)", async () => {
    await mkPayout({ status: "held" });
    await handleRouteEvent("payment.dispute.created", disputeEvt("payment.dispute.created", {}, nowSec() - 300));
    const second = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL!.replace(/connection_limit=\d+/, "connection_limit=3") } } });
    const verdictAt = new Date((nowSec() - 120) * 1000);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const rowLocked = new Promise<void>((r) => (locked = r));
    const holder = second.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM campaign_disputes WHERE razorpay_dispute_id = ${DISPUTE} FOR UPDATE`;
        locked();
        await gate;
        await tx.campaignDispute.update({ where: { razorpayDisputeId: DISPUTE }, data: { status: "won", closedAt: verdictAt, lastEvent: "payment.dispute.won" } });
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
    try {
      await Promise.race([rowLocked, holder]);
      const closing = handleRouteEvent("payment.dispute.closed", disputeEvt("payment.dispute.closed", { status: "closed" }, nowSec() - 20));
      await waitUntil(
        async () =>
          (await second.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%campaign_disputes%'`)[0].n > 0,
        "the handler to block on the row the other transaction holds",
      );
      release();
      await holder;
      expect((await closing).handled).toBe(true);
    } finally {
      release();
      await holder.catch(() => {});
      await second.$disconnect();
    }
    const d = await prisma.campaignDispute.findUniqueOrThrow({ where: { razorpayDisputeId: DISPUTE } });
    expect(d.status).toBe("won"); // the verdict survived the generic "closed"
    expect(d.closedAt).toEqual(verdictAt);
    expect(d.lastEvent).toBe("payment.dispute.closed");
  });

  it("two DIFFERENT disputes opened within the hour each get their own email: the alert key is the dispute, not the event name", async () => {
    await mkPayout({ status: "held" });
    await handleRouteEvent("payment.dispute.created", disputeEvt("payment.dispute.created"));
    await handleRouteEvent("payment.dispute.created", disputeEvt("payment.dispute.created", { id: "disp_TESTDISPUTE002" }));
    expect(notify.mock.calls.map((c) => detailsOf(c).Dispute)).toEqual([DISPUTE, "disp_TESTDISPUTE002"]);
    // The same dispute and status again stays quiet for the hour.
    await handleRouteEvent("payment.dispute.created", disputeEvt("payment.dispute.created", { id: "disp_TESTDISPUTE002" }));
    expect(notify).toHaveBeenCalledTimes(2);
    expect(await prisma.campaignDispute.count()).toBe(2);
  });

  it("the alert does not overstate a pause: payouts already released or releasing are named as still able to settle", async () => {
    await mkPayout({ status: "held" });
    await mkPayout({ status: "release_requested", razorpayTransferId: "trf_REL000000001" });
    await mkPayout({ status: "released", razorpayTransferId: "trf_REL000000002" });
    await handleRouteEvent("payment.dispute.created", disputeEvt("payment.dispute.created"));
    const open = detailsOf(notify.mock.calls[0]);
    expect(open["Newly paused by this event"]).toBe("3");
    expect(open["Already released or releasing"]).toMatch(/^2 of them\./);
    expect(open["Already released or releasing"]).toMatch(/can still settle to the creator&#39;s bank/); // (values reach the mailer HTML-escaped)
    expect(open["What happens"]).toMatch(/still in flight/);
    expect(open["What happens"]).not.toMatch(/Payouts on this payment are paused/);

    // A closed dispute pauses nothing, and says so instead of promising payouts "stay paused".
    notify.mockClear();
    await handleRouteEvent("payment.dispute.lost", disputeEvt("payment.dispute.lost", { status: "lost" }, nowSec() - 5));
    const lost = detailsOf(notify.mock.calls[0]);
    expect(lost["Newly paused by this event"]).toBe("0");
    expect(lost).not.toHaveProperty("Already released or releasing");
    expect(lost["What happens"]).toMatch(/debited from our balance/);
    expect(lost["What happens"]).toMatch(/paused nothing/);
    expect(lost["What happens"]).not.toMatch(/stay paused until/);
  });

  it("a lost dispute is recorded as closed and the payouts STAY paused (un-pausing is never automatic)", async () => {
    const held = await mkPayout({ status: "held" });
    await handleRouteEvent("payment.dispute.created", disputeEvt("payment.dispute.created", {}, nowSec() - 120));
    const at = nowSec() - 60;
    const r = await handleRouteEvent("payment.dispute.lost", disputeEvt("payment.dispute.lost", { status: "lost" }, at));
    expect(r).toEqual({ handled: true, note: "dispute updated" });
    const d = await prisma.campaignDispute.findUniqueOrThrow({ where: { razorpayDisputeId: DISPUTE } });
    expect(d.status).toBe("lost");
    expect(d.closedAt).toEqual(new Date(at * 1000));
    expect(d.lastEvent).toBe("payment.dispute.lost");
    const p = await reload(held.id);
    expect(p.pausedAt).toBeInstanceOf(Date);
    expect(p.pausedReason).toBe("dispute");
    expect(notify.mock.calls.some((c) => /lost/i.test(String(c[0])))).toBe(true);
  });

  it("a late event cannot reopen a closed dispute, but a strictly newer one (an escalation) does and re-pauses", async () => {
    const held = await mkPayout({ status: "held" });
    const closedAt = nowSec() - 300;
    await handleRouteEvent("payment.dispute.won", disputeEvt("payment.dispute.won", { status: "won" }, closedAt));
    expect((await prisma.campaignDispute.findUniqueOrThrow({ where: { razorpayDisputeId: DISPUTE } })).status).toBe("won");
    // A won dispute does not pause (nothing is open), so the payout is free.
    expect((await reload(held.id)).pausedAt).toBeNull();

    const late = await handleRouteEvent("payment.dispute.under_review", disputeEvt("payment.dispute.under_review", { status: "under_review" }, closedAt - 100));
    expect(late.handled).toBe(true);
    expect((await prisma.campaignDispute.findUniqueOrThrow({ where: { razorpayDisputeId: DISPUTE } })).status).toBe("won");
    expect((await reload(held.id)).pausedAt).toBeNull();

    await handleRouteEvent("payment.dispute.created", disputeEvt("payment.dispute.created", { status: "open", phase: "pre_arbitration" }, closedAt + 120));
    const d = await prisma.campaignDispute.findUniqueOrThrow({ where: { razorpayDisputeId: DISPUTE } });
    expect(d.status).toBe("open");
    expect(d.phase).toBe("pre_arbitration");
    expect(d.closedAt).toBeNull();
    expect((await reload(held.id)).pausedReason).toBe("dispute");
  });

  it("a generic 'closed' does not overwrite a recorded verdict, and a verdict replaces a generic 'closed'", async () => {
    await mkPayout({ status: "held" });
    await handleRouteEvent("payment.dispute.lost", disputeEvt("payment.dispute.lost", { status: "lost" }, nowSec() - 200));
    await handleRouteEvent("payment.dispute.closed", disputeEvt("payment.dispute.closed", { status: "closed" }, nowSec() - 100));
    expect((await prisma.campaignDispute.findUniqueOrThrow({ where: { razorpayDisputeId: DISPUTE } })).status).toBe("lost");
  });

  it("reads the status from the entity when the event name is one nobody documented", async () => {
    const held = await mkPayout({ status: "held" });
    await handleRouteEvent("payment.dispute.some_new_state", disputeEvt("payment.dispute.some_new_state", { status: "action_required" }));
    expect((await prisma.campaignDispute.findUniqueOrThrow({ where: { razorpayDisputeId: DISPUTE } })).status).toBe("action_required");
    expect((await reload(held.id)).pausedReason).toBe("dispute");
  });

  it("an unrecognised status is treated as OPEN: the safe side is to pause", async () => {
    const held = await mkPayout({ status: "held" });
    await handleRouteEvent("payment.dispute.surprise", disputeEvt("payment.dispute.surprise", { status: "something_new" }));
    expect((await reload(held.id)).pausedReason).toBe("dispute");
  });

  it("with no status at all it follows the event name (created is open, won is closed)", async () => {
    const held = await mkPayout({ status: "held" });
    await handleRouteEvent("payment.dispute.created", disputeEvt("payment.dispute.created", { status: undefined }));
    expect((await prisma.campaignDispute.findUniqueOrThrow({ where: { razorpayDisputeId: DISPUTE } })).status).toBe("open");
    expect((await reload(held.id)).pausedAt).toBeInstanceOf(Date);
  });

  it("a dispute on a payment we never took for a booking is ignored", async () => {
    const r = await handleRouteEvent("payment.dispute.created", disputeEvt("payment.dispute.created", { payment_id: "pay_UNRELATEDPAY001" }));
    expect(r).toEqual({ handled: false, note: "dispute on a payment we do not know" });
    expect(await prisma.campaignDispute.count()).toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it("links the booking through the payment row when no payout exists yet", async () => {
    const client = await prisma.client.create({ data: { companyName: "Brand", contactName: "B", email: "b@brand.test", passwordHash: "x" } });
    const booking = await prisma.campaignBooking.create({ data: { clientId: client.id, name: "Camp", brand: "Brand" } });
    await prisma.campaignPayment.create({ data: { bookingId: booking.id, razorpayOrderId: "order_TEST000000001", razorpayPaymentId: PAY, amountPaise: 100000, status: "captured" } });
    const r = await handleRouteEvent("payment.dispute.created", disputeEvt("payment.dispute.created"));
    expect(r.handled).toBe(true);
    const d = await prisma.campaignDispute.findUniqueOrThrow({ where: { razorpayDisputeId: DISPUTE } });
    expect(d.bookingId).toBe(booking.id);
    expect(notify.mock.calls[0][2]).toBe(`/campaigns/${booking.id}`);
  });

  it("falls back to the payment entity for the payment id", async () => {
    const held = await mkPayout({ status: "held" });
    const evt = disputeEvt("payment.dispute.created");
    delete (evt.payload.dispute.entity as Record<string, unknown>).payment_id;
    expect((await handleRouteEvent("payment.dispute.created", evt)).handled).toBe(true);
    expect((await reload(held.id)).pausedReason).toBe("dispute");
  });

  it("an echoed secret in the reason code is masked; the free-text reason is never stored", async () => {
    await mkPayout({ status: "held" });
    await handleRouteEvent(
      "payment.dispute.created",
      disputeEvt("payment.dispute.created", { reason_code: "ABCDE1234F", reason_description: "Customer card 4111111111111111 was charged twice", phase: "chargeback 123456789" }),
    );
    const d = await prisma.campaignDispute.findUniqueOrThrow({ where: { razorpayDisputeId: DISPUTE } });
    expect(d.reasonCode).toBe("[redacted]");
    expect(d.phase).toBe("chargeback [redacted]");
    // The text columns carry no digit run or PAN shape (the amount is a number column, not text).
    expect([d.reasonCode, d.phase, d.status, d.currency, d.lastEvent].join(" ")).not.toMatch(/4111111111111111|ABCDE1234F|\d{5,}/);
  });

  it("a missing amount still pauses and records the dispute, and keeps a known amount on later events", async () => {
    const held = await mkPayout({ status: "held" });
    await handleRouteEvent("payment.dispute.created", disputeEvt("payment.dispute.created", { amount: undefined }));
    expect((await reload(held.id)).pausedReason).toBe("dispute");
    expect((await prisma.campaignDispute.findUniqueOrThrow({ where: { razorpayDisputeId: DISPUTE } })).amountPaise).toBe(0);
    await handleRouteEvent("payment.dispute.under_review", disputeEvt("payment.dispute.under_review", { status: "under_review", amount: 90000 }));
    expect((await prisma.campaignDispute.findUniqueOrThrow({ where: { razorpayDisputeId: DISPUTE } })).amountPaise).toBe(90000);
    await handleRouteEvent("payment.dispute.action_required", disputeEvt("payment.dispute.action_required", { status: "action_required", amount: undefined }));
    expect((await prisma.campaignDispute.findUniqueOrThrow({ where: { razorpayDisputeId: DISPUTE } })).amountPaise).toBe(90000);
  });

  it("a dispute with no usable id is unreadable and alerts", async () => {
    await mkPayout({ status: "held" });
    expect(await handleRouteEvent("payment.dispute.created", disputeEvt("payment.dispute.created", { id: undefined }))).toEqual({ handled: false, note: "unreadable" });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(await prisma.campaignDispute.count()).toBe(0);
  });
});

// ── Dispute events are durable, ordered and retried on infrastructure errors ───

type AnyTx = Record<string, any>;
const realTransaction = () => prisma.$transaction.bind(prisma) as unknown as (fn: (tx: AnyTx) => Promise<unknown>, opts?: unknown) => Promise<unknown>;

/** Runs every transaction through `wrap(tx)`: a Proxy that can trace or break the writes made inside it. */
function wrapTransactions(wrap: (tx: AnyTx) => AnyTx) {
  const real = realTransaction();
  return vi.spyOn(prisma, "$transaction").mockImplementation(((fn: (tx: AnyTx) => Promise<unknown>, opts?: unknown) => real((tx) => fn(wrap(tx)), opts)) as never);
}
const bindAll = (t: AnyTx, k: string | symbol) => (typeof t[k as string] === "function" ? t[k as string].bind(t) : t[k as string]);

describe("dispute events are durable, ordered and retried on infrastructure errors", () => {
  const infra = (code: string) => new Prisma.PrismaClientKnownRequestError("Transaction failed due to a write conflict or a deadlock. Please retry your transaction", { code, clientVersion: "test" });

  it("one transaction: the dispute row is written first, then the pauses", async () => {
    await mkPayout({ status: "held" });
    await mkPayout({ status: "planned", razorpayTransferId: null });
    const calls: string[] = [];
    const rawSql: string[] = [];
    const spy = wrapTransactions(
      (tx) =>
        new Proxy(tx, {
          get: (t, k) => {
            if (k === "campaignDispute" || k === "creatorPayout" || k === "creatorPayoutEvent") {
              return new Proxy(t[k as string], {
                get: (m, op) => (typeof m[op as string] === "function" ? (...a: unknown[]) => (calls.push(`${String(k)}.${String(op)}`), m[op as string](...a)) : m[op as string]),
              });
            }
            if (k === "$queryRaw") return (...a: unknown[]) => (calls.push("$queryRaw"), rawSql.push(Array.from(a[0] as ArrayLike<string>).join("?")), t.$queryRaw(...a));
            return bindAll(t, k);
          },
        }),
    );
    try {
      expect(await handleRouteEvent("payment.dispute.created", disputeEvt("payment.dispute.created"))).toEqual({ handled: true, note: "dispute recorded" });
      expect(spy).toHaveBeenCalledTimes(1); // the whole event is ONE transaction
    } finally {
      spy.mockRestore();
    }
    // dispute row, (row lock on the dispute is not needed for a new one), lock the payouts, pause them, write the audit rows
    expect(calls).toEqual(["campaignDispute.createMany", "$queryRaw", "creatorPayout.updateMany", "creatorPayoutEvent.createMany"]);
    // The payouts are locked in id order: the same statement the external-refund reconcile runs (payout-pause.ts).
    expect(rawSql).toHaveLength(1);
    expect(rawSql[0]).toMatch(/FROM creator_payouts[\s\S]*ORDER BY id\s+FOR UPDATE/);
  });

  it("a failure in the pause step records NOTHING (no dispute row, no pause on ANY of three payouts, no audit rows); the event is flagged for redelivery and the redelivery applies all of it", async () => {
    const held = await mkPayout({ status: "held" });
    const planned = await mkPayout({ status: "planned", razorpayTransferId: null });
    const released = await mkPayout({ status: "released", razorpayTransferId: "trf_DUR000000003" });
    const all = [held, planned, released];
    // ONE payload for every delivery: Razorpay redelivers the same bytes, and disputeEvt stamps respond_by
    // from the clock, so building it again would differ whenever a second boundary falls in between.
    const evt = disputeEvt("payment.dispute.created");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    // The audit insert is the LAST write of the pause: by then the dispute row and the payout update are already inside the transaction.
    const spy = wrapTransactions((tx) => new Proxy(tx, { get: (t, k) => (k === "creatorPayoutEvent" ? { createMany: async () => { throw infra("P2034"); } } : bindAll(t, k)) }));
    let first;
    try {
      first = await handleRouteEvent("payment.dispute.created", evt, "evt_dur");
    } finally {
      spy.mockRestore();
      err.mockRestore();
    }
    expect(first).toEqual({ handled: false, note: "temporary", retry: true });
    expect(await prisma.campaignDispute.count()).toBe(0);
    for (const p of all) {
      const rolledBack = await reload(p.id);
      expect(rolledBack.pausedAt, p.status).toBeNull();
      expect(rolledBack.pausedReason, p.status).toBeNull();
      expect(await eventsOf(p.id), p.status).toHaveLength(0);
    }
    // Staff are told the truth: not recorded, will be redelivered, and no reconciliation job exists for disputes.
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toBe("Razorpay Route event failed: payment.dispute.created");
    const text = JSON.stringify(notify.mock.calls[0]);
    expect(text).toMatch(/NOT recorded/);
    expect(text).toMatch(/deliver it again/);
    expect(text).toMatch(/Razorpay dashboard/);
    expect(text).not.toMatch(/reconciliation|Nothing was changed/);

    // The redelivery applies the whole event, and a further copy changes nothing.
    expect(await handleRouteEvent("payment.dispute.created", evt, "evt_dur")).toEqual({ handled: true, note: "dispute recorded" });
    expect(await prisma.campaignDispute.count()).toBe(1);
    for (const p of all) {
      expect((await reload(p.id)).pausedReason, p.status).toBe("dispute");
      expect(await eventsOf(p.id), p.status).toHaveLength(1);
    }
    expect(await handleRouteEvent("payment.dispute.created", evt, "evt_dur")).toEqual({ handled: true, note: "unchanged" });
    for (const p of all) expect(await eventsOf(p.id), p.status).toHaveLength(1);
  });

  // Which errors mean "the database had a bad moment, the same event will work a moment later".
  const known = (code: string, meta?: Record<string, unknown>) => new Prisma.PrismaClientKnownRequestError("boom near 123456789012", { code, clientVersion: "test", meta });
  const RETRY: Array<[string, Error]> = [
    ["P2024 pool timeout", known("P2024")],
    ["P2028 transaction API error", known("P2028")],
    ["P2034 write conflict / deadlock", known("P2034")],
    ["P1001 cannot reach the database", known("P1001")],
    ["P1017 server closed the connection", known("P1017")],
    ["an initialisation error", new Prisma.PrismaClientInitializationError("Can't reach database server", "test", "P1001")],
    ["a raw query killed by a deadlock (meta.code 40P01)", known("P2010", { code: "40P01", message: "deadlock detected" })],
    ["a raw query killed by a lock timeout (meta.code 55P03)", known("P2010", { code: "55P03" })],
    ["a raw query cancelled by the statement timeout (meta.code 57014)", known("P2010", { code: "57014" })],
    ["a bare Postgres lock-timeout code on the error", Object.assign(new Error("lock timeout"), { code: "55P03" })],
    ["a deadlock code on the cause", Object.assign(new Error("wrapped"), { cause: Object.assign(new Error("deadlock detected"), { code: "40P01" }) })],
  ];
  const NO_RETRY: Array<[string, Error]> = [
    ["P2002 unique violation", known("P2002")],
    ["P2003 foreign key", known("P2003")],
    ["P2025 record not found", known("P2025")],
    ["a plain error", new Error("connection lost near 123456789012")],
    ["a TypeError (a bug)", new TypeError("x is not a function")],
    ["a Postgres unique-violation code", Object.assign(new Error("duplicate key"), { code: "23505" })],
  ];

  it("a dispute event lost to an infrastructure error returns retry:true, scrubbed and alerted; any other failure stays always-handled", async () => {
    await mkPayout({ status: "held" });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const [what, e] of [...RETRY, ...NO_RETRY]) {
        const retry = RETRY.some(([w]) => w === what);
        resetPayoutAlertsForTests();
        notify.mockClear();
        err.mockClear();
        const tx = vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(e as never);
        try {
          const r = await handleRouteEvent("payment.dispute.created", disputeEvt("payment.dispute.created"));
          expect(r, what).toEqual(retry ? { handled: false, note: "temporary", retry: true } : { handled: false, note: "error" });
        } finally {
          tx.mockRestore();
        }
        expect(notify, what).toHaveBeenCalledTimes(1); // still alerted, once
        const logged = err.mock.calls.map((c) => c.join(" ")).join("\n");
        expect(logged, what).toContain("[route-webhook] payment.dispute.created failed");
        expect(logged, what).not.toContain("123456789012");
        expect(await prisma.campaignDispute.count(), what).toBe(0);
      }
    } finally {
      err.mockRestore();
    }
  });

  it("the alert for a repeated dispute failure is sent once an hour, even though every delivery is retried", async () => {
    await mkPayout({ status: "held" });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const tx = vi.spyOn(prisma, "$transaction").mockRejectedValue(infra("P2024") as never);
    try {
      for (let i = 0; i < 4; i++) expect((await handleRouteEvent("payment.dispute.created", disputeEvt("payment.dispute.created"))).retry).toBe(true);
      expect(notify).toHaveBeenCalledTimes(1);
    } finally {
      tx.mockRestore();
      err.mockRestore();
    }
  });

  it("only DISPUTE events retry: the same infrastructure error on a transfer or a settlement event stays a plain not-handled", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const transfer = await mkPayout();
      const tx1 = vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(infra("P2024") as never);
      try {
        expect(await handleRouteEvent("transfer.processed", transferEvt("transfer.processed", transfer))).toEqual({ handled: false, note: "error" });
      } finally {
        tx1.mockRestore();
      }
      await mkPayout({ status: "released", recipientSettlementId: SETL, razorpayTransferId: "trf_ONLYDISP00001" });
      const tx2 = vi.spyOn(prisma, "$transaction").mockRejectedValueOnce(infra("P2034") as never);
      try {
        expect(await handleRouteEvent("settlement.processed", settlementEvt())).toEqual({ handled: false, note: "error" });
      } finally {
        tx2.mockRestore();
      }
      // The alert for those still says the reconciliation job reads the real state: for them it is on the plan.
      expect(JSON.stringify(notify.mock.calls[0])).toMatch(/may not have been applied/);
    } finally {
      err.mockRestore();
    }
  });
});

// ── Staff alerts count as sent only when the mailer says the email went out ─────

describe("staff alerts count as sent only when the mail actually went out", () => {
  // sendEmail swallows both "SMTP not configured" and "the send failed" and resolves null.
  const smtpDown = () => notify.mockResolvedValueOnce(null as never);

  it("a send that fails leaves the payout un-stamped, and the NEXT occurrence tries again", async () => {
    const a = await mkPayout({ razorpayTransferId: "trf_NOSEND0000001" });
    const b = await mkPayout({ razorpayTransferId: "trf_NOSEND0000002" });
    const c = await mkPayout({ razorpayTransferId: "trf_NOSEND0000003" });
    smtpDown();
    await handleRouteEvent("transfer.failed", transferEvt("transfer.failed", a, { id: "trf_NOSEND0000001" }));
    await flushPayoutAlertsForTests();
    expect(notify).toHaveBeenCalledTimes(1);
    const first = await reload(a.id);
    expect(first.status).toBe("failed");
    expect(first.alertedStatus).toBeNull();
    expect(first.alertedAt).toBeNull();

    // The key is not quiet after a failed send: the next failure emails (and this time it goes out).
    await handleRouteEvent("transfer.failed", transferEvt("transfer.failed", b, { id: "trf_NOSEND0000002" }));
    await flushPayoutAlertsForTests();
    expect(notify).toHaveBeenCalledTimes(2);
    expect((await reload(b.id)).alertedStatus).toBe("failed");
    expect((await reload(a.id)).alertedStatus).toBeNull(); // still owed to the reconciliation digest

    // Once an email did go out, the hour is quiet again for that key.
    await handleRouteEvent("transfer.failed", transferEvt("transfer.failed", c, { id: "trf_NOSEND0000003" }));
    await flushPayoutAlertsForTests();
    expect(notify).toHaveBeenCalledTimes(2);
    expect((await reload(c.id)).alertedStatus).toBeNull();
  });

  it("a mailer that throws is handled the same way, logged, and never escapes the handler", async () => {
    const row = await mkPayout();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    notify.mockRejectedValueOnce(new Error("535 5.7.8 Username and Password not accepted"));
    try {
      expect(await handleRouteEvent("transfer.failed", transferEvt("transfer.failed", row))).toEqual({ handled: true, note: "failed" });
      await flushPayoutAlertsForTests();
      expect(err.mock.calls.map((c) => c.join(" ")).join("\n")).toContain("[payout-alert] email failed");
    } finally {
      err.mockRestore();
    }
    expect((await reload(row.id)).alertedStatus).toBeNull();
    // ...and the key is free again.
    const next = await mkPayout({ razorpayTransferId: "trf_THROW00000002" });
    await handleRouteEvent("transfer.failed", transferEvt("transfer.failed", next, { id: "trf_THROW00000002" }));
    await flushPayoutAlertsForTests();
    expect((await reload(next.id)).alertedStatus).toBe("failed");
  });

  it("the stamp waits for the mailer: not stamped while the email is still in flight, stamped once it succeeds", async () => {
    let finish!: (v: unknown) => void;
    notify.mockImplementationOnce((() => new Promise((res) => (finish = res))) as never);
    const row = await mkPayout();
    await handleRouteEvent("transfer.failed", transferEvt("transfer.failed", row));
    expect((await reload(row.id)).alertedStatus).toBeNull();
    finish(SENT);
    await flushPayoutAlertsForTests();
    expect((await reload(row.id)).alertedStatus).toBe("failed");
  });

  it("duplicates that arrive while a send is in flight are held back, and folded into the retry if that send fails", async () => {
    let finish!: (v: unknown) => void;
    notify.mockImplementationOnce((() => new Promise((res) => (finish = res))) as never);
    const got = [1, 2, 3].map(() => alertStaffOncePerHour("inflight", "Subject", [{ label: "a", value: "b" }]));
    expect(got).toEqual([true, false, false]);
    expect(notify).toHaveBeenCalledTimes(1);
    finish(null); // the send failed
    await flushPayoutAlertsForTests();
    expect(alertStaffOncePerHour("inflight", "Subject", [{ label: "a", value: "b" }])).toBe(true); // not quiet any more
    await flushPayoutAlertsForTests();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(detailsOf(notify.mock.calls[1])["Held back"]).toBe("2 similar alert(s) since the last email for this event");
  });

  it("onSent runs once for a delivered alert, never for a held-back or a failed one", async () => {
    const onSent = vi.fn();
    expect(alertStaffOncePerHour("cb", "s", [], undefined, { onSent })).toBe(true);
    expect(alertStaffOncePerHour("cb", "s", [], undefined, { onSent })).toBe(false); // quiet hour
    await flushPayoutAlertsForTests();
    expect(onSent).toHaveBeenCalledTimes(1);
    smtpDown();
    expect(alertStaffOncePerHour("cb2", "s", [], undefined, { onSent })).toBe(true);
    await flushPayoutAlertsForTests();
    expect(onSent).toHaveBeenCalledTimes(1);
    // A callback that throws is logged and swallowed.
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      alertStaffOncePerHour("cb3", "s", [], undefined, { onSent: () => { throw new Error("db down"); } });
      await flushPayoutAlertsForTests();
      expect(err.mock.calls.map((c) => c.join(" ")).join("\n")).toContain("could not record the alert");
    } finally {
      err.mockRestore();
    }
  });

  it("alerts that were held back before a failed send are carried over to the retry", async () => {
    const HOUR = 60 * 60 * 1000;
    const t0 = Date.now();
    expect(alertStaffOncePerHour("carry", "s", [], undefined, { now: t0 })).toBe(true);
    await flushPayoutAlertsForTests();
    for (let i = 0; i < 3; i++) expect(alertStaffOncePerHour("carry", "s", [], undefined, { now: t0 + 1000 })).toBe(false); // quiet hour: 3 held back
    smtpDown();
    expect(alertStaffOncePerHour("carry", "s", [], undefined, { now: t0 + 2 * HOUR })).toBe(true); // this send consumes the 3 ... and fails
    await flushPayoutAlertsForTests();
    expect(alertStaffOncePerHour("carry", "s", [], undefined, { now: t0 + 2 * HOUR + 1000 })).toBe(true); // the retry is not quiet
    await flushPayoutAlertsForTests();
    expect(notify).toHaveBeenCalledTimes(3);
    expect(detailsOf(notify.mock.calls[1])["Held back"]).toBe("3 similar alert(s) since the last email for this event");
    expect(detailsOf(notify.mock.calls[2])["Held back"]).toBe("3 similar alert(s) since the last email for this event"); // not lost by the failure
  });

  it("failed attempts still count against the hourly ceiling, so a dead mail server is not hammered", async () => {
    notify.mockResolvedValue(null as never);
    const results: boolean[] = [];
    for (let i = 0; i < 15; i++) {
      results.push(alertStaffOncePerHour(`flood:${i}`, "s", []));
      await flushPayoutAlertsForTests(); // (one at a time: a failure must not give its slot back)
    }
    expect(results.filter(Boolean)).toHaveLength(12);
    expect(notify).toHaveBeenCalledTimes(12);
  });
});

// ── Cross-cutting ───────────────────────────────────────────────────────────────

describe("every state change leaves exactly one audit row", () => {
  it("through a full happy path: held, then (released by someone else) settled", async () => {
    const row = await mkPayout();
    await handleRouteEvent("transfer.processed", transferEvt("transfer.processed", row), "e1");
    // The release flow (Phase 4) is not under test; put the row where it would be.
    await prisma.creatorPayout.update({ where: { id: row.id }, data: { status: "released", recipientSettlementId: SETL } });
    await handleRouteEvent("settlement.processed", settlementEvt(), "e2");
    const ev = await eventsOf(row.id);
    expect(ev.map((e) => `${e.kind}:${e.fromStatus}>${e.toStatus}`)).toEqual(["transfer:transfer_requested>held", "settlement:released>settled"]);
    expect(ev.map((e) => e.razorpayEventId)).toEqual(["e1", "e2"]);
    expect((await reload(row.id)).status).toBe("settled");
  });

  it("never writes paidAt, refunds or booking state: a real paid booking is byte-identical after every event family", async () => {
    const client = await prisma.client.create({ data: { companyName: "Brand", contactName: "B", email: "paid@brand.test", passwordHash: "x" } });
    const paidAt = new Date(Date.now() - 3_600_000);
    const booking = await prisma.campaignBooking.create({
      data: { clientId: client.id, name: "Camp", brand: "Brand", status: "paid_pending_review", totalPaise: 100000, submittedAt: paidAt, paidAt },
    });
    await prisma.campaignPayment.create({ data: { bookingId: booking.id, razorpayOrderId: "order_TESTPAIDAT001", razorpayPaymentId: PAY, amountPaise: 100000, status: "captured" } });
    const processing = await mkPayout({ bookingId: booking.id }); // transfer.processed -> held
    const failing = await mkPayout({ bookingId: booking.id, razorpayTransferId: "trf_PAIDAT000002" }); // transfer.failed -> failed (and an alert)
    const settling = await mkPayout({ bookingId: booking.id, razorpayTransferId: "trf_PAIDAT000003", status: "released", recipientSettlementId: SETL }); // settlement.processed -> settled
    const pausing = await mkPayout({ bookingId: booking.id, razorpayTransferId: "trf_PAIDAT000004", status: "held" }); // payment.dispute.created -> paused

    const bookingBefore = await prisma.campaignBooking.findUniqueOrThrow({ where: { id: booking.id } });
    const paymentBefore = await prisma.campaignPayment.findFirstOrThrow({ where: { bookingId: booking.id } });
    expect(bookingBefore.paidAt).toEqual(paidAt);

    await handleRouteEvent("transfer.processed", transferEvt("transfer.processed", processing));
    await handleRouteEvent("transfer.failed", transferEvt("transfer.failed", failing, { id: "trf_PAIDAT000002" }));
    await handleRouteEvent("settlement.processed", settlementEvt());
    await handleRouteEvent("payment.dispute.created", disputeEvt("payment.dispute.created"));
    await handleRouteEvent("payment.dispute.lost", disputeEvt("payment.dispute.lost", { status: "lost" }, nowSec() - 5));

    // The handlers really ran: this test is worthless if they matched nothing.
    expect((await reload(processing.id)).status).toBe("held");
    expect((await reload(failing.id)).status).toBe("failed");
    expect((await reload(settling.id)).status).toBe("settled");
    expect((await reload(pausing.id)).pausedReason).toBe("dispute");
    expect((await prisma.campaignDispute.findUniqueOrThrow({ where: { razorpayDisputeId: DISPUTE } })).bookingId).toBe(booking.id);

    // ...and the brand's side of the money is exactly as it was, down to updatedAt.
    expect(await prisma.campaignBooking.findUniqueOrThrow({ where: { id: booking.id } })).toEqual(bookingBefore);
    expect(await prisma.campaignPayment.findFirstOrThrow({ where: { bookingId: booking.id } })).toEqual(paymentBefore);
    expect(await prisma.campaignRefund.count()).toBe(0);
    expect(await prisma.campaignBookingEvent.count()).toBe(0);
  });

  it("route-webhooks.ts has no code path that writes bookings, payments or refunds (a tripwire for what the test above cannot reach)", () => {
    const src = readFileSync(join(__dirname, "../src/services/campaign/route-webhooks.ts"), "utf8");
    expect(src).not.toMatch(/\b(?:prisma|tx)\.campaign(?:Booking|BookingItem|BookingEvent|Payment|Refund)\.(?:update|updateMany|create|createMany|upsert|delete|deleteMany)\b/);
    expect(src).not.toMatch(/paidAt|transitionBooking/);
  });
});

// ── The shared pause rule (services/creator/payout-pause.ts) ────────────────────

// The dispute handler and the external-refund reconcile both pause through this one function, so
// the rule (what is paused, which reason wins, the lock order) has exactly one implementation.
describe("pausePayoutsOfPayment: the one pause rule behind the dispute handler and the refund reconcile", () => {
  const SPEC = { reason: "external_refund", actorType: "system", note: "Paused: a refund we did not issue was found on the payment." };

  const seedMixed = async () => {
    const earlier = new Date(Date.now() - 3 * 3_600_000);
    const inFlight = [
      await mkPayout({ status: "held", razorpayTransferId: "trf_PAUSE0000001" }),
      await mkPayout({ status: "planned", razorpayTransferId: null }),
      await mkPayout({ status: "released", razorpayTransferId: "trf_PAUSE0000003" }),
      await mkPayout({ status: "transfer_requested", razorpayTransferId: "trf_PAUSE0000004" }),
    ];
    const settled = await mkPayout({ status: "settled", razorpayTransferId: "trf_PAUSE0000005" });
    const reversed = await mkPayout({ status: "reversed", razorpayTransferId: "trf_PAUSE0000006" });
    const alreadyPaused = await mkPayout({ status: "held", razorpayTransferId: "trf_PAUSE0000007", pausedAt: earlier, pausedReason: "bank_change" });
    const elsewhere = await mkPayout({ status: "held", razorpayTransferId: "trf_PAUSE0000008", razorpayPaymentId: "pay_ANOTHERPAYMENT1" });
    return { earlier, inFlight, settled, reversed, alreadyPaused, elsewhere };
  };

  it("pauses exactly the in-flight payouts of the payment, keeps an earlier reason, and writes one audit row per payout it paused", async () => {
    const s = await seedMixed();
    const at = new Date(Date.now() - 60_000);
    const paused = await prisma.$transaction((tx) => pausePayoutsOfPaymentRows(tx, PAY, { ...SPEC, at, eventId: "evt_pause_1" }));

    expect(paused.map((p) => p.id)).toEqual(s.inFlight.map((p) => p.id).sort());
    for (const p of s.inFlight) {
      const after = await reload(p.id);
      expect(after.pausedAt, p.status).toEqual(at);
      expect(after.pausedReason, p.status).toBe("external_refund");
      expect(after.status, p.status).toBe(p.status); // an overlay: the status does not move
      const ev = await eventsOf(p.id);
      expect(ev, p.status).toHaveLength(1);
      expect(ev[0], p.status).toMatchObject({ kind: "pause", fromStatus: p.status, toStatus: p.status, amountPaise: 50000, actorType: "system", razorpayEventId: "evt_pause_1", note: SPEC.note });
    }
    expect(paused.find((p) => p.id === s.inFlight[0].id)?.status).toBe("held");
    // Nothing in flight, already paused for another reason, or another payment: untouched, no audit row.
    for (const untouched of [s.settled, s.reversed, s.elsewhere]) {
      expect((await reload(untouched.id)).pausedAt, untouched.status).toBeNull();
      expect(await eventsOf(untouched.id), untouched.status).toHaveLength(0);
    }
    expect(await reload(s.alreadyPaused.id)).toMatchObject({ pausedAt: s.earlier, pausedReason: "bank_change" });
    expect(await eventsOf(s.alreadyPaused.id)).toHaveLength(0);

    // A second call finds nothing left to pause: the count form reports 0 and nothing is rewritten.
    expect(await prisma.$transaction((tx) => pausePayoutsOfPayment(tx, PAY, SPEC))).toBe(0);
    expect(await reload(s.inFlight[0].id)).toMatchObject({ pausedAt: at, pausedReason: "external_refund" });
    expect(await eventsOf(s.inFlight[0].id)).toHaveLength(1);
  });

  it("the count form reports how many payouts this call paused", async () => {
    const s = await seedMixed();
    expect(await prisma.$transaction((tx) => pausePayoutsOfPayment(tx, PAY, SPEC))).toBe(s.inFlight.length);
  });

  it("takes its row locks in ascending id order, in one locking statement, then one update and one insert", async () => {
    await seedMixed();
    const calls: string[] = [];
    const rawSql: string[] = [];
    await prisma.$transaction(async (tx) => {
      const spied = new Proxy(tx as unknown as AnyTx, {
        get: (t, k) => {
          if (k === "$queryRaw") return (...a: unknown[]) => (calls.push("$queryRaw"), rawSql.push(Array.from(a[0] as ArrayLike<string>).join("?")), t.$queryRaw(...a));
          if (k === "creatorPayout" || k === "creatorPayoutEvent") {
            return new Proxy(t[k as string], {
              get: (m, op) => (typeof m[op as string] === "function" ? (...a: unknown[]) => (calls.push(`${String(k)}.${String(op)}`), m[op as string](...a)) : m[op as string]),
            });
          }
          return bindAll(t, k);
        },
      });
      await pausePayoutsOfPaymentRows(spied as never, PAY, SPEC);
    });
    expect(calls).toEqual(["$queryRaw", "creatorPayout.updateMany", "creatorPayoutEvent.createMany"]);
    expect(rawSql[0]).toMatch(/FROM creator_payouts[\s\S]*ORDER BY id\s+FOR UPDATE/);
  });

  it("is the only code that pauses a payment's payouts: neither caller keeps a private copy", () => {
    const dispute = readFileSync(join(__dirname, "../src/services/campaign/route-webhooks.ts"), "utf8");
    const reconcile = readFileSync(join(__dirname, "../src/services/campaign/payment.service.ts"), "utf8");
    expect(dispute).toMatch(/pausePayoutsOfPaymentRows\(/);
    expect(reconcile).toMatch(/pausePayoutsOfPayment\(/);
    // paused_at is written by the shared helper alone.
    for (const [name, src] of [["route-webhooks.ts", dispute], ["payment.service.ts", reconcile]] as const) {
      expect(src, name).not.toMatch(/pausedReason\s*:/);
      expect(src, name).not.toMatch(/pausedAt\s*:\s*(?!null)/);
    }
  });
});


// ── Phase 4 review fixes ────────────────────────────────────────────────────────

describe("a repeated create request: the twin audit is not skipped by an event that arrives first", () => {
  const audit = async (attempts: number) =>
    mkPayout({ attempts, transferRequestedAt: new Date(Date.now() - 60_000), nextAttemptAt: new Date(Date.now() + 10 * 60_000) });

  it("transfer.processed (held) on a payout whose create call was sent TWICE changes nothing: it stays transfer_requested for the audit, and writes no audit row", async () => {
    const row = await audit(2);
    const r = await handleRouteEvent("transfer.processed", transferEvt("transfer.processed", row), "evt_twin_1");
    expect(r).toEqual({ handled: true, note: "audit_pending" });
    expect(await reload(row.id)).toMatchObject({ status: "transfer_requested", heldAt: null, transferStatus: null, errorCode: null });
    expect(await eventsOf(row.id)).toHaveLength(0);
  });

  it("neither does a failed or a not-held answer: each would skip the audit (a failed one leaves a live twin untracked, a parked one resolves to held unaudited)", async () => {
    const failed = await audit(2);
    expect(await handleRouteEvent("transfer.failed", transferEvt("transfer.failed", failed), "evt_twin_2")).toEqual({ handled: true, note: "audit_pending" });
    expect((await reload(failed.id)).status).toBe("transfer_requested");
    await prisma.creatorPayout.deleteMany({});
    const notHeld = await audit(3);
    expect(await handleRouteEvent("transfer.processed", transferEvt("transfer.processed", notHeld, { on_hold: false }), "evt_twin_3")).toEqual({ handled: true, note: "audit_pending" });
    expect((await reload(notHeld.id)).status).toBe("transfer_requested");
    await prisma.creatorPayout.update({ where: { id: notHeld.id }, data: { razorpayTransferId: "trf_OTHERONE0001" } });
    const dated = await audit(2);
    expect(await handleRouteEvent("transfer.processed", transferEvt("transfer.processed", dated, { on_hold_until: nowSec() + 86400 }), "evt_twin_4")).toEqual({ handled: true, note: "audit_pending" });
    expect((await reload(dated.id)).status).toBe("transfer_requested");
  });

  it("a payout sent ONCE is moved by the event as before, and a mismatch still parks a repeated one (that is not an audit question)", async () => {
    const once = await audit(1);
    expect(await handleRouteEvent("transfer.processed", transferEvt("transfer.processed", once), "evt_twin_5")).toEqual({ handled: true, note: "held" });
    expect((await reload(once.id)).status).toBe("held");
    await prisma.creatorPayout.deleteMany({});
    const twice = await audit(2);
    const r = await handleRouteEvent("transfer.processed", transferEvt("transfer.processed", twice, { amount: 49_999 }), "evt_twin_6");
    expect(r.note).toBe("transfer_mismatch");
    expect((await reload(twice.id)).status).toBe("needs_attention");
  });

  it("the move is still applied once the audit has run: a repeated-create payout that is already held takes later events normally", async () => {
    const row = await mkPayout({ attempts: 2, status: "held" });
    expect((await handleRouteEvent("transfer.processed", transferEvt("transfer.processed", row), "evt_twin_7")).handled).toBe(true);
    expect((await reload(row.id)).status).toBe("held");
  });
});

describe("a transfer that came out NOT held: the event puts the hold back at once, in the background", () => {
  const fake = new FakeRazorpay();
  beforeEach(() => {
    fake.reset();
    fake.install();
    vi.stubEnv("RAZORPAY_KEY_ID", "rzp_test_key");
    vi.stubEnv("RAZORPAY_KEY_SECRET", "rzp_test_secret");
  });
  afterEach(async () => {
    await flushRouteWebhookBackgroundForTests();
    fake.restore();
    vi.unstubAllEnvs();
  });

  async function parkedWorld(entity: { onHold: boolean; onHoldUntil?: number | null }) {
    fake.seedPayment({ id: PAY, amount: 100_000 });
    const row = await mkPayout({ attempts: 1, transferRequestedAt: new Date(Date.now() - 60_000) });
    fake.seedTransfer({ id: TRF, source: PAY, recipient: ACC, amount: 50_000, onHold: entity.onHold, onHoldUntil: entity.onHoldUntil ?? null, notes: { payout_id: row.id } });
    return row;
  }

  it("processed_not_held: the payout is parked AND one on_hold:true request goes out after the answer; the worker's next read then returns it to held", async () => {
    const row = await parkedWorld({ onHold: false });
    const r = await handleRouteEvent("transfer.processed", transferEvt("transfer.processed", row, { on_hold: false }), "evt_hold_1");
    expect(r).toEqual({ handled: true, note: "processed_not_held" });
    expect((await reload(row.id)).status).toBe("needs_attention");
    await flushRouteWebhookBackgroundForTests();
    expect(fake.calls.filter((c) => is.setHold(c, true))).toHaveLength(1);
    expect(fake.calls.filter((c) => is.setHold(c, false))).toHaveLength(0);
    expect(fake.transfers.get(TRF)!.onHold).toBe(true);
    expect((await eventsOf(row.id)).map((e) => e.note)).toContain("The hold was put back on the transfer.");
    // Still parked until a read confirms it; the worker does that.
    expect((await reload(row.id)).status).toBe("needs_attention");
    expect((await selectDuePayouts(new Date(Date.now() + 10 * 60_000))).filter((d) => d.id === row.id)).toEqual([{ id: row.id, job: "confirm_hold" }]);
    const again = await runPayoutJob("confirm_hold", row.id, { now: new Date(Date.now() + 10 * 60_000) });
    expect(again).toMatchObject({ status: "held", outcome: "held" });
  });

  it("an automatic release date is put back the same way", async () => {
    const row = await parkedWorld({ onHold: true, onHoldUntil: nowSec() + 86_400 });
    await handleRouteEvent("transfer.processed", transferEvt("transfer.processed", row, { on_hold: true, on_hold_until: nowSec() + 86_400 }), "evt_hold_2");
    await flushRouteWebhookBackgroundForTests();
    expect(fake.calls.filter((c) => is.setHold(c, true))).toHaveLength(1);
    expect(fake.transfers.get(TRF)!.onHoldUntil).toBeNull();
  });

  it("a refused PATCH is recorded for the audit and does not disturb the webhook's answer; the parked row is left for the worker, which asks again", async () => {
    const row = await parkedWorld({ onHold: false });
    fake.intercept({ match: (c) => is.setHold(c, true), mode: "reject", status: 400, times: 1 });
    const r = await handleRouteEvent("transfer.processed", transferEvt("transfer.processed", row, { on_hold: false }), "evt_hold_3");
    expect(r.handled).toBe(true);
    await flushRouteWebhookBackgroundForTests();
    expect((await eventsOf(row.id)).some((e) => /could not be put back/.test(e.note ?? ""))).toBe(true);
    expect(fake.transfers.get(TRF)!.onHold).toBe(false);
    const later = new Date(Date.now() + 10 * 60_000);
    expect((await selectDuePayouts(later)).filter((d) => d.id === row.id)).toHaveLength(1);
    await runPayoutJob("confirm_hold", row.id, { now: later });
    expect(fake.calls.filter((c) => is.setHold(c, true))).toHaveLength(2);
    expect(fake.transfers.get(TRF)!.onHold).toBe(true);
  });

  it("without Razorpay keys the event parks the payout and nothing else happens (no call, no throw)", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("RAZORPAY_KEY_ID", "");
    vi.stubEnv("RAZORPAY_KEY_SECRET", "");
    const row = await parkedWorld({ onHold: false });
    await handleRouteEvent("transfer.processed", transferEvt("transfer.processed", row, { on_hold: false }), "evt_hold_4");
    await flushRouteWebhookBackgroundForTests();
    expect(fake.calls).toHaveLength(0);
    expect((await reload(row.id)).status).toBe("needs_attention");
  });
});
