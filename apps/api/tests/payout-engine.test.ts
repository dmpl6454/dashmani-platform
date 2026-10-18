/**
 * The creator-payout ENGINE (services/creator/payout.service.ts), DB-backed, against a stateful fake of Razorpay's Route
 * API (tests/fake-razorpay-route.ts). The fake keeps real state (payments, transfers, holds, reversals, settlements,
 * disputes), so these tests prove properties of the money path, not that a canned answer was read:
 *
 *   - exactly one transfer per payout, however the create call fails or races;
 *   - a transfer is created again only after two empty listings far enough apart, once, and a twin is reversed;
 *   - "held" is claimed only for a processed, held, un-dated transfer; a processed transfer that is not held is parked,
 *     the hold is put back and staff are told;
 *   - a release moves nothing unless every condition holds on fresh facts, and every refusal makes NO Razorpay write;
 *   - a release claimed twice makes exactly one PATCH;
 *   - a reversal's amount is explicit and fresh, never "all"; an unknown answer is resolved by reading, never guessed;
 *   - paid_manual only when no transfer could still release;
 *   - nothing the engine stores or logs carries a bank detail, and paidAt is never written.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { prisma } from "@dashmani/db";

vi.mock("../src/services/email.service", async (orig) => {
  const actual = await orig<typeof import("../src/services/email.service")>();
  return { ...actual, sendEmail: vi.fn(async () => ({ messageId: "test" })), notifyAdminByEmail: vi.fn(async () => ({ messageId: "test" })) };
});

import { notifyAdminByEmail } from "../src/services/email.service";
import { flushPayoutAlertsForTests, resetPayoutAlertsForTests } from "../src/services/creator/payout-alert";
import {
  RELEASE_SWITCH_KEY,
  cleanUpDuplicates,
  confirmHold,
  executePlannedPayout,
  markManualPaid,
  pausePayout,
  pollSettlement,
  recheckHeld,
  releasePayout,
  reholdReleasedPayout,
  requireManualPayment,
  resolveRelease,
  resolveReversal,
  resolveUnknownTransfer,
  resumePayout,
  retryFailedPayout,
  reverseForRefund,
  reversePayout,
  refundAllowanceForPayment,
  reservedPaiseForPayment,
  runPayoutJob,
  scheduleRelease,
  selectDuePayouts,
  type StepResult,
} from "../src/services/creator/payout.service";
import { ABSENT_CHECK_GAP_MS } from "../src/services/creator/payout-policy";
import { FakeRazorpay, is } from "./fake-razorpay-route";
import { captureConsole, scanDatabase } from "./payout-privacy";

const fake = new FakeRazorpay();
const notify = vi.mocked(notifyAdminByEmail);

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const base = Date.now();
/** A time `min` minutes after the test started. The engine takes `now` so leases and gaps are exercised without sleeping. */
const T = (min: number) => new Date(base + min * MIN);

let seq = 0;

interface WorldOpts {
  payoutStatus?: string;
  amount?: number;
  bookingStatus?: string;
  itemStatus?: string;
  accountStatus?: string;
  paymentStatus?: string;
  /** An accepted, verified offer (the release gate needs one). */
  verified?: boolean;
  ownership?: string | null;
  releaseAfter?: Date | null;
  /** A transfer exists at Razorpay and the payout carries its id. Default: for every status after planned that has one. */
  transfer?: boolean;
  onHold?: boolean;
  transferStatus?: string;
  attempts?: number;
  paused?: boolean;
  bankChange?: boolean;
  paidAt?: Date;
}

/** Everything one payout needs: a booking and its paid item, the brand's payment, the creator's activated account, the fake's side of it. */
async function mkWorld(o: WorldOpts = {}) {
  const n = ++seq;
  const acc = `acc_P4ACCT${n}x`;
  const pay = `pay_P4PAY${n}x`;
  const product = `acc_prd_P4PROD${n}x`;
  const amount = o.amount ?? 50_000;
  const price = amount * 2;
  const status = o.payoutStatus ?? "planned";
  const client = await prisma.client.create({ data: { companyName: `Brand ${n}`, contactName: "Asha", email: `brand${n}@p4.test`, passwordHash: "x" } });
  const booking = await prisma.campaignBooking.create({
    data: { clientId: client.id, name: `Campaign ${n}`, brand: "Acme", status: o.bookingStatus ?? "paid_pending_review", paidAt: o.paidAt ?? new Date("2026-10-10T10:00:00.000Z"), totalPaise: price },
  });
  const item = await prisma.campaignBookingItem.create({
    data: { bookingId: booking.id, rateCardId: randomUUID(), targetType: "creator_asset", targetId: randomUUID(), platform: "instagram", format: "post", accountName: "Creator Page", pricePaise: price, status: o.itemStatus ?? "pending" },
  });
  await prisma.campaignPayment.create({ data: { bookingId: booking.id, razorpayOrderId: `order_P4${n}x`, razorpayPaymentId: pay, amountPaise: price, status: o.paymentStatus ?? "captured" } });
  const creatorId = randomUUID();
  const account = await prisma.creatorPayoutAccount.create({
    data: {
      creatorId,
      razorpayAccountId: acc,
      razorpayProductId: product,
      setupStep: "done",
      activationStatus: o.accountStatus ?? "activated",
      destinationHint: "HDFC ••••1234",
      ...(o.bankChange ? { bankChangeRequestedAt: new Date(base - DAY) } : {}),
    },
  });
  fake.seedAccount({ id: acc, email: `creator${n}@p4.test`, productId: product, status: o.accountStatus ?? "activated" });
  fake.seedPayment({ id: pay, amount: price });

  const payoutId = randomUUID();
  const hasTransfer = o.transfer ?? !["planned", "void", "transfer_requested"].includes(status);
  let transferId: string | null = null;
  if (hasTransfer) {
    const released = ["released", "settled", "settlement_failed"].includes(status);
    const t = fake.seedTransfer({ source: pay, recipient: acc, amount, status: o.transferStatus ?? "processed", onHold: o.onHold ?? !released, notes: { payout_id: payoutId, booking_item_id: item.id } });
    transferId = t.id;
  }
  const payout = await prisma.creatorPayout.create({
    data: {
      id: payoutId,
      bookingId: booking.id,
      bookingItemId: item.id,
      creatorId,
      payoutAccountId: account.id,
      razorpayAccountId: acc,
      razorpayPaymentId: pay,
      itemPricePaise: price,
      shareBps: 5000,
      grossPaise: amount,
      amountPaise: amount,
      status,
      razorpayTransferId: transferId,
      attempts: o.attempts ?? (status === "planned" ? 0 : 1),
      releaseAfter: o.releaseAfter === undefined ? new Date(base - MIN) : o.releaseAfter,
      pausedAt: o.paused ? new Date(base - MIN) : null,
      pausedReason: o.paused ? "staff" : null,
      releasedAt: ["released", "settled", "settlement_failed"].includes(status) ? new Date(base - 5 * MIN) : null,
    },
  });
  if (o.verified) {
    await prisma.creatorOffer.create({
      data: {
        bookingId: booking.id,
        bookingItemId: item.id,
        creatorId,
        creatorAssetId: randomUUID(),
        pageName: "Creator Page",
        platform: "instagram",
        format: "post",
        status: "completed",
        payoutPaise: amount,
        expiresAt: new Date(base + DAY),
        linkVerifiedAt: new Date(base - 2 * MIN),
        ownershipCheck: o.ownership === undefined ? "auto_ok" : o.ownership,
      },
    });
  }
  return { n, acc, pay, product, booking, item, account, payout, creatorId, transferId, amount, price };
}
type World = Awaited<ReturnType<typeof mkWorld>>;

/** A payout that satisfies the whole release gate: held, its item live, its offer verified, release_after passed. */
const releasable = (o: WorldOpts = {}) => mkWorld({ payoutStatus: "held", bookingStatus: "approved", itemStatus: "posted_manual", verified: true, ...o });

const reload = (id: string) => prisma.creatorPayout.findUniqueOrThrow({ where: { id } });
const eventsOf = (id: string) => prisma.creatorPayoutEvent.findMany({ where: { payoutId: id }, orderBy: { createdAt: "asc" } });
const subjects = () => notify.mock.calls.map((c) => String(c[0]));
const flush = () => flushPayoutAlertsForTests();
const createCalls = () => fake.calls.filter(is.createTransfer);
const holdCalls = (onHold?: boolean) => fake.calls.filter((c) => is.setHold(c, onHold));

beforeAll(() => fake.install());
afterAll(() => fake.restore());
beforeEach(async () => {
  fake.reset();
  resetPayoutAlertsForTests();
  // system_settings is not truncated between tests (tests/setup.ts), and the kill switch would leak into the next one.
  await prisma.systemSetting.deleteMany({ where: { key: RELEASE_SWITCH_KEY } });
  notify.mockClear();
  vi.stubEnv("RAZORPAY_KEY_ID", "rzp_test_key");
  vi.stubEnv("RAZORPAY_KEY_SECRET", "rzp_test_secret");
  vi.stubEnv("CREATOR_ROUTE_ENABLED", "1");
  vi.stubEnv("CREATOR_PAYOUT_HOLD_DAYS", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

// ═══════════════════════════════════════════════════════════════════════════════
describe("executePlannedPayout: planned → transfer_requested → held", () => {
  it("creates ONE held transfer carrying only our ids, records its id, and reaches held", async () => {
    const w = await mkWorld();
    const r = await executePlannedPayout(w.payout.id, { now: T(0) });
    expect(r).toMatchObject({ ok: true, outcome: "held", status: "held" });

    const calls = createCalls();
    expect(calls).toHaveLength(1);
    // The body is exactly what the plan allows: no brand price, no linked_account_notes, never un-held.
    expect(calls[0].path).toBe(`/v1/payments/${w.pay}/transfers`);
    expect(calls[0].body).toEqual({ transfers: [{ account: w.acc, amount: w.amount, currency: "INR", on_hold: true, notes: { payout_id: w.payout.id, booking_item_id: w.item.id } }] });

    const p = await reload(w.payout.id);
    expect(p).toMatchObject({ status: "held", attempts: 1, transferStatus: "processed", errorCode: null });
    expect(p.razorpayTransferId).toMatch(/^trf_/);
    expect(p.heldAt).not.toBeNull();
    expect(p.onHoldVerifiedAt).not.toBeNull();
    expect(p.lockedUntil).toBeNull();
    expect(fake.transfers.size).toBe(1);
    const t = [...fake.transfers.values()][0];
    expect(t).toMatchObject({ onHold: true, onHoldUntil: null, amount: w.amount, recipient: w.acc, source: w.pay });

    const ev = await eventsOf(w.payout.id);
    expect(ev.map((e) => `${e.fromStatus}>${e.toStatus}`)).toEqual(["planned>transfer_requested", "transfer_requested>transfer_requested", "transfer_requested>held"]);
    expect(ev.every((e) => e.actorType === "system")).toBe(true);
  });

  it("a pause that lands after the checks but before the claim stops the transfer: no Razorpay call, still planned", async () => {
    const w = await mkWorld();
    const r = await executePlannedPayout(w.payout.id, {
      now: T(0),
      hooks: { beforeClaim: async () => void (await prisma.creatorPayout.update({ where: { id: w.payout.id }, data: { pausedAt: new Date(), pausedReason: "staff" } })) },
    });
    expect(r).toMatchObject({ ok: false, outcome: "lost_claim", status: "planned", calls: 0 });
    expect(createCalls()).toHaveLength(0);
    expect(await reload(w.payout.id)).toMatchObject({ status: "planned", attempts: 0, lockedUntil: null });
  });

  it("never touches the booking's paidAt", async () => {
    const paidAt = new Date("2026-09-09T09:09:09.000Z");
    const w = await mkWorld({ paidAt });
    await executePlannedPayout(w.payout.id, { now: T(0) });
    expect((await prisma.campaignBooking.findUniqueOrThrow({ where: { id: w.booking.id } })).paidAt).toEqual(paidAt);
    // …and the engine has no way to: no write to it exists in its source.
    const src = readFileSync(join(__dirname, "../src/services/creator/payout.service.ts"), "utf8");
    expect(src).not.toMatch(/paidAt\s*[:=]/);
  });

  it("a created-but-pending transfer is NOT held until Razorpay reports it processed", async () => {
    fake.createStatus = "pending";
    const w = await mkWorld();
    const r = await executePlannedPayout(w.payout.id, { now: T(0) });
    expect(r).toMatchObject({ ok: false, outcome: "in_flight", status: "transfer_requested" });
    const p = await reload(w.payout.id);
    // The id was recorded at once, and the row waits for the transfer to process.
    expect(p.razorpayTransferId).toMatch(/^trf_/);
    expect(p.heldAt).toBeNull();
    expect(p.nextAttemptAt).not.toBeNull();

    // Still pending: still not held.
    expect(await confirmHold(w.payout.id, { now: T(3) })).toMatchObject({ ok: false, outcome: "in_flight", status: "transfer_requested" });
    fake.processTransfer(p.razorpayTransferId!);
    expect(await confirmHold(w.payout.id, { now: T(6) })).toMatchObject({ ok: true, outcome: "held", status: "held" });
    expect(createCalls()).toHaveLength(1);
  });

  it("a processed transfer that is NOT on hold is never called held: parked, the hold is put back, staff are told, then it resolves", async () => {
    fake.intercept({ match: is.createTransfer, mode: "pass", afterCreate: (t) => (t.onHold = false) });
    const w = await mkWorld();
    const r = await executePlannedPayout(w.payout.id, { now: T(0) });
    expect(r).toMatchObject({ ok: false, outcome: "parked", status: "needs_attention", reason: "processed_not_held" });
    const p = await reload(w.payout.id);
    expect(p).toMatchObject({ status: "needs_attention", errorCode: "processed_not_held", heldAt: null });
    expect(p.lastError).toMatch(/NOT on hold/);
    // The engine PATCHed on_hold:true at once.
    expect(holdCalls(true)).toHaveLength(1);
    expect(holdCalls(false)).toHaveLength(0);
    expect([...fake.transfers.values()][0].onHold).toBe(true);
    await flush();
    expect(subjects().some((s) => /NOT on hold/.test(s))).toBe(true);

    // A fresh read now shows it held: the parked payout resolves to held, and only then.
    expect(await confirmHold(w.payout.id, { now: T(1) })).toMatchObject({ ok: true, outcome: "held", status: "held" });
    expect(await reload(w.payout.id)).toMatchObject({ status: "held", errorCode: null });
  });

  it("a transfer with an automatic release date is also never called held", async () => {
    fake.intercept({ match: is.createTransfer, mode: "pass", afterCreate: (t) => (t.onHoldUntil = 1_900_000_000) });
    const w = await mkWorld();
    const r = await executePlannedPayout(w.payout.id, { now: T(0) });
    expect(r).toMatchObject({ status: "needs_attention", reason: "processed_hold_expires" });
    expect(holdCalls(true)).toHaveLength(1);
    expect([...fake.transfers.values()][0].onHoldUntil).toBeNull();
  });

  it("a definite refusal is `failed`: the code and a scrubbed reason are kept, no id, staff are told", async () => {
    fake.balance = 10;
    const w = await mkWorld();
    const r = await executePlannedPayout(w.payout.id, { now: T(0) });
    expect(r).toMatchObject({ ok: false, outcome: "failed", status: "failed" });
    const p = await reload(w.payout.id);
    expect(p).toMatchObject({ status: "failed", razorpayTransferId: null, attempts: 1, errorCode: "BAD_REQUEST_ERROR", lockedUntil: null });
    expect(p.lastError).toMatch(/not have enough balance/);
    await flush();
    expect(subjects()).toContain("Creator payout transfer FAILED");
    expect(fake.transfers.size).toBe(0);
  });

  it("a refusal that arrives while a refund has just appeared on the payment goes straight to manual_required", async () => {
    const w = await mkWorld();
    fake.intercept({
      match: is.createTransfer,
      mode: "reject",
      status: 400,
      body: { error: { code: "BAD_REQUEST_ERROR", description: "Refund initiated" } },
      // The refund lands after the checks passed and before Razorpay's refusal comes back.
      before: async () => {
        await prisma.campaignRefund.create({ data: { razorpayPaymentId: w.pay, amountPaise: 100, status: "processed", origin: "external" } });
      },
    });
    const r = await executePlannedPayout(w.payout.id, { now: T(0) });
    expect(r).toMatchObject({ ok: false, outcome: "manual_required", status: "manual_required", reason: "refund_exists" });
    expect(createCalls()).toHaveLength(1);
    expect((await eventsOf(w.payout.id)).map((e) => e.toStatus)).toEqual(["transfer_requested", "failed", "manual_required"]);
  });

  it("Retry of a failed transfer is refused once any refund exists, and a FAILED refund does not count", async () => {
    fake.balance = 10;
    const w = await mkWorld();
    expect((await executePlannedPayout(w.payout.id, { now: T(0) })).status).toBe("failed");
    await prisma.campaignRefund.create({ data: { razorpayPaymentId: w.pay, amountPaise: 100, status: "failed", origin: "ours" } });
    fake.balance = 100_000_000;
    // A failed refund returned nothing: Retry is allowed, and creates the transfer.
    expect(await retryFailedPayout(w.payout.id, { now: T(1) })).toMatchObject({ ok: true, outcome: "held", status: "held" });
    const x = await mkWorld();
    fake.balance = 10;
    await executePlannedPayout(x.payout.id, { now: T(0) });
    await prisma.campaignRefund.create({ data: { razorpayPaymentId: x.pay, amountPaise: 100, status: "processed", origin: "external" } });
    expect(await retryFailedPayout(x.payout.id, { now: T(1) })).toMatchObject({ ok: false, outcome: "retry_disabled", reason: "refund_exists" });
    expect((await reload(x.payout.id)).status).toBe("failed");
  });

  it("an unknown answer (applied but lost, never reached, a 502, unreadable 2xx) keeps the claim, makes no second request, and never claims held", async () => {
    for (const mode of ["lose", "drop", "badgateway", "garbage"] as const) {
      fake.reset();
      resetPayoutAlertsForTests();
      const w = await mkWorld();
      fake.intercept({ match: is.createTransfer, mode });
      const r = await executePlannedPayout(w.payout.id, { now: T(0) });
      expect(r, mode).toMatchObject({ ok: false, outcome: "unknown", status: "transfer_requested" });
      const p = await reload(w.payout.id);
      expect(p, mode).toMatchObject({ status: "transfer_requested", razorpayTransferId: null, attempts: 1, errorCode: "create_result_unknown" });
      expect(p.nextAttemptAt, mode).not.toBeNull();
      // A second call does NOT create another transfer.
      expect(await executePlannedPayout(w.payout.id, { now: T(1) }), mode).toMatchObject({ outcome: "not_planned" });
      expect(createCalls(), mode).toHaveLength(1);
      // What Razorpay holds: one transfer if the request landed, none if it never did.
      expect(fake.transfers.size, mode).toBe(mode === "drop" ? 0 : 1);
    }
  });

  it("two callers at once make exactly one transfer", async () => {
    const w = await mkWorld();
    const [a, b] = await Promise.all([executePlannedPayout(w.payout.id, { now: T(0) }), executePlannedPayout(w.payout.id, { now: T(0) })]);
    expect([a.outcome, b.outcome].sort()).toEqual(expect.arrayContaining(["held"]));
    expect(createCalls()).toHaveLength(1);
    expect(fake.transfers.size).toBe(1);
  });

  it("waits, claims nothing and calls nothing for every doubt", async () => {
    const cases: Array<[string, WorldOpts, string]> = [
      ["paused", { paused: true }, "paused"],
      ["booking rejected", { bookingStatus: "rejected" }, "booking_closed"],
      ["item refund_due", { itemStatus: "refund_due" }, "item_closed"],
      ["item refunded", { itemStatus: "refunded" }, "item_closed"],
      ["account not activated", { accountStatus: "under_review" }, "account_not_ready"],
      ["payment not captured", { paymentStatus: "refund_due" }, "payment_not_captured"],
      ["amount below the floor", { amount: 9_999 }, "amount_too_small"],
    ];
    for (const [name, o, reason] of cases) {
      fake.reset();
      const w = await mkWorld(o);
      const r = await executePlannedPayout(w.payout.id, { now: T(0) });
      expect(r, name).toMatchObject({ ok: false, outcome: "waiting", reason, status: "planned", calls: 0 });
      expect(fake.calls, name).toHaveLength(0);
      expect((await reload(w.payout.id)).status, name).toBe("planned");
      expect(await eventsOf(w.payout.id), name).toHaveLength(0);
    }
  });

  it("is dark: the Route switch off, or no Razorpay keys, makes no claim and no call", async () => {
    const w = await mkWorld();
    vi.stubEnv("CREATOR_ROUTE_ENABLED", "");
    expect(await executePlannedPayout(w.payout.id, { now: T(0) })).toMatchObject({ ok: false, outcome: "disabled", status: "planned" });
    vi.stubEnv("CREATOR_ROUTE_ENABLED", "1");
    vi.stubEnv("RAZORPAY_KEY_ID", "");
    expect(await executePlannedPayout(w.payout.id, { now: T(0) })).toMatchObject({ outcome: "disabled" });
    expect(fake.calls).toHaveLength(0);
    expect((await reload(w.payout.id)).status).toBe("planned");
  });

  it("a refund that already exists on the payment makes the payout manual_required: no transfer can be made", async () => {
    const w = await mkWorld();
    await prisma.campaignRefund.create({ data: { razorpayPaymentId: w.pay, amountPaise: 1000, status: "processed", origin: "external" } });
    const r = await executePlannedPayout(w.payout.id, { now: T(0) });
    expect(r).toMatchObject({ ok: true, outcome: "manual_required", status: "manual_required", reason: "refund_exists", calls: 0 });
    expect(createCalls()).toHaveLength(0);
    await flush();
    expect(subjects()).toContain("Creator payout needs a manual bank transfer");
  });

  it("a pending or processed refund on the payment's own row counts too", async () => {
    const w = await mkWorld({ paymentStatus: "refund_pending" });
    const r = await executePlannedPayout(w.payout.id, { now: T(0) });
    expect(r).toMatchObject({ outcome: "manual_required" });
  });

  it("only a planned payout is executed", async () => {
    for (const status of ["held", "released", "void", "failed", "reversed", "settled"]) {
      const w = await mkWorld({ payoutStatus: status });
      expect((await executePlannedPayout(w.payout.id, { now: T(0) })).outcome, status).toBe("not_planned");
    }
    expect(createCalls()).toHaveLength(0);
    expect(await executePlannedPayout(randomUUID())).toMatchObject({ outcome: "not_found", status: null });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe("resolveUnknownTransfer: an unknown create result is settled by READING Razorpay", () => {
  /** An unknown create whose transfer did land. hide = the number of listings that do not show it yet. */
  async function lostCreate(mode: "lose" | "drop", hide = 0) {
    const w = await mkWorld();
    fake.intercept({ match: is.createTransfer, mode, hideFromListings: hide });
    await executePlannedPayout(w.payout.id, { now: T(0) });
    return w;
  }

  it("a late listing ends with exactly ONE transfer: no second create call is ever sent", async () => {
    const w = await lostCreate("lose", 1);
    // Listing 1: the transfer is not visible yet. One empty listing proves nothing.
    expect(await resolveUnknownTransfer(w.payout.id, { now: T(3) })).toMatchObject({ ok: false, outcome: "waiting" });
    expect(await reload(w.payout.id)).toMatchObject({ status: "transfer_requested", absentChecks: 1, razorpayTransferId: null });
    // Listing 2, far enough on: now it shows. It is adopted.
    const r = await resolveUnknownTransfer(w.payout.id, { now: T(15) });
    expect(r).toMatchObject({ ok: true, outcome: "held", status: "held" });
    expect(createCalls()).toHaveLength(1);
    expect(fake.transfers.size).toBe(1);
    expect((await reload(w.payout.id)).razorpayTransferId).toBe([...fake.transfers.keys()][0]);
  });

  it("a transfer that is visible at once is adopted on the first listing", async () => {
    const w = await lostCreate("lose", 0);
    expect(await resolveUnknownTransfer(w.payout.id, { now: T(3) })).toMatchObject({ ok: true, outcome: "held" });
    expect(createCalls()).toHaveLength(1);
  });

  it("two listings must be ≥ the gap apart: a second one too soon does not count and sends nothing", async () => {
    const w = await lostCreate("drop");
    expect(await resolveUnknownTransfer(w.payout.id, { now: T(3) })).toMatchObject({ outcome: "waiting" });
    const early = await resolveUnknownTransfer(w.payout.id, { now: new Date(T(3).getTime() + ABSENT_CHECK_GAP_MS - 1000) });
    expect(early).toMatchObject({ outcome: "waiting" });
    expect(await reload(w.payout.id)).toMatchObject({ absentChecks: 1, attempts: 1 });
    expect(createCalls()).toHaveLength(1);
  });

  it("a request that never landed is sent ONCE more, after two empty listings, and then reaches held", async () => {
    const w = await lostCreate("drop");
    expect((await resolveUnknownTransfer(w.payout.id, { now: T(3) })).outcome).toBe("waiting");
    const r = await resolveUnknownTransfer(w.payout.id, { now: T(15) });
    expect(r).toMatchObject({ ok: false, outcome: "audit_pending", status: "transfer_requested" });
    expect(createCalls()).toHaveLength(2);
    expect(fake.transfers.size).toBe(1);
    const p = await reload(w.payout.id);
    expect(p).toMatchObject({ attempts: 2, absentChecks: 0 });
    expect(p.razorpayTransferId).toBe([...fake.transfers.keys()][0]);

    // The request was repeated, so it is not called held until a listing proves there is no twin, a gap after the last request.
    expect(await confirmHold(w.payout.id, { now: T(16) })).toMatchObject({ outcome: "audit_wait" });
    expect(await confirmHold(w.payout.id, { now: T(30) })).toMatchObject({ ok: true, outcome: "held" });
    expect(fake.transfers.size).toBe(1);
  });

  it("a transfer id that another path records between the second empty listing and the retry claim stops the retry: no second create", async () => {
    const w = await lostCreate("drop");
    expect((await resolveUnknownTransfer(w.payout.id, { now: T(3) })).outcome).toBe("waiting");
    // The webhook (or a staff read) adopts the transfer while this step is still reading the second listing.
    fake.intercept({
      match: is.listTransfers,
      mode: "pass",
      before: async () => void (await prisma.creatorPayout.update({ where: { id: w.payout.id }, data: { razorpayTransferId: "trf_ADOPTEDBYHOOK1" } })),
    });
    const r = await resolveUnknownTransfer(w.payout.id, { now: T(15) });
    expect(r).toMatchObject({ ok: false, outcome: "lost_claim" });
    expect(createCalls()).toHaveLength(1);
    expect(await reload(w.payout.id)).toMatchObject({ attempts: 1, razorpayTransferId: "trf_ADOPTEDBYHOOK1" });
  });

  it("the retry is bounded: another lost answer and two more empty listings park it for a person, with exactly two create calls", async () => {
    const w = await mkWorld();
    fake.intercept({ match: is.createTransfer, mode: "drop", times: 2 });
    await executePlannedPayout(w.payout.id, { now: T(0) });
    await resolveUnknownTransfer(w.payout.id, { now: T(3) });
    const retry = await resolveUnknownTransfer(w.payout.id, { now: T(15) }); // the retry is dropped too
    expect(retry).toMatchObject({ outcome: "unknown" });
    expect(await reload(w.payout.id)).toMatchObject({ attempts: 2, status: "transfer_requested", razorpayTransferId: null });
    await resolveUnknownTransfer(w.payout.id, { now: T(30) });
    const last = await resolveUnknownTransfer(w.payout.id, { now: T(45) });
    expect(last).toMatchObject({ ok: false, outcome: "parked", status: "needs_attention", reason: "transfer_unknown_after_retry" });
    expect(createCalls()).toHaveLength(2);
    expect(fake.transfers.size).toBe(0);
    await flush();
    expect(subjects().some((s) => /needs attention/i.test(s))).toBe(true);
  });

  it("a twin that appears after the retry is found by the audit: one is kept, the extra is REVERSED while still on hold", async () => {
    // The first request landed but stays invisible for two listings; the retry then makes a second transfer.
    const w = await lostCreate("lose", 2);
    await resolveUnknownTransfer(w.payout.id, { now: T(3) });
    await resolveUnknownTransfer(w.payout.id, { now: T(15) }); // retry → a second transfer
    expect(createCalls()).toHaveLength(2);
    expect(fake.transfers.size).toBe(2);
    const stored = (await reload(w.payout.id)).razorpayTransferId!;

    // The audit, a gap after the retry, lists BOTH.
    const r = await confirmHold(w.payout.id, { now: T(30) });
    expect(r).toMatchObject({ ok: false, outcome: "duplicates", status: "needs_attention" });
    expect((await reload(w.payout.id)).razorpayTransferId).toBe(stored);
    // Exactly one live transfer remains, the kept one; the extra was reversed with an EXPLICIT amount.
    const live = fake.liveTransfersFor(w.payout.id);
    expect(live.map((t) => t.id)).toEqual([stored]);
    const reversals = fake.calls.filter(is.createReversal);
    expect(reversals).toHaveLength(1);
    expect(reversals[0].body.amount).toBe(w.amount);
    await flush();
    expect(subjects()).toContain("A duplicate creator payout transfer was found");

    // cleanUpDuplicates lists again, sees exactly the kept one, and hands the payout back to held on a fresh read.
    expect(await cleanUpDuplicates(w.payout.id, { now: T(45) })).toMatchObject({ ok: true, outcome: "held", status: "held" });
    expect(fake.liveTransfersFor(w.payout.id)).toHaveLength(1);
  });

  it("a duplicate that cannot be reversed is reported and the payout stays parked (never held)", async () => {
    const w = await lostCreate("lose", 2);
    await resolveUnknownTransfer(w.payout.id, { now: T(3) });
    await resolveUnknownTransfer(w.payout.id, { now: T(15) });
    fake.intercept({ match: is.createReversal, mode: "reject", status: 400, times: 5 });
    const r = await confirmHold(w.payout.id, { now: T(30) });
    expect(r).toMatchObject({ outcome: "duplicates", reason: "extras_not_reversed" });
    expect((await reload(w.payout.id)).status).toBe("needs_attention");
    expect(await cleanUpDuplicates(w.payout.id, { now: T(45) })).toMatchObject({ ok: false, outcome: "extras_remaining" });
    expect((await reload(w.payout.id)).status).toBe("needs_attention");
  });

  it("two transfers found by the FIRST listing are handled as duplicates, and the earlier one is kept", async () => {
    const w = await mkWorld({ payoutStatus: "transfer_requested", attempts: 1 });
    const a = fake.seedTransfer({ source: w.pay, recipient: w.acc, amount: w.amount, notes: { payout_id: w.payout.id, booking_item_id: w.item.id } });
    a.createdAt = 100;
    const b = fake.seedTransfer({ source: w.pay, recipient: w.acc, amount: w.amount, notes: { payout_id: w.payout.id, booking_item_id: w.item.id } });
    b.createdAt = 200;
    const r = await resolveUnknownTransfer(w.payout.id, { now: T(3) });
    expect(r).toMatchObject({ outcome: "duplicates", status: "needs_attention" });
    expect((await reload(w.payout.id)).razorpayTransferId).toBe(a.id);
    expect(fake.liveTransfersFor(w.payout.id).map((t) => t.id)).toEqual([a.id]);
  });

  it("a twin that was already part-reversed is reversed only for what is left, never its full amount", async () => {
    const w = await mkWorld({ payoutStatus: "transfer_requested", attempts: 1 });
    const a = fake.seedTransfer({ source: w.pay, recipient: w.acc, amount: w.amount, notes: { payout_id: w.payout.id, booking_item_id: w.item.id } });
    a.createdAt = 100;
    const b = fake.seedTransfer({ source: w.pay, recipient: w.acc, amount: w.amount, amountReversed: 300, notes: { payout_id: w.payout.id, booking_item_id: w.item.id } });
    b.createdAt = 200;
    const r = await resolveUnknownTransfer(w.payout.id, { now: T(3) });
    expect(r).toMatchObject({ outcome: "duplicates", status: "needs_attention" });
    const reversals = fake.calls.filter(is.createReversal);
    expect(reversals).toHaveLength(1);
    expect(reversals[0].path).toContain(b.id);
    expect(reversals[0].body.amount).toBe(w.amount - 300);
    expect(fake.liveTransfersFor(w.payout.id).map((t) => t.id)).toEqual([a.id]);
  });

  it("a failed listing changes nothing and never counts as an empty one", async () => {
    const w = await lostCreate("drop");
    fake.intercept({ match: is.listTransfers, mode: "reject", status: 500, times: 3 });
    const r = await resolveUnknownTransfer(w.payout.id, { now: T(3) });
    expect(r).toMatchObject({ ok: false, outcome: "unread" });
    expect(await reload(w.payout.id)).toMatchObject({ absentChecks: 0, attempts: 1, status: "transfer_requested" });
    expect(createCalls()).toHaveLength(1);
  });

  it("with a refund on the payment, two empty listings go to manual_required instead of a retry", async () => {
    const w = await lostCreate("drop");
    await prisma.campaignRefund.create({ data: { razorpayPaymentId: w.pay, amountPaise: 100, status: "processed", origin: "external" } });
    await resolveUnknownTransfer(w.payout.id, { now: T(3) });
    const r = await resolveUnknownTransfer(w.payout.id, { now: T(15) });
    expect(r).toMatchObject({ outcome: "manual_required", status: "manual_required", reason: "no_transfer_after_refund" });
    expect(createCalls()).toHaveLength(1);
  });

  it("a carrier that is for another amount or recipient is parked as a mismatch, not adopted", async () => {
    const w = await mkWorld({ payoutStatus: "transfer_requested", attempts: 1 });
    fake.seedTransfer({ source: w.pay, recipient: "acc_SOMEONEELSE1", amount: w.amount, notes: { payout_id: w.payout.id } });
    const r = await resolveUnknownTransfer(w.payout.id, { now: T(3) });
    expect(r).toMatchObject({ outcome: "parked", status: "needs_attention", reason: "transfer_mismatch" });
    expect((await reload(w.payout.id)).razorpayTransferId).toBeNull();
  });

  it("a lone FAILED carrier is a definite failure", async () => {
    const w = await mkWorld({ payoutStatus: "transfer_requested", attempts: 1 });
    fake.seedTransfer({ source: w.pay, recipient: w.acc, amount: w.amount, status: "failed", notes: { payout_id: w.payout.id } });
    const r = await resolveUnknownTransfer(w.payout.id, { now: T(3) });
    expect(r).toMatchObject({ status: "failed" });
    expect(createCalls()).toHaveLength(0);
  });

  it("only a transfer_requested payout with no id is resolved, and a leased one is left alone", async () => {
    const held = await mkWorld({ payoutStatus: "held" });
    expect((await resolveUnknownTransfer(held.payout.id, { now: T(3) })).outcome).toBe("not_applicable");
    const w = await mkWorld({ payoutStatus: "transfer_requested", attempts: 1 });
    await prisma.creatorPayout.update({ where: { id: w.payout.id }, data: { lockedUntil: T(10) } });
    expect(await resolveUnknownTransfer(w.payout.id, { now: T(3) })).toMatchObject({ outcome: "leased" });
    expect(fake.calls).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe("confirmHold and the daily re-read of a held payout", () => {
  it("stamps a fresh verification on a held payout and changes nothing else", async () => {
    const w = await mkWorld({ payoutStatus: "held" });
    expect(await recheckHeld(w.payout.id, { now: T(0) })).toMatchObject({ ok: true, outcome: "confirmed_held", status: "held" });
    const p = await reload(w.payout.id);
    expect(p.onHoldVerifiedAt).not.toBeNull();
    expect(p.lastCheckedAt).not.toBeNull();
    expect(fake.writes()).toHaveLength(0);
  });

  it("a hold lifted in the Razorpay dashboard is caught: parked, the hold put back, staff told, then it resolves to held", async () => {
    const w = await mkWorld({ payoutStatus: "held" });
    fake.transfers.get(w.transferId!)!.onHold = false; // somebody released it by hand
    const r = await recheckHeld(w.payout.id, { now: T(0) });
    expect(r).toMatchObject({ ok: false, outcome: "parked", status: "needs_attention", reason: "released_outside_flow" });
    expect(holdCalls(true)).toHaveLength(1);
    expect(fake.transfers.get(w.transferId!)!.onHold).toBe(true);
    await flush();
    expect(subjects().some((s) => /NOT on hold/.test(s))).toBe(true);
    expect(await confirmHold(w.payout.id, { now: T(10) })).toMatchObject({ ok: true, outcome: "held" });
  });

  it("an automatic release date set in the dashboard parks it as well", async () => {
    const w = await mkWorld({ payoutStatus: "held" });
    fake.transfers.get(w.transferId!)!.onHoldUntil = 1_900_000_000;
    expect(await recheckHeld(w.payout.id, { now: T(0) })).toMatchObject({ status: "needs_attention", reason: "hold_expires" });
    expect(fake.transfers.get(w.transferId!)!.onHoldUntil).toBeNull();
  });

  it("a transfer reversed outside our flow parks the payout instead of pretending it is held", async () => {
    const w = await mkWorld({ payoutStatus: "held" });
    const t = fake.transfers.get(w.transferId!)!;
    t.amountReversed = t.amount;
    t.status = "reversed";
    expect(await recheckHeld(w.payout.id, { now: T(0) })).toMatchObject({ status: "needs_attention", reason: "reversed_outside_flow" });
    expect(fake.writes()).toHaveLength(0);
  });

  it("a failed transfer is recorded as failed, with a code and an alert", async () => {
    const w = await mkWorld({ payoutStatus: "transfer_requested", transfer: true, transferStatus: "pending" });
    fake.failTransfer(w.transferId!);
    expect(await confirmHold(w.payout.id, { now: T(0) })).toMatchObject({ ok: false, outcome: "failed", status: "failed" });
    await flush();
    expect(subjects()).toContain("Creator payout transfer FAILED");
  });

  it("a transfer that is not the payout's own (another amount) is parked as a mismatch", async () => {
    const w = await mkWorld({ payoutStatus: "transfer_requested", transfer: true, transferStatus: "pending" });
    fake.transfers.get(w.transferId!)!.amount = w.amount - 1;
    expect(await confirmHold(w.payout.id, { now: T(0) })).toMatchObject({ outcome: "mismatch", status: "needs_attention", reason: "transfer_mismatch" });
  });

  it("an unreadable fetch leaves the status alone and schedules another look", async () => {
    const w = await mkWorld({ payoutStatus: "transfer_requested", transfer: true, transferStatus: "pending" });
    fake.intercept({ match: is.fetchTransfer, mode: "reject", status: 500 });
    expect(await confirmHold(w.payout.id, { now: T(0) })).toMatchObject({ ok: false, outcome: "unread", status: "transfer_requested" });
    const p = await reload(w.payout.id);
    expect(p).toMatchObject({ status: "transfer_requested", errorCode: "fetch_failed", lockedUntil: null });
    expect(p.nextAttemptAt).not.toBeNull();
  });

  it("when the webhook already moved the payout to held, a confirm is a harmless no-op", async () => {
    const w = await mkWorld({ payoutStatus: "transfer_requested", transfer: true });
    await prisma.creatorPayout.update({ where: { id: w.payout.id }, data: { status: "held" } }); // the webhook won the race
    expect(await confirmHold(w.payout.id, { now: T(0) })).toMatchObject({ ok: true, status: "held" });
  });

  it("applies only to the states it understands, and a parked payout it cannot explain stays parked", async () => {
    for (const status of ["planned", "released", "failed", "void", "reversed"]) {
      const w = await mkWorld({ payoutStatus: status });
      expect((await confirmHold(w.payout.id, { now: T(0) })).outcome, status).toBe("not_applicable");
    }
    const parked = await mkWorld({ payoutStatus: "needs_attention" });
    await prisma.creatorPayout.update({ where: { id: parked.payout.id }, data: { errorCode: "transfer_unknown_after_retry" } });
    expect((await confirmHold(parked.payout.id, { now: T(0) })).outcome).toBe("not_applicable");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe("releasePayout: the release gate", () => {
  it("releases a payout that satisfies every condition: one PATCH, a fresh confirmation, the destination frozen", async () => {
    const w = await releasable();
    const r = await releasePayout(w.payout.id, { now: T(0) });
    expect(r).toMatchObject({ ok: true, outcome: "released", status: "released" });
    expect(holdCalls(false)).toHaveLength(1);
    expect(holdCalls(false)[0].body).toEqual({ on_hold: false });
    expect(fake.transfers.get(w.transferId!)!.onHold).toBe(false);
    // The calls made, in order: transfer, disputes, account, then the one write, then the confirming read.
    expect(fake.calls.map((c) => `${c.method} ${c.path.replace(/\/(trf|acc_prd|acc|pay)_[A-Za-z0-9_]+/g, "/:id")}`)).toEqual([
      "GET /v1/transfers/:id",
      "GET /v1/disputes",
      "GET /accounts/:id/products/:id",
      "PATCH /v1/transfers/:id",
      "GET /v1/transfers/:id",
    ]);
    const p = await reload(w.payout.id);
    expect(p).toMatchObject({ status: "released", destinationHint: "HDFC ••••1234", errorCode: null, lockedUntil: null });
    expect(p.releasedAt).not.toBeNull();
    expect(p.releaseRequestedAt).not.toBeNull();
    expect(p.nextAttemptAt).not.toBeNull(); // settlement polling starts at once
    expect((await eventsOf(w.payout.id)).map((e) => `${e.fromStatus}>${e.toStatus}`)).toEqual(["held>release_requested", "release_requested>released"]);
    // A list counts as two calls (the engine always reads one page past the end): transfer 1, disputes 2, account 1, PATCH 1, confirm 1.
    expect(r.calls).toBe(6);
  });

  it("a hand-checked post releases too (manual_ok) and a won dispute does not block", async () => {
    const w = await releasable({ ownership: "manual_ok" });
    await prisma.campaignDispute.create({ data: { razorpayDisputeId: "disp_P4WON0000001", razorpayPaymentId: w.pay, amountPaise: 100, status: "won" } });
    fake.addDispute({ paymentId: w.pay, status: "won" });
    fake.addDispute({ paymentId: "pay_SOMEONEELSES1", status: "open" }); // another payment's dispute is none of our business
    expect(await releasePayout(w.payout.id, { now: T(0) })).toMatchObject({ ok: true, outcome: "released" });
  });

  describe("every LOCAL refusal makes no Razorpay call at all and changes nothing", () => {
    const cases: Array<[string, (w: World) => Promise<void> | void, WorldOpts, string]> = [
      ["release_paused", async () => void (await prisma.systemSetting.create({ data: { key: RELEASE_SWITCH_KEY, value: "off" } })), {}, "release_paused"],
      ["payout_not_held", () => undefined, { payoutStatus: "released" }, "payout_not_held"],
      ["payout_paused", () => undefined, { paused: true }, "payout_paused"],
      ["no_transfer", () => undefined, { transfer: false }, "no_transfer"],
      ["booking_not_releasable", () => undefined, { bookingStatus: "rejected" }, "booking_not_releasable"],
      ["item_not_live", () => undefined, { itemStatus: "manual_pending" }, "item_not_live"],
      ["offer_missing", () => undefined, { verified: false }, "offer_missing"],
      ["offer_not_completed", async (w) => void (await prisma.creatorOffer.update({ where: { bookingItemId: w.item.id }, data: { status: "accepted" } })), {}, "offer_not_completed"],
      ["link_not_verified", async (w) => void (await prisma.creatorOffer.update({ where: { bookingItemId: w.item.id }, data: { linkVerifiedAt: null } })), {}, "link_not_verified"],
      ["ownership_unchecked", () => undefined, { ownership: "auto_failed" }, "ownership_unchecked"],
      ["ownership_unchecked (none)", () => undefined, { ownership: null }, "ownership_unchecked"],
      ["dispute_recorded", async (w) => void (await prisma.campaignDispute.create({ data: { razorpayDisputeId: "disp_P4OPEN000001", razorpayPaymentId: w.pay, amountPaise: 100, status: "open" } })), {}, "dispute_recorded"],
      ["dispute_recorded (lost)", async (w) => void (await prisma.campaignDispute.create({ data: { razorpayDisputeId: "disp_P4LOST000001", razorpayPaymentId: w.pay, amountPaise: 100, status: "lost" } })), {}, "dispute_recorded"],
      ["bank_change_pending", () => undefined, { bankChange: true }, "bank_change_pending"],
      ["release_not_scheduled", () => undefined, { releaseAfter: null }, "release_not_scheduled"],
      ["release_not_due", () => undefined, { releaseAfter: new Date(base + DAY) }, "release_not_due"],
    ];
    for (const [name, prep, opts, reason] of cases) {
      it(name, async () => {
        const w = await releasable(opts);
        await prep(w);
        const before = await eventsOf(w.payout.id);
        const r = await releasePayout(w.payout.id, { now: T(0) });
        expect(r).toMatchObject({ ok: false, outcome: "refused", reason, calls: 0 });
        expect(fake.calls).toHaveLength(0);
        expect(await eventsOf(w.payout.id)).toHaveLength(before.length);
        expect((await reload(w.payout.id)).status).toBe(opts.payoutStatus ?? "held");
      });
    }
  });

  describe("every REMOTE refusal makes NO Razorpay write and leaves the payout held", () => {
    const cases: Array<[string, (w: World) => void, WorldOpts, string]> = [
      ["transfer_unreadable", () => fake.intercept({ match: is.fetchTransfer, mode: "reject", status: 500 }), {}, "transfer_unreadable"],
      ["transfer_unreadable (garbage)", () => fake.intercept({ match: is.fetchTransfer, mode: "garbage" }), {}, "transfer_unreadable"],
      ["transfer_mismatch (amount)", (w) => void (fake.transfers.get(w.transferId!)!.amount = 49_999), {}, "transfer_mismatch"],
      ["transfer_mismatch (recipient)", (w) => void (fake.transfers.get(w.transferId!)!.recipient = "acc_SOMEONEELSE1"), {}, "transfer_mismatch"],
      ["transfer_not_processed", () => undefined, { transferStatus: "pending" }, "transfer_not_processed"],
      ["transfer_not_on_hold", (w) => void (fake.transfers.get(w.transferId!)!.onHold = false), {}, "transfer_not_on_hold"],
      ["transfer_hold_expires", (w) => void (fake.transfers.get(w.transferId!)!.onHoldUntil = 1_900_000_000), {}, "transfer_hold_expires"],
      [
        "transfer_reversed",
        (w) => {
          const t = fake.transfers.get(w.transferId!)!;
          t.amountReversed = 100;
          t.status = "partially_reversed";
        },
        {},
        "transfer_not_processed",
      ],
      ["dispute_at_razorpay (open)", (w) => void fake.addDispute({ paymentId: w.pay, status: "open" }), {}, "dispute_at_razorpay"],
      ["dispute_at_razorpay (under_review)", (w) => void fake.addDispute({ paymentId: w.pay, status: "under_review" }), {}, "dispute_at_razorpay"],
      ["dispute_at_razorpay (lost)", (w) => void fake.addDispute({ paymentId: w.pay, status: "lost" }), {}, "dispute_at_razorpay"],
      ["dispute_at_razorpay (closed)", (w) => void fake.addDispute({ paymentId: w.pay, status: "closed" }), {}, "dispute_at_razorpay"],
      ["dispute_unchecked (refused)", () => fake.intercept({ match: is.listDisputes, mode: "reject", status: 400 }), {}, "dispute_unchecked"],
      ["dispute_unchecked (500)", () => fake.intercept({ match: is.listDisputes, mode: "badgateway" }), {}, "dispute_unchecked"],
      ["dispute_unchecked (unreadable)", () => fake.intercept({ match: is.listDisputes, mode: "garbage" }), {}, "dispute_unchecked"],
      ["account_not_activated", (w) => fake.setStatus(w.acc, "needs_clarification"), {}, "account_not_activated"],
      ["account_not_activated (suspended)", (w) => fake.setStatus(w.acc, "suspended"), {}, "account_not_activated"],
      ["account_unchecked", () => fake.intercept({ match: is.fetchProduct, mode: "reject", status: 500 }), {}, "account_unchecked"],
      ["duplicate_unchecked", () => fake.intercept({ match: is.listTransfers, mode: "reject", status: 500 }), { attempts: 2 }, "duplicate_unchecked"],
    ];
    for (const [name, prep, opts, reason] of cases) {
      it(name, async () => {
        const w = await releasable(opts);
        prep(w);
        const r = await releasePayout(w.payout.id, { now: T(0) });
        expect(r).toMatchObject({ ok: false, outcome: "refused", reason });
        expect(r.calls).toBeGreaterThan(0);
        expect(fake.writes()).toHaveLength(0);
        expect(await eventsOf(w.payout.id)).toHaveLength(0);
        expect(await reload(w.payout.id)).toMatchObject({ status: "held", releasedAt: null });
      });
    }

    it("a payout whose request was repeated and that has a twin: nothing is released, the extra is reversed, a person is told", async () => {
      const w = await releasable({ attempts: 2 });
      const twin = fake.seedTransfer({ source: w.pay, recipient: w.acc, amount: w.amount, notes: { payout_id: w.payout.id, booking_item_id: w.item.id } });
      twin.createdAt += 100; // the payout's own transfer is the older one
      const r = await releasePayout(w.payout.id, { now: T(0) });
      expect(r).toMatchObject({ ok: false, outcome: "refused", reason: "duplicate_transfer" });
      expect(holdCalls(false)).toHaveLength(0);
      expect(fake.calls.filter(is.createReversal)).toHaveLength(1);
      expect(fake.liveTransfersFor(w.payout.id).map((t) => t.id)).toEqual([w.transferId]);
      expect((await reload(w.payout.id)).status).toBe("needs_attention");
      await flush();
      expect(subjects()).toContain("A duplicate creator payout transfer was found");
    });

    it("a payout whose request was sent once needs no listing at release", async () => {
      const w = await releasable({ attempts: 1 });
      await releasePayout(w.payout.id, { now: T(0) });
      expect(fake.calls.filter(is.listTransfers)).toHaveLength(0);
    });
  });

  it("two callers at once make exactly ONE on_hold:false request", async () => {
    const w = await releasable();
    const [a, b] = await Promise.all([releasePayout(w.payout.id, { now: T(0) }), releasePayout(w.payout.id, { now: T(0) })]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(holdCalls(false)).toHaveLength(1);
    expect(await reload(w.payout.id)).toMatchObject({ status: "released" });
    expect([a, b].filter((x) => !x.ok)[0]).toMatchObject({ outcome: expect.stringMatching(/lost_claim|refused/) });
  });

  describe("a pause, a dispute or the kill switch that lands between the checks and the PATCH stops the release", () => {
    it("a pause", async () => {
      const w = await releasable();
      const r = await releasePayout(w.payout.id, {
        now: T(0),
        hooks: { afterClaim: async () => void (await prisma.creatorPayout.update({ where: { id: w.payout.id }, data: { pausedAt: new Date(), pausedReason: "dispute" } })) },
      });
      expect(r).toMatchObject({ ok: false, outcome: "refused", reason: "payout_paused", status: "held" });
      expect(holdCalls(false)).toHaveLength(0);
      expect(await reload(w.payout.id)).toMatchObject({ status: "held", lockedUntil: null });
    });
    it("a pause that lands before the claim is not claimed over: lost_claim, no release event, no PATCH", async () => {
      const w = await releasable();
      const r = await releasePayout(w.payout.id, {
        now: T(0),
        hooks: { beforeClaim: async () => void (await prisma.creatorPayout.update({ where: { id: w.payout.id }, data: { pausedAt: new Date(), pausedReason: "staff" } })) },
      });
      expect(r).toMatchObject({ ok: false, outcome: "lost_claim", status: "held" });
      expect(holdCalls(false)).toHaveLength(0);
      expect((await eventsOf(w.payout.id)).some((e) => e.toStatus === "release_requested")).toBe(false);
    });
    it("a dispute", async () => {
      const w = await releasable();
      const r = await releasePayout(w.payout.id, {
        now: T(0),
        hooks: { afterClaim: async () => void (await prisma.campaignDispute.create({ data: { razorpayDisputeId: "disp_P4LATE000001", razorpayPaymentId: w.pay, amountPaise: 100, status: "open" } })) },
      });
      expect(r).toMatchObject({ outcome: "refused", reason: "dispute_recorded" });
      expect(holdCalls(false)).toHaveLength(0);
    });
    it("the kill switch", async () => {
      const w = await releasable();
      const r = await releasePayout(w.payout.id, {
        now: T(0),
        hooks: { afterClaim: async () => void (await prisma.systemSetting.create({ data: { key: RELEASE_SWITCH_KEY, value: "OFF" } })) },
      });
      expect(r).toMatchObject({ outcome: "refused", reason: "release_paused" });
      expect(holdCalls(false)).toHaveLength(0);
      expect((await reload(w.payout.id)).status).toBe("held");
    });
  });

  it("the kill switch is 'off' only: any other value, or none, releases", async () => {
    for (const value of ["on", "", "pilot", "offf"]) {
      fake.reset();
      await prisma.systemSetting.deleteMany({ where: { key: RELEASE_SWITCH_KEY } });
      await prisma.systemSetting.create({ data: { key: RELEASE_SWITCH_KEY, value } });
      const w = await releasable();
      expect((await releasePayout(w.payout.id, { now: T(0) })).ok, value).toBe(true);
    }
  });

  describe("what the PATCH answers", () => {
    it("a definite refusal puts the claim back to held, records the code and alerts", async () => {
      const w = await releasable();
      fake.intercept({ match: (c) => is.setHold(c, false), mode: "reject", status: 400 });
      const r = await releasePayout(w.payout.id, { now: T(0) });
      expect(r).toMatchObject({ ok: false, outcome: "rejected", status: "held" });
      expect(await reload(w.payout.id)).toMatchObject({ status: "held", errorCode: "BAD_REQUEST_ERROR", lockedUntil: null });
      await flush();
      expect(subjects()).toContain("Creator payout release did not go through");
      expect(fake.transfers.get(w.transferId!)!.onHold).toBe(true);
    });

    it("an applied-but-lost answer stays release_requested and resolves to released with NO second PATCH", async () => {
      const w = await releasable();
      fake.intercept({ match: (c) => is.setHold(c, false), mode: "lose" });
      const r = await releasePayout(w.payout.id, { now: T(0) });
      expect(r).toMatchObject({ ok: false, outcome: "unknown", status: "release_requested" });
      expect(fake.transfers.get(w.transferId!)!.onHold).toBe(false); // it DID land
      // A second release is refused: the payout is mid-release, not held.
      expect(await releasePayout(w.payout.id, { now: T(1) })).toMatchObject({ outcome: "refused", reason: "payout_not_held" });
      // A fresh read shows the hold lifted, so it is finished without another request.
      expect(await resolveRelease(w.payout.id, { now: T(1) })).toMatchObject({ ok: true, outcome: "released", status: "released" });
      expect(holdCalls(false)).toHaveLength(1);
      expect((await reload(w.payout.id)).destinationHint).toBe("HDFC ••••1234");
    });

    it("a request that never reached Razorpay is found STILL ON HOLD, and only after a wait is the claim put back so the gate runs again", async () => {
      const w = await releasable();
      fake.intercept({ match: (c) => is.setHold(c, false), mode: "drop" });
      expect((await releasePayout(w.payout.id, { now: T(0) })).outcome).toBe("unknown");
      // Too soon: the request might still be in flight at Razorpay, so a hold seen now proves nothing.
      expect(await resolveRelease(w.payout.id, { now: T(1) })).toMatchObject({ ok: false, outcome: "waiting", status: "release_requested" });
      const r = await resolveRelease(w.payout.id, { now: T(10) });
      expect(r).toMatchObject({ ok: false, outcome: "put_back", status: "held", reason: "release_abandoned" });
      expect(await reload(w.payout.id)).toMatchObject({ status: "held", errorCode: "release_abandoned" });
      await flush();
      expect(subjects()).toContain("Creator payout release did not go through");
      // The next release goes through the whole gate again and succeeds.
      expect(await releasePayout(w.payout.id, { now: T(20) })).toMatchObject({ ok: true, outcome: "released" });
      expect(holdCalls(false)).toHaveLength(2); // one dropped, one real
    });

    it("an unreadable confirming read keeps release_requested; it is not called released until Razorpay shows it", async () => {
      const w = await releasable();
      // The first GET (the gate's) passes; the confirming one fails.
      fake.intercept({ match: is.fetchTransfer, mode: "reject", status: 500, skip: 1 });
      const r = await releasePayout(w.payout.id, { now: T(0) });
      expect(r).toMatchObject({ ok: false, outcome: "unknown", status: "release_requested" });
      expect((await reload(w.payout.id)).releasedAt).toBeNull();
      expect(await resolveRelease(w.payout.id, { now: T(10) })).toMatchObject({ ok: true, outcome: "released" });
      expect(holdCalls(false)).toHaveLength(1);
    });
  });

  it("a release refused by the FRESH read when the transfer was reversed meanwhile: the stored row still says held, Razorpay says reversed", async () => {
    const w = await releasable();
    const t = fake.transfers.get(w.transferId!)!;
    t.amountReversed = t.amount;
    t.status = "reversed";
    expect(await releasePayout(w.payout.id, { now: T(0) })).toMatchObject({ outcome: "refused", reason: "transfer_not_processed" });
    expect(fake.writes()).toHaveLength(0);
  });

  it("is dark without Razorpay keys, and never claims", async () => {
    const w = await releasable();
    vi.stubEnv("RAZORPAY_KEY_ID", "");
    expect(await releasePayout(w.payout.id, { now: T(0) })).toMatchObject({ ok: false, outcome: "disabled" });
    expect((await reload(w.payout.id)).status).toBe("held");
  });

  it("a payout that does not exist", async () => {
    expect(await releasePayout(randomUUID())).toMatchObject({ outcome: "not_found", status: null });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe("pollSettlement: 'Paid' exists only from a processed settlement with a bank reference", () => {
  it("a released transfer with no settlement yet stays released and is looked at again later", async () => {
    const w = await mkWorld({ payoutStatus: "released" });
    const r = await pollSettlement(w.payout.id, { now: T(0) });
    expect(r).toMatchObject({ ok: false, outcome: "awaiting_settlement", status: "released" });
    const p = await reload(w.payout.id);
    expect(p).toMatchObject({ status: "released", settlementUtr: null, settledAt: null });
    expect(p.nextAttemptAt).not.toBeNull();
    expect(fake.writes()).toHaveLength(0);
  });

  it("a settled transfer becomes settled with the UTR and the settlement id; the batch amount is information, never the payout", async () => {
    const w = await mkWorld({ payoutStatus: "released" });
    const st = fake.settleTransfer(w.transferId!, { utr: "AXISCN1153863727", fee: 12, batchExtra: 150_000 });
    const r = await pollSettlement(w.payout.id, { now: T(0) });
    expect(r).toMatchObject({ ok: true, outcome: "settled", status: "settled" });
    // expand[]=recipient_settlement was asked for.
    expect(fake.calls.filter(is.fetchTransfer)[0].query["expand[]"]).toBe("recipient_settlement");
    const p = await reload(w.payout.id);
    expect(p).toMatchObject({ status: "settled", settlementUtr: "AXISCN1153863727", recipientSettlementId: st.id, recipientSettlementStatus: "processed", amountPaise: w.amount, settlementFeePaise: 12, lockedUntil: null, nextAttemptAt: null });
    expect(p.settledAt).not.toBeNull();
    expect(p.settlementAmountPaise).toBe(w.amount + 150_000); // the WHOLE bank batch, kept only as information
    expect(p.amountPaise).toBe(w.amount);
    // Paid is terminal.
    expect((await pollSettlement(w.payout.id, { now: T(1) })).outcome).toBe("not_applicable");
  });

  it("a processed settlement WITHOUT a usable UTR is not paid", async () => {
    const w = await mkWorld({ payoutStatus: "released" });
    fake.settleTransfer(w.transferId!, { utr: null });
    const r = await pollSettlement(w.payout.id, { now: T(0) });
    expect(r).toMatchObject({ ok: false, outcome: "settlement_without_utr", status: "released" });
    expect(await reload(w.payout.id)).toMatchObject({ status: "released", settlementUtr: null, errorCode: "settlement_without_utr" });
  });

  it("the settlement id is written as soon as Razorpay shows it, before it has processed (the settlement webhook links by it)", async () => {
    const w = await mkWorld({ payoutStatus: "released" });
    const st = fake.settleTransfer(w.transferId!, { status: "created", utr: null });
    await pollSettlement(w.payout.id, { now: T(0) });
    expect(await reload(w.payout.id)).toMatchObject({ status: "released", recipientSettlementId: st.id, recipientSettlementStatus: "created" });
    // And it settles later, from the same poll.
    st.status = "processed";
    st.utr = "UTR000000000009";
    expect(await pollSettlement(w.payout.id, { now: T(30) })).toMatchObject({ ok: true, outcome: "settled" });
  });

  it("a failed settlement is settlement_failed with an alert, and a later processed one settles it", async () => {
    const w = await mkWorld({ payoutStatus: "released" });
    const st = fake.settleTransfer(w.transferId!, { status: "failed", utr: null });
    expect(await pollSettlement(w.payout.id, { now: T(0) })).toMatchObject({ ok: false, outcome: "settlement_failed", status: "settlement_failed" });
    await flush();
    expect(subjects()).toContain("Creator payout settlement FAILED (the bank rejected it)");
    st.status = "processed";
    st.utr = "UTR000000000008";
    expect(await pollSettlement(w.payout.id, { now: T(30) })).toMatchObject({ ok: true, outcome: "settled" });
  });

  it("an unreadable fetch changes nothing; a released transfer that someone put back on hold is parked, never settled", async () => {
    const w = await mkWorld({ payoutStatus: "released" });
    fake.intercept({ match: is.fetchTransfer, mode: "reject", status: 500 });
    expect(await pollSettlement(w.payout.id, { now: T(0) })).toMatchObject({ outcome: "unread", status: "released" });
    fake.transfers.get(w.transferId!)!.onHold = true;
    expect(await pollSettlement(w.payout.id, { now: T(10) })).toMatchObject({ outcome: "parked", status: "needs_attention", reason: "re_held_outside_flow" });
  });

  it("a slow settlement raises an alert after days", async () => {
    const w = await mkWorld({ payoutStatus: "released" });
    await prisma.creatorPayout.update({ where: { id: w.payout.id }, data: { releasedAt: new Date(base - 5 * DAY) } });
    await pollSettlement(w.payout.id, { now: T(0) });
    await flush();
    expect(subjects()).toContain("A released creator payout has not settled");
  });

  it("only a released (or settlement_failed) payout is polled", async () => {
    for (const status of ["held", "planned", "reversed", "settled"]) {
      const w = await mkWorld({ payoutStatus: status });
      expect((await pollSettlement(w.payout.id, { now: T(0) })).outcome, status).toBe("not_applicable");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe("reversePayout: explicit, fresh and idempotent", () => {
  const reversalCalls = () => fake.calls.filter(is.createReversal);

  it("takes back exactly the transfer's amount, with our payout id in the notes, and ends reversed", async () => {
    const w = await mkWorld({ payoutStatus: "held" });
    const r = await reversePayout(w.payout.id, { reason: "withdrawn", now: T(0) });
    expect(r).toMatchObject({ ok: true, outcome: "reversed", status: "reversed" });
    expect(reversalCalls()).toHaveLength(1);
    expect(reversalCalls()[0].body).toEqual({ amount: w.amount, notes: { payout_id: w.payout.id } });
    expect(fake.transfers.get(w.transferId!)).toMatchObject({ status: "reversed", amountReversed: w.amount });
    const p = await reload(w.payout.id);
    expect(p).toMatchObject({ status: "reversed", amountReversedPaise: w.amount, transferStatus: "reversed", lockedUntil: null, nextAttemptAt: null });
    expect(p.razorpayReversalId).toMatch(/^rvrsl_/);
    expect(p.reversedAt).not.toBeNull();
    expect((await eventsOf(w.payout.id)).map((e) => `${e.fromStatus}>${e.toStatus}`)).toEqual(["held>reversal_requested", "reversal_requested>reversed"]);
  });

  it("never omits the amount and never uses reverse_all: every reversal body carries a positive integer amount", async () => {
    const w = await mkWorld({ payoutStatus: "held" });
    const other = fake.seedTransfer({ source: w.pay, recipient: "acc_SOMEONEELSE1", amount: 10_000, notes: { payout_id: "someone-elses" } });
    await reversePayout(w.payout.id, { reason: "withdrawn", now: T(0) });
    for (const c of reversalCalls()) {
      expect(Number.isInteger(c.body.amount) && c.body.amount > 0).toBe(true);
      expect(JSON.stringify(c.body)).not.toMatch(/reverse_all/);
    }
    // Another creator's transfer on the same payment is untouched.
    expect(fake.transfers.get(other.id)).toMatchObject({ amountReversed: 0, status: "processed", onHold: true });
  });

  it("reverses only what is LEFT after a partial reversal elsewhere", async () => {
    const w = await mkWorld({ payoutStatus: "held" });
    const t = fake.transfers.get(w.transferId!)!;
    t.amountReversed = 20_000;
    t.status = "partially_reversed";
    expect(await reversePayout(w.payout.id, { reason: "withdrawn", now: T(0) })).toMatchObject({ ok: true, status: "reversed" });
    expect(reversalCalls()[0].body.amount).toBe(w.amount - 20_000);
    expect(fake.transfers.get(w.transferId!)!.amountReversed).toBe(w.amount);
  });

  it("is idempotent: a second call, and a transfer already reversed in the dashboard, both succeed without another reversal", async () => {
    const w = await mkWorld({ payoutStatus: "held" });
    await reversePayout(w.payout.id, { reason: "withdrawn", now: T(0) });
    const again = await reversePayout(w.payout.id, { reason: "withdrawn", now: T(1) });
    expect(again).toMatchObject({ ok: true, outcome: "already_reversed", status: "reversed", calls: 0 });
    expect(reversalCalls()).toHaveLength(1);

    const x = await mkWorld({ payoutStatus: "held" });
    const t = fake.transfers.get(x.transferId!)!;
    t.amountReversed = t.amount;
    t.status = "reversed";
    expect(await reversePayout(x.payout.id, { reason: "withdrawn", now: T(2) })).toMatchObject({ ok: true, status: "reversed" });
    expect(reversalCalls()).toHaveLength(1); // none for the second payout
    expect((await reload(x.payout.id)).reversedAt).not.toBeNull();
  });

  it("a DEFINITE refusal of a held payout puts it back to held and alerts: no money moved, nothing changed", async () => {
    const w = await mkWorld({ payoutStatus: "held" });
    fake.intercept({ match: is.createReversal, mode: "reject", status: 400 });
    const r = await reversePayout(w.payout.id, { reason: "withdrawn", now: T(0) });
    expect(r).toMatchObject({ ok: false, outcome: "refused", status: "held", reason: "reversal_refused" });
    expect(await reload(w.payout.id)).toMatchObject({ status: "held", errorCode: "reversal_refused", amountReversedPaise: 0, reversedAt: null, lockedUntil: null });
    expect(fake.transfers.get(w.transferId!)).toMatchObject({ amountReversed: 0, onHold: true });
    await flush();
    expect(subjects()).toContain("Creator payout reversal FAILED");
  });

  it("a refusal for a payout that was already released is parked for a person, never put back to held", async () => {
    const w = await mkWorld({ payoutStatus: "released" });
    fake.settleTransfer(w.transferId!); // the money reached the bank: Razorpay has no floating balance to reverse against
    const r = await reversePayout(w.payout.id, { reason: "dispute", now: T(0) });
    expect(r).toMatchObject({ ok: false, outcome: "refused", status: "needs_attention", reason: "reversal_refused_after_release" });
    expect((await reload(w.payout.id)).status).toBe("needs_attention");
    await flush();
    expect(subjects()).toContain("Creator payout reversal FAILED");
  });

  it("an UNKNOWN answer is neither success nor failure: it never ends in held, and a read decides", async () => {
    // The reversal landed but the answer was lost.
    const a = await mkWorld({ payoutStatus: "held" });
    fake.intercept({ match: is.createReversal, mode: "lose" });
    const r = await reversePayout(a.payout.id, { reason: "withdrawn", now: T(0) });
    expect(r).toMatchObject({ ok: false, outcome: "unknown", status: "reversal_requested" });
    expect((await reload(a.payout.id)).status).toBe("reversal_requested"); // not held, not reversed
    // Resolved by reading: the fresh transfer is fully reversed, so it finishes with NO second reversal.
    expect(await resolveReversal(a.payout.id, { now: T(1) })).toMatchObject({ ok: true, outcome: "reversed", status: "reversed" });
    expect(reversalCalls()).toHaveLength(1);

    // The reversal never reached Razorpay.
    fake.reset();
    const b = await mkWorld({ payoutStatus: "held" });
    fake.intercept({ match: is.createReversal, mode: "drop" });
    expect((await reversePayout(b.payout.id, { reason: "withdrawn", now: T(0) })).outcome).toBe("unknown");
    // Too soon, the first request might still be in flight: nothing is sent again.
    expect(await resolveReversal(b.payout.id, { now: T(1) })).toMatchObject({ ok: false, outcome: "waiting", status: "reversal_requested" });
    expect(reversalCalls().filter((c) => c.path.includes(b.transferId!))).toHaveLength(1);
    // After the wait: what is LEFT is reversed, once.
    expect(await resolveReversal(b.payout.id, { now: T(10) })).toMatchObject({ ok: true, status: "reversed" });
    expect(fake.transfers.get(b.transferId!)!.amountReversed).toBe(b.amount);
  });

  it("an unreadable fresh read keeps the claim (it cannot compute an explicit amount) and sends no reversal", async () => {
    const w = await mkWorld({ payoutStatus: "held" });
    fake.intercept({ match: is.fetchTransfer, mode: "reject", status: 500 });
    const r = await reversePayout(w.payout.id, { reason: "withdrawn", now: T(0) });
    expect(r).toMatchObject({ ok: false, outcome: "unknown", status: "reversal_requested" });
    expect(reversalCalls()).toHaveLength(0);
    expect(await resolveReversal(w.payout.id, { now: T(10) })).toMatchObject({ ok: true, status: "reversed" });
  });

  it("refuses statuses it must not reverse, and needs_attention only for a person", async () => {
    for (const status of ["settled", "release_requested", "transfer_requested", "failed", "manual_required", "paid_manual"]) {
      const w = await mkWorld({ payoutStatus: status });
      const r = await reversePayout(w.payout.id, { reason: "x", now: T(0) });
      expect(r.ok, status).toBe(false);
      expect(r.status, status).toBe(status);
    }
    for (const status of ["planned", "void"]) {
      expect((await reversePayout((await mkWorld({ payoutStatus: status })).payout.id, { reason: "x", now: T(0) })).outcome, status).toBe("nothing_to_reverse");
    }
    const parked = await mkWorld({ payoutStatus: "needs_attention" });
    expect(await reversePayout(parked.payout.id, { reason: "x", now: T(0) })).toMatchObject({ ok: false, outcome: "not_reversible" });
    expect(await reversePayout(parked.payout.id, { reason: "x", now: T(0), actor: { type: "staff", id: "u1" } })).toMatchObject({ ok: true, status: "reversed" });
    expect(reversalCalls()).toHaveLength(1);
  });

  it("a pending (not yet processed) transfer cannot be reversed yet: back to held, no reversal sent", async () => {
    const w = await mkWorld({ payoutStatus: "held", transferStatus: "pending" });
    const r = await reversePayout(w.payout.id, { reason: "withdrawn", now: T(0) });
    expect(r).toMatchObject({ ok: false, outcome: "refused", status: "held", reason: "transfer_not_processed" });
    expect(reversalCalls()).toHaveLength(0);
  });

  it("a transfer that is not this payout's own is parked, not reversed", async () => {
    const w = await mkWorld({ payoutStatus: "held" });
    fake.transfers.get(w.transferId!)!.recipient = "acc_SOMEONEELSE1";
    const r = await reversePayout(w.payout.id, { reason: "withdrawn", now: T(0) });
    expect(r).toMatchObject({ outcome: "mismatch", status: "needs_attention" });
    expect(reversalCalls()).toHaveLength(0);
  });

  it("a release racing a reversal: whichever claims first wins, the other makes no Razorpay write of its own", async () => {
    const w = await releasable();
    const rev = await reversePayout(w.payout.id, { reason: "withdrawn", now: T(0) });
    expect(rev.status).toBe("reversed");
    const rel = await releasePayout(w.payout.id, { now: T(1) });
    expect(rel).toMatchObject({ ok: false, outcome: "refused", reason: "payout_not_held" });
    expect(holdCalls(false)).toHaveLength(0);

    const x = await releasable();
    const [a, b] = await Promise.all([releasePayout(x.payout.id, { now: T(2) }), reversePayout(x.payout.id, { reason: "withdrawn", now: T(2) })]);
    // The end state is coherent whichever won: never both released-and-paid and reversed-and-refunded as "ok".
    const end = (await reload(x.payout.id)).status;
    expect(["released", "reversed"]).toContain(end);
    if (end === "reversed") expect(holdCalls(false).filter((c) => c.path.includes(x.transferId!))).toHaveLength(0);
    expect([a.ok, b.ok].filter(Boolean).length).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe("reverseForRefund: the step before any refund of a creator item", () => {
  it("no payout, an already void or reversed payout: refundable at once, no call", async () => {
    expect(await reverseForRefund(randomUUID(), { reason: "item_refunded", now: T(0) })).toMatchObject({ refundable: true, state: "no_payout", calls: 0 });
    const v = await mkWorld({ payoutStatus: "void" });
    expect(await reverseForRefund(v.item.id, { reason: "item_refunded" })).toMatchObject({ refundable: true, state: "void" });
    const r = await mkWorld({ payoutStatus: "reversed" });
    expect(await reverseForRefund(r.item.id, { reason: "item_refunded" })).toMatchObject({ refundable: true, state: "reversed" });
    expect(fake.calls).toHaveLength(0);
  });

  it("a planned payout is voided (nothing left our balance) with an audit row, no Razorpay call", async () => {
    const w = await mkWorld();
    const r = await reverseForRefund(w.item.id, { reason: "declined", actor: { type: "creator", id: "c1" } });
    expect(r).toMatchObject({ refundable: true, state: "voided", payoutId: w.payout.id });
    expect(await reload(w.payout.id)).toMatchObject({ status: "void", voidReason: "declined" });
    expect((await eventsOf(w.payout.id)).map((e) => `${e.kind}:${e.actorType}`)).toEqual(["void:creator"]);
    expect(fake.calls).toHaveLength(0);
    // A repeat is a no-op success.
    expect(await reverseForRefund(w.item.id, { reason: "declined" })).toMatchObject({ refundable: true, state: "void" });
  });

  it("a failed payout (Razorpay refused, no money moved) is voided", async () => {
    const w = await mkWorld({ payoutStatus: "failed", transfer: false });
    expect(await reverseForRefund(w.item.id, { reason: "expired" })).toMatchObject({ refundable: true, state: "voided" });
  });

  it("a HELD payout is reversed first; only then is the item refundable", async () => {
    const w = await mkWorld({ payoutStatus: "held" });
    const r = await reverseForRefund(w.item.id, { reason: "withdrawn", now: T(0) });
    expect(r).toMatchObject({ refundable: true, state: "reversed", payoutId: w.payout.id });
    expect(r.calls).toBeGreaterThan(0);
    expect(await reload(w.payout.id)).toMatchObject({ status: "reversed" });
  });

  it("a failed reversal means NOT refundable and the payout is unchanged (held)", async () => {
    const w = await mkWorld({ payoutStatus: "held" });
    fake.intercept({ match: is.createReversal, mode: "reject", status: 400 });
    const r = await reverseForRefund(w.item.id, { reason: "withdrawn", now: T(0) });
    expect(r).toMatchObject({ refundable: false, state: "blocked", reason: "reversal_refused" });
    expect((await reload(w.payout.id)).status).toBe("held");
  });

  it("an unknown reversal answer is 'pending': not refundable yet, and a later call finishes it", async () => {
    const w = await mkWorld({ payoutStatus: "held" });
    fake.intercept({ match: is.createReversal, mode: "lose" });
    expect(await reverseForRefund(w.item.id, { reason: "withdrawn", now: T(0) })).toMatchObject({ refundable: false, state: "reversal_pending" });
    expect(await reverseForRefund(w.item.id, { reason: "withdrawn", now: T(1) })).toMatchObject({ refundable: true, state: "reversed" });
    expect(fake.calls.filter(is.createReversal)).toHaveLength(1);
  });

  it("a transfer still being made makes the refund WAIT (in_flight); released, settled or parked money is never refunded around", async () => {
    const t = await mkWorld({ payoutStatus: "transfer_requested" });
    expect(await reverseForRefund(t.item.id, { reason: "withdrawn" })).toMatchObject({ refundable: false, state: "in_flight" });
    for (const status of ["released", "release_requested", "settled", "settlement_failed", "needs_attention", "paid_manual"]) {
      const w = await mkWorld({ payoutStatus: status });
      const r = await reverseForRefund(w.item.id, { reason: "withdrawn" });
      expect(r, status).toMatchObject({ refundable: false, state: "blocked", reason: `payout_${status}` });
    }
    expect(fake.writes()).toHaveLength(0);
  });

  it("manual_required is refundable only when no money is out: never created, or reversed", async () => {
    const never = await mkWorld({ payoutStatus: "manual_required", transfer: false, attempts: 0 });
    expect(await reverseForRefund(never.item.id, { reason: "x" })).toMatchObject({ refundable: true, state: "voided" });
    const reversed = await mkWorld({ payoutStatus: "manual_required" });
    await prisma.creatorPayout.update({ where: { id: reversed.payout.id }, data: { reversedAt: new Date() } });
    expect(await reverseForRefund(reversed.item.id, { reason: "x" })).toMatchObject({ refundable: true, state: "voided" });
    const unproven = await mkWorld({ payoutStatus: "manual_required", transfer: false, attempts: 1 });
    expect(await reverseForRefund(unproven.item.id, { reason: "x" })).toMatchObject({ refundable: false, state: "blocked", reason: "manual_required_unproven" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe("manual fallback", () => {
  it("(a) a payout that was never sent to Razorpay is paid by hand with no Razorpay call, and the reference is kept exactly", async () => {
    const w = await mkWorld({ payoutStatus: "manual_required", transfer: false, attempts: 0 });
    const r = await markManualPaid(w.payout.id, { reference: "NEFT 482910-AB/77", note: "paid on 18 Oct", actor: { type: "staff", id: "staff-1" }, now: T(0) });
    expect(r).toMatchObject({ ok: true, outcome: "paid_manual", status: "paid_manual", reason: "no_transfer", calls: 0 });
    const p = await reload(w.payout.id);
    expect(p).toMatchObject({ status: "paid_manual", manualReference: "NEFT 482910-AB/77", manualPaidById: "staff-1", manualNote: "paid on 18 Oct" });
    expect(p.manualPaidAt).not.toBeNull();
    expect((await eventsOf(w.payout.id)).map((e) => `${e.kind}:${e.actorType}`)).toEqual(["manual:staff"]);
    expect((await markManualPaid(w.payout.id, { reference: "NEFT 482910-AB/77", now: T(1) })).outcome).toBe("not_manual_required");
  });

  it("(a) a create call WAS sent: only a fresh listing showing no live transfer allows it", async () => {
    const w = await mkWorld({ payoutStatus: "manual_required", transfer: false, attempts: 1 });
    expect(await markManualPaid(w.payout.id, { reference: "UTR778899001", now: T(0) })).toMatchObject({ ok: true, reason: "no_transfer" });

    const x = await mkWorld({ payoutStatus: "manual_required", transfer: false, attempts: 1 });
    fake.seedTransfer({ source: x.pay, recipient: x.acc, amount: x.amount, notes: { payout_id: x.payout.id } }); // it landed unseen
    expect(await markManualPaid(x.payout.id, { reference: "UTR778899002", now: T(0) })).toMatchObject({ ok: false, outcome: "refused", reason: "transfer_active" });

    const y = await mkWorld({ payoutStatus: "manual_required", transfer: false, attempts: 1 });
    fake.intercept({ match: is.listTransfers, mode: "reject", status: 500 });
    expect(await markManualPaid(y.payout.id, { reference: "UTR778899003", now: T(0) })).toMatchObject({ ok: false, reason: "listing_unchecked" });
    expect((await reload(y.payout.id)).status).toBe("manual_required");
  });

  it("(b) the transfer failed AND nothing else live carries the payout id", async () => {
    const w = await mkWorld({ payoutStatus: "manual_required", transferStatus: "failed" });
    expect(await markManualPaid(w.payout.id, { reference: "UTR778899004", now: T(0) })).toMatchObject({ ok: true, reason: "transfer_failed" });

    const x = await mkWorld({ payoutStatus: "manual_required", transferStatus: "failed" });
    fake.seedTransfer({ source: x.pay, recipient: x.acc, amount: x.amount, notes: { payout_id: x.payout.id } }); // another, live, one
    expect(await markManualPaid(x.payout.id, { reference: "UTR778899005", now: T(0) })).toMatchObject({ ok: false, reason: "transfer_active" });
  });

  it("(c) reversed: paid by hand only after the whole transfer is back", async () => {
    const w = await mkWorld({ payoutStatus: "manual_required", transferStatus: "processed" });
    await prisma.creatorPayout.update({ where: { id: w.payout.id }, data: { reversedAt: new Date() } });
    // The row says reversed, but Razorpay still shows a live transfer: refused.
    expect(await markManualPaid(w.payout.id, { reference: "UTR778899006", now: T(0) })).toMatchObject({ ok: false, reason: "transfer_not_failed" });
    const t = fake.transfers.get(w.transferId!)!;
    t.amountReversed = t.amount;
    t.status = "reversed";
    expect(await markManualPaid(w.payout.id, { reference: "UTR778899006", now: T(1) })).toMatchObject({ ok: true, reason: "reversed" });
  });

  it("never pays by hand while a transfer is alive and could still release", async () => {
    const w = await mkWorld({ payoutStatus: "manual_required" }); // a processed, held transfer with the payout in manual_required
    expect(await markManualPaid(w.payout.id, { reference: "UTR778899007", now: T(0) })).toMatchObject({ ok: false, outcome: "refused", reason: "transfer_not_failed" });
    expect((await reload(w.payout.id)).status).toBe("manual_required");
  });

  it("an unreadable fresh read of the transfer refuses", async () => {
    const w = await mkWorld({ payoutStatus: "manual_required", transferStatus: "failed" });
    fake.intercept({ match: is.fetchTransfer, mode: "reject", status: 500 });
    expect(await markManualPaid(w.payout.id, { reference: "UTR778899008", now: T(0) })).toMatchObject({ ok: false, reason: "transfer_unchecked" });
  });

  it("rejects a reference that is empty, too short, odd, or shaped like a PAN or an IFSC", async () => {
    const w = await mkWorld({ payoutStatus: "manual_required", transfer: false, attempts: 0 });
    for (const bad of ["", "ab", "<script>x", "ABCPE1234F", "HDFC0000317", "ref ABCPE1234F"]) {
      expect(await markManualPaid(w.payout.id, { reference: bad, now: T(0) }), bad).toMatchObject({ ok: false, outcome: "invalid_reference" });
    }
    expect((await reload(w.payout.id)).status).toBe("manual_required");
  });

  it("requireManualPayment moves planned, failed, reversed or parked payouts there; a person only for a parked one", async () => {
    for (const status of ["planned", "failed", "reversed"]) {
      const w = await mkWorld({ payoutStatus: status, transfer: false });
      expect(await requireManualPayment(w.payout.id, { reason: "staff_decision", actor: { type: "staff", id: "s" } }), status).toMatchObject({ ok: true, status: "manual_required" });
    }
    const parked = await mkWorld({ payoutStatus: "needs_attention" });
    expect(await requireManualPayment(parked.payout.id, { reason: "x" })).toMatchObject({ ok: false, outcome: "needs_human" });
    expect(await requireManualPayment(parked.payout.id, { reason: "x", actor: { type: "staff", id: "s" } })).toMatchObject({ ok: true });
    const held = await mkWorld({ payoutStatus: "held" });
    expect((await requireManualPayment(held.payout.id, { reason: "x", actor: { type: "staff", id: "s" } })).outcome).toBe("not_applicable");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe("pause and resume", () => {
  it("a staff pause is recorded once, blocks every move, and is lifted only when nothing that caused one holds", async () => {
    const w = await releasable();
    expect(await pausePayout(w.payout.id, { actor: { type: "staff", id: "s" }, reason: "checking the post", now: T(0) })).toMatchObject({ ok: true, outcome: "paused" });
    expect(await pausePayout(w.payout.id, { now: T(0) })).toMatchObject({ ok: true, outcome: "already_paused" });
    const p = await reload(w.payout.id);
    expect(p).toMatchObject({ pausedReason: "staff" });
    expect(p.pausedAt).not.toBeNull();
    expect((await eventsOf(w.payout.id)).filter((e) => e.kind === "pause")).toHaveLength(1);

    // Paused: no release, and a planned paused payout makes no transfer.
    expect(await releasePayout(w.payout.id, { now: T(1) })).toMatchObject({ outcome: "refused", reason: "payout_paused", calls: 0 });
    const planned = await mkWorld({ paused: true });
    expect(await executePlannedPayout(planned.payout.id, { now: T(1) })).toMatchObject({ outcome: "waiting", reason: "paused" });

    expect(await resumePayout(w.payout.id, { actor: { type: "staff", id: "s" }, now: T(2) })).toMatchObject({ ok: true, outcome: "resumed" });
    expect(await reload(w.payout.id)).toMatchObject({ pausedAt: null, pausedReason: null });
    expect(await resumePayout(w.payout.id, { now: T(3) })).toMatchObject({ ok: false, reason: "not_paused" });
    expect(await releasePayout(w.payout.id, { now: T(4) })).toMatchObject({ ok: true, outcome: "released" });
  });

  it("only a payout with something still in flight can be paused", async () => {
    for (const status of ["settled", "void", "reversed", "paid_manual"]) {
      const w = await mkWorld({ payoutStatus: status });
      expect((await pausePayout(w.payout.id)).outcome, status).toBe("not_pausable");
    }
    expect((await pausePayout(randomUUID())).outcome).toBe("not_found");
  });

  it("resume is refused while a dispute is open or lost, a bank change is pending, or the account is not activated", async () => {
    const w = await releasable({ paused: true });
    await prisma.campaignDispute.create({ data: { razorpayDisputeId: "disp_P4RESUME0001", razorpayPaymentId: w.pay, amountPaise: 100, status: "open" } });
    expect(await resumePayout(w.payout.id, { now: T(0) })).toMatchObject({ ok: false, outcome: "refused", reason: "dispute_open" });
    await prisma.campaignDispute.updateMany({ where: { razorpayPaymentId: w.pay }, data: { status: "lost" } });
    expect(await resumePayout(w.payout.id, { now: T(0) })).toMatchObject({ reason: "dispute_open" });
    await prisma.campaignDispute.updateMany({ where: { razorpayPaymentId: w.pay }, data: { status: "won" } });
    await prisma.creatorPayoutAccount.update({ where: { id: w.account.id }, data: { bankChangeRequestedAt: new Date(base - DAY) } });
    expect(await resumePayout(w.payout.id, { now: T(0) })).toMatchObject({ reason: "bank_change_pending" });
    await prisma.creatorPayoutAccount.update({ where: { id: w.account.id }, data: { bankChangeRequestedAt: null, activationStatus: "suspended" } });
    expect(await resumePayout(w.payout.id, { now: T(0) })).toMatchObject({ reason: "account_not_activated" });
    expect((await reload(w.payout.id)).pausedAt).not.toBeNull();
    await prisma.creatorPayoutAccount.update({ where: { id: w.account.id }, data: { activationStatus: "activated" } });
    expect(await resumePayout(w.payout.id, { now: T(0) })).toMatchObject({ ok: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe("a dispute on a released payout: the hold is put back if it can be", () => {
  it("re-holds a released, unsettled transfer and moves released → held, then the gate refuses while paused", async () => {
    const w = await mkWorld({ payoutStatus: "released", paused: true });
    const r = await reholdReleasedPayout(w.payout.id, { now: T(0) });
    expect(r).toMatchObject({ ok: true, outcome: "reheld", status: "held" });
    expect(holdCalls(true)).toHaveLength(1);
    expect(fake.transfers.get(w.transferId!)!.onHold).toBe(true);
    expect(await reload(w.payout.id)).toMatchObject({ status: "held", pausedReason: "staff" });
    await flush();
    expect(subjects()).toContain("A released creator payout was put back on hold");
  });

  it("a hold Razorpay refuses (plan question d: UNVERIFIED) leaves it released, alerts at once and tries again later", async () => {
    fake.allowReholdAfterRelease = false;
    const w = await mkWorld({ payoutStatus: "released", paused: true });
    const r = await reholdReleasedPayout(w.payout.id, { now: T(0) });
    expect(r).toMatchObject({ ok: false, outcome: "rejected", status: "released" });
    expect((await reload(w.payout.id)).nextAttemptAt).not.toBeNull();
    await flush();
    expect(subjects()).toContain("A released creator payout could not be held again");
  });

  it("money that already settled is not re-held: staff are told, no PATCH", async () => {
    const w = await mkWorld({ payoutStatus: "released", paused: true });
    fake.settleTransfer(w.transferId!);
    expect(await reholdReleasedPayout(w.payout.id, { now: T(0) })).toMatchObject({ ok: false, outcome: "already_settled" });
    expect(holdCalls()).toHaveLength(0);
    await flush();
    expect(subjects()).toContain("A released creator payout could not be held again");
  });

  it("applies only to a released payout", async () => {
    const w = await mkWorld({ payoutStatus: "held" });
    expect((await reholdReleasedPayout(w.payout.id, { now: T(0) })).outcome).toBe("not_applicable");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe("retryFailedPayout", () => {
  it("makes a NEW transfer for a failed payout, after proving none is alive, and restarts the attempt count", async () => {
    fake.balance = 10;
    const w = await mkWorld();
    expect((await executePlannedPayout(w.payout.id, { now: T(0) })).status).toBe("failed");
    fake.balance = 100_000_000;
    const r = await retryFailedPayout(w.payout.id, { now: T(1), actor: { type: "staff", id: "s" } });
    expect(r).toMatchObject({ ok: true, outcome: "held", status: "held" });
    expect(await reload(w.payout.id)).toMatchObject({ status: "held", attempts: 1, errorCode: null });
    expect(fake.calls.filter(is.listTransfers).length).toBeGreaterThan(0);
    expect(createCalls()).toHaveLength(2); // the refused one and the retry
  });

  it("is refused while a live transfer already carries the payout id, and for anything but failed", async () => {
    const w = await mkWorld({ payoutStatus: "failed", transfer: false });
    fake.seedTransfer({ source: w.pay, recipient: w.acc, amount: w.amount, notes: { payout_id: w.payout.id } });
    expect(await retryFailedPayout(w.payout.id, { now: T(0) })).toMatchObject({ ok: false, outcome: "transfer_still_active" });
    expect(createCalls()).toHaveLength(0);
    const h = await mkWorld({ payoutStatus: "held" });
    expect((await retryFailedPayout(h.payout.id, { now: T(0) })).outcome).toBe("not_failed");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe("the reconciliation job's view: selectDuePayouts and runPayoutJob", () => {
  it("lists each payout under the job that fits it, skips leased and backed-off rows, and orders the plan's jobs", async () => {
    const planned = await mkWorld();
    const unknown = await mkWorld({ payoutStatus: "transfer_requested" });
    const confirm = await mkWorld({ payoutStatus: "transfer_requested", transfer: true, transferStatus: "pending" });
    const release = await releasable();
    const notYet = await releasable({ releaseAfter: new Date(base + DAY) });
    const releasing = await mkWorld({ payoutStatus: "release_requested" });
    const settle = await mkWorld({ payoutStatus: "released" });
    const reversing = await mkWorld({ payoutStatus: "reversal_requested" });
    const leased = await mkWorld();
    await prisma.creatorPayout.update({ where: { id: leased.payout.id }, data: { lockedUntil: new Date(base + 10 * MIN) } });
    const backedOff = await mkWorld({ payoutStatus: "transfer_requested" });
    await prisma.creatorPayout.update({ where: { id: backedOff.payout.id }, data: { nextAttemptAt: new Date(base + 10 * MIN) } });
    const done = await mkWorld({ payoutStatus: "settled" });
    const disputed = await mkWorld({ payoutStatus: "released", paused: true });
    await prisma.creatorPayout.update({ where: { id: disputed.payout.id }, data: { pausedReason: "dispute", nextAttemptAt: null } });
    const staffPaused = await mkWorld({ payoutStatus: "released", paused: true }); // a staff pause is not an order to re-hold

    const due = await selectDuePayouts(T(1));
    const byId = new Map(due.map((d) => [d.id, d.job]));
    expect(byId.get(planned.payout.id)).toBe("execute");
    expect(byId.get(unknown.payout.id)).toBe("resolve_unknown");
    expect(byId.get(confirm.payout.id)).toBe("confirm_hold");
    expect(byId.get(release.payout.id)).toBe("release");
    expect(byId.get(releasing.payout.id)).toBe("resolve_release");
    expect(byId.get(settle.payout.id)).toBe("poll_settlement");
    expect(byId.get(reversing.payout.id)).toBe("resolve_reversal");
    // Not due: not yet releasable (but it is a daily re-read candidate), leased, backed off, finished.
    expect(byId.get(notYet.payout.id)).toBe("recheck_held");
    expect(byId.has(leased.payout.id)).toBe(false);
    expect(byId.has(backedOff.payout.id)).toBe(false);
    expect(byId.has(done.payout.id)).toBe(false);
    expect(byId.get(disputed.payout.id)).toBe("rehold_paused");
    expect(byId.get(staffPaused.payout.id)).toBe("poll_settlement");
    // The plan's order: execute first.
    expect(due[0].job).toBe("execute");
    // Bounded.
    expect((await selectDuePayouts(T(1), 2)).length).toBe(2);
  });

  it("runPayoutJob runs the named step and nothing else", async () => {
    const w = await mkWorld();
    expect(await runPayoutJob("execute", w.payout.id, { now: T(0) })).toMatchObject({ ok: true, status: "held" });
    const x = await releasable();
    expect(await runPayoutJob("release", x.payout.id, { now: T(0) })).toMatchObject({ ok: true, status: "released" });
    expect(await runPayoutJob("poll_settlement", x.payout.id, { now: T(1) })).toMatchObject({ outcome: "awaiting_settlement" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe("what the engine stores and logs", () => {
  const PAN = "ZYXWV9876Q";
  const IFSC = "ICIC0004321";
  const ACCOUNT_NUMBER = "998877665544332";

  it("no bank detail reaches a column, an audit row, an alert or the log, even when Razorpay's own error text quotes one", async () => {
    const con = captureConsole();
    try {
      // A refusal whose description echoes the creator's identifiers back, as validation errors can.
      fake.intercept({ match: is.createTransfer, mode: "reject", status: 400, body: { error: { code: "BAD_REQUEST_ERROR", description: `Account ${ACCOUNT_NUMBER} with IFSC ${IFSC} and PAN ${PAN} is not allowed` } } });
      const a = await mkWorld();
      expect((await executePlannedPayout(a.payout.id, { now: T(0) })).status).toBe("failed");
      // A reversal refusal and a release with the account's settlement details echoed in its product.
      fake.seedAccount({ id: a.acc, email: "echo@p4.test", productId: a.product, status: "activated", settlements: { account_number: ACCOUNT_NUMBER, ifsc_code: IFSC, beneficiary_name: "Echo Name" } });
      const b = await releasable();
      fake.seedAccount({ id: b.acc, email: "echo2@p4.test", productId: b.product, status: "activated", settlements: { account_number: ACCOUNT_NUMBER, ifsc_code: IFSC, beneficiary_name: "Echo Name" } });
      expect((await releasePayout(b.payout.id, { now: T(0) })).ok).toBe(true);
      fake.intercept({ match: is.createReversal, mode: "reject", status: 400, body: { error: { code: "BAD_REQUEST_ERROR", description: `PAN ${PAN} account ${ACCOUNT_NUMBER}` } } });
      await reversePayout(b.payout.id, { reason: "dispute", now: T(5) });
      await flush();
    } finally {
      con.restore();
    }
    expect(await scanDatabase([PAN, IFSC, ACCOUNT_NUMBER, "Echo Name"])).toEqual([]);
    const everything = [con.lines.join("\n"), JSON.stringify(notify.mock.calls)].join("\n");
    for (const needle of [PAN, IFSC, ACCOUNT_NUMBER, "Echo Name"]) expect(everything).not.toContain(needle);
  });

  it("the audit rows carry our own wording only: no payload, no provider id soup, bounded", async () => {
    const w = await releasable();
    await releasePayout(w.payout.id, { now: T(0) });
    fake.settleTransfer(w.transferId!, { utr: "AXISCN1153863727" });
    await pollSettlement(w.payout.id, { now: T(30) });
    for (const e of await eventsOf(w.payout.id)) {
      expect(e.note ?? "").not.toMatch(/\{|\}|"/);
      expect((e.note ?? "").length).toBeLessThanOrEqual(500);
      expect(e.actorType).toBe("system");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe("helpers for the refund, offer and capture code", () => {
  it("refundAllowanceForPayment: a refund waits while a transfer can still be made, and once a refund exists a failed payout is manual", async () => {
    const a = await mkWorld({ payoutStatus: "held" });
    expect(await refundAllowanceForPayment(a.pay)).toEqual({ allowed: true, blockedBy: [], manualRequired: [], retryAllowed: true });
    const b = await mkWorld({ payoutStatus: "planned" });
    expect(await refundAllowanceForPayment(b.pay)).toMatchObject({ allowed: false, blockedBy: [b.payout.id] });
    const c = await mkWorld({ payoutStatus: "transfer_requested" });
    expect(await refundAllowanceForPayment(c.pay)).toMatchObject({ allowed: false, blockedBy: [c.payout.id] });
    const d = await mkWorld({ payoutStatus: "failed", transfer: false });
    await prisma.campaignRefund.create({ data: { razorpayPaymentId: d.pay, amountPaise: 1, status: "pending", origin: "ours" } });
    expect(await refundAllowanceForPayment(d.pay)).toEqual({ allowed: true, blockedBy: [], manualRequired: [d.payout.id], retryAllowed: false });
    // A failed refund does not count.
    const e = await mkWorld({ payoutStatus: "failed", transfer: false });
    await prisma.campaignRefund.create({ data: { razorpayPaymentId: e.pay, amountPaise: 1, status: "failed", origin: "ours" } });
    expect(await refundAllowanceForPayment(e.pay)).toMatchObject({ manualRequired: [], retryAllowed: true });
  });

  it("reservedPaiseForPayment: the price of every creator item whose payout is not reversed or void", async () => {
    const w = await mkWorld({ payoutStatus: "held" });
    // A second payout on the SAME payment, reversed: it reserves nothing.
    const item2 = await prisma.campaignBookingItem.create({
      data: { bookingId: w.booking.id, rateCardId: randomUUID(), targetType: "creator_asset", targetId: randomUUID(), platform: "instagram", format: "reel", accountName: "Second", pricePaise: 70_000, status: "pending" },
    });
    await prisma.creatorPayout.create({
      data: { bookingId: w.booking.id, bookingItemId: item2.id, creatorId: randomUUID(), payoutAccountId: randomUUID(), razorpayAccountId: w.acc, razorpayPaymentId: w.pay, itemPricePaise: 70_000, shareBps: 5000, grossPaise: 35_000, amountPaise: 35_000, status: "reversed" },
    });
    expect(await reservedPaiseForPayment(w.pay)).toBe(w.price);
    await prisma.creatorPayout.update({ where: { bookingItemId: item2.id }, data: { status: "settled" } });
    expect(await reservedPaiseForPayment(w.pay)).toBe(w.price + 70_000);
    expect(await reservedPaiseForPayment("pay_NOSUCHPAYMENT1")).toBe(0);
    // Inside a transaction too.
    await prisma.$transaction(async (tx) => expect(await reservedPaiseForPayment(w.pay, tx)).toBe(w.price + 70_000));
  });

  it("scheduleRelease: verified_at + hold days, at least a day for a hand check, first scheduling only, never throws", async () => {
    const V = new Date("2026-10-18T10:00:00.000Z");
    const a = await mkWorld({ payoutStatus: "held", releaseAfter: null });
    expect(await scheduleRelease(a.item.id, { ownershipCheck: "auto_ok", verifiedAt: V })).toMatchObject({ scheduled: true, releaseAfter: V });
    expect((await reload(a.payout.id)).releaseAfter).toEqual(V);
    // A second call keeps the first.
    expect(await scheduleRelease(a.item.id, { ownershipCheck: "manual_ok", verifiedAt: new Date(V.getTime() + DAY) })).toMatchObject({ scheduled: false, reason: "not_schedulable_held" });
    expect((await reload(a.payout.id)).releaseAfter).toEqual(V);
    expect((await eventsOf(a.payout.id)).filter((e) => e.kind === "schedule")).toHaveLength(1);

    const b = await mkWorld({ payoutStatus: "held", releaseAfter: null });
    expect(await scheduleRelease(b.item.id, { ownershipCheck: "manual_ok", verifiedAt: V })).toMatchObject({ scheduled: true, releaseAfter: new Date(V.getTime() + DAY) });
    const c = await mkWorld({ payoutStatus: "planned", releaseAfter: null });
    expect(await scheduleRelease(c.item.id, { ownershipCheck: "auto_ok", verifiedAt: V, holdDays: 3 })).toMatchObject({ scheduled: true, releaseAfter: new Date(V.getTime() + 3 * DAY) });
    // The configured days apply by default.
    vi.stubEnv("CREATOR_PAYOUT_HOLD_DAYS", "2");
    const d = await mkWorld({ payoutStatus: "held", releaseAfter: null });
    expect(await scheduleRelease(d.item.id, { ownershipCheck: "auto_ok", verifiedAt: V })).toMatchObject({ releaseAfter: new Date(V.getTime() + 2 * DAY) });
    vi.stubEnv("CREATOR_PAYOUT_HOLD_DAYS", "garbage");
    const e = await mkWorld({ payoutStatus: "held", releaseAfter: null });
    expect(await scheduleRelease(e.item.id, { ownershipCheck: "auto_ok", verifiedAt: V })).toMatchObject({ releaseAfter: V });

    // Nothing to schedule: no payout, and states that can no longer be released.
    expect(await scheduleRelease(randomUUID(), { ownershipCheck: "auto_ok" })).toMatchObject({ scheduled: false, reason: "no_payout" });
    for (const status of ["void", "reversed", "settled", "released", "failed"]) {
      const w = await mkWorld({ payoutStatus: status, releaseAfter: null, transfer: false });
      expect((await scheduleRelease(w.item.id, { ownershipCheck: "auto_ok", verifiedAt: V })).scheduled, status).toBe(false);
    }
    expect(fake.calls).toHaveLength(0); // scheduling never talks to Razorpay
  });
});
