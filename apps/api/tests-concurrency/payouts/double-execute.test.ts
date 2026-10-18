/**
 * RACE 2: two workers executing the same `planned` payout.
 *
 * Razorpay has NO idempotency key for a transfer made from a payment [R3]: two create calls make two transfers, and the
 * second one moves the creator's share out of our balance AGAIN. So the only thing between a planned payout and a double
 * transfer is OUR claim, taken before Razorpay is asked:
 *
 *     planned → transfer_requested   (conditional: status = planned, not paused, lease free; stamps a 2-minute lease)
 *
 * Several callers reach a planned payout at once in production: the capture kick (right after the webhook), the
 * reconciliation worker's tick, a second API process's tick, staff pressing Retry. This file starts them together.
 *
 * WHAT IS ASSERTED, per payout, at the end: Razorpay was asked to create ONE transfer (applied, not merely attempted),
 * exactly one live transfer carries the payout's id, our row names exactly that transfer, the payout is `held`, and the
 * audit rows show ONE planned → transfer_requested claim. The same must hold when the create answer is LOST (applied, never
 * heard): the second worker must not "help" by creating again.
 *
 * MUTATION RESULTS (a scratch copy of apps/api outside the repo, the claim changed, the suite run against it):
 *   • the claim of planned → transfer_requested made a blind update     → RED (all four tests);
 *   • the status guard removed from the claim                           → GREEN: the lease alone still turns the second worker away;
 *   • the lease removed from the claim                                  → GREEN: the status guard alone still does;
 *   • both removed                                                      → RED.
 * Two independent conditions guard the claim, so removing ONE leaves the race protected: the design, not a gap in the test.
 * The "LOCK QUEUE" test is the deterministic one: both executors read `planned`, queue on the payout row held by another
 * connection, and are served one after the other, the second re-evaluating its WHERE (see release-vs-reversal.test.ts).
 */
import { describe, it, expect, vi } from "vitest";
import { prisma } from "@dashmani/db";

vi.mock("../../src/services/email.service", async (orig) => {
  const actual = await orig<typeof import("../../src/services/email.service")>();
  return { ...actual, sendEmail: vi.fn(async () => ({ messageId: "test" })), notifyAdminByEmail: vi.fn(async () => ({ messageId: "test" })) };
});

import { executePlannedPayout, resolveUnknownTransfer, runPayoutJob, selectDuePayouts } from "../../src/services/creator/payout.service";
import {
  FakeRazorpay,
  SEED,
  countApplied,
  expectLegalHistories,
  expectPayoutMatchesRazorpay,
  is,
  payoutIdsOf,
  plannedWorld,
  rngFor,
  statusEdges,
  together,
  useMoneyHarness,
  withLatency,
  withRowLockQueue,
} from "./cc-helpers";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

const fake = new FakeRazorpay();

/** What a reconciliation tick does for the payouts due now, minus the tick's overlap guard (a second PROCESS has no such guard). */
async function workerPass(): Promise<void> {
  const due = await selectDuePayouts(new Date(), 50);
  for (const d of due) await runPayoutJob(d.job, d.id);
}

async function expectOneTransferEach(w: Awaited<ReturnType<typeof plannedWorld>>, why: string): Promise<void> {
  for (const c of w.creators) {
    const p = await prisma.creatorPayout.findUniqueOrThrow({ where: { bookingItemId: c.id } });
    const where = `${why}: payout ${p.id} status=${p.status} attempts=${p.attempts} seed=${SEED}`;
    const live = fake.liveTransfersFor(p.id);
    expect(live, where).toHaveLength(1);
    expect(p.razorpayTransferId, where).toBe(live[0].id);
    const created = fake.appliedOk(is.createTransfer).filter((x) => x.body?.transfers?.[0]?.notes?.payout_id === p.id);
    expect(created, `${where}: Razorpay was asked to create more than one transfer for one payout`).toHaveLength(1);
    expect(p.status, where).toBe("held");
    const claims = (await statusEdges(p.id)).filter((e) => e.from === "planned" && e.to === "transfer_requested");
    expect(claims, `${where}: the planned payout was claimed more than once`).toHaveLength(1);
    await expectPayoutMatchesRazorpay(fake, p.id, why);
  }
  await expectLegalHistories(await payoutIdsOf(w), why);
}

describe("race 2: two workers on the same planned payout", () => {
  useMoneyHarness(fake);

  it("direct: 4 callers per payout (the kick, two ticks' worth, a Retry-style call) on 6 payouts at once: ONE transfer each", async () => {
    const rng = rngFor("double-execute-direct");
    const w = await plannedWorld(fake, { pages: Array.from({ length: 6 }, () => ({})) });
    withLatency(fake, rng, { beforeMs: [3, 14], afterMs: [0, 8], only: is.createTransfer });
    const ids = await payoutIdsOf(w);

    const out = await together(ids.flatMap((id) => [0, 1, 2, 3].map((k) => ({ run: () => executePlannedPayout(id), delayMs: Math.floor(rng() * 6) * (k % 2) }))));
    for (const o of out) expect(o.ok, `a step threw: ${String((o.error as Error)?.stack ?? o.error)}`).toBe(true);
    // Per payout: exactly one caller got the claim; the rest lost it (or found the lease taken), and none of them called Razorpay.
    const perPayout = ids.map((_, i) => out.slice(i * 4, i * 4 + 4).map((o) => o.value as { outcome: string; calls: number }));
    for (const rs of perPayout) {
      expect(rs.filter((r) => r.calls > 0), `more than one caller talked to Razorpay (seed ${SEED})`).toHaveLength(1);
      for (const r of rs.filter((x) => x.calls === 0)) expect(["lost_claim", "not_planned"]).toContain(r.outcome);
    }
    await expectOneTransferEach(w, "direct");
    expect(countApplied(fake, is.createTransfer)).toBe(6);
  });

  it("LOCK QUEUE: two executors both read `planned` and queue on the payout row; the second one's claim re-checks its WHERE after the first commits, matches nothing and makes no Razorpay call", async () => {
    const w = await plannedWorld(fake, { pages: [{}] });
    const [id] = await payoutIdsOf(w);
    let a!: Awaited<ReturnType<typeof executePlannedPayout>>;
    let b!: Awaited<ReturnType<typeof executePlannedPayout>>;
    await withRowLockQueue(id, async (q) => {
      const first = executePlannedPayout(id);
      await q.blocked(1);
      const second = executePlannedPayout(id);
      await q.blocked(2);
      await q.unlock();
      [a, b] = await Promise.all([first, second]);
    });
    expect(a).toMatchObject({ ok: true, status: "held" });
    expect(b, `seed=${SEED}`).toMatchObject({ ok: false, outcome: "lost_claim", calls: 0 });
    expect(countApplied(fake, is.createTransfer)).toBe(1);
    await expectOneTransferEach(w, "lock queue");
  });

  it("two worker PASSES (selectDuePayouts + runPayoutJob, the shape of a tick) running together over 8 payouts: ONE transfer each", async () => {
    const rng = rngFor("double-execute-passes");
    const w = await plannedWorld(fake, { pages: Array.from({ length: 8 }, () => ({})) });
    withLatency(fake, rng, { beforeMs: [3, 12], afterMs: [0, 6], only: is.createTransfer });
    const out = await together([() => workerPass(), () => workerPass(), { run: () => workerPass(), delayMs: 5 }]);
    for (const o of out) expect(o.ok, String((o.error as Error)?.stack ?? o.error)).toBe(true);
    await expectOneTransferEach(w, "worker passes");
    expect(countApplied(fake, is.createTransfer)).toBe(8);
  });

  it("a LOST create answer (applied, never heard) while a second worker runs: still ONE transfer, adopted by reading Razorpay, never created again", async () => {
    const rng = rngFor("double-execute-lost");
    const w = await plannedWorld(fake, { pages: Array.from({ length: 4 }, () => ({})) });
    withLatency(fake, rng, { beforeMs: [2, 8], afterMs: [0, 5], only: (c) => c.path.startsWith("/v1/payments") });
    // Every first create is applied at Razorpay and its answer is lost.
    fake.intercept({ match: is.createTransfer, mode: "lose", times: 4 });
    const ids = await payoutIdsOf(w);

    // Round 1: the claims and the lost answers, with a second executor racing each one.
    await together(ids.flatMap((id) => [() => executePlannedPayout(id), { run: () => executePlannedPayout(id), delayMs: 4 }]));
    for (const id of ids) expect((await prisma.creatorPayout.findUniqueOrThrow({ where: { id } })).status).toBe("transfer_requested");

    // Round 2: three workers try to resolve each unknown result AT THE SAME TIME (the lease lets one read; nobody creates).
    const later = new Date(Date.now() + 10 * 60_000);
    const out = await together(ids.flatMap((id) => [0, 1, 2].map(() => () => resolveUnknownTransfer(id, { now: later }))));
    for (const o of out) expect(o.ok, String((o.error as Error)?.stack ?? o.error)).toBe(true);
    // A payout whose create was adopted is requested-with-an-id: the hold is confirmed by the next step.
    await together(ids.flatMap((id) => [0, 1].map(() => () => runPayoutJob("confirm_hold", id, { now: later }))));
    await workerPass();

    for (const c of w.creators) {
      const p = await prisma.creatorPayout.findUniqueOrThrow({ where: { bookingItemId: c.id } });
      expect(fake.liveTransfersFor(p.id), `payout ${p.id} status=${p.status} seed=${SEED}`).toHaveLength(1);
      expect(p.razorpayTransferId).toBe(fake.liveTransfersFor(p.id)[0].id);
      expect(["transfer_requested", "held"]).toContain(p.status);
    }
    // Four creates in all: none repeated while a transfer already carried the payout's id.
    expect(countApplied(fake, is.createTransfer)).toBe(4);
    await expectLegalHistories(await payoutIdsOf(w), "lost create answers");
  });
});
