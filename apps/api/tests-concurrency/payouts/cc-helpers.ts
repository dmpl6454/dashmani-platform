/**
 * Shared harness for the PAYOUT concurrency suite (not a test file).
 *
 *   cd apps/api && DATABASE_URL="postgresql://user:password@localhost:5432/dashmani_payout_cc?connection_limit=10" \
 *     npx vitest run -c vitest.concurrency.config.ts tests-concurrency/payouts
 *
 * ⚠️ WHY THIS SUITE EXISTS. The main suite runs with connection_limit=1, so every database call of every test is
 * serialised on ONE connection: it can prove that a claim is written, never that two claims racing for the same row
 * produce exactly one winner. Here the pool is 10, the callers are real concurrent async functions inside one process
 * (the same shape as several API requests plus the worker's tick), and every Razorpay call goes to the STATEFUL fake
 * (tests/fake-razorpay-route.ts) with simulated network time, so the windows between "we read", "we claimed", "we asked
 * Razorpay" and "Razorpay answered" are wide enough for another caller to land inside them.
 *
 * What the tests assert is never "a call was made", always an INVARIANT of the money: how many times Razorpay was
 * really asked (fake.applied), what state Razorpay ended in (fake.transfers / payments), what our rows say, and that
 * the two agree. Where a test only samples the interleavings (random start offsets) the comments say so; where it
 * places a competitor at an exact point (the engine's own `hooks.beforeClaim` / `afterClaim`) they say that instead.
 *
 * ⚠️ WHAT "PROVEN" MEANS HERE. Each headline race was also run against a scratch copy of the code with its protecting
 * claim or lock removed (a scratch copy of apps/api outside the repo, with the one claim changed to a blind update, or the
 * advisory lock skipped), and the test failed. A test that passes on correct code and also on the broken code proves nothing;
 * the results, including the mutants that SURVIVED because a second layer still protects, are written down per test file.
 *
 * ⚠️ SEEDS. Every random choice comes from a seeded generator (CC_SEED, default below). A failure prints the seed;
 * the same seed replays the same START OFFSETS and the same chosen operations. Real scheduling is still the
 * operating system's, so a replay is a strong hint, not a guarantee.
 */
import { expect, vi, beforeEach, afterEach } from "vitest";
import { prisma, PrismaClient } from "@dashmani/db";
import { settlePayoutKicksForTests } from "../../src/services/campaign/payment.service";
import { settleCreatorRefundsForTests } from "../../src/services/creator/creator-refund.service";
import { flushPayoutAlertsForTests, resetPayoutAlertsForTests } from "../../src/services/creator/payout-alert";
import { onCreatorLinkVerified } from "../../src/services/creator/payout-ledger";
import { releasePayout, reservedPaiseForPayment } from "../../src/services/creator/payout.service";
import { canMove } from "../../src/services/creator/payout-states";
import { resetCreatorPayoutsCronForTests } from "../../src/cron/creator-payouts.cron";
import { FakeRazorpay, is, type FakeCall } from "../../tests/fake-razorpay-route";
import { capture, mkStaff, mkWorld, nameOf, payoutOf, sendWebhook, stubPayoutEnv, verifiedOffer, type StaffWorld, type World } from "../../tests/payout-fixtures";
import { notifyAdminByEmail } from "../../src/services/email.service";

export { FakeRazorpay, is, capture, mkStaff, mkWorld, payoutOf, stubPayoutEnv, verifiedOffer, nameOf };
export type { World, FakeCall, StaffWorld };

/** Deliver an HMAC-signed webhook through the real route under an event id of our choosing (any string: re-deliveries reuse one). */
export const deliver = (event: string, payload: Record<string, unknown>, eventId: string) => sendWebhook(event, payload, eventId as `${string}-${string}-${string}-${string}-${string}`);

// ── Seeds and time ──────────────────────────────────────────────────────────────

export const SEED = Number.isFinite(Number(process.env.CC_SEED)) && process.env.CC_SEED ? Number(process.env.CC_SEED) : 20261018;

/** mulberry32: a tiny seeded generator (the same sequence for the same seed on every machine). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A generator whose sequence depends on the suite seed AND a name, so two tests never share one stream. */
export function rngFor(name: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  return mulberry32((h ^ SEED) >>> 0);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

// ── Starting callers together ───────────────────────────────────────────────────

export interface Settled<T> {
  ok: boolean;
  value?: T;
  error?: unknown;
}

export interface Job<T = unknown> {
  run: () => Promise<T>;
  /** Start this long after the barrier opens (ms). Used to sweep one competitor across the other's windows. */
  delayMs?: number;
}

/**
 * Start every job behind ONE barrier, so the callers begin on the same tick (plus each job's own offset), and wait for
 * all of them. Never rejects: a throw becomes `{ ok: false, error }`, because for a race the interesting answer is
 * "what did each side get", including a clean 409 as an Error.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function together(jobs: Array<Job<any> | (() => Promise<any>)>): Promise<Array<Settled<any>>> {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const started = jobs.map(async (j): Promise<Settled<any>> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const job: Job<any> = typeof j === "function" ? { run: j } : j;
    await gate;
    if (job.delayMs && job.delayMs > 0) await sleep(job.delayMs);
    try {
      return { ok: true, value: await job.run() };
    } catch (error) {
      return { ok: false, error };
    }
  });
  await sleep(0); // let every async function reach the barrier
  open();
  return Promise.all(started);
}

export const codeOf = (e: unknown): string => String((e as { code?: string })?.code ?? (e as { message?: string })?.message ?? e);
export const statusOfErr = (e: unknown): number | null => ((e as { statusCode?: number; status?: number })?.statusCode ?? (e as { status?: number })?.status ?? null);

// ── The per-test environment ────────────────────────────────────────────────────

/**
 * Register the hooks every payout race needs (INSIDE a describe: tests/setup.ts TRUNCATEs in a root beforeEach and the
 * seeding must come after it). Returns an accessor for the staff user. The caller's file must have
 * `vi.mock("../../src/services/email.service", …)` at its top: vi.mock is hoisted per FILE.
 */
export function useMoneyHarness(fake: FakeRazorpay, extraEnv: Record<string, string> = {}): { staff: () => StaffWorld } {
  let staff!: StaffWorld;
  beforeEach(async () => {
    // system_settings is not truncated between tests: the release switch must start every test absent (= on).
    await prisma.systemSetting.deleteMany({ where: { key: "creatorPayouts.release" } });
    stubPayoutEnv(extraEnv);
    fake.reset();
    fake.install();
    resetPayoutAlertsForTests();
    resetCreatorPayoutsCronForTests();
    vi.mocked(notifyAdminByEmail).mockClear();
    staff = await mkStaff();
  });
  afterEach(async () => {
    // Fire-and-forget work of the last test (kicks, background refunds, alert stamps) must not reach into the next one.
    await settlePayoutKicksForTests();
    await settleCreatorRefundsForTests();
    await flushPayoutAlertsForTests();
    await prisma.systemSetting.deleteMany({ where: { key: "creatorPayouts.release" } });
    fake.restore();
    vi.unstubAllEnvs();
  });
  return { staff: () => staff };
}

/**
 * Network time for the fake: every call is "in flight" for `beforeMs` before Razorpay applies it and its answer takes
 * `afterMs` to come back. Randomised (seeded) so two runs of the same call differ and the windows move around.
 */
export function withLatency(fake: FakeRazorpay, rng: () => number, o: { beforeMs?: [number, number]; afterMs?: [number, number]; only?: (c: FakeCall) => boolean } = {}): void {
  const span = (r: [number, number] | undefined) => (r ? Math.round(r[0] + rng() * (r[1] - r[0])) : 0);
  fake.latency = (c) => (o.only && !o.only(c) ? null : { before: span(o.beforeMs ?? [1, 6]), after: span(o.afterMs ?? [0, 4]) });
}

// ── Building worlds ─────────────────────────────────────────────────────────────

/** A captured booking whose creator payouts the real kick has made HELD (asserted). */
export async function heldWorld(fake: FakeRazorpay, spec: Parameters<typeof mkWorld>[1]): Promise<World> {
  const w = await mkWorld(fake, spec);
  expect((await capture(fake, w)).status).toBe(200);
  for (const c of w.creators) expect((await payoutOf(c.id)).status, `payout of ${c.id} after capture`).toBe("held");
  return w;
}

/** A captured booking whose payouts stay `planned` (the kick is off while it is captured; nothing is made at Razorpay). */
export async function plannedWorld(fake: FakeRazorpay, spec: Parameters<typeof mkWorld>[1]): Promise<World> {
  vi.stubEnv("CREATOR_PAYOUT_CRON_ENABLED", "0");
  try {
    const w = await mkWorld(fake, spec);
    expect((await capture(fake, w)).status).toBe(200);
    for (const c of w.creators) expect((await payoutOf(c.id)).status, `payout of ${c.id} after capture`).toBe("planned");
    return w;
  } finally {
    vi.stubEnv("CREATOR_PAYOUT_CRON_ENABLED", "");
  }
}

/** The verified post and the scheduled release of one creator item (the release gate's offer, item and booking facts). */
export async function makeReleasable(w: World, itemId: string, staffId: string): Promise<void> {
  await verifiedOffer(w, itemId);
  await onCreatorLinkVerified(itemId, { type: "staff", id: staffId });
}

/**
 * How long a release takes to reach its claim (local facts, a transfer read, a dispute list, an account read) on THIS machine,
 * UNDER THE LOAD of several releases at once: the longest gate among `payoutIds`, all released together (they are released for
 * real; use payouts the test does not look at again). The sweeps lay their start offsets out in multiples of it, so they cross the
 * claim on a fast laptop and on a slow, busy CI runner alike instead of hard-coding milliseconds.
 */
export async function calibrateGate(payoutIds: string[]): Promise<number> {
  const t0 = Date.now();
  const gates: number[] = [];
  await together(payoutIds.map((id) => () => releasePayout(id, { hooks: { beforeClaim: async () => void gates.push(Date.now() - t0) } })));
  const gate = Math.max(0, ...gates);
  expect(gate, "the calibration releases never reached their claim").toBeGreaterThan(0);
  return gate;
}

// ── Queueing claimants on the row lock (a deterministic window inside Postgres) ──

export async function waitUntil(cond: () => Promise<boolean>, what: string, ms = 10_000, stepMs = 25): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await sleep(stepMs);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** How many backends are right now waiting for a row lock inside an UPDATE of creator_payouts (a claim waiting its turn). */
export async function claimsWaitingOnRow(): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%UPDATE%creator_payouts%'`;
  return rows[0].n;
}

export interface RowLockQueue {
  /** Resolves once exactly `n` claims are waiting on the payout row. */
  blocked(n: number): Promise<void>;
  /** Let the lock go: the waiting claims proceed one after another, each re-checking its WHERE against what the one before committed. */
  unlock(): Promise<void>;
}

/**
 * Hold a row lock on one payout from ANOTHER connection, run `body` (which starts claimants and waits until they are queued
 * on that lock), and release it in `body` via `unlock()`.
 *
 * ⚠️ WHY THIS IS THE RIGHT WAY TO TEST A CLAIM. A claim is "read the status, then UPDATE … WHERE status = what I read". The race
 * lives in the gap between the read and the UPDATE: two claimants can both read `held`. That gap is microseconds wide, so random
 * start offsets almost never land in it. Here both claimants READ (no lock needed for a plain read, they see `held`), then BLOCK
 * on the UPDATE because this connection holds the row; when it lets go, Postgres runs the queued UPDATEs one after the other and
 * re-evaluates each one's WHERE against the row the previous one committed. If the WHERE is a real condition the second matches
 * nothing; if it is not, both claims succeed. The order the claimants are queued in is the order they are served in, so a test
 * can say which one is second.
 */
export async function withRowLockQueue(payoutId: string, body: (q: RowLockQueue) => Promise<void>): Promise<void> {
  // Anything from earlier in the test that would also queue on a payout row (an alert stamp, a lease drop) must be finished, or it
  // would be counted among the claims waiting.
  await settlePayoutKicksForTests();
  await settleCreatorRefundsForTests();
  await flushPayoutAlertsForTests();
  const second = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL!.replace(/connection_limit=\d+/, "connection_limit=2") } } });
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  let locked!: () => void;
  const lockedP = new Promise<void>((r) => (locked = r));
  const holder = second.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM creator_payouts WHERE id = ${payoutId} FOR UPDATE`;
      locked();
      await gate;
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
  try {
    await Promise.race([lockedP, holder]);
    await body({
      blocked: (n) => waitUntil(async () => (await claimsWaitingOnRow()) === n, `${n} claim(s) waiting on the payout row`),
      unlock: async () => {
        open();
        await holder;
      },
    });
  } finally {
    open();
    await holder.catch(() => undefined);
    await second.$disconnect();
  }
}

// ── Reading what happened ───────────────────────────────────────────────────────

export const callNames = (calls: FakeCall[]): string[] => calls.map(nameOf);
export const countApplied = (fake: FakeRazorpay, pred: (c: FakeCall) => boolean) => fake.appliedOk(pred).length;
export const forTransfer = (id: string) => (c: FakeCall) => c.path.startsWith(`/v1/transfers/${id}`);
/** Applied "lift the hold" PATCHes (on_hold:false) on one transfer. */
export const holdOffOf = (fake: FakeRazorpay, transferId: string) => countApplied(fake, (c) => is.setHold(c, false) && forTransfer(transferId)(c));
export const reversalsOf = (fake: FakeRazorpay, transferId: string) => countApplied(fake, (c) => is.createReversal(c) && forTransfer(transferId)(c));

export interface EdgeEvent {
  from: string;
  to: string;
  kind: string;
}

/** The status-changing audit rows of one payout (the rest, checks and pauses, keep from = to and are left out). */
export async function statusEdges(payoutId: string): Promise<EdgeEvent[]> {
  const rows = await prisma.creatorPayoutEvent.findMany({ where: { payoutId }, orderBy: { createdAt: "asc" }, select: { fromStatus: true, toStatus: true, kind: true } });
  return rows.filter((r) => r.fromStatus && r.toStatus && r.fromStatus !== r.toStatus).map((r) => ({ from: r.fromStatus!, to: r.toStatus!, kind: r.kind }));
}

/**
 * Is there ONE legal history behind these audit rows? The edges are a multiset (two events of one millisecond have no
 * reliable order), so this looks for an ordering that walks `start` to `final` using every edge exactly once, each one a
 * legal move of payout-states. A payout whose status was claimed TWICE from the same state (held → release_requested AND
 * held → reversal_requested, with nothing returning to held in between) has no such walk: the rows describe a branch, i.e.
 * two callers each believed they owned the payout. Returns null when a walk exists, else a sentence.
 */
export function historyProblem(edges: EdgeEvent[], start: string, final: string): string | null {
  for (const e of edges) if (!canMove(e.from as never, e.to as never)) return `illegal move ${e.from} -> ${e.to}`;
  if (edges.length === 0) return start === final ? null : `no events but status moved ${start} -> ${final}`;
  const used = new Array(edges.length).fill(false);
  const walk = (at: string, left: number): boolean => {
    if (left === 0) return at === final;
    for (let i = 0; i < edges.length; i++) {
      if (used[i] || edges[i].from !== at) continue;
      used[i] = true;
      if (walk(edges[i].to, left - 1)) return true;
      used[i] = false;
    }
    return false;
  };
  return walk(start, edges.length) ? null : `the audit rows (${edges.map((e) => `${e.from}>${e.to}`).join(", ")}) are not one walk from ${start} to ${final}`;
}

/** Every payout of the given ids: its audit rows form one legal walk planned -> status. */
export async function expectLegalHistories(payoutIds: string[], why = ""): Promise<void> {
  for (const id of payoutIds) {
    const p = await prisma.creatorPayout.findUniqueOrThrow({ where: { id } });
    const problem = historyProblem(await statusEdges(id), "planned", p.status);
    expect(problem, `payout ${id} (${p.status}) ${why} seed=${SEED}`).toBeNull();
  }
}

/**
 * What the fake (Razorpay) and our rows must agree on, per payout, once nothing is in flight. Only claims that hold in
 * EVERY quiescent state are made: a payout we call reversed has a fully reversed transfer; one we call released or
 * settled has its hold lifted and nothing taken back; one we call held has its hold on and nothing taken back.
 */
export async function expectPayoutMatchesRazorpay(fake: FakeRazorpay, payoutId: string, why = ""): Promise<void> {
  const p = await prisma.creatorPayout.findUniqueOrThrow({ where: { id: payoutId } });
  if (!p.razorpayTransferId) return;
  const t = fake.transfers.get(p.razorpayTransferId);
  expect(t, `${why} payout ${p.id} names a transfer the fake does not have`).toBeDefined();
  const where = `${why} payout ${p.id} status=${p.status} transfer(onHold=${t!.onHold}, reversed=${t!.amountReversed}/${t!.amount}) seed=${SEED}`;
  if (p.status === "reversed") expect(t!.amountReversed, where).toBe(t!.amount);
  if (p.status === "released" || p.status === "settled") {
    expect(t!.onHold, where).toBe(false);
    expect(t!.amountReversed, where).toBe(0);
  }
  if (p.status === "held") {
    expect(t!.onHold, where).toBe(true);
    expect(t!.amountReversed, where).toBe(0);
  }
}

export interface PaymentBooks {
  paymentId: string;
  captured: number;
  /** What Razorpay really refunded (not failed). */
  refundedAtRazorpay: number;
  /** What is still at creators: transfer amount minus what was taken back, summed over live transfers. */
  transferredNet: number;
  /** Our own claim on the refundable amount: refundedPaise on the payment row. */
  refundedLedger: number;
  /** The raw (UNclamped) refundable amount: captured − refunded − reserved. Negative means the books are broken. */
  rawRefundable: number;
}

/** The conservation law of ONE payment: money out of it (refunds + live transfers) never exceeds what it captured. */
export async function booksOf(fake: FakeRazorpay, razorpayPaymentId: string): Promise<PaymentBooks> {
  const pay = await prisma.campaignPayment.findUniqueOrThrow({ where: { razorpayPaymentId } });
  const f = fake.payments.get(razorpayPaymentId);
  const refunded = (f?.refunds ?? []).filter((r) => r.status !== "failed").reduce((a, r) => a + r.amount, 0);
  const net = [...fake.transfers.values()].filter((t) => t.source === razorpayPaymentId).reduce((a, t) => a + (t.amount - t.amountReversed), 0);
  const reserved = await reservedPaiseForPayment(razorpayPaymentId);
  return { paymentId: pay.id, captured: pay.amountPaise, refundedAtRazorpay: refunded, transferredNet: net, refundedLedger: pay.refundedPaise, rawRefundable: pay.amountPaise - pay.refundedPaise - reserved };
}

/**
 * The creator's SHARE is not the item price (a 40% share of ₹2,500 is ₹1,000), so the conservation law is stated on the
 * creator's side as: refunds + net transfers <= captured is TOO WEAK to catch "refunded the full price while the share is
 * still out" (₹2,500 + ₹1,000 = ₹3,500 is still far below a ₹6,000 payment). The sharper law is the reserve one,
 * rawRefundable >= 0: refunded + the item price of every payout that has not been taken back <= captured.
 */
export function expectBooksClose(b: PaymentBooks, why = ""): void {
  const w = `${why} payment ${b.paymentId} seed=${SEED}`;
  expect(b.refundedAtRazorpay + b.transferredNet, `${w}: money out of the payment (refunds + live transfers) exceeds what it captured`).toBeLessThanOrEqual(b.captured);
  expect(b.rawRefundable, `${w}: refunded + reserved exceeds the capture (reserved amount not honoured)`).toBeGreaterThanOrEqual(0);
}

/** The payout ids of a world's creator items, in item order. */
export async function payoutIdsOf(w: World): Promise<string[]> {
  return Promise.all(w.creators.map(async (c) => (await prisma.creatorPayout.findUniqueOrThrow({ where: { bookingItemId: c.id }, select: { id: true } })).id));
}

export async function itemStatus(itemId: string): Promise<string> {
  return (await prisma.campaignBookingItem.findUniqueOrThrow({ where: { id: itemId }, select: { status: true } })).status;
}

/**
 * The DISTINCT refunds Razorpay made, with the idempotency key each carried (rf-item-<itemId> for an item). ⚠️ A repeated REQUEST under
 * the same key is not a repeated REFUND: Razorpay answers it with the refund it already made [R30], which is exactly why the
 * ledger and the sweep may safely re-send an unanswered request. So refunds are counted from what exists, not from how often
 * the request was sent. `key` is null for a refund made without one (our code never does).
 */
export function appliedRefunds(fake: FakeRazorpay): Array<{ id: string; key: string | null; amount: number }> {
  const keyOfRefund = new Map<string, string>();
  for (const [k, r] of fake.refundKeys) keyOfRefund.set(r.id, k.slice(k.indexOf(":") + 1));
  return [...fake.payments.values()].flatMap((p) => p.refunds.filter((r) => r.status !== "failed").map((r) => ({ id: r.id, key: keyOfRefund.get(r.id) ?? null, amount: r.amount })));
}

/** A refund key without its `-r<N>` retry suffix: the INTENT. Two refunds of one intent are the brand being repaid twice. */
export const intentOfKey = (key: string): string => key.replace(/-r\d+$/, "");
