/**
 * RACE 5: accept vs decline vs expire vs withdraw on ONE offer, and the refund that follows a close.
 *
 * An offer is the creator's chance to take a booked post. Four things can happen to it at about the same time: the creator
 * accepts, the creator declines, the worker expires it (its time is up), staff withdraw it. Each is a different
 * transaction on a different request; the rule is that the offer ends in ONE state and the money agrees with it:
 *
 *   accepted             the post is the creator's: item manual_pending, payout still held, nothing reversed, nothing refunded;
 *   declined/expired/    the post will not happen: item refund_due, then (reverse BEFORE refund) the creator's payout is
 *   withdrawn            reversed and the brand refunded EXACTLY ONCE, however many callers try to finish the job.
 *
 * What serialises the decision: each transaction takes the BOOKING row lock first (lockBookingRow) and then makes a
 * conditional update on the offer and the item. What these tests add over the main suite: the callers really overlap (a
 * 10-connection pool, simulated Razorpay time), so the post-commit half, the unwind and the refund, runs from several callers
 * at once: the closer's own settle, the reconciliation worker's job 10 (twice), and a staff Refund click.
 *
 * Serial histories that are LEGAL and therefore accepted: accept alone; decline alone; expire alone; withdraw alone; and
 * accept THEN withdraw (a staff withdraw of an accepted offer whose link was not sent is allowed, so the creator saw "accepted"
 * and the offer was withdrawn right after). Never two closers; never accept alongside decline or expire.
 *
 * ⚠️ HONESTY NOTE. The decision half is serialised by the booking row lock, so what varies run to run is WHO WINS, not
 * whether two win. The assertion that two closers never both succeed therefore guards the conditional updates inside the
 * lock; the money assertions (one reversal, one refund) guard the half that really overlaps.
 */
import { describe, it, expect, vi } from "vitest";
import { prisma } from "@dashmani/db";

vi.mock("../../src/services/email.service", async (orig) => {
  const actual = await orig<typeof import("../../src/services/email.service")>();
  return { ...actual, sendEmail: vi.fn(async () => ({ messageId: "test" })), notifyAdminByEmail: vi.fn(async () => ({ messageId: "test" })) };
});

import request from "supertest";
import app from "../../src/app";
import { acceptOffer, declineOffer, expireOffer, withdrawOffer } from "../../src/services/creator/creator-offer.service";
import { progressCreatorItemRefund, runRefundDueJob, settleCreatorRefundsForTests } from "../../src/services/creator/creator-refund.service";
import { openOffer } from "../../tests/payout-fixtures";
import {
  DAY,
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
  type World,
} from "./cc-helpers";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

const fake = new FakeRazorpay();

describe("race 5: accept / decline / expire / withdraw on one offer", () => {
  const h = useMoneyHarness(fake);

  it("5 offers, 3 or 4 deciders and 2 worker jobs each, all at once: ONE ending per offer, ONE reversal and ONE refund when it closed, nothing when it was accepted", async () => {
    const rng = rngFor("offer-race");
    const N = 5;
    const worlds: World[] = [];
    for (let i = 0; i < N; i++) worlds.push(await heldWorld(fake, { pages: [{}] }));
    const offers = [];
    for (const w of worlds) {
      const o = await openOffer(w, w.creators[0].id, { status: "offered", expiresAt: new Date(Date.now() + 30 * MIN) });
      offers.push({ w, offerId: o.id, itemId: w.creators[0].id, creatorId: w.creators[0].creatorId! });
    }
    withLatency(fake, rng, { beforeMs: [2, 14], afterMs: [0, 6], only: (c) => is.createReversal(c) || is.refund(c) || is.fetchTransfer(c) });

    const acceptNow = new Date(); // valid for accept: the offer has 30 minutes left
    const dueNow = new Date(Date.now() + 31 * MIN); // valid for expire: its time is up on THIS clock
    // Offers 0, 2, 4 have all four deciders; offers 1, 3 have no staff withdraw, so "accepted" can be the ending too (a withdraw
    // always succeeds on an accepted offer with no link, so with it in the race "accepted" almost never survives).
    const jobs: Array<{ run: () => Promise<unknown>; delayMs: number }> = [];
    const at: Array<Record<string, number>> = [];
    for (const [i, o] of offers.entries()) {
      const idx: Record<string, number> = {};
      const add = (name: string, run: () => Promise<unknown>, delayMs: number) => {
        idx[name] = jobs.length;
        jobs.push({ run, delayMs });
      };
      add("accept", () => acceptOffer(o.creatorId, o.offerId, acceptNow), Math.floor(rng() * 8));
      add("decline", () => declineOffer(o.creatorId, o.offerId, "not now", acceptNow), Math.floor(rng() * 8));
      add("expire", () => expireOffer(o.offerId, dueNow), Math.floor(rng() * 8));
      if (i % 2 === 0) add("withdraw", () => withdrawOffer(o.offerId, { staffId: h.staff().staffId, now: acceptNow }), Math.floor(rng() * 8));
      // The reconciliation worker's job 10, twice, landing while the closer is still unwinding. (A staff Refund click is NOT in this
      // wave: on an open offer it is itself a closer. The second test has it, on an item that is already claimed.)
      add("job10a", () => runRefundDueJob({ now: dueNow }), 4 + Math.floor(rng() * 25));
      add("job10b", () => runRefundDueJob({ now: dueNow }), 10 + Math.floor(rng() * 30));
      at.push(idx);
    }
    const out = await together(jobs);

    // Only clean refusals: an AppError (409 …) is a loser; anything else is a defect.
    for (const o of out) {
      if (o.ok) continue;
      const e = o.error as { statusCode?: number; code?: string; message?: string };
      expect(e.statusCode, `an operation failed with something that is not a clean refusal: ${String(e.message)} seed=${SEED}`).toBeGreaterThanOrEqual(400);
      expect(e.statusCode).toBeLessThan(500);
    }

    // Let everything that was started finish: background refunds, and the worker's job until nothing is owed.
    await settleCreatorRefundsForTests();
    for (let round = 0; round < 4; round++) {
      await runRefundDueJob({ now: new Date(Date.now() + (round + 1) * 40 * MIN) });
      await settleCreatorRefundsForTests();
    }

    const tally = { accepted: 0, acceptedThenWithdrawn: 0, declined: 0, expired: 0, withdrawn: 0 };
    for (let i = 0; i < N; i++) {
      const o = offers[i];
      const [acc, dec, exp] = [out[at[i].accept], out[at[i].decline], out[at[i].expire]];
      const wd = at[i].withdraw === undefined ? { ok: false } : out[at[i].withdraw];
      const offer = await prisma.creatorOffer.findUniqueOrThrow({ where: { id: o.offerId } });
      const closers = [dec, exp, wd].filter((r) => r.ok).length;
      const where = `offer ${o.offerId}: accept=${acc.ok} decline=${dec.ok} expire=${exp.ok} withdraw=${wd.ok} final=${offer.status} seed=${SEED}`;
      expect(closers, `${where}: more than one closer succeeded`).toBeLessThanOrEqual(1);
      if (acc.ok) expect(dec.ok || exp.ok, `${where}: an accepted offer was then declined or expired`).toBe(false);
      expect(["accepted", "declined", "expired", "withdrawn"], where).toContain(offer.status);

      const p = await prisma.creatorPayout.findUniqueOrThrow({ where: { bookingItemId: o.itemId } });
      const tid = p.razorpayTransferId!;
      const refunds = appliedRefunds(fake).filter((r) => r.key === `rf-item-${o.itemId}`);
      const books = await booksOf(fake, p.razorpayPaymentId);
      if (offer.status === "accepted") {
        tally.accepted++;
        expect(closers, where).toBe(0);
        expect(await itemStatus(o.itemId), where).toBe("manual_pending");
        expect(p.status, where).toBe("held");
        expect(reversalsOf(fake, tid), where).toBe(0);
        expect(refunds, where).toHaveLength(0);
      } else {
        if (acc.ok) tally.acceptedThenWithdrawn++;
        tally[offer.status as "declined" | "expired" | "withdrawn"]++;
        expect(closers, where).toBe(1);
        expect(await itemStatus(o.itemId), where).toBe("refunded");
        // Reverse BEFORE refund, once each: the share is back exactly once, and the brand was refunded exactly once.
        expect(p.status, where).toBe("reversed");
        expect(reversalsOf(fake, tid), `${where}: the payout was reversed ${reversalsOf(fake, tid)} times`).toBe(1);
        expect(refunds, `${where}: the post was refunded ${refunds.length} times`).toHaveLength(1);
        expect(refunds[0].amount, where).toBe(o.w.creators[0].price);
        const reversalAt = fake.applied.findIndex((a) => a.status < 300 && is.createReversal(a.call) && a.call.path.includes(tid));
        const refundAt = fake.applied.findIndex((a) => a.status < 300 && is.refund(a.call) && a.call.headers["X-Refund-Idempotency"] === `rf-item-${o.itemId}`);
        expect(reversalAt, `${where}: the refund was applied before the reversal`).toBeLessThan(refundAt);
      }
      expectBooksClose(books, where);
      await expectPayoutMatchesRazorpay(fake, p.id, where);
    }
    await expectLegalHistories((await Promise.all(offers.map((o) => payoutIdsOf(o.w)))).flat(), "offer race");
    console.log(`[race 5] ${JSON.stringify(tally)} (seed ${SEED})`);
  });

  it("the same refund started by FIVE callers at once on one claimed item (two direct calls, two worker jobs, a staff click): one reversal, one refund", async () => {
    const rng = rngFor("offer-race-finishers");
    const w = await heldWorld(fake, { pages: [{}] });
    const item = w.creators[0];
    const o = await openOffer(w, item.id, { status: "offered", expiresAt: new Date(Date.now() + 30 * MIN) });
    withLatency(fake, rng, { beforeMs: [4, 16], afterMs: [0, 8], only: (c) => is.createReversal(c) || is.refund(c) });
    // Close it without settling (the worker's way: expiry claims the item and leaves the refund to job 10), then let five finishers loose.
    await expireOffer(o.id, new Date(Date.now() + 31 * MIN));
    expect(await itemStatus(item.id)).toBe("refund_due");
    const later = new Date(Date.now() + DAY);
    const out = await together([
      () => progressCreatorItemRefund(item.id, { actor: { type: "system" }, reason: "refund_due", now: later }),
      () => progressCreatorItemRefund(item.id, { actor: { type: "system" }, reason: "refund_due", now: later }),
      { run: () => runRefundDueJob({ now: later }), delayMs: 3 },
      { run: () => runRefundDueJob({ now: later }), delayMs: 9 },
      {
        run: async () => (await request(app).post(`/v1/admin/campaigns/${w.booking.id}/items/${item.id}/refund`).set("Authorization", `Bearer ${h.staff().admin}`).send({})).status,
        delayMs: 6,
      },
    ]);
    for (const r of out) expect(r.ok, String((r.error as Error)?.stack ?? r.error)).toBe(true);
    await settleCreatorRefundsForTests();
    const p = await prisma.creatorPayout.findUniqueOrThrow({ where: { bookingItemId: item.id } });
    expect(p.status).toBe("reversed");
    expect(reversalsOf(fake, p.razorpayTransferId!), `seed=${SEED}`).toBe(1);
    expect(appliedRefunds(fake).filter((r) => r.key === `rf-item-${item.id}`), `seed=${SEED}`).toHaveLength(1);
    expect(await itemStatus(item.id)).toBe("refunded");
    expectBooksClose(await booksOf(fake, p.razorpayPaymentId), "five finishers");
    await expectLegalHistories([p.id]);
  });
});
