/**
 * RACE 6: duplicate Razorpay webhook deliveries arriving while the reconciliation worker polls the same payout.
 *
 * Razorpay redelivers a webhook on any non-2xx and may deliver the same event twice at once; the worker reads the same
 * facts from Razorpay on its own clock. For ONE fact (a transfer became processed; a settlement was paid) there are therefore
 * several writers: N deliveries of the event and M polls. The rule is that the fact lands ONCE: the payout moves exactly one
 * step, one audit row says so, nothing is written twice and nothing moves backwards, whoever is first and however they
 * interleave. What makes that so: every move is ONE conditional UPDATE whose WHERE names the statuses the move is legal from
 * (payout-states.ts), and the webhook endpoint stamps each event id once (razorpay_webhook_events.event_id is UNIQUE, and a
 * delivery that finds an unprocessed row of the same id re-processes it, which is safe for the same reason).
 *
 * Asserted at the end of each test: every delivery was answered 200 (a non-2xx makes Razorpay retry for 24 h and then
 * disable the webhook, which also marks brand payments paid); the payout is in the ONE expected state with its bank
 * reference, time and settlement id; exactly ONE status-changing audit row exists for the move; the audit rows form one legal
 * walk; and the event table has one row per distinct event id, all processed.
 */
import { describe, it, expect, vi } from "vitest";
import { prisma } from "@dashmani/db";

vi.mock("../../src/services/email.service", async (orig) => {
  const actual = await orig<typeof import("../../src/services/email.service")>();
  return { ...actual, sendEmail: vi.fn(async () => ({ messageId: "test" })), notifyAdminByEmail: vi.fn(async () => ({ messageId: "test" })) };
});

import { confirmHold, pollSettlement, releasePayout, runPayoutJob } from "../../src/services/creator/payout.service";
import {
  FakeRazorpay,
  SEED,
  capture,
  expectLegalHistories,
  expectPayoutMatchesRazorpay,
  heldWorld,
  makeReleasable,
  mkWorld,
  payoutOf,
  rngFor,
  statusEdges,
  together,
  useMoneyHarness,
  withLatency,
  is,
  deliver,
} from "./cc-helpers";
import { randomUUID } from "node:crypto";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

const fake = new FakeRazorpay();
const nowSec = () => Math.floor(Date.now() / 1000);

function settlementPayload(s: { id: string; utr: string | null; amount: number }) {
  return { settlement: { entity: { id: s.id, entity: "settlement", amount: s.amount, status: "processed", fees: 0, tax: 0, utr: s.utr, created_at: nowSec() - 60 } } };
}

function transferProcessedPayload(t: { id: string; source: string; recipient: string; amount: number; notes: Record<string, string> }) {
  return {
    transfer: {
      entity: {
        id: t.id,
        entity: "transfer",
        status: "processed",
        source: t.source,
        recipient: t.recipient,
        amount: t.amount,
        currency: "INR",
        amount_reversed: 0,
        notes: t.notes,
        fees: 1,
        tax: 0,
        on_hold: true,
        on_hold_until: null,
        settlement_status: "on_hold",
        recipient_settlement_id: null,
        created_at: nowSec() - 120,
        processed_at: nowSec() - 100,
      },
    },
  };
}

describe("race 6: duplicate webhooks vs the worker's poll", () => {
  const h = useMoneyHarness(fake);

  it("settlement.processed delivered 6 times (4 event ids, one of them twice, one thrice) while 3 polls run: settled ONCE, with the UTR, one audit row", async () => {
    const rng = rngFor("webhook-settlement");
    const w = await heldWorld(fake, { pages: [{}] });
    const c = w.creators[0];
    await makeReleasable(w, c.id, h.staff().staffId);
    const p0 = await payoutOf(c.id);
    expect(await releasePayout(p0.id)).toMatchObject({ ok: true, status: "released" });
    const tid = p0.razorpayTransferId!;

    // The settlement exists but is not paid yet: one poll links its id to the payout (the webhook links ONLY by that id).
    const st = fake.settleTransfer(tid, { status: "created" });
    expect(await pollSettlement(p0.id)).toMatchObject({ status: "released" });
    expect((await payoutOf(c.id)).recipientSettlementId).toBe(st.id);
    // Now it is paid, and everything learns about it at once.
    fake.settlements.get(st.id)!.status = "processed";
    withLatency(fake, rng, { beforeMs: [1, 9], afterMs: [0, 4], only: is.fetchTransfer });

    const sameId = `evt_dup_${randomUUID()}`;
    const thrice = `evt_trip_${randomUUID()}`;
    const eventIds = [sameId, sameId, thrice, thrice, thrice, `evt_${randomUUID()}`, `evt_${randomUUID()}`];
    const body = settlementPayload({ id: st.id, utr: st.utr, amount: st.amount });
    const jobs = [
      // The deliveries are spread over a wider span than the polls, so the poll is sometimes first and sometimes last.
      ...eventIds.map((eid) => ({ run: () => deliver("settlement.processed", body, eid), delayMs: Math.floor(rng() * 60) })),
      { run: () => pollSettlement(p0.id), delayMs: Math.floor(rng() * 25) },
      { run: () => pollSettlement(p0.id), delayMs: Math.floor(rng() * 25) },
      { run: () => runPayoutJob("poll_settlement", p0.id), delayMs: Math.floor(rng() * 25) },
    ];
    const out = await together(jobs);
    for (const o of out) expect(o.ok, String((o.error as Error)?.stack ?? o.error)).toBe(true);
    for (const o of out.slice(0, 7)) {
      const r = o.value as { status: number; body: { success: boolean } };
      expect([r.status, r.body.success], `a webhook delivery was not answered 2xx (seed ${SEED})`).toEqual([200, true]);
    }

    const p = await payoutOf(c.id);
    expect(p, `seed=${SEED}`).toMatchObject({ status: "settled", settlementUtr: st.utr, recipientSettlementStatus: "processed", recipientSettlementId: st.id });
    expect(p.settledAt).not.toBeNull();
    const edges = await statusEdges(p.id);
    expect(edges.filter((e) => e.to === "settled"), `the payout was settled more than once: ${JSON.stringify(edges)}`).toHaveLength(1);
    expect(edges.filter((e) => e.from === "released"), JSON.stringify(edges)).toHaveLength(1);
    // The audit row of the move, whichever side won it, says what the money did (never a second one).
    const rows = await prisma.creatorPayoutEvent.findMany({ where: { payoutId: p.id, toStatus: "settled" } });
    expect(rows).toHaveLength(1);
    console.log(`[race 6] the settlement was recorded by: ${rows[0].actorType} (seed ${SEED})`);
    // The event table: one row per DISTINCT event id, every one stamped processed.
    const eventRows = await prisma.razorpayWebhookEvent.findMany({ where: { event: "settlement.processed" } });
    expect(eventRows.map((e) => e.eventId).sort()).toEqual([...new Set(eventIds)].sort());
    expect(eventRows.length).toBe(4);
    expect(eventRows.every((e) => e.processedAt !== null)).toBe(true);
    await expectPayoutMatchesRazorpay(fake, p.id);
    await expectLegalHistories([p.id]);
  });

  it("webhooks ALONE (no poll anywhere): 6 concurrent deliveries of settlement.processed settle the payout ONCE, recorded as Razorpay's own event", async () => {
    const rng = rngFor("webhook-alone");
    const w = await heldWorld(fake, { pages: [{}] });
    const c = w.creators[0];
    await makeReleasable(w, c.id, h.staff().staffId);
    const p0 = await payoutOf(c.id);
    expect(await releasePayout(p0.id)).toMatchObject({ ok: true, status: "released" });
    const st = fake.settleTransfer(p0.razorpayTransferId!, { status: "created" });
    expect(await pollSettlement(p0.id)).toMatchObject({ status: "released" }); // links the id, nothing else
    fake.settlements.get(st.id)!.status = "processed";
    const body = settlementPayload({ id: st.id, utr: st.utr, amount: st.amount });
    const out = await together([0, 1, 2, 3, 4, 5].map(() => ({ run: () => deliver("settlement.processed", body, `evt_alone_${randomUUID()}`), delayMs: Math.floor(rng() * 6) })));
    for (const o of out) expect([o.ok, (o.value as { status: number }).status], String((o.error as Error)?.stack ?? "")).toEqual([true, 200]);
    const p = await payoutOf(c.id);
    expect(p, `seed=${SEED}`).toMatchObject({ status: "settled", settlementUtr: st.utr });
    const rows = await prisma.creatorPayoutEvent.findMany({ where: { payoutId: p.id, toStatus: "settled" } });
    expect(rows.map((r) => r.actorType), `seed=${SEED}`).toEqual(["razorpay"]);
    await expectLegalHistories([p.id]);
  });

  it("two payouts in ONE bank settlement: one settlement.processed delivered three times while each payout is polled: both settle ONCE, each with its own audit row", async () => {
    const rng = rngFor("webhook-batch");
    const w = await heldWorld(fake, { pages: [{}, {}] });
    for (const c of w.creators) await makeReleasable(w, c.id, h.staff().staffId);
    const ps = await Promise.all(w.creators.map((c) => payoutOf(c.id)));
    for (const p of ps) expect(await releasePayout(p.id)).toMatchObject({ ok: true, status: "released" });
    const tids = ps.map((p) => p.razorpayTransferId!);
    // One settlement carries both transfers (its amount is the BATCH amount, as in Razorpay's own sample).
    const st = fake.settleTransfer(tids[0], { status: "created", batchExtra: ps[1].amountPaise });
    fake.transfers.get(tids[1])!.settlementId = st.id;
    for (const p of ps) expect(await pollSettlement(p.id)).toMatchObject({ status: "released" });
    fake.settlements.get(st.id)!.status = "processed";

    const body = settlementPayload({ id: st.id, utr: st.utr, amount: st.amount });
    const out = await together([
      ...[0, 1, 2].map((k) => ({ run: () => deliver("settlement.processed", body, `evt_batch_${randomUUID()}`), delayMs: k * 3 + Math.floor(rng() * 5) })),
      ...ps.flatMap((p) => [{ run: () => pollSettlement(p.id), delayMs: Math.floor(rng() * 10) }, { run: () => pollSettlement(p.id), delayMs: Math.floor(rng() * 10) }]),
    ]);
    for (const o of out) expect(o.ok, String((o.error as Error)?.stack ?? o.error)).toBe(true);
    for (const p of ps) {
      const now = await prisma.creatorPayout.findUniqueOrThrow({ where: { id: p.id } });
      expect(now, `seed=${SEED}`).toMatchObject({ status: "settled", settlementUtr: st.utr, recipientSettlementId: st.id });
      // The batch amount is information about the BANK settlement, never this creator's share.
      expect(now.amountPaise).toBe(p.amountPaise);
      expect((await statusEdges(p.id)).filter((e) => e.to === "settled")).toHaveLength(1);
    }
    await expectLegalHistories(ps.map((p) => p.id));
  });

  it("transfer.processed delivered 5 times while 3 hold-confirmations run on a transfer still pending at Razorpay: held ONCE", async () => {
    const rng = rngFor("webhook-transfer");
    fake.createStatus = "pending"; // the kick leaves the payout transfer_requested, with its transfer id recorded
    const w = await mkWorld(fake, { pages: [{}, {}, {}] });
    expect((await capture(fake, w)).status).toBe(200);
    const ps = await Promise.all(w.creators.map((c) => payoutOf(c.id)));
    for (const p of ps) expect(p).toMatchObject({ status: "transfer_requested" });
    // Razorpay finishes the transfers; the event and the worker both find out.
    for (const p of ps) fake.processTransfer(p.razorpayTransferId!);
    withLatency(fake, rng, { beforeMs: [1, 8], afterMs: [0, 3], only: is.fetchTransfer });

    const jobs = ps.flatMap((p) => {
      const t = fake.transfers.get(p.razorpayTransferId!)!;
      const payload = transferProcessedPayload({ id: t.id, source: t.source, recipient: t.recipient, amount: t.amount, notes: t.notes });
      const dupId = `evt_tp_${randomUUID()}`;
      return [
        ...[dupId, dupId, `evt_${randomUUID()}`, `evt_${randomUUID()}`, `evt_${randomUUID()}`].map((eid) => ({ run: () => deliver("transfer.processed", payload, eid), delayMs: Math.floor(rng() * 50) })),
        { run: () => confirmHold(p.id), delayMs: Math.floor(rng() * 20) },
        { run: () => confirmHold(p.id), delayMs: Math.floor(rng() * 20) },
        { run: () => runPayoutJob("confirm_hold", p.id), delayMs: Math.floor(rng() * 20) },
      ];
    });
    const out = await together(jobs);
    for (const o of out) expect(o.ok, String((o.error as Error)?.stack ?? o.error)).toBe(true);
    for (const [i, o] of out.entries()) {
      if (i % 8 < 5) expect((o.value as { status: number }).status, `delivery ${i} (seed ${SEED})`).toBe(200);
    }
    for (const p of ps) {
      const now = await prisma.creatorPayout.findUniqueOrThrow({ where: { id: p.id } });
      expect(now, `seed=${SEED}`).toMatchObject({ status: "held" });
      expect(now.heldAt).not.toBeNull();
      const edges = await statusEdges(p.id);
      const who = (await prisma.creatorPayoutEvent.findMany({ where: { payoutId: p.id, toStatus: "held" } })).map((e) => e.actorType);
      console.log(`[race 6] held was recorded by: ${who.join(",")} (seed ${SEED})`);
      expect(edges.filter((e) => e.from === "transfer_requested" && e.to === "held"), JSON.stringify(edges)).toHaveLength(1);
      await expectPayoutMatchesRazorpay(fake, p.id);
    }
    await expectLegalHistories(ps.map((p) => p.id));
  });
});
