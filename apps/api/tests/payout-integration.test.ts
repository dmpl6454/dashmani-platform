/**
 * The money leg, wired into the product (payout plan Phase 4, integration): the capture kick, the refund seams of every way a
 * creator's post can end (reverse BEFORE refund), reject as a re-runnable sequence, the refund that waits for a sibling's
 * transfer [R4], the release schedule, and the switches. The booking flows are the real services behind the real routes;
 * every Razorpay call goes to the stateful fake (tests/fake-razorpay-route.ts), so ONE call log shows the order of every
 * money move and a test can say "the reversal came before the refund" about what actually happened.
 *
 * The engine's own properties (one transfer per payout, the release gate, reversal arithmetic) are proved in payout-engine.test.ts;
 * the worker in payout-cron.test.ts; the staff API in payout-admin.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@dashmani/db";
import "./setup";

vi.mock("../src/services/email.service", async (orig) => {
  const actual = await orig<typeof import("../src/services/email.service")>();
  return { ...actual, sendEmail: vi.fn(async () => ({ messageId: "test" })), notifyAdminByEmail: vi.fn(async () => ({ messageId: "test" })) };
});

import app from "../src/app";
import { notifyAdminByEmail } from "../src/services/email.service";
import { resetPayoutAlertsForTests } from "../src/services/creator/payout-alert";
import { settlePayoutKicksForTests } from "../src/services/campaign/payment.service";
import { expireOffer, withdrawOffer } from "../src/services/creator/creator-offer.service";
import { onCreatorLinkVerified } from "../src/services/creator/payout-ledger";
import { RELEASE_SWITCH_KEY, executePlannedPayout, reservedPaiseForPayment } from "../src/services/creator/payout.service";
import { runRefundDueJob, settleCreatorRefundsForTests } from "../src/services/creator/creator-refund.service";
import { resetCreatorPayoutsCronForTests, runCreatorPayoutsTick } from "../src/cron/creator-payouts.cron";
import { FakeRazorpay, is } from "./fake-razorpay-route";
import { generateCreatorToken } from "./helpers";
import {
  DAY,
  HOUR,
  MIN,
  bookingOf,
  callLog,
  capture,
  countOf,
  fakeRefunds,
  firstIndex,
  itemOf,
  mkStaff,
  mkWorld,
  offerOf,
  openOffer,
  payoutOf,
  stubPayoutEnv,
  verifiedOffer,
  type StaffWorld,
  type World,
} from "./payout-fixtures";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const fake = new FakeRazorpay();

let staff: StaffWorld;

beforeEach(async () => {
  // system_settings is not truncated between tests: the release switch must start every test absent (= on).
  await prisma.systemSetting.deleteMany({ where: { key: "creatorPayouts.release" } });
  stubPayoutEnv();
  fake.reset();
  fake.install();
  resetPayoutAlertsForTests();
  resetCreatorPayoutsCronForTests();
  vi.mocked(notifyAdminByEmail).mockClear();
  staff = await mkStaff();
});
afterEach(async () => {
  await prisma.systemSetting.deleteMany({ where: { key: "creatorPayouts.release" } }); // leave nothing behind for the next file
  await settlePayoutKicksForTests();
  await settleCreatorRefundsForTests();
  fake.restore();
  vi.unstubAllEnvs();
});

const staffPost = (path: string, body: object = {}) => request(app).post(`/v1/admin/campaigns/${path}`).set("Authorization", `Bearer ${staff.admin}`).send(body);
const creatorPost = (creatorId: string, path: string, body: object = {}) => request(app).post(`/v1${path}`).set("Authorization", `Bearer ${generateCreatorToken(creatorId, `creator-${creatorId}@x.test`)}`).send(body);

/** A captured booking: the payouts are planned and (the kick being on) held by the time this returns. */
async function paid(spec: Parameters<typeof mkWorld>[1]): Promise<World> {
  const w = await mkWorld(fake, spec);
  expect((await capture(fake, w)).status).toBe(200);
  return w;
}

/** Put a creator item's payout in a state the kick did not leave it in (the fake keeps the transfer it already made). */
const setPayout = (itemId: string, data: Record<string, unknown>) => prisma.creatorPayout.update({ where: { bookingItemId: itemId }, data });

// ── The capture kick ──────────────────────────────────────────────────────────────

describe("the capture kick", () => {
  it("makes exactly ONE held transfer per creator item and none for a network item; a second delivery makes none", async () => {
    const w = await mkWorld(fake, { pages: [{}, { price: 300_000, shareBps: 5000 }], network: [100_000] });
    expect((await capture(fake, w)).status).toBe(200);
    expect(await prisma.creatorPayout.count({ where: { bookingId: w.booking.id } })).toBe(2);
    for (const c of w.creators) {
      const p = await payoutOf(c.id);
      expect(p).toMatchObject({ status: "held", amountPaise: c.payout });
      const t = fake.transfers.get(p.razorpayTransferId!)!;
      expect(t).toMatchObject({ amount: c.payout, onHold: true, source: w.payId });
    }
    expect(countOf(callLog(fake), "transfer.create")).toBe(2);
    expect((await bookingOf(w.booking.id)).status).toBe("paid_pending_review");

    // The same payment delivered again under another event (order.paid) and the very same event id again: nothing more is made.
    expect((await capture(fake, w, { event: "order.paid" })).status).toBe(200);
    expect(countOf(callLog(fake), "transfer.create")).toBe(2);
    expect(await prisma.creatorPayout.count({ where: { bookingId: w.booking.id } })).toBe(2);
  });

  it("the webhook answers before the transfers are made: a create call held open does not delay the 200", async () => {
    const w = await mkWorld(fake, { pages: [{}] });
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    fake.intercept({ match: is.createTransfer, mode: "hold", gate, times: 1 });
    const t0 = Date.now();
    try {
      const res = await capture(fake, w, { settle: false });
      expect(res.status).toBe(200);
      expect(Date.now() - t0).toBeLessThan(4_000); // Razorpay gives a webhook 5 seconds
      // The kick is in flight behind the held create call: the answer did not wait for it.
      await vi.waitFor(() => expect(countOf(callLog(fake), "transfer.create")).toBe(1));
      expect(["planned", "transfer_requested"]).toContain((await payoutOf(w.creators[0].id)).status);
    } finally {
      open();
    }
    await settlePayoutKicksForTests();
    expect(await payoutOf(w.creators[0].id)).toMatchObject({ status: "held" });
    expect(countOf(callLog(fake), "transfer.create")).toBe(1);
  });

  it("is off with the Route switch off (planned stays planned, no create call) and the worker's own pass makes it once the switch is on", async () => {
    vi.stubEnv("CREATOR_ROUTE_ENABLED", "0");
    const w = await paid({ pages: [{}] });
    expect(await payoutOf(w.creators[0].id)).toMatchObject({ status: "planned", razorpayTransferId: null });
    expect(countOf(callLog(fake), "transfer.create")).toBe(0);
    // With the switch off the worker leaves it planned too (nothing NEW is created) ...
    await runCreatorPayoutsTick();
    expect((await payoutOf(w.creators[0].id)).status).toBe("planned");
    expect(countOf(callLog(fake), "transfer.create")).toBe(0);
    // ... and once it is back on, the worker is the backstop of the kick.
    vi.stubEnv("CREATOR_ROUTE_ENABLED", "1");
    const tick = await runCreatorPayoutsTick();
    expect(tick.jobs.execute).toBe(1);
    expect(await payoutOf(w.creators[0].id)).toMatchObject({ status: "held" });
    expect(countOf(callLog(fake), "transfer.create")).toBe(1);
  });

  it("is off with the payout worker stopped (CREATOR_PAYOUT_CRON_ENABLED=0): no Razorpay call at all, from the kick or the worker", async () => {
    vi.stubEnv("CREATOR_PAYOUT_CRON_ENABLED", "0");
    const w = await paid({ pages: [{}] });
    expect(await payoutOf(w.creators[0].id)).toMatchObject({ status: "planned" });
    expect((await runCreatorPayoutsTick()).ran).toBe(false);
    expect(fake.calls.filter((c) => c.path.startsWith("/v1/transfers") || is.createTransfer(c))).toHaveLength(0);
    expect((await payoutOf(w.creators[0].id)).status).toBe("planned");
  });
});

// ── Reverse BEFORE refund: every way a creator's post can end × where its payout is ────

type PayoutState = "planned" | "transfer_requested" | "held" | "released";
type Flow = "refundItem" | "withdraw" | "decline" | "expire" | "missed_window";
const FLOWS: Flow[] = ["refundItem", "withdraw", "decline", "expire", "missed_window"];
const STATES: PayoutState[] = ["planned", "transfer_requested", "held", "released"];

/** What each payout state must lead to, whichever way the post ended. `refunded` and `reversals` count Razorpay requests. */
const EXPECT: Record<PayoutState, { payout: string; item: "refunded" | "refund_due" | "open"; refunds: number; reversals: number; refused: boolean }> = {
  // Nothing has left our balance: the payout is voided, then the brand is refunded.
  planned: { payout: "void", item: "refunded", refunds: 1, reversals: 0, refused: false },
  // The transfer is still being made: no refund may start, nothing is reversed, the post waits as refund_due for the worker [R4].
  transfer_requested: { payout: "transfer_requested", item: "refund_due", refunds: 0, reversals: 0, refused: false },
  // The share is in the linked account on hold: it is taken back FIRST (one explicit reversal), and only then is the brand refunded.
  held: { payout: "reversed", item: "refunded", refunds: 1, reversals: 1, refused: false },
  // Already paid out: nothing is changed, nothing is refunded; a person takes the payout back from the queue first.
  released: { payout: "released", item: "open", refunds: 0, reversals: 0, refused: true },
};

/** A captured booking of one creator page and one network page, with the creator's payout where `state` says and an OPEN offer. */
async function worldAt(state: PayoutState, flow: Flow) {
  // `planned` and `transfer_requested` are what a capture leaves when the kick has not run (or is mid-flight): capture with it off.
  if (state === "planned" || state === "transfer_requested") vi.stubEnv("CREATOR_PAYOUT_CRON_ENABLED", "0");
  const w = await paid({ pages: [{}], network: [100_000] });
  vi.stubEnv("CREATOR_PAYOUT_CRON_ENABLED", "");
  const c = w.creators[0];
  if (state === "transfer_requested") await setPayout(c.id, { status: "transfer_requested", transferRequestedAt: new Date() });
  if (state === "released") await setPayout(c.id, { status: "released", releasedAt: new Date() });
  const offer = await openOffer(w, c.id, { status: flow === "decline" || flow === "expire" ? "offered" : "accepted", ...(flow === "expire" ? { expiresAt: new Date(Date.now() - MIN) } : {}) });
  return { w, c, offer };
}

/** Run one way of ending the post. Resolves to the HTTP status for the routes, or the thrown error's status for the services. */
async function endThePost(flow: Flow, w: World, c: World["creators"][number], offerId: string): Promise<{ status: number; code?: string }> {
  const later = new Date(Date.now() + 10 * MIN);
  switch (flow) {
    case "refundItem": {
      const r = await staffPost(`${w.booking.id}/items/${c.id}/refund`);
      return { status: r.status, code: r.body?.error?.code };
    }
    case "withdraw": {
      const r = await staffPost(`${w.booking.id}/items/${c.id}/withdraw-offer`);
      return { status: r.status, code: r.body?.error?.code };
    }
    case "decline": {
      const r = await creatorPost(c.creatorId!, `/creator/offers/${offerId}/decline`, {});
      await settleCreatorRefundsForTests(); // a decline settles its refund in the background
      return { status: r.status, code: r.body?.error?.code };
    }
    case "expire":
    case "missed_window": {
      try {
        if (flow === "expire") await expireOffer(offerId, later);
        else await withdrawOffer(offerId, { closedReason: "missed_window" });
      } catch (e) {
        return { status: (e as { statusCode?: number }).statusCode ?? 500, code: (e as { code?: string }).code };
      }
      // The clock-driven endings never talk to Razorpay for the refund: job 10 of the payout worker does, a little later.
      await runRefundDueJob({ now: later });
      return { status: 200 };
    }
  }
}

describe("reverse BEFORE refund: every way a creator's post can end, whichever state its payout is in", () => {
  for (const flow of FLOWS) {
    for (const state of STATES) {
      const want = EXPECT[state];
      it(`${flow} with the payout ${state}: ${want.refused ? "refused, nothing changes" : `payout ${want.payout}, ${want.refunds} refund, ${want.reversals} reversal`}`, async () => {
        const { w, c, offer } = await worldAt(state, flow);
        const before = fake.calls.length;
        const out = await endThePost(flow, w, c, offer.id);
        const log = callLog(fake).slice(before);

        if (want.refused) {
          expect(out.status).toBe(409);
          expect(out.code).toMatch(/^(PAYOUT_PAID_OUT|OFFER_UNAVAILABLE)$/);
        } else {
          expect(out.status).toBe(200);
        }
        expect((await payoutOf(c.id)).status).toBe(want.payout);
        expect(countOf(log, "refund.create")).toBe(want.refunds);
        expect(countOf(log, "reversal.create")).toBe(want.reversals);
        expect(countOf(log, "transfer.create")).toBe(0); // a post that ends never makes a transfer
        expect(fakeRefunds(fake, w).filter((r) => r.amount === c.price)).toHaveLength(want.refunds);
        const item = await itemOf(c.id);
        if (want.item === "open") expect(["awaiting_creator", "manual_pending"]).toContain(item.status);
        else expect(item.status).toBe(want.item);
        // The offer: closed whenever the post ended, still open when the whole thing was refused.
        expect((await offerOf(c.id)).status).toBe(want.refused ? (flow === "decline" || flow === "expire" ? "offered" : "accepted") : flow === "decline" ? "declined" : flow === "expire" ? "expired" : "withdrawn");
        if (want.reversals === 1) {
          // THE rule: the reversal was made, and answered, before the refund was asked for.
          expect(firstIndex(log, "reversal.create")).toBeGreaterThanOrEqual(0);
          expect(firstIndex(log, "reversal.create")).toBeLessThan(firstIndex(log, "refund.create"));
          const transferId = (await payoutOf(c.id)).razorpayTransferId;
          const t = [...fake.transfers.values()].find((x) => x.id === transferId)!;
          expect(t.amountReversed).toBe(t.amount); // the whole share, as an explicit amount
        }
        // The network item of the same booking is never touched by any of this.
        expect((await itemOf(w.networkItems[0].id)).status).toBe("pending");
        // paidAt is the webhook's alone.
        expect((await bookingOf(w.booking.id)).paidAt).not.toBeNull();
      });
    }
  }

  it("an unknown answer to the reversal is never read as success: the post stays refund_due, nothing is refunded, and the next worker pass settles it", async () => {
    const { w, c, offer } = await worldAt("held", "withdraw");
    // The reversal is APPLIED at Razorpay but its answer is lost.
    fake.intercept({ match: is.createReversal, mode: "lose", times: 1 });
    const before = fake.calls.length;
    const r = await staffPost(`${w.booking.id}/items/${c.id}/withdraw-offer`);
    expect(r.status).toBe(200);
    expect(r.body.data.withdrawNotice).toMatch(/still being taken back|Razorpay has not confirmed/);
    const log = callLog(fake).slice(before);
    expect(countOf(log, "refund.create")).toBe(0);
    expect((await itemOf(c.id)).status).toBe("refund_due");
    expect(["reversal_requested", "held"]).toContain((await payoutOf(c.id)).status);
    expect((await offerOf(c.id)).status).toBe("withdrawn");
    // The worker READS what happened (it never guesses and never reverses twice): the reversal is confirmed, then the brand is refunded.
    const later = new Date(Date.now() + 10 * MIN);
    await runCreatorPayoutsTick({ now: later });
    await runRefundDueJob({ now: later });
    expect((await payoutOf(c.id)).status).toBe("reversed");
    expect((await itemOf(c.id)).status).toBe("refunded");
    const all = callLog(fake);
    expect(countOf(all, "refund.create")).toBe(1);
    expect(countOf(all, "reversal.create")).toBe(1); // asked once; the answer was read, not asked for again
    expect(firstIndex(all, "reversal.create")).toBeLessThan(firstIndex(all, "refund.create"));
    void offer;
  });

  it("a reversal Razorpay REFUSES is never read as success: no refund, the post stays refund_due, staff are told, nothing is lost", async () => {
    const { w, c } = await worldAt("held", "refundItem");
    fake.intercept({ match: is.createReversal, mode: "reject", status: 400, times: 99 });
    const r = await staffPost(`${w.booking.id}/items/${c.id}/refund`);
    expect([200, 409, 502]).toContain(r.status);
    expect(countOf(callLog(fake), "refund.create")).toBe(0);
    expect((await itemOf(c.id)).status).toBe("refund_due");
    expect(["held", "needs_attention", "reversal_requested"]).toContain((await payoutOf(c.id)).status);
    expect(await prisma.campaignRefund.count()).toBe(0);
    expect(fakeRefunds(fake, w)).toHaveLength(0);
  });
});

// ── Reject: a sequence that can be run again ──────────────────────────────────────────

describe("reject (a campaign with creator posts)", () => {
  const reject = (w: World) => staffPost(`${w.booking.id}/reject`, { note: "Not suitable" });

  it("planned payouts are voided and held ones are reversed, ALL before any refund; then every item is refunded per item and the campaign is refunded", async () => {
    const w = await paid({ pages: [{}, { price: 300_000, shareBps: 5000 }], network: [100_000] });
    const [a, b] = w.creators;
    expect((await payoutOf(a.id)).status).toBe("held");
    expect((await payoutOf(b.id)).status).toBe("held");
    const before = fake.calls.length;
    const res = await reject(w);
    expect(res.status).toBe(200);
    expect(res.body.data.rejectPending).toBeUndefined();
    const log = callLog(fake).slice(before);
    expect(countOf(log, "reversal.create")).toBe(2);
    expect(countOf(log, "refund.create")).toBe(3);
    // Every reversal was made and answered before the first refund.
    expect(log.lastIndexOf("reversal.create")).toBeLessThan(firstIndex(log, "refund.create"));
    for (const c of [a, b]) expect((await payoutOf(c.id)).status).toBe("reversed");
    for (const i of w.items) expect((await itemOf(i.id)).status).toBe("refunded");
    expect((await bookingOf(w.booking.id)).status).toBe("refunded");
    expect(fakeRefunds(fake, w).map((r) => r.amount).sort((x, y) => x - y)).toEqual([100_000, 250_000, 300_000]);
    // Rejecting again is refused and moves nothing more.
    expect((await reject(w)).status).toBe(409);
    expect(countOf(callLog(fake), "refund.create")).toBe(3);
    expect(countOf(callLog(fake), "reversal.create")).toBe(2);
  });

  it("a planned payout is voided with no Razorpay write at all for it", async () => {
    vi.stubEnv("CREATOR_PAYOUT_CRON_ENABLED", "0");
    const w = await paid({ pages: [{}] });
    vi.stubEnv("CREATOR_PAYOUT_CRON_ENABLED", "");
    const before = fake.calls.length;
    expect((await reject(w)).status).toBe(200);
    const log = callLog(fake).slice(before);
    expect(countOf(log, "reversal.create")).toBe(0);
    expect(countOf(log, "transfer.create")).toBe(0);
    expect(countOf(log, "refund.create")).toBe(1);
    expect(await payoutOf(w.creators[0].id)).toMatchObject({ status: "void", voidReason: "booking_rejected" });
    expect((await bookingOf(w.booking.id)).status).toBe("refunded");
  });

  it("⚠️ one share already paid out refuses the WHOLE rejection: nothing reversed, nothing refunded, the campaign and every item as they were", async () => {
    const w = await paid({ pages: [{}, {}], network: [100_000] });
    await setPayout(w.creators[1].id, { status: "released", releasedAt: new Date() });
    const before = fake.calls.length;
    const res = await reject(w);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PAYOUT_PAID_OUT");
    const log = callLog(fake).slice(before);
    expect(countOf(log, "reversal.create")).toBe(0);
    expect(countOf(log, "refund.create")).toBe(0);
    expect((await payoutOf(w.creators[0].id)).status).toBe("held");
    expect((await bookingOf(w.booking.id)).status).toBe("paid_pending_review");
    for (const i of w.items) expect((await itemOf(i.id)).status).toBe("pending");
  });

  it("⚠️ a failure half-way is a re-runnable sequence: the first reject takes back what it can and says it is not finished; the second finishes it without refunding anything twice or reversing a share twice", async () => {
    const w = await paid({ pages: [{}, {}], network: [100_000] });
    const [a, b] = w.creators;
    // The second reversal is refused by Razorpay (the first goes through).
    fake.intercept({ match: is.createReversal, mode: "reject", status: 400, skip: 1, times: 1 });
    const first = await reject(w);
    expect(first.status).toBe(200);
    expect(first.body.data.rejectPending).toBe(true);
    expect(String(first.body.data.refundNotice ?? first.body.data.rejectNotice ?? "")).toMatch(/not rejected yet|Press Reject again|can't be taken back/i);
    // Nothing was refunded and the campaign is NOT rejected: no half-refunded booking.
    expect(countOf(callLog(fake), "refund.create")).toBe(0);
    expect((await bookingOf(w.booking.id)).status).toBe("paid_pending_review");
    // Exactly one share was taken back (the order the two are tried in is not the point); the other is where it was.
    const states = [(await payoutOf(a.id)).status, (await payoutOf(b.id)).status].sort();
    expect(states).toEqual(["held", "reversed"]);
    // Both creator posts are claimed (refund due); the network post waits untouched.
    expect((await itemOf(a.id)).status).toBe("refund_due");
    expect((await itemOf(b.id)).status).toBe("refund_due");
    expect((await itemOf(w.networkItems[0].id)).status).toBe("pending");

    // Again, once Razorpay is well: the share already taken back is not reversed a second time, the other is, and everything is refunded once.
    const second = await reject(w);
    expect(second.status).toBe(200);
    expect(second.body.data.rejectPending).toBeUndefined();
    const log = callLog(fake);
    expect(countOf(log, "reversal.create")).toBe(3); // one share once; the other twice (the refused attempt, then the one that worked)
    expect(countOf(log, "refund.create")).toBe(3);
    expect((await bookingOf(w.booking.id)).status).toBe("refunded");
    for (const i of w.items) expect((await itemOf(i.id)).status).toBe("refunded");
    expect(fakeRefunds(fake, w)).toHaveLength(3);
    expect(fakeRefunds(fake, w).reduce((n, r) => n + r.amount, 0)).toBe(w.total);
  });

  it("a share whose transfer is still being made leaves the rejection pending (not rejected, nothing refunded); the worker, then Reject again, finish it", async () => {
    vi.stubEnv("CREATOR_PAYOUT_CRON_ENABLED", "0");
    const w = await paid({ pages: [{}], network: [100_000] });
    vi.stubEnv("CREATOR_PAYOUT_CRON_ENABLED", "");
    const c = w.creators[0];
    await setPayout(c.id, { status: "transfer_requested", transferRequestedAt: new Date() });
    const res = await reject(w);
    expect(res.status).toBe(200);
    expect(res.body.data.rejectPending).toBe(true);
    expect(countOf(callLog(fake), "refund.create")).toBe(0);
    expect((await bookingOf(w.booking.id)).status).toBe("paid_pending_review");
    expect((await itemOf(c.id)).status).toBe("refund_due");
  });
});

// ── No refund while a sibling's transfer can still be made [R4], and the reserved amount ──

describe("the refund waits for a sibling transfer [R4], and a creator's share is reserved", () => {
  it("⚠️ a refund of one post waits while another payout of the SAME payment is still planned: the share is taken back, nothing is refunded, and the worker refunds it once the sibling is held", async () => {
    vi.stubEnv("CREATOR_PAYOUT_CRON_ENABLED", "0");
    const w = await paid({ pages: [{}, {}] });
    const [a, b] = w.creators;
    // A's transfer was made; B's has not been (still planned).
    const pa = await payoutOf(a.id);
    const pb = await payoutOf(b.id);
    await executePlannedPayout(pa.id);
    expect((await payoutOf(a.id)).status).toBe("held");
    expect((await payoutOf(b.id)).status).toBe("planned");
    vi.stubEnv("CREATOR_PAYOUT_CRON_ENABLED", "");
    await openOffer(w, a.id, { status: "accepted" });

    const res = await staffPost(`${w.booking.id}/items/${a.id}/refund`);
    expect(res.status).toBe(200);
    // A's share was taken back (that is always safe) but the brand's money was NOT refunded while B's share could still become a transfer.
    expect((await payoutOf(a.id)).status).toBe("reversed");
    expect(countOf(callLog(fake), "refund.create")).toBe(0);
    expect((await itemOf(a.id)).status).toBe("refund_due");
    expect(await prisma.campaignRefund.count()).toBe(0);
    expect(String(res.body.data.refundNotice ?? "")).toMatch(/waiting|another creator|still being/i);

    // B's transfer is made (held): now the refund may go.
    await executePlannedPayout(pb.id);
    expect((await payoutOf(b.id)).status).toBe("held");
    const job = await runRefundDueJob({ now: new Date(Date.now() + 10 * MIN) });
    expect(job).toMatchObject({ refunded: 1 });
    expect((await itemOf(a.id)).status).toBe("refunded");
    expect(countOf(callLog(fake), "refund.create")).toBe(1);
    expect(countOf(callLog(fake), "reversal.create")).toBe(1); // A was reversed once, never again
    expect((await payoutOf(b.id)).status).toBe("held"); // B is untouched
  });

  it("the refund sweep also holds its fire while a payout of the payment can still become a transfer (no refund is started behind the transfer's back)", async () => {
    vi.stubEnv("CREATOR_PAYOUT_CRON_ENABLED", "0");
    const w = await paid({ pages: [{}], network: [100_000] });
    vi.stubEnv("CREATOR_PAYOUT_CRON_ENABLED", "");
    expect((await payoutOf(w.creators[0].id)).status).toBe("planned");
    // The network item is refunded: its money is not reserved, but R4 says no refund while a transfer is still to come.
    const res = await staffPost(`${w.booking.id}/items/${w.networkItems[0].id}/refund`);
    expect([200, 409]).toContain(res.status);
    expect(countOf(callLog(fake), "refund.create")).toBe(0);
    // The transfer is made; the same click now refunds.
    await executePlannedPayout((await payoutOf(w.creators[0].id)).id);
    const again = await staffPost(`${w.booking.id}/items/${w.networkItems[0].id}/refund`);
    expect(again.status).toBe(200);
    expect(countOf(callLog(fake), "refund.create")).toBe(1);
    expect(fakeRefunds(fake, w).map((r) => r.amount)).toEqual([100_000]);
  });

  it("reservedOn: a creator's whole item price is reserved until its payout is reversed or void; a network item can only be refunded from what is NOT reserved", async () => {
    const w = await paid({ pages: [{}, {}], network: [100_000] }); // 250k + 250k + 100k
    expect(await reservedPaiseForPayment(w.payId)).toBe(500_000);
    // A network post priced above what is left unreserved cannot be refunded out of a creator's money.
    await prisma.campaignBookingItem.update({ where: { id: w.networkItems[0].id }, data: { pricePaise: 200_000 } });
    const refused = await staffPost(`${w.booking.id}/items/${w.networkItems[0].id}/refund`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("NOTHING_TO_REFUND");
    expect(countOf(callLog(fake), "refund.create")).toBe(0);
    await prisma.campaignBookingItem.update({ where: { id: w.networkItems[0].id }, data: { pricePaise: 100_000 } });

    // Reversing one share frees its item price.
    await openOffer(w, w.creators[0].id, { status: "accepted" });
    expect((await staffPost(`${w.booking.id}/items/${w.creators[0].id}/withdraw-offer`)).status).toBe(200);
    expect((await payoutOf(w.creators[0].id)).status).toBe("reversed");
    expect(await reservedPaiseForPayment(w.payId)).toBe(250_000);
    // The unreserved part now covers the network item (and the refunded creator item): one refund each, all within what was captured.
    expect((await staffPost(`${w.booking.id}/items/${w.networkItems[0].id}/refund`)).status).toBe(200);
    expect(fakeRefunds(fake, w).map((r) => r.amount).sort((x, y) => x - y)).toEqual([100_000, 250_000]);
    // Whatever was refunded, the other creator's share stays reserved: the brand can never be refunded out of money owed to a creator.
    expect(await reservedPaiseForPayment(w.payId)).toBe(250_000);
    const refunded = fakeRefunds(fake, w).reduce((n, r) => n + r.amount, 0);
    expect(w.total - refunded).toBeGreaterThanOrEqual(250_000);
  });
});

// ── Verify → release_after → the worker releases only when the gate passes ────────────

describe("verification schedules the release; the worker releases only when the gate passes", () => {
  /** A captured, held booking of one creator page whose post staff have verified. */
  async function verified(o: { ownership?: string; verifiedAt?: Date } = {}) {
    const w = await paid({ pages: [{}] });
    const c = w.creators[0];
    const verifiedAt = o.verifiedAt ?? new Date();
    await verifiedOffer(w, c.id, { ownership: o.ownership ?? "auto_ok", verifiedAt });
    return { w, c, verifiedAt };
  }
  const holdLifted = () => fake.count((c) => is.setHold(c, false));
  const actor = () => ({ type: "staff" as const, id: staff.staffId });

  it("release_after = verified_at + the hold days (at least a day when ownership was checked by hand); only the FIRST scheduling counts", async () => {
    vi.stubEnv("CREATOR_PAYOUT_HOLD_DAYS", "2");
    const auto = await verified({ ownership: "auto_ok" });
    await onCreatorLinkVerified(auto.c.id, actor());
    const p = await payoutOf(auto.c.id);
    expect(p.releaseAfter!.getTime()).toBe(auto.verifiedAt.getTime() + 2 * DAY);
    // A second call (a re-verify, a retry) does not move it.
    await prisma.creatorOffer.update({ where: { bookingItemId: auto.c.id }, data: { linkVerifiedAt: new Date(auto.verifiedAt.getTime() + 5 * HOUR) } });
    await onCreatorLinkVerified(auto.c.id, actor());
    expect((await payoutOf(auto.c.id)).releaseAfter!.getTime()).toBe(auto.verifiedAt.getTime() + 2 * DAY);
    expect(await prisma.creatorPayoutEvent.count({ where: { payoutId: p.id, kind: "schedule" } })).toBe(1);

    // With no extra hold days the hand-checked one still waits a day; an automatic one is due at once.
    vi.stubEnv("CREATOR_PAYOUT_HOLD_DAYS", "");
    const manual = await verified({ ownership: "manual_ok" });
    await onCreatorLinkVerified(manual.c.id, actor());
    expect((await payoutOf(manual.c.id)).releaseAfter!.getTime()).toBe(manual.verifiedAt.getTime() + DAY);
    const fast = await verified({ ownership: "auto_ok" });
    await onCreatorLinkVerified(fast.c.id, actor());
    expect((await payoutOf(fast.c.id)).releaseAfter!.getTime()).toBe(fast.verifiedAt.getTime());
    expect(holdLifted()).toBe(0); // scheduling releases nothing
  });

  it("the worker releases it only once it is due: before release_after no hold is lifted, after it the transfer is released", async () => {
    vi.stubEnv("CREATOR_PAYOUT_HOLD_DAYS", "2");
    const { c, verifiedAt } = await verified();
    await onCreatorLinkVerified(c.id, actor());
    const due = new Date(verifiedAt.getTime() + 2 * DAY);

    await runCreatorPayoutsTick({ now: new Date(due.getTime() - HOUR) });
    expect(holdLifted()).toBe(0);
    expect((await payoutOf(c.id)).status).toBe("held");

    const tick = await runCreatorPayoutsTick({ now: new Date(due.getTime() + MIN) });
    expect(tick.jobs.release).toBe(1);
    expect(holdLifted()).toBe(1);
    expect(await payoutOf(c.id)).toMatchObject({ status: "released" });
    expect((await payoutOf(c.id)).releasedAt).not.toBeNull();
    const t = fake.transfers.get((await payoutOf(c.id)).razorpayTransferId!)!;
    expect(t.onHold).toBe(false);
    // A second tick does not release it twice.
    await runCreatorPayoutsTick({ now: new Date(due.getTime() + 2 * MIN) });
    expect(holdLifted()).toBe(1);
    // And what was released can no longer be refunded around: the refund seams refuse it.
    const item = await itemOf(c.id);
    expect(["posted_manual", "published"]).toContain(item.status);
  });

  async function dueNow(o: { ownership?: string } = {}) {
    const x = await verified(o);
    await onCreatorLinkVerified(x.c.id, actor());
    return { ...x, now: new Date(x.verifiedAt.getTime() + 3 * DAY) };
  }

  it("⚠️ the runtime switch pauses every release (system_settings creatorPayouts.release = off) and resumes when it is cleared", async () => {
    const { c, now } = await dueNow();
    await prisma.systemSetting.upsert({ where: { key: RELEASE_SWITCH_KEY }, create: { key: RELEASE_SWITCH_KEY, value: "off" }, update: { value: "off" } });
    await runCreatorPayoutsTick({ now });
    expect(holdLifted()).toBe(0);
    expect((await payoutOf(c.id)).status).toBe("held");
    await prisma.systemSetting.delete({ where: { key: RELEASE_SWITCH_KEY } });
    await runCreatorPayoutsTick({ now: new Date(now.getTime() + 10 * MIN) });
    expect(holdLifted()).toBe(1);
    expect((await payoutOf(c.id)).status).toBe("released");
  });

  it("⚠️ the fresh dispute check FAILS CLOSED: a dispute at Razorpay, and a dispute list that cannot be read, each release nothing", async () => {
    const { w, c, now } = await dueNow();
    // 1. A dispute on the payment, asked of Razorpay fresh.
    const dispute = fake.addDispute({ paymentId: w.payId });
    await runCreatorPayoutsTick({ now });
    expect(holdLifted()).toBe(0);
    expect((await payoutOf(c.id)).status).toBe("held");
    // 2. The dispute list cannot be read: unknown is never "clear".
    fake.disputes.splice(fake.disputes.indexOf(dispute), 1);
    fake.intercept({ match: is.listDisputes, mode: "reject", status: 500, times: 99 });
    await runCreatorPayoutsTick({ now: new Date(now.getTime() + 20 * MIN) });
    expect(holdLifted()).toBe(0);
    expect((await payoutOf(c.id)).status).toBe("held");
  });

  it("⚠️ a pending bank change blocks the release with no Razorpay write at all", async () => {
    const { w, c, now } = await dueNow();
    await prisma.creatorPayoutAccount.updateMany({ where: { creatorId: w.creators[0].creatorId! }, data: { bankChangeRequestedAt: new Date() } });
    const mark = fake.calls.length;
    await runCreatorPayoutsTick({ now });
    expect(holdLifted()).toBe(0);
    expect(fake.calls.slice(mark).filter(is.v1Write)).toHaveLength(0);
    expect((await payoutOf(c.id)).status).toBe("held");
  });

  it("an unverified post, a payout staff paused and a refunded item are never released, however long they have waited", async () => {
    // Not verified (the offer is only accepted).
    const w = await paid({ pages: [{}, {}, {}] });
    const [unverified, paused, refunded] = w.creators;
    await openOffer(w, unverified.id, { status: "accepted" });
    await verifiedOffer(w, paused.id);
    await onCreatorLinkVerified(paused.id, actor());
    await setPayout(paused.id, { pausedAt: new Date() });
    await verifiedOffer(w, refunded.id);
    await onCreatorLinkVerified(refunded.id, actor());
    await prisma.campaignBookingItem.update({ where: { id: refunded.id }, data: { status: "refund_due" } });
    await runCreatorPayoutsTick({ now: new Date(Date.now() + 10 * DAY) });
    expect(holdLifted()).toBe(0);
    for (const c of [unverified, paused]) expect((await payoutOf(c.id)).status).toBe("held");
  });
});

// ── paidAt: only the payment webhook says a brand paid ────────────────────────────────

describe("paidAt is never written by the money leg", () => {
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");
  const root = join(__dirname, "..", "src");

  it("no payout, refund, staff-queue or worker source mentions paidAt in code (comments aside)", () => {
    for (const f of ["services/creator/payout.service.ts", "services/creator/payout-policy.ts", "services/creator/payout-ledger.ts", "services/creator/creator-refund.service.ts", "services/creator/payout-staff.service.ts", "cron/creator-payouts.cron.ts"]) {
      expect(strip(readFileSync(join(root, f), "utf8")), f).not.toMatch(/\bpaidAt\b|paid_at/);
    }
  });

  it("a whole life (capture, verify, release, a reversal and a refund of the other post) leaves the booking's paidAt exactly what the webhook set", async () => {
    const w = await paid({ pages: [{}, {}] });
    const paidAt = (await bookingOf(w.booking.id)).paidAt;
    expect(paidAt).not.toBeNull();
    const [a, b] = w.creators;
    await verifiedOffer(w, a.id);
    await onCreatorLinkVerified(a.id, { type: "staff", id: staff.staffId });
    await runCreatorPayoutsTick({ now: new Date(Date.now() + DAY) });
    expect((await payoutOf(a.id)).status).toBe("released");
    await openOffer(w, b.id, { status: "accepted" });
    await prisma.campaignBooking.update({ where: { id: w.booking.id }, data: { status: "approved" } });
    expect((await staffPost(`${w.booking.id}/items/${b.id}/withdraw-offer`)).status).toBe(200);
    expect((await payoutOf(b.id)).status).toBe("reversed");
    expect((await bookingOf(w.booking.id)).paidAt!.getTime()).toBe(paidAt!.getTime());
  });
});
