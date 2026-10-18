/**
 * The payout reconciliation worker (cron/creator-payouts.cron.ts), driven through runCreatorPayoutsTick against the stateful fake of
 * Razorpay. Every payout is made by the real capture webhook and the real engine, so a state like "release requested, answer lost" is
 * REACHED (by losing the answer at the fake), not written into a row.
 *
 * What is proved here: each of the worker's jobs picks up its state and moves it one safe step; a tick spends at most 20 Razorpay requests
 * and defers the rest; the refunds of job 10 are never starved by a busy payout queue; one tick at a time; three bad answers in a row stop
 * a tick; the switches (worker off, no keys, Route off stops only NEW transfers, refund sweep off); and the daily digest and the
 * suspended-account alert go out once, not every tick.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { prisma } from "@dashmani/db";
import "./setup";

vi.mock("../src/services/email.service", async (orig) => {
  const actual = await orig<typeof import("../src/services/email.service")>();
  return { ...actual, sendEmail: vi.fn(async () => ({ messageId: "test" })), notifyAdminByEmail: vi.fn(async () => ({ messageId: "test" })) };
});

import { notifyAdminByEmail } from "../src/services/email.service";
import { flushPayoutAlertsForTests, resetPayoutAlertsForTests } from "../src/services/creator/payout-alert";
import { settlePayoutKicksForTests } from "../src/services/campaign/payment.service";
import { onCreatorLinkVerified } from "../src/services/creator/payout-ledger";
import { settleCreatorRefundsForTests } from "../src/services/creator/creator-refund.service";
import { JOB_COST, REFUND_RESERVE, TICK_CALL_BUDGET, alertSuspendedHolding, findStuckPayouts, resetCreatorPayoutsCronForTests, runCreatorPayoutsTick } from "../src/cron/creator-payouts.cron";
import { FakeRazorpay, is } from "./fake-razorpay-route";
import { DAY, HOUR, MIN, callLog, capture, countOf, itemOf, mkWorld, openOffer, payoutOf, stubPayoutEnv, verifiedOffer, mkStaff, type World } from "./payout-fixtures";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const fake = new FakeRazorpay();
const subjects = () => vi.mocked(notifyAdminByEmail).mock.calls.map((c) => String(c[0]));
let staffId: string;

beforeEach(async () => {
  // system_settings is not truncated between tests: the release switch must start every test absent (= on).
  await prisma.systemSetting.deleteMany({ where: { key: "creatorPayouts.release" } });
  stubPayoutEnv();
  fake.reset();
  fake.install();
  resetPayoutAlertsForTests();
  resetCreatorPayoutsCronForTests();
  vi.mocked(notifyAdminByEmail).mockClear();
  staffId = (await mkStaff()).staffId;
});
afterEach(async () => {
  await prisma.systemSetting.deleteMany({ where: { key: "creatorPayouts.release" } }); // leave nothing behind for the next file
  await settlePayoutKicksForTests();
  await settleCreatorRefundsForTests();
  await flushPayoutAlertsForTests();
  fake.restore();
  vi.unstubAllEnvs();
});

const paid = async (spec: Parameters<typeof mkWorld>[1]): Promise<World> => {
  const w = await mkWorld(fake, spec);
  expect((await capture(fake, w)).status).toBe(200);
  return w;
};
/** A captured booking whose payouts the kick did NOT make (still `planned`). */
async function plannedWorld(spec: Parameters<typeof mkWorld>[1]): Promise<World> {
  vi.stubEnv("CREATOR_PAYOUT_CRON_ENABLED", "0");
  const w = await paid(spec);
  vi.stubEnv("CREATOR_PAYOUT_CRON_ENABLED", "");
  return w;
}
const setPayout = (itemId: string, data: Record<string, unknown>) => prisma.creatorPayout.update({ where: { bookingItemId: itemId }, data });
const after = (m: number) => new Date(Date.now() + m * MIN);
const requests = (from: number) => fake.calls.length - from;

// ── The jobs ───────────────────────────────────────────────────────────────────────

describe("each job picks up its own state and moves it one safe step", () => {
  it("1 execute: a planned payout becomes ONE held transfer", async () => {
    const w = await plannedWorld({ pages: [{}] });
    const tick = await runCreatorPayoutsTick();
    expect(tick).toMatchObject({ ran: true, failed: 0 });
    expect(tick.jobs.execute).toBe(1);
    expect(await payoutOf(w.creators[0].id)).toMatchObject({ status: "held" });
    expect(countOf(callLog(fake), "transfer.create")).toBe(1);
    // A second pass finds nothing to execute and creates nothing.
    expect((await runCreatorPayoutsTick()).jobs.execute).toBe(0);
    expect(countOf(callLog(fake), "transfer.create")).toBe(1);
  });

  it("2 resolve_unknown: a create whose answer was lost is READ (the transfer is adopted), never created a second time", async () => {
    const w = await mkWorld(fake, { pages: [{}] });
    fake.intercept({ match: is.createTransfer, mode: "lose", times: 1 });
    await capture(fake, w);
    const lost = await payoutOf(w.creators[0].id);
    expect(lost.status).toBe("transfer_requested");
    expect(lost.razorpayTransferId).toBeNull();
    const tick = await runCreatorPayoutsTick({ now: after(30) });
    expect(tick.jobs.resolve_unknown).toBe(1);
    const p = await payoutOf(w.creators[0].id);
    expect(p.status).toBe("held");
    expect(p.razorpayTransferId).toBe([...fake.transfers.keys()][0]);
    expect(fake.transfers.size).toBe(1);
    expect(countOf(callLog(fake), "transfer.create")).toBe(1);
  });

  it("3 confirm_hold: a transfer Razorpay still calls pending is confirmed once it is processed", async () => {
    fake.createStatus = "pending";
    const w = await paid({ pages: [{}] });
    const c = w.creators[0];
    expect(await payoutOf(c.id)).toMatchObject({ status: "transfer_requested" });
    const id = (await payoutOf(c.id)).razorpayTransferId!;
    expect(id).toMatch(/^trf_/);
    fake.processTransfer(id);
    const tick = await runCreatorPayoutsTick({ now: after(10) });
    expect(tick.jobs.confirm_hold).toBe(1);
    expect(await payoutOf(c.id)).toMatchObject({ status: "held" });
  });

  it("4 cleanup_duplicates: an extra live transfer for the same payout is reversed, and the payout goes back to held on a fresh read", async () => {
    const w = await paid({ pages: [{}] });
    const c = w.creators[0];
    const p = await payoutOf(c.id);
    const twin = fake.seedTransfer({ source: w.payId, recipient: p.razorpayAccountId, amount: p.amountPaise, notes: { payout_id: p.id, booking_item_id: c.id }, onHold: true });
    await setPayout(c.id, { status: "needs_attention", errorCode: "duplicate_transfer" });
    const t1 = await runCreatorPayoutsTick();
    expect(t1.jobs.cleanup_duplicates).toBe(1);
    expect(fake.transfers.get(twin.id)!.amountReversed).toBe(twin.amount);
    expect(fake.transfers.get(p.razorpayTransferId!)!.amountReversed).toBe(0); // the kept one is never touched
    const t2 = await runCreatorPayoutsTick({ now: after(2 * 60) });
    expect(t2.jobs.cleanup_duplicates).toBe(1);
    expect(await payoutOf(c.id)).toMatchObject({ status: "held" });
  });

  it("5 release: a due, verified payout is released (the hold is lifted); one tick, one PATCH", async () => {
    const w = await paid({ pages: [{}] });
    const c = w.creators[0];
    await verifiedOffer(w, c.id);
    await onCreatorLinkVerified(c.id, { type: "staff", id: staffId });
    const tick = await runCreatorPayoutsTick({ now: after(5) });
    expect(tick.jobs.release).toBe(1);
    expect(await payoutOf(c.id)).toMatchObject({ status: "released" });
    expect(fake.count((x) => is.setHold(x, false))).toBe(1);
  });

  it("6 resolve_release: a release whose answer was lost is READ, and the payout is released (the hold is not lifted twice)", async () => {
    const w = await paid({ pages: [{}] });
    const c = w.creators[0];
    await verifiedOffer(w, c.id);
    await onCreatorLinkVerified(c.id, { type: "staff", id: staffId });
    fake.intercept({ match: (x) => is.setHold(x, false), mode: "lose", times: 1 });
    await runCreatorPayoutsTick({ now: after(5) });
    expect(await payoutOf(c.id)).toMatchObject({ status: "release_requested" });
    const tick = await runCreatorPayoutsTick({ now: after(30) });
    expect(tick.jobs.resolve_release).toBe(1);
    expect(await payoutOf(c.id)).toMatchObject({ status: "released" });
    expect(fake.count((x) => is.setHold(x, false))).toBe(1);
  });

  it("7 poll_settlement: a released payout is `settled` only from a processed settlement with its UTR", async () => {
    const w = await paid({ pages: [{}] });
    const c = w.creators[0];
    await verifiedOffer(w, c.id);
    await onCreatorLinkVerified(c.id, { type: "staff", id: staffId });
    await runCreatorPayoutsTick({ now: after(5) });
    const id = (await payoutOf(c.id)).razorpayTransferId!;
    // Not settled yet: it stays released.
    await runCreatorPayoutsTick({ now: after(60) });
    expect((await payoutOf(c.id)).status).toBe("released");
    fake.settleTransfer(id);
    const tick = await runCreatorPayoutsTick({ now: after(120) });
    expect(tick.jobs.poll_settlement).toBeGreaterThanOrEqual(1);
    expect(await payoutOf(c.id)).toMatchObject({ status: "settled" });
    expect((await payoutOf(c.id)).settlementUtr).toMatch(/^UTRFAKE/);
  });

  it("8 resolve_reversal: a reversal whose answer was lost is READ and confirmed, never reversed twice", async () => {
    const w = await paid({ pages: [{}] });
    const c = w.creators[0];
    await openOffer(w, c.id, { status: "accepted" });
    fake.intercept({ match: is.createReversal, mode: "lose", times: 1 });
    const { reversePayout } = await import("../src/services/creator/payout.service");
    const r = await reversePayout((await payoutOf(c.id)).id, { reason: "test", actor: { type: "staff", id: staffId } });
    expect(r.status).toBe("reversal_requested");
    const tick = await runCreatorPayoutsTick({ now: after(30) });
    expect(tick.jobs.resolve_reversal).toBe(1);
    expect(await payoutOf(c.id)).toMatchObject({ status: "reversed" });
    expect(countOf(callLog(fake), "reversal.create")).toBe(1);
  });

  it("9 recheck_held: a held payout is re-read once a day, and a transfer someone released in the Razorpay dashboard is put back on hold and staff are told", async () => {
    const w = await paid({ pages: [{}] });
    const c = w.creators[0];
    const id = (await payoutOf(c.id)).razorpayTransferId!;
    // Nothing is due straight after the hold was confirmed.
    expect((await runCreatorPayoutsTick({ now: after(5) })).jobs.recheck_held).toBe(0);
    // Someone lifts the hold in the Razorpay dashboard.
    fake.transfers.get(id)!.onHold = false;
    const tick = await runCreatorPayoutsTick({ now: new Date(Date.now() + DAY + HOUR) });
    expect(tick.jobs.recheck_held).toBe(1);
    expect(fake.transfers.get(id)!.onHold).toBe(true); // the hold is put back
    expect(fake.count((x) => is.setHold(x, true))).toBeGreaterThanOrEqual(1);
    await flushPayoutAlertsForTests();
    expect(subjects().length).toBeGreaterThan(0);
    expect(["held", "needs_attention"]).toContain((await payoutOf(c.id)).status);
  });

  it("10 rehold_paused: a released, unsettled payout that a dispute paused has its hold put back", async () => {
    const w = await paid({ pages: [{}] });
    const c = w.creators[0];
    await verifiedOffer(w, c.id);
    await onCreatorLinkVerified(c.id, { type: "staff", id: staffId });
    await runCreatorPayoutsTick({ now: after(5) });
    const id = (await payoutOf(c.id)).razorpayTransferId!;
    expect(fake.transfers.get(id)!.onHold).toBe(false);
    await setPayout(c.id, { pausedAt: new Date(), pausedReason: "dispute" });
    const tick = await runCreatorPayoutsTick({ now: after(6 * 60) });
    expect(tick.jobs.rehold_paused).toBe(1);
    expect(fake.transfers.get(id)!.onHold).toBe(true);
  });
});

// ── The budget ──────────────────────────────────────────────────────────────────────

describe("a tick is bounded", () => {
  it("every job's worst case is a real number and the budget keeps a reserve for the refunds", () => {
    expect(TICK_CALL_BUDGET).toBe(20);
    expect(REFUND_RESERVE).toBeGreaterThan(0);
    expect(TICK_CALL_BUDGET - REFUND_RESERVE).toBeGreaterThanOrEqual(Math.max(...Object.values(JOB_COST)));
    for (const [job, cost] of Object.entries(JOB_COST)) expect(cost, job).toBeGreaterThan(0);
  });

  it("⚠️ a backlog never costs more than 20 Razorpay requests in a tick: the rest is deferred and drains over the next ticks", async () => {
    const w = await paid({ pages: Array.from({ length: 8 }, () => ({})) }); // 8 held payouts, all due for their daily re-read
    const dayLater = new Date(Date.now() + DAY + HOUR);
    let total = 0;
    let sawDeferred = false;
    for (let i = 0; i < 12; i++) {
      const mark = fake.calls.length;
      const tick = await runCreatorPayoutsTick({ now: dayLater, budget: 10 }); // payouts get 10 - 6 = 4: one recheck (worst case 4) a tick
      expect(requests(mark)).toBeLessThanOrEqual(10);
      expect(tick.calls).toBeLessThanOrEqual(10 - REFUND_RESERVE);
      if (tick.deferred > 0) sawDeferred = true;
      total += tick.jobs.recheck_held;
      if (tick.jobs.recheck_held === 0) break;
    }
    expect(sawDeferred).toBe(true);
    expect(total).toBe(w.creators.length); // every payout was looked at, one tick at a time, none twice
    // With the real budget, one tick over a big backlog stays inside it too.
    const big = await paid({ pages: Array.from({ length: 12 }, () => ({})) });
    const mark = fake.calls.length;
    const tick = await runCreatorPayoutsTick({ now: new Date(Date.now() + 3 * DAY) });
    expect(requests(mark)).toBeLessThanOrEqual(TICK_CALL_BUDGET);
    expect(tick.jobs.recheck_held).toBeGreaterThan(0);
    void big;
  });

  it("⚠️ the refunds of job 10 are not starved by a busy payout queue: they have their own reserve inside the same 20", async () => {
    const w = await paid({ pages: [{}, {}, {}, {}] });
    // Three held payouts are due for their re-read; the fourth post is owed back (refund_due, payout void: one refund call).
    const owed = w.creators[3];
    await setPayout(owed.id, { status: "void", voidReason: "test" });
    await prisma.campaignBookingItem.update({ where: { id: owed.id }, data: { status: "refund_due" } });
    const later = new Date(Date.now() + DAY + HOUR);
    const mark = fake.calls.length;
    const tick = await runCreatorPayoutsTick({ now: later, budget: 10 });
    expect(requests(mark)).toBeLessThanOrEqual(10);
    expect(tick.calls).toBeLessThanOrEqual(10 - REFUND_RESERVE);
    expect(tick.refunds).toMatchObject({ checked: 1, refunded: 1 });
    expect((await itemOf(owed.id)).status).toBe("refunded");
    expect(countOf(callLog(fake).slice(mark), "refund.create")).toBe(1);
  });

  it("three bad answers in a row stop the tick (Razorpay is down): the rest waits for the next one", async () => {
    await paid({ pages: Array.from({ length: 6 }, () => ({})) });
    fake.intercept({ match: is.fetchTransfer, mode: "drop", times: 99 });
    const tick = await runCreatorPayoutsTick({ now: new Date(Date.now() + DAY + HOUR) });
    expect(tick.selected).toBe(6);
    expect(tick.jobs.recheck_held).toBe(3);
    expect(tick.deferred).toBe(3);
    expect(tick.failed).toBe(0);
  });
});

// ── Switches and guards ─────────────────────────────────────────────────────────────

describe("the switches and the overlap guard", () => {
  it("CREATOR_PAYOUT_CRON_ENABLED=0 stops the whole worker, and no Razorpay keys means it does nothing at all", async () => {
    const w = await plannedWorld({ pages: [{}] });
    vi.stubEnv("CREATOR_PAYOUT_CRON_ENABLED", "0");
    const mark = fake.calls.length;
    expect((await runCreatorPayoutsTick()).ran).toBe(false);
    vi.stubEnv("CREATOR_PAYOUT_CRON_ENABLED", "");
    vi.stubEnv("RAZORPAY_KEY_ID", "");
    vi.stubEnv("RAZORPAY_KEY_SECRET", "");
    expect((await runCreatorPayoutsTick()).ran).toBe(false);
    expect(requests(mark)).toBe(0);
    expect((await payoutOf(w.creators[0].id)).status).toBe("planned");
  });

  it("⚠️ the Route switch off stops only NEW transfers: a planned payout waits, while a due release, a reversal and a refund keep going", async () => {
    const w = await plannedWorld({ pages: [{}, {}, {}] });
    const [planned, releasing, reversing] = w.creators;
    // `releasing` and `reversing` get their transfers (the switch is on for that), then the switch goes off.
    const { executePlannedPayout, reversePayout } = await import("../src/services/creator/payout.service");
    await executePlannedPayout((await payoutOf(releasing.id)).id);
    await executePlannedPayout((await payoutOf(reversing.id)).id);
    await verifiedOffer(w, releasing.id);
    await onCreatorLinkVerified(releasing.id, { type: "staff", id: staffId });
    fake.intercept({ match: is.createReversal, mode: "lose", times: 1 });
    await reversePayout((await payoutOf(reversing.id)).id, { reason: "test", actor: { type: "staff", id: staffId } });
    expect((await payoutOf(reversing.id)).status).toBe("reversal_requested");

    vi.stubEnv("CREATOR_ROUTE_ENABLED", "0");
    const mark = fake.calls.length;
    const tick = await runCreatorPayoutsTick({ now: after(30) });
    expect(tick.jobs.execute).toBe(0);
    expect(callLog(fake).slice(mark)).not.toContain("transfer.create");
    expect((await payoutOf(planned.id)).status).toBe("planned");
    expect(tick.jobs.release).toBe(1);
    expect((await payoutOf(releasing.id)).status).toBe("released");
    expect(tick.jobs.resolve_reversal).toBe(1);
    expect((await payoutOf(reversing.id)).status).toBe("reversed");
  });

  it("the refund sweep switch (CAMPAIGN_REFUND_SWEEP_ENABLED=0) leaves job 10 out of the tick", async () => {
    const w = await paid({ pages: [{}] });
    await setPayout(w.creators[0].id, { status: "void", voidReason: "test" });
    await prisma.campaignBookingItem.update({ where: { id: w.creators[0].id }, data: { status: "refund_due" } });
    vi.stubEnv("CAMPAIGN_REFUND_SWEEP_ENABLED", "0");
    const tick = await runCreatorPayoutsTick({ now: after(10) });
    expect(tick.ran).toBe(true);
    expect(tick.refunds).toBeNull();
    expect((await itemOf(w.creators[0].id)).status).toBe("refund_due");
    vi.stubEnv("CAMPAIGN_REFUND_SWEEP_ENABLED", "");
    const again = await runCreatorPayoutsTick({ now: after(10) });
    expect(again.refunds).toMatchObject({ refunded: 1 });
  });

  it("⚠️ one tick at a time: a tick that starts while another is still running does nothing (the guard is claimed before the first await)", async () => {
    const w = await paid({ pages: [{}] });
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    fake.intercept({ match: is.fetchTransfer, mode: "hold", gate, times: 1 });
    const first = runCreatorPayoutsTick({ now: new Date(Date.now() + DAY + HOUR) });
    try {
      await vi.waitFor(() => expect(fake.count(is.fetchTransfer)).toBe(1));
      const second = await runCreatorPayoutsTick({ now: new Date(Date.now() + DAY + HOUR) });
      expect(second.ran).toBe(false);
      expect(fake.count(is.fetchTransfer)).toBe(1);
    } finally {
      open();
    }
    expect((await first).ran).toBe(true);
    // And two ticks started in the same instant: exactly one runs.
    const both = await Promise.all([runCreatorPayoutsTick({ now: after(1) }), runCreatorPayoutsTick({ now: after(1) })]);
    expect(both.filter((t) => t.ran)).toHaveLength(1);
    void w;
  });
});

// ── Job 14: alerts the steps do not raise ────────────────────────────────────────────

describe("alerts", () => {
  it("a payout account that is suspended while it holds money is alerted ONCE per account per IST day", async () => {
    const w = await paid({ pages: [{}, {}] });
    await prisma.creatorPayoutAccount.update({ where: { id: w.creators[0].accountId! }, data: { activationStatus: "suspended" } });
    const t1 = await runCreatorPayoutsTick();
    expect(t1.suspendedHolding).toBe(1);
    await flushPayoutAlertsForTests();
    const SUBJECT = "A creator's payout account is suspended while it holds money";
    expect(subjects().filter((s) => s === SUBJECT)).toHaveLength(1);
    // The same day: found again, not mailed again.
    expect((await runCreatorPayoutsTick()).suspendedHolding).toBe(1);
    await flushPayoutAlertsForTests();
    expect(subjects().filter((s) => s === SUBJECT)).toHaveLength(1);
    // Never a bank detail or a Razorpay body in it.
    const mail = JSON.stringify(vi.mocked(notifyAdminByEmail).mock.calls.find((c) => c[0] === SUBJECT));
    expect(mail).not.toMatch(/acc_|account_number|ifsc|HDFC/i);
    // The next IST day it is a new alert.
    expect(await alertSuspendedHolding(new Date(Date.now() + 2 * DAY))).toBe(1);
    await flushPayoutAlertsForTests();
    expect(subjects().filter((s) => s === SUBJECT)).toHaveLength(2);
  });

  it("the daily digest names what is past its threshold and goes out once a day, not every tick", async () => {
    const w = await paid({ pages: [{}] });
    const c = w.creators[0];
    // A payout parked for a person for over an hour, and nobody was ever alerted.
    await setPayout(c.id, { status: "needs_attention", errorCode: "processed_not_held", updatedAt: new Date(Date.now() - 3 * HOUR) });
    const found = await findStuckPayouts(new Date());
    expect(found.map((f) => f.key)).toEqual(expect.arrayContaining(["needs_attention", "unalerted"]));
    const DIGEST = /creator payout.* past the point they should have moved/;
    const T0 = Date.now();
    const t1 = await runCreatorPayoutsTick({ now: new Date(T0) });
    expect(t1.stuck).toBeGreaterThan(0);
    await flushPayoutAlertsForTests();
    expect(subjects().filter((s) => DIGEST.test(s))).toHaveLength(1);
    // The check itself runs at most hourly.
    expect((await runCreatorPayoutsTick({ now: new Date(T0 + 30 * MIN) })).stuck).toBe(0);
    // Two hours on it is found again, but a digest went out less than a day ago.
    expect((await runCreatorPayoutsTick({ now: new Date(T0 + 2 * HOUR) })).stuck).toBeGreaterThan(0);
    await flushPayoutAlertsForTests();
    expect(subjects().filter((s) => DIGEST.test(s))).toHaveLength(1);
    // A day later, still stuck: one more.
    await runCreatorPayoutsTick({ now: new Date(T0 + DAY + 3 * HOUR) });
    await flushPayoutAlertsForTests();
    expect(subjects().filter((s) => DIGEST.test(s))).toHaveLength(2);
  });

  it("a refund that has waited a dozen worker passes is named in the digest", async () => {
    const w = await paid({ pages: [{}] });
    const c = w.creators[0];
    await prisma.campaignBookingItem.update({ where: { id: c.id }, data: { status: "refund_due", attempts: 12 } });
    expect((await findStuckPayouts(new Date())).map((f) => f.key)).toContain("refund_due");
  });

  it("nothing is mailed when nothing is stuck", async () => {
    await paid({ pages: [{}] });
    const t = await runCreatorPayoutsTick({ now: after(5) });
    expect(t.stuck).toBe(0);
    await flushPayoutAlertsForTests();
    expect(subjects().filter((s) => /past the point/.test(s))).toHaveLength(0);
  });
});
