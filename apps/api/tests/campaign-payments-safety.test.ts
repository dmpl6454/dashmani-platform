/**
 * The money paths of campaign payments: capture, refunds, the refund ledger, the sweep, reject.
 *
 * Everything runs against Postgres with Razorpay replaced by a small in-memory model
 * (razorpayHttp.fetch). The model can answer a refund normally, refuse it (400), fail it (500) or
 * "time out" before or after it created the refund, which is what the safety rules are about:
 *   - a capture is claimed once and moves the booking once, however many events arrive;
 *   - a refund is claimed on a ledger BEFORE Razorpay is called and never twice;
 *   - only a definite refusal gives the claim back; an unknown answer keeps it and is reconciled;
 *   - a refund we did not make is detected and pauses creator payouts.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach, vi } from "vitest";
import request from "supertest";
import crypto from "crypto";
import { prisma } from "@dashmani/db";
import "./setup";

vi.mock("../src/services/email.service", async (orig) => {
  const actual = await orig<typeof import("../src/services/email.service")>();
  return { ...actual, sendEmail: vi.fn(async () => ({ messageId: "test" })), notifyAdminByEmail: vi.fn(async () => null) };
});

// Route events belong to another module; here only the endpoint's contract with it is tested.
vi.mock("../src/services/campaign/route-webhooks", () => ({
  isRouteEvent: (e: string) => e.startsWith("transfer.") || e.startsWith("payment.dispute."),
  handleRouteEvent: vi.fn(async () => ({ handled: true })),
}));

import app from "../src/app";
import { notifyAdminByEmail, sendEmail } from "../src/services/email.service";
import { razorpayHttp } from "../src/services/campaign/razorpay";
import * as bookingSvc from "../src/services/campaign/booking.service";
import { handleRouteEvent } from "../src/services/campaign/route-webhooks";
import { sendDeliveryEmail, getResults } from "../src/services/campaign/delivery.service";
import { refundableOn, refundPaymentRow, capturedPaymentFor, sweepRefundDue, reconcileRefunds, refundTuning, retryOnContention, isContention } from "../src/services/campaign/payment.service";
import { generateToken } from "./helpers";

const WEBHOOK_SECRET = "whsec_test_safety";
let savedPaymentMode: string | undefined;

beforeAll(() => {
  savedPaymentMode = process.env.CAMPAIGN_PAYMENT_MODE;
  delete process.env.CAMPAIGN_PAYMENT_MODE;
  process.env.RAZORPAY_KEY_ID = "rzp_test_key";
  process.env.RAZORPAY_KEY_SECRET = "rzp_test_secret";
  process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
});
afterAll(() => {
  for (const k of ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"]) delete process.env[k];
  if (savedPaymentMode !== undefined) process.env.CAMPAIGN_PAYMENT_MODE = savedPaymentMode;
});

// ── A tiny Razorpay ─────────────────────────────────────────────────────────────

type RefundMode = "ok" | "held" | "reject400" | "http500" | "timeout_before" | "timeout_after";
interface StoredRefund { id: string; amount: number; status: string; receipt: string | null; key: string | null }

/** A promise the test opens by hand: Razorpay "takes as long as the test says", with no sleeps and no timing. */
function gate() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

const rz = {
  mode: "ok" as RefundMode,
  listFails: false,
  /** While set, a refund POST (mode "held") / a refund-list GET does not answer until the test opens it. */
  postGate: null as Promise<void> | null,
  listGate: null as Promise<void> | null,
  /** The status Razorpay gives a refund it creates. */
  newStatus: "processed",
  refunds: new Map<string, StoredRefund[]>(), // by razorpay payment id
  calls: [] as Array<{ method: string; url: string; body: any; key: string | undefined }>,
  n: 0,
};
const refundPosts = () => rz.calls.filter((c) => c.method === "POST" && c.url.endsWith("/refund"));
const allRefunds = () => [...rz.refunds.values()].flat();

function stubRazorpay() {
  rz.mode = "ok";
  rz.listFails = false;
  rz.postGate = null;
  rz.listGate = null;
  rz.newStatus = "processed";
  rz.refunds.clear();
  rz.calls.length = 0;
  rz.n = 0;
  razorpayHttp.fetch = (async (url: any, init: any) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : null;
    const key = init?.headers?.["X-Refund-Idempotency"] as string | undefined;
    rz.calls.push({ method, url: u, body, key });

    const post = /\/payments\/([^/?]+)\/refund$/.exec(u);
    if (method === "POST" && post) {
      const pid = post[1];
      if (rz.mode === "reject400") {
        return new Response(JSON.stringify({ error: { code: "BAD_REQUEST_ERROR", description: "Your account does not have enough balance to carry out the refund operation." } }), { status: 400 });
      }
      if (rz.mode === "http500") return new Response("upstream error", { status: 500 });
      if (rz.mode === "timeout_before") throw new TypeError("fetch failed");
      if (rz.mode === "held" && rz.postGate) await rz.postGate;
      const list = rz.refunds.get(pid) ?? [];
      // Razorpay's own idempotency: the same key returns the original refund.
      let r = key ? list.find((x) => x.key === key) : undefined;
      if (!r) {
        r = { id: `rfnd_${++rz.n}`, amount: body.amount, status: rz.newStatus, receipt: body.receipt ?? null, key: key ?? null };
        list.push(r);
        rz.refunds.set(pid, list);
      }
      if (rz.mode === "timeout_after") throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ id: r.id, entity: "refund", amount: r.amount, status: r.status, payment_id: pid, receipt: r.receipt }), { status: 200 });
    }

    const get = /\/payments\/([^/?]+)\/refunds(\?|$)/.exec(u);
    if (method === "GET" && get) {
      if (rz.listGate) await rz.listGate;
      if (rz.listFails) return new Response("down", { status: 500 });
      const items = (rz.refunds.get(get[1]) ?? []).map((r) => ({ id: r.id, entity: "refund", amount: r.amount, status: r.status, receipt: r.receipt, payment_id: get[1] }));
      return new Response(JSON.stringify({ entity: "collection", count: items.length, items }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
}

function webhook(event: string, entity: Record<string, unknown>, kind: "payment" | "refund" = "payment", eventId = crypto.randomUUID()) {
  const raw = JSON.stringify({ event, payload: { [kind]: { entity } } });
  const sig = crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
  return request(app).post("/v1/webhooks/razorpay").set("Content-Type", "application/json").set("x-razorpay-signature", sig).set("x-razorpay-event-id", eventId).send(raw);
}

// ── Seeding (straight into the database: no wizard, no media) ───────────────────

let admin: string;
let clientId: string;
let seq = 0;

async function seed(o: { booking: string; prices: number[]; items?: string[]; total?: number | null; payment?: { status: string; refunded?: number } | null }) {
  const n = ++seq;
  const total = o.total === undefined ? o.prices.reduce((a, b) => a + b, 0) : o.total;
  const booking = await prisma.campaignBooking.create({
    data: { clientId, name: `Campaign ${n}`, brand: "Brand", status: o.booking, totalPaise: total, format: "post", launchFrom: new Date(), launchTo: new Date(), paidAt: o.payment && o.payment.status !== "created" ? new Date() : null },
  });
  const items = [];
  for (let i = 0; i < o.prices.length; i++) {
    items.push(
      await prisma.campaignBookingItem.create({
        data: { bookingId: booking.id, rateCardId: `rc-${n}-${i}`, targetType: "meta_asset", targetId: `t-${n}-${i}`, platform: "instagram", format: "post", accountName: `Account ${i}`, pricePaise: o.prices[i], status: o.items?.[i] ?? "pending" },
      }),
    );
  }
  const payment = o.payment === null || o.payment === undefined
    ? null
    : await prisma.campaignPayment.create({
        data: {
          bookingId: booking.id,
          razorpayOrderId: `order_${n}`,
          razorpayPaymentId: o.payment.status === "created" ? null : `pay_${n}`,
          amountPaise: total ?? 0,
          status: o.payment.status,
          refundedPaise: o.payment.refunded ?? 0,
        },
      });
  return { booking, items, payment, n };
}

const paid = (n: number, amount: number, extra: Record<string, unknown> = {}) => ({ id: `pay_${n}`, order_id: `order_${n}`, amount, currency: "INR", ...extra });
const bookingEvents = (bookingId: string) => prisma.campaignBookingEvent.findMany({ where: { bookingId }, orderBy: { createdAt: "asc" } });
const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);

const post = (path: string, body?: unknown) => request(app).post(path).set("Authorization", `Bearer ${admin}`).send(body ?? {});
/** The subjects of every staff alert sent so far in this test. */
const alertSubjects = () => vi.mocked(notifyAdminByEmail).mock.calls.map((c) => String(c[0]));
/** Make a ledger row look older, so a sweep treats it as unanswered for long enough (the sweep's own `now` cannot move the row's clock). */
const backdate = (refundId: string, minutes: number) => prisma.campaignRefund.update({ where: { id: refundId }, data: { createdAt: new Date(Date.now() - minutes * 60_000) } });

// vitest runs top-level beforeEach hooks in parallel with setup.ts's TRUNCATE; hooks inside a describe run after it.
describe("campaign payment safety", () => {
  beforeEach(async () => {
    stubRazorpay();
    vi.mocked(notifyAdminByEmail).mockClear();
    vi.mocked(handleRouteEvent).mockClear();
    const client = await prisma.client.create({ data: { companyName: "Brand A", contactName: "Asha", email: "a@brand.test", passwordHash: "x" } });
    clientId = client.id;
    const staff = await prisma.user.create({ data: { name: "Staff", email: "staff@ds.test", passwordHash: "x", status: "ACTIVE" } });
    admin = generateToken(staff.id, staff.email, ["Admin"]);
  });
  afterEach(() => vi.restoreAllMocks());

  // ── Pure ────────────────────────────────────────────────────────────────────────

  describe("refundableOn", () => {
    it("is captured minus refunded minus reserved, and never negative", () => {
      expect(refundableOn({ amountPaise: 100_000, refundedPaise: 30_000 })).toBe(70_000);
      expect(refundableOn({ amountPaise: 100_000, refundedPaise: 30_000 }, 20_000)).toBe(50_000);
      expect(refundableOn({ amountPaise: 100_000, refundedPaise: 90_000 }, 20_000)).toBe(0);
    });
  });

  // ── Capture ─────────────────────────────────────────────────────────────────────

  describe("capture: claim the payment first", () => {
    it("payment.captured + order.paid together move the booking once and never refund", async () => {
      const s = await seed({ booking: "awaiting_payment", prices: [250_000], payment: { status: "created" } });
      // Different payment ids make "only the winner's id is used" visible; a real redelivery carries the same one.
      const [a, b] = await Promise.all([webhook("payment.captured", paid(s.n, 250_000, { id: "pay_A" })), webhook("order.paid", paid(s.n, 250_000, { id: "pay_B" }))]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect([a, b].filter((r) => r.body.data.duplicate === true)).toHaveLength(1);

      const booking = await prisma.campaignBooking.findUniqueOrThrow({ where: { id: s.booking.id } });
      expect(booking.status).toBe("paid_pending_review");
      expect(booking.paidAt).not.toBeNull();
      const moves = (await bookingEvents(s.booking.id)).filter((e) => e.toStatus === "paid_pending_review");
      expect(moves).toHaveLength(1);
      const pay = await prisma.campaignPayment.findUniqueOrThrow({ where: { id: s.payment!.id } });
      expect(pay.status).toBe("captured");
      expect(["pay_A", "pay_B"]).toContain(pay.razorpayPaymentId);
      expect(moves[0].note).toContain(pay.razorpayPaymentId!);
      expect(refundPosts()).toHaveLength(0);
      expect(await prisma.campaignRefund.count()).toBe(0);
    });

    it("a failure after the claim rolls everything back, so Razorpay's retry runs cleanly", async () => {
      const s = await seed({ booking: "awaiting_payment", prices: [250_000], payment: { status: "created" } });
      const spy = vi.spyOn(bookingSvc, "transitionBooking").mockRejectedValueOnce(new Error("boom"));
      const eventId = crypto.randomUUID();

      const first = await webhook("payment.captured", paid(s.n, 250_000), "payment", eventId);
      expect(first.status).toBe(500);
      // Not "captured but stuck": nothing of the half-finished work survived.
      const mid = await prisma.campaignPayment.findUniqueOrThrow({ where: { id: s.payment!.id } });
      expect(mid.status).toBe("created");
      expect(mid.razorpayPaymentId).toBeNull();
      expect((await prisma.campaignBooking.findUniqueOrThrow({ where: { id: s.booking.id } })).status).toBe("awaiting_payment");
      expect((await prisma.razorpayWebhookEvent.findUniqueOrThrow({ where: { eventId } })).processedAt).toBeNull();
      expect(refundPosts()).toHaveLength(0);

      const retry = await webhook("payment.captured", paid(s.n, 250_000), "payment", eventId);
      expect(retry.status).toBe(200);
      expect(retry.body.data.duplicate).toBeUndefined();
      expect((await prisma.campaignBooking.findUniqueOrThrow({ where: { id: s.booking.id } })).status).toBe("paid_pending_review");
      expect((await prisma.campaignPayment.findUniqueOrThrow({ where: { id: s.payment!.id } })).status).toBe("captured");
      spy.mockRestore();
    });

    it("a payment that does not match is recorded refund_due, then refunded after the commit", async () => {
      // The client edited after checkout (back to draft, no total) and then paid the old order.
      const s = await seed({ booking: "draft", prices: [250_000], total: null, payment: { status: "created" } });
      await prisma.campaignPayment.update({ where: { id: s.payment!.id }, data: { amountPaise: 250_000 } });
      const res = await webhook("payment.captured", paid(s.n, 250_000));
      expect(res.status).toBe(200);

      const posts = refundPosts();
      expect(posts).toHaveLength(1);
      expect(posts[0].body.amount).toBe(250_000);
      expect(posts[0].key).toBe(`rf-stale-${s.payment!.id}`);
      const pay = await prisma.campaignPayment.findUniqueOrThrow({ where: { id: s.payment!.id } });
      expect(pay.status).toBe("refunded");
      expect(pay.refundedPaise).toBe(250_000);
      const rows = await prisma.campaignRefund.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "processed", origin: "ours", reason: "outdated_order", amountPaise: 250_000, idempotencyKey: `rf-stale-${s.payment!.id}` });
      expect((await prisma.campaignBooking.findUniqueOrThrow({ where: { id: s.booking.id } })).status).toBe("draft");
      // Nothing is left for the sweep to do.
      const swept = await sweepRefundDue({ now: later(30) });
      expect(swept).toMatchObject({ issued: 0, resumed: 0 });
      expect(refundPosts()).toHaveLength(1);
    });

    it("a duplicate payment on an already-paid booking is refunded and the booking is untouched", async () => {
      const s = await seed({ booking: "paid_pending_review", prices: [250_000], payment: { status: "captured" } });
      const dup = await prisma.campaignPayment.create({ data: { bookingId: s.booking.id, razorpayOrderId: "order_dup", amountPaise: 250_000 } });
      const res = await webhook("payment.captured", { id: "pay_dup", order_id: "order_dup", amount: 250_000, currency: "INR" });
      expect(res.status).toBe(200);
      expect((await prisma.campaignPayment.findUniqueOrThrow({ where: { id: dup.id } })).status).toBe("refunded");
      expect((await prisma.campaignPayment.findUniqueOrThrow({ where: { id: s.payment!.id } })).status).toBe("captured");
      expect((await prisma.campaignBooking.findUniqueOrThrow({ where: { id: s.booking.id } })).status).toBe("paid_pending_review");
      expect((await prisma.campaignRefund.findFirstOrThrow()).reason).toBe("duplicate_payment");
    });

    it("a payment that failed and was then retried on the same order is captured, not dismissed as a duplicate", async () => {
      // Razorpay sends payment.failed for each failed attempt; the client's next attempt on the SAME order succeeds.
      const s = await seed({ booking: "awaiting_payment", prices: [250_000], payment: { status: "created" } });
      const failed = await webhook("payment.failed", { id: "pay_failed_try", order_id: `order_${s.n}`, amount: 250_000, currency: "INR" });
      expect(failed.status).toBe(200);
      expect((await prisma.campaignPayment.findUniqueOrThrow({ where: { id: s.payment!.id } })).status).toBe("failed");

      const res = await webhook("payment.captured", paid(s.n, 250_000, { id: "pay_second_try" }));
      expect(res.status).toBe(200);
      expect(res.body.data.duplicate).toBeUndefined();
      expect((await prisma.campaignBooking.findUniqueOrThrow({ where: { id: s.booking.id } })).status).toBe("paid_pending_review");
      expect((await bookingEvents(s.booking.id)).filter((e) => e.toStatus === "paid_pending_review")).toHaveLength(1);
      expect(await prisma.campaignPayment.findUniqueOrThrow({ where: { id: s.payment!.id } })).toMatchObject({ status: "captured", razorpayPaymentId: "pay_second_try" });
      expect(refundPosts()).toHaveLength(0);
    });

    it("a capture for a different amount is refunded for what Razorpay actually took, and the booking is not moved", async () => {
      const s = await seed({ booking: "awaiting_payment", prices: [250_000], payment: { status: "created" } });
      const res = await webhook("payment.captured", paid(s.n, 249_000));
      expect(res.status).toBe(200);

      const booking = await prisma.campaignBooking.findUniqueOrThrow({ where: { id: s.booking.id } });
      expect(booking.status).toBe("awaiting_payment");
      expect(booking.paidAt).toBeNull();
      expect((await bookingEvents(s.booking.id)).filter((e) => e.toStatus === "paid_pending_review")).toHaveLength(0);
      const posts = refundPosts();
      expect(posts).toHaveLength(1);
      expect(posts[0].body.amount).toBe(249_000);
      expect(posts[0].key).toBe(`rf-stale-${s.payment!.id}`);
      // The dead row now says what was captured (not what was ordered), and all of it came back.
      expect(await prisma.campaignPayment.findUniqueOrThrow({ where: { id: s.payment!.id } })).toMatchObject({ status: "refunded", amountPaise: 249_000, refundedPaise: 249_000 });
      expect(await prisma.campaignRefund.findFirstOrThrow()).toMatchObject({ amountPaise: 249_000, reason: "outdated_order", status: "processed" });
    });

    it("a capture in another currency is refunded and the booking is not moved", async () => {
      const s = await seed({ booking: "awaiting_payment", prices: [250_000], payment: { status: "created" } });
      const res = await webhook("payment.captured", paid(s.n, 250_000, { currency: "USD" }));
      expect(res.status).toBe(200);

      expect((await prisma.campaignBooking.findUniqueOrThrow({ where: { id: s.booking.id } })).status).toBe("awaiting_payment");
      expect(refundPosts()).toHaveLength(1);
      expect(await prisma.campaignRefund.findFirstOrThrow()).toMatchObject({ reason: "outdated_order", amountPaise: 250_000 });
      expect((await prisma.campaignPayment.findUniqueOrThrow({ where: { id: s.payment!.id } })).status).toBe("refunded");
    });
  });

  // ── The sweep ───────────────────────────────────────────────────────────────────

  describe("refund sweep", () => {
    async function mismatch() {
      const s = await seed({ booking: "draft", prices: [250_000], total: null, payment: { status: "created" } });
      await prisma.campaignPayment.update({ where: { id: s.payment!.id }, data: { amountPaise: 250_000 } });
      return s;
    }

    it("a refund Razorpay refuses at capture time still answers 2xx; the payment stays owed for the sweep", async () => {
      const s = await mismatch();
      rz.mode = "reject400";
      const res = await webhook("payment.captured", paid(s.n, 250_000));
      expect(res.status).toBe(200);
      expect(res.body.data.note).toBe("refund will be retried");
      expect(await prisma.campaignPayment.findUniqueOrThrow({ where: { id: s.payment!.id } })).toMatchObject({ status: "refund_due", refundedPaise: 0 });
      expect((await prisma.campaignRefund.findFirstOrThrow()).status).toBe("failed");
      expect((await prisma.razorpayWebhookEvent.findFirstOrThrow()).processedAt).not.toBeNull();
    });

    it("a slow refund call does not hold the webhook past its deadline, and still completes", async () => {
      const s = await mismatch();
      // Razorpay does not answer the refund until the test says so: the deadline is certain to pass, whatever the machine's speed.
      const hold = gate();
      rz.mode = "held";
      rz.postGate = hold.wait;
      const saved = refundTuning.inlineDeadlineMs;
      refundTuning.inlineDeadlineMs = 50;
      try {
        const res = await webhook("payment.captured", paid(s.n, 250_000));
        expect(res.status).toBe(200);
        expect(res.body.data.note).toBe("refund in progress");
      } finally {
        refundTuning.inlineDeadlineMs = saved;
      }
      // The call reached Razorpay (so the claim had committed) and is waiting there: claimed, not yet confirmed.
      await vi.waitFor(() => expect(refundPosts()).toHaveLength(1), { timeout: 5000, interval: 10 });
      expect((await prisma.campaignRefund.findFirstOrThrow()).status).toBe("requested");

      hold.open();
      await vi.waitFor(async () => expect((await prisma.campaignPayment.findUniqueOrThrow({ where: { id: s.payment!.id } })).status).toBe("refunded"), { timeout: 5000, interval: 25 });
      expect(refundPosts()).toHaveLength(1);
    });

    it("recovers a refund whose first call timed out after Razorpay created it: no second refund", async () => {
      const s = await mismatch();
      rz.mode = "timeout_after";
      const res = await webhook("payment.captured", paid(s.n, 250_000));
      expect(res.status).toBe(200);
      expect(res.body.data.note).toBe("refund confirming");
      // The claim is kept and the payment is still owed in full: nobody was told it failed.
      expect((await prisma.campaignPayment.findUniqueOrThrow({ where: { id: s.payment!.id } }))).toMatchObject({ status: "refund_due", refundedPaise: 250_000 });
      expect((await prisma.campaignRefund.findFirstOrThrow()).status).toBe("requested");

      rz.mode = "ok";
      const swept = await sweepRefundDue({ now: later(10) });
      expect(swept.errors).toBe(0);
      expect(swept.reconciled).toBe(1);
      const row = await prisma.campaignRefund.findFirstOrThrow();
      expect(row).toMatchObject({ status: "processed", razorpayRefundId: "rfnd_1", origin: "ours" });
      expect((await prisma.campaignPayment.findUniqueOrThrow({ where: { id: s.payment!.id } })).status).toBe("refunded");
      expect(refundPosts()).toHaveLength(1);
      expect(allRefunds()).toHaveLength(1);
    });

    it("re-sends a refund Razorpay never received, with the SAME key, once its list shows nothing", async () => {
      const s = await mismatch();
      rz.mode = "timeout_before";
      await webhook("payment.captured", paid(s.n, 250_000));
      expect(refundPosts()).toHaveLength(1);

      rz.mode = "ok";
      // Too early: only a look at the list, no re-send yet.
      expect((await sweepRefundDue({ now: later(3) })).resumed).toBe(0);
      expect(refundPosts()).toHaveLength(1);

      const swept = await sweepRefundDue({ now: later(10) });
      expect(swept.resumed).toBe(1);
      const posts = refundPosts();
      expect(posts).toHaveLength(2);
      expect(posts[1].key).toBe(posts[0].key);
      expect(allRefunds()).toHaveLength(1);
      expect(await prisma.campaignRefund.count()).toBe(1);
      expect((await prisma.campaignPayment.findUniqueOrThrow({ where: { id: s.payment!.id } })).status).toBe("refunded");
    });

    it("refunds a payment left refund_due after a crash, and backs off after a refusal", async () => {
      const s = await seed({ booking: "draft", prices: [250_000], total: null, payment: { status: "refund_due" } });
      await prisma.campaignPayment.update({ where: { id: s.payment!.id }, data: { amountPaise: 250_000, razorpayPaymentId: "pay_crashed" } });

      rz.mode = "reject400";
      let swept = await sweepRefundDue({ now: later(2) });
      expect(swept.errors).toBe(1);
      expect(refundPosts()).toHaveLength(1);
      // Refused: the claim went back, the payment is still owed in full.
      expect(await prisma.campaignPayment.findUniqueOrThrow({ where: { id: s.payment!.id } })).toMatchObject({ status: "refund_due", refundedPaise: 0 });
      // Backing off: the next tick does not hammer Razorpay.
      swept = await sweepRefundDue({ now: later(3) });
      expect(refundPosts()).toHaveLength(1);

      rz.mode = "ok";
      swept = await sweepRefundDue({ now: later(20) });
      expect(swept.issued).toBe(1);
      const keys = refundPosts().map((c) => c.key);
      expect(keys).toEqual([`rf-stale-${s.payment!.id}`, `rf-stale-${s.payment!.id}-r2`]);
      expect((await prisma.campaignPayment.findUniqueOrThrow({ where: { id: s.payment!.id } })).status).toBe("refunded");
    });

    it("does nothing when Razorpay is not configured", async () => {
      await seed({ booking: "draft", prices: [100_000], total: null, payment: { status: "refund_due" } });
      const keys = [process.env.RAZORPAY_KEY_ID, process.env.RAZORPAY_KEY_SECRET];
      delete process.env.RAZORPAY_KEY_ID;
      delete process.env.RAZORPAY_KEY_SECRET;
      try {
        expect(await sweepRefundDue({ now: later(10) })).toEqual({ issued: 0, reconciled: 0, resumed: 0, errors: 0 });
        expect(rz.calls).toHaveLength(0);
      } finally {
        process.env.RAZORPAY_KEY_ID = keys[0];
        process.env.RAZORPAY_KEY_SECRET = keys[1];
      }
    });
  });

  // ── Item refunds ────────────────────────────────────────────────────────────────

  describe("refunding an item", () => {
    const refundItem = (bookingId: string, itemId: string) => post(`/v1/admin/campaigns/${bookingId}/items/${itemId}/refund`);
    async function approvedWithTwoItems() {
      return seed({ booking: "approved", prices: [100_000, 150_000], items: ["manual_pending", "manual_pending"], payment: { status: "captured" } });
    }

    it("an unanswered item refund tells staff the truth about the sweep: 'checking automatically' only while it runs", async () => {
      const saved = process.env.CAMPAIGN_REFUND_SWEEP_ENABLED;
      try {
        rz.mode = "http500";
        const on = await approvedWithTwoItems();
        const running = await refundItem(on.booking.id, on.items[0].id);
        expect(running.body.data.refundNotice).toContain("We're checking automatically");

        process.env.CAMPAIGN_REFUND_SWEEP_ENABLED = "0";
        const off = await approvedWithTwoItems();
        const paused = await refundItem(off.booking.id, off.items[0].id);
        expect(paused.status).toBe(200);
        expect(paused.body.data.refundNotice).toContain("switched off");
        expect(paused.body.data.refundNotice).not.toContain("checking automatically");
      } finally {
        if (saved === undefined) delete process.env.CAMPAIGN_REFUND_SWEEP_ENABLED;
        else process.env.CAMPAIGN_REFUND_SWEEP_ENABLED = saved;
      }
    });

    it("a timeout never leads to a second refund: same key, one ledger row, the item stays claimed", async () => {
      const s = await approvedWithTwoItems();
      rz.mode = "timeout_after";
      const first = await refundItem(s.booking.id, s.items[0].id);
      expect(first.status).toBe(200);
      expect(first.body.data.refundNotice).toContain("hasn't confirmed");
      expect((await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: s.items[0].id } })).status).toBe("refunded");
      let row = await prisma.campaignRefund.findFirstOrThrow();
      expect(row).toMatchObject({ status: "requested", idempotencyKey: `rf-item-${s.items[0].id}`, bookingItemId: s.items[0].id, amountPaise: 100_000 });
      expect(await prisma.campaignPayment.findUniqueOrThrow({ where: { id: s.payment!.id } })).toMatchObject({ refundedPaise: 100_000, status: "refund_pending" });
      expect((await bookingEvents(s.booking.id)).some((e) => (e.note ?? "").includes("confirming with Razorpay"))).toBe(true);

      // A second click: the item is already refunded, so it is refused and nothing is sent.
      const again = await refundItem(s.booking.id, s.items[0].id);
      expect(again.status).toBe(409);
      // The same intent through the service: it finds its row, claims nothing, sends nothing.
      const posts = refundPosts().length;
      const result = await refundPaymentRow(s.payment!.id, 100_000, "x", { type: "system" }, { key: `rf-item-${s.items[0].id}`, reason: "item_refunded", itemId: s.items[0].id });
      expect(result.state).toBe("confirming");
      expect(refundPosts()).toHaveLength(posts);
      expect(await prisma.campaignRefund.count()).toBe(1);
      expect((await prisma.campaignPayment.findUniqueOrThrow({ where: { id: s.payment!.id } })).refundedPaise).toBe(100_000);

      // The other item can still be refunded while the first is unconfirmed.
      rz.mode = "ok";
      const second = await refundItem(s.booking.id, s.items[1].id);
      expect(second.status).toBe(200);
      expect(second.body.data.refundNotice).toBeNull();

      // The sweep finds the first refund in Razorpay's list and links it: exactly two refunds exist.
      await sweepRefundDue({ now: later(10) });
      row = await prisma.campaignRefund.findFirstOrThrow({ where: { bookingItemId: s.items[0].id } });
      expect(row).toMatchObject({ status: "processed", razorpayRefundId: "rfnd_1" });
      expect(allRefunds().map((r) => r.amount).sort()).toEqual([100_000, 150_000]);
      expect(await prisma.campaignPayment.findUniqueOrThrow({ where: { id: s.payment!.id } })).toMatchObject({ refundedPaise: 250_000, status: "refunded" });
    });

    it("a definite refusal rolls the claim back and a retry uses a fresh key", async () => {
      const s = await approvedWithTwoItems();
      rz.mode = "reject400";
      const res = await refundItem(s.booking.id, s.items[0].id);
      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe("REFUND_FAILED");
      expect(res.body.error.message.toLowerCase()).not.toContain("dashboard");
      expect((await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: s.items[0].id } })).status).toBe("manual_pending");
      expect(await prisma.campaignPayment.findUniqueOrThrow({ where: { id: s.payment!.id } })).toMatchObject({ refundedPaise: 0, status: "captured" });
      const failed = await prisma.campaignRefund.findFirstOrThrow();
      expect(failed.status).toBe("failed");
      expect(failed.lastError).toContain("balance");
      expect((await bookingEvents(s.booking.id)).some((e) => (e.note ?? "").includes("FAILED"))).toBe(true);

      rz.mode = "ok";
      const retry = await refundItem(s.booking.id, s.items[0].id);
      expect(retry.status).toBe(200);
      const rows = await prisma.campaignRefund.findMany({ orderBy: { createdAt: "asc" } });
      expect(rows.map((r) => [r.idempotencyKey, r.status])).toEqual([
        [`rf-item-${s.items[0].id}`, "failed"],
        [`rf-item-${s.items[0].id}-r2`, "processed"],
      ]);
      expect(await prisma.campaignPayment.findUniqueOrThrow({ where: { id: s.payment!.id } })).toMatchObject({ refundedPaise: 100_000, status: "captured" });
      expect(allRefunds()).toHaveLength(1);
    });

    it("an unknown answer keeps the claim as refund_pending; the refund event reconciles it", async () => {
      const s = await approvedWithTwoItems();
      rz.mode = "http500";
      const res = await refundItem(s.booking.id, s.items[0].id);
      expect(res.status).toBe(200);
      expect(res.body.data.refundNotice).toBeTruthy();
      expect(await prisma.campaignPayment.findUniqueOrThrow({ where: { id: s.payment!.id } })).toMatchObject({ refundedPaise: 100_000, status: "refund_pending" });
      expect((await prisma.campaignRefund.findFirstOrThrow()).status).toBe("requested");

      // Razorpay had in fact created it (the 500 came from a proxy); its event arrives.
      const receipt = `item:${s.items[0].id.slice(0, 30)}`;
      rz.refunds.set(s.payment!.razorpayPaymentId!, [{ id: "rfnd_late", amount: 100_000, status: "processed", receipt, key: null }]);
      const evt = await webhook("refund.processed", { id: "rfnd_late", payment_id: s.payment!.razorpayPaymentId, amount: 100_000 }, "refund");
      expect(evt.status).toBe(200);
      const rows = await prisma.campaignRefund.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "processed", razorpayRefundId: "rfnd_late", origin: "ours" });
      expect(await prisma.campaignPayment.findUniqueOrThrow({ where: { id: s.payment!.id } })).toMatchObject({ refundedPaise: 100_000, status: "captured" });
      expect(vi.mocked(notifyAdminByEmail)).not.toHaveBeenCalled();
    });

    it("a refund event whose list can't be read still answers 2xx and is reconciled by the sweep", async () => {
      const s = await approvedWithTwoItems();
      rz.listFails = true;
      rz.refunds.set(s.payment!.razorpayPaymentId!, [{ id: "rfnd_x", amount: 40_000, status: "processed", receipt: null, key: null }]);
      const evt = await webhook("refund.processed", { id: "rfnd_x", payment_id: s.payment!.razorpayPaymentId }, "refund");
      expect(evt.status).toBe(200);
      expect(evt.body.data.note).toBe("reconcile deferred");
      expect(await prisma.campaignRefund.count()).toBe(0);

      rz.listFails = false;
      const swept = await sweepRefundDue({ now: later(5) });
      expect(swept.reconciled).toBe(1);
      expect(await prisma.campaignRefund.findFirstOrThrow()).toMatchObject({ razorpayRefundId: "rfnd_x", origin: "external" });
    });

    it("a refund event whose list hangs past the deadline still answers 2xx, marks the payment, and finishes in the background", async () => {
      const s = await approvedWithTwoItems();
      const pid = s.payment!.razorpayPaymentId!;
      rz.refunds.set(pid, [{ id: "rfnd_hang", amount: 40_000, status: "processed", receipt: null, key: null }]);
      // Razorpay's refund list does not answer until the test opens it, however short the deadline is.
      const hold = gate();
      rz.listGate = hold.wait;
      const saved = refundTuning.inlineDeadlineMs;
      refundTuning.inlineDeadlineMs = 50;
      let evt: request.Response;
      try {
        evt = await webhook("refund.processed", { id: "rfnd_hang", payment_id: pid }, "refund", "evt-hang-1");
      } finally {
        refundTuning.inlineDeadlineMs = saved;
      }
      expect(evt.status).toBe(200);
      expect(evt.body.data.note).toBe("reconcile deferred");
      // Marked for the sweep, and the event is finished: Razorpay is not asked to redeliver it.
      expect((await prisma.campaignPayment.findUniqueOrThrow({ where: { id: s.payment!.id } })).lastEvent).toBe("refund.reconcile_pending");
      expect((await prisma.razorpayWebhookEvent.findUniqueOrThrow({ where: { eventId: "evt-hang-1" } })).processedAt).not.toBeNull();
      expect(await prisma.campaignRefund.count()).toBe(0);

      // The list finally answers: the reconcile that was still running completes by itself and clears the marker.
      hold.open();
      await vi.waitFor(async () => expect(await prisma.campaignRefund.findFirst({ where: { razorpayRefundId: "rfnd_hang" } })).toMatchObject({ origin: "external", status: "processed" }), { timeout: 5000, interval: 25 });
      await vi.waitFor(() => expect(alertSubjects()).toContain("Refund found on a campaign payment that we did not issue"), { timeout: 5000, interval: 25 });
      expect((await prisma.campaignPayment.findUniqueOrThrow({ where: { id: s.payment!.id } })).lastEvent).toBe("refund.reconciled");
    });

    it("capturedPaymentFor looks at what is refundable, and never at money that is owed in full", async () => {
      const s = await seed({ booking: "approved", prices: [100_000, 150_000], payment: { status: "refund_pending", refunded: 100_000 } });
      expect((await capturedPaymentFor(s.booking.id, 150_000))?.id).toBe(s.payment!.id);
      expect(await capturedPaymentFor(s.booking.id, 150_001)).toBeNull();
      await prisma.campaignPayment.update({ where: { id: s.payment!.id }, data: { status: "refund_due" } });
      expect(await capturedPaymentFor(s.booking.id, 100_000)).toBeNull();
      expect((await capturedPaymentFor(s.booking.id, 100_000, { only: [s.payment!.id] }))?.id).toBe(s.payment!.id);
    });

    // ── A refund that FAILS after the item was marked refunded ────────────────────

    it("a refund Razorpay accepted and then failed is issued again by the sweep, under a fresh key, and alerted once", async () => {
      const s = await approvedWithTwoItems();
      const itemId = s.items[0].id;
      const pid = s.payment!.razorpayPaymentId!;
      rz.newStatus = "pending";
      expect((await refundItem(s.booking.id, itemId)).status).toBe(200);
      expect(await prisma.campaignRefund.findFirstOrThrow()).toMatchObject({ status: "pending", idempotencyKey: `rf-item-${itemId}` });
      expect(await prisma.campaignPayment.findUniqueOrThrow({ where: { id: s.payment!.id } })).toMatchObject({ status: "refund_pending", refundedPaise: 100_000 });

      // Razorpay fails it after accepting it.
      rz.refunds.get(pid)![0].status = "failed";
      expect((await webhook("refund.failed", { id: "rfnd_1", payment_id: pid }, "refund")).status).toBe(200);
      expect(await prisma.campaignRefund.findFirstOrThrow()).toMatchObject({ status: "failed", razorpayRefundId: "rfnd_1" });
      expect(await prisma.campaignPayment.findUniqueOrThrow({ where: { id: s.payment!.id } })).toMatchObject({ status: "refund_failed", refundedPaise: 0 });
      expect(alertSubjects()).toEqual(["A campaign refund failed at Razorpay"]);
      expect((await bookingEvents(s.booking.id)).some((e) => (e.note ?? "").includes("failed at Razorpay"))).toBe(true);
      // The item stays refunded, so staff have no button for it ...
      expect((await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: itemId } })).status).toBe("refunded");
      expect((await refundItem(s.booking.id, itemId)).status).toBe(409);
      // ... and the same event again changes nothing and alerts nobody a second time.
      await webhook("refund.failed", { id: "rfnd_1", payment_id: pid }, "refund");
      expect(await prisma.campaignPayment.findUniqueOrThrow({ where: { id: s.payment!.id } })).toMatchObject({ status: "refund_failed", refundedPaise: 0 });
      expect(alertSubjects()).toHaveLength(1);

      // So the sweep does it, after its backoff (5 minutes per failure).
      rz.newStatus = "processed";
      expect((await sweepRefundDue({ now: later(2) })).issued).toBe(0);
      expect(refundPosts()).toHaveLength(1);
      expect((await sweepRefundDue({ now: later(10) })).issued).toBe(1);
      expect(refundPosts().map((c) => c.key)).toEqual([`rf-item-${itemId}`, `rf-item-${itemId}-r2`]);
      expect((await prisma.campaignRefund.findMany({ orderBy: { createdAt: "asc" } })).map((r) => [r.idempotencyKey, r.status])).toEqual([
        [`rf-item-${itemId}`, "failed"],
        [`rf-item-${itemId}-r2`, "processed"],
      ]);
      expect(await prisma.campaignPayment.findUniqueOrThrow({ where: { id: s.payment!.id } })).toMatchObject({ refundedPaise: 100_000, status: "captured" });
      // Done: nothing is sent again.
      await sweepRefundDue({ now: later(60) });
      expect(refundPosts()).toHaveLength(2);
      expect(alertSubjects()).toHaveLength(1);
    });

    it("a refund that timed out and is then REFUSED on the sweep's re-send is not forgotten: it is issued afresh", async () => {
      const s = await approvedWithTwoItems();
      const itemId = s.items[0].id;
      rz.mode = "timeout_before";
      expect((await refundItem(s.booking.id, itemId)).status).toBe(200);
      const row = await prisma.campaignRefund.findFirstOrThrow();
      expect(row.status).toBe("requested");
      // Unanswered for ten minutes, the sweep re-sends it with the same key, and Razorpay now says no (no balance).
      await backdate(row.id, 10);
      rz.mode = "reject400";
      const first = await sweepRefundDue();
      expect(first).toMatchObject({ resumed: 0, errors: 1 });
      expect(alertSubjects()).toEqual(["A campaign refund could not be completed"]);
      expect(await prisma.campaignRefund.findFirstOrThrow()).toMatchObject({ status: "failed", idempotencyKey: `rf-item-${itemId}` });
      // The claim went back, but the item stays refunded: nothing re-opens it, so only the sweep can still return the money.
      expect(await prisma.campaignPayment.findUniqueOrThrow({ where: { id: s.payment!.id } })).toMatchObject({ refundedPaise: 0, status: "captured" });
      expect((await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: itemId } })).status).toBe("refunded");
      const sent = refundPosts().length;
      expect((await sweepRefundDue({ now: later(2) })).issued).toBe(0); // backing off
      expect(refundPosts()).toHaveLength(sent);

      // Razorpay takes it later: the same intent goes out again, under a fresh key.
      rz.mode = "ok";
      expect((await sweepRefundDue({ now: later(10) })).issued).toBe(1);
      expect(refundPosts().at(-1)!.key).toBe(`rf-item-${itemId}-r2`);
      expect((await prisma.campaignRefund.findMany({ orderBy: { createdAt: "asc" } })).map((r) => [r.idempotencyKey, r.status])).toEqual([
        [`rf-item-${itemId}`, "failed"],
        [`rf-item-${itemId}-r2`, "processed"],
      ]);
      expect(await prisma.campaignPayment.findUniqueOrThrow({ where: { id: s.payment!.id } })).toMatchObject({ refundedPaise: 100_000, status: "captured" });
    });

    it("a refusal that re-opened the item is NOT retried by the sweep: staff retry it from the portal", async () => {
      const s = await approvedWithTwoItems();
      rz.mode = "reject400";
      expect((await refundItem(s.booking.id, s.items[0].id)).status).toBe(502);
      expect((await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: s.items[0].id } })).status).toBe("manual_pending");
      rz.mode = "ok";
      expect((await sweepRefundDue({ now: later(60) })).issued).toBe(0);
      expect(refundPosts()).toHaveLength(1);
    });
  });

  // ── The sweep's step for a failed item refund: when it stands down ───────────────

  describe("a failed item refund: when the sweep leaves it alone", () => {
    /** An item that was refunded, whose refund has FAILED (the ledger row is all the sweep has to go on). */
    async function failedItemRefund(o: { booking?: string; items?: string[]; payment?: string; attempts?: number } = {}) {
      const s = await seed({ booking: o.booking ?? "approved", prices: [100_000, 150_000], items: o.items ?? ["refunded", "manual_pending"], payment: { status: o.payment ?? "captured" } });
      const itemId = s.items[0].id;
      const keys = Array.from({ length: o.attempts ?? 1 }, (_, i) => (i === 0 ? `rf-item-${itemId}` : `rf-item-${itemId}-r${i + 1}`));
      for (const k of keys) {
        await prisma.campaignRefund.create({
          data: { idempotencyKey: k, paymentId: s.payment!.id, razorpayPaymentId: s.payment!.razorpayPaymentId!, bookingId: s.booking.id, bookingItemId: itemId, amountPaise: 100_000, status: "failed", origin: "ours", reason: "item_refunded" },
        });
      }
      return { s, itemId };
    }

    it("re-sends it when the item is still refunded and nothing else has happened", async () => {
      const { itemId } = await failedItemRefund();
      expect((await sweepRefundDue({ now: later(10) })).issued).toBe(1);
      expect(refundPosts().map((c) => c.key)).toEqual([`rf-item-${itemId}-r2`]);
    });

    it("does not re-send it when a refund we did not issue appeared after it failed (the dashboard may have paid it), and says so once", async () => {
      const { s } = await failedItemRefund();
      await prisma.campaignRefund.create({
        data: { razorpayRefundId: "rfnd_dashboard", paymentId: s.payment!.id, razorpayPaymentId: s.payment!.razorpayPaymentId!, bookingId: s.booking.id, amountPaise: 100_000, status: "processed", origin: "external", reason: "external" },
      });
      expect((await sweepRefundDue({ now: later(10) })).issued).toBe(0);
      expect((await sweepRefundDue({ now: later(20) })).issued).toBe(0);
      expect(refundPosts()).toHaveLength(0);
      expect(alertSubjects()).toEqual(["A failed campaign item refund was not re-sent"]);
    });

    it("does not re-send it while the payment is owed in full: the whole remainder is refunded under the payment's own key", async () => {
      const { s } = await failedItemRefund({ booking: "rejected", items: ["refunded", "refunded"], payment: "refund_due" });
      rz.mode = "reject400"; // the payment-level refund (step 1) is refused, so the payment stays owed
      await sweepRefundDue({ now: later(10) });
      expect(refundPosts().map((c) => c.key)).toEqual([`rf-stale-${s.payment!.id}`]);
      expect(await prisma.campaignPayment.findUniqueOrThrow({ where: { id: s.payment!.id } })).toMatchObject({ status: "refund_due", refundedPaise: 0 });
    });

    it("does not re-send it for an item that has been re-opened", async () => {
      await failedItemRefund({ items: ["manual_pending", "manual_pending"] });
      expect((await sweepRefundDue({ now: later(10) })).issued).toBe(0);
      expect(refundPosts()).toHaveLength(0);
    });

    it("gives up after five failed attempts and tells staff once to refund it by hand", async () => {
      await failedItemRefund({ attempts: 5 });
      await sweepRefundDue({ now: later(60) });
      await sweepRefundDue({ now: later(120) });
      expect(refundPosts()).toHaveLength(0);
      expect(alertSubjects()).toEqual(["A campaign item refund needs a manual refund"]);
    });

    it("alerts staff when the third attempt is refused too", async () => {
      const { itemId } = await failedItemRefund({ attempts: 2 });
      rz.mode = "reject400";
      const swept = await sweepRefundDue({ now: later(30) });
      expect(swept).toMatchObject({ issued: 0, errors: 1 });
      expect(refundPosts().map((c) => c.key)).toEqual([`rf-item-${itemId}-r3`]);
      expect(alertSubjects()).toEqual(["A campaign refund keeps failing"]);
    });

    // ── It reads Razorpay before it re-sends ─────────────────────────────────────

    /** Set when a ledger row "last failed" (updatedAt is that clock; the ORM would stamp it with the real now). */
    const failedAt = (itemId: string, minutesAgo: number) =>
      prisma.$executeRaw`UPDATE campaign_refunds SET updated_at = ${new Date(Date.now() - minutesAgo * 60_000)} WHERE booking_item_id = ${itemId}`;

    it("reads Razorpay's refund list before re-sending: a dashboard refund that only exists at Razorpay is filed as external, and nothing is re-sent", async () => {
      const { s } = await failedItemRefund();
      const pid = s.payment!.razorpayPaymentId!;
      // Staff refunded the item by hand in the Razorpay dashboard after the failure. NOTHING has filed it on our ledger:
      // no refund event has been handled, and no requested/pending row makes the sweep look at this payment.
      rz.refunds.set(pid, [{ id: "rfnd_dash_only", amount: 100_000, status: "pending", receipt: null, key: null }]);
      expect(await prisma.campaignRefund.count({ where: { origin: "external" } })).toBe(0);

      const swept = await sweepRefundDue({ now: later(10) });
      expect(swept.issued).toBe(0);
      expect(refundPosts()).toHaveLength(0); // the brand is NOT refunded a second time
      expect(await prisma.campaignRefund.findFirstOrThrow({ where: { origin: "external" } })).toMatchObject({ razorpayRefundId: "rfnd_dash_only", status: "pending", amountPaise: 100_000 });
      expect(await prisma.campaignPayment.findUniqueOrThrow({ where: { id: s.payment!.id } })).toMatchObject({ refundedPaise: 100_000 });
      expect(alertSubjects().sort()).toEqual(["A failed campaign item refund was not re-sent", "Refund found on a campaign payment that we did not issue"]);

      // Later ticks: nothing is sent and nobody is told again.
      await sweepRefundDue({ now: later(20) });
      expect(refundPosts()).toHaveLength(0);
      expect(alertSubjects()).toHaveLength(2);
    });

    it("a refund.created event files a dashboard refund at once, so the sweep stands down without even reading Razorpay", async () => {
      const { s } = await failedItemRefund();
      const pid = s.payment!.razorpayPaymentId!;
      rz.refunds.set(pid, [{ id: "rfnd_dash_new", amount: 100_000, status: "pending", receipt: null, key: null }]);
      const res = await webhook("refund.created", { id: "rfnd_dash_new", payment_id: pid }, "refund");
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ handled: true });
      expect(await prisma.campaignRefund.findFirstOrThrow({ where: { origin: "external" } })).toMatchObject({ razorpayRefundId: "rfnd_dash_new", status: "pending" });
      expect(alertSubjects()).toEqual(["Refund found on a campaign payment that we did not issue"]);

      const reads = () => rz.calls.filter((c) => c.method === "GET").length;
      const before = reads();
      await sweepRefundDue({ now: later(10) });
      expect(refundPosts()).toHaveLength(0);
      expect(reads()).toBe(before); // the ledger already shows it: no Razorpay call
      expect(alertSubjects()).toHaveLength(2);
    });

    it("a refund.created event is deferred, not failed, when the list cannot be read (the sweep's marker covers it)", async () => {
      const { s } = await failedItemRefund();
      rz.listFails = true;
      const res = await webhook("refund.created", { id: "rfnd_dash_new", payment_id: s.payment!.razorpayPaymentId }, "refund", "evt-created-1");
      expect(res.status).toBe(200);
      expect(res.body.data.note).toBe("reconcile deferred");
      expect((await prisma.campaignPayment.findUniqueOrThrow({ where: { id: s.payment!.id } })).lastEvent).toBe("refund.reconcile_pending");
      expect((await prisma.razorpayWebhookEvent.findUniqueOrThrow({ where: { eventId: "evt-created-1" } })).processedAt).not.toBeNull();
    });

    it("does not re-send while Razorpay's refund list cannot be read, and tries again on the next tick", async () => {
      const { itemId } = await failedItemRefund();
      rz.listFails = true;
      const first = await sweepRefundDue({ now: later(10) });
      expect(first).toMatchObject({ issued: 0, errors: 1 });
      expect(refundPosts()).toHaveLength(0);
      rz.listFails = false;
      expect((await sweepRefundDue({ now: later(11) })).issued).toBe(1);
      expect(refundPosts().map((c) => c.key)).toEqual([`rf-item-${itemId}-r2`]);
    });

    // ── Parked refunds do not use up the tick ────────────────────────────────────

    it("refunds the sweep gave up on or stood down for do not use up the tick's budget: a live retry still goes out", async () => {
      const givenUp = await failedItemRefund({ attempts: 5 });
      const standDown = await failedItemRefund();
      await prisma.campaignRefund.create({
        data: { razorpayRefundId: "rfnd_dash_parked", paymentId: standDown.s.payment!.id, razorpayPaymentId: standDown.s.payment!.razorpayPaymentId!, bookingId: standDown.s.booking.id, amountPaise: 100_000, status: "processed", origin: "external", reason: "external" },
      });
      const live = await failedItemRefund();
      // One parked row older than the live one and one newer, so no ordering can put the live one first.
      await failedAt(givenUp.itemId, 90);
      await failedAt(live.itemId, 30);
      await failedAt(standDown.itemId, 0);

      // A budget of ONE: before, the first parked row spent it and the live retry was never reached.
      const swept = await sweepRefundDue({ now: later(60), limit: 1 });
      expect(swept.issued).toBe(1);
      expect(refundPosts().map((c) => c.key)).toEqual([`rf-item-${live.itemId}-r2`]);
      expect(alertSubjects().filter((x) => x === "A failed campaign item refund was not re-sent")).toHaveLength(1);
      // The tick ended once its one Razorpay read was spent; the other parked row is dealt with on the next one, and each is told once.
      await sweepRefundDue({ now: later(61), limit: 1 });
      await sweepRefundDue({ now: later(62), limit: 1 });
      expect(refundPosts()).toHaveLength(1);
      expect(alertSubjects().filter((x) => x === "A campaign item refund needs a manual refund")).toHaveLength(1);
      expect(alertSubjects().filter((x) => x === "A failed campaign item refund was not re-sent")).toHaveLength(1);
    });

    it("looks at the newest failures first: 200 parked refunds cannot crowd a live retry out of the candidates", async () => {
      const s = await seed({ booking: "approved", prices: [100_000], items: ["refunded"], payment: { status: "captured" } });
      const live = s.items[0];
      await prisma.campaignBookingItem.createMany({
        data: Array.from({ length: 201 }, (_, i) => ({ bookingId: s.booking.id, rateCardId: `rc-parked-${i}`, targetType: "meta_asset", targetId: `tp-${i}`, platform: "instagram", format: "post", accountName: `Parked ${i}`, pricePaise: 1_000, status: "manual_pending" })),
      });
      const parked = await prisma.campaignBookingItem.findMany({ where: { bookingId: s.booking.id, status: "manual_pending" }, select: { id: true } });
      const row = (itemId: string, amountPaise: number, updatedAt: Date) => ({
        idempotencyKey: `rf-item-${itemId}`, paymentId: s.payment!.id, razorpayPaymentId: s.payment!.razorpayPaymentId!, bookingId: s.booking.id, bookingItemId: itemId, amountPaise, status: "failed", origin: "ours", reason: "item_refunded", updatedAt,
      });
      // 201 re-opened items (the sweep stands down for each) that failed long ago, and one live item that failed 30 minutes ago.
      await prisma.campaignRefund.createMany({ data: [...parked.map((i) => row(i.id, 1_000, new Date(Date.now() - 600 * 60_000))), row(live.id, 100_000, new Date(Date.now() - 30 * 60_000))] });

      expect((await sweepRefundDue({ now: new Date(), limit: 1 })).issued).toBe(1);
      expect(refundPosts().map((c) => c.key)).toEqual([`rf-item-${live.id}-r2`]);
    });

    // ── A sibling refund that stays pending ──────────────────────────────────────

    it("reconciling a payment does not push back the retry of a refund that already failed", async () => {
      const s = await seed({ booking: "approved", prices: [100_000, 150_000], items: ["refunded", "refunded"], payment: { status: "refund_pending", refunded: 150_000 } });
      const pid = s.payment!.razorpayPaymentId!;
      const [i0, i1] = s.items;
      const base = { paymentId: s.payment!.id, razorpayPaymentId: pid, bookingId: s.booking.id, origin: "ours", reason: "item_refunded" };
      // i1's refund is still pending at Razorpay and has never been checked: the sweep reconciles this payment on every pass.
      await prisma.campaignRefund.create({ data: { ...base, idempotencyKey: `rf-item-${i1.id}`, bookingItemId: i1.id, amountPaise: 150_000, status: "pending", razorpayRefundId: "rfnd_sibling" } });
      // i0's refund was accepted by Razorpay and then failed, twice: rows that carry a Razorpay id, which a reconcile used to re-stamp.
      await prisma.campaignRefund.create({ data: { ...base, idempotencyKey: `rf-item-${i0.id}`, bookingItemId: i0.id, amountPaise: 100_000, status: "failed", razorpayRefundId: "rfnd_f1" } });
      await prisma.campaignRefund.create({ data: { ...base, idempotencyKey: `rf-item-${i0.id}-r2`, bookingItemId: i0.id, amountPaise: 100_000, status: "failed", razorpayRefundId: "rfnd_f2" } });
      rz.refunds.set(pid, [
        { id: "rfnd_sibling", amount: 150_000, status: "pending", receipt: null, key: null },
        { id: "rfnd_f1", amount: 100_000, status: "failed", receipt: null, key: null },
        { id: "rfnd_f2", amount: 100_000, status: "failed", receipt: null, key: null },
      ]);
      await failedAt(i0.id, 30); // long past the 10 minute backoff for a second failure

      const swept = await sweepRefundDue({ now: new Date() });
      expect(swept.reconciled).toBe(1); // the pending sibling made the sweep reconcile the payment first
      expect(swept.issued).toBe(1);
      expect(refundPosts().map((c) => c.key)).toEqual([`rf-item-${i0.id}-r3`]);
      // And a reconcile left the failed rows' clock alone.
      const failedRows = await prisma.campaignRefund.findMany({ where: { bookingItemId: i0.id, status: "failed" } });
      expect(failedRows).toHaveLength(2);
      for (const r of failedRows) expect(r.updatedAt.getTime()).toBeLessThan(Date.now() - 20 * 60_000);
    });
  });

  // ── External refunds ────────────────────────────────────────────────────────────

  describe("a refund we did not make", () => {
    it("is filed as external, pauses every creator payout on the payment, and alerts staff", async () => {
      const s = await seed({ booking: "paid_pending_review", prices: [250_000], payment: { status: "captured" } });
      const payout = await prisma.creatorPayout.create({
        data: {
          bookingId: s.booking.id,
          bookingItemId: s.items[0].id,
          creatorId: "creator-1",
          payoutAccountId: "acct-row-1",
          razorpayAccountId: "acc_test",
          razorpayPaymentId: s.payment!.razorpayPaymentId!,
          itemPricePaise: 250_000,
          shareBps: 7000,
          grossPaise: 175_000,
          amountPaise: 175_000,
        },
      });
      rz.refunds.set(s.payment!.razorpayPaymentId!, [{ id: "rfnd_dash", amount: 40_000, status: "processed", receipt: null, key: null }]);

      const res = await webhook("refund.processed", { id: "rfnd_dash", payment_id: s.payment!.razorpayPaymentId, amount: 40_000 }, "refund");
      expect(res.status).toBe(200);

      expect(await prisma.campaignRefund.findFirstOrThrow()).toMatchObject({ razorpayRefundId: "rfnd_dash", origin: "external", status: "processed", amountPaise: 40_000, idempotencyKey: null });
      expect(await prisma.campaignPayment.findUniqueOrThrow({ where: { id: s.payment!.id } })).toMatchObject({ refundedPaise: 40_000, status: "captured" });
      const paused = await prisma.creatorPayout.findUniqueOrThrow({ where: { id: payout.id } });
      expect(paused.pausedAt).not.toBeNull();
      expect(paused.pausedReason).toBe("external_refund");
      expect(await prisma.creatorPayoutEvent.count({ where: { payoutId: payout.id, kind: "pause" } })).toBe(1);
      expect((await bookingEvents(s.booking.id)).some((e) => (e.note ?? "").includes("did not issue"))).toBe(true);
      expect(vi.mocked(notifyAdminByEmail)).toHaveBeenCalledTimes(1);
      expect(String(vi.mocked(notifyAdminByEmail).mock.calls[0][0])).toContain("did not issue");

      // The same refund again (another event, or the sweep): known now, so no second alert and no second row.
      await webhook("refund.processed", { id: "rfnd_dash", payment_id: s.payment!.razorpayPaymentId }, "refund");
      expect(await prisma.campaignRefund.count()).toBe(1);
      expect(vi.mocked(notifyAdminByEmail)).toHaveBeenCalledTimes(1);
    });

    it("pauses only the payouts with something in flight, and never rewrites why one was already paused", async () => {
      const s = await seed({ booking: "paid_pending_review", prices: [100_000, 100_000, 100_000, 100_000, 100_000], payment: { status: "captured" } });
      const payoutOn = (i: number, extra: Record<string, unknown>) =>
        prisma.creatorPayout.create({
          data: {
            bookingId: s.booking.id,
            bookingItemId: s.items[i].id,
            creatorId: `creator-${i}`,
            payoutAccountId: `acct-row-${i}`,
            razorpayAccountId: "acc_test",
            razorpayPaymentId: s.payment!.razorpayPaymentId!,
            itemPricePaise: 100_000,
            shareBps: 7000,
            grossPaise: 70_000,
            amountPaise: 70_000,
            ...extra,
          },
        });
      const earlier = new Date(Date.now() - 3 * 3600_000);
      const settled = await payoutOn(0, { status: "settled", settledAt: earlier });
      const voided = await payoutOn(1, { status: "void", voidReason: "declined" });
      const disputed = await payoutOn(2, { status: "held", pausedAt: earlier, pausedReason: "dispute" });
      const bankChange = await payoutOn(3, { status: "planned", pausedAt: earlier, pausedReason: "bank_change" });
      const inFlight = await payoutOn(4, { status: "held" });
      rz.refunds.set(s.payment!.razorpayPaymentId!, [{ id: "rfnd_dash", amount: 40_000, status: "processed", receipt: null, key: null }]);

      const res = await webhook("refund.processed", { id: "rfnd_dash", payment_id: s.payment!.razorpayPaymentId, amount: 40_000 }, "refund");
      expect(res.status).toBe(200);

      const row = (id: string) => prisma.creatorPayout.findUniqueOrThrow({ where: { id } });
      const pauses = (id: string) => prisma.creatorPayoutEvent.count({ where: { payoutId: id, kind: "pause" } });
      // Nothing in flight: left alone, so a paid creator is never shown "payout paused".
      for (const done of [settled, voided]) {
        expect(await row(done.id)).toMatchObject({ pausedAt: null, pausedReason: null });
        expect(await pauses(done.id)).toBe(0);
      }
      // Already paused: the first reason and its time stand, and no second "paused" entry is written.
      expect(await row(disputed.id)).toMatchObject({ pausedAt: earlier, pausedReason: "dispute" });
      expect(await row(bankChange.id)).toMatchObject({ pausedAt: earlier, pausedReason: "bank_change" });
      expect(await pauses(disputed.id)).toBe(0);
      expect(await pauses(bankChange.id)).toBe(0);
      // Something in flight and not paused yet: paused, with exactly one entry saying what it was.
      const paused = await row(inFlight.id);
      expect(paused.pausedAt).not.toBeNull();
      expect(paused.pausedReason).toBe("external_refund");
      const events = await prisma.creatorPayoutEvent.findMany({ where: { payoutId: inFlight.id, kind: "pause" } });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ fromStatus: "held", toStatus: "held", amountPaise: 70_000, actorType: "system" });
      // The booking history counts what was actually paused.
      expect((await bookingEvents(s.booking.id)).some((e) => (e.note ?? "").includes("1 creator payout(s) paused"))).toBe(true);
    });

    it("a payment whose payouts are all settled is not paused at all, and the booking history does not claim it", async () => {
      const s = await seed({ booking: "paid_pending_review", prices: [100_000], payment: { status: "captured" } });
      const payout = await prisma.creatorPayout.create({
        data: { bookingId: s.booking.id, bookingItemId: s.items[0].id, creatorId: "c", payoutAccountId: "a", razorpayAccountId: "acc_test", razorpayPaymentId: s.payment!.razorpayPaymentId!, itemPricePaise: 100_000, shareBps: 7000, grossPaise: 70_000, amountPaise: 70_000, status: "settled", settledAt: new Date() },
      });
      rz.refunds.set(s.payment!.razorpayPaymentId!, [{ id: "rfnd_dash2", amount: 10_000, status: "processed", receipt: null, key: null }]);
      await webhook("refund.processed", { id: "rfnd_dash2", payment_id: s.payment!.razorpayPaymentId }, "refund");
      expect(await prisma.creatorPayout.findUniqueOrThrow({ where: { id: payout.id } })).toMatchObject({ pausedAt: null, pausedReason: null });
      expect(await prisma.creatorPayoutEvent.count()).toBe(0);
      const note = (await bookingEvents(s.booking.id)).map((e) => e.note ?? "").find((n) => n.includes("did not issue"));
      expect(note).toBeTruthy();
      expect(note).not.toContain("paused");
    });

    it("is a safe no-op for a payment that has no creator payouts, and escapes provider text in the alert", async () => {
      const s = await seed({ booking: "paid_pending_review", prices: [100_000], payment: { status: "captured" } });
      rz.refunds.set(s.payment!.razorpayPaymentId!, [{ id: "rfnd_<b>", amount: 100_000, status: "processed", receipt: null, key: null }]);
      const res = await webhook("refund.processed", { id: "rfnd_<b>", payment_id: s.payment!.razorpayPaymentId }, "refund");
      expect(res.status).toBe(200);
      expect(await prisma.campaignPayment.findUniqueOrThrow({ where: { id: s.payment!.id } })).toMatchObject({ status: "refunded", refundedPaise: 100_000 });
      const details = vi.mocked(notifyAdminByEmail).mock.calls[0][1] as Array<{ label: string; value: string }>;
      expect(details.find((d) => d.label === "Refund")?.value).toBe("rfnd_&lt;b&gt;");
    });
  });

  // ── Lock order and contention ───────────────────────────────────────────────────

  describe("refund bookkeeping under contention", () => {
    const lost = () => Object.assign(new Error("Transaction failed due to a write conflict or a deadlock. Please retry your transaction"), { code: "P2034" });

    it("recognises a lost deadlock or write conflict, and nothing else", () => {
      expect(isContention(lost())).toBe(true);
      expect(isContention(Object.assign(new Error("raw query failed"), { code: "P2010", meta: { code: "40P01" } }))).toBe(true);
      expect(isContention(Object.assign(new Error("could not serialize access"), { code: "P2010", meta: { code: "40001" } }))).toBe(true);
      expect(isContention(new Error("deadlock detected"))).toBe(true);
      expect(isContention(Object.assign(new Error("Unique constraint failed"), { code: "P2002" }))).toBe(false);
      expect(isContention(Object.assign(new Error("Timed out fetching a new connection"), { code: "P2024" }))).toBe(false);
      expect(isContention(undefined)).toBe(false);
    });

    it("retryOnContention runs the work again once, and only for contention", async () => {
      let n = 0;
      expect(await retryOnContention(async () => (++n === 1 ? Promise.reject(lost()) : "done"))).toBe("done");
      expect(n).toBe(2);

      n = 0;
      await expect(retryOnContention(async () => { n++; throw lost(); })).rejects.toMatchObject({ code: "P2034" });
      expect(n).toBe(2);

      n = 0;
      await expect(retryOnContention(async () => { n++; throw new Error("boom"); })).rejects.toThrow("boom");
      expect(n).toBe(1);
    });

    /** Records, per transaction, the order of the statements that matter for locking. */
    function recordTransactions() {
      const real = prisma.$transaction.bind(prisma) as (...args: unknown[]) => Promise<unknown>;
      const logs: string[][] = [];
      const wrap = (tx: any, log: string[]) =>
        new Proxy(tx, {
          get(target, prop) {
            const value = target[prop];
            if (prop === "$queryRaw") {
              return (strings: TemplateStringsArray, ...values: unknown[]) => {
                log.push(`raw ${strings.join("?").replace(/\s+/g, " ").trim()}`);
                return target.$queryRaw(strings, ...values);
              };
            }
            if (prop === "campaignRefund" || prop === "campaignPayment") {
              return new Proxy(value, {
                get(model, method) {
                  const fn = model[method];
                  return typeof fn === "function" ? (...args: unknown[]) => { log.push(`${String(prop)}.${String(method)}`); return model[method](...args); } : fn;
                },
              });
            }
            return value;
          },
        });
      vi.spyOn(prisma, "$transaction").mockImplementation(((fn: unknown, opts?: unknown) => {
        if (typeof fn !== "function") return real(fn, opts);
        const log: string[] = [];
        logs.push(log);
        return real((tx: unknown) => (fn as (t: unknown) => unknown)(wrap(tx, log)), opts);
      }) as typeof prisma.$transaction);
      return logs;
    }
    const PAYMENT_LOCK = "raw SELECT id FROM campaign_payments WHERE id = ? FOR UPDATE";

    it("releasing a refused claim, recording a refund and reconciling all lock the payment row before any refund row", async () => {
      const s = await seed({ booking: "approved", prices: [100_000, 150_000], items: ["manual_pending", "manual_pending"], payment: { status: "captured" } });
      const logs = recordTransactions();
      const key = (i: number) => ({ key: `rf-item-${s.items[i].id}`, reason: "item_refunded", itemId: s.items[i].id });

      // Refused: claim, then release.
      rz.mode = "reject400";
      await expect(refundPaymentRow(s.payment!.id, 100_000, "x", { type: "system" }, key(0))).rejects.toMatchObject({ code: "REFUND_FAILED" });
      const release = logs.find((l) => l.includes("campaignRefund.updateMany"))!;
      expect(release[0]).toBe(PAYMENT_LOCK);

      // Accepted: claim, then record.
      rz.mode = "ok";
      await refundPaymentRow(s.payment!.id, 150_000, "x", { type: "system" }, key(1));
      const record = logs.find((l) => l.includes("campaignRefund.findUnique") && l.includes("campaignRefund.update"))!;
      expect(record[0]).toBe(PAYMENT_LOCK);

      // Reconcile.
      logs.length = 0;
      await reconcileRefunds(s.payment!.id);
      expect(logs[0][0]).toBe(PAYMENT_LOCK);
    });

    it("a release that loses a deadlock runs again, and the caller still gets the refusal", async () => {
      const s = await seed({ booking: "approved", prices: [100_000], items: ["manual_pending"], payment: { status: "captured" } });
      rz.mode = "reject400";
      const real = prisma.$transaction.bind(prisma) as (...args: unknown[]) => Promise<unknown>;
      let n = 0;
      // Transaction 1 is the claim, 2 the release (lost), 3 the release again.
      vi.spyOn(prisma, "$transaction").mockImplementation(((...args: unknown[]) => (++n === 2 ? Promise.reject(lost()) : real(...args))) as typeof prisma.$transaction);

      await expect(refundPaymentRow(s.payment!.id, 100_000, "x", { type: "system" }, { key: `rf-item-${s.items[0].id}`, reason: "item_refunded", itemId: s.items[0].id })).rejects.toMatchObject({ statusCode: 502, code: "REFUND_FAILED" });
      expect(n).toBe(3);
      expect(await prisma.campaignRefund.findFirstOrThrow()).toMatchObject({ status: "failed" });
      expect(await prisma.campaignPayment.findUniqueOrThrow({ where: { id: s.payment!.id } })).toMatchObject({ refundedPaise: 0, status: "captured" });
    });

    it("a reconcile that loses a deadlock runs again, once", async () => {
      const s = await seed({ booking: "approved", prices: [100_000, 150_000], items: ["manual_pending", "manual_pending"], payment: { status: "captured" } });
      rz.refunds.set(s.payment!.razorpayPaymentId!, [{ id: "rfnd_c", amount: 40_000, status: "processed", receipt: null, key: null }]);
      const real = prisma.$transaction.bind(prisma) as (...args: unknown[]) => Promise<unknown>;
      let n = 0;
      const spy = vi.spyOn(prisma, "$transaction").mockImplementation(((...args: unknown[]) => (++n === 1 ? Promise.reject(lost()) : real(...args))) as typeof prisma.$transaction);
      expect(await reconcileRefunds(s.payment!.id)).toEqual({ refundedPaise: 40_000, external: 1 });
      expect(n).toBe(2);
      expect(await prisma.campaignRefund.count()).toBe(1);

      // Lost both times: the error is not swallowed, and it is not retried a second time.
      n = 0;
      spy.mockImplementation((() => { n++; return Promise.reject(lost()); }) as typeof prisma.$transaction);
      await expect(reconcileRefunds(s.payment!.id)).rejects.toMatchObject({ code: "P2034" });
      expect(n).toBe(2);
    });

    it("a refusal whose release keeps failing still answers with the refusal, never a raw database error; the sweep settles it", async () => {
      const s = await seed({ booking: "approved", prices: [100_000, 150_000], items: ["manual_pending", "manual_pending"], payment: { status: "captured" } });
      const itemId = s.items[0].id;
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      rz.mode = "reject400";
      const real = prisma.$transaction.bind(prisma) as (...args: unknown[]) => Promise<unknown>;
      let n = 0;
      // The claim works; every attempt to release it loses.
      const spy = vi.spyOn(prisma, "$transaction").mockImplementation(((...args: unknown[]) => (++n >= 2 ? Promise.reject(lost()) : real(...args))) as typeof prisma.$transaction);

      const res = await post(`/v1/admin/campaigns/${s.booking.id}/items/${itemId}/refund`);
      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe("REFUND_FAILED");
      expect(n).toBe(3); // the claim, the release, and ONE more try
      expect(consoleSpy.mock.calls.flat().join(" ")).toContain("could not be released");
      spy.mockRestore();
      // The claim is still held, so the item stays refunded: re-opening it would let staff post it while that refund can still go through.
      expect(await prisma.campaignRefund.findFirstOrThrow()).toMatchObject({ status: "requested" });
      expect((await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: itemId } })).status).toBe("refunded");

      // The sweep re-sends it under the same key; refused again, it is released, and then issued afresh.
      await backdate((await prisma.campaignRefund.findFirstOrThrow()).id, 10);
      expect(await sweepRefundDue()).toMatchObject({ resumed: 0, errors: 1 });
      expect(await prisma.campaignRefund.findFirstOrThrow()).toMatchObject({ status: "failed" });
      rz.mode = "ok";
      expect((await sweepRefundDue({ now: later(10) })).issued).toBe(1);
      expect(await prisma.campaignPayment.findUniqueOrThrow({ where: { id: s.payment!.id } })).toMatchObject({ refundedPaise: 100_000, status: "captured" });
    });
  });

  // ── Reject ──────────────────────────────────────────────────────────────────────

  describe("reject", () => {
    const reject = (id: string) => post(`/v1/admin/campaigns/${id}/reject`, { note: "Brand not permitted on our network" });

    it("is refused (409) when a post is already live on an online-paid booking, and changes nothing", async () => {
      const s = await seed({ booking: "approved", prices: [100_000, 150_000], items: ["posted_manual", "manual_pending"], payment: { status: "captured" } });
      const res = await reject(s.booking.id);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("POSTS_LIVE");
      expect((await prisma.campaignBooking.findUniqueOrThrow({ where: { id: s.booking.id } })).status).toBe("approved");
      expect((await prisma.campaignBookingItem.findMany({ where: { bookingId: s.booking.id }, orderBy: { pricePaise: "asc" } })).map((i) => i.status)).toEqual(["posted_manual", "manual_pending"]);
      expect((await prisma.campaignPayment.findUniqueOrThrow({ where: { id: s.payment!.id } })).status).toBe("captured");
      expect(rz.calls).toHaveLength(0);
    });

    it("refunds each not-posted item at its own price, under its own key, and stops there", async () => {
      // One item was refunded earlier (50 000 already gone); two are still to be refused.
      const s = await seed({ booking: "paid_pending_review", prices: [50_000, 100_000, 150_000], items: ["refunded", "pending", "failed"], payment: { status: "captured", refunded: 50_000 } });
      const res = await reject(s.booking.id);
      expect(res.status).toBe(200);
      expect(res.body.data.refundError).toBeNull();

      const posts = refundPosts();
      expect(posts.map((c) => c.body.amount).sort((a, b) => a - b)).toEqual([100_000, 150_000]);
      expect(posts.map((c) => c.key).sort()).toEqual([`rf-item-${s.items[1].id}`, `rf-item-${s.items[2].id}`].sort());
      expect(await prisma.campaignPayment.findUniqueOrThrow({ where: { id: s.payment!.id } })).toMatchObject({ refundedPaise: 300_000, status: "refunded" });
      expect((await prisma.campaignBookingItem.findMany({ where: { bookingId: s.booking.id } })).every((i) => i.status === "refunded")).toBe(true);
      expect((await prisma.campaignRefund.findMany()).every((r) => r.reason === "booking_rejected" && r.status === "processed")).toBe(true);
      expect((await prisma.campaignBooking.findUniqueOrThrow({ where: { id: s.booking.id } })).status).toBe("refunded");
      // A second reject is refused and refunds nothing more.
      expect((await reject(s.booking.id)).status).toBe(409);
      expect(refundPosts()).toHaveLength(2);
    });

    it("an account being published right now stops the whole rejection (nothing is half-done)", async () => {
      const s = await seed({ booking: "approved", prices: [100_000, 150_000], items: ["manual_pending", "queued"], payment: { status: "captured" } });
      await prisma.campaignBookingItem.update({ where: { id: s.items[1].id }, data: { lockedUntil: new Date(Date.now() + 5 * 60_000) } });
      const res = await reject(s.booking.id);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("BUSY");
      expect((await prisma.campaignBooking.findUniqueOrThrow({ where: { id: s.booking.id } })).status).toBe("approved");
      expect((await prisma.campaignBookingItem.findMany({ where: { bookingId: s.booking.id }, orderBy: { pricePaise: "asc" } })).map((i) => i.status)).toEqual(["manual_pending", "queued"]);
      expect((await prisma.campaignPayment.findUniqueOrThrow({ where: { id: s.payment!.id } })).status).toBe("captured");
      expect(rz.calls).toHaveLength(0);
    });

    it("when Razorpay refuses, the booking is still rejected and the money is marked owed; the sweep finishes it", async () => {
      const s = await seed({ booking: "paid_pending_review", prices: [100_000, 150_000], payment: { status: "captured" } });
      rz.mode = "reject400";
      const res = await reject(s.booking.id);
      expect(res.status).toBe(200);
      expect(res.body.data.refundError).toContain("retry automatically");
      expect(res.body.data.refundError.toLowerCase()).not.toContain("dashboard");
      expect(res.body.data.status).toBe("rejected");
      expect(await prisma.campaignPayment.findUniqueOrThrow({ where: { id: s.payment!.id } })).toMatchObject({ status: "refund_due", refundedPaise: 0 });

      rz.mode = "ok";
      const swept = await sweepRefundDue({ now: later(10) });
      expect(swept.issued).toBe(1);
      expect(refundPosts().at(-1)).toMatchObject({ key: `rf-stale-${s.payment!.id}`, body: expect.objectContaining({ amount: 250_000 }) });
      expect((await prisma.campaignPayment.findUniqueOrThrow({ where: { id: s.payment!.id } })).status).toBe("refunded");
      expect((await prisma.campaignBooking.findUniqueOrThrow({ where: { id: s.booking.id } })).status).toBe("refunded");
    });

    it("when Razorpay doesn't answer, the booking says the refund is being confirmed, not that it failed", async () => {
      const s = await seed({ booking: "paid_pending_review", prices: [250_000], payment: { status: "captured" } });
      rz.mode = "http500";
      const res = await reject(s.booking.id);
      expect(res.status).toBe(200);
      expect(res.body.data.refundError).toBeNull();
      expect(res.body.data.refundNotice).toContain("hasn't confirmed");
      expect((await prisma.campaignBooking.findUniqueOrThrow({ where: { id: s.booking.id } })).status).toBe("rejected");
    });

    describe("with the refund sweep switched off (CAMPAIGN_REFUND_SWEEP_ENABLED=0)", () => {
      let saved: string | undefined;
      beforeEach(() => {
        saved = process.env.CAMPAIGN_REFUND_SWEEP_ENABLED;
        process.env.CAMPAIGN_REFUND_SWEEP_ENABLED = "0";
      });
      afterEach(() => {
        if (saved === undefined) delete process.env.CAMPAIGN_REFUND_SWEEP_ENABLED;
        else process.env.CAMPAIGN_REFUND_SWEEP_ENABLED = saved;
      });

      it("an unanswered refund does not tell staff 'we're checking automatically': nothing is", async () => {
        const s = await seed({ booking: "paid_pending_review", prices: [250_000], payment: { status: "captured" } });
        rz.mode = "http500";
        const res = await reject(s.booking.id);
        expect(res.status).toBe(200);
        expect(res.body.data.refundNotice).toContain("hasn't confirmed");
        expect(res.body.data.refundNotice).toContain("switched off");
        expect(res.body.data.refundNotice).not.toContain("checking automatically");
        expect(res.body.data.refundNotice).not.toContain("nothing needs doing");
        expect(res.body.data.refundNotice).toContain("can't be refunded twice");
      });

      it("a refused rejection refund is not promised an automatic retry", async () => {
        const s = await seed({ booking: "paid_pending_review", prices: [100_000, 150_000], payment: { status: "captured" } });
        rz.mode = "reject400";
        const res = await reject(s.booking.id);
        expect(res.status).toBe(200);
        expect(res.body.data.refundError).not.toContain("retry automatically");
        expect(res.body.data.refundError).toContain("will not be retried");
        expect(res.body.data.status).toBe("rejected");
      });
    });

    it("an offline booking (no online payment) is unchanged: nothing refunded, stays rejected", async () => {
      const s = await seed({ booking: "paid_pending_review", prices: [100_000, 150_000], items: ["pending", "manual_pending"], payment: null });
      const res = await reject(s.booking.id);
      expect(res.status).toBe(200);
      expect(res.body.data.refundError).toBeNull();
      expect(res.body.data.status).toBe("rejected");
      expect((await prisma.campaignBookingItem.findMany({ where: { bookingId: s.booking.id } })).every((i) => i.status === "refunded")).toBe(true);
      expect(rz.calls).toHaveLength(0);
      expect(await prisma.campaignRefund.count()).toBe(0);
    });
  });

  // ── The delivery email ──────────────────────────────────────────────────────────

  describe("the delivery email's refund wording follows the ledger", () => {
    /** A delivered booking: one post live, one account refunded; `refund` is that item's ledger row, if any. */
    async function deliveryEmail(refund: { status: string } | null, payment: { status: string } | null = { status: "captured" }) {
      const s = await seed({ booking: "partially_published", prices: [100_000, 150_000], items: ["posted_manual", "refunded"], payment });
      if (refund && s.payment) {
        await prisma.campaignRefund.create({
          data: { idempotencyKey: `rf-item-${s.items[1].id}`, paymentId: s.payment.id, razorpayPaymentId: s.payment.razorpayPaymentId!, bookingId: s.booking.id, bookingItemId: s.items[1].id, amountPaise: 150_000, status: refund.status, origin: "ours", reason: "item_refunded" },
        });
      }
      vi.mocked(sendEmail).mockClear();
      expect(await sendDeliveryEmail(s.booking.id, { force: true })).toBe(true);
      const mail = vi.mocked(sendEmail).mock.calls.find(([o]) => o.to === "a@brand.test");
      return String(mail![0].html);
    }

    it.each(["processed", "pending"])("says the amount has been refunded once Razorpay has the refund (%s)", async (status) => {
      const html = await deliveryEmail({ status });
      expect(html).toContain("The amount for those has been refunded to your original payment method.");
      expect(html).toContain("Not posted — refunded");
    });

    it.each([["failed"], ["requested"], [null]])("does not say it was refunded when the refund is %s: our team is returning it", async (status) => {
      const html = await deliveryEmail(status ? { status } : null);
      expect(html).toContain("Our team is returning the amount for those to you.");
      expect(html).toContain("Not posted — being returned");
      expect(html).not.toContain("refunded to your original payment method");
      expect(html).not.toContain("Not posted — refunded");
    });

    it("keeps the offline wording exactly: nothing was charged, so nothing was refunded", async () => {
      const html = await deliveryEmail(null, null);
      expect(html).toContain("They will not be charged — our team will confirm the final amount with you.");
      expect(html).toContain("Not posted — not charged");
      expect(html).not.toContain("refunded");
      expect(html).not.toContain("being returned");
    });

    // A post marked `failed` was never refunded, whatever happened to its neighbour.
    /** One live post plus the given others, on an online-paid booking; `ledger` is the refund row (by index into `others`) of a refunded one. */
    async function mixedDelivery(others: string[], ledger: Record<number, string> = {}) {
      const s = await seed({ booking: "partially_published", prices: [100_000, ...others.map(() => 100_000)], items: ["posted_manual", ...others], payment: { status: "captured" } });
      for (const [i, status] of Object.entries(ledger)) {
        const item = s.items[Number(i) + 1];
        await prisma.campaignRefund.create({
          data: { idempotencyKey: `rf-item-${item.id}`, paymentId: s.payment!.id, razorpayPaymentId: s.payment!.razorpayPaymentId!, bookingId: s.booking.id, bookingItemId: item.id, amountPaise: 100_000, status, origin: "ours", reason: "item_refunded" },
        });
      }
      vi.mocked(sendEmail).mockClear();
      expect(await sendDeliveryEmail(s.booking.id, { force: true })).toBe(true);
      return String(vi.mocked(sendEmail).mock.calls.find(([o]) => o.to === "a@brand.test")![0].html);
    }

    it("does not say the amount was refunded for a post that was only marked failed", async () => {
      const html = await mixedDelivery(["failed", "refunded"], { 1: "processed" });
      expect(html).toContain("2 posts could not be made.");
      expect(html).not.toContain("The amount for those has been refunded");
      expect(html).toContain("The amount for 1 of them has been refunded to your original payment method.");
      expect(html).toContain("Our team will contact you about 1 of them.");
      // The failed post's own row still says only "Not posted", and the refunded one says refunded.
      expect(html).toMatch(/<td[^>]*>Not posted<\/td>/);
      expect(html).toContain("Not posted — refunded");
    });

    it("splits refunded posts whose refund Razorpay has from those still being returned, and failed ones from both", async () => {
      const html = await mixedDelivery(["refunded", "refunded", "failed"], { 0: "processed", 1: "failed" });
      expect(html).toContain("3 posts could not be made.");
      expect(html).toContain("The amount for 1 of them has been refunded to your original payment method.");
      expect(html).toContain("Our team is returning the amount for 1 of them.");
      expect(html).toContain("Our team will contact you about 1 of them.");
      expect(html).not.toContain("for those");
    });

    it("keeps the plain wording when every post that did not go live is in one group", async () => {
      expect(await mixedDelivery(["refunded", "refunded"], { 0: "processed", 1: "pending" })).toContain("The amount for those has been refunded to your original payment method.");
      expect(await mixedDelivery(["refunded", "refunded"], { 0: "requested" })).toContain("Our team is returning the amount for those to you.");
      expect(await mixedDelivery(["failed", "failed"])).toContain("Our team will contact you about them.");
    });
  });

  // ── What the client portal is told ──────────────────────────────────────────────

  describe("the client's view says an item was refunded only when the ledger does", () => {
    it("carries refundConfirmed on the booking and on the results, from the same ledger rule as the email", async () => {
      const s = await seed({ booking: "partially_published", prices: [100_000, 100_000, 100_000, 100_000, 100_000, 100_000], items: ["posted_manual", "refunded", "refunded", "refunded", "refunded", "failed"], payment: { status: "captured" } });
      const ledger = async (i: number, status: string, origin = "ours") =>
        prisma.campaignRefund.create({
          data: { idempotencyKey: origin === "ours" ? `rf-item-${s.items[i].id}` : null, razorpayRefundId: origin === "ours" ? null : `rfnd_ext_${i}`, paymentId: s.payment!.id, razorpayPaymentId: s.payment!.razorpayPaymentId!, bookingId: s.booking.id, bookingItemId: s.items[i].id, amountPaise: 100_000, status, origin, reason: origin === "ours" ? "item_refunded" : "external" },
        });
      await ledger(1, "processed");
      await ledger(2, "pending");
      await ledger(3, "failed"); // accepted and then failed: still being returned
      // items[4]: refunded with no ledger row at all (the refund is still being sent); items[5]: failed, never refunded.
      const want = Object.fromEntries(s.items.map((it, i) => [it.id, [false, true, true, false, false, false][i]]));
      const byId = (items: Array<{ id: string; refundConfirmed?: boolean }>) => Object.fromEntries(items.map((i) => [i.id, i.refundConfirmed]));

      expect(byId((await bookingSvc.getClientBooking(clientId, s.booking.id)).items as any)).toEqual(want);
      expect(byId((await getResults(clientId, s.booking.id))!.items)).toEqual(want);
    });

    it("a refund we did not issue never makes an item read refunded", async () => {
      const s = await seed({ booking: "partially_published", prices: [100_000, 100_000], items: ["posted_manual", "refunded"], payment: { status: "captured" } });
      await prisma.campaignRefund.create({
        data: { razorpayRefundId: "rfnd_dash", paymentId: s.payment!.id, razorpayPaymentId: s.payment!.razorpayPaymentId!, bookingId: s.booking.id, bookingItemId: s.items[1].id, amountPaise: 100_000, status: "processed", origin: "external", reason: "external" },
      });
      expect((await bookingSvc.getClientBooking(clientId, s.booking.id)).items.map((i: any) => i.refundConfirmed)).toEqual([false, false]);
    });

    it("an offline booking has no ledger rows, so nothing is confirmed (the portal says 'not charged' there)", async () => {
      const s = await seed({ booking: "partially_published", prices: [100_000, 100_000], items: ["posted_manual", "refunded"], payment: null });
      expect((await bookingSvc.getClientBooking(clientId, s.booking.id)).items.map((i: any) => i.refundConfirmed)).toEqual([false, false]);
    });
  });

  // ── Webhook endpoint ────────────────────────────────────────────────────────────

  describe("route events on the shared webhook", () => {
    it("answer 2xx whatever the Route handler does, unless it asks for a retry (below)", async () => {
      vi.mocked(handleRouteEvent).mockRejectedValueOnce(new Error("handler blew up"));
      const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const bad = await webhook("transfer.processed", { id: "trf_1" }, "payment", "evt-route-1");
      expect(bad.status).toBe(200);
      expect(bad.body.data).toEqual({ handled: false, note: "route handler error" });
      // The event is stamped processed, and only its NAME was logged.
      expect((await prisma.razorpayWebhookEvent.findUniqueOrThrow({ where: { eventId: "evt-route-1" } })).processedAt).not.toBeNull();
      expect(spy.mock.calls.flat().join(" ")).toContain("transfer.processed");
      expect(spy.mock.calls.flat().join(" ")).not.toContain("trf_1");

      const ok = await webhook("payment.dispute.created", { id: "disp_1" }, "payment", "evt-route-2");
      expect(ok.status).toBe(200);
      expect(ok.body.data).toEqual({ handled: true });
      expect(vi.mocked(handleRouteEvent)).toHaveBeenLastCalledWith("payment.dispute.created", expect.any(Object), "evt-route-2");
    });

    it("the one exception: an event the handler asks to have retried is left unprocessed and answered with a retryable 5xx", async () => {
      // Contract with handleRouteEvent: { retry: true } means an infrastructure error lost an event nothing else re-reads (a dispute).
      const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.mocked(handleRouteEvent).mockResolvedValueOnce({ handled: false, note: "error", retry: true } as never);
      const first = await webhook("payment.dispute.created", { id: "disp_retry" }, "payment", "evt-retry-1");
      expect(first.status).toBe(503);
      expect(first.body.error.code).toBe("TEMPORARY");
      // NOT stamped processed: Razorpay's redelivery must be able to run it again.
      expect((await prisma.razorpayWebhookEvent.findUniqueOrThrow({ where: { eventId: "evt-retry-1" } })).processedAt).toBeNull();
      expect(spy.mock.calls.flat().join(" ")).not.toContain("disp_retry");

      const again = await webhook("payment.dispute.created", { id: "disp_retry" }, "payment", "evt-retry-1");
      expect(again.status).toBe(200);
      expect(again.body.data).toEqual({ handled: true }); // the retry flag is not echoed back
      expect(vi.mocked(handleRouteEvent)).toHaveBeenCalledTimes(2);
      expect((await prisma.razorpayWebhookEvent.findUniqueOrThrow({ where: { eventId: "evt-retry-1" } })).processedAt).not.toBeNull();

      // Finished now: a further delivery is a duplicate and is not processed a third time.
      const third = await webhook("payment.dispute.created", { id: "disp_retry" }, "payment", "evt-retry-1");
      expect(third.status).toBe(200);
      expect(third.body.data.duplicate).toBe(true);
      expect(vi.mocked(handleRouteEvent)).toHaveBeenCalledTimes(2);
    });

    it("a handler that reports an error WITHOUT asking for a retry is stamped processed and answered 2xx", async () => {
      vi.mocked(handleRouteEvent).mockResolvedValueOnce({ handled: false, note: "unreadable" });
      const res = await webhook("transfer.failed", { id: "trf_x" }, "payment", "evt-noretry-1");
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ handled: false, note: "unreadable" });
      expect((await prisma.razorpayWebhookEvent.findUniqueOrThrow({ where: { eventId: "evt-noretry-1" } })).processedAt).not.toBeNull();
    });

    it("are not offered the payment and refund events", async () => {
      const s = await seed({ booking: "awaiting_payment", prices: [100_000], payment: { status: "created" } });
      await webhook("payment.captured", paid(s.n, 100_000));
      await webhook("refund.processed", { id: "rfnd_none", payment_id: "pay_unknown" }, "refund");
      expect(vi.mocked(handleRouteEvent)).not.toHaveBeenCalled();
    });
  });
});
