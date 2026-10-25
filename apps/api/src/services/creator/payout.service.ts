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
 *   markManualPaid         manual_required → paid_manual           (only for a live, verified post, and when no transfer can release)
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
  fetchTransferSettlement,
  fetchPaymentRefunds,
  refundedTotalPaise,
  listDisputes,
  fetchRouteProduct,
  type RazorpayTransfer,
} from "../campaign/razorpay";
import { scrubPayoutSecrets } from "../../utils/payout-scrub";
import { alertStaffOncePerHour } from "./payout-alert";
import { bankChangeBlocksRelease } from "./payout-account-view";
import { pausePayoutsOfPayment } from "./payout-pause";
import { PAUSABLE_STATUSES, canMove, type PayoutStatus, type TransferFacts } from "./payout-states";
import {
  ABSENT_CHECK_GAP_MS,
  DISPUTE_NOT_BLOCKING,
  canRetryFailedTransfer,
  decideManualFallback,
  decideRefundAllowed,
  decideRefundVerdict,
  decideResume,
  decideReversal,
  decideReversalOutcome,
  decideTransferCreation,
  decideTransferRetry,
  evaluateLocalRelease,
  evaluateRelease,
  evaluateRemoteForRelease,
  evaluateTransferForRelease,
  heldAnomalyBackoffMs,
  isFullyReversed,
  LIVE_ITEM_STATUSES_FOR_RELEASE,
  mapTransferFactsToState,
  plannedWaitBackoffMs,
  releaseAfter,
  releaseRefusalBackoffMs,
  requestKeyOf,
  reservedPaiseOf,
  type CarrierTransfer,
  type RefundAllowance,
  type ReleaseFacts,
  type ReleaseRefusal,
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
  /**
   * Also pause the payout, in the same transaction, unless it is paused already (an existing pause and its reason are kept). The status write
   * locks the row first, so a pause landing meanwhile is either seen here (and kept) or waits for this one.
   */
  pause?: { at: Date; reason: string };
}): Promise<boolean> {
  for (const f of a.from) if (!canMove(f, a.to)) throw new Error(`illegal payout move ${f} -> ${a.to}`);
  return prisma.$transaction(async (tx) => {
    const cur = await tx.creatorPayout.findUnique({ where: { id: a.id }, select: { status: true, bookingId: true, amountPaise: true } });
    if (!cur || !a.from.includes(cur.status as PayoutStatus)) return false;
    const r = await tx.creatorPayout.updateMany({ where: { ...a.where, id: a.id, status: cur.status }, data: { ...a.data, status: a.to } });
    if (r.count !== 1) return false;
    if (a.pause) await tx.creatorPayout.updateMany({ where: { id: a.id, pausedAt: null }, data: { pausedAt: a.pause.at, pausedReason: a.pause.reason } });
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
  refund_conflict: "A creator payout was stopped: a refund of the brand's payment is not accounted for",
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
/**
 * A payout that can never be transferred because a refund exists on its payment [R4]. It is NOT "pay the creator": only a post that went live and
 * was verified is owed (markManualPaid refuses any other), and a payout that never got as far as a transfer belongs to a post never offered.
 */
const REFUND_EXISTS_TEXT =
  "A refund exists on the brand's payment, so no transfer can be made from it. If the creator's post is live and verified, pay them by bank transfer; if it never went live, nothing is owed: refund the post from the campaign page.";

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
  transfer_unknown_after_retry: "The transfer request was repeated once and no transfer ever showed up in Razorpay. It is looked for again every hour, and adopted if it appears. A person must check Razorpay: if the transfer is there, give its id in the payout queue; if there is none, record that there, then stop the payout. A post that never went live is owed nothing: refund it from the campaign page once the payout is stopped (only a live, verified post is paid by bank transfer).",
  reversal_refused: "Razorpay refused to take the transfer back. Nothing changed; check Razorpay.",
  reversal_refused_after_release: "Razorpay refused to take the transfer back (if it had been released, it may already have settled to the creator's bank, or the linked account may no longer hold it). Check Razorpay and the linked account's balance.",
  reversal_failed_state: "The transfer could not be reversed in its current state. Check Razorpay.",
  transfer_failed: "Razorpay reports the transfer failed.",
  listing_unreadable: "Razorpay's list of this payment's transfers could not be read for half an hour, so nobody can tell whether this payout's transfer exists. Nothing is repeated or refunded meanwhile, and it is re-checked every hour. Look in the Razorpay dashboard: if the transfer is there, give its id in the payout queue; if there is none, record that in the payout queue.",
  live_transfer_found: "A live transfer carrying this payout's id was found on a payout that had been marked failed or manual. It is being tracked again; nothing is refunded or paid by hand until it is reversed or confirmed.",
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
type LocalReleaseFacts = Omit<ReleaseFacts, "transfer" | "duplicateTransfers" | "razorpayDisputes" | "razorpayRefunds" | "account"> & { productId: string | null; hint: string | null; accountRowMatches: boolean };

/** The facts only Razorpay can add to the local ones, all "unchecked" until they are read. */
const UNREAD_REMOTE = { transfer: null, duplicateTransfers: "unchecked", razorpayDisputes: "unchecked", razorpayRefunds: "unchecked", account: "unchecked" } as const satisfies Pick<ReleaseFacts, "transfer" | "duplicateTransfers" | "razorpayDisputes" | "razorpayRefunds" | "account">;

async function loadLocalReleaseFacts(p: PayoutRow, now: Date, actor: PayoutActor = SYSTEM): Promise<LocalReleaseFacts> {
  const [releaseEnabled, booking, item, offer, disputes, acct, creator] = await Promise.all([
    releaseSwitchOn(),
    prisma.campaignBooking.findUnique({ where: { id: p.bookingId }, select: { status: true } }),
    prisma.campaignBookingItem.findUnique({ where: { id: p.bookingItemId }, select: { status: true } }),
    prisma.creatorOffer.findUnique({ where: { bookingItemId: p.bookingItemId }, select: { status: true, linkVerifiedAt: true, ownershipCheck: true } }),
    prisma.campaignDispute.findMany({ where: { razorpayPaymentId: p.razorpayPaymentId }, select: { status: true } }),
    prisma.creatorPayoutAccount.findUnique({
      where: { id: p.payoutAccountId },
      select: { razorpayAccountId: true, razorpayProductId: true, destinationHint: true, bankChangeRequestedAt: true, bankChangeClearedAt: true, activationStatus: true },
    }),
    prisma.creator.findUnique({ where: { id: p.creatorId }, select: { status: true } }),
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
    creatorStatus: creator?.status ?? null,
    byStaff: actor.type === "staff",
    accountActivation: acct?.activationStatus ?? null,
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

// ── Transfers of the payment that carry this payout's id ────────────────────────

/** The LIVE transfers (not failed, not fully reversed) of a payment's listing that carry this payout's id, whichever request made them. */
function liveCarriersOf(listing: readonly RazorpayTransfer[], payoutId: string): RazorpayTransfer[] {
  return listing.filter((t) => t.notes.payout_id === payoutId && t.status !== "failed" && !isFullyReversed({ status: t.status, amount: t.amount, amountReversed: t.amount_reversed }));
}

/** Every transfer of the payment, or null when the listing could not be read: an unread list is never an empty one. */
async function readListing(ctx: Ctx, p: Pick<PayoutRow, "razorpayPaymentId">): Promise<RazorpayTransfer[] | null> {
  try {
    return await rz(ctx, () => listAllPaymentTransfers(p.razorpayPaymentId), 2);
  } catch {
    return null;
  }
}

const ATTEST_KIND = "attest_no_transfer";

/**
 * A person looked in the Razorpay dashboard, AFTER this payout's last request to Razorpay, and attested that no transfer exists for it. The
 * only way past a payment-transfer listing that cannot be read for good (see attestNoTransfer); it stands in for the listing and for nothing else.
 */
async function hasNoTransferAttestation(p: Pick<PayoutRow, "id" | "transferRequestedAt" | "createdAt">): Promise<boolean> {
  const ev = await prisma.creatorPayoutEvent.findFirst({
    where: { payoutId: p.id, kind: ATTEST_KIND, actorType: "staff", createdAt: { gte: p.transferRequestedAt ?? p.createdAt } },
    select: { id: true },
  });
  return ev !== null;
}

const ATTEST_ONLY_KIND = "attest_no_other_transfer";

/**
 * A person looked in the Razorpay dashboard and attested that NO transfer other than the one this payout records carries its id (see
 * attestNoTransfer). It stands in for the TWIN AUDIT's listing, and only while that listing cannot be read: in the hold confirmation (and the
 * daily re-read) and in the release's twin check, i.e. on the way to paying the creator, which is where a person's word already counts
 * (markManualPaid). ⚠️ NEVER on the way to refunding the brand (the void before a refund, the reversal before a refund): a twin a person missed
 * would then sit in the linked account while the brand is repaid in full. Valid only when it was made at least ABSENT_CHECK_GAP_MS after the
 * payout's last request (the same rule a listing must meet: a first request can land late), and only while the payout records a transfer.
 */
async function hasNoOtherTransferAttestation(p: Pick<PayoutRow, "id" | "transferRequestedAt" | "razorpayTransferId">): Promise<boolean> {
  if (p.razorpayTransferId === null || p.transferRequestedAt === null) return false;
  const ev = await prisma.creatorPayoutEvent.findFirst({
    where: { payoutId: p.id, kind: ATTEST_ONLY_KIND, actorType: "staff", createdAt: { gte: new Date(p.transferRequestedAt.getTime() + ABSENT_CHECK_GAP_MS) } },
    select: { id: true },
  });
  return ev !== null;
}

/** The statuses whose next step is a twin audit (attempts > 1): the hold confirmation, the daily re-read, the release. */
const TWIN_AUDITED_STATUSES: readonly string[] = ["transfer_requested", "held", "needs_attention"];

/** What it takes to say "no transfer of this payout can still release money" (the facts decideManualFallback judges), read fresh. */
interface NoTransferProof {
  /** This payout's own transfer, read fresh (null = none stored, or unread: see transferChecked). */
  transfer: { status: string; amount: number; amountReversed: number } | null;
  transferChecked: boolean;
  /** Live transfers of the payment carrying this payout's id; null = the listing was not read (and not attested away). */
  live: RazorpayTransfer[] | null;
  activeCarriers: number | null;
  listing: RazorpayTransfer[] | null;
}

async function readNoTransferProof(ctx: Ctx, p: PayoutRow, o: { allowAttestation: boolean; fetchOwn?: boolean }): Promise<NoTransferProof> {
  const out: NoTransferProof = { transfer: null, transferChecked: false, live: null, activeCarriers: null, listing: null };
  // A create call that was never sent cannot have made a transfer, so nothing needs reading.
  if (p.razorpayTransferId === null && p.attempts === 0) return { ...out, live: [], activeCarriers: 0 };
  out.listing = await readListing(ctx, p);
  if (out.listing) {
    out.live = liveCarriersOf(out.listing, p.id);
    out.activeCarriers = out.live.length;
  } else if (o.allowAttestation && (await hasNoTransferAttestation(p))) {
    out.live = [];
    out.activeCarriers = 0;
  }
  if (p.razorpayTransferId !== null && o.fetchOwn !== false) {
    try {
      const t = await rz(ctx, () => fetchTransfer(p.razorpayTransferId!));
      out.transfer = { status: t.status, amount: t.amount, amountReversed: t.amount_reversed };
      out.transferChecked = true;
    } catch {
      out.transferChecked = false;
    }
  }
  return out;
}

/**
 * Staff-typed text that is about to be STORED (a reason, a note): scrubPayoutSecrets, and also a run of five or more digits split by
 * dots, slashes, underscores or a few spaces and hyphens ("5010.0123.4567") counts as one run and is masked. Scrub first, then cut:
 * cutting first could leave the front of a long number unmasked.
 */
export function scrubStaffText(text: string): string {
  const bounded = String(text ?? "").slice(0, 400);
  return scrubPayoutSecrets(bounded).replace(/[0-9](?:[ _./:#-]{0,3}[0-9]){4,}/g, "[redacted]");
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
      data: { errorCode: decision.reason, lastError: REFUND_EXISTS_TEXT, lockedUntil: null },
      kind: "manual",
      actor: SYSTEM,
      note: `Manual payment required: ${decision.reason}.`,
    });
    if (moved) alertPayout(p, "manual_required", "manual_required", decision.reason);
    return result(ctx, moved ? "manual_required" : (await loadPayout(payoutId))?.status ?? null, moved, moved ? "manual_required" : "lost_claim", decision.reason);
  }
  if (decision.action === "wait") {
    // ⚠️ A payout that has to wait is not asked about again on the very next tick: it would sit in the selection every tick, and enough
    // of them crowd out the work that takes money BACK (a staff Execute and the capture kick ignore this and always try).
    if (decision.reason !== "paused" && opts.actor?.type !== "staff") {
      await prisma.creatorPayout.updateMany({ where: { id: p.id, status: "planned" }, data: { nextAttemptAt: new Date(now.getTime() + plannedWaitBackoffMs(decision.reason, now.getTime() - p.createdAt.getTime())) } });
    }
    return result(ctx, p.status, false, "waiting", decision.reason);
  }

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
        // The request's key rides in the notes, so a listing can tell this request's transfer from one an earlier request left behind.
        notes: { payout_id: p.id, booking_item_id: p.bookingItemId, ...(requestKeyOf(p.attempts, p.transferRequestedAt) ? { attempt: requestKeyOf(p.attempts, p.transferRequestedAt)! } : {}) },
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
        data: { errorCode: "refund_exists", lastError: REFUND_EXISTS_TEXT },
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
    const stillNotHeld = p.status === "needs_attention" && dec.action === "rehold";
    if (p.status === "transfer_requested") next = IN_FLIGHT_RECHECK_MS;
    else if (p.status === "released" || p.status === "settlement_failed") next = settlementPollDelayMs(p.releasedAt, now);
    else if (p.status === "release_requested" || p.status === "reversal_requested") next = IN_FLIGHT_RECHECK_MS;
    // A payout parked because its hold is gone is read again at a growing pace (5 minutes, doubling, never over 2 hours): the hold is put back
    // every time, and a transfer that cannot be held for good must not keep the worker busy every few minutes.
    else if (stillNotHeld) next = heldAnomalyBackoffMs(p.absentChecks);
    else if (p.status === "needs_attention") next = RETRY_BACKOFF_MS;
    const data: Prisma.CreatorPayoutUpdateManyMutationInput = { ...base, lockedUntil: null };
    if (p.status === "held" && dec.reason === "confirmed_held") data.onHoldVerifiedAt = now;
    if (stillNotHeld) data.absentChecks = { increment: 1 };
    if (next !== null) data.nextAttemptAt = new Date(now.getTime() + next);
    await prisma.creatorPayout.updateMany({ where: { id: p.id, status: p.status }, data });
    // A parked payout whose hold has still not been put back: try again, and keep telling staff (the alert is limited to one an hour).
    if (dec.action === "rehold") {
      await putHoldBack(ctx, p, t.id, actor);
      if (stillNotHeld && p.absentChecks >= 2) alertPayout(p, "not_on_hold", "needs_attention", "still_not_held", [{ label: "Transfer", value: t.id }, { label: "Checks", value: String(p.absentChecks + 1) }]);
    }
    return result(ctx, p.status, dec.reason === "confirmed_held", dec.reason);
  }

  let data: Prisma.CreatorPayoutUpdateManyMutationInput;
  let text: string;
  let kind = "transfer";
  switch (dec.to) {
    case "held":
      data = { ...base, heldAt: now, onHoldVerifiedAt: now, errorCode: null, lastError: null, lockedUntil: null, nextAttemptAt: null, absentChecks: 0 };
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
      data = { ...base, errorCode: dec.reason.slice(0, 80), lastError: REASON_TEXT[dec.reason] ?? dec.reason, lockedUntil: null, nextAttemptAt: null, absentChecks: 0 };
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

const carrierOf = (t: RazorpayTransfer): CarrierTransfer => ({ id: t.id, status: t.status, amount: t.amount, amountReversed: t.amount_reversed, recipient: t.recipient, createdAt: t.created_at, generation: t.notes.attempt ?? null });

/** A listing that cannot be read for this long, while a create call's outcome is still unknown, is not waited on any more: a person looks. */
export const LISTING_UNREADABLE_PARK_MS = 30 * 60_000;
/** How often a payout parked with no transfer id (listing_unreadable, transfer_unknown_after_retry) lists the payment's transfers again. */
const LISTING_UNREADABLE_RECHECK_MS = 60 * 60_000;
/**
 * The parks of an unknown create result that have NO transfer id and are listed again hourly (selectDuePayouts' `unreadable` bucket and
 * resolveUnknownTransfer's `parked` test, which must agree):
 *   listing_unreadable           the list could not be read for half an hour; resumes as an unknown result when it can be read again.
 *   transfer_unknown_after_retry the request was sent twice and two listings showed nothing. ⚠️ A first request can still land LATE, and the
 *                                transfer webhook only matches a STORED id, so without this hourly look a transfer that lands after the
 *                                park would sit held in the linked account with nothing tracking it. Found → adopted (decideTransferRetry).
 */
export const PARKED_UNKNOWN_CODES: readonly string[] = ["listing_unreadable", "transfer_unknown_after_retry"];

/**
 * A payout in transfer_requested with NO transfer id: the create call's answer was lost or unreadable (or the
 * process died after the claim). Razorpay has no idempotency key for this call [R3], so this reads the
 * payment's transfers and decides (decideTransferRetry):
 *   exactly one carries our payout_id → adopt it;
 *   several → keep one, reverse the extras while they are still on hold, park the payout for a person;
 *   none, for the second time and ≥ ABSENT_CHECK_GAP_MS after the first → send the create call ONCE more
 *     (only with the Route switch on and the payout not paused: it is a NEW transfer request like any other);
 *   none, with a refund on the payment → manual_required; none after the retry → needs_attention.
 * A listing that fails changes nothing: an unread list is not an empty one. But a listing that STAYS unreadable for
 * LISTING_UNREADABLE_PARK_MS parks the payout as needs_attention(listing_unreadable) and tells staff, because every
 * refund on the payment waits for it and nothing else can end that wait. Such a parked payout asks again hourly and
 * resumes by itself when the listing works; a person can also adopt the transfer by its id (adoptTransferByStaff) or
 * attest that none exists (attestNoTransfer). A payout parked as transfer_unknown_after_retry is listed again hourly too,
 * and leaves the park ONLY when a listing shows a transfer carrying its id (adopted, or handled as twins, a failure or a
 * mismatch exactly as an unknown result would be); a listing that still shows nothing leaves it parked and asks again later.
 */
export async function resolveUnknownTransfer(payoutId: string, opts: StepOptions = {}): Promise<StepResult> {
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? SYSTEM;
  const ctx = newCtx(payoutId);
  const p0 = await loadPayout(payoutId);
  if (!p0) return result(ctx, null, false, "not_found");
  const parked = p0.status === "needs_attention" && PARKED_UNKNOWN_CODES.includes(p0.errorCode ?? "") && p0.razorpayTransferId === null;
  if ((p0.status !== "transfer_requested" && !parked) || p0.razorpayTransferId !== null) return result(ctx, p0.status, false, "not_applicable");
  if (!razorpayConfig.configured()) return result(ctx, p0.status, false, "disabled", "not_configured");
  const lease = await takeLease(payoutId, [p0.status as PayoutStatus], now);
  if (!lease) return result(ctx, p0.status, false, "leased");
  try {
    let p = (await loadPayout(payoutId))!;
    if (p.razorpayTransferId !== null || p.status !== p0.status) return result(ctx, p.status, false, "not_applicable");

    const listing = await readListing(ctx, p);
    if (!listing) {
      if (p.status === "needs_attention") {
        await backoff(p.id, "needs_attention", now, LISTING_UNREADABLE_RECHECK_MS);
        return result(ctx, p.status, false, "unread", p.errorCode ?? "listing_unreadable");
      }
      const since = (p.transferRequestedAt ?? p.createdAt).getTime();
      if (now.getTime() - since < LISTING_UNREADABLE_PARK_MS) {
        await backoff(p.id, "transfer_requested", now, RETRY_BACKOFF_MS, { errorCode: "listing_failed" });
        return result(ctx, p.status, false, "unread", "listing_failed");
      }
      const parkedNow = await transition({
        id: p.id,
        from: ["transfer_requested"],
        to: "needs_attention",
        data: { errorCode: "listing_unreadable", lastError: REASON_TEXT.listing_unreadable, lockedUntil: null, nextAttemptAt: new Date(now.getTime() + LISTING_UNREADABLE_RECHECK_MS) },
        kind: "transfer",
        actor,
        note: "Razorpay's list of this payment's transfers has not been readable for 30 minutes; a person must look.",
      });
      if (parkedNow) alertPayout(p, "needs_attention", "needs_attention", "listing_unreadable");
      return result(ctx, parkedNow ? "needs_attention" : (await loadPayout(p.id))?.status ?? null, false, "parked", "listing_unreadable");
    }

    if (p.status === "needs_attention") {
      const afterRetry = p.errorCode === "transfer_unknown_after_retry";
      if (afterRetry) {
        // Sent twice, and two listings showed nothing: only a transfer carrying this payout's id that has turned up since is a reason to
        // leave the park. The probe is the same decision the unknown result is judged by; `refundExists` only matters when nothing carries
        // our id, which is exactly the case that stays parked, so it is not read here.
        const probe = decideTransferRetry({
          now,
          attempts: p.attempts,
          absentChecks: p.absentChecks,
          lastCheckedAt: p.lastCheckedAt,
          refundExists: false,
          storedTransferId: null,
          requestKey: requestKeyOf(p.attempts, p.transferRequestedAt),
          expected: { recipient: p.razorpayAccountId, amountPaise: p.amountPaise },
          carriers: listing.filter((t) => t.notes.payout_id === p.id).map(carrierOf),
        });
        const found = probe.action === "adopt" || probe.action === "adopt_failed" || probe.action === "duplicates" || (probe.action === "needs_attention" && probe.reason !== "transfer_unknown_after_retry");
        if (!found) {
          await prisma.creatorPayout.updateMany({
            where: { id: p.id, status: "needs_attention", errorCode: "transfer_unknown_after_retry", razorpayTransferId: null },
            data: { lastCheckedAt: now, nextAttemptAt: new Date(now.getTime() + LISTING_UNREADABLE_RECHECK_MS), lockedUntil: null },
          });
          return result(ctx, p.status, false, "waiting", "transfer_unknown_after_retry");
        }
      }
      // The listing works again (or, after a repeated request, now shows a transfer carrying this payout's id): the payout goes back to
      // being an unknown create result, and is judged like one. After a repeat its counters are kept: a carrier that vanished again parks it again.
      const back = await transition({
        id: p.id,
        from: ["needs_attention"],
        to: "transfer_requested",
        where: { razorpayTransferId: null, errorCode: p.errorCode },
        data: afterRetry ? { errorCode: null, lastError: null, nextAttemptAt: null } : { errorCode: null, lastError: null, absentChecks: 0, lastCheckedAt: null, nextAttemptAt: null },
        kind: "transfer",
        actor,
        note: afterRetry
          ? "A transfer carrying this payout's id showed up in Razorpay's list after the repeated request was parked; it is judged from that list."
          : "Razorpay's list of this payment's transfers can be read again; the unknown transfer request is judged from it.",
      });
      if (!back) return result(ctx, (await loadPayout(p.id))?.status ?? null, false, "lost_claim");
      p = (await loadPayout(payoutId))!;
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
      requestKey: requestKeyOf(p.attempts, p.transferRequestedAt),
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
        // The second empty listing, far enough from the first: the create call did not land. Once more, never more. ⚠️ A repeat is a NEW
        // transfer request, so it needs what the first one needed: the Route switch on, and the payout not paused. (The item and the
        // booking are NOT re-judged here: a closed item's transfer is made and taken straight back, which is the designed way out, and
        // refusing it would leave the item's refund waiting on a transfer that never comes.) Waiting loses nothing: each wait lists first.
        if (!transfersEnabled() || p.pausedAt !== null) {
          await prisma.creatorPayout.updateMany({ where: { id: p.id, status: "transfer_requested", razorpayTransferId: null }, data: { nextAttemptAt: new Date(now.getTime() + RETRY_BACKOFF_MS), lockedUntil: null } });
          return result(ctx, p.status, false, "waiting", p.pausedAt !== null ? "paused" : "route_off_or_not_configured");
        }
        const claimed = await prisma.creatorPayout.updateMany({
          where: { id: p.id, status: "transfer_requested", razorpayTransferId: null, attempts: p.attempts, pausedAt: null },
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
        // A park with no transfer id that the hourly look covers (PARKED_UNKNOWN_CODES) is due again in an hour, not on the next tick: it was just listed.
        const relist = PARKED_UNKNOWN_CODES.includes(d.reason) ? new Date(now.getTime() + LISTING_UNREADABLE_RECHECK_MS) : null;
        const moved = await transition({ id: p.id, from: ["transfer_requested"], to: "needs_attention", data: { errorCode: d.reason, lastError: REASON_TEXT[d.reason] ?? d.reason, lockedUntil: null, nextAttemptAt: relist, ...(relist ? { lastCheckedAt: now } : {}) }, kind: "transfer", actor, note: `Parked: ${d.reason}.` });
        if (moved) alertPayout(p, "needs_attention", "needs_attention", d.reason);
        return result(ctx, moved ? "needs_attention" : (await loadPayout(p.id))?.status ?? null, false, "parked", d.reason);
      }
    }
  } finally {
    await dropLease(payoutId, lease);
  }
}

/**
 * Two or more live transfers carry this payout's id (the retry landed after the first create call did), or the one transfer the payout
 * was tracking is dead and another, live one carries its id. Keep one, park the payout for a person, and reverse every extra WHILE IT IS
 * STILL ON HOLD (explicit amount: what is left of each). The payout returns to `held` only through cleanUpDuplicates, after a listing
 * proves exactly the kept transfer is alive. The kept transfer's id REPLACES whatever id the payout held when it was read (a dead one,
 * or none): the update names that id, so a payout that moved on in the meantime is left alone.
 */
async function handleDuplicates(ctx: Ctx, p: PayoutRow, keep: RazorpayTransfer, extras: RazorpayTransfer[], now: Date, actor: PayoutActor, lastError: string = REASON_TEXT.duplicate_transfer): Promise<StepResult> {
  try {
    const r = await prisma.creatorPayout.updateMany({
      where: { id: p.id, status: p.status, razorpayTransferId: p.razorpayTransferId },
      data: { razorpayTransferId: keep.id.slice(0, 64), transferStatus: statusOf(keep.status) },
    });
    if (r.count !== 1) return result(ctx, (await loadPayout(p.id))?.status ?? null, false, "lost_claim");
  } catch (err) {
    if ((err as { code?: string })?.code === "P2002") {
      alertPayout(p, "id_not_recorded", p.status, "transfer_id_in_use", [{ label: "Transfer", value: keep.id }]);
      return result(ctx, p.status, false, "id_not_recorded", "transfer_id_in_use");
    }
    throw err;
  }
  const parkText = `${extras.length + 1} transfers carry this payout; one is kept, the extras are being reversed.`;
  const parkData = { errorCode: "duplicate_transfer", lastError, lockedUntil: null, nextAttemptAt: new Date(now.getTime() + IN_FLIGHT_RECHECK_MS) };
  let moved: boolean;
  if (p.status === "needs_attention") {
    // Already parked, for another reason (its hold was put back and it is being read again): the table has no needs_attention →
    // needs_attention move, so the reason is replaced in place, under the same condition a move would have had.
    moved = (await prisma.creatorPayout.updateMany({ where: { id: p.id, status: "needs_attention" }, data: parkData })).count === 1;
    if (moved) await recordEvent(p, "transfer", "needs_attention", parkText, actor);
  } else {
    moved = await transition({ id: p.id, from: [p.status as PayoutStatus], to: "needs_attention", data: parkData, kind: "transfer", actor, note: parkText });
  }
  if (!moved) return result(ctx, (await loadPayout(p.id))?.status ?? null, false, "lost_claim");
  alertPayout(p, "duplicate_transfer", "needs_attention", "duplicate_transfer", [{ label: "Kept", value: keep.id }, ...extras.map((e) => ({ label: "Extra", value: e.id }))]);
  const done = await reverseExtras(ctx, p, extras, actor);
  return result(ctx, "needs_attention", false, "duplicates", done ? "extras_reversed" : "extras_not_reversed");
}

/**
 * One call for every place that lists the payment's transfers to look for twins of a payout (the confirm audit, the daily re-read, the
 * void before a refund, the reversal): `live` are the live transfers carrying this payout's id. Nothing to do when exactly the stored
 * transfer is alive, or none is. Anything else (an extra beside the stored one, or live ones while the stored one is dead or missing) is
 * handed to handleDuplicates with the keeper chosen the usual way, and the caller stops: the payout is parked and being cleaned up.
 * Returns the StepResult when it took over, null when the caller may go on. With `anyLive`, a single live transfer is handled too (see below).
 */
async function parkIfTwins(ctx: Ctx, p: PayoutRow, live: RazorpayTransfer[], now: Date, actor: PayoutActor, o: { anyLive?: boolean } = {}): Promise<StepResult | null> {
  const storedLive = live.find((x) => x.id === p.razorpayTransferId);
  // `anyLive`: the payout is in a status that says NO transfer is out (failed, manual_required), so even the one transfer it names being alive is wrong.
  if (live.length === 0 || (!o.anyLive && storedLive && live.length === 1)) return null;
  const sorted = [...live].sort((a, b) => (a.created_at ?? Number.MAX_SAFE_INTEGER) - (b.created_at ?? Number.MAX_SAFE_INTEGER) || (a.id < b.id ? -1 : 1));
  const keep = storedLive ?? sorted[0];
  const text = storedLive ? REASON_TEXT.duplicate_transfer : REASON_TEXT.live_transfer_found;
  return handleDuplicates(ctx, p, keep, live.filter((x) => x.id !== keep.id), now, actor, text);
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
    const listing = await readListing(ctx, p);
    if (!listing) {
      await backoff(p.id, "needs_attention", now, RETRY_BACKOFF_MS);
      return result(ctx, p.status, false, "unread", "listing_failed");
    }
    const live = liveCarriersOf(listing, p.id);
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
    // The listing above is the audit: exactly the kept transfer is alive.
    return confirmHoldLocked(ctx, p, now, actor, true);
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

async function confirmHoldLocked(ctx: Ctx, p: PayoutRow, now: Date, actor: PayoutActor, audited = false): Promise<StepResult> {
  // ⚠️ THE TWIN AUDIT. A payout whose create call was sent more than once (an automatic retry, a staff Retry) may have a SECOND live
  // transfer: the first request, landing late. No transfer of such a payout is called held (and a parked one is not resolved back to
  // held, and the daily re-read of a held one does not pass without a look) until a listing, taken at least ABSENT_CHECK_GAP_MS after
  // the last request, shows exactly the stored transfer alive. Whatever route brought it here (the create answer, a webhook, the
  // resolution of a parked row) is audited the same way.
  if (!audited && p.attempts > 1 && (p.status === "transfer_requested" || p.status === "needs_attention" || p.status === "held")) {
    if (p.status === "transfer_requested") {
      const readyAt = (p.transferRequestedAt?.getTime() ?? 0) + ABSENT_CHECK_GAP_MS;
      if (now.getTime() < readyAt) {
        await backoff(p.id, "transfer_requested", now, readyAt - now.getTime() + 60_000);
        return result(ctx, p.status, false, "audit_wait", "request_was_repeated");
      }
    }
    const listing = await readListing(ctx, p);
    if (listing) {
      const took = await parkIfTwins(ctx, p, liveCarriersOf(listing, p.id), now, actor);
      if (took) return took;
    } else if (!(await hasNoOtherTransferAttestation(p))) {
      // Unread, and no person has said (after the last request) that no other transfer carries this payout's id: nothing is called held.
      await backoff(p.id, p.status as PayoutStatus, now, RETRY_BACKOFF_MS, { errorCode: p.status === "transfer_requested" ? "listing_failed" : p.errorCode });
      return result(ctx, p.status, false, "unread", "listing_failed");
    }
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

/**
 * The payment's refunds, asked of Razorpay and set against OUR ledger (the same reason the disputes are asked: a refund webhook that never
 * arrived leaves no row, and the sweep only reconciles payments it already knows to be in motion). More refunded at Razorpay than our books
 * show, or a refund of THIS item on our books while its payout was not taken back, means the brand has already been repaid. A refund of
 * another item is normal: it is in our ledger and the totals agree.
 */
async function razorpayRefundVerdict(ctx: Ctx, p: PayoutRow): Promise<ReleaseFacts["razorpayRefunds"]> {
  try {
    const refunds = await rz(ctx, () => fetchPaymentRefunds(p.razorpayPaymentId), 2);
    const ledger = await prisma.campaignRefund.findMany({ where: { razorpayPaymentId: p.razorpayPaymentId, status: { not: "failed" } }, select: { amountPaise: true, bookingItemId: true } });
    return decideRefundVerdict({ razorpayRefundedPaise: refundedTotalPaise(refunds), ledger, itemId: p.bookingItemId });
  } catch {
    return "unchecked";
  }
}

/**
 * A refund the payout must not outlive: every payout of the payment is PAUSED (so the worker stops asking every few minutes and a person
 * has to look), staff are told, and for a refund our books do not know the refund reconciler is run once so it is filed (it also pauses,
 * which is then a no-op). Best effort: the release was refused either way, so a failure here only means the next tick asks again.
 */
async function holdForRefundConflict(p: PayoutRow, verdict: "unaccounted" | "covers_item"): Promise<void> {
  try {
    await prisma.$transaction((tx) =>
      pausePayoutsOfPayment(tx, p.razorpayPaymentId, {
        reason: "external_refund",
        actorType: "system",
        note: verdict === "unaccounted" ? "Razorpay shows a refund on the brand's payment that our records do not: payouts of this payment are paused until staff have looked." : "A refund of this very post is on our books while its payout was not taken back: payouts of this payment are paused until staff have looked.",
      }),
    );
  } catch {
    /* the refusal stands; the next tick asks again */
  }
  alertPayout(p, "refund_conflict", "held", verdict);
  if (verdict !== "unaccounted") return;
  try {
    const pay = await prisma.campaignPayment.findUnique({ where: { razorpayPaymentId: p.razorpayPaymentId }, select: { id: true } });
    if (pay) {
      // Loaded here, not at the top of the file: the payment service imports this one.
      const { reconcileRefunds } = await import("../campaign/payment.service");
      await reconcileRefunds(pay.id);
    }
  } catch {
    /* the sweep and the refund webhook are the other ways it gets filed */
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
 * call), then a fresh read of the transfer, then Razorpay's word on twins, disputes, refunds and the account's
 * activation (each read only if everything before it was clear), then the CLAIM (a conditional update: two callers
 * produce exactly one PATCH), a second look at the pause, the creator, the dispute rows and the switch, and only
 * then PATCH on_hold:false. The result is confirmed by a fresh read before the payout is called released, and the
 * creator's destination is frozen onto it then.
 *
 * Refusals make no Razorpay write. The WORKER backs a refused payout off (nextAttemptAt, see releaseRefusalBackoffMs) so a few
 * that stay refused cannot fill every tick and starve the rest; a person's "Release now" (a staff actor) neither waits on that
 * nor writes it. A definite refusal of the PATCH puts the claim back to held; an unknown answer keeps release_requested for
 * resolveRelease.
 */
export async function releasePayout(payoutId: string, opts: StepOptions = {}): Promise<StepResult> {
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? SYSTEM;
  const ctx = newCtx(payoutId);
  const p = await loadPayout(payoutId);
  if (!p) return result(ctx, null, false, "not_found");
  if (!razorpayConfig.configured()) return result(ctx, p.status, false, "disabled", "not_configured");

  const refuse = async (reason: ReleaseRefusal): Promise<StepResult> => {
    if (actor.type !== "staff") {
      const ms = releaseRefusalBackoffMs(reason, { now, releaseAfter: p.releaseAfter });
      if (ms !== null) await prisma.creatorPayout.updateMany({ where: { id: p.id, status: "held", pausedAt: null }, data: { nextAttemptAt: new Date(now.getTime() + ms) } });
    }
    return result(ctx, p.status, false, "refused", reason);
  };

  // 1. Local facts.
  const local = await loadLocalReleaseFacts(p, now, actor);
  const localFacts: ReleaseFacts = { ...local, ...UNREAD_REMOTE };
  const localDecision = evaluateLocalRelease(localFacts);
  if (!localDecision.ok) return refuse(localDecision.reason);

  // 2. The transfer, fresh.
  let t: RazorpayTransfer | null = null;
  try {
    t = await rz(ctx, () => fetchTransfer(p.razorpayTransferId!));
  } catch {
    t = null;
  }
  const transferDecision = evaluateTransferForRelease({ payout: localFacts.payout, transfer: t ? viewOf(t) : null });
  if (!transferDecision.ok) return refuse(transferDecision.reason);

  // 3. Razorpay's own word on twins, disputes, refunds and the account, in the order the gate judges them and each read only while
  //    everything before it was clear (a refusal costs only what it took to reach). Every fact starts at the value that REFUSES nothing
  //    only because the final evaluation below runs over what was really read: a fact that was skipped sits behind a refusal that was
  //    already decided, so no skipped fact can ever be what lets a release through. A payout whose create call was only ever sent once
  //    cannot have a twin, so it costs no listing; one that was sent twice must prove it has none.
  let remote: Pick<ReleaseFacts, "duplicateTransfers" | "razorpayDisputes" | "razorpayRefunds" | "account"> = { duplicateTransfers: "none", razorpayDisputes: "clear", razorpayRefunds: "clear", account: "activated" };
  let early: ReturnType<typeof evaluateRemoteForRelease> = { ok: true };
  let extras: RazorpayTransfer[] = [];
  if (p.attempts > 1) {
    const listing = await readListing(ctx, p);
    extras = listing ? liveCarriersOf(listing, p.id).filter((x) => x.id !== p.razorpayTransferId) : [];
    // An unread list is "unchecked" (no release), unless a person attested after the last request that no other transfer carries this payout's id.
    const twins = listing ? (extras.length > 0 ? "found" : "none") : (await hasNoOtherTransferAttestation(p)) ? "none" : "unchecked";
    remote = { ...remote, duplicateTransfers: twins };
    early = evaluateRemoteForRelease(remote);
  }
  if (early.ok) {
    remote = { ...remote, razorpayDisputes: await razorpayDisputeVerdict(ctx, p, now) };
    early = evaluateRemoteForRelease(remote);
  }
  if (early.ok) {
    remote = { ...remote, razorpayRefunds: await razorpayRefundVerdict(ctx, p) };
    early = evaluateRemoteForRelease(remote);
  }
  if (early.ok) remote = { ...remote, account: await accountVerdict(ctx, p, local.productId, local.accountRowMatches) };
  const decision = evaluateRelease({ ...localFacts, transfer: viewOf(t!), ...remote });
  if (!decision.ok) {
    // Twins found at release time: nothing is released, the extras are reversed while they are on hold, and a person is told.
    if (decision.reason === "duplicate_transfer") {
      await handleDuplicates(ctx, p, t!, extras, now, actor);
      return result(ctx, (await loadPayout(payoutId))?.status ?? p.status, false, "refused", decision.reason);
    }
    if (decision.reason === "refund_at_razorpay") await holdForRefundConflict(p, remote.razorpayRefunds === "covers_item" ? "covers_item" : "unaccounted");
    return refuse(decision.reason);
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

  // 5. A pause, a suspension, a dispute or the kill switch can land between the checks and the claim. Look once more, then PATCH.
  const again = (await loadPayout(payoutId))!;
  const second = evaluateLocalRelease({ ...(await loadLocalReleaseFacts({ ...again, status: "held" }, now, actor)), ...UNREAD_REMOTE });
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
 * Poll a released payout's settlement, from the moment of release. The transfer is read PLAIN (its base fields carry settlement_status
 * and recipient_settlement_id, and the id is written as soon as Razorpay shows it: the settlement webhook links by it). Once the transfer
 * names a settlement, that settlement (its status and bank UTR) is read through the one route the docs show, the transfer list with
 * expand[]=recipient_settlement filtered to that settlement (fetchTransferSettlement). A PROCESSED settlement with a usable bank
 * reference (UTR) → settled, a FAILED one → settlement_failed with an alert. "Paid" exists only from this: transfer.processed, a
 * released hold and a base-field settlement_status of "settled" are never "paid" without the UTR. A settlement that cannot be read now
 * changes nothing and is read again later. Also re-reads a settlement_failed payout, which Razorpay may settle later.
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
    const settlementId = t.recipient_settlement?.id ?? t.recipient_settlement_id;
    if (settlementId && !t.recipient_settlement) {
      try {
        const st = await rz(ctx, () => fetchTransferSettlement(t.id, settlementId), 2);
        if (st) t = { ...t, recipient_settlement: st };
      } catch {
        // Not readable now: the transfer's own fields are still recorded (the settlement id the webhook links by), and nothing is called settled without the UTR.
      }
    }
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
  /**
   * A PERSON pressed Reverse because the creator must not be paid (the staff wrapper sets it; a reversal before a refund does not): a definite
   * refusal that puts the payout back in `held` also PAUSES it (reason staff), in the same move, so its scheduled release does not go ahead
   * minutes later against what was asked. Honoured only for a staff actor. A person resumes it once the transfer is settled.
   */
  pauseIfRefused?: boolean;
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
 *    needs_attention, because Razorpay only reverses already-settled money against a floating balance). A person's Reverse
 *    (pauseIfRefused) that lands back in held also pauses it, so the release it was meant to stop does not go ahead.
 *  • An UNKNOWN answer keeps reversal_requested and is read back (resolveReversal); it is never "held" and
 *    never "reversed" until Razorpay says so.
 */
export async function reversePayout(payoutId: string, opts: ReverseOptions): Promise<StepResult> {
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? SYSTEM;
  const ctx = newCtx(payoutId);
  // ⚠️ A person may have typed the reason: it is stored in the audit notes, so it is scrubbed the way every staff-typed text is (scrubStaffText).
  const why = scrubStaffText(opts.reason);
  const pauseOnRefusal = opts.pauseIfRefused === true && actor.type === "staff";
  const p0 = await loadPayout(payoutId);
  if (!p0) return result(ctx, null, false, "not_found");
  if (p0.status === "reversed") return result(ctx, "reversed", true, "already_reversed");
  if (p0.status === "planned" || p0.status === "void") return result(ctx, p0.status, false, "nothing_to_reverse");
  if (!razorpayConfig.configured()) return result(ctx, p0.status, false, "disabled", "not_configured");
  if (p0.status === "reversal_requested") {
    const lease = await takeLease(payoutId, ["reversal_requested"], now);
    if (!lease) return result(ctx, p0.status, false, "leased");
    try {
      return await runReversal(ctx, (await loadPayout(payoutId))!, await priorStatusOfReversal(p0), now, actor, why, pauseOnRefusal);
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
    note: `Reversal requested (${why}).`,
  });
  if (!claimed) return result(ctx, (await loadPayout(payoutId))?.status ?? null, false, "lost_claim");
  try {
    return await runReversal(ctx, (await loadPayout(payoutId))!, p0.status, now, actor, why, pauseOnRefusal);
  } finally {
    await dropLease(payoutId, lease);
  }
}

/**
 * Put a reversal claim back (or park it) after a definite refusal. `pauseOnRefusal` (a person's Reverse, see ReverseOptions): one put back in
 * `held` is paused in the same move, so the release the person meant to stop does not go ahead.
 */
async function rollbackReversal(ctx: Ctx, p: PayoutRow, to: PayoutStatus, reasonCode: string, now: Date, actor: PayoutActor, err?: unknown, pauseOnRefusal = false): Promise<StepResult> {
  const pause = pauseOnRefusal && to === "held";
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
    ...(pause ? { pause: { at: now, reason: "staff" } } : {}),
    note:
      to === "held"
        ? pause
          ? `The reversal was refused (${reasonCode}); the payout is held again and paused, so it will not be released: resume it once the transfer is settled.`
          : `The reversal was refused (${reasonCode}); the payout is held again.`
        : `The reversal was refused (${reasonCode}); a person must look.`,
  });
  if (moved) alertPayout(p, "reversal_failed", to, reasonCode);
  return result(ctx, moved ? to : (await loadPayout(p.id))?.status ?? null, false, "refused", reasonCode);
}

async function runReversal(ctx: Ctx, p: PayoutRow, prior: string, now: Date, actor: PayoutActor, why: string, pauseOnRefusal = false): Promise<StepResult> {
  if (!p.razorpayTransferId) {
    return rollbackReversal(ctx, p, "needs_attention", "reversal_failed_state", now, actor);
  }
  // ⚠️ THE TWIN AUDIT, before anything is called reversed. A payout whose create call was sent more than once may have a second live
  // transfer; reversing only the stored one would make the payout "reversed", release the item's price for the brand's refund, and leave
  // the twin's share in the linked account with nothing tracking it. So every live transfer carrying this payout's id is taken back first
  // (explicit amounts), and a reversal whose transfer list cannot be read is not finished.
  if (p.attempts > 1) {
    const listing = await readListing(ctx, p);
    if (!listing) {
      await backoff(p.id, "reversal_requested", now, IN_FLIGHT_RECHECK_MS, { errorCode: "reversal_unread" });
      return result(ctx, "reversal_requested", false, "unknown", "listing_failed");
    }
    const live = liveCarriersOf(listing, p.id);
    // The transfer we are taking back is not the live one: re-point the payout at the live one and let the duplicates flow settle it.
    if (live.length > 0 && !live.some((x) => x.id === p.razorpayTransferId)) {
      const took = await parkIfTwins(ctx, p, live, now, actor);
      if (took) return took;
    }
    const extras = live.filter((x) => x.id !== p.razorpayTransferId);
    if (extras.length > 0 && !(await reverseExtras(ctx, p, extras, actor))) {
      await backoff(p.id, "reversal_requested", now, IN_FLIGHT_RECHECK_MS, { errorCode: "reversal_unknown", lastError: "A second transfer carrying this payout's id could not be taken back yet. It is being retried." });
      return result(ctx, "reversal_requested", false, "unknown", "extras_not_reversed");
    }
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
    if (decision.reason === "transfer_not_processed") return rollbackReversal(ctx, p, prior === "held" ? "held" : "needs_attention", "transfer_not_processed", now, actor, undefined, pauseOnRefusal);
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
    return rollbackReversal(ctx, p, out.to, out.reason, now, actor, err, pauseOnRefusal);
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
 *   failed                        → voided (Razorpay refused it: no money moved). Sent more than once: voided only after a
 *                                    listing, taken at least ABSENT_CHECK_GAP_MS after the last request, shows no live transfer
 *                                    carrying its id (before that: reversal_pending / audit_wait, asked again).
 *   manual_required               → voided only when money provably never left or came back (no create call was ever
 *                                    sent, or it was reversed, or a listing taken that long after the last request shows no
 *                                    live transfer carrying its id); otherwise blocked or waiting.
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
  const ctx = newCtx(p.id);

  const voidIt = async (from: PayoutStatus, text: string): Promise<RefundReadiness> => {
    const moved = await transition({ id: p.id, from: [from], to: "void", data: { voidReason: reason, lockedUntil: null, nextAttemptAt: null }, kind: "void", actor, note: text });
    if (moved) return { refundable: true, state: "voided", payoutId: p.id, calls: ctx.calls };
    const cur = await loadPayout(p.id);
    if (cur?.status === "void") return { refundable: true, state: "void", payoutId: p.id, calls: ctx.calls };
    return { refundable: false, state: "blocked", payoutId: p.id, reason: "payout_moved", calls: ctx.calls };
  };

  /**
   * ⚠️ NO PAYOUT IS VOIDED WHILE A TRANSFER OF IT IS ALIVE. A payout that was sent to Razorpay more than once may have a live transfer
   * that its row does not know (the first request, landing late; the retry that a lost answer left unrecorded), and voiding the payout
   * lets the brand be refunded in full while that transfer's share sits in the linked account. So before a `failed` or `manual_required`
   * payout is voided its payment's transfers are listed: a live one parks the payout (duplicate flow: it is tracked again and taken
   * back), an unread list waits. A payout that was only ever sent once needs no listing for `failed` (a single request refused or
   * failed cannot have a twin); a `manual_required` one is proven by decideManualFallback's own rules.
   */
  const voidAfterAudit = async (from: "failed" | "manual_required", text: string): Promise<RefundReadiness> => {
    if (from === "failed" && p.attempts <= 1) return voidIt(from, text);
    // ⚠️ The same rule the hold confirmation keeps: a listing taken less than ABSENT_CHECK_GAP_MS after the last request proves nothing about
    // a request that is still on its way into Razorpay (an automatic repeat refused within seconds leaves the FIRST request in flight). The
    // refund waits and is asked again (job 10); nothing is listed or voided before then.
    const since = (p.transferRequestedAt ?? p.createdAt).getTime();
    if (now.getTime() - since < ABSENT_CHECK_GAP_MS) return { refundable: false, state: "reversal_pending", payoutId: p.id, reason: "audit_wait", calls: ctx.calls };
    const proof = await readNoTransferProof(ctx, p, { allowAttestation: false, fetchOwn: from === "manual_required" });
    if (proof.live && proof.live.length > 0) {
      const took = await parkIfTwins(ctx, p, proof.live, now, actor, { anyLive: true });
      if (took) return { refundable: false, state: "reversal_pending", payoutId: p.id, reason: "transfer_active", calls: ctx.calls };
      return { refundable: false, state: "blocked", payoutId: p.id, reason: "payout_moved", calls: ctx.calls };
    }
    if (proof.activeCarriers === null) return { refundable: false, state: "reversal_pending", payoutId: p.id, reason: "listing_unread", calls: ctx.calls };
    if (from === "manual_required") {
      const d = decideManualFallback({ status: "manual_required", transferId: p.razorpayTransferId, attempts: p.attempts, reversedAt: p.reversedAt, transfer: proof.transfer, transferChecked: proof.transferChecked, activeCarriers: proof.activeCarriers });
      if (!d.ok) return { refundable: false, state: d.reason === "transfer_unchecked" ? "reversal_pending" : "blocked", payoutId: p.id, reason: d.reason === "transfer_unchecked" ? "transfer_unread" : "manual_required_unproven", calls: ctx.calls };
    }
    return voidIt(from, text);
  };

  switch (p.status) {
    case "void":
      return { refundable: true, state: "void", payoutId: p.id, calls: 0 };
    case "reversed":
      return { refundable: true, state: "reversed", payoutId: p.id, calls: 0 };
    case "planned":
      return voidIt("planned", `Voided before any money moved (${reason}).`);
    case "failed":
      return voidAfterAudit("failed", `Voided: Razorpay refused the transfer, so no money moved (${reason}).`);
    case "manual_required": {
      // Nothing was ever sent: no read can add to that.
      if (p.razorpayTransferId === null && p.attempts === 0) return voidIt("manual_required", `Voided: no money is out (${reason}).`);
      return voidAfterAudit("manual_required", `Voided: no money is out (${reason}).`);
    }
    case "transfer_requested":
      return { refundable: false, state: "in_flight", payoutId: p.id, reason: "transfer_in_flight", calls: 0 };
    case "held":
    case "reversal_requested": {
      const r = await reversePayout(p.id, { reason, actor, now });
      if (r.status === "reversed") return { refundable: true, state: "reversed", payoutId: p.id, calls: r.calls };
      // A twin was found and the payout is being cleaned up by the worker: the refund waits, nobody is asked to decide.
      if (r.outcome === "unknown" || r.outcome === "partial" || r.outcome === "leased" || r.outcome === "duplicates" || r.status === "reversal_requested") {
        return { refundable: false, state: "reversal_pending", payoutId: p.id, reason: r.outcome === "duplicates" ? "twin_transfer_found" : r.outcome, calls: r.calls };
      }
      return { refundable: false, state: "blocked", payoutId: p.id, reason: r.reason ?? r.outcome, calls: r.calls };
    }
    case "needs_attention":
      // A payout the worker is cleaning up by itself (duplicates, a hold being put back) is not a decision a person must take yet: the refund waits.
      if (p.errorCode === "duplicate_transfer" || HOLD_RESOLVABLE_REASONS.includes(p.errorCode ?? "")) return { refundable: false, state: "reversal_pending", payoutId: p.id, reason: "reconciling", calls: 0 };
      return { refundable: false, state: "blocked", payoutId: p.id, reason: `payout_${p.status}`, calls: 0 };
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
 * id is dropped (the retry makes a NEW transfer, tagged as a new request); the attempt counter restarts at one but never drops from two or more.
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
  const listing = await readListing(ctx, p);
  // A listing that cannot be read at all is stood in for only by a person's attestation, made after the last request (attestNoTransfer).
  if (!listing && !(actor.type === "staff" && (await hasNoTransferAttestation(p)))) return result(ctx, p.status, false, "unread", "listing_failed");
  const live = listing ? liveCarriersOf(listing, p.id) : [];
  if (live.length > 0) return result(ctx, p.status, false, "transfer_still_active", "transfer_still_active");
  const claimed = await transition({
    id: p.id,
    from: ["failed"],
    to: "transfer_requested",
    where: { pausedAt: null, OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
    // ⚠️ The attempt count restarts at ONE after a clean failure (a new request, one automatic repeat still allowed), but is never brought
    // DOWN from two or more: a payout that was once sent twice keeps that memory, and with it the twin audits (release, reversal, the hold
    // confirmation, the void before a refund) that look for a transfer an earlier request left behind.
    data: { razorpayTransferId: null, attempts: Math.max(1, p.attempts), absentChecks: 0, transferRequestedAt: now, lockedUntil: new Date(now.getTime() + LEASE_MS), nextAttemptAt: null, errorCode: null, lastError: null },
    kind: "transfer",
    actor,
    note: "Staff retried the failed transfer.",
  });
  if (!claimed) return result(ctx, (await loadPayout(payoutId))?.status ?? null, false, "lost_claim");
  return performCreate(ctx, (await loadPayout(payoutId))!, now, actor);
}

/**
 * Staff mark a payout as one that must be paid by bank transfer (planned, failed, reversed or parked). This only
 * RECORDS the decision, and only when nothing could still release the money: paid_manual is reachable only through
 * markManualPaid, but a payout moved to manual_required while its transfer is alive can be neither reversed, refunded
 * nor recorded as paid by anything after that, and the creator would be paid twice the day someone releases the transfer
 * from the Razorpay dashboard. So the move follows the same rules as the manual fallback itself (decideManualFallback)
 * over FRESH facts: nothing was ever sent, or the transfer failed (or was reversed, and the whole of it is back) and the
 * payment lists no other live transfer carrying this payout's id. A parked payout whose transfer is alive is refused
 * with `transfer_exists`: reverse it first. A reversal seen at Razorpay that our row never recorded (a dashboard
 * reversal) is recorded here, because the fresh read proves it. A reversed payout whose item has been refunded (or is
 * being) is refused: the price is not owed any more and the manual payment would put it back on reserve. Staff are refused
 * (post_not_live) for any payout but a parked one unless the post is live and verified: see postIsPayableByHand.
 */
export async function requireManualPayment(payoutId: string, opts: StepOptions & { reason: string }): Promise<StepResult> {
  const now = opts.now ?? new Date();
  const ctx = newCtx(payoutId);
  const actor = opts.actor ?? SYSTEM;
  const p = await loadPayout(payoutId);
  if (!p) return result(ctx, null, false, "not_found");
  if (p.status === "manual_required") return result(ctx, p.status, true, "already_manual_required");
  const from = (["planned", "failed", "reversed", "needs_attention"] as PayoutStatus[]).filter((s) => s === p.status);
  if (from.length === 0) return result(ctx, p.status, false, "not_applicable");
  if (p.status === "needs_attention" && actor.type !== "staff") return result(ctx, p.status, false, "needs_human");

  if (p.status === "reversed") {
    const item = await prisma.campaignBookingItem.findUnique({ where: { id: p.bookingItemId }, select: { status: true } });
    if (!item || item.status === "refunded" || item.status === "refund_due") return result(ctx, p.status, false, "refused", "item_refunded");
  }
  // ⚠️ A PERSON asks for a bank transfer only for a post that went live and was verified (postIsPayableByHand): otherwise nothing is owed, and a
  // planned or failed payout is voided by refunding the post instead. The worker's own give-up (planned, a transfer that can never be made) is
  // not a person's: it only stops the payout holding up its payment's other refunds, and markManualPaid still refuses to record a payment for it.
  // A PARKED payout is the one exception: moving it here needs the same proof that no money is out (below), and it is the only way a parked
  // payout of a post that never went live becomes refundable (a refund refuses a parked payout; one with no transfer cannot be reversed).
  if (actor.type === "staff" && p.status !== "needs_attention" && !(await postIsPayableByHand(p))) return result(ctx, p.status, false, "refused", "post_not_live");

  let reversedNow = false;
  if (!(p.status === "planned" && p.razorpayTransferId === null && p.attempts === 0)) {
    if (!razorpayConfig.configured()) return result(ctx, p.status, false, "refused", "listing_unchecked");
    const proof = await readNoTransferProof(ctx, p, { allowAttestation: actor.type === "staff" });
    reversedNow = p.reversedAt === null && proof.transfer !== null && isFullyReversed(proof.transfer);
    const d = decideManualFallback({
      status: "manual_required",
      transferId: p.razorpayTransferId,
      attempts: p.attempts,
      reversedAt: reversedNow ? now : p.reversedAt,
      transfer: proof.transfer,
      transferChecked: proof.transferChecked,
      activeCarriers: proof.activeCarriers,
    });
    if (!d.ok) return result(ctx, p.status, false, "refused", d.reason === "transfer_not_failed" ? "transfer_exists" : d.reason);
  }

  const moved = await transition({
    id: p.id,
    from,
    to: "manual_required",
    data: { errorCode: scrubStaffText(opts.reason).slice(0, 80), lockedUntil: null, nextAttemptAt: null, ...(reversedNow ? { reversedAt: now } : {}) },
    kind: "manual",
    actor,
    note: `Manual payment required (${scrubStaffText(opts.reason)}).`,
  });
  return result(ctx, moved ? "manual_required" : (await loadPayout(payoutId))?.status ?? null, moved, moved ? "manual_required" : "lost_claim");
}

/**
 * ⚠️ WHETHER A PERSON MAY PAY THE CREATOR BY HAND FOR THIS POST: it is live (the release gate's own list of live statuses), its offer is this
 * creator's, `completed` AND has link_verified_at set (both, as the release gate wants), and no refund of the post is on the ledger (one that is
 * not failed). A payout that was never held belongs to a post that never went live: an offer, its acceptance, the link and its verification
 * all need a held payout. So for a planned, failed or never-held payout the creator is owed nothing, and paying them would pay for work that
 * never existed AND make the post impossible to refund: paid_manual is final, and every refund (and a rejection) refuses it. Such a payout
 * leaves planned, failed or manual_required only by being voided, which refunding the post does (reverseForRefund). Read from our own rows.
 */
async function postIsPayableByHand(p: Pick<PayoutRow, "bookingItemId" | "creatorId">): Promise<boolean> {
  const [item, offer, refunds] = await Promise.all([
    prisma.campaignBookingItem.findUnique({ where: { id: p.bookingItemId }, select: { status: true } }),
    prisma.creatorOffer.findUnique({ where: { bookingItemId: p.bookingItemId }, select: { creatorId: true, status: true, linkVerifiedAt: true } }),
    prisma.campaignRefund.count({ where: { bookingItemId: p.bookingItemId, status: { not: "failed" } } }),
  ]);
  if (!item || !LIVE_ITEM_STATUSES_FOR_RELEASE.includes(item.status)) return false;
  if (!offer || offer.creatorId !== p.creatorId || offer.status !== "completed" || offer.linkVerifiedAt === null) return false;
  return refunds === 0;
}

const REFERENCE_RE = /^[A-Za-z0-9][A-Za-z0-9 _./:#-]{3,99}$/;
const PAN_SHAPE = /[A-Za-z]{5}[0-9]{4}[A-Za-z]/;
const IFSC_SHAPE = /[A-Za-z]{4}0[A-Za-z0-9]{6}/;
/** Every character REFERENCE_RE allows besides letters and digits: a PAN or an IFSC typed with them in the middle is still one. */
const REFERENCE_SEPARATORS = /[ _./:#-]/g;

/** Whether staff text for a bank-transfer reference may be kept: well formed, and not a PAN or an IFSC however it is spaced. */
export function referenceProblem(reference: string): "invalid" | "looks_like_bank_details" | null {
  if (!REFERENCE_RE.test(reference)) return "invalid";
  const flat = reference.replace(REFERENCE_SEPARATORS, "");
  if (PAN_SHAPE.test(reference) || IFSC_SHAPE.test(reference) || PAN_SHAPE.test(flat) || IFSC_SHAPE.test(flat)) return "looks_like_bank_details";
  return null;
}

/**
 * manual_required → paid_manual. Staff paid the creator by bank transfer and record the reference. Refused unless
 * the post is live and verified (post_not_live: postIsPayableByHand), and unless no transfer can still release money
 * (decideManualFallback): none was ever created, or a fresh read shows it failed with no other live transfer carrying
 * this payout's id, or it was reversed and the whole transfer is back. Paying by hand while a transfer could still
 * release is paying twice; paying for a post that never went live pays for nothing and strands the post's refund.
 *
 * The reference is kept exactly as typed, because it is a bank UTR and a UTR is a run of digits that a scrubber would
 * mask; so what is checked is its SHAPE (a PAN or an IFSC is refused however it is spaced, hyphenated or dotted), and
 * the free-text note beside it is scrubbed.
 */
export async function markManualPaid(payoutId: string, opts: StepOptions & { reference: string; note?: string }): Promise<StepResult> {
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? SYSTEM;
  const ctx = newCtx(payoutId);
  const p = await loadPayout(payoutId);
  if (!p) return result(ctx, null, false, "not_found");
  const reference = (opts.reference ?? "").trim();
  if (referenceProblem(reference) !== null) return result(ctx, p.status, false, "invalid_reference");
  if (p.status !== "manual_required") return result(ctx, p.status, false, "not_manual_required");
  // ⚠️ Only a post that went live and was verified is owed (see postIsPayableByHand): whoever asks, before any Razorpay read.
  if (!(await postIsPayableByHand(p))) return result(ctx, p.status, false, "refused", "post_not_live");

  // Fresh facts, read only when the decision needs them.
  if ((p.razorpayTransferId !== null || p.attempts > 0) && !razorpayConfig.configured()) return result(ctx, p.status, false, "refused", "listing_unchecked");
  const proof = await readNoTransferProof(ctx, p, { allowAttestation: actor.type === "staff" });
  const d = decideManualFallback({ status: p.status, transferId: p.razorpayTransferId, attempts: p.attempts, reversedAt: p.reversedAt, transfer: proof.transfer, transferChecked: proof.transferChecked, activeCarriers: proof.activeCarriers });
  if (!d.ok) return result(ctx, p.status, false, "refused", d.reason);

  const moved = await transition({
    id: p.id,
    from: ["manual_required"],
    to: "paid_manual",
    data: { manualReference: reference, manualPaidAt: now, manualPaidById: actor.id ?? null, manualNote: opts.note ? scrubStaffText(opts.note).slice(0, 500) : null, errorCode: null, lastError: null, lockedUntil: null, nextAttemptAt: null },
    kind: "manual",
    actor,
    note: `Paid by bank transfer (${d.basis}). Reference recorded.`,
  });
  return result(ctx, moved ? "paid_manual" : (await loadPayout(payoutId))?.status ?? null, moved, moved ? "paid_manual" : "lost_claim", moved ? d.basis : undefined);
}

// ── A listing that cannot be read: the two things a person can do ───────────────

/**
 * A person looked in the Razorpay dashboard and found NO transfer for this payout (nor a transfer carrying its id on the payment). Recorded as
 * an audit row with the person's id; it stands in for the payment-transfer listing, and only for a listing that cannot be read, in
 * requireManualPayment, markManualPaid and a staff Retry. It is valid only until the payout is sent to Razorpay again. Staff only.
 *
 * A payout that RECORDS a transfer can only be attested this way when its request was sent more than once and its next step is a twin
 * audit (the hold confirmation, the daily re-read, the release): the person then says "no transfer OTHER than the recorded one carries this
 * payout's id" (outcome attested_no_other; see hasNoOtherTransferAttestation for where it counts, and where it never does). Any other payout
 * with a transfer id is refused with transfer_exists (adopt or reverse that transfer instead): an attestation cannot hide a transfer we know of.
 */
export async function attestNoTransfer(payoutId: string, opts: StepOptions & { note: string; actor: PayoutActor }): Promise<StepResult> {
  const ctx = newCtx(payoutId);
  const p = await loadPayout(payoutId);
  if (!p) return result(ctx, null, false, "not_found");
  if (opts.actor.type !== "staff" || !opts.actor.id) return result(ctx, p.status, false, "needs_human");
  const text = scrubStaffText(opts.note);
  const noOther = p.razorpayTransferId !== null;
  if (noOther) {
    const twinAudited = p.attempts > 1 && TWIN_AUDITED_STATUSES.includes(p.status) && (p.status !== "needs_attention" || HOLD_RESOLVABLE_REASONS.includes(p.errorCode ?? ""));
    if (!twinAudited) return result(ctx, p.status, false, "refused", "transfer_exists");
  } else if (!["needs_attention", "failed", "transfer_requested", "manual_required"].includes(p.status) || p.attempts === 0) {
    return result(ctx, p.status, false, "not_applicable");
  }
  // ⚠️ What a person sees in the dashboard less than ABSENT_CHECK_GAP_MS after the payout's last request proves no more than a listing taken then
  // would: that request may still be on its way in. Such an attestation is refused, not recorded (the "no other" form could never count anyway).
  const now = opts.now ?? new Date();
  if (p.transferRequestedAt !== null && now.getTime() - p.transferRequestedAt.getTime() < ABSENT_CHECK_GAP_MS) return result(ctx, p.status, false, "refused", "attest_too_soon");
  if (noOther) {
    await prisma.creatorPayoutEvent.create({
      data: {
        payoutId: p.id,
        bookingId: p.bookingId,
        kind: ATTEST_ONLY_KIND,
        fromStatus: p.status,
        toStatus: p.status,
        amountPaise: p.amountPaise,
        actorType: "staff",
        actorId: opts.actor.id,
        note: note(`Staff checked the Razorpay dashboard: no transfer other than the one this payout records carries its id. ${text}`),
        ...(opts.now ? { createdAt: opts.now } : {}),
      },
    });
    return result(ctx, p.status, true, "attested_no_other");
  }
  await prisma.creatorPayoutEvent.create({
    data: {
      payoutId: p.id,
      bookingId: p.bookingId,
      kind: ATTEST_KIND,
      fromStatus: p.status,
      toStatus: p.status,
      amountPaise: p.amountPaise,
      actorType: "staff",
      actorId: opts.actor.id,
      note: note(`Staff checked the Razorpay dashboard and found no transfer for this payout. ${text}`),
      ...(opts.now ? { createdAt: opts.now } : {}),
    },
  });
  return result(ctx, p.status, true, "attested");
}

/**
 * A person found this payout's transfer in the Razorpay dashboard (its id) while the payment's transfer listing could not be read. The
 * engine reads THAT transfer and adopts it only if it is this payout's: carrying this payout's id in its notes, the same linked account,
 * the same payment, the same amount. Never a transfer on the staff member's word alone. Works for a payout parked as listing_unreadable
 * (or any parked payout that has no transfer id yet); it goes back to transfer_requested with the id recorded and is judged like any
 * transfer found by a listing (held, a twin audit for a repeated request, a mismatch parked). Like a listing, it never takes a transfer that
 * failed or was fully taken back unless the CURRENT request made it (refused: transfer_from_earlier_request, the payout stays parked).
 */
export async function adoptTransferByStaff(payoutId: string, opts: StepOptions & { transferId: string; actor: PayoutActor }): Promise<StepResult> {
  const now = opts.now ?? new Date();
  const ctx = newCtx(payoutId);
  const p0 = await loadPayout(payoutId);
  if (!p0) return result(ctx, null, false, "not_found");
  if (opts.actor.type !== "staff") return result(ctx, p0.status, false, "needs_human");
  if (p0.status !== "needs_attention" || p0.razorpayTransferId !== null) return result(ctx, p0.status, false, "not_applicable");
  if (!razorpayConfig.configured()) return result(ctx, p0.status, false, "disabled", "not_configured");
  const lease = await takeLease(payoutId, ["needs_attention"], now);
  if (!lease) return result(ctx, p0.status, false, "leased");
  try {
    let t: RazorpayTransfer;
    try {
      t = await rz(ctx, () => fetchTransfer(opts.transferId));
    } catch (err) {
      // A definite refusal of the read (no such transfer, a malformed id) is the person's mistake, not Razorpay being down.
      return isDefinitelyRejected(err) ? result(ctx, p0.status, false, "refused", "transfer_not_found") : result(ctx, p0.status, false, "unread", errCode(err));
    }
    if (t.notes.payout_id !== p0.id || !transferMatches(p0, t) || t.source === null) return result(ctx, p0.status, false, "refused", "transfer_not_ours");
    // ⚠️ decideTransferRetry's own rule, before anything moves: a LIVE transfer counts whichever request made it, but a DEAD one (failed, or
    // fully reversed) counts only when the CURRENT request made it (its notes.attempt is this payout's request key, as read under the claim).
    // A failed transfer left over from an earlier request (before a staff Retry, say) is history: adopting it would call the payout failed, the
    // refund would then void it, and the current request's transfer would sit held in the linked account with nothing tracking it. A dead
    // transfer that carries no key at all is never trusted.
    const cur = (await loadPayout(payoutId)) ?? p0;
    const requestKey = requestKeyOf(cur.attempts, cur.transferRequestedAt);
    const carrier = carrierOf(t);
    if ((carrier.status === "failed" || isFullyReversed(carrier)) && (requestKey === null || carrier.generation !== requestKey)) {
      return result(ctx, cur.status, false, "refused", "transfer_from_earlier_request");
    }
    // Recorded on another payout already (it would fail the unique id AFTER the payout had left its park): refused before anything moves.
    if ((await prisma.creatorPayout.count({ where: { razorpayTransferId: t.id, id: { not: p0.id } } })) > 0) return result(ctx, p0.status, false, "refused", "transfer_in_use");
    const back = await transition({
      id: p0.id,
      from: ["needs_attention"],
      to: "transfer_requested",
      where: { razorpayTransferId: null },
      data: { errorCode: null, lastError: null, nextAttemptAt: null },
      kind: "transfer",
      actor: opts.actor,
      note: "Staff found this payout's transfer in Razorpay and gave its id; the transfer is read and checked before it is recorded.",
    });
    if (!back) return result(ctx, (await loadPayout(payoutId))?.status ?? null, false, "lost_claim");
    return adoptTransfer(ctx, (await loadPayout(payoutId))!, t, now, opts.actor, "Staff identified this payout's transfer.");
  } finally {
    await dropLease(payoutId, lease);
  }
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
      data: { payoutId, bookingId: cur.bookingId, kind: "pause", fromStatus: cur.status, toStatus: cur.status, amountPaise: cur.amountPaise, actorType: actor.type, actorId: actor.id ?? null, note: note(`Paused${opts.reason ? ` (${scrubStaffText(opts.reason)})` : ""}.`) },
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
      // Too late to hold it: record what was read (the settlement status is what takes this payout out of the re-hold bucket, so the
      // settlement poll can finish it) and make the poll due now. A person is told once an hour.
      await prisma.creatorPayout.updateMany({ where: { id: p.id, status: "released" }, data: { ...columnsFrom(t, now), lockedUntil: null, nextAttemptAt: null } });
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
 * The payouts each job should look at now, in the plan's order (P4 reconciliation jobs 1 to 9). A row leased by another step, or backed
 * off to a later time, is not due. `release` lists only held payouts whose release_after has passed and that are not paused:
 * releasePayout still evaluates the whole gate.
 *
 * ⚠️ FAIR, because the cut at `limit` is made HERE and the worker can only reorder what it is given. The buckets are merged in the
 * worker's own priority order (taking money back, putting a lost hold back and clearing up come before letting more money out, and the
 * settlement poll, which only reads, comes last), and the two buckets that can hold a long backlog of payouts that do nothing (new
 * transfers waiting for an account, releases that keep being refused) are each capped at a third of the limit, so a backlog of either
 * can never crowd out a reversal, a settlement poll or the daily re-read. The release bucket is not even queried while the release
 * switch is off (every row in it would be refused again, at no gain), and it resumes at once when the switch goes back on. Every
 * bucket skips what is backed off (`nextAttemptAt`), which is what keeps a refused payout from coming back every tick.
 */
export async function selectDuePayouts(now: Date, limit = 50): Promise<Array<{ id: string; job: PayoutJob }>> {
  const unleased: Prisma.CreatorPayoutWhereInput = { OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] };
  const due: Prisma.CreatorPayoutWhereInput = { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] };
  const q = (where: Prisma.CreatorPayoutWhereInput, order: "createdAt" | "lastCheckedAt" = "createdAt") =>
    prisma.creatorPayout.findMany({ where: { AND: [where, unleased] }, select: { id: true }, orderBy: order === "createdAt" ? { createdAt: "asc" } : { lastCheckedAt: "asc" }, take: limit });
  const dayAgo = new Date(now.getTime() - HELD_RECHECK_MS);
  const releaseOn = await releaseSwitchOn();
  const [execute, unknown, unreadable, confirm, parkedHold, dup, release, resolveRel, settle, reversal, recheck, rehold] = await Promise.all([
    q({ status: "planned", pausedAt: null, AND: [due] }),
    q({ status: "transfer_requested", razorpayTransferId: null, AND: [due] }),
    // Parked with no transfer id (the list could not be read, or a repeated request showed nothing): listed again hourly, and resumed by itself
    // when the list works or a transfer carrying the payout's id turns up (PARKED_UNKNOWN_CODES; resolveUnknownTransfer's `parked` test agrees).
    q({ status: "needs_attention", errorCode: { in: [...PARKED_UNKNOWN_CODES] }, razorpayTransferId: null, AND: [due] }),
    q({ status: "transfer_requested", razorpayTransferId: { not: null }, AND: [due] }),
    // Parked because the hold was gone (processed and not on hold, or with an automatic release date): the hold was put back, and this read
    // is what puts the payout back to `held`, or puts the hold back again.
    q({ status: "needs_attention", razorpayTransferId: { not: null }, errorCode: { in: [...HOLD_RESOLVABLE_REASONS] }, AND: [due] }),
    q({ status: "needs_attention", errorCode: "duplicate_transfer", AND: [due] }),
    releaseOn ? q({ status: "held", pausedAt: null, releaseAfter: { lte: now }, AND: [due] }) : Promise.resolve([] as Array<{ id: string }>),
    q({ status: "release_requested" }),
    q({ status: { in: ["released", "settlement_failed"] }, AND: [due] }),
    q({ status: "reversal_requested", AND: [due] }),
    q({ status: "held", AND: [due], OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: dayAgo } }] }, "lastCheckedAt"),
    // Only a dispute or an outside refund pauses a released payout in a way that asks for its hold back (a staff pause is the staff's to act on),
    // and one that has already SETTLED cannot be re-held: it is left to the settlement poll, or the same row would shadow it for ever.
    q({
      status: "released",
      pausedAt: { not: null },
      pausedReason: { in: ["dispute", "external_refund"] },
      // (`not` alone would also drop the rows where the column is still empty.)
      AND: [due, { OR: [{ settlementStatus: null }, { settlementStatus: { not: "settled" } }] }, { OR: [{ recipientSettlementStatus: null }, { recipientSettlementStatus: { not: "processed" } }] }],
    }),
  ]);
  const out: Array<{ id: string; job: PayoutJob }> = [];
  const seen = new Set<string>();
  const backlogCap = Math.max(1, Math.ceil(limit / 3));
  const add = (rows: Array<{ id: string }>, job: PayoutJob, cap = limit) => {
    let taken = 0;
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      if (out.length >= limit || taken >= cap) break;
      seen.add(r.id);
      out.push({ id: r.id, job });
      taken++;
    }
  };
  // The worker's priority order (cron/creator-payouts.cron.ts PRIORITY), with the re-hold of a parked payout right behind the reversals.
  add(reversal, "resolve_reversal");
  add(rehold, "rehold_paused");
  add(parkedHold, "confirm_hold");
  add(unknown, "resolve_unknown");
  add(unreadable, "resolve_unknown");
  add(dup, "cleanup_duplicates");
  add(execute, "execute", backlogCap);
  add(confirm, "confirm_hold");
  add(resolveRel, "resolve_release");
  add(release, "release", backlogCap);
  add(settle, "poll_settlement");
  add(recheck, "recheck_held");
  return out;
}
