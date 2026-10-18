/**
 * RACE 7: rejecting a campaign (a sequence that can be run again) while the refund workers finish the same posts.
 *
 * Reject with creator posts is NOT one step. It claims every creator post (refund due), withdraws the creators' offers, takes
 * each creator's share BACK from Razorpay (reverse BEFORE refund), and only when every share is back moves the campaign to
 * rejected and refunds each post once. A step that cannot finish leaves a visible partial state and the SAME button resumes it.
 * Meanwhile three other things are working on the same rows without being asked: the reconciliation worker's job 10 (refunds
 * creator posts that are refund due), the payment-level refund sweep (sweepRefundDue), and the worker's whole tick.
 *
 * THIS TEST BUILDS THE PARTIAL STATE FOR REAL (Razorpay refuses the second reversal once, so the first Reject leaves one share
 * still held, three posts refund due, the campaign not yet rejected) and then starts, at the same moment: Reject twice (two
 * tabs), job 10 twice, the refund sweep, and a full worker tick, with simulated Razorpay time on every money call.
 *
 * Several of them will lose a claim to another and answer a clean 409 (the post was claimed by someone else: BUSY, or the
 * campaign is already rejected). That is correct and expected: a loser is allowed, a duplicate effect is not. After the wave,
 * staff press Reject again and the workers tick until nothing is owed, as they would. ASSERTED about the END STATE:
 *   • every post (3 creators + 1 network) is refunded, under its own key `rf-item-<id>`, exactly ONCE at Razorpay;
 *   • the refunds add up to what was captured and not a paisa more, and no refund other than those four exists (a payment-level
 *     remainder refund on top of the item refunds would repay the brand twice);
 *   • each creator's transfer was reversed exactly ONCE, for the explicit amount, and BEFORE that creator's post was refunded;
 *   • the campaign ended rejected/refunded, every payout reversed, the ledger agrees with Razorpay;
 *   • no 5xx anywhere.
 */
import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { prisma } from "@dashmani/db";

vi.mock("../../src/services/email.service", async (orig) => {
  const actual = await orig<typeof import("../../src/services/email.service")>();
  return { ...actual, sendEmail: vi.fn(async () => ({ messageId: "test" })), notifyAdminByEmail: vi.fn(async () => ({ messageId: "test" })) };
});

import app from "../../src/app";
import { sweepRefundDue } from "../../src/services/campaign/payment.service";
import { runRefundDueJob, settleCreatorRefundsForTests } from "../../src/services/creator/creator-refund.service";
import { runCreatorPayoutsTick } from "../../src/cron/creator-payouts.cron";
import {
  FakeRazorpay,
  MIN,
  SEED,
  appliedRefunds,
  booksOf,
  expectBooksClose,
  expectLegalHistories,
  expectPayoutMatchesRazorpay,
  heldWorld,
  is,
  itemStatus,
  payoutIdsOf,
  reversalsOf,
  rngFor,
  together,
  useMoneyHarness,
  withLatency,
} from "./cc-helpers";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

const fake = new FakeRazorpay();

describe("race 7: Reject (resumed) vs the refund workers", () => {
  const h = useMoneyHarness(fake);

  it("a half-finished Reject, then Reject x2 + job 10 x2 + the refund sweep + a worker tick at once: every post refunded ONCE, every share reversed ONCE, before its refund", async () => {
    const rng = rngFor("reject-vs-sweep");
    const w = await heldWorld(fake, { pages: [{}, {}, {}], network: [100_000] });
    const reject = async (): Promise<{ status: number; code?: string; pending?: boolean }> => {
      const r = await request(app).post(`/v1/admin/campaigns/${w.booking.id}/reject`).set("Authorization", `Bearer ${h.staff().admin}`).send({ note: "Not suitable" });
      return { status: r.status, code: r.body?.error?.code, pending: r.body?.data?.rejectPending === true };
    };

    // ── The partial state, built the way it happens: Razorpay refuses the second reversal once. ──
    fake.intercept({ match: is.createReversal, mode: "reject", status: 400, skip: 1, times: 1 });
    const first = await reject();
    expect(first, "the first Reject must say it is not finished").toMatchObject({ status: 200, pending: true });
    expect(appliedRefunds(fake), "nothing may be refunded while a share is still out").toHaveLength(0);
    const ids = await payoutIdsOf(w);
    const states = (await Promise.all(ids.map((id) => prisma.creatorPayout.findUniqueOrThrow({ where: { id } })))).map((p) => p.status).sort();
    // The first reversal went through, the second was refused (back to held), the third went through.
    expect(states, `seed=${SEED}`).toEqual(["held", "reversed", "reversed"]);

    // ── The wave. `later` is far enough on for the workers' ages and backoffs to have passed. ──
    const later = new Date(Date.now() + 30 * MIN);
    withLatency(fake, rng, { beforeMs: [2, 14], afterMs: [0, 6], only: (c) => is.createReversal(c) || is.refund(c) || is.fetchTransfer(c) });
    const out = await together([
      { run: reject, delayMs: 0 },
      { run: reject, delayMs: Math.floor(rng() * 20) },
      { run: () => runRefundDueJob({ now: later }), delayMs: Math.floor(rng() * 20) },
      { run: () => runRefundDueJob({ now: later }), delayMs: Math.floor(rng() * 30) },
      { run: () => sweepRefundDue({ now: later }), delayMs: Math.floor(rng() * 30) },
      { run: () => runCreatorPayoutsTick({ now: later }), delayMs: Math.floor(rng() * 40) },
    ]);
    for (const o of out) expect(o.ok, String((o.error as Error)?.stack ?? o.error)).toBe(true);
    console.log(`[race 7] wave: reject=${JSON.stringify(out.slice(0, 2).map((o) => o.value))} job10=${JSON.stringify(out.slice(2, 4).map((o) => o.value))} sweep=${JSON.stringify(out[4].value)} (seed ${SEED})`);
    for (const o of out.slice(0, 2)) {
      const v = o.value as { status: number; code?: string };
      expect(v.status, `Reject answered ${JSON.stringify(v)} (seed ${SEED}): a loser must be a clean 2xx/409, never a 5xx`).toBeLessThan(500);
      if (v.status >= 400) expect(v.status).toBe(409);
    }

    // ── Then what staff and the workers do: press Reject again and let the workers tick until nothing is owed. ──
    let step = 0;
    for (; step < 12; step++) {
      const b = await prisma.campaignBooking.findUniqueOrThrow({ where: { id: w.booking.id }, select: { status: true } });
      const open = (await Promise.all(w.items.map((i) => itemStatus(i.id)))).filter((s) => s !== "refunded").length;
      if ((b.status === "rejected" || b.status === "refunded") && open === 0) break;
      const r = await reject();
      expect(r.status, `Reject answered ${JSON.stringify(r)} (seed ${SEED})`).toBeLessThan(500);
      const t = new Date(later.getTime() + (step + 1) * 30 * MIN);
      await runRefundDueJob({ now: t });
      await sweepRefundDue({ now: t });
      await runCreatorPayoutsTick({ now: t });
      await settleCreatorRefundsForTests();
    }
    console.log(`[race 7] converged after ${step} more step(s) (seed ${SEED})`);
    expect(step, `Reject and the workers did not converge (seed ${SEED})`).toBeLessThan(12);

    // ── The end state. ──
    const booking = await prisma.campaignBooking.findUniqueOrThrow({ where: { id: w.booking.id } });
    expect(["rejected", "refunded"], `seed=${SEED}`).toContain(booking.status);
    const refunds = appliedRefunds(fake);
    for (const i of w.items) {
      const mine = refunds.filter((r) => r.key === `rf-item-${i.id}`);
      expect(mine, `item ${i.id} was refunded ${mine.length} times (seed ${SEED})`).toHaveLength(1);
      expect(mine[0].amount).toBe(i.price);
      expect(await itemStatus(i.id)).toBe("refunded");
    }
    expect(refunds, `a refund other than the four item refunds exists: ${JSON.stringify(refunds)} (seed ${SEED})`).toHaveLength(4);
    expect(refunds.reduce((a, r) => a + r.amount, 0)).toBe(w.total);

    for (const c of w.creators) {
      const p = await prisma.creatorPayout.findUniqueOrThrow({ where: { bookingItemId: c.id } });
      expect(p.status, `seed=${SEED}`).toBe("reversed");
      const tid = p.razorpayTransferId!;
      // Once, for the explicit amount, before the refund of that very post.
      const applied = fake.applied.filter((a) => a.status < 300 && is.createReversal(a.call) && a.call.path.includes(tid));
      expect(applied, `the share of ${p.id} was reversed ${applied.length} times (seed ${SEED})`).toHaveLength(1);
      expect(applied[0].call.body?.amount, "a reversal must name its amount, never reverse_all").toBe(p.amountPaise);
      expect(reversalsOf(fake, tid)).toBe(1);
      const reversalAt = fake.applied.findIndex((a) => a === applied[0]);
      const refundAt = fake.applied.findIndex((a) => a.status < 300 && is.refund(a.call) && a.call.headers["X-Refund-Idempotency"] === `rf-item-${c.id}`);
      expect(reversalAt, `the post of ${c.id} was refunded before its share was taken back (seed ${SEED})`).toBeLessThan(refundAt);
      await expectPayoutMatchesRazorpay(fake, p.id, "reject vs sweep");
    }

    // The ledger and Razorpay agree, and the payment is fully refunded.
    const pay = await prisma.campaignPayment.findFirstOrThrow({ where: { bookingId: w.booking.id } });
    const ledger = await prisma.campaignRefund.findMany({ where: { paymentId: pay.id, status: { not: "failed" } } });
    expect(ledger.reduce((a, r) => a + r.amountPaise, 0), `seed=${SEED}`).toBe(w.total);
    expect(pay.refundedPaise).toBe(w.total);
    const books = await booksOf(fake, w.payId);
    expect(books.refundedAtRazorpay).toBe(w.total);
    expect(books.transferredNet, "every creator share is back").toBe(0);
    expectBooksClose(books, "reject vs sweep");
    await expectLegalHistories(await payoutIdsOf(w), "reject vs sweep");
  });
});
