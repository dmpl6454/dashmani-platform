/**
 * RACE 1: a release and a reversal of ONE held payout, started together.
 *
 * Two different things may be done to the same held transfer: LIFT its hold (release: the creator's share leaves our
 * control and settles to their bank) and TAKE IT BACK (reversal: the share returns to our balance, so the brand can be
 * refunded). Doing both is the worst thing the money leg can do: the brand is refunded with money that already went to
 * the creator, out of our own balance. What stops it is the CLAIM each side makes before it asks Razorpay anything:
 *
 *     release:  held → release_requested   (conditional: status = held, not paused, lease free)
 *     reversal: held → reversal_requested  (conditional: status in held|released|settlement_failed, lease free)
 *
 * Both are ONE conditional UPDATE (transition() in payout.service), so Postgres lets exactly one of them change the row and
 * the other finds it moved. The claim has TWO independent conditions, the status and the lease (locked_until): while one claim
 * is in flight the lease alone also turns the other away.
 *
 * WHAT THESE TESTS ASSERT (real interleaving: a 10-connection pool, simulated network time on every Razorpay call):
 *   • the SWEEP starts a release and a reversal of each of 12 payouts, the reversal's start swept from "together" to well
 *     after the release has claimed (laid out in multiples of the MEASURED gate time, so it crosses the claim on any machine).
 *     It samples the interleavings (the operating system schedules them) and prints how many of each kind it saw. Per payout
 *     it asserts the INVARIANTS, not one expected outcome:
 *       - the lift-the-hold PATCH was applied at most once and the reversal at most once;
 *       - never "released AND reversed" from a RACE: the only allowed way to see both is the serial one, where the
 *         release was fully confirmed (`released`) before the reversal claimed (the audit rows prove the order);
 *       - Razorpay and our row agree (a payout we call reversed has a fully reversed transfer, a released one a lifted
 *         hold and nothing reversed, a held one its hold on);
 *       - the audit rows are ONE legal walk (a payout claimed twice from `held` shows up as a branch).
 *   • two LOCK QUEUE tests, the deterministic ones. A claim is "read the status, then UPDATE … WHERE status = what I read", and the
 *     race lives in the microseconds between the two, which random offsets almost never hit. Here ANOTHER connection holds the
 *     payout row, both claimants read `held` and block on their UPDATE, and when the lock is let go Postgres serves them one
 *     after the other, each re-evaluating its WHERE against what the previous one committed. The test chooses who is served
 *     second (the order of arrival is the order of service), once for each side.
 *   • three PLACED tests (the engine's own test hooks, and a hook in the fake): the competitor runs to completion exactly where the
 *     other has checked everything but not yet claimed (or claimed but not yet asked Razorpay). ⚠️ They pin the ORDER semantics
 *     (what a release does when the reversal already finished, and the other way round); they cannot see a non-atomic claim,
 *     because a competitor that has already COMMITTED is turned away by the transaction's own read before the UPDATE runs.
 *
 * MUTATION RESULTS (a scratch copy of apps/api outside the repo, the claims changed one at a time, the suite run against it):
 *   • the release's claim made a blind update      → RED (the sweep, and "LOCK QUEUE, reversal served first");
 *   • the reversal's claim made a blind update     → RED (the sweep, and "LOCK QUEUE, release served first");
 *   • both blind                                   → RED (the sweep and both lock-queue tests);
 *   • the status guard removed from both claims    → GREEN: the lease alone still turns the second claimant away;
 *   • the lease removed from both claims           → GREEN: the status guard alone still does;
 *   • status guard AND lease removed from both     → RED.
 *   The two conditions are independent layers, so removing ONE leaves this race protected: that is the design, not a gap in the test.
 */
import { describe, it, expect, vi } from "vitest";
import { prisma } from "@dashmani/db";

vi.mock("../../src/services/email.service", async (orig) => {
  const actual = await orig<typeof import("../../src/services/email.service")>();
  return { ...actual, sendEmail: vi.fn(async () => ({ messageId: "test" })), notifyAdminByEmail: vi.fn(async () => ({ messageId: "test" })) };
});

import { releasePayout, reversePayout } from "../../src/services/creator/payout.service";
import {
  FakeRazorpay,
  SEED,
  calibrateGate,
  expectLegalHistories,
  expectPayoutMatchesRazorpay,
  heldWorld,
  holdOffOf,
  is,
  makeReleasable,
  payoutOf,
  reversalsOf,
  rngFor,
  statusEdges,
  together,
  useMoneyHarness,
  withLatency,
  withRowLockQueue,
} from "./cc-helpers";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

const fake = new FakeRazorpay();
const STAFF = (id: string) => ({ type: "staff" as const, id });
/** The sweep reaches this many times the (solo) gate time: twelve releases at once stretch each other's gate, so the span is generous. */
const SPAN = 2.5;

describe("race 1: release vs reversal on one held payout", () => {
  const h = useMoneyHarness(fake);

  it("SWEEP: 12 payouts, a release and a reversal each, the reversal's start swept across the release's windows: never both, never a branch, Razorpay and our row agree", async () => {
    const rng = rngFor("release-vs-reversal-sweep");
    const K = 12;
    // Four extra payouts are released first, together, to MEASURE how long the release's gate takes on this machine under this load
    // (local facts, a transfer read, a dispute list, an account read: up to its claim). The sweep is then laid out in multiples of
    // that, so it crosses the release's claim on a fast laptop and on a slow CI runner alike, instead of hard-coding milliseconds.
    const CAL = 4;
    const w = await heldWorld(fake, { pages: Array.from({ length: K + CAL }, () => ({})) });
    for (const c of w.creators) await makeReleasable(w, c.id, h.staff().staffId);
    withLatency(fake, rng, { beforeMs: [2, 7], afterMs: [0, 4], only: (c) => c.path.startsWith("/v1/transfers") || is.listDisputes(c) || is.fetchProduct(c) });
    const gateMs = await calibrateGate((await Promise.all(w.creators.slice(K).map((c) => payoutOf(c.id)))).map((p) => p.id));

    const payouts = await Promise.all(w.creators.slice(0, K).map((c) => payoutOf(c.id)));
    // Pair i: the reversal starts (i / (K-1)) × SPAN × gate after the release (plus 0-2 ms of jitter): from "together" to well after
    // the release has claimed.
    const jobs = payouts.flatMap((p, i) => [
      { run: () => releasePayout(p.id), delayMs: 0 },
      { run: () => reversePayout(p.id, { reason: "withdrawn", actor: STAFF(h.staff().staffId) }), delayMs: Math.round((i / (K - 1)) * SPAN * gateMs) + Math.floor(rng() * 3) },
    ]);
    const out = await together(jobs);
    for (const o of out) expect(o.ok, `a step threw: ${String((o.error as Error)?.stack ?? o.error)} seed=${SEED}`).toBe(true);

    const seen = { reversalWon: 0, releaseWon: 0, releasedThenReversed: 0 };
    for (let i = 0; i < K; i++) {
      const rel = out[2 * i].value as Awaited<ReturnType<typeof releasePayout>>;
      const rev = out[2 * i + 1].value as Awaited<ReturnType<typeof reversePayout>>;
      const p = await prisma.creatorPayout.findUniqueOrThrow({ where: { id: payouts[i].id } });
      const tid = p.razorpayTransferId!;
      const holdOff = holdOffOf(fake, tid);
      const reversals = reversalsOf(fake, tid);
      const where = `payout ${p.id}: release=${rel.outcome}/${rel.status} reversal=${rev.outcome}/${rev.status} final=${p.status} holdOff=${holdOff} reversals=${reversals} seed=${SEED}`;

      // The two money moves, counted at Razorpay (what was really applied, answered or not).
      expect(holdOff, where).toBeLessThanOrEqual(1);
      expect(reversals, where).toBeLessThanOrEqual(1);
      // Never a reversal with no amount (reverse_all), whatever the interleaving.
      for (const c of fake.appliedOk((x) => is.createReversal(x) && x.path.includes(tid))) expect(Number.isInteger(c.body?.amount), where).toBe(true);

      const edges = await statusEdges(p.id);
      const claimsFromHeld = edges.filter((e) => e.from === "held" && (e.to === "release_requested" || e.to === "reversal_requested"));
      if (holdOff === 1 && reversals === 1) {
        // Both money moves happened: the ONLY legitimate way is serial. The release was confirmed before the reversal claimed, so
        // the reversal's claim left `released`, not `held` or `release_requested`.
        seen.releasedThenReversed++;
        expect(edges.some((e) => e.from === "released" && e.to === "reversal_requested"), where).toBe(true);
        expect(claimsFromHeld.filter((e) => e.to === "reversal_requested"), where).toHaveLength(0);
        expect(p.status, where).toBe("reversed");
      } else if (reversals === 1) {
        seen.reversalWon++;
        expect(holdOff, where).toBe(0);
        expect(p.status, where).toBe("reversed");
        expect(rel.ok, where).toBe(false);
        expect(claimsFromHeld.map((e) => e.to), where).toEqual(["reversal_requested"]);
      } else {
        seen.releaseWon++;
        expect(holdOff, where).toBe(1);
        expect(p.status, where).toBe("released");
        expect(rev.ok, where).toBe(false);
        expect(claimsFromHeld.map((e) => e.to), where).toEqual(["release_requested"]);
      }
      await expectPayoutMatchesRazorpay(fake, p.id, "sweep");
    }
    await expectLegalHistories(payouts.map((p) => p.id), "after the sweep");
    // The sweep is only worth something if it saw both sides win. (It also reports the serial case, which is legal.)
    console.log(`[race 1 sweep] gate ${gateMs} ms; reversal won ${seen.reversalWon}, release won ${seen.releaseWon}, serial released-then-reversed ${seen.releasedThenReversed} (seed ${SEED})`);
    expect(seen.reversalWon, "the sweep never let the reversal win: it is not crossing the release's claim").toBeGreaterThan(0);
    expect(seen.releaseWon + seen.releasedThenReversed, "the sweep never let the release win").toBeGreaterThan(0);
  });

  it("PLACED: the reversal runs to completion AFTER the release passed every check and BEFORE it claims: the release loses its claim, asks Razorpay for nothing, and the money stays reversed", async () => {
    const w = await heldWorld(fake, { pages: [{}] });
    const c = w.creators[0];
    await makeReleasable(w, c.id, h.staff().staffId);
    const p = await payoutOf(c.id);

    let reversal: Awaited<ReturnType<typeof reversePayout>> | null = null;
    const rel = await releasePayout(p.id, {
      hooks: {
        // The release has read the transfer (held), the disputes (none) and the account (activated): it is about to claim.
        beforeClaim: async () => {
          reversal = await reversePayout(p.id, { reason: "withdrawn", actor: STAFF(h.staff().staffId) });
        },
      },
    });

    expect(reversal).toMatchObject({ ok: true, status: "reversed" });
    expect(rel).toMatchObject({ ok: false, outcome: "lost_claim" });
    const now = await payoutOf(c.id);
    expect(now.status).toBe("reversed");
    expect(holdOffOf(fake, p.razorpayTransferId!)).toBe(0);
    expect(reversalsOf(fake, p.razorpayTransferId!)).toBe(1);
    const t = fake.transfers.get(p.razorpayTransferId!)!;
    expect(t).toMatchObject({ onHold: true, amountReversed: p.amountPaise });
    await expectLegalHistories([p.id]);
  });

  it("PLACED: the reversal arrives just AFTER the release claimed and BEFORE it asked Razorpay: the reversal is refused (not reversible while a release is in flight), the release completes, nothing is taken back", async () => {
    const w = await heldWorld(fake, { pages: [{}] });
    const c = w.creators[0];
    await makeReleasable(w, c.id, h.staff().staffId);
    const p = await payoutOf(c.id);

    let reversal: Awaited<ReturnType<typeof reversePayout>> | null = null;
    const rel = await releasePayout(p.id, {
      hooks: {
        afterClaim: async () => {
          reversal = await reversePayout(p.id, { reason: "withdrawn", actor: STAFF(h.staff().staffId) });
        },
      },
    });

    expect(rel).toMatchObject({ ok: true, outcome: "released", status: "released" });
    expect(reversal).toMatchObject({ ok: false, outcome: "not_reversible" });
    expect(holdOffOf(fake, p.razorpayTransferId!)).toBe(1);
    expect(reversalsOf(fake, p.razorpayTransferId!)).toBe(0);
    expect(fake.transfers.get(p.razorpayTransferId!)).toMatchObject({ onHold: false, amountReversed: 0 });
    await expectPayoutMatchesRazorpay(fake, p.id);
    await expectLegalHistories([p.id]);
  });

  it("PLACED: a release attempted while the reversal is mid-call at Razorpay (claimed, request in flight) is refused by the local gate and makes no PATCH", async () => {
    const w = await heldWorld(fake, { pages: [{}] });
    const c = w.creators[0];
    await makeReleasable(w, c.id, h.staff().staffId);
    const p = await payoutOf(c.id);

    let release: Awaited<ReturnType<typeof releasePayout>> | null = null;
    fake.intercept({
      match: is.createReversal,
      mode: "pass",
      // The reversal has CLAIMED (reversal_requested) and its request has reached Razorpay's door: a release lands now.
      before: async () => {
        release = await releasePayout(p.id);
      },
    });
    const rev = await reversePayout(p.id, { reason: "withdrawn", actor: STAFF(h.staff().staffId) });

    expect(rev).toMatchObject({ ok: true, status: "reversed" });
    expect(release).toMatchObject({ ok: false, outcome: "refused" });
    expect(holdOffOf(fake, p.razorpayTransferId!)).toBe(0);
    expect(reversalsOf(fake, p.razorpayTransferId!)).toBe(1);
    expect(fake.transfers.get(p.razorpayTransferId!)).toMatchObject({ onHold: true, amountReversed: p.amountPaise });
    await expectLegalHistories([p.id]);
  });

  it("LOCK QUEUE, reversal served first: both claims read `held` and queue on the payout row; the release's UPDATE is served second, re-checks its WHERE and matches nothing", async () => {
    const w = await heldWorld(fake, { pages: [{}] });
    const c = w.creators[0];
    await makeReleasable(w, c.id, h.staff().staffId);
    const p = await payoutOf(c.id);
    let rev!: Awaited<ReturnType<typeof reversePayout>>;
    let rel!: Awaited<ReturnType<typeof releasePayout>>;
    await withRowLockQueue(p.id, async (q) => {
      const revP = reversePayout(p.id, { reason: "withdrawn", actor: STAFF(h.staff().staffId) });
      await q.blocked(1);
      const relP = releasePayout(p.id); // gets through its whole gate, then queues behind the reversal at its claim
      await q.blocked(2);
      await q.unlock();
      [rev, rel] = await Promise.all([revP, relP]);
    });
    expect(rev).toMatchObject({ ok: true, status: "reversed" });
    expect(rel).toMatchObject({ ok: false, outcome: "lost_claim" });
    expect(holdOffOf(fake, p.razorpayTransferId!), `seed=${SEED}`).toBe(0);
    expect(reversalsOf(fake, p.razorpayTransferId!)).toBe(1);
    expect(fake.transfers.get(p.razorpayTransferId!)).toMatchObject({ onHold: true, amountReversed: p.amountPaise });
    expect((await statusEdges(p.id)).filter((e) => e.from === "held")).toHaveLength(1);
    await expectLegalHistories([p.id]);
  });

  it("LOCK QUEUE, release served first: the reversal's UPDATE is served second, re-checks its WHERE and matches nothing; the release completes and nothing is taken back", async () => {
    const w = await heldWorld(fake, { pages: [{}] });
    const c = w.creators[0];
    await makeReleasable(w, c.id, h.staff().staffId);
    const p = await payoutOf(c.id);
    let rev!: Awaited<ReturnType<typeof reversePayout>>;
    let rel!: Awaited<ReturnType<typeof releasePayout>>;
    await withRowLockQueue(p.id, async (q) => {
      const relP = releasePayout(p.id);
      await q.blocked(1);
      const revP = reversePayout(p.id, { reason: "withdrawn", actor: STAFF(h.staff().staffId) });
      await q.blocked(2);
      await q.unlock();
      [rel, rev] = await Promise.all([relP, revP]);
    });
    expect(rel).toMatchObject({ ok: true, outcome: "released", status: "released" });
    expect(rev).toMatchObject({ ok: false, outcome: "lost_claim" });
    expect(holdOffOf(fake, p.razorpayTransferId!), `seed=${SEED}`).toBe(1);
    expect(reversalsOf(fake, p.razorpayTransferId!)).toBe(0);
    expect(fake.transfers.get(p.razorpayTransferId!)).toMatchObject({ onHold: false, amountReversed: 0 });
    expect((await statusEdges(p.id)).filter((e) => e.from === "held")).toHaveLength(1);
    await expectPayoutMatchesRazorpay(fake, p.id);
    await expectLegalHistories([p.id]);
  });

  it("a lost answer: the release's PATCH was applied but its answer is lost (release_requested) and a reversal arrives meanwhile: the payout is never both, and a reversal is refused while the release is unresolved", async () => {
    const w = await heldWorld(fake, { pages: [{}] });
    const c = w.creators[0];
    await makeReleasable(w, c.id, h.staff().staffId);
    const p = await payoutOf(c.id);
    fake.intercept({ match: (x) => is.setHold(x, false), mode: "lose", times: 1 });

    const [rel, rev] = (await together([() => releasePayout(p.id), { run: () => reversePayout(p.id, { reason: "withdrawn", actor: STAFF(h.staff().staffId) }), delayMs: 60 }])).map((o) => o.value as { ok: boolean; outcome: string; status: string | null });
    // Whichever way the two interleaved, the payout is NOT both: either the reversal got in first (and the release lost), or the
    // release claimed first and the lost answer left it release_requested, where a reversal is refused.
    const mid = await payoutOf(c.id);
    expect(["reversed", "release_requested"], `release=${rel.outcome} reversal=${rev.outcome} seed=${SEED}`).toContain(mid.status);
    if (mid.status === "release_requested") {
      expect(rev.ok).toBe(false);
      // A reversal that arrives later, while the release is still unresolved, is refused too.
      const again = await reversePayout(p.id, { reason: "withdrawn", actor: STAFF(h.staff().staffId) });
      expect(again.ok).toBe(false);
      expect(reversalsOf(fake, p.razorpayTransferId!)).toBe(0);
    }
    await expectPayoutMatchesRazorpay(fake, p.id);
    await expectLegalHistories([p.id]);
  });
});
