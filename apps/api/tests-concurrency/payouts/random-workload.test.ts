/**
 * RACE 8: a seeded, randomised, mixed workload over many payouts, with injected unknown results.
 *
 * Every other file in this directory aims two or three callers at one fact. This one aims EVERYTHING at EVERYTHING and asks
 * only whether the money still adds up. Four BUILDER workers (70 operations each) push money forward and two TAKER workers (14
 * each, spread across the run, like staff and creators) take it back, over 5 bookings: 20 creator payouts and 5 network posts,
 * a mix of offered, accepted-with-a-link and plain posts, and one booking whose payouts are still PLANNED for the worker to make:
 *
 *   builders: the worker's tick, a second worker's pass, execute, release, verify (+ the release schedule), accept, job 10, the
 *             refund sweep, fresh and re-delivered transfer.processed / settlement.processed webhooks, and the world itself moving
 *             (Razorpay settles a transfer, or the bank rejects the settlement);
 *   takers:   reverse a share, decline, expire, withdraw, refund one post, Reject a campaign, pause and resume a payout.
 *
 * Razorpay misbehaves while they run: about 8% of calls get a fault chosen at random: the answer is LOST after the request was
 * applied, the request NEVER ARRIVES, a 502, an unreadable 200, or (for a write) a definite refusal. Calls have simulated
 * network time. The whole thing is repeated in independent rounds (own estate, own seeds), and CC_SCALE=4 makes each round four
 * times longer for a soak.
 *
 * ⚠️ WHAT A TAKER DOING SOMETHING DANGEROUS MEANS. A staff "reverse" of a payout whose post is live, and of one that has
 * already settled to the creator's bank, are NOT filtered out: they are the adversarial case. The engine's answer to the second
 * is to refuse (Razorpay needs a floating balance) and park the payout for a person; that is why a few payouts end
 * `needs_attention` and the money-out invariant (S) allows for them. A definite refusal injected into a refund surfaces as a
 * designed 502 REFUND_FAILED, which is not counted as a defect.
 *
 * Then the faults stop, staff resume anything they paused, the workers keep ticking (time jumps forward) and Reject is pressed again
 * on any campaign left half-rejected, until nothing is in flight. THE INVARIANTS (the point of the test):
 *
 *   H  every payout has ONE legal history: its audit rows form a walk planned → its status using only moves payout-states allows
 *      (a payout claimed twice from one state, or a state skipped, has no such walk);
 *   M  Razorpay and our rows agree (reversed ⇒ fully reversed transfer; released/settled ⇒ hold lifted and nothing taken back;
 *      held ⇒ hold on), and at most ONE live transfer carries any payout's id;
 *   R  REVERSE BEFORE REFUND: a creator post that was refunded to the brand has a payout that is void, or reversed BEFORE the
 *      refund was applied (and a void one has no live transfer);
 *   X  NO POST BOTH REFUNDED AND PAID: a refunded creator post's payout never reads released / settled / paid by hand;
 *   C  CONSERVATION per payment: refunds + live transfers ≤ what it captured, AND the unclamped refundable amount
 *      (captured − refunded − reserved) is never negative, i.e. no negative reserve;
 *   S  money OUT: what Razorpay shows lifted from hold and not taken back equals what our rows call released or settled
 *      (nothing left our balance that we do not know about, and nothing we call paid is still held);
 *   K  every refund INTENT (rf-item-<id>, however many requests carried its key: a re-sent request under one key is ONE refund
 *      at Razorpay) produced at most one refund; every reversal request named its amount (never reverse_all); the ledger's refunds
 *      and Razorpay's are the same total once the sweep has run;
 *   L  LIVENESS: nothing is left in flight (requested / release_requested / reversal_requested), and no creator post is left
 *      refund due, after the faults stop and the workers have had their turns;
 *   E  no operation failed with anything but a clean AppError: no raw database error (a pool timeout, a deadlock, a unique
 *      violation) and no exception reached a caller.
 *
 * SEEDS. CC_SEED reproduces the same operations, targets and fault choices; real scheduling is still the machine's. The seed
 * is in every failure message. A failing run is a real finding: do not retry it into green.
 */
import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { prisma } from "@dashmani/db";

vi.mock("../../src/services/email.service", async (orig) => {
  const actual = await orig<typeof import("../../src/services/email.service")>();
  return { ...actual, sendEmail: vi.fn(async () => ({ messageId: "test" })), notifyAdminByEmail: vi.fn(async () => ({ messageId: "test" })) };
});

import app from "../../src/app";
import { sweepRefundDue } from "../../src/services/campaign/payment.service";
import { acceptOffer, declineOffer, expireOffer, verifyCreatorItem, withdrawOffer } from "../../src/services/creator/creator-offer.service";
import { onCreatorLinkVerified } from "../../src/services/creator/payout-ledger";
import { runRefundDueJob, settleCreatorRefundsForTests } from "../../src/services/creator/creator-refund.service";
import { executePlannedPayout, pausePayout, releasePayout, resumePayout, reversePayout, runPayoutJob, selectDuePayouts } from "../../src/services/creator/payout.service";
import { runCreatorPayoutsTick } from "../../src/cron/creator-payouts.cron";
import { openOffer } from "../../tests/payout-fixtures";
import {
  DAY,
  FakeRazorpay,
  HOUR,
  MIN,
  SEED as SUITE_SEED,
  appliedRefunds,
  booksOf,
  expectBooksClose,
  heldWorld,
  historyProblem,
  intentOfKey,
  is,
  plannedWorld,
  rngFor,
  sleep,
  statusEdges,
  together,
  useMoneyHarness,
  withLatency,
  type World,
  deliver,
} from "./cc-helpers";

vi.setConfig({ testTimeout: 600_000, hookTimeout: 120_000 });

const fake = new FakeRazorpay();

/** Workers 0..3 push money forward (execute, verify, release, poll, webhooks); workers 4 and 5 are staff and the creators, who take it back. */
const BUILDERS = 4;
const TAKERS = 2;
const WORKERS = BUILDERS + TAKERS;
/** CC_SCALE=4 runs four times as many operations per worker: a soak for a person, not for CI. */
const SCALE = Math.max(1, Math.floor(Number(process.env.CC_SCALE) || 1));
const BUILDER_OPS = 70 * SCALE;
const TAKER_OPS = 14 * SCALE;
/** Independent rounds, each with its own estate, seeds and faults (the suite truncates between tests). */
const ROUNDS = 4;
const BOOKINGS = 5;
const FAULT_RATE = 0.08;

interface Prepared {
  w: World;
  offered: { itemId: string; offerId: string; creatorId: string };
  /** Two accepted offers whose link is submitted and auto-checked: ready for staff to verify, then to be released. */
  accepted: Array<{ itemId: string; offerId: string; creatorId: string; key: string }>;
  plain: { itemId: string };
  network: { itemId: string };
}

describe("race 8: a randomised mixed workload with injected unknown results", () => {
  const h = useMoneyHarness(fake);

  for (let round = 0; round < ROUNDS; round++) {
    it(`round ${round}: ${BUILDERS} builders x ${BUILDER_OPS} + ${TAKERS} takers x ${TAKER_OPS} random operations over ${BOOKINGS} bookings, ~${Math.round(FAULT_RATE * 100)}% of Razorpay calls faulty: every invariant holds once things settle`, async () => {
      const SEED = `${SUITE_SEED}.r${round}`; // every message below carries it; CC_SEED=<n> replays the same operations
      const rng = rngFor(`random-workload-${round}`);
      const pick = <T>(xs: readonly T[]): T | undefined => (xs.length ? xs[Math.floor(rng() * xs.length)] : undefined);
      const T0 = Date.now();

      // ── The estate ──────────────────────────────────────────────────────────────
      const prepared: Prepared[] = [];
      for (let i = 0; i < BOOKINGS; i++) {
        const spec = { pages: [{}, {}, {}, {}], network: [100_000] };
        const w = i === 2 ? await plannedWorld(fake, spec) : await heldWorld(fake, spec);
        const [a, b, c, d] = w.creators;
        const offered = await openOffer(w, a.id, { status: "offered", expiresAt: new Date(T0 + 12 * HOUR) });
        const accepted: Prepared["accepted"] = [];
        for (const [k, item] of [b, c].entries()) {
          const o = await openOffer(w, item.id, { status: "accepted", linkSubmitted: true });
          const code = `RW${i}${k}${Date.now().toString(36)}`;
          await prisma.creatorOffer.update({ where: { id: o.id }, data: { linkUrl: `https://www.instagram.com/p/${code}/`, linkCanonicalKey: `ig:${code}`, ownershipCheck: "auto_ok" } });
          accepted.push({ itemId: item.id, offerId: o.id, creatorId: item.creatorId!, key: `ig:${code}` });
        }
        prepared.push({ w, offered: { itemId: a.id, offerId: offered.id, creatorId: a.creatorId! }, accepted, plain: { itemId: d.id }, network: { itemId: w.networkItems[0].id } });
      }
      const staff = h.staff();
      const bookingOfItem = new Map<string, string>();
      for (const p of prepared) for (const i of p.w.items) bookingOfItem.set(i.id, p.w.booking.id);
      const allItems = prepared.flatMap((p) => p.w.items);
      const rejectedAttempts = new Set<string>();

      // ── Faults and network time ─────────────────────────────────────────────────
      withLatency(fake, rng, { beforeMs: [0, 6], afterMs: [0, 3] });
      let injected = 0;
      fake.chaos = (c) => {
        if (!c.path.startsWith("/v1/")) return null;
        const r = rng();
        if (r >= FAULT_RATE) return null;
        injected++;
        const write = c.method === "POST" || c.method === "PATCH";
        const modes = write ? (["lose", "drop", "badgateway", "garbage", "reject"] as const) : (["drop", "badgateway", "garbage"] as const);
        const mode = modes[Math.floor(rng() * modes.length)];
        return mode === "reject" ? { mode, status: 400 } : { mode };
      };

      // ── The operations ──────────────────────────────────────────────────────────
      const unexpected: Array<{ op: string; error: string }> = [];
      const log: Record<string, number> = {};
      const clockAhead = () => new Date(Date.now() + Math.floor(rng() * 8 * HOUR));
      const staffActor = { type: "staff" as const, id: staff.staffId };
      const anyPayout = async (where: Record<string, unknown> = {}) => pick(await prisma.creatorPayout.findMany({ where, select: { id: true, bookingItemId: true, bookingId: true, razorpayTransferId: true } }));
      const deliveredEvents: Array<{ event: string; payload: unknown; id: string }> = [];

      // A route answers a clean 4xx for a loser, and 502 REFUND_FAILED when Razorpay definitely refused a refund (this test injects
      // exactly that): both are designed answers. Anything else at 5xx is the "unexpected error" a person would see.
      const expectedFiveHundreds = new Set(["REFUND_FAILED"]);
      const noUnexpected5xx = (what: string, r: { status: number; body?: { error?: { code?: string } } }) => {
        if (r.status >= 500 && !expectedFiveHundreds.has(String(r.body?.error?.code))) throw new Error(`${what} answered ${r.status}: ${JSON.stringify(r.body?.error)}`);
      };
      const rejectBooking = async (bookingId: string) => {
        rejectedAttempts.add(bookingId);
        noUnexpected5xx("reject", await request(app).post(`/v1/admin/campaigns/${bookingId}/reject`).set("Authorization", `Bearer ${staff.admin}`).send({ note: "random" }));
      };
      const refundOne = async (bookingId: string, itemId: string) => {
        noUnexpected5xx("refund", await request(app).post(`/v1/admin/campaigns/${bookingId}/items/${itemId}/refund`).set("Authorization", `Bearer ${staff.admin}`).send({}));
      };

      type Op = { name: string; weight: number; kind: "build" | "take"; run: () => Promise<unknown> };
      const accOf = (p: Prepared) => pick(p.accepted)!;
      const OPS: Op[] = [
        // ── What pushes money forward ──
        { name: "tick", weight: 6, kind: "build", run: () => runCreatorPayoutsTick({ now: clockAhead() }) },
        {
          name: "pass",
          weight: 6,
          kind: "build",
          run: async () => {
            const now = clockAhead();
            for (const d of await selectDuePayouts(now, 20)) await runPayoutJob(d.job, d.id, { now });
          },
        },
        { name: "execute", weight: 6, kind: "build", run: async () => { const p = await anyPayout({ status: "planned" }); if (p) await executePlannedPayout(p.id); } },
        { name: "release", weight: 10, kind: "build", run: async () => { const p = await anyPayout({ status: "held", releaseAfter: { not: null } }); if (p) await releasePayout(p.id); } },
        {
          name: "verify",
          weight: 10,
          kind: "build",
          run: async () => {
            const p = pick(prepared)!;
            const a = accOf(p);
            await verifyCreatorItem(p.w.booking.id, a.itemId, { staffId: staff.staffId });
            await onCreatorLinkVerified(a.itemId, staffActor);
          },
        },
        { name: "accept", weight: 3, kind: "build", run: async () => { const p = pick(prepared)!; await acceptOffer(p.offered.creatorId, p.offered.offerId, new Date(T0)); } },
        { name: "job10", weight: 4, kind: "build", run: () => runRefundDueJob({ now: clockAhead() }) },
        { name: "sweep", weight: 3, kind: "build", run: () => sweepRefundDue({ now: clockAhead() }) },
        {
          name: "webhook-transfer",
          weight: 5,
          kind: "build",
          run: async () => {
            const t = pick([...fake.transfers.values()]);
            if (!t || t.status === "failed") return;
            const ev = { event: "transfer.processed", id: `evt_rw_${randomUUID()}`, payload: { transfer: { entity: { id: t.id, entity: "transfer", status: "processed", source: t.source, recipient: t.recipient, amount: t.amount, currency: "INR", amount_reversed: t.amountReversed, notes: t.notes, fees: 1, tax: 0, on_hold: t.onHold, on_hold_until: null, settlement_status: t.onHold ? "on_hold" : "pending", recipient_settlement_id: t.settlementId, created_at: t.createdAt, processed_at: t.createdAt + 5 } } } };
            deliveredEvents.push(ev);
            const r = await deliver(ev.event, ev.payload as Record<string, unknown>, ev.id);
            if (r.status >= 500) throw new Error(`webhook answered ${r.status}`);
          },
        },
        {
          name: "webhook-settlement",
          weight: 5,
          kind: "build",
          run: async () => {
            const s = pick([...fake.settlements.values()].filter((x) => x.status === "processed"));
            if (!s) return;
            const ev = { event: "settlement.processed", id: `evt_rw_${randomUUID()}`, payload: { settlement: { entity: { id: s.id, entity: "settlement", amount: s.amount, status: "processed", fees: 0, tax: 0, utr: s.utr, created_at: Math.floor(Date.now() / 1000) - 60 } } } };
            deliveredEvents.push(ev);
            const r = await deliver(ev.event, ev.payload as Record<string, unknown>, ev.id);
            if (r.status >= 500) throw new Error(`webhook answered ${r.status}`);
          },
        },
        {
          name: "redeliver",
          weight: 4,
          kind: "build",
          run: async () => {
            const ev = pick(deliveredEvents);
            if (!ev) return;
            const r = await deliver(ev.event, ev.payload as Record<string, unknown>, rng() < 0.5 ? ev.id : `evt_rw_${randomUUID()}`);
            if (r.status >= 500) throw new Error(`webhook answered ${r.status}`);
          },
        },
        {
          name: "env-settle",
          weight: 6,
          kind: "build",
          run: async () => {
            // The world moves: Razorpay settles a released transfer to the creator's bank, or the bank rejects it.
            const t = pick([...fake.transfers.values()].filter((x) => !x.onHold && x.amountReversed === 0 && x.settlementId === null && x.status !== "failed"));
            if (t) fake.settleTransfer(t.id, rng() < 0.85 ? {} : { status: "failed", utr: null });
          },
        },
        // ── What takes it back (staff and the creators) ──
        {
          name: "reverse",
          weight: 3,
          kind: "take",
          run: async () => {
            // Staff take a share back (a dispute, a mistake). Mostly where the post is not live; sometimes anywhere, which is the dangerous case.
            const p = await anyPayout({ status: { in: ["held", "released", "settlement_failed"] } });
            if (p) await reversePayout(p.id, { reason: "staff", actor: staffActor });
          },
        },
        { name: "decline", weight: 2, kind: "take", run: async () => { const p = pick(prepared)!; await declineOffer(p.offered.creatorId, p.offered.offerId, "no", new Date(T0)); } },
        { name: "expire", weight: 2, kind: "take", run: async () => { const p = pick(prepared)!; await expireOffer(p.offered.offerId, new Date(T0 + 13 * HOUR)); } },
        { name: "withdraw", weight: 3, kind: "take", run: async () => { const p = pick(prepared)!; await withdrawOffer(pick([p.offered.offerId, accOf(p).offerId])!, { staffId: staff.staffId }); } },
        { name: "refund-item", weight: 3, kind: "take", run: async () => { const i = pick(allItems)!; await refundOne(bookingOfItem.get(i.id)!, i.id); } },
        { name: "reject", weight: 1, kind: "take", run: async () => rejectBooking(pick(prepared)!.w.booking.id) },
        { name: "pause", weight: 2, kind: "take", run: async () => { const p = await anyPayout({ status: { in: ["held", "planned"] } }); if (p) await pausePayout(p.id, { reason: "staff", actor: staffActor }); } },
        { name: "resume", weight: 3, kind: "take", run: async () => { const p = await anyPayout({ pausedAt: { not: null } }); if (p) await resumePayout(p.id, { actor: staffActor }); } },
      ];
      const chooseOp = (kind: Op["kind"]) => {
        const pool = OPS.filter((o) => o.kind === kind);
        let r = rng() * pool.reduce((a, o) => a + o.weight, 0);
        for (const o of pool) if ((r -= o.weight) < 0) return o;
        return pool[0];
      };

      const worker = (id: number) => async () => {
        const kind: Op["kind"] = id < BUILDERS ? "build" : "take";
        const n = kind === "build" ? BUILDER_OPS : TAKER_OPS;
        for (let i = 0; i < n; i++) {
          const op = chooseOp(kind);
          log[op.name] = (log[op.name] ?? 0) + 1;
          try {
            await op.run();
          } catch (e) {
            const err = e as { statusCode?: number; name?: string; message?: string; code?: string };
            // A clean refusal (an AppError) is what a loser of a race gets. Anything else is a defect somebody would see as a 500.
            if (typeof err?.statusCode !== "number") unexpected.push({ op: op.name, error: `${err?.name ?? "Error"} ${err?.code ?? ""} ${String(err?.message ?? e).slice(0, 220)}` });
            else if (err.statusCode >= 500 && !expectedFiveHundreds.has(String(err.code))) unexpected.push({ op: op.name, error: `AppError ${err.statusCode} ${err.code}` });
          }
          // The takers act now and then, spread across the run; the builders keep going.
          await sleep(kind === "build" ? Math.floor(rng() * 5) : 15 + Math.floor(rng() * 45));
        }
      };

      const t0 = Date.now();
      await together(Array.from({ length: WORKERS }, (_, i) => ({ run: worker(i), delayMs: i < BUILDERS ? i * 2 : 120 + i * 40 })));
      await settleCreatorRefundsForTests();
      console.log(`[race 8] ${BUILDERS * BUILDER_OPS + TAKERS * TAKER_OPS} operations in ${Date.now() - t0} ms; ${injected} faults injected; mix ${JSON.stringify(log)} (seed ${SEED})`);

      // ── The faults stop; staff resume what they paused; time passes; the workers do their turns ─────────────────
      fake.chaos = null;
      fake.latency = null;
      for (const p of await prisma.creatorPayout.findMany({ where: { pausedAt: { not: null } }, select: { id: true } })) await resumePayout(p.id, { actor: staffActor }).catch(() => undefined);
      const inFlight = async () =>
        (await prisma.creatorPayout.count({ where: { status: { in: ["transfer_requested", "release_requested", "reversal_requested"] } } })) +
        (await prisma.campaignBookingItem.count({ where: { targetType: "creator_asset", status: "refund_due" } })) +
        (await prisma.campaignRefund.count({ where: { origin: "ours", status: { in: ["requested", "pending"] } } }));
      let rounds = 0;
      for (; rounds < 60; rounds++) {
        if ((await inFlight()) === 0 && rounds > 0) break;
        const t = new Date(T0 + 24 * HOUR + (rounds + 1) * 3 * HOUR);
        // Staff press Reject again on every campaign they tried to reject that is not finished.
        for (const bookingId of rejectedAttempts) {
          const b = await prisma.campaignBooking.findUniqueOrThrow({ where: { id: bookingId }, select: { status: true } });
          if (["paid_pending_review", "changes_requested", "approved"].includes(b.status) && (await prisma.campaignBookingItem.count({ where: { bookingId, status: "refund_due" } })) > 0) await rejectBooking(bookingId).catch(() => undefined);
        }
        await runCreatorPayoutsTick({ now: t });
        await runRefundDueJob({ now: t });
        await sweepRefundDue({ now: t });
        await settleCreatorRefundsForTests();
        // A refund Razorpay has applied but the ledger still calls pending is learned from its list (the sweep reads it).
      }
      console.log(`[race 8] settled after ${rounds} round(s); still in flight: ${await inFlight()} (seed ${SEED})`);

      // ── THE INVARIANTS ──────────────────────────────────────────────────────────

      // E: nothing but clean refusals reached a caller.
      expect(unexpected, `operations failed with something that is not a clean refusal (seed ${SEED})`).toEqual([]);

      const payouts = await prisma.creatorPayout.findMany();
      const items = await prisma.campaignBookingItem.findMany({ where: { id: { in: allItems.map((i) => i.id) } } });
      const itemById = new Map(items.map((i) => [i.id, i]));
      const why = (p: { id: string; status: string }) => `payout ${p.id} (${p.status}) seed=${SEED}`;

      // L: liveness.
      const stuck = payouts.filter((p) => ["transfer_requested", "release_requested", "reversal_requested"].includes(p.status));
      expect(stuck.map((p) => `${p.id} ${p.status} ${p.errorCode ?? ""}`), `payouts left in flight after the faults stopped (seed ${SEED})`).toEqual([]);
      expect(items.filter((i) => i.status === "refund_due" && i.targetType === "creator_asset").map((i) => i.id), `creator posts left refund due (seed ${SEED})`).toEqual([]);

      // H: one legal history per payout.
      for (const p of payouts) {
        const problem = historyProblem(await statusEdges(p.id), "planned", p.status);
        expect(problem, `${why(p)}: ${problem}`).toBeNull();
      }

      // M: Razorpay and our rows agree; at most one live transfer per payout.
      for (const p of payouts) {
        expect(fake.liveTransfersFor(p.id).length, `${why(p)} has ${fake.liveTransfersFor(p.id).length} live transfers`).toBeLessThanOrEqual(1);
        if (!p.razorpayTransferId) continue;
        const t = fake.transfers.get(p.razorpayTransferId)!;
        const w = `${why(p)} transfer(onHold=${t.onHold}, reversed=${t.amountReversed}/${t.amount})`;
        if (p.status === "reversed") expect(t.amountReversed, w).toBe(t.amount);
        if (p.status === "released" || p.status === "settled") {
          expect(t.onHold, w).toBe(false);
          expect(t.amountReversed, w).toBe(0);
        }
        if (p.status === "held") {
          expect(t.onHold, w).toBe(true);
          expect(t.amountReversed, w).toBe(0);
        }
      }

      // R + X: reverse before refund; nothing both refunded and paid.
      const refundsApplied = fake.applied.filter((a) => a.status < 300 && is.refund(a.call));
      const keyOf = (a: (typeof refundsApplied)[number]) => a.call.headers["X-Refund-Idempotency"] ?? null;
      const refundsMade = appliedRefunds(fake);
      for (const p of payouts) {
        const mine = refundsMade.filter((r) => r.key !== null && intentOfKey(r.key) === `rf-item-${p.bookingItemId}`);
        const it = itemById.get(p.bookingItemId);
        if (mine.length === 0) {
          // Not refunded to the brand: an item that is `refunded` with no refund is only legal for a booking without an online payment.
          expect(it?.status === "refunded", `${why(p)}: its post is marked refunded but no refund exists for it`).toBe(false);
          continue;
        }
        expect(["void", "reversed"], `${why(p)}: its post was refunded to the brand but its payout is not out of the way`).toContain(p.status);
        const refund = refundsApplied.find((a) => keyOf(a) !== null && intentOfKey(keyOf(a)!) === `rf-item-${p.bookingItemId}`)!;
        if (p.status === "reversed") {
          const rev = fake.applied.findIndex((a) => a.status < 300 && is.createReversal(a.call) && p.razorpayTransferId !== null && a.call.path.includes(p.razorpayTransferId));
          const ref = fake.applied.findIndex((a) => a === refund);
          expect(rev, `${why(p)}: no applied reversal`).toBeGreaterThanOrEqual(0);
          expect(rev, `${why(p)}: refunded before its share was taken back`).toBeLessThan(ref);
        } else {
          expect(fake.liveTransfersFor(p.id), `${why(p)}: void, yet a live transfer carries its id`).toHaveLength(0);
        }
      }

      // K: every refund INTENT produced at most one refund (a re-sent request under the same key is one refund); every reversal named its amount.
      const intents = refundsMade.filter((r) => r.key !== null).map((r) => intentOfKey(r.key!));
      expect(new Set(intents).size, `an item was refunded to the brand more than once: ${intents.join(",")} (seed ${SEED})`).toBe(intents.length);
      for (const c of fake.calls.filter(is.createReversal)) expect(Number.isInteger(c.body?.amount), `a reversal without an amount (reverse_all): ${c.path} (seed ${SEED})`).toBe(true);

      // C: conservation and the reserve, per payment; and the ledger against Razorpay.
      const payments = await prisma.campaignPayment.findMany({ where: { razorpayPaymentId: { not: null } } });
      for (const pay of payments) {
        const books = await booksOf(fake, pay.razorpayPaymentId!);
        expectBooksClose(books, "random workload");
        const ledger = await prisma.campaignRefund.findMany({ where: { paymentId: pay.id, status: { not: "failed" } } });
        const ledgerTotal = ledger.reduce((a, r) => a + r.amountPaise, 0);
        expect(books.refundedAtRazorpay, `payment ${pay.id}: Razorpay refunded more than our ledger claims (seed ${SEED})`).toBeLessThanOrEqual(ledgerTotal);
        expect(pay.refundedPaise, `payment ${pay.id}: refundedPaise disagrees with the ledger (seed ${SEED})`).toBe(ledgerTotal);
        // After the sweep ran with the faults off, a ledger row Razorpay never heard of would be a refund we claimed and never made.
        expect(books.refundedAtRazorpay, `payment ${pay.id}: the ledger claims refunds Razorpay never made (seed ${SEED})`).toBe(ledgerTotal);
      }

      // S: money OUT.
      const lifted = [...fake.transfers.values()].filter((t) => !t.onHold && t.amountReversed < t.amount).reduce((a, t) => a + (t.amount - t.amountReversed), 0);
      const ours = payouts.filter((p) => p.status === "released" || p.status === "settled" || p.status === "settlement_failed").reduce((a, p) => a + p.amountPaise, 0);
      const parked = payouts.filter((p) => p.status === "needs_attention").length;
      if (parked === 0) expect(lifted, `Razorpay shows ${lifted} paise lifted from hold, our rows call ${ours} paid (seed ${SEED})`).toBe(ours);
      else expect(ours, `our rows call ${ours} paise paid but Razorpay shows only ${lifted} lifted (seed ${SEED})`).toBeLessThanOrEqual(lifted);

      // The plain inequality too: what our rows call paid out never exceeds what the captured payments set aside for creators.
      const sharesCaptured = payouts.reduce((a, p) => a + p.amountPaise, 0);
      expect(ours, `paid out ${ours} but only ${sharesCaptured} was set aside for creators (seed ${SEED})`).toBeLessThanOrEqual(sharesCaptured);

      // The shape of the end state, for the record.
      const byStatus: Record<string, number> = {};
      for (const p of payouts) byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
      for (const p of payouts.filter((x) => x.status === "needs_attention")) console.log(`[race 8] parked payout ${p.id}: ${p.errorCode} | ${p.lastError} (seed ${SEED})`);
      console.log(`[race 8] end state: payouts ${JSON.stringify(byStatus)}; refunds ${refundsMade.length} (${refundsApplied.length} requests); transfers ${fake.transfers.size}; reversals ${fake.appliedOk(is.createReversal).length}; settlements ${fake.settlements.size} (seed ${SEED})`);
      void DAY;
      void MIN;
    });
  }
});
