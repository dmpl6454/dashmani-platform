/**
 * RACE 9 (beyond the eight asked for): a payment DISPUTE opening while a release is in flight.
 *
 * A dispute is learned two ways that do not arrive together: Razorpay's own list (the release gate asks it, fresh, before it
 * claims) and the `payment.dispute.created` webhook (which pauses every payout still in flight on that payment). A release that
 * started a moment before either can therefore complete with the dispute already open. The engine's answer is the `rehold_paused`
 * job: a RELEASED, unsettled payout that a dispute paused has its hold put back (PATCH on_hold:true, UNVERIFIED on a released
 * transfer: plan question d) and, on a fresh read, goes released → held.
 *
 * What is raced: for 8 payments (one creator each), a release and the dispute (it appears at Razorpay and its webhook is
 * delivered, twice at once) start together, the dispute's start swept across the release's gate-and-claim path (laid out in
 * multiples of the MEASURED gate time). Whatever the interleaving, after the worker has had its turns:
 *   • no payout is left with its hold LIFTED at Razorpay while a dispute is open: its transfer is on hold again (or the payout
 *     was never released), whichever side won;
 *   • the payout is `held` (a hold put back) and paused for the dispute, never `released`, never reversed by this path;
 *   • the dispute is recorded once and each payout was paused once (a doubled delivery is not a second pause);
 *   • the audit rows are one legal walk; Razorpay and our row agree.
 * Three outcomes are expected across the sweep and the test prints how many of each it saw: the release was refused (the gate
 * saw the dispute), the pause landed before the claim, or the release completed and was re-held afterwards.
 *
 * Two PLACED tests pin the two windows exactly: the webhook lands after the release CLAIMED and before it asked Razorpay (the
 * release's second look reads the pause and stops: the hold is never lifted), and it lands after that last look and just before
 * the PATCH is applied (the window no look can close: the hold IS lifted, the payout reads released-and-paused, and only the worker's
 * re-hold puts it back). The second one documents a real, bounded exposure: for the length of one worker interval the money of a
 * disputed payment is out of hold. The alert the dispute handler sends says so ("Already released or releasing").
 */
import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "@dashmani/db";

vi.mock("../../src/services/email.service", async (orig) => {
  const actual = await orig<typeof import("../../src/services/email.service")>();
  return { ...actual, sendEmail: vi.fn(async () => ({ messageId: "test" })), notifyAdminByEmail: vi.fn(async () => ({ messageId: "test" })) };
});

import { releasePayout, runPayoutJob, selectDuePayouts } from "../../src/services/creator/payout.service";
import {
  DAY,
  FakeRazorpay,
  SEED,
  calibrateGate,
  deliver,
  expectLegalHistories,
  expectPayoutMatchesRazorpay,
  heldWorld,
  holdOffOf,
  is,
  makeReleasable,
  payoutOf,
  rngFor,
  statusEdges,
  together,
  useMoneyHarness,
  withLatency,
  type World,
} from "./cc-helpers";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

const fake = new FakeRazorpay();
const SPAN = 2.5;
const nowSec = () => Math.floor(Date.now() / 1000);

function disputePayload(disputeId: string, paymentId: string) {
  return {
    payment: { entity: { id: paymentId, entity: "payment", amount: 100000 } },
    dispute: { entity: { id: disputeId, entity: "dispute", payment_id: paymentId, amount: 100000, currency: "INR", amount_deducted: 0, reason_code: "chargeback", respond_by: nowSec() + 7 * 86400, status: "open", phase: "chargeback", created_at: nowSec() - 5 } },
  };
}

describe("race 9: a dispute opens while a release is in flight", () => {
  const h = useMoneyHarness(fake);

  it("PLACED: the dispute's webhook lands after the release CLAIMED and before it asked Razorpay: the release's second look stops it, the hold is never lifted", async () => {
    const w = await heldWorld(fake, { pages: [{}] });
    const c = w.creators[0];
    await makeReleasable(w, c.id, h.staff().staffId);
    const p = await payoutOf(c.id);
    const body = disputePayload(`disp_PL${randomUUID().replace(/-/g, "").slice(0, 12)}`, p.razorpayPaymentId);
    const rel = await releasePayout(p.id, {
      hooks: {
        afterClaim: async () => {
          fake.addDispute({ id: body.dispute.entity.id, paymentId: p.razorpayPaymentId, status: "open" });
          expect((await deliver("payment.dispute.created", body, `evt_disp_${randomUUID()}`)).status).toBe(200);
        },
      },
    });
    expect(rel).toMatchObject({ ok: false, outcome: "refused" });
    const now = await payoutOf(c.id);
    expect(now).toMatchObject({ status: "held", pausedReason: "dispute" });
    expect(now.pausedAt).not.toBeNull();
    expect(holdOffOf(fake, p.razorpayTransferId!), "the hold was lifted although a dispute had paused the payout").toBe(0);
    expect(fake.transfers.get(p.razorpayTransferId!)).toMatchObject({ onHold: true, amountReversed: 0 });
    await expectLegalHistories([p.id]);
  });

  it("PLACED: the dispute lands after the release's last look and just BEFORE its PATCH is applied (the window no look can close): the hold is lifted, the payout is released-and-paused, and the worker puts the hold back", async () => {
    const w = await heldWorld(fake, { pages: [{}] });
    const c = w.creators[0];
    await makeReleasable(w, c.id, h.staff().staffId);
    const p = await payoutOf(c.id);
    const body = disputePayload(`disp_PL${randomUUID().replace(/-/g, "").slice(0, 12)}`, p.razorpayPaymentId);
    fake.intercept({
      match: (x) => is.setHold(x, false),
      mode: "pass",
      before: async () => {
        fake.addDispute({ id: body.dispute.entity.id, paymentId: p.razorpayPaymentId, status: "open" });
        expect((await deliver("payment.dispute.created", body, `evt_disp_${randomUUID()}`)).status).toBe(200);
      },
    });
    const rel = await releasePayout(p.id);
    expect(rel).toMatchObject({ ok: true, status: "released" });
    expect(await payoutOf(c.id)).toMatchObject({ status: "released", pausedReason: "dispute" });
    expect(fake.transfers.get(p.razorpayTransferId!)).toMatchObject({ onHold: false }); // the window: the money is out of hold until the worker acts
    // The worker's turn: the re-hold job runs for a released payout that a dispute paused.
    const later = new Date(Date.now() + DAY);
    for (const d of await selectDuePayouts(later, 50)) await runPayoutJob(d.job, d.id, { now: later });
    expect(await payoutOf(c.id)).toMatchObject({ status: "held", pausedReason: "dispute" });
    expect(fake.transfers.get(p.razorpayTransferId!)).toMatchObject({ onHold: true, amountReversed: 0 });
    await expectLegalHistories([p.id]);
  });

  it("8 payments: the release and the dispute (Razorpay's list + two webhook deliveries) start together, the dispute swept across the release's path: no hold is left lifted while a dispute is open", async () => {
    const rng = rngFor("dispute-vs-release");
    const K = 8;
    // One payment per creator (each world has one page), so each dispute pauses exactly one payout.
    const worlds: World[] = [];
    const CAL = 4;
    for (let i = 0; i < K + CAL; i++) worlds.push(await heldWorld(fake, { pages: [{}] }));
    for (const w of worlds) await makeReleasable(w, w.creators[0].id, h.staff().staffId);
    withLatency(fake, rng, { beforeMs: [2, 7], afterMs: [0, 4], only: (c) => c.path.startsWith("/v1/transfers") || is.listDisputes(c) || is.fetchProduct(c) });

    // Calibrate the release's gate time under load on four extra payments (released together; no dispute there).
    const gateMs = await calibrateGate((await Promise.all(worlds.slice(K).map((w) => payoutOf(w.creators[0].id)))).map((p) => p.id));

    const payouts = await Promise.all(worlds.slice(0, K).map((w) => payoutOf(w.creators[0].id)));
    const disputeIds = payouts.map(() => `disp_RW${randomUUID().replace(/-/g, "").slice(0, 12)}`);
    const jobs = payouts.flatMap((p, i) => {
      const at = Math.round((i / (K - 1)) * SPAN * gateMs) + Math.floor(rng() * 3);
      const body = disputePayload(disputeIds[i], p.razorpayPaymentId);
      // The dispute exists at Razorpay from `at`, and its webhook is delivered then, twice at once.
      const open = async () => {
        fake.addDispute({ id: disputeIds[i], paymentId: p.razorpayPaymentId, status: "open", createdAt: nowSec() });
        return deliver("payment.dispute.created", body, `evt_disp_${randomUUID()}`);
      };
      return [
        { run: () => releasePayout(p.id), delayMs: 0 },
        { run: open, delayMs: at },
        { run: () => deliver("payment.dispute.created", body, `evt_disp_${randomUUID()}`), delayMs: at + 1 },
      ];
    });
    const out = await together(jobs);
    for (const o of out) expect(o.ok, String((o.error as Error)?.stack ?? o.error)).toBe(true);
    for (let i = 0; i < K; i++) for (const k of [1, 2]) expect((out[3 * i + k].value as { status: number }).status, `a dispute delivery was not answered 2xx (seed ${SEED})`).toBe(200);

    // What each side did, BEFORE the worker has had its turn.
    const seen = { refused: 0, pausedBeforeClaim: 0, releasedThenPaused: 0, other: 0 };
    const before: Array<{ status: string; paused: boolean }> = [];
    for (const [i, p] of payouts.entries()) {
      const now = await prisma.creatorPayout.findUniqueOrThrow({ where: { id: p.id } });
      before.push({ status: now.status, paused: now.pausedAt !== null });
      const rel = out[3 * i].value as { outcome: string };
      if (rel.outcome === "refused") seen.refused++;
      else if (now.status === "held") seen.pausedBeforeClaim++;
      else if (now.status === "released") seen.releasedThenPaused++;
      else seen.other++;
    }

    // The worker has its turns (time moves on): the re-hold job runs for every released payout a dispute paused.
    const later = new Date(Date.now() + DAY);
    for (let round = 0; round < 4; round++) {
      for (const d of await selectDuePayouts(new Date(later.getTime() + round * 3_600_000), 50)) await runPayoutJob(d.job, d.id, { now: new Date(later.getTime() + round * 3_600_000) });
    }
    console.log(`[race 9] gate ${gateMs} ms; before the worker: ${JSON.stringify(seen)}; states ${JSON.stringify(before.reduce<Record<string, number>>((a, b) => ((a[`${b.status}${b.paused ? "+paused" : ""}`] = (a[`${b.status}${b.paused ? "+paused" : ""}`] ?? 0) + 1), a), {}))} (seed ${SEED})`);

    for (const [i, p] of payouts.entries()) {
      const now = await prisma.creatorPayout.findUniqueOrThrow({ where: { id: p.id } });
      const t = fake.transfers.get(p.razorpayTransferId!)!;
      const where = `payout ${p.id}: status=${now.status} paused=${now.pausedAt !== null}(${now.pausedReason}) hold=${t.onHold} holdOffApplied=${holdOffOf(fake, p.razorpayTransferId!)} seed=${SEED}`;
      // The point: with a dispute open, the money is NOT out. Its hold is on, and our row says held.
      expect(t.onHold, `${where}: a dispute is open but the transfer's hold is lifted`).toBe(true);
      expect(t.amountReversed, where).toBe(0);
      expect(now.status, where).toBe("held");
      expect(now.pausedAt, `${where}: the dispute did not pause the payout`).not.toBeNull();
      expect(now.pausedReason, where).toBe("dispute");
      // One dispute row, one pause per payout (a doubled delivery is not a second pause).
      expect(await prisma.campaignDispute.count({ where: { razorpayDisputeId: disputeIds[i] } }), where).toBe(1);
      expect(await prisma.creatorPayoutEvent.count({ where: { payoutId: p.id, kind: "pause" } }), `${where}: paused more than once`).toBe(1);
      await expectPayoutMatchesRazorpay(fake, p.id, "dispute vs release");
    }
    await expectLegalHistories(payouts.map((p) => p.id), "dispute vs release");
    // The sweep is only worth something if the release really did win some of them (released, then re-held).
    const reheld = (await Promise.all(payouts.map((p) => statusEdges(p.id)))).filter((e) => e.some((x) => x.from === "released" && x.to === "held")).length;
    console.log(`[race 9] re-held after a release: ${reheld} of ${K}`);
    expect(seen.refused + seen.pausedBeforeClaim + reheld, "the sweep produced no interleaving at all").toBeGreaterThan(0);
  });
});
