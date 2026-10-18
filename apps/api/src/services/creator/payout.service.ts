/**
 * The creator-payout ENGINE: every step that moves a creator's money out of (or back into) our Razorpay
 * balance. Phase 4 of docs/superpowers/plans/2026-10-12-creator-payouts-razorpay-route.md ("P4").
 *
 *   executePlannedPayout   planned → transfer_requested → held     (a HELD transfer to the linked account)
 *   resolveUnknownTransfer an unreadable or lost create answer, settled by READING Razorpay, never by retrying blind
 *   confirmHold            a transfer that was asked for, confirmed held (or put back on hold)
 *   releasePayout          held → release_requested → released     (PATCH on_hold:false, behind the release gate)
 *   resolveRelease         a release that was claimed and never confirmed
 *   pollSettlement         released → settled / settlement_failed  ("Paid" only from a processed settlement + UTR)
 *   reversePayout          held → reversal_requested → reversed    (explicit amount, never "all")
 *   reverseForRefund       the reverse-BEFORE-refund step for withdraw, decline, expiry, reject, a refund of one item
 *   markManualPaid         manual_required → paid_manual           (only when no transfer can release)
 *   pausePayout / resumePayout, reholdReleasedPayout, retryFailedPayout, requireManualPayment
 *
 * ⚠️ THE RULES EVERY FUNCTION HERE FOLLOWS (each closes a specific way to lose or double-pay money):
 *  1. FAIL CLOSED. A fact that could not be read (a Razorpay answer, a switch, a dispute check) is a refusal,
 *     never the good value. The decisions are pure functions in payout-policy.ts; this file reads facts, asks,
 *     and does exactly what was answered.
 *  2. NO HTTP INSIDE A DATABASE TRANSACTION, and no Razorpay call while a row lock is held: a Razorpay answer can
 *     take 15 seconds, and a transaction waiting on it would hold the connection pool hostage. Every status change
 *     is a short transaction around one CONDITIONAL updateMany (WHERE id AND status IN (…)) plus its audit row.
 *  3. CLAIM FIRST. The status moves BEFORE Razorpay is asked (planned → transfer_requested, held →
 *     release_requested, held → reversal_requested), so a crash between "we asked" and "Razorpay answered" leaves
 *     a row to reconcile, never a silent transfer. A claim that loses a race changes nothing and makes no call.
 *  4. AN UNKNOWN ANSWER IS NEITHER SUCCESS NOR FAILURE. A timeout, a 5xx, a 409, an unreadable 2xx keeps the
 *     claim and is resolved by reading Razorpay (a list or a fetch). There is no idempotency key for a transfer
 *     made from a payment [R3], so a transfer is created again only after TWO listings, far enough apart, both
 *     show nothing, and at most once automatically.
 *  5. EVERY CHANGE LEAVES AN AUDIT ROW (creator_payout_events), whose note is our own wording plus scrubbed codes:
 *     no bank detail, no Razorpay free text, no payload.
 *  6. paidAt IS NEVER WRITTEN HERE. Only the payment webhook says a brand paid.
 *
 * Each exported step returns a small StepResult (never a provider body). `calls` counts the Razorpay calls it
 * made (a list counts two: it always reads one page past the end), so the reconciliation job can keep its budget.
 */
import { prisma, Prisma } from "@dashmani/db";
import type { CreatorPayout } from "@dashmani/db";
import { creatorConfig } from "./creator-config";
import { razorpayConfig } from "../campaign/config";
import {
  RazorpayError,
  isDefinitelyRejected,
  createTransferFromPayment,
  fetchTransfer,
  setTransferHold,
  reverseTransfer,
  listTransferReversals,
  listAllPaymentTransfers,
  listDisputes,
  fetchRouteProduct,
  type RazorpayTransfer,
} from "../campaign/razorpay";
import { scrubPayoutSecrets } from "../../utils/payout-scrub";
import { alertStaffOncePerHour } from "./payout-alert";
import { bankChangeBlocksRelease } from "./payout-account-view";
import { PAUSABLE_STATUSES, canMove, type PayoutStatus, type TransferFacts } from "./payout-states";
import {
  ABSENT_CHECK_GAP_MS,
  DISPUTE_NOT_BLOCKING,
  canRetryFailedTransfer,
  decideManualFallback,
  decideRefundAllowed,
  decideResume,
  decideReversal,
  decideReversalOutcome,
  decideTransferCreation,
  decideTransferRetry,
  evaluateLocalRelease,
  evaluateRelease,
  evaluateTransferForRelease,
  isFullyReversed,
  mapTransferFactsToState,
  releaseAfter,
  reservedPaiseOf,
  type CarrierTransfer,
  type RefundAllowance,
  type ReleaseFacts,
  type TransferStateDecision,
  type TransferView,
} from "./payout-policy";

// ── Public types ────────────────────────────────────────────────────────────────

export interface PayoutActor {
  type: "system" | "staff" | "creator" | "razorpay";
  id?: string | null;
}
const SYSTEM: PayoutActor = { type: "system" };

export interface StepResult {
  /** The step did what was asked, or what was asked was already true. */
  ok: boolean;
  /** A stable code: released, refused, unknown, lost_claim, already_reversed, … */
  outcome: string;
  payoutId: string;
  /** The payout's status after the step; null when there is no such payout. */
  status: string | null;
  /** Razorpay calls made (a list counts as two). */
  calls: number;
  /** Why it was refused or did not complete: a stable code from our own vocabulary. */
  reason?: string;
}

export interface StepOptions {
  /** Epoch for leases and delays. Tests only. */
  now?: Date;
  actor?: PayoutActor;
  /** Tests only: run at a named point so a test can land a pause or a dispute exactly there. */
  hooks?: { beforeClaim?: () => Promise<void>; afterClaim?: () => Promise<void> };
}

// ── Tunables ────────────────────────────────────────────────────────────────────

/** How long a step owns a payout while it talks to Razorpay: longer than the client's 15 s timeout, short enough to recover quickly. */
export const LEASE_MS = 2 * 60_000;
/** A created or pending transfer is looked at again after this (the webhook normally gets there first). */
const IN_FLIGHT_RECHECK_MS = 2 * 60_000;
const RETRY_BACKOFF_MS = 5 * 60_000;
/** A held payout is re-read from Razorpay once a day, to notice anything done in the dashboard [P4 job 9]. */
export const HELD_RECHECK_MS = 24 * 60 * 60_000;
/** Disputes can only come after the capture; the lookback covers a capture whose webhook arrived days late. */
const DISPUTE_LOOKBACK_S = 3 * 24 * 60 * 60;
/** A released payout that has not settled this long after release is worth a human look. */
const SETTLEMENT_SLOW_MS = 4 * 24 * 60 * 60_000;
export const RELEASE_SWITCH_KEY = "creatorPayouts.release";

/** Extra days between a verified post and its release (CREATOR_PAYOUT_HOLD_DAYS, default 0). Never NaN, never negative. */
export function payoutHoldDays(): number {
  const raw = process.env.CREATOR_PAYOUT_HOLD_DAYS;
  const n = raw === undefined || raw === "" ? 0 : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** NEW transfers need the Route switch AND the keys. Existing payouts keep reconciling with the switch off. */
export const transfersEnabled = (): boolean => creatorConfig.routeEnabled() && razorpayConfig.configured();

/**
 * The runtime pause of ALL releases: system_settings creatorPayouts.release = 'off' (absent = on). A read that
 * fails counts as OFF: nothing is released on a switch we could not read.
 */
export async function releaseSwitchOn(): Promise<boolean> {
  try {
    const row = await prisma.systemSetting.findUnique({ where: { key: RELEASE_SWITCH_KEY } });
    return !(row && String(row.value).trim().toLowerCase() === "off");
  } catch {
    return false;
  }
}

// ── Plumbing ────────────────────────────────────────────────────────────────────

interface Ctx {
  payoutId: string;
  calls: number;
}
const newCtx = (payoutId: string): Ctx => ({ payoutId, calls: 0 });

/** Count a Razorpay call, then make it. `weight` 2 for a list (it reads one page past the end). */
async function rz<T>(ctx: Ctx, fn: () => Promise<T>, weight = 1): Promise<T> {
  ctx.calls += weight;
  return fn();
}

const result = (ctx: Ctx, status: string | null, ok: boolean, outcome: string, reason?: string): StepResult => ({
  ok,
  outcome,
  payoutId: ctx.payoutId,
  status,
  calls: ctx.calls,
  ...(reason ? { reason } : {}),
});

function errCode(err: unknown): string {
  if (err instanceof RazorpayError) return (err.code ?? (err.status ? `http_${err.status}` : "error")).slice(0, 80);
  return "error";
}

/** Our own sentence about an error: a code and the (already scrubbed, bounded) provider message, stored in the row's lastError only. */
function errText(err: unknown, lead: string): string {
  const msg = err instanceof RazorpayError ? err.message : "";
  return scrubPayoutSecrets(`${lead}${msg ? `: ${msg}` : ""}`).slice(0, 500);
}

const note = (s: string): string => scrubPayoutSecrets(s).slice(0, 500);
const inr = (paise: number): string => `₹${(paise / 100).toFixed(2)}`;

const loadPayout = (id: string) => prisma.creatorPayout.findUnique({ where: { id } });

/** Applies `to` only to a row still in `from`, and writes its audit row, in ONE short transaction. False = the row had moved on (a lost race). */
async function transition(a: {
  id: string;
  from: readonly PayoutStatus[];
  to: PayoutStatus;
  data?: Prisma.CreatorPayoutUpdateManyMutationInput;
  where?: Prisma.CreatorPayoutWhereInput;
  kind: string;
  actor: PayoutActor;
  note: string;
  amountPaise?: number | null;
}): Promise<boolean> {
  for (const f of a.from) if (!canMove(f, a.to)) throw new Error(`illegal payout move ${f} -> ${a.to}`);
  return prisma.$transaction(async (tx) => {
    const cur = await tx.creatorPayout.findUnique({ where: { id: a.id }, select: { status: true, bookingId: true, amountPaise: true } });
    if (!cur || !a.from.includes(cur.status as PayoutStatus)) return false;
    const r = await tx.creatorPayout.updateMany({ where: { ...a.where, id: a.id, status: cur.status }, data: { ...a.data, status: a.to } });
    if (r.count !== 1) return false;
    await tx.creatorPayoutEvent.create({
      data: {
        payoutId: a.id,
        bookingId: cur.bookingId,
        kind: a.kind.slice(0, 40),
        fromStatus: cur.status,
        toStatus: a.to,
        amountPaise: a.amountPaise === undefined ? cur.amountPaise : a.amountPaise,
        actorType: a.actor.type,
        actorId: a.actor.id ?? null,
        note: note(a.note),
      },
    });
    return true;
  });
}

/** An audit row for something that did not change the status (a check, a pause, a refusal worth keeping). */
async function recordEvent(p: Pick<CreatorPayout, "id" | "bookingId" | "amountPaise">, kind: string, status: string, text: string, actor: PayoutActor = SYSTEM): Promise<void> {
  await prisma.creatorPayoutEvent.create({
    data: { payoutId: p.id, bookingId: p.bookingId, kind: kind.slice(0, 40), fromStatus: status, toStatus: status, amountPaise: p.amountPaise, actorType: actor.type, actorId: actor.id ?? null, note: note(text) },
  });
}

/** Own the payout for the length of a Razorpay conversation. null = another step holds it. */
async function takeLease(id: string, statuses: readonly PayoutStatus[], now: Date, ms = LEASE_MS): Promise<Date | null> {
  const until = new Date(now.getTime() + ms);
  const r = await prisma.creatorPayout.updateMany({
    where: { id, status: { in: [...statuses] }, OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
    data: { lockedUntil: until },
  });
  return r.count === 1 ? until : null;
}

async function dropLease(id: string, until: Date | null): Promise<void> {
  if (!until) return;
  await prisma.creatorPayout.updateMany({ where: { id, lockedUntil: until }, data: { lockedUntil: null } });
}

/** Record that a step could not finish and when to look again, without touching the status. */
async function backoff(id: string, status: PayoutStatus, now: Date, ms: number, data: Prisma.CreatorPayoutUpdateManyMutationInput = {}): Promise<void> {
  await prisma.creatorPayout.updateMany({ where: { id, status }, data: { ...data, nextAttemptAt: new Date(now.getTime() + ms), lockedUntil: null } });
}

// ── Staff alerts ────────────────────────────────────────────────────────────────

const SUBJECTS: Record<string, string> = {
  transfer_failed: "Creator payout transfer FAILED",
  manual_required: "Creator payout needs a manual bank transfer",
  needs_attention: "Creator payout needs attention",
  not_on_hold: "A creator payout transfer is NOT on hold",
  reversal_failed: "Creator payout reversal FAILED",
  release_failed: "Creator payout release did not go through",
  settlement_failed: "Creator payout settlement FAILED (the bank rejected it)",
  settlement_slow: "A released creator payout has not settled",
  duplicate_transfer: "A duplicate creator payout transfer was found",
  rehold: "A released creator payout could not be held again",
  reheld: "A released creator payout was put back on hold",
  id_not_recorded: "A Razorpay transfer could not be recorded",
};

/**
 * One email per kind and status per hour (a Razorpay balance that runs dry fails EVERY transfer at once), and the
 * payout is stamped alerted_status / alerted_at only after the mailer reports the email went out, so the
 * reconciliation digest still covers a payout whose email did not. Text is ours: ids and scrubbed codes only.
 */
function alertPayout(p: Pick<CreatorPayout, "id" | "bookingId" | "amountPaise">, kind: keyof typeof SUBJECTS, status: string, reason: string, extra: Array<{ label: string; value: string }> = []): void {
  alertStaffOncePerHour(
    `payout-engine:${kind}:${status}`,
    SUBJECTS[kind] ?? "Creator payout needs attention",
    [
      { label: "Status", value: status },
      { label: "Reason", value: reason },
      { label: "Amount", value: inr(p.amountPaise) },
      { label: "Payout", value: p.id },
      { label: "Booking", value: p.bookingId },
      ...extra,
    ],
    `/campaigns/${p.bookingId}`,
    {
      onSent: async () => {
        await prisma.creatorPayout.updateMany({ where: { id: p.id }, data: { alertedStatus: status.slice(0, 24), alertedAt: new Date() } });
      },
    },
  );
}

/** Our words for the reasons a payout parks (stored in last_error; the reason code itself is in error_code). */
const REASON_TEXT: Record<string, string> = {
  processed_not_held: "Razorpay showed the transfer processed but NOT on hold. The hold was put back; confirm it before anything is released.",
  processed_hold_expires: "Razorpay showed an automatic release date on the transfer. The hold was put back without one; confirm it before anything is released.",
  released_outside_flow: "The transfer's hold was lifted outside our release flow. The hold was put back; check Razorpay.",
  hold_expires: "Razorpay shows an automatic release date on the transfer. The hold was put back without one; check Razorpay.",
  failed_while_held: "Razorpay now shows the held transfer as failed. Check Razorpay.",
  settled_while_held: "The transfer settled to the creator's bank although we still had it held. Check Razorpay before refunding or paying.",
  re_held_outside_flow: "A released transfer is on hold again, which we did not do. Check Razorpay.",
  reversed_outside_flow: "The transfer was reversed outside our flow. Check Razorpay before refunding or paying.",
  partially_reversed: "The transfer was partly reversed. Check Razorpay before anything else happens to it.",
  transfer_mismatch: "Razorpay's transfer does not match this payout. Check Razorpay.",
  duplicate_transfer: "More than one transfer was made for this payout. The extra ones are being reversed; confirm one live transfer remains.",
  transfer_unknown_after_retry: "The transfer request was repeated once and no transfer ever showed up in Razorpay. A person must check Razorpay.",
  reversal_refused: "Razorpay refused to take the transfer back. Nothing changed; check Razorpay.",
  reversal_refused_after_release: "Razorpay refused to take back money that was already released. Check Razorpay and the linked account's balance.",
  reversal_failed_state: "The transfer could not be reversed in its current state. Check Razorpay.",
  transfer_failed: "Razorpay reports the transfer failed.",
};

// ── What Razorpay's transfer says, as columns and as facts ──────────────────────

const statusOf = (v: string): string => v.slice(0, 24);

function factsOf(t: RazorpayTransfer): TransferFacts {
  return {
    status: t.status,
    onHold: t.on_hold,
    onHoldUntil: t.on_hold_until,
    amount: t.amount,
    amountReversed: t.amount_reversed,
    settlementStatus: t.settlement_status,
    recipientSettlementStatus: t.recipient_settlement?.status?.toLowerCase() ?? null,
  };
}

/** What a transfer read tells us to remember. amount_reversed is Razorpay's figure, read now, never defaulted. */
function columnsFrom(t: RazorpayTransfer, now: Date): Prisma.CreatorPayoutUpdateManyMutationInput {
  const d: Prisma.CreatorPayoutUpdateManyMutationInput = { transferStatus: statusOf(t.status), amountReversedPaise: t.amount_reversed, lastCheckedAt: now };
  if (t.settlement_status) d.settlementStatus = statusOf(t.settlement_status);
  const settlementId = t.recipient_settlement?.id ?? t.recipient_settlement_id;
  // ⚠️ Written as soon as Razorpay shows it: the settlement webhook carries no transfer id and links ONLY by this column.
  if (settlementId) d.recipientSettlementId = settlementId.slice(0, 64);
  if (t.recipient_settlement?.status) d.recipientSettlementStatus = t.recipient_settlement.status.toLowerCase().slice(0, 16);
  if (t.fees !== null) d.transferFeesPaise = t.fees;
  if (t.tax !== null) d.transferTaxPaise = t.tax;
  return d;
}

type PayoutRow = CreatorPayout;

/** The transfer is the one this payout set aside: same linked account, same amount, and (when Razorpay says) the same payment and our note. */
function transferMatches(p: PayoutRow, t: RazorpayTransfer): boolean {
  if (t.recipient !== p.razorpayAccountId || t.amount !== p.amountPaise) return false;
  if (t.source !== null && t.source !== p.razorpayPaymentId) return false;
  if (t.notes.payout_id !== undefined && t.notes.payout_id !== p.id) return false;
  return true;
}

const hasUsableUtr = (utr: string | null): utr is string => typeof utr === "string" && /^[A-Za-z0-9_/-]{4,64}$/.test(utr.trim());

function settlementPollDelayMs(releasedAt: Date | null, now: Date): number {
  const age = releasedAt ? now.getTime() - releasedAt.getTime() : 0;
  return age < 24 * 60 * 60_000 ? 60 * 60_000 : 3 * 60 * 60_000;
}

// ── Facts read from our own database ────────────────────────────────────────────

/** The release gate's local facts (everything except what only Razorpay can say). Fails closed on a switch it cannot read. */
async function loadLocalReleaseFacts(p: PayoutRow, now: Date): Promise<Omit<ReleaseFacts, "transfer" | "duplicateTransfers" | "razorpayDisputes" | "account"> & { productId: string | null; hint: string | null; accountRowMatches: boolean }> {
  const [releaseEnabled, booking, item, offer, disputes, acct] = await Promise.all([
    releaseSwitchOn(),
    prisma.campaignBooking.findUnique({ where: { id: p.bookingId }, select: { status: true } }),
    prisma.campaignBookingItem.findUnique({ where: { id: p.bookingItemId }, select: { status: true } }),
    prisma.creatorOffer.findUnique({ where: { bookingItemId: p.bookingItemId }, select: { status: true, linkVerifiedAt: true, ownershipCheck: true } }),
    prisma.campaignDispute.findMany({ where: { razorpayPaymentId: p.razorpayPaymentId }, select: { status: true } }),
    prisma.creatorPayoutAccount.findUnique({
      where: { id: p.payoutAccountId },
      select: { razorpayAccountId: true, razorpayProductId: true, destinationHint: true, bankChangeRequestedAt: true, bankChangeClearedAt: true },
    }),
  ]);
  return {
    now,
    releaseEnabled,
    payout: {
      status: p.status,
      pausedAt: p.pausedAt,
      releaseAfter: p.releaseAfter,
      amountPaise: p.amountPaise,
      transferId: p.razorpayTransferId,
      razorpayAccountId: p.razorpayAccountId,
      razorpayPaymentId: p.razorpayPaymentId,
    },
    booking,
    item,
    offer,
    disputeStatuses: disputes.map((d) => d.status),
    bankChangeBlocks: acct ? bankChangeBlocksRelease(acct, now) : false,
    productId: acct?.razorpayProductId ?? null,
    hint: acct?.destinationHint ?? null,
    accountRowMatches: acct?.razorpayAccountId === p.razorpayAccountId,
  };
}

async function refundExistsFor(razorpayPaymentId: string): Promise<boolean> {
  const [pay, n] = await Promise.all([
    prisma.campaignPayment.findUnique({ where: { razorpayPaymentId }, select: { status: true, refundedPaise: true } }),
    prisma.campaignRefund.count({ where: { razorpayPaymentId, status: { not: "failed" } } }),
  ]);
  return n > 0 || (pay?.refundedPaise ?? 0) > 0 || pay?.status === "refund_pending" || pay?.status === "refunded";
}

// ── Creating the transfer ───────────────────────────────────────────────────────

/**
 * planned → transfer_requested → held. One held transfer for the payout, made from the brand's captured payment
 * into the creator's linked account with on_hold:true, carrying only our payout_id and booking_item_id.
 *
 * Nothing is claimed unless decideTransferCreation says go (switch on, payment captured with no refund, booking
 * and item still payable, account activated, not paused). A refund that already exists on the payment means no
 * transfer can ever be made [R4]: the payout goes straight to manual_required.
 */
export async function executePlannedPayout(payoutId: string, opts: StepOptions = {}): Promise<StepResult> {
  const now = opts.now ?? new Date();
  const ctx = newCtx(payoutId);
  const p = await loadPayout(payoutId);
  if (!p) return result(ctx, null, false, "not_found");
  if (p.status !== "planned") return result(ctx, p.status, false, "not_planned");
  if (!transfersEnabled()) return result(ctx, p.status, false, "disabled", "route_off_or_not_configured");

  const facts = await loadCreateFacts(p);
  const decision = decideTransferCreation(facts);
  if (decision.action === "manual_required") {
    const moved = await transition({
      id: p.id,
      from: ["planned"],
      to: "manual_required",
      where: { pausedAt: null },
      data: { errorCode: decision.reason, lastError: "A refund exists on the brand's payment, so no transfer can be made from it. Pay the creator by bank transfer.", lockedUntil: null },
      kind: "manual",
      actor: SYSTEM,
      note: `Manual payment required: ${decision.reason}.`,
    });
    if (moved) alertPayout(p, "manual_required", "manual_required", decision.reason);
    return result(ctx, moved ? "manual_required" : (await loadPayout(payoutId))?.status ?? null, moved, moved ? "manual_required" : "lost_claim", decision.reason);
  }
  if (decision.action === "wait") return result(ctx, p.status, false, "waiting", decision.reason);

  if (opts.hooks?.beforeClaim) await opts.hooks.beforeClaim();
  const claimed = await transition({
    id: p.id,
    from: ["planned"],
    to: "transfer_requested",
    where: { pausedAt: null, OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
    data: { attempts: { increment: 1 }, transferRequestedAt: now, lockedUntil: new Date(now.getTime() + LEASE_MS), nextAttemptAt: null, errorCode: null, lastError: null },
    kind: "transfer",
    actor: opts.actor ?? SYSTEM,
    note: "Transfer requested from Razorpay (held).",
  });
  if (!claimed) return result(ctx, (await loadPayout(payoutId))?.status ?? null, false, "lost_claim");
  const after = (await loadPayout(payoutId))!;
  return performCreate(ctx, after, now, opts.actor ?? SYSTEM);
}

async function loadCreateFacts(p: PayoutRow) {
  const [payment, refundExists, booking, item, acct] = await Promise.all([
    prisma.campaignPayment.findUnique({ where: { razorpayPaymentId: p.razorpayPaymentId }, select: { status: true } }),
    refundExistsFor(p.razorpayPaymentId),
    prisma.campaignBooking.findUnique({ where: { id: p.bookingId }, select: { status: true } }),
    prisma.campaignBookingItem.findUnique({ where: { id: p.bookingItemId }, select: { status: true } }),
    prisma.creatorPayoutAccount.findUnique({ where: { id: p.payoutAccountId }, select: { activationStatus: true, razorpayAccountId: true } }),
  ]);
  return {
    refundExists,
    paymentCaptured: payment?.status === "captured",
    bookingStatus: booking?.status ?? null,
    itemStatus: item?.status ?? null,
    accountActivated: acct?.activationStatus === "activated" && acct.razorpayAccountId === p.razorpayAccountId,
    paused: p.pausedAt !== null,
    amountPaise: p.amountPaise,
  };
}

/** The create call itself and what to make of its answer. `p` is already claimed (transfer_requested, lease held). */
async function performCreate(ctx: Ctx, p: PayoutRow, now: Date, actor: PayoutActor): Promise<StepResult> {
  let t: RazorpayTransfer;
  try {
    t = await rz(ctx, () =>
      createTransferFromPayment(p.razorpayPaymentId, {
        account: p.razorpayAccountId,
        amountPaise: p.amountPaise,
        onHold: true,
        notes: { payout_id: p.id, booking_item_id: p.bookingItemId },
      }),
    );
  } catch (err) {
    return afterCreateError(ctx, p, err, now, actor);
  }
  return adoptTransfer(ctx, p, t, now, actor, "Razorpay created the transfer.");
}

/** A failed create call: a definite refusal is `failed`; anything else leaves the claim for resolveUnknownTransfer. */
async function afterCreateError(ctx: Ctx, p: PayoutRow, err: unknown, now: Date, actor: PayoutActor): Promise<StepResult> {
  const code = errCode(err);
  if (isDefinitelyRejected(err)) {
    const moved = await transition({
      id: p.id,
      from: ["transfer_requested"],
      to: "failed",
      data: { errorCode: code, lastError: errText(err, "Razorpay refused the transfer"), lockedUntil: null, nextAttemptAt: null },
      kind: "transfer",
      actor,
      note: `Razorpay refused the transfer (${code}).`,
    });
    if (!moved) return result(ctx, (await loadPayout(p.id))?.status ?? null, false, "lost_claim");
    // A refund that appeared meanwhile means the transfer can never be retried: staff pay by hand.
    if (await refundExistsFor(p.razorpayPaymentId)) {
      const manual = await transition({
        id: p.id,
        from: ["failed"],
        to: "manual_required",
        data: { errorCode: "refund_exists", lastError: "A refund exists on the brand's payment, so no transfer can be made from it. Pay the creator by bank transfer." },
        kind: "manual",
        actor: SYSTEM,
        note: "Manual payment required: a refund exists on the payment.",
      });
      if (manual) {
        alertPayout(p, "manual_required", "manual_required", "refund_exists");
        return result(ctx, "manual_required", false, "manual_required", "refund_exists");
      }
    }
    alertPayout(p, "transfer_failed", "failed", code);
    return result(ctx, "failed", false, "failed", code);
  }
  // Unknown: Razorpay may or may not have made the transfer. Keep the claim and let the resolver read Razorpay.
  await backoff(p.id, "transfer_requested", now, 60_000, { errorCode: "create_result_unknown", lastError: "The transfer request got no readable answer from Razorpay. It is being reconciled by reading Razorpay; no second request is made until then." });
  await recordEvent(p, "transfer", "transfer_requested", `Transfer request got no readable answer (${code}); reconciling.`, actor);
  return result(ctx, "transfer_requested", false, "unknown", code);
}

/**
 * Razorpay gave us a transfer for this payout (the create answer, or one found by a listing). Record its id AT
 * ONCE, before anything else can go wrong, then judge it.
 */
async function adoptTransfer(ctx: Ctx, p: PayoutRow, t: RazorpayTransfer, now: Date, actor: PayoutActor, why: string): Promise<StepResult> {
  try {
    const r = await prisma.creatorPayout.updateMany({
      where: { id: p.id, status: "transfer_requested", razorpayTransferId: null },
      data: { razorpayTransferId: t.id.slice(0, 64), transferStatus: statusOf(t.status), lastCheckedAt: now },
    });
    if (r.count === 0) {
      const cur = await loadPayout(p.id);
      if (cur?.razorpayTransferId !== t.id) {
        // A transfer exists at Razorpay that this payout could not record (it moved on, or holds another id).
        alertPayout(p, "id_not_recorded", cur?.status ?? "unknown", "transfer_id_not_recorded", [{ label: "Transfer", value: t.id }]);
        return result(ctx, cur?.status ?? null, false, "id_not_recorded");
      }
    }
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") {
      alertPayout(p, "id_not_recorded", p.status, "transfer_id_in_use", [{ label: "Transfer", value: t.id }]);
      return result(ctx, p.status, false, "id_not_recorded", "transfer_id_in_use");
    }
    throw err;
  }
  await recordEvent(p, "transfer", "transfer_requested", `${why} Transfer id recorded.`, actor);
  const cur = (await loadPayout(p.id))!;
  if (!transferMatches(cur, t)) return parkMismatch(ctx, cur, t, actor);
  if (cur.status === "transfer_requested" && cur.attempts > 1) {
    // ⚠️ The create call was sent TWICE, so a twin of this transfer may still be on its way into Razorpay's list. The
    // payout is not called held until a listing, at least ABSENT_CHECK_GAP_MS after the last request, shows it has none.
    const auditAt = (cur.transferRequestedAt?.getTime() ?? now.getTime()) + ABSENT_CHECK_GAP_MS + 60_000;
    await prisma.creatorPayout.updateMany({ where: { id: cur.id, status: "transfer_requested" }, data: { transferStatus: statusOf(t.status), nextAttemptAt: new Date(auditAt), lockedUntil: null, lastCheckedAt: now } });
    return result(ctx, "transfer_requested", false, "audit_pending", "request_was_repeated");
  }
  return applyFreshTransfer(ctx, cur, t, now, actor);
}

async function parkMismatch(ctx: Ctx, p: PayoutRow, t: RazorpayTransfer, actor: PayoutActor): Promise<StepResult> {
  const moved = await transition({
    id: p.id,
    from: ["transfer_requested", "held", "release_requested", "released", "settlement_failed", "reversal_requested"],
    to: "needs_attention",
    data: { errorCode: "transfer_mismatch", lastError: REASON_TEXT.transfer_mismatch, lockedUntil: null },
    kind: "transfer",
    actor,
    note: "The transfer does not match this payout (recipient, payment, amount or note).",
  });
  alertPayout(p, "needs_attention", "needs_attention", "transfer_mismatch", [{ label: "Transfer", value: t.id }]);
  return result(ctx, moved ? "needs_attention" : (await loadPayout(p.id))?.status ?? null, false, "mismatch", "transfer_mismatch");
}

/**
 * Judge a FRESH transfer read against the payout's current status and apply the one legal move it implies
 * (payout-policy.mapTransferFactsToState decides which). Shared by the create answer, a listing's find,
 * confirm-hold, the daily re-read, the release confirmation, the settlement poll and the reversal's finish.
 */
async function applyFreshTransfer(ctx: Ctx, p: PayoutRow, t: RazorpayTransfer, now: Date, actor: PayoutActor): Promise<StepResult> {
  const facts = factsOf(t);
  const dec: TransferStateDecision = mapTransferFactsToState(p.status, facts);
  const base = columnsFrom(t, now);
  const from = [p.status as PayoutStatus];

  if (!dec.to) {
    // Nothing to move. Record what was read and when to look again.
    let next: number | null = null;
    if (p.status === "transfer_requested") next = IN_FLIGHT_RECHECK_MS;
    else if (p.status === "released" || p.status === "settlement_failed") next = settlementPollDelayMs(p.releasedAt, now);
    else if (p.status === "release_requested" || p.status === "reversal_requested") next = IN_FLIGHT_RECHECK_MS;
    else if (p.status === "needs_attention") next = RETRY_BACKOFF_MS;
    const data: Prisma.CreatorPayoutUpdateManyMutationInput = { ...base, lockedUntil: null };
    if (p.status === "held" && dec.reason === "confirmed_held") data.onHoldVerifiedAt = now;
    if (next !== null) data.nextAttemptAt = new Date(now.getTime() + next);
    await prisma.creatorPayout.updateMany({ where: { id: p.id, status: p.status }, data });
    // A parked payout whose hold has still not been put back: try again.
    if (dec.action === "rehold") await putHoldBack(ctx, p, t.id, actor);
    return result(ctx, p.status, dec.reason === "confirmed_held", dec.reason);
  }

  let data: Prisma.CreatorPayoutUpdateManyMutationInput;
  let text: string;
  let kind = "transfer";
  switch (dec.to) {
    case "held":
      data = { ...base, heldAt: now, onHoldVerifiedAt: now, errorCode: null, lastError: null, lockedUntil: null, nextAttemptAt: null };
      text = "Razorpay shows the transfer processed and on hold.";
      break;
    case "failed":
      data = { ...base, errorCode: (t.error?.reason ?? t.error?.code ?? "transfer_failed").slice(0, 80), lastError: scrubPayoutSecrets(t.error?.description ?? REASON_TEXT.transfer_failed).slice(0, 500), lockedUntil: null, nextAttemptAt: null };
      text = "Razorpay reports the transfer failed.";
      break;
    case "released": {
      const hint = (await prisma.creatorPayoutAccount.findUnique({ where: { id: p.payoutAccountId }, select: { destinationHint: true } }))?.destinationHint ?? null;
      data = { ...base, releasedAt: now, onHoldVerifiedAt: now, destinationHint: hint ? hint.slice(0, 80) : null, errorCode: null, lastError: null, lockedUntil: null, nextAttemptAt: new Date(now.getTime() + settlementPollDelayMs(now, now)) };
      text = "Razorpay shows the hold lifted: released. The destination was frozen onto this payout.";
      kind = "release";
      break;
    }
    case "settled": {
      const st = t.recipient_settlement;
      // "Paid" needs the bank's reference. A processed settlement without a usable UTR is not shown as paid.
      if (!st || !hasUsableUtr(st.utr)) {
        await prisma.creatorPayout.updateMany({ where: { id: p.id, status: p.status }, data: { ...base, errorCode: "settlement_without_utr", lockedUntil: null, nextAttemptAt: new Date(now.getTime() + settlementPollDelayMs(p.releasedAt, now)) } });
        return result(ctx, p.status, false, "settlement_without_utr");
      }
      data = {
        ...base,
        settledAt: now,
        settlementUtr: st.utr.trim().slice(0, 64),
        // The settlement entity's amount is the WHOLE bank batch (it can carry several transfers): kept as information only, never as the creator's share.
        settlementAmountPaise: st.amount_settled,
        settlementFeePaise: st.fee,
        errorCode: null,
        lastError: null,
        lockedUntil: null,
        nextAttemptAt: null,
      };
      text = "Razorpay shows the settlement processed.";
      kind = "settlement";
      break;
    }
    case "settlement_failed":
      data = { ...base, errorCode: "settlement_failed", lastError: "Razorpay reports the bank settlement failed. The creator's bank rejected it: their details need updating.", lockedUntil: null, nextAttemptAt: null };
      text = "Razorpay reports the settlement failed.";
      kind = "settlement";
      break;
    case "reversed":
      data = { ...base, reversedAt: now, transferStatus: "reversed", errorCode: null, lastError: null, lockedUntil: null, nextAttemptAt: null };
      text = "Razorpay shows the whole transfer reversed.";
      kind = "reversal";
      break;
    case "needs_attention":
      data = { ...base, errorCode: dec.reason.slice(0, 80), lastError: REASON_TEXT[dec.reason] ?? dec.reason, lockedUntil: null, nextAttemptAt: null };
      text = `Parked: ${dec.reason}.`;
      break;
    default:
      data = { ...base, lockedUntil: null };
      text = `Moved: ${dec.reason}.`;
  }

  const moved = await transition({ id: p.id, from, to: dec.to, data, kind, actor, note: text });
  if (!moved) return result(ctx, (await loadPayout(p.id))?.status ?? null, false, "lost_claim");

  if (dec.to === "failed") {
    alertPayout(p, "transfer_failed", "failed", "transfer_failed");
  } else if (dec.to === "settlement_failed") {
    alertPayout(p, "settlement_failed", "settlement_failed", "settlement_failed");
  } else if (dec.to === "needs_attention") {
    alertPayout(p, dec.action === "rehold" ? "not_on_hold" : "needs_attention", "needs_attention", dec.reason, [{ label: "Transfer", value: t.id }]);
  }
  if (dec.action === "rehold") await putHoldBack(ctx, p, t.id, actor);
  return result(ctx, dec.to, dec.to !== "needs_attention" && dec.to !== "failed" && dec.to !== "settlement_failed", dec.to === "needs_attention" ? "parked" : dec.to, dec.to === "needs_attention" ? dec.reason : undefined);
}

/** PATCH on_hold:true on a transfer that should have been held. Best effort: the row is already parked and staff already told. */
async function putHoldBack(ctx: Ctx, p: PayoutRow, transferId: string, actor: PayoutActor): Promise<void> {
  try {
    await rz(ctx, () => setTransferHold(transferId, true));
    await recordEvent(p, "transfer", "needs_attention", "The hold was put back on the transfer.", actor);
  } catch (err) {
    await recordEvent(p, "transfer", "needs_attention", `The hold could not be put back (${errCode(err)}). Do it in Razorpay now.`, actor);
  }
}

// ── An unknown create result ────────────────────────────────────────────────────

const carrierOf = (t: RazorpayTransfer): CarrierTransfer => ({ id: t.id, status: t.status, amount: t.amount, amountReversed: t.amount_reversed, recipient: t.recipient, createdAt: t.created_at });

/**
 * A payout in transfer_requested with NO transfer id: the create call's answer was lost or unreadable (or the
 * process died after the claim). Razorpay has no idempotency key for this call [R3], so this reads the
 * payment's transfers and decides (decideTransferRetry):
 *   exactly one carries our payout_id → adopt it;
 *   several → keep one, reverse the extras while they are still on hold, park the payout for a person;
 *   none, for the second time and ≥ ABSENT_CHECK_GAP_MS after the first → send the create call ONCE more;
 *   none, with a refund on the payment → manual_required; none after the retry → needs_attention.
 * A listing that fails changes nothing: an unread list is not an empty one.
 */
export async function resolveUnknownTransfer(payoutId: string, opts: StepOptions = {}): Promise<StepResult> {
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? SYSTEM;
  const ctx = newCtx(payoutId);
  const p0 = await loadPayout(payoutId);
  if (!p0) return result(ctx, null, false, "not_found");
  if (p0.status !== "transfer_requested" || p0.razorpayTransferId !== null) return result(ctx, p0.status, false, "not_applicable");
  if (!razorpayConfig.configured()) return result(ctx, p0.status, false, "disabled", "not_configured");
  const lease = await takeLease(payoutId, ["transfer_requested"], now);
  if (!lease) return result(ctx, p0.status, false, "leased");
  try {
    const p = (await loadPayout(payoutId))!;
    if (p.status !== "transfer_requested" || p.razorpayTransferId !== null) return result(ctx, p.status, false, "not_applicable");

    let listing: RazorpayTransfer[];
    try {
      listing = await rz(ctx, () => listAllPaymentTransfers(p.razorpayPaymentId), 2);
    } catch (err) {
      await backoff(p.id, "transfer_requested", now, RETRY_BACKOFF_MS, { errorCode: "listing_failed" });
      return result(ctx, p.status, false, "unread", errCode(err));
    }
    const mine = listing.filter((t) => t.notes.payout_id === p.id);
    const refundExists = await refundExistsFor(p.razorpayPaymentId);
    const d = decideTransferRetry({
      now,
      attempts: p.attempts,
      absentChecks: p.absentChecks,
      lastCheckedAt: p.lastCheckedAt,
      refundExists,
      storedTransferId: p.razorpayTransferId,
      expected: { recipient: p.razorpayAccountId, amountPaise: p.amountPaise },
      carriers: mine.map(carrierOf),
    });

    switch (d.action) {
      case "adopt":
      case "adopt_failed": {
        const t = mine.find((x) => x.id === d.transferId)!;
        return adoptTransfer(ctx, p, t, now, actor, "A listing of the payment's transfers showed this payout's transfer.");
      }
      case "duplicates": {
        const keep = mine.find((x) => x.id === d.keep)!;
        const extras = mine.filter((x) => d.extras.includes(x.id));
        return handleDuplicates(ctx, p, keep, extras, now, actor);
      }
      case "wait": {
        await prisma.creatorPayout.updateMany({
          where: { id: p.id, status: "transfer_requested" },
          data: d.countAbsent
            ? { absentChecks: d.absentChecks, lastCheckedAt: now, nextAttemptAt: new Date(now.getTime() + ABSENT_CHECK_GAP_MS + 60_000), lockedUntil: null }
            : { nextAttemptAt: new Date(now.getTime() + ABSENT_CHECK_GAP_MS + 60_000), lockedUntil: null },
        });
        return result(ctx, p.status, false, "waiting", "no_transfer_seen_yet");
      }
      case "retry": {
        // The second empty listing, far enough from the first: the create call did not land. Once more, never more.
        const claimed = await prisma.creatorPayout.updateMany({
          where: { id: p.id, status: "transfer_requested", razorpayTransferId: null, attempts: p.attempts },
          data: { attempts: { increment: 1 }, absentChecks: 0, lastCheckedAt: now, transferRequestedAt: now, nextAttemptAt: null, lockedUntil: new Date(now.getTime() + LEASE_MS) },
        });
        if (claimed.count !== 1) return result(ctx, p.status, false, "lost_claim");
        await recordEvent(p, "transfer", "transfer_requested", "Two listings showed no transfer for this payout; the request is sent once more.", actor);
        return performCreate(ctx, (await loadPayout(p.id))!, now, actor);
      }
      case "manual_required": {
        // Nothing was ever created and a refund exists: through `failed` (the state table has no direct edge).
        const a = await transition({ id: p.id, from: ["transfer_requested"], to: "failed", data: { errorCode: d.reason, lastError: "No transfer was ever created and a refund exists on the brand's payment.", lockedUntil: null }, kind: "transfer", actor, note: "No transfer was ever created." });
        if (!a) return result(ctx, (await loadPayout(p.id))?.status ?? null, false, "lost_claim");
        const b = await transition({ id: p.id, from: ["failed"], to: "manual_required", data: { errorCode: d.reason }, kind: "manual", actor, note: "Manual payment required: a refund exists on the payment." });
        if (b) alertPayout(p, "manual_required", "manual_required", d.reason);
        return result(ctx, b ? "manual_required" : "failed", false, "manual_required", d.reason);
      }
      case "needs_attention": {
        const moved = await transition({ id: p.id, from: ["transfer_requested"], to: "needs_attention", data: { errorCode: d.reason, lastError: REASON_TEXT[d.reason] ?? d.reason, lockedUntil: null, nextAttemptAt: null }, kind: "transfer", actor, note: `Parked: ${d.reason}.` });
        if (moved) alertPayout(p, "needs_attention", "needs_attention", d.reason);
        return result(ctx, moved ? "needs_attention" : (await loadPayout(p.id))?.status ?? null, false, "parked", d.reason);
      }
    }
  } finally {
    await dropLease(payoutId, lease);
  }
}

/**
 * Two or more live transfers carry this payout's id (the retry landed after the first create call did). Keep
 * one, park the payout for a person, and reverse every extra WHILE IT IS STILL ON HOLD (explicit amount: what
 * is left of each). The payout returns to `held` only through cleanUpDuplicates, after a listing proves one
 * live transfer remains.
 */
async function handleDuplicates(ctx: Ctx, p: PayoutRow, keep: RazorpayTransfer, extras: RazorpayTransfer[], now: Date, actor: PayoutActor): Promise<StepResult> {
  // Record the kept transfer's id (a payout that was found with no id yet; or the one it already carries).
  const r = await prisma.creatorPayout.updateMany({
    where: { id: p.id, status: p.status, OR: [{ razorpayTransferId: null }, { razorpayTransferId: keep.id }] },
    data: { razorpayTransferId: keep.id.slice(0, 64), transferStatus: statusOf(keep.status) },
  });
  if (r.count !== 1) return result(ctx, (await loadPayout(p.id))?.status ?? null, false, "lost_claim");
  const moved = await transition({
    id: p.id,
    from: [p.status as PayoutStatus],
    to: "needs_attention",
    data: { errorCode: "duplicate_transfer", lastError: REASON_TEXT.duplicate_transfer, lockedUntil: null, nextAttemptAt: new Date(now.getTime() + IN_FLIGHT_RECHECK_MS) },
    kind: "transfer",
    actor,
    note: `${extras.length + 1} transfers carry this payout; one is kept, the extras are being reversed.`,
  });
  if (!moved) return result(ctx, (await loadPayout(p.id))?.status ?? null, false, "lost_claim");
  alertPayout(p, "duplicate_transfer", "needs_attention", "duplicate_transfer", [{ label: "Kept", value: keep.id }, ...extras.map((e) => ({ label: "Extra", value: e.id }))]);
  const done = await reverseExtras(ctx, p, extras, actor);
  return result(ctx, "needs_attention", false, "duplicates", done ? "extras_reversed" : "extras_not_reversed");
}

/** Reverse what is left of each extra transfer (explicit amount). Returns true when every one is fully back. */
async function reverseExtras(ctx: Ctx, p: PayoutRow, extras: RazorpayTransfer[], actor: PayoutActor): Promise<boolean> {
  let all = true;
  for (const e of extras) {
    const left = e.amount - e.amount_reversed;
    if (isFullyReversed({ status: e.status, amount: e.amount, amountReversed: e.amount_reversed }) || e.status === "failed") continue;
    if (left <= 0) continue;
    try {
      await rz(ctx, () => reverseTransfer(e.id, left, { payout_id: p.id }));
      await recordEvent(p, "reversal", "needs_attention", "An extra transfer was reversed.", actor);
    } catch (err) {
      all = false;
      await recordEvent(p, "reversal", "needs_attention", `An extra transfer could not be reversed (${errCode(err)}).`, actor);
      alertPayout(p, "reversal_failed", "needs_attention", errCode(err), [{ label: "Extra transfer", value: e.id }]);
    }
  }
  return all;
}

/**
 * A payout parked as duplicate_transfer: list the payment's transfers again, reverse any extra that is still
 * alive, and once EXACTLY the kept one is alive hand the payout to confirmHold, which moves it back to `held`
 * on a fresh read of that transfer.
 */
export async function cleanUpDuplicates(payoutId: string, opts: StepOptions = {}): Promise<StepResult> {
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? SYSTEM;
  const ctx = newCtx(payoutId);
  const p0 = await loadPayout(payoutId);
  if (!p0) return result(ctx, null, false, "not_found");
  if (p0.status !== "needs_attention" || p0.errorCode !== "duplicate_transfer" || !p0.razorpayTransferId) return result(ctx, p0.status, false, "not_applicable");
  if (!razorpayConfig.configured()) return result(ctx, p0.status, false, "disabled", "not_configured");
  const lease = await takeLease(payoutId, ["needs_attention"], now);
  if (!lease) return result(ctx, p0.status, false, "leased");
  try {
    const p = (await loadPayout(payoutId))!;
    let listing: RazorpayTransfer[];
    try {
      listing = await rz(ctx, () => listAllPaymentTransfers(p.razorpayPaymentId), 2);
    } catch (err) {
      await backoff(p.id, "needs_attention", now, RETRY_BACKOFF_MS);
      return result(ctx, p.status, false, "unread", errCode(err));
    }
    const live = listing.filter((t) => t.notes.payout_id === p.id && t.status !== "failed" && !isFullyReversed({ status: t.status, amount: t.amount, amountReversed: t.amount_reversed }));
    const extras = live.filter((t) => t.id !== p.razorpayTransferId);
    if (extras.length > 0) {
      const ok = await reverseExtras(ctx, p, extras, actor);
      await backoff(p.id, "needs_attention", now, IN_FLIGHT_RECHECK_MS);
      return result(ctx, p.status, false, "extras_remaining", ok ? "reversed_now_recheck" : "reversal_failed");
    }
    if (!live.some((t) => t.id === p.razorpayTransferId)) {
      await backoff(p.id, "needs_attention", now, RETRY_BACKOFF_MS);
      return result(ctx, p.status, false, "kept_transfer_not_live", "kept_transfer_not_live");
    }
    return confirmHoldLocked(ctx, p, now, actor);
  } finally {
    await dropLease(payoutId, lease);
  }
}

// ── Confirming the hold ─────────────────────────────────────────────────────────

/** needs_attention reasons that a fresh read can resolve back to `held` (the hold was put back, or the duplicate is gone). */
export const HOLD_RESOLVABLE_REASONS: readonly string[] = ["processed_not_held", "processed_hold_expires", "released_outside_flow", "hold_expires"];

/**
 * Read the payout's transfer from Razorpay and confirm what it is:
 *   transfer_requested + processed + on_hold + no on_hold_until → held (and ONLY then: never on an unreported or
 *     false on_hold; a processed transfer that is not on hold is parked, the hold is put back, staff are told);
 *   created / pending → stays, looked at again in two minutes (the webhook normally gets there first);
 *   failed → failed.
 * Also the daily re-read of a `held` payout (anything done in the dashboard shows up here), and the resolution of a
 * needs_attention payout whose hold was put back.
 */
export async function confirmHold(payoutId: string, opts: StepOptions = {}): Promise<StepResult> {
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? SYSTEM;
  const ctx = newCtx(payoutId);
  const p0 = await loadPayout(payoutId);
  if (!p0) return result(ctx, null, false, "not_found");
  const eligible =
    (p0.status === "transfer_requested" && p0.razorpayTransferId !== null) ||
    p0.status === "held" ||
    (p0.status === "needs_attention" && p0.razorpayTransferId !== null && HOLD_RESOLVABLE_REASONS.includes(p0.errorCode ?? ""));
  if (!eligible) return result(ctx, p0.status, false, "not_applicable");
  if (!razorpayConfig.configured()) return result(ctx, p0.status, false, "disabled", "not_configured");
  const lease = await takeLease(payoutId, [p0.status as PayoutStatus], now);
  if (!lease) return result(ctx, p0.status, false, "leased");
  try {
    const p = (await loadPayout(payoutId))!;
    return await confirmHoldLocked(ctx, p, now, actor);
  } finally {
    await dropLease(payoutId, lease);
  }
}

async function confirmHoldLocked(ctx: Ctx, p: PayoutRow, now: Date, actor: PayoutActor): Promise<StepResult> {
  if (p.status === "transfer_requested" && p.attempts > 1) {
    // The request was repeated (see adoptTransfer): prove there is no twin before this transfer is called held.
    const readyAt = (p.transferRequestedAt?.getTime() ?? 0) + ABSENT_CHECK_GAP_MS;
    if (now.getTime() < readyAt) {
      await backoff(p.id, "transfer_requested", now, readyAt - now.getTime() + 60_000);
      return result(ctx, p.status, false, "audit_wait", "request_was_repeated");
    }
    let listing: RazorpayTransfer[];
    try {
      listing = await rz(ctx, () => listAllPaymentTransfers(p.razorpayPaymentId), 2);
    } catch (err) {
      await backoff(p.id, "transfer_requested", now, RETRY_BACKOFF_MS, { errorCode: "listing_failed" });
      return result(ctx, p.status, false, "unread", errCode(err));
    }
    const live = listing.filter((x) => x.notes.payout_id === p.id && x.status !== "failed" && !isFullyReversed({ status: x.status, amount: x.amount, amountReversed: x.amount_reversed }));
    const extras = live.filter((x) => x.id !== p.razorpayTransferId);
    const keep = live.find((x) => x.id === p.razorpayTransferId);
    if (extras.length > 0 && keep) return handleDuplicates(ctx, p, keep, extras, now, actor);
  }
  let t: RazorpayTransfer;
  try {
    t = await rz(ctx, () => fetchTransfer(p.razorpayTransferId!));
  } catch (err) {
    await backoff(p.id, p.status as PayoutStatus, now, RETRY_BACKOFF_MS, { errorCode: p.status === "needs_attention" ? p.errorCode : "fetch_failed" });
    return result(ctx, p.status, false, "unread", errCode(err));
  }
  if (!transferMatches(p, t)) return parkMismatch(ctx, p, t, actor);
  return applyFreshTransfer(ctx, p, t, now, actor);
}

/** The daily re-read of a held payout: confirmHold under the name the reconciliation job uses. */
export const recheckHeld = (payoutId: string, opts: StepOptions = {}): Promise<StepResult> => confirmHold(payoutId, opts);

// ── Release ─────────────────────────────────────────────────────────────────────

/** Did Razorpay's fresh transfer show the money already at the creator's bank? */
function settledAtBank(t: RazorpayTransfer): boolean {
  return t.recipient_settlement?.status?.toLowerCase() === "processed" || t.settlement_status === "settled";
}

/** The payment's disputes, asked of Razorpay (our campaign_disputes table is fed only by webhooks, so a missed event leaves no row). */
async function razorpayDisputeVerdict(ctx: Ctx, p: PayoutRow, now: Date): Promise<"clear" | "blocking" | "unchecked"> {
  try {
    const from = Math.max(0, Math.floor(p.createdAt.getTime() / 1000) - DISPUTE_LOOKBACK_S);
    const to = Math.floor(now.getTime() / 1000) + 3600;
    const list = await rz(ctx, () => listDisputes({ fromEpoch: from, toEpoch: to }), 2);
    return list.some((d) => d.payment_id === p.razorpayPaymentId && (d.status === null || !DISPUTE_NOT_BLOCKING.includes(d.status))) ? "blocking" : "clear";
  } catch {
    return "unchecked";
  }
}

async function accountVerdict(ctx: Ctx, p: PayoutRow, productId: string | null, rowMatches: boolean): Promise<"activated" | "not_activated" | "unchecked"> {
  if (!productId || !rowMatches) return "unchecked";
  try {
    const prod = await rz(ctx, () => fetchRouteProduct(p.razorpayAccountId, productId));
    return prod.activation_status === "activated" ? "activated" : "not_activated";
  } catch {
    return "unchecked";
  }
}

const viewOf = (t: RazorpayTransfer): TransferView => ({ id: t.id, status: t.status, onHold: t.on_hold, onHoldUntil: t.on_hold_until, amount: t.amount, amountReversed: t.amount_reversed, recipient: t.recipient, source: t.source });

/**
 * held → release_requested → released. THE money-out step; it moves nothing unless evaluateRelease says ok over
 * facts read fresh (see the policy for the full list). Order: local facts first (a local refusal costs no Razorpay
 * call), then a fresh read of the transfer, then Razorpay's dispute list and the account's activation, then the
 * CLAIM (a conditional update: two callers produce exactly one PATCH), a second look at the pause, the dispute
 * rows and the switch, and only then PATCH on_hold:false. The result is confirmed by a fresh read before the
 * payout is called released, and the creator's destination is frozen onto it then.
 *
 * Refusals write nothing and make no Razorpay write. A definite refusal of the PATCH puts the claim back to held;
 * an unknown answer keeps release_requested for resolveRelease.
 */
export async function releasePayout(payoutId: string, opts: StepOptions = {}): Promise<StepResult> {
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? SYSTEM;
  const ctx = newCtx(payoutId);
  const p = await loadPayout(payoutId);
  if (!p) return result(ctx, null, false, "not_found");
  if (!razorpayConfig.configured()) return result(ctx, p.status, false, "disabled", "not_configured");

  // 1. Local facts.
  const local = await loadLocalReleaseFacts(p, now);
  const localFacts: ReleaseFacts = { ...local, transfer: null, duplicateTransfers: "unchecked", razorpayDisputes: "unchecked", account: "unchecked" };
  const localDecision = evaluateLocalRelease(localFacts);
  if (!localDecision.ok) return result(ctx, p.status, false, "refused", localDecision.reason);

  // 2. The transfer, fresh.
  let t: RazorpayTransfer | null = null;
  try {
    t = await rz(ctx, () => fetchTransfer(p.razorpayTransferId!));
  } catch {
    t = null;
  }
  const transferDecision = evaluateTransferForRelease({ payout: localFacts.payout, transfer: t ? viewOf(t) : null });
  if (!transferDecision.ok) return result(ctx, p.status, false, "refused", transferDecision.reason);

  // 3. Razorpay's own word on duplicates, disputes and the account. A payout whose create call was only ever sent
  //    once cannot have a twin, so it costs no listing; one that was sent twice must prove it has none.
  let duplicateTransfers: ReleaseFacts["duplicateTransfers"] = "none";
  let extras: RazorpayTransfer[] = [];
  if (p.attempts > 1) {
    try {
      const listing = await rz(ctx, () => listAllPaymentTransfers(p.razorpayPaymentId), 2);
      extras = listing.filter((x) => x.notes.payout_id === p.id && x.id !== p.razorpayTransferId && x.status !== "failed" && !isFullyReversed({ status: x.status, amount: x.amount, amountReversed: x.amount_reversed }));
      duplicateTransfers = extras.length > 0 ? "found" : "none";
    } catch {
      duplicateTransfers = "unchecked";
    }
  }
  const razorpayDisputes = await razorpayDisputeVerdict(ctx, p, now);
  const account = await accountVerdict(ctx, p, local.productId, local.accountRowMatches);
  const full: ReleaseFacts = { ...localFacts, transfer: viewOf(t!), duplicateTransfers, razorpayDisputes, account };
  const decision = evaluateRelease(full);
  if (!decision.ok) {
    // Twins found at release time: nothing is released, the extras are reversed while they are on hold, and a person is told.
    if (decision.reason === "duplicate_transfer") await handleDuplicates(ctx, p, t!, extras, now, actor);
    return result(ctx, (await loadPayout(payoutId))?.status ?? p.status, false, "refused", decision.reason);
  }

  // 4. Claim. Conditional on the payout still being held and not paused: two callers make exactly one PATCH.
  if (opts.hooks?.beforeClaim) await opts.hooks.beforeClaim();
  const lease = new Date(now.getTime() + LEASE_MS);
  const claimed = await transition({
    id: p.id,
    from: ["held"],
    to: "release_requested",
    where: { pausedAt: null, OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
    data: { releaseRequestedAt: now, lockedUntil: lease, nextAttemptAt: null, errorCode: null },
    kind: "release",
    actor,
    note: "Release claimed: every release condition held on fresh facts.",
  });
  if (!claimed) return result(ctx, (await loadPayout(payoutId))?.status ?? null, false, "lost_claim");
  if (opts.hooks?.afterClaim) await opts.hooks.afterClaim();

  // 5. A pause, a dispute or the kill switch can land between the checks and the claim. Look once more, then PATCH.
  const again = (await loadPayout(payoutId))!;
  const second = evaluateLocalRelease({ ...(await loadLocalReleaseFacts({ ...again, status: "held" }, now)), transfer: null, duplicateTransfers: "unchecked", razorpayDisputes: "unchecked", account: "unchecked" });
  if (!second.ok) {
    await transition({ id: p.id, from: ["release_requested"], to: "held", data: { lockedUntil: null, nextAttemptAt: new Date(now.getTime() + RETRY_BACKOFF_MS) }, kind: "release", actor, note: `Release stopped before Razorpay was asked: ${second.reason}.` });
    return result(ctx, "held", false, "refused", second.reason);
  }

  // 6. PATCH on_hold:false.
  try {
    await rz(ctx, () => setTransferHold(p.razorpayTransferId!, false));
  } catch (err) {
    const code = errCode(err);
    if (isDefinitelyRejected(err)) {
      await transition({ id: p.id, from: ["release_requested"], to: "held", data: { errorCode: code, lastError: errText(err, "Razorpay refused the release"), lockedUntil: null, nextAttemptAt: new Date(now.getTime() + RETRY_BACKOFF_MS) }, kind: "release", actor, note: `Razorpay refused the release (${code}); the payout is held again.` });
      alertPayout(p, "release_failed", "held", code);
      return result(ctx, "held", false, "rejected", code);
    }
    await backoff(p.id, "release_requested", now, IN_FLIGHT_RECHECK_MS, { errorCode: "release_unconfirmed" });
    await recordEvent(p, "release", "release_requested", `The release request got no readable answer (${code}); it will be re-read.`, actor);
    return result(ctx, "release_requested", false, "unknown", code);
  }

  // 7. Confirm with a fresh read.
  return confirmRelease(ctx, p.id, now, actor);
}

async function confirmRelease(ctx: Ctx, payoutId: string, now: Date, actor: PayoutActor): Promise<StepResult> {
  const p = (await loadPayout(payoutId))!;
  let t: RazorpayTransfer;
  try {
    t = await rz(ctx, () => fetchTransfer(p.razorpayTransferId!));
  } catch (err) {
    await backoff(p.id, "release_requested", now, IN_FLIGHT_RECHECK_MS, { errorCode: "release_unconfirmed" });
    return result(ctx, p.status, false, "unknown", errCode(err));
  }
  if (!transferMatches(p, t)) return parkMismatch(ctx, p, t, actor);
  const out = await applyFreshTransfer(ctx, p, t, now, actor);
  if (out.outcome === "still_on_hold") {
    await backoff(p.id, "release_requested", now, IN_FLIGHT_RECHECK_MS, { errorCode: "release_unconfirmed" });
    return result(ctx, "release_requested", false, "unknown", "still_on_hold");
  }
  return out.status === "released" ? { ...out, ok: true, outcome: "released" } : out;
}

/**
 * A release that was claimed and never confirmed (the process died, or Razorpay's answer was lost) and whose
 * lease has run out. A fresh read decides: hold lifted → released; still on hold → the claim is put BACK to held
 * (the release gate runs again from the start next time); anything stranger parks for a person.
 */
export async function resolveRelease(payoutId: string, opts: StepOptions = {}): Promise<StepResult> {
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? SYSTEM;
  const ctx = newCtx(payoutId);
  const p0 = await loadPayout(payoutId);
  if (!p0) return result(ctx, null, false, "not_found");
  if (p0.status !== "release_requested" || !p0.razorpayTransferId) return result(ctx, p0.status, false, "not_applicable");
  if (!razorpayConfig.configured()) return result(ctx, p0.status, false, "disabled", "not_configured");
  const lease = await takeLease(payoutId, ["release_requested"], now);
  if (!lease) return result(ctx, p0.status, false, "leased");
  try {
    const p = (await loadPayout(payoutId))!;
    let t: RazorpayTransfer;
    try {
      t = await rz(ctx, () => fetchTransfer(p.razorpayTransferId!));
    } catch (err) {
      await backoff(p.id, "release_requested", now, RETRY_BACKOFF_MS, { errorCode: "release_unconfirmed" });
      return result(ctx, p.status, false, "unread", errCode(err));
    }
    if (!transferMatches(p, t)) return parkMismatch(ctx, p, t, actor);
    const dec = mapTransferFactsToState("release_requested", factsOf(t));
    if (dec.reason === "still_on_hold") {
      // The request may still be in flight at Razorpay (a timeout does not cancel it), so a hold seen soon after proves nothing.
      // Only after the wait is the claim put back and the gate run again from the start.
      if (p.nextAttemptAt !== null && p.nextAttemptAt.getTime() > now.getTime()) {
        await prisma.creatorPayout.updateMany({ where: { id: p.id, status: "release_requested" }, data: { ...columnsFrom(t, now), lockedUntil: null } });
        return result(ctx, p.status, false, "waiting", "release_unconfirmed");
      }
      const back = await transition({
        id: p.id,
        from: ["release_requested"],
        to: "held",
        data: { ...columnsFrom(t, now), errorCode: "release_abandoned", lastError: "A release was claimed but the hold was never lifted. The payout is held again; the release gate runs again before anything is released.", lockedUntil: null, nextAttemptAt: new Date(now.getTime() + RETRY_BACKOFF_MS) },
        kind: "release",
        actor,
        note: "The release never took effect at Razorpay; the payout is held again.",
      });
      if (back) alertPayout(p, "release_failed", "held", "release_abandoned");
      return result(ctx, back ? "held" : (await loadPayout(p.id))?.status ?? null, false, "put_back", "release_abandoned");
    }
    return applyFreshTransfer(ctx, p, t, now, actor);
  } finally {
    await dropLease(payoutId, lease);
  }
}

// ── Settlement ──────────────────────────────────────────────────────────────────

/**
 * Poll a released payout's settlement (fetch with expand[]=recipient_settlement), from the moment of release:
 * the settlement id is written as soon as Razorpay shows it (the settlement webhook links by it), a PROCESSED
 * settlement with a usable bank reference (UTR) → settled, a FAILED one → settlement_failed with an alert. "Paid"
 * exists only from this: transfer.processed and a released hold are never "paid". Also re-reads a
 * settlement_failed payout, which Razorpay may settle later.
 */
export async function pollSettlement(payoutId: string, opts: StepOptions = {}): Promise<StepResult> {
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? SYSTEM;
  const ctx = newCtx(payoutId);
  const p0 = await loadPayout(payoutId);
  if (!p0) return result(ctx, null, false, "not_found");
  if ((p0.status !== "released" && p0.status !== "settlement_failed") || !p0.razorpayTransferId) return result(ctx, p0.status, false, "not_applicable");
  if (!razorpayConfig.configured()) return result(ctx, p0.status, false, "disabled", "not_configured");
  const lease = await takeLease(payoutId, [p0.status as PayoutStatus], now);
  if (!lease) return result(ctx, p0.status, false, "leased");
  try {
    const p = (await loadPayout(payoutId))!;
    let t: RazorpayTransfer;
    try {
      t = await rz(ctx, () => fetchTransfer(p.razorpayTransferId!));
    } catch (err) {
      await backoff(p.id, p.status as PayoutStatus, now, RETRY_BACKOFF_MS, {});
      return result(ctx, p.status, false, "unread", errCode(err));
    }
    if (!transferMatches(p, t)) return parkMismatch(ctx, p, t, actor);
    const out = await applyFreshTransfer(ctx, p, t, now, actor);
    if (out.status === "released" && p.releasedAt && now.getTime() - p.releasedAt.getTime() > SETTLEMENT_SLOW_MS) {
      alertPayout(p, "settlement_slow", "released", "settlement_slow");
    }
    return out;
  } finally {
    await dropLease(payoutId, lease);
  }
}

// ── Reversal ────────────────────────────────────────────────────────────────────

async function priorStatusOfReversal(p: PayoutRow): Promise<string> {
  const ev = await prisma.creatorPayoutEvent.findFirst({ where: { payoutId: p.id, toStatus: "reversal_requested" }, orderBy: { createdAt: "desc" }, select: { fromStatus: true } });
  return ev?.fromStatus ?? (p.releasedAt ? "released" : "held");
}

export interface ReverseOptions extends StepOptions {
  /** Why (a short code: withdrawn, declined, expired, missed_window, rejected, item_refunded, dispute, account_suspended, staff). */
  reason: string;
}

/**
 * Take a creator's share back out of their linked account: held → reversal_requested → reversed.
 *
 *  • CLAIM first (held, released or settlement_failed → reversal_requested; needs_attention only for a staff
 *    actor), which also stops a release that has not started.
 *  • READ the transfer fresh, then reverse EXACTLY `amount − amount_reversed` (decideReversal) [R16]. Never
 *    "all" and never reverse_all: that would reverse every transfer of the payment, other creators' shares
 *    included [R14].
 *  • IDEMPOTENT: a transfer already fully reversed is success, and a repeated call never reverses twice.
 *  • A DEFINITE refusal puts the payout back where it was and alerts staff (held → held; anything released →
 *    needs_attention, because Razorpay only reverses already-settled money against a floating balance).
 *  • An UNKNOWN answer keeps reversal_requested and is read back (resolveReversal); it is never "held" and
 *    never "reversed" until Razorpay says so.
 */
export async function reversePayout(payoutId: string, opts: ReverseOptions): Promise<StepResult> {
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? SYSTEM;
  const ctx = newCtx(payoutId);
  const p0 = await loadPayout(payoutId);
  if (!p0) return result(ctx, null, false, "not_found");
  if (p0.status === "reversed") return result(ctx, "reversed", true, "already_reversed");
  if (p0.status === "planned" || p0.status === "void") return result(ctx, p0.status, false, "nothing_to_reverse");
  if (!razorpayConfig.configured()) return result(ctx, p0.status, false, "disabled", "not_configured");
  if (p0.status === "reversal_requested") {
    const lease = await takeLease(payoutId, ["reversal_requested"], now);
    if (!lease) return result(ctx, p0.status, false, "leased");
    try {
      return await runReversal(ctx, (await loadPayout(payoutId))!, await priorStatusOfReversal(p0), now, actor, opts.reason);
    } finally {
      await dropLease(payoutId, lease);
    }
  }
  const from: PayoutStatus[] = ["held", "released", "settlement_failed"];
  if (actor.type === "staff") from.push("needs_attention");
  if (!from.includes(p0.status as PayoutStatus)) return result(ctx, p0.status, false, "not_reversible", p0.status);
  const lease = new Date(now.getTime() + LEASE_MS);
  const claimed = await transition({
    id: p0.id,
    from,
    to: "reversal_requested",
    where: { OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
    data: { reversalRequestedAt: now, lockedUntil: lease, nextAttemptAt: null, errorCode: null },
    kind: "reversal",
    actor,
    note: `Reversal requested (${opts.reason}).`,
  });
  if (!claimed) return result(ctx, (await loadPayout(payoutId))?.status ?? null, false, "lost_claim");
  try {
    return await runReversal(ctx, (await loadPayout(payoutId))!, p0.status, now, actor, opts.reason);
  } finally {
    await dropLease(payoutId, lease);
  }
}

/** Put a reversal claim back (or park it) after a definite refusal. */
async function rollbackReversal(ctx: Ctx, p: PayoutRow, to: PayoutStatus, reasonCode: string, now: Date, actor: PayoutActor, err?: unknown): Promise<StepResult> {
  const moved = await transition({
    id: p.id,
    from: ["reversal_requested"],
    to,
    data: {
      errorCode: reasonCode.slice(0, 80),
      lastError: err ? errText(err, "Razorpay refused the reversal") : REASON_TEXT[reasonCode] ?? "The reversal could not be made.",
      lockedUntil: null,
      nextAttemptAt: to === "held" ? new Date(now.getTime() + RETRY_BACKOFF_MS) : null,
    },
    kind: "reversal",
    actor,
    note: to === "held" ? `The reversal was refused (${reasonCode}); the payout is held again.` : `The reversal was refused (${reasonCode}); a person must look.`,
  });
  if (moved) alertPayout(p, "reversal_failed", to, reasonCode);
  return result(ctx, moved ? to : (await loadPayout(p.id))?.status ?? null, false, "refused", reasonCode);
}

async function runReversal(ctx: Ctx, p: PayoutRow, prior: string, now: Date, actor: PayoutActor, why: string): Promise<StepResult> {
  if (!p.razorpayTransferId) {
    return rollbackReversal(ctx, p, "needs_attention", "reversal_failed_state", now, actor);
  }
  let fresh: RazorpayTransfer;
  try {
    fresh = await rz(ctx, () => fetchTransfer(p.razorpayTransferId!));
  } catch (err) {
    await backoff(p.id, "reversal_requested", now, IN_FLIGHT_RECHECK_MS, { errorCode: "reversal_unread" });
    return result(ctx, "reversal_requested", false, "unknown", errCode(err));
  }
  if (!transferMatches(p, fresh)) return parkMismatch(ctx, p, fresh, actor);

  const decision = decideReversal({
    payoutStatus: "reversal_requested",
    byStaff: actor.type === "staff",
    transfer: { status: fresh.status, amount: fresh.amount, amountReversed: fresh.amount_reversed },
  });
  if (decision.action === "already_reversed") return finishReversal(ctx, p, fresh.amount, null, now, actor, "Razorpay shows the whole transfer already reversed.", fresh);
  if (decision.action === "refuse") {
    // A transfer that is not processed yet is simply not reversible YET: back to where it was.
    if (decision.reason === "transfer_not_processed") return rollbackReversal(ctx, p, prior === "held" ? "held" : "needs_attention", "transfer_not_processed", now, actor);
    return rollbackReversal(ctx, p, "needs_attention", "reversal_failed_state", now, actor);
  }

  // A reversal request that got no answer a moment ago may still be in flight at Razorpay (a timeout does not cancel it). Reading
  // the transfer is always fine; asking again is not, until the wait is over: two requests for what is left would race.
  if (p.nextAttemptAt !== null && p.nextAttemptAt.getTime() > now.getTime()) {
    await prisma.creatorPayout.updateMany({ where: { id: p.id, status: "reversal_requested" }, data: { amountReversedPaise: fresh.amount_reversed, lastCheckedAt: now, lockedUntil: null } });
    return result(ctx, "reversal_requested", false, "waiting", "reversal_unconfirmed");
  }

  let reversal: { id: string; amount: number };
  try {
    reversal = await rz(ctx, () => reverseTransfer(fresh.id, decision.amountPaise, { payout_id: p.id }));
  } catch (err) {
    const out = decideReversalOutcome({
      priorStatus: prior,
      outcome: isDefinitelyRejected(err) ? "definite_rejection" : "unknown",
      transferOnHold: fresh.on_hold,
      transferSettled: settledAtBank(fresh),
    });
    if (out.to === null) {
      await backoff(p.id, "reversal_requested", now, IN_FLIGHT_RECHECK_MS, { errorCode: "reversal_unknown", lastError: "The reversal request got no readable answer from Razorpay. It is being reconciled by reading the transfer back." });
      await recordEvent(p, "reversal", "reversal_requested", `The reversal request got no readable answer (${errCode(err)}); reconciling.`, actor);
      return result(ctx, "reversal_requested", false, "unknown", errCode(err));
    }
    return rollbackReversal(ctx, p, out.to, out.reason, now, actor, err);
  }

  const total = fresh.amount_reversed + reversal.amount;
  if (total >= fresh.amount) return finishReversal(ctx, p, fresh.amount, reversal.id, now, actor, `Reversed the remaining amount (${why}).`, fresh);
  // A partial result (Razorpay reversed less than asked, or someone else reversed some meanwhile): keep the claim and finish next time.
  await prisma.creatorPayout.updateMany({ where: { id: p.id, status: "reversal_requested" }, data: { amountReversedPaise: total, razorpayReversalId: reversal.id.slice(0, 64), lockedUntil: null, nextAttemptAt: new Date(now.getTime() + IN_FLIGHT_RECHECK_MS) } });
  return result(ctx, "reversal_requested", false, "partial", "partially_reversed");
}

async function finishReversal(ctx: Ctx, p: PayoutRow, amount: number, reversalId: string | null, now: Date, actor: PayoutActor, text: string, fresh: RazorpayTransfer): Promise<StepResult> {
  let rid = reversalId;
  if (rid === null) {
    // Informational only (which reversal did it): a failed list never blocks the finish.
    try {
      const list = await rz(ctx, () => listTransferReversals(fresh.id));
      rid = list.find((r) => r.notes.payout_id === p.id)?.id ?? list[0]?.id ?? null;
    } catch {
      rid = null;
    }
  }
  const moved = await transition({
    id: p.id,
    from: ["reversal_requested"],
    to: "reversed",
    data: { reversedAt: now, amountReversedPaise: amount, transferStatus: "reversed", razorpayReversalId: rid ? rid.slice(0, 64) : null, errorCode: null, lastError: null, lockedUntil: null, nextAttemptAt: null },
    kind: "reversal",
    actor,
    note: text,
  });
  if (moved) return result(ctx, "reversed", true, "reversed");
  // The webhook may have finished it first: that is the same success.
  const cur = await loadPayout(p.id);
  return cur?.status === "reversed" ? result(ctx, "reversed", true, "already_reversed") : result(ctx, cur?.status ?? null, false, "lost_claim");
}

/** A reversal that was claimed and never finished (lease expired): read the transfer back and finish, or reverse what is left. */
export async function resolveReversal(payoutId: string, opts: Partial<ReverseOptions> = {}): Promise<StepResult> {
  return reversePayout(payoutId, { ...opts, reason: opts.reason ?? "reconcile" });
}

// ── Reverse before refund ───────────────────────────────────────────────────────

export interface RefundReadiness {
  /** True when the item's price may now be refunded to the brand: its payout is void, reversed, or none exists. */
  refundable: boolean;
  /**
   * no_payout | void (already) | voided (just now) | reversed | reversal_pending (a reversal is in flight, ask again) |
   * in_flight (a transfer is still being made: the refund waits) | blocked (a person must decide).
   */
  state: "no_payout" | "void" | "voided" | "reversed" | "reversal_pending" | "in_flight" | "blocked";
  payoutId: string | null;
  reason?: string;
  calls: number;
}

/**
 * THE step before any refund of a creator item's price (refundItem, reject, decline, expire, withdraw, the missed
 * window): make sure its payout can no longer pay anyone. Call it AFTER claiming the item or offer and OUTSIDE any
 * database transaction (it talks to Razorpay), and refund only when `refundable` is true.
 *
 *   no payout / void / reversed   → refundable.
 *   planned                       → voided now (nothing has left our balance).
 *   failed                        → voided (Razorpay refused it: no money moved).
 *   manual_required               → voided only when money provably never left or came back (no create call was ever
 *                                    sent, or it was reversed); otherwise blocked.
 *   held / reversal_requested     → reversePayout (explicit amount); refundable once it reads reversed.
 *   transfer_requested            → in_flight: the refund WAITS until the transfer settles into held [R4].
 *   anything released or settled, needs_attention → blocked: not a decision a refund may make.
 */
export async function reverseForRefund(itemId: string, opts: { actor?: PayoutActor; reason: string; now?: Date }): Promise<RefundReadiness> {
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? SYSTEM;
  const reason = opts.reason.slice(0, 40);
  const p = await prisma.creatorPayout.findUnique({ where: { bookingItemId: itemId } });
  if (!p) return { refundable: true, state: "no_payout", payoutId: null, calls: 0 };

  const voidIt = async (from: PayoutStatus, text: string): Promise<RefundReadiness> => {
    const moved = await transition({ id: p.id, from: [from], to: "void", data: { voidReason: reason, lockedUntil: null, nextAttemptAt: null }, kind: "void", actor, note: text });
    if (moved) return { refundable: true, state: "voided", payoutId: p.id, calls: 0 };
    const cur = await loadPayout(p.id);
    if (cur?.status === "void") return { refundable: true, state: "void", payoutId: p.id, calls: 0 };
    return { refundable: false, state: "blocked", payoutId: p.id, reason: "payout_moved", calls: 0 };
  };

  switch (p.status) {
    case "void":
      return { refundable: true, state: "void", payoutId: p.id, calls: 0 };
    case "reversed":
      return { refundable: true, state: "reversed", payoutId: p.id, calls: 0 };
    case "planned":
      return voidIt("planned", `Voided before any money moved (${reason}).`);
    case "failed":
      return voidIt("failed", `Voided: Razorpay refused the transfer, so no money moved (${reason}).`);
    case "manual_required": {
      const proven = p.reversedAt !== null || (p.razorpayTransferId === null && p.attempts === 0);
      return proven ? voidIt("manual_required", `Voided: no money is out (${reason}).`) : { refundable: false, state: "blocked", payoutId: p.id, reason: "manual_required_unproven", calls: 0 };
    }
    case "transfer_requested":
      return { refundable: false, state: "in_flight", payoutId: p.id, reason: "transfer_in_flight", calls: 0 };
    case "held":
    case "reversal_requested": {
      const r = await reversePayout(p.id, { reason, actor, now });
      if (r.status === "reversed") return { refundable: true, state: "reversed", payoutId: p.id, calls: r.calls };
      if (r.outcome === "unknown" || r.outcome === "partial" || r.outcome === "leased" || r.status === "reversal_requested") return { refundable: false, state: "reversal_pending", payoutId: p.id, reason: r.outcome, calls: r.calls };
      return { refundable: false, state: "blocked", payoutId: p.id, reason: r.reason ?? r.outcome, calls: r.calls };
    }
    default:
      return { refundable: false, state: "blocked", payoutId: p.id, reason: `payout_${p.status}`, calls: 0 };
  }
}

// ── For the refund, offer and capture code: small database reads and one write ───

/**
 * Whether a refund may start on a payment now, from our own records (no Razorpay call): payouts of the payment that
 * are still `planned` or `transfer_requested` block it [R4], and once any refund exists a payout that can no longer be
 * transferred is listed as manual. See decideRefundAllowed. The refund sweep and every refund of a creator item ask this.
 */
export async function refundAllowanceForPayment(razorpayPaymentId: string): Promise<RefundAllowance> {
  const [payouts, refundsExist] = await Promise.all([
    prisma.creatorPayout.findMany({ where: { razorpayPaymentId }, select: { id: true, status: true, itemPricePaise: true } }),
    refundExistsFor(razorpayPaymentId),
  ]);
  return decideRefundAllowed(payouts, refundsExist);
}

/**
 * P4 "Reserved amount" for one Razorpay payment: the item price of every creator item whose payout is not reversed or
 * void. A payment's refundable amount is what it captured, less what was refunded, less this. Pass a transaction client
 * to read it inside the caller's transaction.
 */
export async function reservedPaiseForPayment(razorpayPaymentId: string, db: Pick<Prisma.TransactionClient, "creatorPayout"> = prisma): Promise<number> {
  const rows = await db.creatorPayout.findMany({ where: { razorpayPaymentId }, select: { status: true, itemPricePaise: true } });
  return reservedPaiseOf(rows);
}

/**
 * Schedules the release of a creator item's payout once staff verified the link: release_after = verified_at +
 * CREATOR_PAYOUT_HOLD_DAYS, and AT LEAST one day when the ownership of the post was checked by hand. Only the FIRST
 * scheduling counts (a payout that already has a release_after keeps it), and only a payout that can still be
 * released is touched. Never throws: a failure here is the reconciliation job's to repair, never a reason to undo a
 * verification that already committed.
 */
export async function scheduleRelease(
  itemId: string,
  o: { ownershipCheck: string | null; verifiedAt?: Date; holdDays?: number; actor?: PayoutActor },
): Promise<{ scheduled: boolean; payoutId: string | null; releaseAfter: Date | null; reason?: string }> {
  try {
    const p = await prisma.creatorPayout.findUnique({ where: { bookingItemId: itemId }, select: { id: true, bookingId: true, amountPaise: true, status: true } });
    if (!p) return { scheduled: false, payoutId: null, releaseAfter: null, reason: "no_payout" };
    const at = releaseAfter(o.verifiedAt ?? new Date(), o.ownershipCheck, o.holdDays ?? payoutHoldDays());
    const r = await prisma.creatorPayout.updateMany({
      where: { id: p.id, releaseAfter: null, status: { in: ["planned", "transfer_requested", "held", "needs_attention"] } },
      data: { releaseAfter: at, nextAttemptAt: null },
    });
    if (r.count !== 1) return { scheduled: false, payoutId: p.id, releaseAfter: null, reason: `not_schedulable_${p.status}` };
    await recordEvent(p, "schedule", p.status, `Release scheduled after the post was verified (${o.ownershipCheck === "auto_ok" ? "ownership checked automatically" : "ownership checked by hand: at least one day"}).`, o.actor ?? SYSTEM);
    return { scheduled: true, payoutId: p.id, releaseAfter: at };
  } catch (err) {
    console.error(`[payout-engine] scheduleRelease failed: ${errCode(err)}`);
    return { scheduled: false, payoutId: null, releaseAfter: null, reason: "error" };
  }
}

// ── Staff: retry, manual, pause ─────────────────────────────────────────────────

/**
 * Staff Retry of a `failed` payout: allowed only while nothing has been refunded on the payment [R4], while it is
 * not paused, and only when a listing proves no live transfer already carries this payout's id. The failed transfer's
 * id is dropped (the retry makes a NEW transfer); the attempt counter restarts.
 */
export async function retryFailedPayout(payoutId: string, opts: StepOptions = {}): Promise<StepResult> {
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? SYSTEM;
  const ctx = newCtx(payoutId);
  const p = await loadPayout(payoutId);
  if (!p) return result(ctx, null, false, "not_found");
  if (p.status !== "failed") return result(ctx, p.status, false, "not_failed");
  if (!transfersEnabled()) return result(ctx, p.status, false, "disabled", "route_off_or_not_configured");
  const facts = await loadCreateFacts(p);
  if (!canRetryFailedTransfer({ status: p.status, refundExists: facts.refundExists })) return result(ctx, p.status, false, "retry_disabled", "refund_exists");
  const decision = decideTransferCreation(facts);
  if (decision.action !== "create") return result(ctx, p.status, false, "waiting", decision.reason);
  let listing: RazorpayTransfer[];
  try {
    listing = await rz(ctx, () => listAllPaymentTransfers(p.razorpayPaymentId), 2);
  } catch (err) {
    return result(ctx, p.status, false, "unread", errCode(err));
  }
  const live = listing.filter((t) => t.notes.payout_id === p.id && t.status !== "failed" && !isFullyReversed({ status: t.status, amount: t.amount, amountReversed: t.amount_reversed }));
  if (live.length > 0) return result(ctx, p.status, false, "transfer_still_active", "transfer_still_active");
  const claimed = await transition({
    id: p.id,
    from: ["failed"],
    to: "transfer_requested",
    where: { pausedAt: null, OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
    data: { razorpayTransferId: null, attempts: 1, absentChecks: 0, transferRequestedAt: now, lockedUntil: new Date(now.getTime() + LEASE_MS), nextAttemptAt: null, errorCode: null, lastError: null },
    kind: "transfer",
    actor,
    note: "Staff retried the failed transfer.",
  });
  if (!claimed) return result(ctx, (await loadPayout(payoutId))?.status ?? null, false, "lost_claim");
  return performCreate(ctx, (await loadPayout(payoutId))!, now, actor);
}

/**
 * Staff mark a payout as one that must be paid by bank transfer (planned, failed, reversed or parked). This only
 * RECORDS the decision: paid_manual is reachable only through markManualPaid, which re-checks that no transfer could
 * still release.
 */
export async function requireManualPayment(payoutId: string, opts: StepOptions & { reason: string }): Promise<StepResult> {
  const ctx = newCtx(payoutId);
  const actor = opts.actor ?? SYSTEM;
  const p = await loadPayout(payoutId);
  if (!p) return result(ctx, null, false, "not_found");
  if (p.status === "manual_required") return result(ctx, p.status, true, "already_manual_required");
  const from = (["planned", "failed", "reversed", "needs_attention"] as PayoutStatus[]).filter((s) => s === p.status);
  if (from.length === 0) return result(ctx, p.status, false, "not_applicable");
  if (p.status === "needs_attention" && actor.type !== "staff") return result(ctx, p.status, false, "needs_human");
  const moved = await transition({ id: p.id, from, to: "manual_required", data: { errorCode: opts.reason.slice(0, 80), lockedUntil: null, nextAttemptAt: null }, kind: "manual", actor, note: `Manual payment required (${opts.reason}).` });
  return result(ctx, moved ? "manual_required" : (await loadPayout(payoutId))?.status ?? null, moved, moved ? "manual_required" : "lost_claim");
}

const REFERENCE_RE = /^[A-Za-z0-9][A-Za-z0-9 _./:#-]{3,99}$/;
const PAN_SHAPE = /[A-Za-z]{5}[0-9]{4}[A-Za-z]/;
const IFSC_SHAPE = /[A-Za-z]{4}0[A-Za-z0-9]{6}/;

/**
 * manual_required → paid_manual. Staff paid the creator by bank transfer and record the reference. Refused unless
 * no transfer can still release money (decideManualFallback): none was ever created, or a fresh read shows it
 * failed with no other live transfer carrying this payout's id, or it was reversed and the whole transfer is
 * back. Paying by hand while a transfer could still release is paying twice.
 */
export async function markManualPaid(payoutId: string, opts: StepOptions & { reference: string; note?: string }): Promise<StepResult> {
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? SYSTEM;
  const ctx = newCtx(payoutId);
  const p = await loadPayout(payoutId);
  if (!p) return result(ctx, null, false, "not_found");
  const reference = (opts.reference ?? "").trim();
  if (!REFERENCE_RE.test(reference) || PAN_SHAPE.test(reference) || IFSC_SHAPE.test(reference)) return result(ctx, p.status, false, "invalid_reference");
  if (p.status !== "manual_required") return result(ctx, p.status, false, "not_manual_required");

  // Fresh facts, read only when the decision needs them.
  let transfer: { status: string; amount: number; amountReversed: number } | null = null;
  let transferChecked = false;
  let activeCarriers: number | null = null;
  const needsListing = p.razorpayTransferId !== null || p.attempts > 0;
  if (needsListing) {
    if (!razorpayConfig.configured()) return result(ctx, p.status, false, "refused", "listing_unchecked");
    try {
      const listing = await rz(ctx, () => listAllPaymentTransfers(p.razorpayPaymentId), 2);
      activeCarriers = listing.filter((t) => t.notes.payout_id === p.id && t.status !== "failed" && !isFullyReversed({ status: t.status, amount: t.amount, amountReversed: t.amount_reversed })).length;
    } catch {
      activeCarriers = null;
    }
    if (p.razorpayTransferId !== null) {
      try {
        const t = await rz(ctx, () => fetchTransfer(p.razorpayTransferId!));
        transfer = { status: t.status, amount: t.amount, amountReversed: t.amount_reversed };
        transferChecked = true;
      } catch {
        transferChecked = false;
      }
    }
  }
  const d = decideManualFallback({ status: p.status, transferId: p.razorpayTransferId, attempts: p.attempts, reversedAt: p.reversedAt, transfer, transferChecked, activeCarriers });
  if (!d.ok) return result(ctx, p.status, false, "refused", d.reason);

  const moved = await transition({
    id: p.id,
    from: ["manual_required"],
    to: "paid_manual",
    data: { manualReference: reference, manualPaidAt: now, manualPaidById: actor.id ?? null, manualNote: opts.note ? scrubPayoutSecrets(opts.note).slice(0, 500) : null, errorCode: null, lastError: null, lockedUntil: null, nextAttemptAt: null },
    kind: "manual",
    actor,
    note: `Paid by bank transfer (${d.basis}). Reference recorded.`,
  });
  return result(ctx, moved ? "paid_manual" : (await loadPayout(payoutId))?.status ?? null, moved, moved ? "paid_manual" : "lost_claim", moved ? d.basis : undefined);
}

/** Staff pause: nothing about the payout moves until it is resumed. Idempotent. */
export async function pausePayout(payoutId: string, opts: StepOptions & { reason?: string } = {}): Promise<StepResult> {
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? SYSTEM;
  const ctx = newCtx(payoutId);
  const outcome = await prisma.$transaction(async (tx) => {
    const cur = await tx.creatorPayout.findUnique({ where: { id: payoutId }, select: { status: true, bookingId: true, amountPaise: true, pausedAt: true } });
    if (!cur) return { status: null as string | null, outcome: "not_found" };
    if (!(PAUSABLE_STATUSES as readonly string[]).includes(cur.status)) return { status: cur.status, outcome: "not_pausable" };
    if (cur.pausedAt) return { status: cur.status, outcome: "already_paused" };
    const r = await tx.creatorPayout.updateMany({ where: { id: payoutId, pausedAt: null, status: { in: [...PAUSABLE_STATUSES] } }, data: { pausedAt: now, pausedReason: "staff" } });
    if (r.count !== 1) return { status: cur.status, outcome: "lost_race" };
    await tx.creatorPayoutEvent.create({
      data: { payoutId, bookingId: cur.bookingId, kind: "pause", fromStatus: cur.status, toStatus: cur.status, amountPaise: cur.amountPaise, actorType: actor.type, actorId: actor.id ?? null, note: note(`Paused${opts.reason ? ` (${opts.reason})` : ""}.`) },
    });
    return { status: cur.status, outcome: "paused" };
  });
  return result(ctx, outcome.status, outcome.outcome === "paused" || outcome.outcome === "already_paused", outcome.outcome);
}

/**
 * Staff resume. Refused while anything that caused a pause still holds (decideResume): a dispute that is not won, a
 * bank change in flight, a linked account that is not activated. The release gate checks all of it again at release.
 */
export async function resumePayout(payoutId: string, opts: StepOptions = {}): Promise<StepResult> {
  const actor = opts.actor ?? SYSTEM;
  const ctx = newCtx(payoutId);
  const p = await loadPayout(payoutId);
  if (!p) return result(ctx, null, false, "not_found");
  const now = opts.now ?? new Date();
  const [disputes, acct] = await Promise.all([
    prisma.campaignDispute.findMany({ where: { razorpayPaymentId: p.razorpayPaymentId }, select: { status: true } }),
    prisma.creatorPayoutAccount.findUnique({ where: { id: p.payoutAccountId }, select: { activationStatus: true, razorpayAccountId: true, bankChangeRequestedAt: true, bankChangeClearedAt: true } }),
  ]);
  const d = decideResume({
    paused: p.pausedAt !== null,
    disputeStatuses: disputes.map((x) => x.status),
    bankChangeBlocks: acct ? bankChangeBlocksRelease(acct, now) : false,
    accountActivated: acct?.activationStatus === "activated" && acct.razorpayAccountId === p.razorpayAccountId,
  });
  if (!d.ok) return result(ctx, p.status, false, "refused", d.reason);
  const moved = await prisma.$transaction(async (tx) => {
    const r = await tx.creatorPayout.updateMany({ where: { id: payoutId, pausedAt: { not: null } }, data: { pausedAt: null, pausedReason: null } });
    if (r.count !== 1) return false;
    await tx.creatorPayoutEvent.create({
      data: { payoutId, bookingId: p.bookingId, kind: "resume", fromStatus: p.status, toStatus: p.status, amountPaise: p.amountPaise, actorType: actor.type, actorId: actor.id ?? null, note: "Resumed." },
    });
    return true;
  });
  return result(ctx, p.status, moved, moved ? "resumed" : "lost_race");
}

// ── Disputes: put a released payout's hold back ─────────────────────────────────

/**
 * A dispute opened (or a refund we did not make appeared) on a payment whose payout was ALREADY released but
 * has not settled: try to put the hold back with PATCH on_hold:true (UNVERIFIED for a released transfer: plan
 * question d) and confirm it with a fresh read, then released → held. It does not reverse the transfer by itself
 * (that takes money back out of the creator's account, a person's call); if the hold cannot be put back, or the
 * money has already settled, staff are told at once and the payout stays released.
 */
export async function reholdReleasedPayout(payoutId: string, opts: StepOptions = {}): Promise<StepResult> {
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? SYSTEM;
  const ctx = newCtx(payoutId);
  const p0 = await loadPayout(payoutId);
  if (!p0) return result(ctx, null, false, "not_found");
  if (p0.status !== "released" || !p0.razorpayTransferId) return result(ctx, p0.status, false, "not_applicable");
  if (!razorpayConfig.configured()) return result(ctx, p0.status, false, "disabled", "not_configured");
  const lease = await takeLease(payoutId, ["released"], now);
  if (!lease) return result(ctx, p0.status, false, "leased");
  try {
    const p = (await loadPayout(payoutId))!;
    let t: RazorpayTransfer;
    try {
      t = await rz(ctx, () => fetchTransfer(p.razorpayTransferId!));
    } catch (err) {
      await backoff(p.id, "released", now, RETRY_BACKOFF_MS);
      return result(ctx, p.status, false, "unread", errCode(err));
    }
    if (!transferMatches(p, t)) return parkMismatch(ctx, p, t, actor);
    if (settledAtBank(t)) {
      alertPayout(p, "rehold", "released", "already_settled");
      return result(ctx, p.status, false, "already_settled", "already_settled");
    }
    if (!t.on_hold) {
      try {
        await rz(ctx, () => setTransferHold(t.id, true));
      } catch (err) {
        const code = errCode(err);
        await backoff(p.id, "released", now, 60 * 60_000);
        await recordEvent(p, "transfer", "released", `The hold could not be put back (${code}).`, actor);
        alertPayout(p, "rehold", "released", code);
        return result(ctx, p.status, false, isDefinitelyRejected(err) ? "rejected" : "unknown", code);
      }
      try {
        t = await rz(ctx, () => fetchTransfer(p.razorpayTransferId!));
      } catch (err) {
        await backoff(p.id, "released", now, IN_FLIGHT_RECHECK_MS);
        return result(ctx, p.status, false, "unknown", errCode(err));
      }
    }
    if (t.on_hold && t.on_hold_until === null && t.status === "processed" && t.amount_reversed === 0 && !settledAtBank(t)) {
      const moved = await transition({
        id: p.id,
        from: ["released"],
        to: "held",
        data: { ...columnsFrom(t, now), heldAt: now, onHoldVerifiedAt: now, errorCode: null, lastError: null, lockedUntil: null, nextAttemptAt: null },
        kind: "transfer",
        actor,
        note: "The hold was put back on a released transfer (dispute protection); a fresh read confirms it.",
      });
      if (moved) alertPayout(p, "reheld", "held", "reheld");
      return result(ctx, moved ? "held" : (await loadPayout(payoutId))?.status ?? null, moved, moved ? "reheld" : "lost_claim");
    }
    alertPayout(p, "rehold", "released", "hold_not_confirmed");
    await backoff(p.id, "released", now, 60 * 60_000);
    return result(ctx, p.status, false, "not_confirmed", "hold_not_confirmed");
  } finally {
    await dropLease(payoutId, lease);
  }
}

// ── For the reconciliation job ──────────────────────────────────────────────────

export const PAYOUT_JOBS = [
  "execute",
  "resolve_unknown",
  "confirm_hold",
  "cleanup_duplicates",
  "release",
  "resolve_release",
  "poll_settlement",
  "resolve_reversal",
  "recheck_held",
  "rehold_paused",
] as const;
export type PayoutJob = (typeof PAYOUT_JOBS)[number];

/** Run one reconciliation job on one payout. */
export function runPayoutJob(job: PayoutJob, payoutId: string, opts: StepOptions = {}): Promise<StepResult> {
  switch (job) {
    case "execute":
      return executePlannedPayout(payoutId, opts);
    case "resolve_unknown":
      return resolveUnknownTransfer(payoutId, opts);
    case "confirm_hold":
      return confirmHold(payoutId, opts);
    case "cleanup_duplicates":
      return cleanUpDuplicates(payoutId, opts);
    case "release":
      return releasePayout(payoutId, opts);
    case "resolve_release":
      return resolveRelease(payoutId, opts);
    case "poll_settlement":
      return pollSettlement(payoutId, opts);
    case "resolve_reversal":
      return resolveReversal(payoutId, opts);
    case "recheck_held":
      return recheckHeld(payoutId, opts);
    case "rehold_paused":
      return reholdReleasedPayout(payoutId, opts);
  }
}

/**
 * The payouts each job should look at now, in the plan's order (P4 reconciliation jobs 1 to 9), oldest first. A row
 * leased by another step, or backed off to a later time, is not due. `release` lists only held payouts whose
 * release_after has passed and that are not paused: releasePayout still evaluates the whole gate.
 */
export async function selectDuePayouts(now: Date, limit = 50): Promise<Array<{ id: string; job: PayoutJob }>> {
  const unleased: Prisma.CreatorPayoutWhereInput = { OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] };
  const due: Prisma.CreatorPayoutWhereInput = { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] };
  const q = (where: Prisma.CreatorPayoutWhereInput, order: "createdAt" | "lastCheckedAt" = "createdAt") =>
    prisma.creatorPayout.findMany({ where: { AND: [where, unleased] }, select: { id: true }, orderBy: order === "createdAt" ? { createdAt: "asc" } : { lastCheckedAt: "asc" }, take: limit });
  const dayAgo = new Date(now.getTime() - HELD_RECHECK_MS);
  const [execute, unknown, confirm, dup, release, resolveRel, settle, reversal, recheck, rehold] = await Promise.all([
    q({ status: "planned", pausedAt: null }),
    q({ status: "transfer_requested", razorpayTransferId: null, AND: [due] }),
    q({ status: "transfer_requested", razorpayTransferId: { not: null }, AND: [due] }),
    q({ status: "needs_attention", errorCode: "duplicate_transfer", AND: [due] }),
    q({ status: "held", pausedAt: null, releaseAfter: { lte: now }, AND: [due] }),
    q({ status: "release_requested" }),
    q({ status: { in: ["released", "settlement_failed"] }, AND: [due] }),
    q({ status: "reversal_requested", AND: [due] }),
    q({ status: "held", OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: dayAgo } }] }, "lastCheckedAt"),
    // Only a dispute or an outside refund pauses a released payout in a way that asks for its hold back (a staff pause is the staff's to act on).
    q({ status: "released", pausedAt: { not: null }, pausedReason: { in: ["dispute", "external_refund"] }, AND: [due] }),
  ]);
  const out: Array<{ id: string; job: PayoutJob }> = [];
  const seen = new Set<string>();
  const add = (rows: Array<{ id: string }>, job: PayoutJob) => {
    for (const r of rows) {
      if (seen.has(r.id) || out.length >= limit) continue;
      seen.add(r.id);
      out.push({ id: r.id, job });
    }
  };
  add(execute, "execute");
  add(unknown, "resolve_unknown");
  add(confirm, "confirm_hold");
  add(dup, "cleanup_duplicates");
  add(rehold, "rehold_paused");
  add(release, "release");
  add(resolveRel, "resolve_release");
  add(settle, "poll_settlement");
  add(reversal, "resolve_reversal");
  add(recheck, "recheck_held");
  return out;
}
