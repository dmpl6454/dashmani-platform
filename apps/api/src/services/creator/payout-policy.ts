/**
 * The creator-payout DECISIONS, as pure functions. No database, no Razorpay, no clock, no environment.
 * The engine (payout.service.ts) reads facts, asks one of these what to do, and does exactly that. So the
 * rules that keep money from leaving by mistake live in one reviewable file, and a test can enumerate them.
 *
 * ⚠️ THE PRINCIPLE: FAIL CLOSED. Every function here answers "no" (or "wait", or "park for a human") when
 * a fact is missing, unreadable, unchecked or in doubt. A fact that was not read is never treated as the
 * good value: it is its own refusal reason (`*_unchecked`, `transfer_unreadable`). The only way to the
 * `ok: true` answer of evaluateRelease is for EVERY precondition to hold at once.
 *
 * Sources: docs/superpowers/plans/2026-10-12-creator-payouts-razorpay-route.md, Phase 4. "P4" below is
 * that section; [R#] are the plan's Razorpay source keys.
 */
import { canMove, isPayoutStatus, mapTransferEvent, reservesItemPrice, type PayoutStatus, type TransferFacts } from "./payout-states";

// ── Constants (each one a decision the plan states) ─────────────────────────────

/** P4 Transfers: two listings "at least N minutes apart" must both miss the transfer before it is created again. */
export const ABSENT_CHECK_GAP_MS = 10 * 60_000;
/** The number of consecutive empty listings that proves a create call never landed. */
export const ABSENT_CHECKS_BEFORE_RETRY = 2;
/** P4 Transfers: "at most ONE automatic retry" = the first create call plus one more. */
export const MAX_CREATE_ATTEMPTS = 2;
/** P4 Release / plan section 3: "at least 1 day when ownership_check = manual_ok". */
export const MANUAL_OWNERSHIP_MIN_HOLD_DAYS = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Booking statuses in which a verified, live creator post can exist (approved on, and none that were rejected, refunded, cancelled or expired). */
export const RELEASABLE_BOOKING_STATUSES: readonly string[] = ["approved", "publishing", "completed", "partially_published"];
/** Booking statuses in which a transfer may still be made: paid, not rejected. */
export const TRANSFERABLE_BOOKING_STATUSES: readonly string[] = ["paid_pending_review", "changes_requested", "approved", "publishing", "completed", "partially_published"];
/** Item statuses that are live on the platform. */
export const LIVE_ITEM_STATUSES_FOR_RELEASE: readonly string[] = ["posted_manual", "published"];
/** Item statuses in which a transfer must NOT be made: the post will not happen or the money is being returned. */
export const UNPAYABLE_ITEM_STATUSES: readonly string[] = ["refunded", "refund_due", "failed"];
export const OWNERSHIP_PASSED: readonly string[] = ["auto_ok", "manual_ok"];
/** Only a dispute known to be WON lets a release through: open, under review, lost, closed and an unreadable status all block. */
export const DISPUTE_NOT_BLOCKING: readonly string[] = ["won"];
/** Payout statuses that may start (or resume) a reversal. needs_attention only for a person (see decideReversal). */
export const REVERSIBLE_FROM: readonly PayoutStatus[] = ["held", "released", "settlement_failed", "reversal_requested", "needs_attention"];

// ── Small helpers ───────────────────────────────────────────────────────────────

const isNonNegInt = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/** A transfer that has come back to us in full. */
export function isFullyReversed(t: { status: string; amount: number; amountReversed: number }): boolean {
  return t.status === "reversed" || (t.amount > 0 && t.amountReversed >= t.amount);
}

/** What remains of a transfer to take back: amount − amount_reversed (never negative). */
export function remainingToReverse(t: { amount: number; amountReversed: number }): number {
  return Math.max(0, t.amount - t.amountReversed);
}

// ── The release gate ────────────────────────────────────────────────────────────

/** What Razorpay says about the payout's transfer, read FRESH just before the release. */
export interface TransferView {
  id: string;
  status: string;
  onHold: boolean;
  onHoldUntil: number | null;
  amount: number;
  amountReversed: number;
  recipient: string;
  source: string | null;
}

export interface ReleaseFacts {
  now: Date;
  /** system_settings creatorPayouts.release is anything but 'off' (absent = on). */
  releaseEnabled: boolean;
  payout: {
    status: string;
    pausedAt: Date | null;
    releaseAfter: Date | null;
    amountPaise: number;
    transferId: string | null;
    razorpayAccountId: string;
    razorpayPaymentId: string;
  };
  booking: { status: string } | null;
  item: { status: string } | null;
  offer: { status: string; linkVerifiedAt: Date | null; ownershipCheck: string | null } | null;
  /** The status of every campaign_disputes row on the payment (our own record). */
  disputeStatuses: readonly string[];
  /** bankChangeBlocksRelease(payout account): a bank change is pending, or was cleared less than 72 hours ago. */
  bankChangeBlocks: boolean;
  /**
   * creators.status of the payout's creator: approved | closed | suspended | rejected | in_review | draft. null = the row could not be
   * read (or is gone), which is a refusal like any other unread fact. A creator staff suspended after verifying the post must not be
   * paid by the next worker tick, and "approved" is the only status the worker releases for.
   */
  creatorStatus: string | null;
  /**
   * A person asked for this release (a staff "Release now"). The only thing it changes: a creator who CLOSED their account after the
   * post was verified is owed the money (their payouts keep reconciling), so a person may release it, and the worker never does.
   */
  byStaff: boolean;
  /** The payout account's activation_status as we last stored it (the poll and the webhooks keep it current). null = no such account row. */
  accountActivation: string | null;
  // ── read from Razorpay, fresh ──
  transfer: TransferView | null;
  /**
   * Whether ANOTHER live transfer carries this payout's id on the payment (the create call was sent twice and both
   * landed). "none" is also what a payout whose create call was only ever sent once reports: a second transfer
   * cannot exist then, so no listing is needed. "unchecked" = it was asked and the listing could not be read.
   */
  duplicateTransfers: "none" | "found" | "unchecked";
  /** The payment's disputes asked of Razorpay. "unchecked" = the question could not be answered. */
  razorpayDisputes: "clear" | "blocking" | "unchecked";
  /**
   * The payment's refunds asked of Razorpay and set against OUR ledger (a refund webhook is the only other way we hear of one, and a
   * missed webhook leaves no trace): "unaccounted" = Razorpay shows more refunded than our books do, "covers_item" = our books show a
   * refund of THIS item (its price is going back to the brand, so the creator's share must not leave), "unchecked" = it could not be read.
   */
  razorpayRefunds: "clear" | "unaccounted" | "covers_item" | "unchecked";
  /** The linked account's Route product, asked of Razorpay. */
  account: "activated" | "not_activated" | "unchecked";
}

/** Every reason a release can be refused: a closed set, each with a test. */
export const RELEASE_REFUSALS = [
  "release_paused",
  "payout_not_held",
  "payout_paused",
  "no_transfer",
  "creator_not_active",
  "booking_not_releasable",
  "item_not_live",
  "offer_missing",
  "offer_not_completed",
  "link_not_verified",
  "ownership_unchecked",
  "dispute_recorded",
  "bank_change_pending",
  "release_not_scheduled",
  "release_not_due",
  "transfer_unreadable",
  "transfer_mismatch",
  "transfer_not_processed",
  "transfer_not_on_hold",
  "transfer_hold_expires",
  "transfer_reversed",
  "duplicate_transfer",
  "duplicate_unchecked",
  "dispute_at_razorpay",
  "dispute_unchecked",
  "refund_at_razorpay",
  "refund_unchecked",
  "account_not_activated",
  "account_unchecked",
] as const;
export type ReleaseRefusal = (typeof RELEASE_REFUSALS)[number];

export type ReleaseDecision = { ok: true } | { ok: false; reason: ReleaseRefusal };

const refuse = (reason: ReleaseRefusal): ReleaseDecision => ({ ok: false, reason });
const OK: ReleaseDecision = { ok: true };

/**
 * Everything that can be judged WITHOUT asking Razorpay. The engine runs this first, so a release that is
 * refused for a local reason costs no Razorpay call at all.
 */
export function evaluateLocalRelease(f: ReleaseFacts): ReleaseDecision {
  if (!f.releaseEnabled) return refuse("release_paused");
  if (f.payout.status !== "held") return refuse("payout_not_held");
  if (f.payout.pausedAt !== null) return refuse("payout_paused");
  if (!f.payout.transferId) return refuse("no_transfer");
  // The creator's own standing. A suspended, rejected or unreadable creator is never paid (staff must reinstate first); one who closed
  // the account is paid only by a person.
  if (!(f.creatorStatus === "approved" || (f.creatorStatus === "closed" && f.byStaff))) return refuse("creator_not_active");
  if (!f.booking || !RELEASABLE_BOOKING_STATUSES.includes(f.booking.status)) return refuse("booking_not_releasable");
  if (!f.item || !LIVE_ITEM_STATUSES_FOR_RELEASE.includes(f.item.status)) return refuse("item_not_live");
  if (!f.offer) return refuse("offer_missing");
  // A verified offer is `completed` with link_verified_at set (Phase 3): both, never one of them alone.
  if (f.offer.status !== "completed") return refuse("offer_not_completed");
  if (f.offer.linkVerifiedAt === null) return refuse("link_not_verified");
  if (f.offer.ownershipCheck === null || !OWNERSHIP_PASSED.includes(f.offer.ownershipCheck)) return refuse("ownership_unchecked");
  if (f.disputeStatuses.some((s) => !DISPUTE_NOT_BLOCKING.includes(s))) return refuse("dispute_recorded");
  if (f.bankChangeBlocks) return refuse("bank_change_pending");
  // What we last stored of the linked account's state; the fresh read of Razorpay's product (below) stays the authority for ALLOWING.
  // A stale "not activated" only delays a release until the next poll, and costs no Razorpay call to say so.
  if (f.accountActivation !== "activated") return refuse("account_not_activated");
  if (f.payout.releaseAfter === null) return refuse("release_not_scheduled");
  if (f.payout.releaseAfter.getTime() > f.now.getTime()) return refuse("release_not_due");
  return OK;
}

/** The fresh transfer must be exactly what we set aside: processed, on hold with no automatic release, never reversed, ours. */
export function evaluateTransferForRelease(f: Pick<ReleaseFacts, "payout" | "transfer">): ReleaseDecision {
  const t = f.transfer;
  if (!t) return refuse("transfer_unreadable");
  if (t.id !== f.payout.transferId || t.recipient !== f.payout.razorpayAccountId || t.amount !== f.payout.amountPaise || (t.source !== null && t.source !== f.payout.razorpayPaymentId)) {
    return refuse("transfer_mismatch");
  }
  if (t.status !== "processed") return refuse("transfer_not_processed");
  if (t.onHold !== true) return refuse("transfer_not_on_hold");
  if (t.onHoldUntil !== null) return refuse("transfer_hold_expires");
  if (t.amountReversed !== 0) return refuse("transfer_reversed");
  return OK;
}

/** What else Razorpay says: no duplicate transfer, no dispute that is not won, no refund our books do not know, an activated account. */
export function evaluateRemoteForRelease(f: Pick<ReleaseFacts, "razorpayDisputes" | "razorpayRefunds" | "account" | "duplicateTransfers">): ReleaseDecision {
  if (f.duplicateTransfers === "found") return refuse("duplicate_transfer");
  if (f.duplicateTransfers !== "none") return refuse("duplicate_unchecked");
  if (f.razorpayDisputes === "blocking") return refuse("dispute_at_razorpay");
  if (f.razorpayDisputes !== "clear") return refuse("dispute_unchecked");
  if (f.razorpayRefunds === "unaccounted" || f.razorpayRefunds === "covers_item") return refuse("refund_at_razorpay");
  if (f.razorpayRefunds !== "clear") return refuse("refund_unchecked");
  if (f.account === "not_activated") return refuse("account_not_activated");
  if (f.account !== "activated") return refuse("account_unchecked");
  return OK;
}

/**
 * P4 Release: the ONE function that says whether a held payout may be released. Money leaves our control
 * only when this returns { ok: true }, and it does only when every fact below holds at the same time:
 *
 *   the switch is on · payout held and not paused · a transfer exists · the creator is approved (a creator who
 *   closed the account is released for by a person only) · booking approved on · item live · offer completed
 *   with a verified link and a passed ownership check · no dispute on our books · no bank change in flight · the
 *   linked account is activated as we stored it · release_after set and reached · the FRESH transfer is
 *   processed, on hold, without an automatic release date, never reversed, and is ours · no duplicate transfer
 *   carries our id · Razorpay lists no dispute that is not won · Razorpay shows no refund our books do not know
 *   and none of this item · the linked account is activated as Razorpay says now.
 *
 * Anything missing, unreadable or unchecked is a refusal with its own reason. Local checks come first and
 * the reason returned is the first that fails, in the order of RELEASE_REFUSALS (documentation order, not
 * priority: the answer is "no" either way).
 */
export function evaluateRelease(f: ReleaseFacts): ReleaseDecision {
  const local = evaluateLocalRelease(f);
  if (!local.ok) return local;
  const transfer = evaluateTransferForRelease(f);
  if (!transfer.ok) return transfer;
  return evaluateRemoteForRelease(f);
}

/**
 * How a payment's refunds, as Razorpay lists them, compare with our own ledger of them. A refund that Razorpay shows and our books
 * do not (a staff refund from the Razorpay dashboard whose webhook was lost or is late) means the brand has already been repaid
 * out of our balance, and paying the creator as well is paying twice. A refund of THIS item in our own ledger says the same.
 * A refund of a DIFFERENT item is normal and never blocks: our ledger carries it and the totals agree.
 */
export function decideRefundVerdict(f: {
  /** What Razorpay says is refunded on the payment (pending and processed, not failed). */
  razorpayRefundedPaise: number;
  /** Our ledger's refunds of the payment that did not fail, whatever their origin (our own in-flight ones count). */
  ledger: ReadonlyArray<{ amountPaise: number; bookingItemId: string | null }>;
  itemId: string;
}): "clear" | "unaccounted" | "covers_item" {
  if (f.ledger.some((r) => r.bookingItemId === f.itemId)) return "covers_item";
  const known = f.ledger.reduce((sum, r) => sum + r.amountPaise, 0);
  return f.razorpayRefundedPaise > known ? "unaccounted" : "clear";
}

const REFUSAL_MIN_BACKOFF_MS = 30 * 60_000;
const REFUSAL_MAX_BACKOFF_MS = 6 * 60 * 60_000;
const REFUSAL_TRANSIENT_BACKOFF_MS = 15 * 60_000;
/** Refusals that read as "we could not ask", which clear on their own: asked again after a short wait. */
const TRANSIENT_REFUSALS: readonly ReleaseRefusal[] = ["transfer_unreadable", "duplicate_unchecked", "dispute_unchecked", "refund_unchecked", "account_unchecked"];
/**
 * Refusals that need no wait because the row is not selected again anyway (not held, paused, not scheduled, not due) or because the
 * whole bucket is skipped (the release switch is off, so a release resumes the moment it is switched on).
 */
const NO_BACKOFF_REFUSALS: readonly ReleaseRefusal[] = ["release_paused", "payout_not_held", "payout_paused", "no_transfer", "release_not_scheduled", "release_not_due"];

/**
 * When a release the gate REFUSED should be looked at again by the worker (null = no wait). Every refusal that can go on for a long time
 * is waited on, whether it was reached locally or after asking Razorpay: a few payouts that stay refused would otherwise sit in every
 * tick's selection and spend the per-tick request budget on every tick, and every payout behind them would wait for ever. A transient
 * refusal waits a quarter of an hour; a persistent one waits a quarter of the time it has already been overdue, between half an hour
 * and six hours. (A person's "Release now" never waits on this, and never writes it.)
 */
export function releaseRefusalBackoffMs(reason: ReleaseRefusal, o: { now: Date; releaseAfter: Date | null }): number | null {
  if (NO_BACKOFF_REFUSALS.includes(reason)) return null;
  if (TRANSIENT_REFUSALS.includes(reason)) return REFUSAL_TRANSIENT_BACKOFF_MS;
  const overdue = o.releaseAfter === null ? 0 : Math.max(0, o.now.getTime() - o.releaseAfter.getTime());
  return Math.min(REFUSAL_MAX_BACKOFF_MS, Math.max(REFUSAL_MIN_BACKOFF_MS, Math.floor(overdue / 4)));
}

/**
 * The wait before a payout that Razorpay shows NOT on hold (parked, with the hold put back) is read again: 5 minutes after the first
 * check, doubling each time, never more than 2 hours. `checks` = how many reads have already found it still not held.
 */
export function heldAnomalyBackoffMs(checks: number): number {
  const n = Number.isFinite(checks) ? Math.max(0, Math.min(10, Math.floor(checks))) : 0;
  return Math.min(2 * 60 * 60_000, 5 * 60_000 * 2 ** n);
}

/**
 * How long a `planned` payout that waits (the linked account not ready, the item closed, paused …) is left alone before the worker looks
 * at it again: a quarter of the time it has already been waiting, between 5 minutes and an hour. A capture that has not landed yet is
 * looked at again after 2 minutes. `ageMs` = how long ago the payout was planned.
 */
export function plannedWaitBackoffMs(reason: string, ageMs: number): number {
  if (reason === "payment_not_captured") return 2 * 60_000;
  const age = Number.isFinite(ageMs) ? Math.max(0, ageMs) : 0;
  return Math.min(60 * 60_000, Math.max(5 * 60_000, Math.floor(age / 4)));
}

/**
 * P4 Release / section 3: release_after = verified_at + max(CREATOR_PAYOUT_HOLD_DAYS, 1 day when ownership was
 * checked by hand). An ownership value that is not an explicit automatic pass also gets the one-day floor (it
 * is never trusted to need none). A holdDays that is not a non-negative finite number counts as 0.
 */
export function releaseAfter(verifiedAt: Date, ownershipCheck: string | null | undefined, holdDays: number): Date {
  const configured = Number.isFinite(holdDays) && holdDays > 0 ? holdDays : 0;
  const floor = ownershipCheck === "auto_ok" ? 0 : MANUAL_OWNERSHIP_MIN_HOLD_DAYS;
  return new Date(verifiedAt.getTime() + Math.max(configured, floor) * DAY_MS);
}

// ── Creating the transfer, and what an unknown answer means ─────────────────────

/** One transfer of the payment that carries our payout id in its notes. */
export interface CarrierTransfer {
  id: string;
  status: string;
  amount: number;
  amountReversed: number;
  recipient: string;
  /** unix seconds; null when Razorpay sent none. Used only to pick which of two duplicates to keep. */
  createdAt: number | null;
  /** notes.attempt: the request that made this transfer (see requestKeyOf). null on a transfer that carries none. */
  generation: string | null;
}

/**
 * Names ONE request to Razorpay for a payout: how many create calls the payout had sent when this one went out, and the second it was
 * claimed. A payout can be sent more than once (the automatic retry, a staff Retry), and the key is written into the transfer's notes
 * so a transfer found later in a listing says WHICH request made it. null = the payout never recorded a request time.
 */
export function requestKeyOf(attempts: number, requestedAt: Date | null): string | null {
  return requestedAt === null ? null : `${attempts}.${Math.floor(requestedAt.getTime() / 1000)}`;
}

export interface TransferRetryFacts {
  now: Date;
  /** Create calls sent so far (the first one counts). */
  attempts: number;
  /** Consecutive listings that showed no carrier. */
  absentChecks: number;
  /** When the last listing that counted as "absent" was read. */
  lastCheckedAt: Date | null;
  /** Any refund that is not failed exists on the payment: no transfer can be made from it any more [R4]. */
  refundExists: boolean;
  /** The transfer id we already stored, if any. */
  storedTransferId: string | null;
  /** The key of the CURRENT request (requestKeyOf), or null when none was recorded. */
  requestKey: string | null;
  expected: { recipient: string; amountPaise: number };
  /** THIS listing: every transfer of the payment whose notes.payout_id is this payout's. */
  carriers: readonly CarrierTransfer[];
}

export type TransferRetryDecision =
  /** Exactly one live transfer carries our id: record it. */
  | { action: "adopt"; transferId: string }
  /** The only carrier failed: record it, and the payout is a definite failure. */
  | { action: "adopt_failed"; transferId: string }
  /** Two or more live carriers: keep one, reverse the rest while they are still on hold. */
  | { action: "duplicates"; keep: string; extras: string[] }
  /** Not enough evidence yet: another listing is needed. `count` says whether this one counts as an absent check. */
  | { action: "wait"; countAbsent: boolean; absentChecks: number }
  /** Two listings, far enough apart, both empty: the create call never landed. Send it once more. */
  | { action: "retry" }
  /** No transfer can be created (a refund exists): staff pay by hand, Retry is disabled. */
  | { action: "manual_required"; reason: string }
  /** A person must look. */
  | { action: "needs_attention"; reason: string };

/**
 * P4 Transfers. There is no idempotency key for a transfer made from a payment [R3], so after a timeout or
 * an unreadable answer the only way to know whether it landed is to LIST the payment's transfers and look for
 * our payout_id. A create call is repeated only when two such listings, at least ABSENT_CHECK_GAP_MS apart,
 * both showed nothing, and at most once automatically. A listing that fails never reaches this function: an
 * unread list is not an empty one.
 */
export function decideTransferRetry(f: TransferRetryFacts): TransferRetryDecision {
  // ⚠️ A LIVE transfer always counts, whichever request made it (money is out). A transfer that is NOT live (failed, reversed) counts
  // only when it was made by THIS request: a failed one left over from an earlier request (before a staff Retry, say) is history, and
  // adopting it as "the outcome" would call the payout failed while the retry's own transfer, which has simply not shown up in the
  // listing yet, sits held in the linked account with nothing tracking it. A non-live carrier with no key at all is never trusted.
  const live = f.carriers.filter((c) => c.status !== "failed" && !isFullyReversed(c));
  const outcomes = [...live, ...f.carriers.filter((c) => (c.status === "failed" || isFullyReversed(c)) && f.requestKey !== null && c.generation === f.requestKey)];
  const mismatched = live.some((c) => c.recipient !== f.expected.recipient || c.amount !== f.expected.amountPaise);
  if (live.length === 0 && outcomes.length > 0) {
    // Everything of this request that carries our id has failed or been reversed. A failure is a definite outcome; a reversal
    // nobody asked for is not ours to interpret.
    const failed = outcomes.filter((c) => c.status === "failed");
    if (failed.length === outcomes.length) return { action: "adopt_failed", transferId: pickKeeper(failed, f.storedTransferId) };
    return { action: "needs_attention", reason: "reversed_outside_flow" };
  }
  if (live.length >= 1 && mismatched) return { action: "needs_attention", reason: "transfer_mismatch" };
  if (live.length === 1) return { action: "adopt", transferId: live[0].id };
  if (live.length > 1) {
    const keep = pickKeeper(live, f.storedTransferId);
    return { action: "duplicates", keep, extras: live.map((c) => c.id).filter((id) => id !== keep) };
  }

  // Nothing carries our id.
  const counted = f.lastCheckedAt === null || f.now.getTime() - f.lastCheckedAt.getTime() >= ABSENT_CHECK_GAP_MS;
  const absent = counted ? f.absentChecks + 1 : f.absentChecks;
  if (absent < ABSENT_CHECKS_BEFORE_RETRY) return { action: "wait", countAbsent: counted, absentChecks: absent };
  // Two empty listings, far enough apart. The create call did not land.
  if (f.refundExists) return { action: "manual_required", reason: "no_transfer_after_refund" };
  if (f.attempts >= MAX_CREATE_ATTEMPTS) return { action: "needs_attention", reason: "transfer_unknown_after_retry" };
  return { action: "retry" };
}

/** Which of several carriers to keep: the one we already stored, else the earliest created, else the smallest id (a stable choice that never flips). */
function pickKeeper(list: readonly CarrierTransfer[], stored: string | null): string {
  if (stored && list.some((c) => c.id === stored)) return stored;
  const sorted = [...list].sort((a, b) => (a.createdAt ?? Number.MAX_SAFE_INTEGER) - (b.createdAt ?? Number.MAX_SAFE_INTEGER) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return sorted[0].id;
}

export interface CreateFacts {
  /** The payment has a refund (not failed) or is not in `captured`. */
  refundExists: boolean;
  paymentCaptured: boolean;
  bookingStatus: string | null;
  itemStatus: string | null;
  accountActivated: boolean;
  paused: boolean;
  amountPaise: number;
}

export type CreateDecision =
  | { action: "create" }
  /** Leave the payout `planned` and try again later; nothing was claimed. */
  | { action: "wait"; reason: string }
  /** A refund exists on the payment, so no transfer can ever be made: staff pay by hand. */
  | { action: "manual_required"; reason: string };

/** The smallest amount we will ask Razorpay to move, in paise: Razorpay's own floor is unclear (plan question f), so it is ₹100 as at rate-card time. */
export const MIN_TRANSFER_PAISE = 10_000;

/** Whether a planned payout may be turned into a transfer now. Anything doubtful waits; nothing is created on a guess. */
export function decideTransferCreation(f: CreateFacts): CreateDecision {
  if (f.paused) return { action: "wait", reason: "paused" };
  if (f.refundExists) return { action: "manual_required", reason: "refund_exists" };
  if (!f.paymentCaptured) return { action: "wait", reason: "payment_not_captured" };
  if (f.bookingStatus === null || !TRANSFERABLE_BOOKING_STATUSES.includes(f.bookingStatus)) return { action: "wait", reason: "booking_closed" };
  if (f.itemStatus === null || UNPAYABLE_ITEM_STATUSES.includes(f.itemStatus)) return { action: "wait", reason: "item_closed" };
  if (!f.accountActivated) return { action: "wait", reason: "account_not_ready" };
  if (!isNonNegInt(f.amountPaise) || f.amountPaise < MIN_TRANSFER_PAISE) return { action: "wait", reason: "amount_too_small" };
  return { action: "create" };
}

/** Staff Retry of a `failed` payout: only while nothing has been refunded on the payment [R4]. */
export function canRetryFailedTransfer(f: { status: string; refundExists: boolean }): boolean {
  return f.status === "failed" && !f.refundExists;
}

// ── Reversal ────────────────────────────────────────────────────────────────────

export interface ReversalFacts {
  payoutStatus: string;
  /** A person asked for it (a staff action). The system never reverses a payout that needs a human. */
  byStaff: boolean;
  /** The transfer, read FRESH after the claim. null = it could not be read. */
  transfer: { status: string; amount: number; amountReversed: number } | null;
}

export type ReversalDecision =
  /** Nothing left to take back: the transfer is fully reversed already. Idempotent success. */
  | { action: "already_reversed" }
  /** Take back exactly this many paise: amount − amount_reversed. Never "all". */
  | { action: "reverse"; amountPaise: number }
  | { action: "refuse"; reason: "not_reversible_state" | "needs_human" | "transfer_unreadable" | "transfer_not_processed" | "transfer_failed" | "bad_amounts" };

/**
 * P4 Reversal. The amount is ALWAYS explicit and computed from a fresh read [R16]: omitting it reverses the
 * whole transfer, and reverse_all reverses every transfer of the payment, other creators' shares included
 * [R14]. A transfer already fully reversed is a success, so a repeated call never errors and never reverses
 * twice. A transfer that is not yet processed (created, pending) cannot be reversed; one that failed has
 * nothing to take back and is a human's question.
 */
export function decideReversal(f: ReversalFacts): ReversalDecision {
  if (!isPayoutStatus(f.payoutStatus) || !REVERSIBLE_FROM.includes(f.payoutStatus)) return { action: "refuse", reason: "not_reversible_state" };
  if (f.payoutStatus === "needs_attention" && !f.byStaff) return { action: "refuse", reason: "needs_human" };
  const t = f.transfer;
  if (!t) return { action: "refuse", reason: "transfer_unreadable" };
  if (!isNonNegInt(t.amount) || !isNonNegInt(t.amountReversed) || t.amount <= 0 || t.amountReversed > t.amount) return { action: "refuse", reason: "bad_amounts" };
  if (isFullyReversed(t)) return { action: "already_reversed" };
  if (t.status === "failed") return { action: "refuse", reason: "transfer_failed" };
  if (t.status !== "processed" && t.status !== "partially_reversed") return { action: "refuse", reason: "transfer_not_processed" };
  return { action: "reverse", amountPaise: remainingToReverse(t) };
}

export type ReversalCallOutcome = "success" | "definite_rejection" | "unknown";

export interface ReversalOutcomeFacts {
  /** The status the payout had when the reversal was claimed. */
  priorStatus: string;
  outcome: ReversalCallOutcome;
  /** The transfer as last read fresh: still on hold and unsettled? null when unknown. */
  transferOnHold: boolean | null;
  transferSettled: boolean;
}

export interface ReversalOutcomeDecision {
  /** The payout's next status; null = keep `reversal_requested` and reconcile (an unknown result is neither success nor failure). */
  to: PayoutStatus | null;
  alert: boolean;
  reason: string;
}

/**
 * What a reversal call's answer does to the payout. A definite refusal puts the claim back to `held` ONLY when
 * the payout really was held and the transfer is still on hold and unsettled; anywhere else (a released payout,
 * money that may have reached the bank, where Razorpay refuses without a floating balance) it is
 * `needs_attention`. An unknown answer keeps the claim: it is never read as success and never as failure.
 */
export function decideReversalOutcome(f: ReversalOutcomeFacts): ReversalOutcomeDecision {
  if (f.outcome === "success") return { to: "reversed", alert: false, reason: "reversed" };
  if (f.outcome === "unknown") return { to: null, alert: false, reason: "reversal_unknown" };
  if (f.priorStatus === "held" && f.transferOnHold === true && !f.transferSettled) return { to: "held", alert: true, reason: "reversal_refused" };
  return { to: "needs_attention", alert: true, reason: "reversal_refused_after_release" };
}

// ── Refunds ─────────────────────────────────────────────────────────────────────

export interface PayoutOfPayment {
  id: string;
  status: string;
  itemPricePaise?: number;
}

export interface RefundAllowance {
  /** False while a transfer can still be created: no refund may start [R4]. */
  allowed: boolean;
  /** The payouts that block (planned or transfer_requested). */
  blockedBy: string[];
  /** Payouts that can no longer ever be transferred because a refund exists: staff pay by hand. */
  manualRequired: string[];
  /** Staff Retry of a failed transfer: off once any refund exists. */
  retryAllowed: boolean;
}

/**
 * P4 "When refunds are allowed": "You cannot request a transfer on payment once a refund has been initiated"
 * [R4]. So no refund runs while any payout on the payment is `planned` or `transfer_requested` (the item
 * waits as refund_due and the sweep refunds it once allowed), and once ANY refund exists a transfer that
 * failed, or was never created, goes straight to manual_required with Retry disabled.
 */
export function decideRefundAllowed(payouts: readonly PayoutOfPayment[], refundsExist: boolean): RefundAllowance {
  const blockedBy = payouts.filter((p) => p.status === "planned" || p.status === "transfer_requested").map((p) => p.id);
  const manualRequired = refundsExist ? payouts.filter((p) => p.status === "planned" || p.status === "failed").map((p) => p.id) : [];
  return { allowed: blockedBy.length === 0, blockedBy, manualRequired, retryAllowed: !refundsExist };
}

/**
 * P4 "Reserved amount": the item price of every creator item whose payout is not reversed or void. A
 * payment's refundable amount is captured − refunded − this.
 */
export function reservedPaiseOf(payouts: ReadonlyArray<{ status: string; itemPricePaise: number }>): number {
  return payouts.reduce((sum, p) => (reservesItemPrice(p.status) ? sum + p.itemPricePaise : sum), 0);
}

// ── Manual fallback ─────────────────────────────────────────────────────────────

export interface ManualFallbackFacts {
  status: string;
  transferId: string | null;
  /** Create calls sent (0 = none was ever sent, so no transfer can exist). */
  attempts: number;
  reversedAt: Date | null;
  /** THIS payout's transfer, read fresh. null = it has none, or it could not be read (see `transferChecked`). */
  transfer: { status: string; amount: number; amountReversed: number } | null;
  transferChecked: boolean;
  /** Transfers of the payment carrying this payout_id that are still alive (not failed, not fully reversed). null = the listing was not read. */
  activeCarriers: number | null;
}

export type ManualFallbackDecision =
  | { ok: true; basis: "no_transfer" | "transfer_failed" | "reversed" }
  | { ok: false; reason: "not_manual_required" | "transfer_unchecked" | "listing_unchecked" | "transfer_active" | "transfer_not_failed" | "not_reversed" };

/**
 * P4 Manual fallback: `manual_required` → `paid_manual` only if
 *   (a) no transfer was ever created: none was ever sent, or a fresh listing shows none carrying our id;
 *   (b) a fresh read shows the transfer failed AND the payment lists no other live transfer with this payout_id;
 *   (c) the payout is reversed: it was reversed and a fresh read shows the whole transfer back.
 * Anything else is refused: paying by hand while a transfer could still release is paying twice.
 */
export function decideManualFallback(f: ManualFallbackFacts): ManualFallbackDecision {
  if (f.status !== "manual_required") return { ok: false, reason: "not_manual_required" };

  if (f.transferId === null) {
    if (f.attempts === 0) return { ok: true, basis: "no_transfer" };
    // A create call WAS sent: it may have landed unseen, so only a fresh listing can say.
    if (f.activeCarriers === null) return { ok: false, reason: "listing_unchecked" };
    return f.activeCarriers === 0 ? { ok: true, basis: "no_transfer" } : { ok: false, reason: "transfer_active" };
  }

  if (!f.transferChecked || !f.transfer) return { ok: false, reason: "transfer_unchecked" };
  if (f.activeCarriers === null) return { ok: false, reason: "listing_unchecked" };

  if (isFullyReversed(f.transfer)) {
    if (f.reversedAt === null) return { ok: false, reason: "not_reversed" };
    return f.activeCarriers === 0 ? { ok: true, basis: "reversed" } : { ok: false, reason: "transfer_active" };
  }
  if (f.transfer.status === "failed") return f.activeCarriers === 0 ? { ok: true, basis: "transfer_failed" } : { ok: false, reason: "transfer_active" };
  return { ok: false, reason: "transfer_not_failed" };
}

// ── Mapping a fresh read of the transfer onto a move ────────────────────────────

export interface TransferStateDecision {
  /** The status to move to; absent = no move (see `reason`). Always a legal canMove() edge. */
  to?: PayoutStatus;
  /** A stable code. */
  reason: string;
  /** Staff should hear about it now. */
  alert?: boolean;
  /** Something to DO to the transfer as well as recording it: put the hold back. */
  action?: "rehold";
}

/**
 * What a FRESH read of the transfer (a fetch, not a webhook) implies for a payout in `current`. It is
 * mapTransferEvent plus the cases only a fresh read can judge: a held payout whose hold has gone, a
 * release that took effect, a released payout that is held again. Every move it proposes is a legal edge of
 * the state table (tested for every status against a grid of facts).
 *
 * "held" is claimed ONLY for status processed + on_hold true + no on_hold_until. A transfer that is processed
 * but not on hold, or that Razorpay will release by itself, is NEVER recorded as held: the payout parks in
 * needs_attention, the caller puts the hold back (`action: "rehold"`) and staff are told.
 */
export function mapTransferFactsToState(current: string, facts: TransferFacts): TransferStateDecision {
  if (!isPayoutStatus(current)) return { reason: "unknown_status" };
  const settled = facts.recipientSettlementStatus === "processed" || facts.settlementStatus === "settled";
  const reversedSomewhat = facts.status === "reversed" || facts.status === "partially_reversed" || (facts.amountReversed !== null && facts.amountReversed > 0);

  switch (current) {
    case "release_requested": {
      if (reversedSomewhat) return fromEvent(current, facts);
      if (facts.status === "processed" && facts.onHold === false) return { to: "released", reason: "released" };
      if (facts.onHold === true) return { reason: "still_on_hold" };
      return { reason: "in_flight" };
    }
    case "held": {
      if (reversedSomewhat) return fromEvent(current, facts);
      if (facts.status === "failed") return { to: "needs_attention", reason: "failed_while_held", alert: true };
      if (settled) return { to: "needs_attention", reason: "settled_while_held", alert: true };
      if (facts.status === "processed" && facts.onHold === false) return { to: "needs_attention", reason: "released_outside_flow", alert: true, action: "rehold" };
      if (facts.status === "processed" && facts.onHoldUntil !== null) return { to: "needs_attention", reason: "hold_expires", alert: true, action: "rehold" };
      return { reason: "confirmed_held" };
    }
    case "released": {
      if (facts.recipientSettlementStatus === "processed" || facts.recipientSettlementStatus === "failed" || reversedSomewhat) return fromEvent(current, facts);
      if (!settled && facts.onHold === true) return { to: "needs_attention", reason: "re_held_outside_flow", alert: true };
      return { reason: "awaiting_settlement" };
    }
    case "needs_attention": {
      // A fresh fetch may resolve a parked payout, and only to a state the facts PROVE. Settlement facts never
      // resolve it (a person decides what "Paid" means for a row that was parked).
      if (facts.recipientSettlementStatus !== null || settled) return { reason: "needs_human" };
      if (facts.status === "reversed" || (facts.amount !== null && facts.amount > 0 && facts.amountReversed !== null && facts.amountReversed >= facts.amount)) return { to: "reversed", reason: "reversed" };
      if (reversedSomewhat) return { reason: "needs_human" };
      if (facts.status === "failed") return { to: "failed", reason: "failed" };
      if (facts.status === "processed" && facts.onHold === true && facts.onHoldUntil === null) return { to: "held", reason: "confirmed_held" };
      if (facts.status === "processed" && (facts.onHold === false || facts.onHoldUntil !== null)) return { reason: "still_not_held", action: "rehold" };
      return { reason: "needs_human" };
    }
    case "transfer_requested":
    case "settlement_failed":
    case "reversal_requested":
      return fromEvent(current, facts);
    default:
      // planned, reversed, failed, manual_required and the terminal states: a transfer's facts do not move them.
      return { reason: "not_applicable" };
  }
}

/** mapTransferEvent, with the "put the hold back" action added where it asks for one. */
function fromEvent(current: PayoutStatus, facts: TransferFacts): TransferStateDecision {
  const move = mapTransferEvent(current, facts);
  const rehold = move.to === "needs_attention" && (move.reason === "processed_not_held" || move.reason === "processed_hold_expires");
  const out: TransferStateDecision = { reason: move.reason };
  if (move.to) {
    // Belt and braces: the policy never proposes a move the state table does not allow.
    if (!canMove(current, move.to)) return { reason: "illegal_move_suppressed" };
    out.to = move.to;
  }
  if (move.alert) out.alert = true;
  if (rehold) out.action = "rehold";
  return out;
}

// ── Pausing ─────────────────────────────────────────────────────────────────────

export type ResumeRefusal = "dispute_open" | "bank_change_pending" | "account_not_activated" | "not_paused";

/**
 * Staff may lift a pause only when nothing that caused one still holds: no dispute that is not won, no bank
 * change in flight, and an activated linked account. (The release gate checks all of it again at release time.)
 */
export function decideResume(f: { paused: boolean; disputeStatuses: readonly string[]; bankChangeBlocks: boolean; accountActivated: boolean }): { ok: true } | { ok: false; reason: ResumeRefusal } {
  if (!f.paused) return { ok: false, reason: "not_paused" };
  if (f.disputeStatuses.some((s) => !DISPUTE_NOT_BLOCKING.includes(s))) return { ok: false, reason: "dispute_open" };
  if (f.bankChangeBlocks) return { ok: false, reason: "bank_change_pending" };
  if (!f.accountActivated) return { ok: false, reason: "account_not_activated" };
  return { ok: true };
}
