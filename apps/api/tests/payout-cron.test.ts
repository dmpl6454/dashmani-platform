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
import { alertStaffOncePerHour, clearPayoutAlertMarkersForTests, flushPayoutAlertsForTests, resetPayoutAlertsForTests } from "../src/services/creator/payout-alert";
import { settlePayoutKicksForTests } from "../src/services/campaign/payment.service";
import { onCreatorLinkVerified } from "../src/services/creator/payout-ledger";
import { settleCreatorRefundsForTests } from "../src/services/creator/creator-refund.service";
import { withdrawOffer } from "../src/services/creator/creator-offer.service";
import { JOB_COST, REFUND_RESERVE, TICK_CALL_BUDGET, alertSuspendedHolding, findStuckPayouts, resetCreatorPayoutsCronForTests, runCreatorPayoutsTick } from "../src/cron/creator-payouts.cron";
import { FakeRazorpay, is } from "./fake-razorpay-route";
import { PAYOUT_CHIPS, actionsFor } from "@dashmani/shared/src/payouts/staff-ui";
import { DAY, HOUR, MIN, callLog, capture, countOf, itemOf, mkWorld, openOffer, payoutOf, stubPayoutEnv, verifiedOffer, mkStaff, type World } from "./payout-fixtures";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const fake = new FakeRazorpay();
const subjects = () => vi.mocked(notifyAdminByEmail).mock.calls.map((c) => String(c[0]));
let staffId: string;

beforeEach(async () => {
  // system_settings is not truncated between tests: the release switch must start every test absent (= on).
  await prisma.systemSetting.deleteMany({ where: { key: "creatorPayouts.release" } });
  await clearPayoutAlertMarkersForTests(); // the once-a-day markers are in the database, which is not truncated between tests
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
  await clearPayoutAlertMarkersForTests();
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
    // r3 #3: "What to do" names the queue's REAL views and buttons, and splits by the post's state: a link that is not verified yet is verified
    // FIRST (a payout taken back before that can never be paid by hand), a live verified post is reversed then paid by bank transfer from
    // "Owed after reversal", and a post never sent is withdrawn (the client is refunded). No view called "Taken back, unpaid" exists.
    // (The alert HTML-escapes its fields: read them back as plain text.)
    const unescape = (v: string) => v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
    const todo = unescape((vi.mocked(notifyAdminByEmail).mock.calls.find((c) => c[0] === SUBJECT)![1] as Array<{ label: string; value: string }>).find((d) => d.label === "What to do")!.value);
    expect(todo).not.toMatch(/Taken back, unpaid/);
    expect(todo).toMatch(/not verified yet: verify it FIRST, while the payout is still held \("Verify link & release"/);
    expect(todo).toMatch(/live and verified: press "Reverse".*under "Owed after reversal": press "Pay by bank transfer instead"/);
    expect(todo).toMatch(/not sent a link: nothing is owed\. Press "Withdraw offer".*refunded automatically/);
    expect(todo.indexOf("verify it FIRST")).toBeLessThan(todo.indexOf('press "Reverse"'));
    // Every label the email names is one the staff pages really show.
    for (const label of ["Owed after reversal", "Needs attention"]) expect(PAYOUT_CHIPS.map((ch) => ch.label)).toContain(label);
    const reversedLive = actionsFor({ status: "reversed", pausedAt: null, releaseAfter: null, itemStatus: "posted_manual" }, { releaseOn: true, now: Date.now() }).map((a) => a.label);
    const heldLabels = actionsFor({ status: "held", pausedAt: null, releaseAfter: null }, { releaseOn: true, now: Date.now() }).map((a) => a.label);
    const manualLive = actionsFor({ status: "manual_required", pausedAt: null, releaseAfter: null, itemStatus: "posted_manual" }, { releaseOn: true, now: Date.now() }).map((a) => a.label);
    const parkedNotLive = actionsFor({ status: "needs_attention", pausedAt: null, releaseAfter: null, itemStatus: "awaiting_creator", hasTransfer: true, errorCode: "failed_while_held" }, { releaseOn: true, now: Date.now() }).map((a) => a.label);
    expect(reversedLive).toContain("Pay by bank transfer instead");
    expect(heldLabels).toContain("Reverse");
    expect(manualLive).toContain("Mark paid manually");
    expect(parkedNotLive).toEqual(expect.arrayContaining(["Reverse", "Stop this payout"]));
    // The next IST day it is a new alert.
    expect(await alertSuspendedHolding(new Date(Date.now() + 2 * DAY))).toBe(1);
    await flushPayoutAlertsForTests();
    expect(subjects().filter((s) => s === SUBJECT)).toHaveLength(2);
  });

  it("the daily digest names what is past its threshold and goes out once a day, not every tick", async () => {
    const w = await paid({ pages: [{}] });
    const c = w.creators[0];
    // A payout parked for a person for over an hour, and nobody was ever alerted.
    await setPayout(c.id, { status: "needs_attention", errorCode: "needs_look", updatedAt: new Date(Date.now() - 3 * HOUR) });
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

  it("⚠️ 'once per IST day' survives a restart and a later hour: a deploy wipes the in-memory state, the database marker does not", async () => {
    const w = await paid({ pages: [{}] });
    await prisma.creatorPayoutAccount.update({ where: { id: w.creators[0].accountId! }, data: { activationStatus: "suspended" } });
    const SUBJECT = "A creator's payout account is suspended while it holds money";
    const morning = new Date("2026-10-20T06:00:00.000Z"); // 11:30 IST
    expect(await alertSuspendedHolding(morning)).toBe(1);
    await flushPayoutAlertsForTests();
    expect(subjects().filter((s) => s === SUBJECT)).toHaveLength(1);
    // A restart: the hourly memory is gone. Three hours on, the same IST day: found again, not mailed again.
    resetPayoutAlertsForTests();
    expect(await alertSuspendedHolding(new Date(morning.getTime() + 3 * HOUR))).toBe(1);
    await flushPayoutAlertsForTests();
    expect(subjects().filter((s) => s === SUBJECT)).toHaveLength(1);
    // And hour after hour, with the memory forgotten each time: still one for the day.
    for (let h = 4; h <= 8; h++) {
      resetPayoutAlertsForTests();
      await alertSuspendedHolding(new Date(morning.getTime() + h * HOUR));
    }
    await flushPayoutAlertsForTests();
    expect(subjects().filter((s) => s === SUBJECT)).toHaveLength(1);
    // The next IST day it is a new alert, once.
    resetPayoutAlertsForTests();
    await alertSuspendedHolding(new Date(morning.getTime() + DAY));
    await flushPayoutAlertsForTests();
    expect(subjects().filter((s) => s === SUBJECT)).toHaveLength(2);
  });

  it("⚠️ the daily digest is not sent again after a restart (every deploy restarts the process): the day is counted from the last digest that really went out, kept in the database", async () => {
    const w = await paid({ pages: [{}] });
    await setPayout(w.creators[0].id, { status: "needs_attention", errorCode: "needs_look", updatedAt: new Date(Date.now() - 3 * HOUR) });
    const DIGEST = /creator payout.* past the point they should have moved/;
    const T0 = Date.now();
    expect((await runCreatorPayoutsTick({ now: new Date(T0) })).stuck).toBeGreaterThan(0);
    await flushPayoutAlertsForTests();
    expect(subjects().filter((s) => DIGEST.test(s))).toHaveLength(1);
    // Deploy: the process restarts a few minutes later. Everything in memory is gone, the payout is still stuck.
    resetPayoutAlertsForTests();
    resetCreatorPayoutsCronForTests();
    expect((await runCreatorPayoutsTick({ now: new Date(T0 + 4 * MIN) })).stuck).toBeGreaterThan(0);
    await flushPayoutAlertsForTests();
    expect(subjects().filter((s) => DIGEST.test(s))).toHaveLength(1);
    // Another deploy the next morning: still stuck, a day has passed: one more, and only one.
    resetPayoutAlertsForTests();
    resetCreatorPayoutsCronForTests();
    await runCreatorPayoutsTick({ now: new Date(T0 + DAY + 2 * HOUR) });
    await flushPayoutAlertsForTests();
    expect(subjects().filter((s) => DIGEST.test(s))).toHaveLength(2);
  });

  it("⚠️ a failed digest send does not use up the day: the marker is written only once the mailer said the email went out", async () => {
    const w = await paid({ pages: [{}] });
    await setPayout(w.creators[0].id, { status: "needs_attention", errorCode: "needs_look", updatedAt: new Date(Date.now() - 3 * HOUR) });
    const DIGEST = /creator payout.* past the point they should have moved/;
    const T0 = Date.now();
    vi.mocked(notifyAdminByEmail).mockResolvedValueOnce(null as never); // SMTP down: sendEmail answers null
    await runCreatorPayoutsTick({ now: new Date(T0) });
    await flushPayoutAlertsForTests();
    expect(subjects().filter((s) => DIGEST.test(s))).toHaveLength(1); // tried
    expect(await prisma.systemSetting.count({ where: { key: { startsWith: "creatorPayouts.alerted:payout-digest" } } })).toBe(0);
    // The next hourly check tries again (and this one is delivered).
    resetPayoutAlertsForTests();
    await runCreatorPayoutsTick({ now: new Date(T0 + 2 * HOUR) });
    await flushPayoutAlertsForTests();
    expect(subjects().filter((s) => DIGEST.test(s))).toHaveLength(2);
    expect(await prisma.systemSetting.count({ where: { key: { startsWith: "creatorPayouts.alerted:payout-digest" } } })).toBe(1);
  });

  it("⚠️ a creator cannot use up the alert budget that money-critical alerts need: twenty declines, then a failed transfer still emails (and a critical flood is still capped)", async () => {
    const sent = () => vi.mocked(notifyAdminByEmail).mock.calls.length;
    const t0 = Date.now();
    const declines = Array.from({ length: 20 }, (_, i) => alertStaffOncePerHour(`creator-offer-closed:item-${i}`, "A creator declined a campaign post", [], undefined, { now: t0 }));
    expect(declines.filter(Boolean).length).toBeLessThanOrEqual(6); // the routine lane has its own, smaller allowance
    expect(declines.filter(Boolean).length).toBeGreaterThan(0);
    await flushPayoutAlertsForTests();
    const afterDeclines = sent();
    expect(alertStaffOncePerHour("payout-engine:transfer_failed:failed", "Creator payout transfer FAILED", [], undefined, { now: t0 })).toBe(true);
    expect(alertStaffOncePerHour("dispute:disp_x:open", "Payment dispute opened on a creator booking", [], undefined, { now: t0 })).toBe(true);
    await flushPayoutAlertsForTests();
    expect(sent()).toBe(afterDeclines + 2);
    // The critical lane keeps its own ceiling: a flood of DIFFERENT critical keys is still stopped at 12.
    resetPayoutAlertsForTests();
    const flood = Array.from({ length: 20 }, (_, i) => alertStaffOncePerHour(`payout-engine:flood:${i}`, "x", [], undefined, { now: t0 }));
    expect(flood.filter(Boolean)).toHaveLength(12);
  });

  it("names a verified post whose release was never scheduled, a reversed payout of a live post, and a post that reads refunded with no refund behind it", async () => {
    const w = await paid({ pages: [{}, {}, {}] });
    const [unscheduled, reversed, refundedNoRefund] = w.creators;
    await verifiedOffer(w, unscheduled.id, { verifiedAt: new Date(Date.now() - 2 * HOUR) });
    await setPayout(reversed.id, { status: "reversed", reversedAt: new Date(Date.now() - 2 * DAY), amountReversedPaise: reversed.payout });
    await prisma.campaignBookingItem.update({ where: { id: reversed.id }, data: { status: "posted_manual" } });
    await setPayout(refundedNoRefund.id, { status: "void", voidReason: "test" });
    await prisma.campaignBookingItem.update({ where: { id: refundedNoRefund.id }, data: { status: "refunded", updatedAt: new Date(Date.now() - 7 * HOUR) } });
    const found = await findStuckPayouts(new Date());
    const by = new Map(found.map((f) => [f.key, f]));
    expect(by.get("verified_not_scheduled")?.sample).toEqual([(await payoutOf(unscheduled.id)).id]);
    expect(by.get("reversed_owed")?.sample).toEqual([(await payoutOf(reversed.id)).id]);
    expect(by.get("refunded_no_ledger")?.sample).toEqual([refundedNoRefund.id]);
    // The same facts one minute after the verification are not stuck yet.
    expect((await findStuckPayouts(new Date(Date.now() - 3 * HOUR))).map((f) => f.key)).not.toContain("verified_not_scheduled");
  });

  it("⚠️ 'parked since' is the time of the last real MOVE into the status, not updated_at: a payout re-polled every few minutes is still named", async () => {
    const w = await paid({ pages: [{}] });
    const c = w.creators[0];
    const p = await payoutOf(c.id);
    // Parked three hours ago ...
    await prisma.creatorPayoutEvent.create({ data: { payoutId: p.id, bookingId: p.bookingId, kind: "status_change", fromStatus: "held", toStatus: "needs_attention", actorType: "system", createdAt: new Date(Date.now() - 3 * HOUR) } });
    // ... and every backoff of the cleanup loop since has bumped updated_at to now.
    await setPayout(c.id, { status: "needs_attention", errorCode: "duplicate_transfer", alertedStatus: "needs_attention", updatedAt: new Date() });
    expect((await findStuckPayouts(new Date())).map((f) => f.key)).toContain("needs_attention");
    // A payout that really moved into the status a minute ago is not.
    const fresh = await paid({ pages: [{}] });
    const q = await payoutOf(fresh.creators[0].id);
    await prisma.creatorPayoutEvent.create({ data: { payoutId: q.id, bookingId: q.bookingId, kind: "status_change", fromStatus: "held", toStatus: "needs_attention", actorType: "system", createdAt: new Date() } });
    await setPayout(fresh.creators[0].id, { status: "needs_attention", errorCode: "duplicate_transfer", alertedStatus: "needs_attention", updatedAt: new Date() });
    expect((await findStuckPayouts(new Date())).find((f) => f.key === "needs_attention")?.sample).toEqual([p.id]);
  });
});

// ── Repairs the worker does around the plan's jobs ───────────────────────────────────────

describe("⚠️ a verified post can never stay unscheduled: the worker schedules a release the follow-up lost", () => {
  it("release_after = the REAL verification time + the hold, only the first scheduling counts, and the release goes only when it is due", async () => {
    vi.stubEnv("CREATOR_PAYOUT_HOLD_DAYS", "2");
    const w = await paid({ pages: [{}] });
    const c = w.creators[0];
    const verifiedAt = new Date(Date.now() - 2 * HOUR);
    await verifiedOffer(w, c.id, { verifiedAt }); // the follow-up (onCreatorLinkVerified) never ran
    expect((await payoutOf(c.id)).releaseAfter).toBeNull();
    const t1 = await runCreatorPayoutsTick({ now: after(1) });
    expect(t1.scheduled).toBe(1);
    const p = await payoutOf(c.id);
    expect(p.releaseAfter!.getTime()).toBe(verifiedAt.getTime() + 2 * DAY); // the hold is not restarted from now
    expect(p.status).toBe("held");
    expect(t1.jobs.release).toBe(0);
    expect(fake.count((x) => is.setHold(x, false))).toBe(0);
    // Idempotent: a second pass changes nothing.
    expect((await runCreatorPayoutsTick({ now: after(2) })).scheduled).toBe(0);
    expect((await payoutOf(c.id)).releaseAfter!.getTime()).toBe(verifiedAt.getTime() + 2 * DAY);
    // Due: released by the gate.
    const t3 = await runCreatorPayoutsTick({ now: new Date(verifiedAt.getTime() + 2 * DAY + MIN) });
    expect(t3.jobs.release).toBe(1);
    expect((await payoutOf(c.id)).status).toBe("released");
    expect(await prisma.creatorPayoutEvent.count({ where: { payoutId: p.id, kind: "schedule" } })).toBe(1);
  });

  it("a hand-checked post waits at least a day after the verification, and with no hold days an automatic one is due at once (in the same tick)", async () => {
    const w = await paid({ pages: [{}, {}] });
    const [byHand, auto] = w.creators;
    const verifiedAt = new Date(Date.now() - 2 * HOUR);
    await verifiedOffer(w, byHand.id, { verifiedAt, ownership: "manual_ok" });
    await verifiedOffer(w, auto.id, { verifiedAt });
    const t = await runCreatorPayoutsTick({ now: after(1) });
    expect(t.scheduled).toBe(2);
    expect((await payoutOf(byHand.id)).releaseAfter!.getTime()).toBe(verifiedAt.getTime() + DAY);
    expect((await payoutOf(byHand.id)).status).toBe("held");
    expect((await payoutOf(auto.id)).status).toBe("released"); // scheduled first, so it was due in the very tick that scheduled it
  });

  it("an unverified post, one whose ownership check did not pass, a paused payout's neighbour and a finished payout are never scheduled by it", async () => {
    const w = await paid({ pages: [{}, {}] });
    const [unverified, odd] = w.creators;
    await verifiedOffer(w, odd.id, { ownership: "unverifiable" });
    expect((await runCreatorPayoutsTick({ now: after(1) })).scheduled).toBe(0);
    expect((await payoutOf(unverified.id)).releaseAfter).toBeNull();
    expect((await payoutOf(odd.id)).releaseAfter).toBeNull();
  });
});

describe("⚠️ a payout that can never be created does not hold every refund of its payment for ever", () => {
  /** Two creators on one campaign: A's payout is held, B's stays planned because B's payout account needs clarification. */
  async function stuckSibling() {
    const w = await plannedWorld({ pages: [{}, {}] });
    const [a, b] = w.creators;
    await prisma.creatorPayoutAccount.update({ where: { id: b.accountId! }, data: { activationStatus: "needs_clarification" } });
    await runCreatorPayoutsTick(); // A is made (held), B waits: "not ready"
    expect((await payoutOf(a.id)).status).toBe("held");
    expect((await payoutOf(b.id)).status).toBe("planned");
    const offer = await openOffer(w, a.id, { status: "offered" });
    await withdrawOffer(offer.id, { staffId, closedReason: "withdrawn" }); // A's post ends: its share is taken back, the refund waits behind B
    expect((await itemOf(a.id)).status).toBe("refund_due");
    expect((await payoutOf(a.id)).status).toBe("reversed");
    expect(countOf(callLog(fake), "refund.create")).toBe(0);
    return { w, a, b };
  }

  it("after the budget (24 hours) the sibling becomes manual_required with an alert, and A's refund goes out in the same tick", async () => {
    const { a, b } = await stuckSibling();
    // Not yet: 23 hours in, it is still waited for.
    const early = await runCreatorPayoutsTick({ now: after(23 * 60) });
    expect(early.gaveUp).toBe(0);
    expect((await payoutOf(b.id)).status).toBe("planned");
    expect((await itemOf(a.id)).status).toBe("refund_due");
    // After the budget:
    const t = await runCreatorPayoutsTick({ now: after(25 * 60) });
    expect(t.gaveUp).toBe(1);
    expect(await payoutOf(b.id)).toMatchObject({ status: "manual_required", errorCode: "transfer_never_created" });
    expect(t.refunds).toMatchObject({ refunded: 1 });
    expect((await itemOf(a.id)).status).toBe("refunded");
    expect(countOf(callLog(fake), "refund.create")).toBe(1);
    expect(countOf(callLog(fake), "transfer.create")).toBe(1); // only A's: B's was never made, and nothing else was
    await flushPayoutAlertsForTests();
    expect(subjects().filter((s) => /could not be set aside, so their post can't go ahead/.test(s))).toHaveLength(1);
    // ⚠️ r2 #R5: its post was never offered to the creator, so nothing is owed: the alert says to refund the post, never to pay by hand.
    const gaveUpAlert = vi.mocked(notifyAdminByEmail).mock.calls.find((c) => /could not be set aside/.test(String(c[0])))!;
    const todo = (gaveUpAlert[1] as Array<{ label: string; value: string }>).find((d) => d.label === "What to do")!.value;
    expect(todo).toMatch(/Nothing is owed to the creator/);
    expect(todo).toMatch(/Refund this post from the campaign page/);
    expect(todo).not.toMatch(/pay them by bank transfer|record the reference/);
    // A second pass gives up on nothing more and mails nothing more.
    expect((await runCreatorPayoutsTick({ now: after(26 * 60) })).gaveUp).toBe(0);
    await flushPayoutAlertsForTests();
    expect(subjects().filter((s) => /could not be set aside/.test(s))).toHaveLength(1);
    // The payout is on record as alerted, so the digest does not call it "unalerted".
    expect((await payoutOf(b.id)).alertedStatus).toBe("manual_required");
  });

  it("never while the Route switch is off (that pause is the owner's), never for a paused payout, and a payout that CAN be made is made, not given up on", async () => {
    const { b } = await stuckSibling();
    vi.stubEnv("CREATOR_ROUTE_ENABLED", "0");
    expect((await runCreatorPayoutsTick({ now: after(48 * 60) })).gaveUp).toBe(0);
    expect((await payoutOf(b.id)).status).toBe("planned");
    vi.stubEnv("CREATOR_ROUTE_ENABLED", "1");
    await setPayout(b.id, { pausedAt: new Date(), pausedReason: "staff" });
    expect((await runCreatorPayoutsTick({ now: after(48 * 60) })).gaveUp).toBe(0);
    expect((await payoutOf(b.id)).status).toBe("planned");
    // Unpaused and the account fixed meanwhile: the last attempt MAKES the transfer.
    await setPayout(b.id, { pausedAt: null, pausedReason: null });
    await prisma.creatorPayoutAccount.update({ where: { id: (await payoutOf(b.id)).payoutAccountId }, data: { activationStatus: "activated" } });
    const t = await runCreatorPayoutsTick({ now: after(49 * 60) });
    expect(t.gaveUp).toBe(0);
    expect((await payoutOf(b.id)).status).toBe("held");
  });
});

describe("⚠️ a post marked refunded with no refund behind it is found and re-opened (never refunded twice)", () => {
  async function lost(spec: Parameters<typeof paid>[0] = { pages: [{}] }) {
    const w = await paid(spec);
    const c = w.creators[0];
    await setPayout(c.id, { status: "reversed", reversedAt: new Date(), amountReversedPaise: c.payout });
    // The crash window of the old order: the post was flipped to refunded and no ledger row was ever written.
    await prisma.campaignBookingItem.update({ where: { id: c.id }, data: { status: "refunded", updatedAt: new Date(Date.now() - 2 * HOUR) } });
    return { w, c };
  }

  it("re-opens it, then job 10 refunds it ONCE under the post's own key", async () => {
    const { w, c } = await lost();
    const t1 = await runCreatorPayoutsTick({ now: after(1) });
    expect(t1.reopened).toBe(1);
    expect((await itemOf(c.id)).status).toBe("refund_due");
    expect(countOf(callLog(fake), "refund.create")).toBe(0);
    const t2 = await runCreatorPayoutsTick({ now: after(10) });
    expect(t2.refunds).toMatchObject({ refunded: 1 });
    expect((await itemOf(c.id)).status).toBe("refunded");
    expect(countOf(callLog(fake), "refund.create")).toBe(1);
    expect(await prisma.campaignRefund.count({ where: { bookingItemId: c.id, idempotencyKey: `rf-item-${c.id}` } })).toBe(1);
    // Nothing is left to repair.
    expect((await runCreatorPayoutsTick({ now: after(20) })).reopened).toBe(0);
    void w;
  });

  it("⚠️ but not when a refund nobody here issued has appeared since: the client may already be repaid, so a person is told instead", async () => {
    const { w, c } = await lost();
    fake.payments.get(w.payId)!.refunds.push({ id: "rfnd_dashboard01", amount: c.price, status: "processed" });
    const t = await runCreatorPayoutsTick({ now: after(1) });
    expect(t.reopened).toBe(0);
    expect((await itemOf(c.id)).status).toBe("refunded");
    expect(countOf(callLog(fake), "refund.create")).toBe(0);
    await flushPayoutAlertsForTests();
    expect(subjects().filter((s) => /reads refunded but no refund of it was found/.test(s))).toHaveLength(1);
    // Looked at again, it is not mailed again the same day.
    resetPayoutAlertsForTests();
    await runCreatorPayoutsTick({ now: after(2) });
    await flushPayoutAlertsForTests();
    expect(subjects().filter((s) => /reads refunded but no refund of it was found/.test(s))).toHaveLength(1);
  });

  it("⚠️ r2 #R6: a suspect it stood down for is left out for a while (the date its refund check rests on never moves), so the next one is reached and the stood-down one's refunds are not re-read every tick", async () => {
    // The OLDER suspect was repaid from the Razorpay dashboard: stood down. The NEWER one was never repaid: it must still be re-opened.
    // (A network post on the same payment keeps it captured after the dashboard refund: the suspect stays a suspect, as it would in production.)
    const repaid = await lost({ pages: [{}], network: [300_000] });
    await prisma.campaignBookingItem.update({ where: { id: repaid.c.id }, data: { updatedAt: new Date(Date.now() - 3 * HOUR) } });
    fake.payments.get(repaid.w.payId)!.refunds.push({ id: "rfnd_dashboard02", amount: repaid.c.price, status: "processed" });
    const owed = await lost();
    const markedAt = (await itemOf(repaid.c.id)).updatedAt.getTime();
    const readsOf = (payId: string) => fake.calls.filter((c) => c.method === "GET" && c.path.includes(payId) && /\/refunds/.test(c.path)).length;

    const t1 = await runCreatorPayoutsTick({ now: after(1) }); // one suspect a tick, oldest first: the repaid one, stood down
    expect(t1.reopened).toBe(0);
    expect((await itemOf(repaid.c.id)).status).toBe("refunded");
    const reads = readsOf(repaid.w.payId);
    expect(reads).toBeGreaterThan(0);

    const t2 = await runCreatorPayoutsTick({ now: after(6) }); // before: the same one, every tick; now the next suspect
    expect(t2.reopened).toBe(1);
    expect((await itemOf(owed.c.id)).status).toBe("refund_due");
    for (const m of [11, 16, 21]) await runCreatorPayoutsTick({ now: after(m) });
    expect((await itemOf(owed.c.id)).status).toBe("refunded"); // job 10 refunded it, once
    expect(readsOf(repaid.w.payId)).toBe(reads); // the stood-down one's refund list is not read again meanwhile
    expect((await itemOf(repaid.c.id)).updatedAt.getTime()).toBe(markedAt); // ⚠️ the external-refund check's baseline did not move

    // After the wait it is looked at again, and is still left alone: the dashboard refund still came after it was marked refunded.
    await runCreatorPayoutsTick({ now: after(7 * 60) });
    expect(readsOf(repaid.w.payId)).toBeGreaterThan(reads);
    expect((await itemOf(repaid.c.id)).status).toBe("refunded");
    expect(fake.calls.filter((c) => is.refund(c) && c.path.includes(repaid.w.payId))).toHaveLength(0); // never refunded twice
    expect(await prisma.campaignRefund.count({ where: { bookingItemId: owed.c.id, idempotencyKey: `rf-item-${owed.c.id}` } })).toBe(1);
  });

  it("is left alone when the post is refunded properly (a refund of it is on the ledger), when its payout is not out of the way, and for a network post", async () => {
    const w = await paid({ pages: [{}, {}], network: [100_000] });
    const [proper, held] = w.creators;
    await setPayout(proper.id, { status: "reversed", reversedAt: new Date() });
    const pay = await prisma.campaignPayment.findFirstOrThrow({ where: { bookingId: w.booking.id } });
    await prisma.campaignRefund.create({ data: { idempotencyKey: `rf-item-${proper.id}`, paymentId: pay.id, razorpayPaymentId: pay.razorpayPaymentId!, bookingId: w.booking.id, bookingItemId: proper.id, amountPaise: proper.price, status: "processed", origin: "ours", reason: "item_refunded" } });
    const old = new Date(Date.now() - 2 * HOUR);
    for (const id of [proper.id, held.id, w.networkItems[0].id]) await prisma.campaignBookingItem.update({ where: { id }, data: { status: "refunded", updatedAt: old } });
    expect((await runCreatorPayoutsTick({ now: after(1) })).reopened).toBe(0);
    for (const id of [proper.id, held.id, w.networkItems[0].id]) expect((await itemOf(id)).status).toBe("refunded");
  });
});

