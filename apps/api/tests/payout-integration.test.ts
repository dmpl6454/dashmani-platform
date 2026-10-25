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
import { randomUUID } from "node:crypto";
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
import { clearPayoutAlertMarkersForTests, flushPayoutAlertsForTests, resetPayoutAlertsForTests } from "../src/services/creator/payout-alert";
import { settlePayoutKicksForTests } from "../src/services/campaign/payment.service";
import { expireOffer, withdrawOffer } from "../src/services/creator/creator-offer.service";
import { onCreatorLinkVerified, payoutRefundGuard } from "../src/services/creator/payout-ledger";
import { RELEASE_SWITCH_KEY, executePlannedPayout, reservedPaiseForPayment } from "../src/services/creator/payout.service";
import { runRefundDueJob, settleCreatorRefundsForTests } from "../src/services/creator/creator-refund.service";
import { findStuckPayouts, resetCreatorPayoutsCronForTests, runCreatorPayoutsTick } from "../src/cron/creator-payouts.cron";
import { FakeRazorpay, is, type FakeCall } from "./fake-razorpay-route";
import { generateCreatorToken } from "./helpers";
import { payoutHint, pausedChip } from "@dashmani/shared/src/payouts/staff-ui";
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
  await clearPayoutAlertMarkersForTests();
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
  await clearPayoutAlertMarkersForTests();
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


// ── A refund Razorpay refused is never re-sent blindly ────────────────────────────────

const later = (minutes: number) => new Date(Date.now() + minutes * MIN);
const refundCalls = () => countOf(callLog(fake), "refund.create");
const mails = () => vi.mocked(notifyAdminByEmail).mock.calls.map((c) => String(c[0]));
const listRefunds = (c: FakeCall) => c.method === "GET" && /^\/v1\/payments\/[^/]+\/refunds$/.test(c.path);

describe("⚠️ job 10 never re-sends a refund Razorpay refused blindly: a backoff, a cap, a read of the payment's refunds first, and a stand-down", () => {
  /** A booking of two creator pages and one network page; staff withdraw the first creator's accepted offer while Razorpay refuses the client's refund `times` times. */
  async function refusedOnce(refusals = 1) {
    const w = await paid({ pages: [{}, {}], network: [250_000] });
    const a = w.creators[0];
    await openOffer(w, a.id, { status: "accepted" });
    fake.intercept({ match: is.refund, mode: "reject", status: 400, times: refusals });
    const r = await staffPost(`${w.booking.id}/items/${a.id}/withdraw-offer`);
    expect(r.status).toBe(200);
    expect((await itemOf(a.id)).status).toBe("refund_due"); // the creator's share is taken back, the client is owed, Razorpay said no
    expect((await payoutOf(a.id)).status).toBe("reversed");
    expect(refundCalls()).toBe(1);
    expect(await prisma.campaignRefund.count({ where: { bookingItemId: a.id, status: "failed" } })).toBe(1);
    return { w, a };
  }

  it("a refund staff made in the Razorpay dashboard after the refusal stands the automatic path down: NO second refund, the post says why, one email, and it is parked", async () => {
    const { w, a } = await refusedOnce();
    // The dashboard refund of this post's price: the ledger cannot say which post it was for, and the payment still has room for another one.
    fake.payments.get(w.payId)!.refunds.push({ id: "rfnd_dashboard01", amount: a.price, status: "processed" });
    const r1 = await runRefundDueJob({ now: later(10) });
    expect(r1).toMatchObject({ checked: 1, blocked: 1, refunded: 0 });
    expect(refundCalls()).toBe(1); // still only the refused one: the client is not repaid twice out of the other posts' share
    const item = await itemOf(a.id);
    expect(item.status).toBe("refund_due");
    expect(item.lastError).toMatch(/refund we did not issue/);
    expect(item.nextAttemptAt).not.toBeNull();
    expect(item.attempts).toBeGreaterThanOrEqual(12);
    expect(await prisma.campaignRefund.count({ where: { paymentId: (await prisma.campaignPayment.findFirstOrThrow({ where: { bookingId: w.booking.id } })).id, origin: "external" } })).toBe(1);
    await flushPayoutAlertsForTests();
    expect(mails().filter((m) => /refund was not re-sent/.test(m))).toHaveLength(1);
    // Parked: the next passes neither look at it nor read Razorpay, and nothing more is mailed.
    const mark = fake.calls.length;
    for (const m of [20, 30, 40]) expect((await runRefundDueJob({ now: later(m) })).checked).toBe(0);
    expect(fake.calls.length).toBe(mark);
    await flushPayoutAlertsForTests();
    expect(mails().filter((m) => /refund was not re-sent/.test(m))).toHaveLength(1);
    // The daily digest still names it (attempts is pinned at the stuck mark).
    expect((await findStuckPayouts(later(60))).map((f) => f.key)).toContain("refund_due");
  });

  it("a refund refused again and again is retried with a backoff at most five times; then a person is told ONCE and nothing more is sent or read", async () => {
    const { a } = await refusedOnce(99);
    // Too soon: three minutes after the refusal the post is old enough for the job but the backoff has not run out. No request.
    const mark = fake.calls.length;
    expect(await runRefundDueJob({ now: later(3) })).toMatchObject({ checked: 1, waiting: 1 });
    expect(fake.calls.length).toBe(mark);
    // Spaced out, it is tried again until the fifth refusal.
    for (let i = 1; i <= 4; i++) {
      expect((await runRefundDueJob({ now: later(70 * i) })).checked).toBe(1);
      expect(refundCalls()).toBe(1 + i);
    }
    expect(await prisma.campaignRefund.count({ where: { bookingItemId: a.id, status: "failed" } })).toBe(5);
    // The sixth: capped. Nothing is sent.
    expect(await runRefundDueJob({ now: later(70 * 5) })).toMatchObject({ checked: 1, blocked: 1 });
    expect(refundCalls()).toBe(5);
    const item = await itemOf(a.id);
    expect(item.status).toBe("refund_due");
    expect(item.lastError).toMatch(/refused it several times/);
    expect(item.nextAttemptAt).not.toBeNull();
    await flushPayoutAlertsForTests();
    expect(mails().filter((m) => /needs a manual refund/.test(m))).toHaveLength(1);
    // And from then on it costs nothing: not selected, no read, no mail.
    const after = fake.calls.length;
    for (let i = 6; i <= 9; i++) expect((await runRefundDueJob({ now: later(70 * i) })).checked).toBe(0);
    expect(fake.calls.length).toBe(after);
    await flushPayoutAlertsForTests();
    expect(mails().filter((m) => /needs a manual refund/.test(m))).toHaveLength(1);
  });

  it("the payment's refund list is READ before every re-send; if it cannot be read nothing is sent, and the next pass goes on", async () => {
    const { a } = await refusedOnce();
    fake.intercept({ match: listRefunds, mode: "reject", status: 500, times: 1 });
    const r1 = await runRefundDueJob({ now: later(10) });
    expect(r1).toMatchObject({ checked: 1, waiting: 1, refunded: 0 });
    expect(refundCalls()).toBe(1);
    expect((await itemOf(a.id)).nextAttemptAt).toBeNull(); // an unreadable list is not a stand-down
    const r2 = await runRefundDueJob({ now: later(20) });
    expect(r2).toMatchObject({ checked: 1, refunded: 1 });
    expect(refundCalls()).toBe(2);
    expect((await itemOf(a.id)).status).toBe("refunded");
    expect(await prisma.campaignRefund.count({ where: { bookingItemId: a.id, idempotencyKey: `rf-item-${a.id}-r2` } })).toBe(1);
  });

  it("the staff Refund click is the deliberate override: it sends even when the automatic path stood down", async () => {
    const { w, a } = await refusedOnce(5);
    for (let i = 1; i <= 5; i++) await runRefundDueJob({ now: later(70 * i) });
    expect(refundCalls()).toBe(5);
    expect((await itemOf(a.id)).nextAttemptAt).not.toBeNull();
    // Razorpay accepts again (the intercept has used its five refusals); a person presses Refund.
    const r = await staffPost(`${w.booking.id}/items/${a.id}/refund`);
    expect(r.status).toBe(200);
    expect(refundCalls()).toBe(6);
    expect((await itemOf(a.id)).status).toBe("refunded");
  });
});

describe("⚠️ 'Mark refunded': the way out when the client was repaid outside the portal", () => {
  /** One creator page; staff withdraw its offer while Razorpay refuses the refund, and the dashboard repays the client: the refund is stuck for ever without it. */
  async function repaidElsewhere() {
    const w = await paid({ pages: [{}] });
    const a = w.creators[0];
    await openOffer(w, a.id, { status: "accepted" });
    fake.intercept({ match: is.refund, mode: "reject", status: 400, times: 1 });
    expect((await staffPost(`${w.booking.id}/items/${a.id}/withdraw-offer`)).status).toBe(200);
    fake.payments.get(w.payId)!.refunds.push({ id: "rfnd_dashboard77", amount: a.price, status: "processed" });
    const job = await runRefundDueJob({ now: later(10) });
    expect(job).toMatchObject({ blocked: 1 });
    return { w, a };
  }
  const mark = (w: World, itemId: string, body: object = {}) => staffPost(`${w.booking.id}/items/${itemId}/mark-refunded`, body);

  it("records THAT refund against the post, marks it refunded and moves the booking on, with a history line and without sending another refund", async () => {
    const { w, a } = await repaidElsewhere();
    const before = refundCalls();
    const r = await mark(w, a.id);
    expect(r.status).toBe(200);
    expect(refundCalls()).toBe(before); // nothing is refunded again
    expect((await itemOf(a.id)).status).toBe("refunded");
    const ledger = await prisma.campaignRefund.findFirstOrThrow({ where: { razorpayRefundId: "rfnd_dashboard77" } });
    expect(ledger).toMatchObject({ origin: "external", bookingItemId: a.id });
    const events = await prisma.campaignBookingEvent.findMany({ where: { bookingId: w.booking.id }, orderBy: { createdAt: "asc" } });
    expect(events.some((e) => e.actorType === "staff" && /marked refunded by hand.*rfnd_dashboard77/.test(e.note ?? ""))).toBe(true);
    // Done is done: a second press is a plain refusal, and the refund is attributed to this post only.
    const again = await mark(w, a.id);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("ALREADY_REFUNDED");
  });

  it("refuses, changing nothing, when Razorpay lists no such refund, when the refund id is not one of the payment's, or when the creator's payout is not taken back", async () => {
    const w = await paid({ pages: [{}] });
    const a = w.creators[0];
    await openOffer(w, a.id, { status: "accepted" });
    fake.intercept({ match: is.refund, mode: "reject", status: 400, times: 1 });
    expect((await staffPost(`${w.booking.id}/items/${a.id}/withdraw-offer`)).status).toBe(200);
    // No refund exists anywhere but our refused attempt.
    const none = await mark(w, a.id);
    expect(none.status).toBe(409);
    expect(none.body.error.code).toBe("NO_EXTERNAL_REFUND");
    // A refund that exists but is smaller than the post's price does not count either.
    fake.payments.get(w.payId)!.refunds.push({ id: "rfnd_small0001", amount: a.price - 1, status: "processed" });
    expect((await mark(w, a.id)).body.error.code).toBe("NO_EXTERNAL_REFUND");
    fake.payments.get(w.payId)!.refunds.push({ id: "rfnd_enough0001", amount: a.price, status: "processed" });
    expect((await mark(w, a.id, { refundId: "rfnd_nothere99" })).body.error.code).toBe("NO_EXTERNAL_REFUND");
    expect((await itemOf(a.id)).status).toBe("refund_due");
    expect(await prisma.campaignRefund.count({ where: { bookingItemId: a.id, origin: "external" } })).toBe(0);
    // The payout must already be out of the way: this never decides anything about the creator's money.
    await setPayout(a.id, { status: "held" });
    const held = await mark(w, a.id);
    expect(held.status).toBe(409);
    expect(held.body.error.code).toBe("PAYOUT_NOT_TAKEN_BACK");
    expect((await itemOf(a.id)).status).toBe("refund_due");
    // Taken back: now the exact refund is accepted.
    await setPayout(a.id, { status: "reversed" });
    expect((await mark(w, a.id)).status).toBe(200);
    expect(await prisma.campaignRefund.findFirstOrThrow({ where: { razorpayRefundId: "rfnd_enough0001" } })).toMatchObject({ bookingItemId: a.id });
  });

  it("with two refunds that could be this post's the staff member names the one; one refund can only ever be recorded against ONE post", async () => {
    const w = await paid({ pages: [{}, {}] });
    const [a, b] = w.creators;
    for (const c of [a, b]) {
      await openOffer(w, c.id, { status: "accepted" });
      fake.intercept({ match: is.refund, mode: "reject", status: 400, times: 1 });
      expect((await staffPost(`${w.booking.id}/items/${c.id}/withdraw-offer`)).status).toBe(200);
    }
    fake.payments.get(w.payId)!.refunds.push({ id: "rfnd_dash_a0001", amount: a.price, status: "processed" }, { id: "rfnd_dash_b0001", amount: b.price, status: "processed" });
    const ambiguous = await mark(w, a.id);
    expect(ambiguous.status).toBe(409);
    expect(ambiguous.body.error.code).toBe("AMBIGUOUS_REFUND");
    expect(ambiguous.body.error.message).toContain("rfnd_dash_a0001");
    expect((await mark(w, a.id, { refundId: "rfnd_dash_a0001" })).status).toBe(200);
    // A's refund cannot be reused for B: naming it again finds nothing unattributed.
    const reuse = await mark(w, b.id, { refundId: "rfnd_dash_a0001" });
    expect(reuse.status).toBe(409);
    expect(reuse.body.error.code).toBe("NO_EXTERNAL_REFUND");
    expect((await mark(w, b.id, { refundId: "rfnd_dash_b0001" })).status).toBe(200);
    expect((await itemOf(a.id)).status).toBe("refunded");
    expect((await itemOf(b.id)).status).toBe("refunded");
  });
});

// ── A post becomes `refunded` only once its refund is on the ledger ─────────────────

/** Block a kind of write for the duration of `work`, the way a failing database would. Every statement of the trigger is dropped afterwards. */
async function withBlockedWrites(blocks: Array<{ table: string; op: "INSERT" | "UPDATE"; when: string }>, work: () => Promise<void>) {
  await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION p4_ops_block() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'blocked by the test'; END; $$ LANGUAGE plpgsql`);
  try {
    for (const [i, b] of blocks.entries()) {
      await prisma.$executeRawUnsafe(`CREATE TRIGGER p4_ops_block_${i} BEFORE ${b.op} ON ${b.table} FOR EACH ROW WHEN (${b.when}) EXECUTE FUNCTION p4_ops_block()`);
    }
    await work();
  } finally {
    for (const [i, b] of blocks.entries()) await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS p4_ops_block_${i} ON ${b.table}`);
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS p4_ops_block()`);
  }
}

describe("⚠️ no post is ever `refunded` without a refund behind it: the post is marked LAST, after the ledger row exists", () => {
  it("a database error when the refund is claimed, EVEN WHEN the recovery update cannot run either, leaves the post refund_due (never refunded with no refund)", async () => {
    const w = await paid({ pages: [{}] });
    const a = w.creators[0];
    await openOffer(w, a.id, { status: "accepted" });
    await withBlockedWrites(
      [
        { table: "campaign_refunds", op: "INSERT", when: "true" }, // the claim (the ledger row) fails
        { table: "campaign_booking_items", op: "UPDATE", when: "OLD.status = 'refunded' AND NEW.status = 'refund_due'" }, // and so would any attempt to undo an early mark
      ],
      async () => {
        const r = await staffPost(`${w.booking.id}/items/${a.id}/withdraw-offer`);
        expect(r.status).toBe(200);
      },
    );
    expect((await itemOf(a.id)).status).toBe("refund_due");
    expect(await prisma.campaignRefund.count({ where: { bookingItemId: a.id } })).toBe(0);
    expect(refundCalls()).toBe(0);
    // Healthy again: the worker refunds it, once.
    expect(await runRefundDueJob({ now: later(10) })).toMatchObject({ refunded: 1 });
    expect((await itemOf(a.id)).status).toBe("refunded");
    expect(refundCalls()).toBe(1);
  });

  it("a failure to mark the post AFTER the ledger row exists loses nothing: the next pass finds the row, marks the post, and sends no second refund", async () => {
    const w = await paid({ pages: [{}] });
    const a = w.creators[0];
    await openOffer(w, a.id, { status: "accepted" });
    await withBlockedWrites([{ table: "campaign_booking_items", op: "UPDATE", when: "OLD.status = 'refund_due' AND NEW.status = 'refunded'" }], async () => {
      const r = await staffPost(`${w.booking.id}/items/${a.id}/withdraw-offer`);
      expect(r.status).toBe(200);
    });
    // The client WAS refunded (the row and the refund exist), but the post could not be marked yet.
    expect((await itemOf(a.id)).status).toBe("refund_due");
    expect(refundCalls()).toBe(1);
    expect(await prisma.campaignRefund.findFirstOrThrow({ where: { bookingItemId: a.id } })).toMatchObject({ status: "processed", idempotencyKey: `rf-item-${a.id}` });
    // The payment is now fully refunded: no payment "can cover" the post any more, which must not strand it.
    expect((await prisma.campaignPayment.findFirstOrThrow({ where: { bookingId: w.booking.id } })).status).toBe("refunded");
    const job = await runRefundDueJob({ now: later(10) });
    expect(job).toMatchObject({ checked: 1, refunded: 1 });
    expect((await itemOf(a.id)).status).toBe("refunded");
    expect(refundCalls()).toBe(1);
    expect(await prisma.campaignRefund.count({ where: { bookingItemId: a.id } })).toBe(1);
  });
});

// ── Verifying a creator's post must schedule its release even when what follows fails ──

describe("⚠️ verification schedules the release BEFORE anything that can throw", () => {
  it("a settle failure right after the verification committed (the staff member sees an error) still leaves the release scheduled; a retry of Verify is a 409, so nothing else could have", async () => {
    const w = await paid({ pages: [{}] });
    const a = w.creators[0];
    await openOffer(w, a.id, { status: "accepted", linkSubmitted: true });
    await prisma.creatorOffer.update({ where: { bookingItemId: a.id }, data: { ownershipCheck: "auto_ok" } });
    let status = 0;
    await withBlockedWrites([{ table: "campaign_bookings", op: "UPDATE", when: "NEW.status = 'completed'" }], async () => {
      const r = await staffPost(`${w.booking.id}/items/${a.id}/verify-creator-link`, { linkCanonicalKey: "ig:ABC123" });
      status = r.status;
    });
    expect(status).toBe(500); // the settle step failed ...
    expect((await itemOf(a.id)).status).toBe("posted_manual"); // ... after the verification had committed
    expect((await offerOf(a.id)).linkVerifiedAt).not.toBeNull();
    const p = await payoutOf(a.id);
    expect(p.releaseAfter).not.toBeNull(); // and the release was scheduled first
    expect(p.releaseAfter!.getTime()).toBe((await offerOf(a.id)).linkVerifiedAt!.getTime());
    const retry = await staffPost(`${w.booking.id}/items/${a.id}/verify-creator-link`, { linkCanonicalKey: "ig:ABC123" });
    expect(retry.status).toBe(409);
    expect(retry.body.error.code).toBe("ALREADY_VERIFIED");
  });
});

// ── A suspended creator is not paid ──────────────────────────────────────────────────

describe("⚠️ suspending a creator pauses their payouts (reinstating does not resume them)", () => {
  const admin = () => `Bearer ${staff.admin}`;

  it("pauses every payout of theirs that still has something in flight (reason creator_suspended, audited, one alert), leaves other creators and finished payouts alone, and a payout already paused keeps its first reason", async () => {
    const w = await paid({ pages: [{}, {}] });
    const [mine, other] = w.creators;
    const template = await payoutOf(mine.id);
    const extra = (data: Record<string, unknown>) =>
      prisma.creatorPayout.create({
        data: {
          bookingId: template.bookingId,
          bookingItemId: randomUUID(),
          creatorId: template.creatorId,
          payoutAccountId: template.payoutAccountId,
          razorpayAccountId: template.razorpayAccountId,
          razorpayPaymentId: template.razorpayPaymentId,
          itemPricePaise: 250_000,
          shareBps: 4000,
          grossPaise: 100_000,
          amountPaise: 100_000,
          ...data,
        } as never,
      });
    const settled = await extra({ status: "settled" });
    const disputed = await extra({ status: "held", pausedAt: new Date(Date.now() - HOUR), pausedReason: "dispute" });
    await verifiedOffer(w, mine.id);
    await onCreatorLinkVerified(mine.id, { type: "staff", id: staff.staffId });

    const res = await request(app).post(`/v1/admin/creators/${mine.creatorId}/suspend`).set("Authorization", admin()).send({ note: "Posts that are not theirs" });
    expect(res.status).toBe(200);
    const p = await payoutOf(mine.id);
    expect(p).toMatchObject({ status: "held", pausedReason: "creator_suspended" });
    expect(p.pausedAt).not.toBeNull();
    const ev = await prisma.creatorPayoutEvent.findFirstOrThrow({ where: { payoutId: p.id, kind: "pause" } });
    expect(ev).toMatchObject({ actorType: "staff", actorId: staff.staffId });
    expect(await prisma.creatorPayout.findUniqueOrThrow({ where: { id: disputed.id } })).toMatchObject({ pausedReason: "dispute" }); // the first reason is kept
    expect((await prisma.creatorPayout.findUniqueOrThrow({ where: { id: settled.id } })).pausedAt).toBeNull(); // finished: nothing to pause
    expect((await payoutOf(other.id)).pausedAt).toBeNull(); // another creator's payout, on the same campaign, is untouched
    await flushPayoutAlertsForTests();
    expect(mails().filter((m) => /paused because the creator was suspended/.test(m))).toHaveLength(1);
    // The due release does not go while the creator is suspended.
    await runCreatorPayoutsTick({ now: later(3 * 24 * 60) });
    expect(fake.count((c) => is.setHold(c, false))).toBe(0);
    expect((await payoutOf(mine.id)).status).toBe("held");

    // Reinstating the creator does NOT resume the payout: staff decide.
    expect((await request(app).post(`/v1/admin/creators/${mine.creatorId}/reinstate`).set("Authorization", admin()).send({})).status).toBe(200);
    expect(await payoutOf(mine.id)).toMatchObject({ pausedReason: "creator_suspended" });
    expect((await payoutOf(mine.id)).pausedAt).not.toBeNull();
    // ... and a person resumes it deliberately.
    const resume = await request(app).post(`/v1/admin/creator-payouts/${p.id}/resume`).set("Authorization", admin()).send({});
    expect(resume.status).toBe(200);
    expect((await payoutOf(mine.id)).pausedAt).toBeNull();
  });

  it("⚠️ r2 #R10: a payout already RELEASED when the creator is suspended is paused, but the pause stops nothing: the alert, the hint and the chip say so and point at Reverse", async () => {
    const w = await paid({ pages: [{}] });
    const c = w.creators[0];
    await verifiedOffer(w, c.id);
    await onCreatorLinkVerified(c.id, { type: "staff", id: staff.staffId });
    const pid = (await payoutOf(c.id)).id;
    expect((await request(app).post(`/v1/admin/creator-payouts/${pid}/release-now`).set("Authorization", admin()).send({})).status).toBe(200);
    expect((await payoutOf(c.id)).status).toBe("released");

    expect((await request(app).post(`/v1/admin/creators/${c.creatorId}/suspend`).set("Authorization", admin()).send({ note: "Posts that are not theirs" })).status).toBe(200);
    expect(await payoutOf(c.id)).toMatchObject({ status: "released", pausedReason: "creator_suspended" });

    // The alert counts it apart and tells staff to Reverse it; it never says nothing is paid out.
    await flushPayoutAlertsForTests();
    const calls = vi.mocked(notifyAdminByEmail).mock.calls.filter((m) => /suspended creator has 1 payout already released/.test(String(m[0])));
    expect(calls).toHaveLength(1);
    expect(String(calls[0][0])).toMatch(/pausing does not stop it, reverse it now/);
    const body = JSON.stringify(calls[0]);
    // (The email escapes apostrophes.)
    expect(body).toMatch(/Pausing does not stop Razorpay settling it to the creator(&#39;|')s bank/);
    expect(body).toMatch(/take it back with Reverse while the money is still in the creator(&#39;|')s linked account/);
    expect(body).toMatch(/Already released, still settling/);
    expect(body).not.toMatch(/Nothing is paid out to this creator/);

    // The queue row the staff page draws: it is in the Paused view, and its sentence and chip say the pause does not stop it.
    const q = await request(app).get("/v1/admin/creator-payouts?filter=paused").set("Authorization", admin());
    expect(q.status).toBe(200);
    const row = q.body.data.rows.find((r: { id: string }) => r.id === pid);
    expect(row).toBeTruthy();
    expect(payoutHint(row)).toMatch(/Pausing does not stop this: Razorpay settles it whatever the pause says/);
    expect(pausedChip(row)).toMatchObject({ holds: false, label: expect.stringMatching(/doesn't stop it/) });

    // And that is what happens: Razorpay settles it while it is paused, and the worker records the settlement.
    fake.settleTransfer((await payoutOf(c.id)).razorpayTransferId!, { utr: "UTR4R10SETTLED" });
    const tick = await runCreatorPayoutsTick({ now: later(180) });
    expect(tick.jobs.poll_settlement).toBeGreaterThanOrEqual(1);
    expect(await payoutOf(c.id)).toMatchObject({ status: "settled", pausedReason: "creator_suspended" });
  });
});

// ── Re-review round 2, #R3: a manual_required payout that sent a create call but records no transfer is not a dead end for the refund ──

describe("r2 #R3: a manual_required payout with no transfer recorded goes through the refund guard, and the engine proves it from a fresh listing", () => {
  it("the guard: no transfer recorded → go ahead, whatever the attempts; a recorded transfer never reversed → a person decides", () => {
    expect(payoutRefundGuard({ status: "manual_required", reversedAt: null, razorpayTransferId: null, attempts: 2 })).toBeNull();
    expect(payoutRefundGuard({ status: "manual_required", reversedAt: null, razorpayTransferId: null, attempts: 0 })).toBeNull();
    expect(payoutRefundGuard({ status: "manual_required", reversedAt: new Date(), razorpayTransferId: "trf_X", attempts: 2 })).toBeNull();
    expect(payoutRefundGuard({ status: "manual_required", reversedAt: null, razorpayTransferId: "trf_X", attempts: 2 })).toMatchObject({ statusCode: 409, code: "PAYOUT_NEEDS_ATTENTION" });
  });

  /** A captured creator post whose payout went to manual_required after its create call was sent twice and never recorded a transfer. */
  async function manualAfterSend(o: { transferAtRazorpay: boolean }) {
    // Without a transfer at Razorpay: capture with the kick off, so nothing is ever created for this payout.
    if (!o.transferAtRazorpay) vi.stubEnv("CREATOR_PAYOUT_CRON_ENABLED", "0");
    const w = await paid({ pages: [{}], network: [100_000] });
    vi.stubEnv("CREATOR_PAYOUT_CRON_ENABLED", "");
    const c = w.creators[0];
    const transferId = (await payoutOf(c.id)).razorpayTransferId;
    await setPayout(c.id, { status: "manual_required", errorCode: "transfer_unknown_after_retry", razorpayTransferId: null, attempts: 2, transferRequestedAt: new Date(Date.now() - 30 * MIN), nextAttemptAt: null });
    await openOffer(w, c.id, { status: "accepted" });
    return { w, c, transferId };
  }

  it("an empty listing: refundItem voids the payout and refunds the post once (no transfer is ever made)", async () => {
    const { w, c } = await manualAfterSend({ transferAtRazorpay: false });
    const before = fake.calls.length;
    const r = await staffPost(`${w.booking.id}/items/${c.id}/refund`);
    expect(r.status).toBe(200);
    expect(await payoutOf(c.id)).toMatchObject({ status: "void", voidReason: "item_refunded" });
    expect((await itemOf(c.id)).status).toBe("refunded");
    const log = callLog(fake).slice(before);
    expect(countOf(log, "refund.create")).toBe(1);
    expect(countOf(callLog(fake), "transfer.create")).toBe(0);
    expect(fakeRefunds(fake, w).filter((x) => x.amount === c.price)).toHaveLength(1);
  });

  it("⚠️ a live transfer carrying the payout's id: the payout is parked and tracks it again, and nothing is refunded", async () => {
    const { w, c, transferId } = await manualAfterSend({ transferAtRazorpay: true });
    expect(transferId).not.toBeNull();
    const before = fake.calls.length;
    const r = await staffPost(`${w.booking.id}/items/${c.id}/refund`);
    expect(r.status).toBe(200);
    expect(await payoutOf(c.id)).toMatchObject({ status: "needs_attention", errorCode: "duplicate_transfer", razorpayTransferId: transferId });
    expect((await itemOf(c.id)).status).toBe("refund_due");
    expect(countOf(callLog(fake).slice(before), "refund.create")).toBe(0);
    expect(await prisma.campaignRefund.count({ where: { bookingItemId: c.id } })).toBe(0);
  });
});

// ── Re-review round 2, #R5: a hand payment is only for a post that went live and was verified; the post that never did is refunded ──

describe("⚠️ r2 #R5: a payout whose post never went live is never paid by hand, and refunding the post still works", () => {
  const payoutPost = (payoutId: string, action: string, body: object = {}) =>
    request(app).post(`/v1/admin/creator-payouts/${payoutId}/${action}`).set("Authorization", `Bearer ${staff.admin}`).send(body);

  /** A captured creator post whose payout was never set aside (the kick off): planned, and the post never offered. */
  async function neverHeld() {
    vi.stubEnv("CREATOR_PAYOUT_CRON_ENABLED", "0");
    const w = await paid({ pages: [{}], network: [100_000] });
    vi.stubEnv("CREATOR_PAYOUT_CRON_ENABLED", "");
    const c = w.creators[0];
    expect((await payoutOf(c.id)).status).toBe("planned");
    return { w, c, pid: (await payoutOf(c.id)).id };
  }

  it("given up on (the worker's manual_required): 'Mark paid manually' is refused and records nothing; Refund on the campaign page voids it and refunds the post once", async () => {
    const { w, c, pid } = await neverHeld();
    await setPayout(c.id, { status: "manual_required", errorCode: "transfer_never_created" });
    const before = fake.calls.length;
    const refused = await payoutPost(pid, "mark-manual-paid", { reference: "UTR778899200" });
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toMatch(/\[post_not_live\]$/);
    expect(fake.calls.length).toBe(before); // refused before any Razorpay read
    expect(await payoutOf(c.id)).toMatchObject({ status: "manual_required", manualReference: null, manualPaidAt: null });

    const r = await staffPost(`${w.booking.id}/items/${c.id}/refund`);
    expect(r.status).toBe(200);
    expect(await payoutOf(c.id)).toMatchObject({ status: "void", voidReason: "item_refunded" });
    expect((await itemOf(c.id)).status).toBe("refunded");
    expect(countOf(callLog(fake).slice(before), "refund.create")).toBe(1);
    expect(fakeRefunds(fake, w).filter((x) => x.amount === c.price)).toHaveLength(1);
    expect(countOf(callLog(fake), "transfer.create")).toBe(0);
  });

  it("planned: a person cannot switch it to a bank transfer (nothing is owed); Refund voids it", async () => {
    const { w, c, pid } = await neverHeld();
    const refused = await payoutPost(pid, "require-manual", { reason: "account not ready" });
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toMatch(/\[post_not_live\]$/);
    expect((await payoutOf(c.id)).status).toBe("planned");
    expect((await staffPost(`${w.booking.id}/items/${c.id}/refund`)).status).toBe(200);
    expect(await payoutOf(c.id)).toMatchObject({ status: "void" });
    expect((await itemOf(c.id)).status).toBe("refunded");
  });

  it("a post owed a refund whose payout parks tells staff to take it back or stop it, and NEVER to pay the creator by hand (that would make the refund impossible)", async () => {
    const { c } = await neverHeld();
    await setPayout(c.id, { status: "needs_attention", errorCode: "transfer_unknown_after_retry", razorpayTransferId: null, attempts: 2, transferRequestedAt: new Date(Date.now() - 30 * MIN), nextAttemptAt: null });
    await prisma.campaignBookingItem.update({ where: { id: c.id }, data: { status: "refund_due", updatedAt: new Date(Date.now() - HOUR) } });
    expect(await runRefundDueJob({ now: later(1) })).toMatchObject({ checked: 1, blocked: 1, refunded: 0 });
    await flushPayoutAlertsForTests();
    const alert = vi.mocked(notifyAdminByEmail).mock.calls.find((m) => String(m[0]) === "A creator's post can't be refunded yet")!;
    const todo = (alert[1] as Array<{ label: string; value: string }>).find((d) => d.label === "What to do")!.value;
    expect(todo).toMatch(/Reverse/);
    expect(todo).toMatch(/Never pay the creator by hand/);
    expect(todo).not.toMatch(/pay the creator by hand, and the refund then goes out by itself/);
  });

  it("parked with no transfer (requested twice, nothing ever showed up): 'Stop this payout' moves it once a fresh listing shows no money out; it is never paid by hand; the post is then refunded once", async () => {
    const { w, c, pid } = await neverHeld();
    await setPayout(c.id, { status: "needs_attention", errorCode: "transfer_unknown_after_retry", razorpayTransferId: null, attempts: 2, transferRequestedAt: new Date(Date.now() - 30 * MIN), nextAttemptAt: null });
    // A refund cannot start on a parked payout: a person stops it first.
    expect((await staffPost(`${w.booking.id}/items/${c.id}/refund`)).status).toBe(409);
    const stopped = await payoutPost(pid, "require-manual", { reason: "no transfer at Razorpay" });
    expect(stopped.status).toBe(200);
    expect(stopped.body.data.payout.status).toBe("manual_required");
    expect((await payoutPost(pid, "mark-manual-paid", { reference: "UTR778899201" })).status).toBe(409);
    const before = fake.calls.length;
    const r = await staffPost(`${w.booking.id}/items/${c.id}/refund`);
    expect(r.status).toBe(200);
    expect(await payoutOf(c.id)).toMatchObject({ status: "void", voidReason: "item_refunded" });
    expect((await itemOf(c.id)).status).toBe("refunded");
    expect(countOf(callLog(fake).slice(before), "refund.create")).toBe(1);
    expect(countOf(callLog(fake), "transfer.create")).toBe(0);
  });
});
