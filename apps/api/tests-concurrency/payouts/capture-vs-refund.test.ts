/**
 * RACE 3: the capture of a payment, the transfers it sets off, and refunds of the SAME payment arriving meanwhile.
 *
 * The brand pays once; that one payment funds the network posts AND each creator's held transfer. Three rules meet on it:
 *
 *   [R4] Razorpay refuses a transfer on a payment once a refund has been initiated on it. A refund that lands while a
 *        creator's payout is still `planned` or `transfer_requested` would therefore STRAND that creator's share (their payout
 *        would have to be paid by hand). So claimRefund refuses (409 REFUND_WAITING) while any payout of the payment is in
 *        either state, and the caller keeps the money owed.
 *   RESERVE  captured − refunded − RESERVED is what may still be refunded, where reserved = the item price of every creator
 *        post whose payout is not reversed or void. Refunding a creator's price while their share is still out would repay
 *        the brand with money that is not ours.
 *   ONCE  the payment is captured ONCE, however many times Razorpay delivers payment.captured / order.paid.
 *
 * WHAT IS RAISED TOGETHER: three deliveries of the capture (two events, three ids); a staff refund of the network post that
 * starts the moment the payment reads `captured` and is retried like staff would while it answers 409; and four direct
 * refund claims of the SAME 100,000 paise, which compete with it for the single refundable remainder (850,000 captured, 750,000
 * reserved by the three creators).
 *
 * ASSERTED: one capture (3 payouts, 3 transfers); every payout `held` (none failed, none manual_required: a refund never beat a
 * transfer); no refund was APPLIED at Razorpay before the last transfer was; exactly ONE of the five competing refunds got the
 * remainder and nothing was refunded beyond it; the books close (refunds + live transfers ≤ captured; the unclamped refundable
 * amount is never negative); and no caller got a 5xx or an unexplained failure.
 */
import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { prisma } from "@dashmani/db";

vi.mock("../../src/services/email.service", async (orig) => {
  const actual = await orig<typeof import("../../src/services/email.service")>();
  return { ...actual, sendEmail: vi.fn(async () => ({ messageId: "test" })), notifyAdminByEmail: vi.fn(async () => ({ messageId: "test" })) };
});

import app from "../../src/app";
import { refundPaymentRow, settlePayoutKicksForTests } from "../../src/services/campaign/payment.service";
import {
  FakeRazorpay,
  SEED,
  appliedRefunds,
  booksOf,
  expectBooksClose,
  expectLegalHistories,
  expectPayoutMatchesRazorpay,
  is,
  mkWorld,
  payoutIdsOf,
  rngFor,
  sleep,
  together,
  useMoneyHarness,
  waitUntil,
  withLatency,
  deliver,
} from "./cc-helpers";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

const fake = new FakeRazorpay();

describe("race 3: capture vs refund on one payment", () => {
  const h = useMoneyHarness(fake);

  it("3 capture deliveries + a staff refund of the network post + 4 direct claims of the same remainder, all at once: one capture, three held transfers, one refund of exactly the unreserved remainder", async () => {
    const rng = rngFor("capture-vs-refund");
    const w = await mkWorld(fake, { pages: [{}, {}, {}], network: [100_000] });
    fake.seedPayment({ id: w.payId, amount: w.total });
    expect(w.total).toBe(850_000); // 3 × 250,000 creators + 100,000 network
    const payment = await prisma.campaignPayment.findFirstOrThrow({ where: { bookingId: w.booking.id } });
    const netItem = w.networkItems[0];
    // The creators' share is only 40% of their price, but the WHOLE price is reserved: 750,000 reserved, 100,000 refundable.
    const REFUNDABLE = 100_000;
    withLatency(fake, rng, { beforeMs: [3, 16], afterMs: [0, 6], only: (c) => is.createTransfer(c) || is.refund(c) || is.fetchTransfer(c) });

    const payload = { payment: { entity: { id: w.payId, order_id: w.orderId, amount: w.total, currency: "INR" } } };
    let toldToWait = 0; // refund attempts answered "wait: a creator's payout is still being set aside" (the window this test is about)
    const staffRefund = async (): Promise<{ status: number; code?: string }> => {
      // Starts the moment the capture committed, then presses again like a person would until it is not told to wait.
      await waitUntil(async () => (await prisma.campaignPayment.findUniqueOrThrow({ where: { id: payment.id }, select: { status: true } })).status !== "created", "the capture to commit", 20_000, 3);
      let last: { status: number; code?: string } = { status: 0 };
      for (let i = 0; i < 80; i++) {
        const r = await request(app).post(`/v1/admin/campaigns/${w.booking.id}/items/${netItem.id}/refund`).set("Authorization", `Bearer ${h.staff().admin}`).send({});
        last = { status: r.status, code: r.body?.error?.code };
        if (r.body?.error?.code === "REFUND_WAITING") toldToWait++;
        if (r.status === 200 || (r.status === 409 && r.body?.error?.code !== "REFUND_WAITING")) return last;
        await sleep(20);
      }
      return last;
    };
    const directClaim = (k: number) => async (): Promise<{ ok: boolean; code?: string }> => {
      await waitUntil(async () => (await prisma.campaignPayment.findUniqueOrThrow({ where: { id: payment.id }, select: { status: true } })).status !== "created", "the capture to commit", 20_000, 3);
      for (let i = 0; i < 80; i++) {
        try {
          await refundPaymentRow(payment.id, REFUNDABLE, `extra:${k}`, { type: "system" }, { key: `cc-extra-${k}`, reason: "item_refunded" });
          return { ok: true };
        } catch (e) {
          const code = (e as { code?: string }).code;
          if (code === "REFUND_WAITING") toldToWait++;
          if (code !== "REFUND_WAITING") return { ok: false, code };
          await sleep(20);
        }
      }
      return { ok: false, code: "gave_up_waiting" };
    };

    const out = await together([
      { run: () => deliver("payment.captured", payload, `evt_cap_${k(1)}`), delayMs: 0 },
      { run: () => deliver("order.paid", payload, `evt_cap_${k(2)}`), delayMs: Math.floor(rng() * 6) },
      { run: () => deliver("payment.captured", payload, `evt_cap_${k(3)}`), delayMs: Math.floor(rng() * 10) },
      { run: staffRefund, delayMs: 0 },
      ...[1, 2, 3, 4].map((n) => ({ run: directClaim(n), delayMs: Math.floor(rng() * 10) })),
    ]);
    await settlePayoutKicksForTests();

    for (const o of out) expect(o.ok, String((o.error as Error)?.stack ?? o.error)).toBe(true);
    for (const o of out.slice(0, 3)) expect((o.value as { status: number }).status, `a capture delivery was not answered 2xx (seed ${SEED})`).toBe(200);

    // ONE capture: three payouts, three transfers, the booking moved once.
    const payouts = await prisma.creatorPayout.findMany({ where: { bookingId: w.booking.id } });
    expect(payouts, `seed=${SEED}`).toHaveLength(3);
    expect(fake.appliedOk(is.createTransfer), `seed=${SEED}`).toHaveLength(3);
    for (const p of payouts) {
      expect(p.status, `a refund beat a transfer: payout ${p.id} is ${p.status} (${p.errorCode}) seed=${SEED}`).toBe("held");
      await expectPayoutMatchesRazorpay(fake, p.id, "capture vs refund");
    }
    expect((await prisma.campaignBooking.findUniqueOrThrow({ where: { id: w.booking.id } })).status).toBe("paid_pending_review");

    // The test is only worth something if a refund really did arrive while a transfer could still be made.
    console.log(`[race 3] refund attempts told to wait for a creator's transfer: ${toldToWait} (seed ${SEED})`);
    expect(toldToWait, "no refund ever met a planned or requested payout: the window was not crossed").toBeGreaterThan(0);

    // [R4]: no refund was applied at Razorpay before the last transfer was.
    const lastTransferAt = Math.max(...fake.applied.map((a, i) => (a.status < 300 && is.createTransfer(a.call) ? i : -1)));
    const firstRefundAt = fake.applied.findIndex((a) => a.status < 300 && is.refund(a.call));
    expect(firstRefundAt, `seed=${SEED}`).toBeGreaterThan(lastTransferAt);

    // RESERVE: five competitors for one remainder; exactly one got it, and nothing beyond it was refunded.
    const refunds = appliedRefunds(fake);
    expect(refunds, `seed=${SEED}`).toHaveLength(1);
    expect(refunds[0].amount).toBe(REFUNDABLE);
    const winners = [out[3], ...out.slice(4)].filter((o) => (o.value as { ok?: boolean; status?: number })?.ok === true || (o.value as { status?: number })?.status === 200);
    expect(winners, `exactly one of the five refund attempts may have been served (seed ${SEED})`).toHaveLength(1);
    // The losers lost cleanly: a conflict, never an unexplained failure.
    for (const o of [out[3], ...out.slice(4)]) {
      const v = o.value as { ok?: boolean; status?: number; code?: string };
      if (v.ok === true || v.status === 200) continue;
      expect(["REFUND_CONFLICT", "NOTHING_TO_REFUND", "INVALID_STATE", "NOT_CAPTURED"], `a refund competitor failed with ${JSON.stringify(v)} (seed ${SEED})`).toContain(v.code);
    }
    const books = await booksOf(fake, w.payId);
    expect(books.refundedAtRazorpay).toBe(REFUNDABLE);
    expect(books.refundedLedger).toBe(REFUNDABLE);
    expectBooksClose(books, "capture vs refund");
    await expectLegalHistories(await payoutIdsOf(w), "capture vs refund");
  });
});

let seq = 0;
const k = (n: number) => `${process.pid}_${Date.now()}_${++seq}_${n}`;
