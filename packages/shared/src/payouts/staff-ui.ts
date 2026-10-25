// Creator-payout display logic for the staff pages (the queue at /campaigns/payouts and the payout panel on a campaign).
// PURE: no React, no fetch, no clock of its own (a function that needs "now" is handed it), so the internal portal runs it and
// apps/api's vitest suite (the only test runner in the repo) tests it (tests/payout-staff-ui-helpers.test.ts), the way
// packages/shared/src/pipeline/* and growth/combine are. Import it by MODULE PATH ("@dashmani/shared/src/payouts/staff-ui"), never the
// "@dashmani/shared" barrel: the barrel drags zod and every validator into the page.
//
// ⚠️ THIS FILE DECIDES NOTHING ABOUT MONEY. The API's engine (apps/api services/creator/payout.service.ts) is the only thing that
// moves, holds, releases or reverses money, and it re-checks every condition on every click. What is here is wording, and which
// BUTTONS to offer so staff are not shown an action that can't apply. Where a button is offered that the engine may still refuse
// (a release the Razorpay dispute check blocks, a retry after a refund), the API's own refusal sentence is shown to the person.
//
// ⚠️ "PAID" IS NEVER A GUESS. Only `settled` (Razorpay settled the money to the creator's bank) and `paid_manual` (staff recorded
// their own bank transfer) read as paid. `released` means Razorpay was told to let go of the money: the creator has not received it.
//
// ⚠️ THREE LISTS HERE MIRROR THE API AND MUST NOT DRIFT: the queue's filters (PAYOUT_FILTER_KEYS = payout-staff.service PAYOUT_FILTERS,
// and payoutInFilter = its whereForFilter), the actions offered per status (actionsFor = the engine's legal moves), and the bank-reference
// check (referenceProblem = the engine's). tests/payout-staff-ui-helpers.test.ts holds each against the API's own copy.

import { formatStatus } from "../utils/status";

// ── Types: the API's JSON as the staff pages read it ────────────────────────────────────────────

/** The queue's views, exactly the API's `filter` values. */
export const PAYOUT_FILTER_KEYS = [
  "open",
  "needs_attention",
  "manual_required",
  "paused",
  "held_awaiting_verify",
  "releasing",
  "settlement_pending",
  "failed",
  "owed_after_reversal",
  "finished",
  "all",
] as const;
export type PayoutFilterKey = (typeof PAYOUT_FILTER_KEYS)[number];

/** What the queue answered about the switches that decide whether money moves (all optional: an older API sends none). */
export interface PayoutSwitches {
  /** false = ALL releases are paused (the runtime switch). The banner reads exactly `=== false`. */
  release?: boolean;
  /** CREATOR_ROUTE_ENABLED: whether NEW transfers to creators' accounts are being made. */
  newTransfers?: boolean;
  /** CREATOR_PAYOUT_CRON_ENABLED: whether the worker runs. */
  worker?: boolean;
  /** Whether Razorpay's keys are set on the API. false = nothing moves at all (every transfer, release and reversal is refused). */
  razorpay?: boolean;
}

export interface PayoutLastEvent {
  kind: string;
  toStatus: string | null;
  note: string | null;
  at: string;
}

/** One payout as the queue and the booking page list it. Dates arrive as ISO strings. */
export interface PayoutRow {
  id: string;
  bookingId: string;
  bookingName: string | null;
  bookingItemId: string;
  creatorId: string;
  creatorName: string | null;
  pageName: string | null;
  platform: string | null;
  format: string | null;
  status: string;
  pausedAt: string | null;
  pausedReason: string | null;
  /** What the client paid for this post. */
  itemPricePaise: number;
  /** The creator's share of it, the tax withheld from that share, and what is transferred (gross − tax). */
  grossPaise: number;
  tdsPaise: number;
  amountPaise: number;
  amountReversedPaise: number;
  /** "HDFC ••••1234": a masked reference, frozen when the money was released. null before that. */
  destinationHint: string | null;
  releaseAfter: string | null;
  heldAt: string | null;
  releasedAt: string | null;
  settledAt: string | null;
  reversedAt: string | null;
  errorCode: string | null;
  attempts: number;
  /** Razorpay's settlement UTR (a bank transaction reference, never an account detail): the answer to "was the creator paid?". */
  settlementUtr: string | null;
  /** The reference staff recorded for a bank transfer they made themselves, and when. */
  manualReference: string | null;
  manualPaidAt: string | null;
  /** The post's own status (posted_manual, refund_due, refunded …): a reversed payout of a LIVE post is money the creator is owed. */
  itemStatus: string | null;
  /** When staff verified the creator's link. A held row with this set and no releaseAfter is waiting for the worker to schedule it. */
  linkVerifiedAt: string | null;
  /** Whether a Razorpay transfer is recorded on the payout (the id itself is only in the detail). Absent from an older API: unknown. */
  hasTransfer?: boolean;
  createdAt: string;
  updatedAt: string;
  lastEvent: PayoutLastEvent | null;
}

/** What GET /admin/creator-payouts/:id adds to a row (the Razorpay ids are references, not bank details). */
export interface PayoutDetailFields {
  razorpayPaymentId: string | null;
  razorpayAccountId: string | null;
  razorpayTransferId: string | null;
  transferStatus: string | null;
  settlementStatus: string | null;
  recipientSettlementStatus: string | null;
  recipientSettlementId: string | null;
  settlementUtr: string | null;
  shareBps: number | null;
  tdsBps: number | null;
  nextAttemptAt: string | null;
  lastCheckedAt: string | null;
  onHoldVerifiedAt: string | null;
  transferRequestedAt: string | null;
  releaseRequestedAt: string | null;
  reversalRequestedAt: string | null;
  voidReason: string | null;
  /** Scrubbed by the API. */
  lastError: string | null;
  manualReference: string | null;
  manualPaidAt: string | null;
  manualNote: string | null;
}

export interface PayoutEvent {
  id: string;
  kind: string;
  fromStatus: string | null;
  toStatus: string | null;
  amountPaise: number | null;
  actorType: string;
  /** Scrubbed by the API: no amounts, ids or bank data. */
  note: string | null;
  createdAt: string;
}

/** What the booking detail carries per creator offer (`creatorOffers[].payout`), whatever state the payout is in. null = none created. */
export interface PayoutSummary {
  id: string;
  status: string;
  amountPaise: number;
  amountReversedPaise: number;
  pausedAt: string | null;
  pausedReason: string | null;
  releaseAfter: string | null;
  releasedAt: string | null;
  settledAt: string | null;
  reversedAt: string | null;
  settlementUtr: string | null;
  manualReference: string | null;
  manualPaidAt: string | null;
  errorCode: string | null;
}

/** GET /admin/creator-payouts/release-switch. `lastChange` is null when nobody ever changed it through the portal. */
export interface ReleaseSwitchState {
  key: string;
  release: "on" | "off";
  updatedAt: string | null;
  lastChange: { at: string; byId: string; byName: string | null; from: "on" | "off" | null; to: "on" | "off" | null } | null;
}

// ── Statuses ────────────────────────────────────────────────────────────────────────────────────

/** Nothing is in flight any more. (`reversed` has one way out: the creator may still be owed money, see isOwedAfterReversal.) */
export const FINISHED_STATUSES = ["settled", "paid_manual", "void", "reversed"] as const;
export const isFinished = (status: string) => (FINISHED_STATUSES as readonly string[]).includes(status);

/**
 * The post statuses that mean "the creator's post is live" (a verified link). A copy of @dashmani/shared LIVE_ITEM_STATUSES kept here so this
 * module pulls in nothing; the helper test holds the two equal.
 */
export const LIVE_ITEM = ["posted_manual", "published"] as const;
export const isLiveItem = (itemStatus: string | null | undefined) => !!itemStatus && (LIVE_ITEM as readonly string[]).includes(itemStatus);
/** The client was (or is being) repaid for the post: nothing is owed to the creator for it. */
const isReturnedItem = (itemStatus: string | null | undefined) => itemStatus === "refund_due" || itemStatus === "refunded";

/** A payout taken back whose post is still live: the creator did the work and their share is back with us, so they are owed it. */
export const isOwedAfterReversal = (p: { status: string; itemStatus?: string | null }) => p.status === "reversed" && isLiveItem(p.itemStatus);

const STATUS_VIEW: Record<string, { label: string; color: string }> = {
  planned: { label: "Planned", color: "#738395" },
  transfer_requested: { label: "Transfer requested", color: "#238BFF" },
  held: { label: "Held", color: "#E9BD62" },
  release_requested: { label: "Releasing", color: "#238BFF" },
  // Not "Paid": Razorpay was told to let the money go, the creator's bank has not got it yet.
  released: { label: "Released · settling", color: "#238BFF" },
  settled: { label: "Paid · settled", color: "#00D7A0" },
  settlement_failed: { label: "Settlement failed", color: "#FB7185" },
  reversal_requested: { label: "Taking back", color: "#F59E66" },
  reversed: { label: "Taken back", color: "#A7B3C2" },
  failed: { label: "Transfer failed", color: "#FB7185" },
  needs_attention: { label: "Needs attention", color: "#FB7185" },
  manual_required: { label: "Pay by hand", color: "#F59E66" },
  paid_manual: { label: "Paid by hand", color: "#00D7A0" },
  void: { label: "Void", color: "#4E5F70" },
};

/**
 * The pill for a payout. A held payout says whether anything is scheduled, and an unscheduled one whether its post was verified (the queue's
 * rows carry `linkVerifiedAt`): a verified post whose release the worker has not scheduled yet is not "awaiting verify". Every other status
 * is its own word.
 */
export function payoutStatusView(p: { status: string; releaseAfter: string | null; linkVerifiedAt?: string | null }): { label: string; color: string } {
  if (p.status === "held") {
    if (p.releaseAfter) return { label: "Held · release scheduled", color: "#E9BD62" };
    return p.linkVerifiedAt ? { label: "Held · release not scheduled", color: "#E9BD62" } : { label: "Held · awaiting verify", color: "#E9BD62" };
  }
  return STATUS_VIEW[p.status] ?? { label: formatStatus(p.status) || "Unknown", color: "#738395" };
}

/** A status as a plain word inside a sentence ("Now: released · settling"). */
export const statusWord = (status: string) => (STATUS_VIEW[status]?.label ?? formatStatus(status)).toLowerCase();

/**
 * creator_payouts.paused_reason of the pause a PERSON's Reverse puts on a held payout (the engine's payout-pause.ts REVERSE_PAUSE_REASON; the
 * helper test holds the two equal). It is written when the reversal is claimed and replaces any reason already there, so that a Reverse Razorpay
 * refuses leaves the payout held and paused under the person's reason, whoever finished the reversal. Resume releases such a payout when due.
 */
export const REVERSE_PAUSE_REASON = "staff_reverse";

const PAUSE_REASON: Record<string, string> = {
  dispute: "a dispute on the client's payment",
  external_refund: "the client's payment was refunded outside our system",
  bank_change: "the creator asked to change their bank account",
  account_suspended: "the creator's payout account was suspended",
  creator_suspended: "the creator was suspended",
  staff: "paused by staff",
  [REVERSE_PAUSE_REASON]:
    "a person pressed Reverse so the creator is not paid, and Razorpay has not taken the money back (it refused, or has not confirmed it yet): resume it only if the creator should be paid after all, and its release then goes ahead when due",
};

/** Why a payout is paused, in staff words. A reason this page doesn't know is shown as the API wrote it (it is scrubbed, and React escapes it). */
export function pauseText(reason: string | null): string {
  if (!reason) return "no reason recorded";
  return PAUSE_REASON[reason] ?? reason.replace(/_/g, " ");
}

/**
 * The pause reasons that make the worker ask Razorpay to put the hold back on a payout that was already RELEASED (the engine's
 * rehold_paused bucket in payout.service selectDuePayouts). Any other pause on a released payout is staff's to act on: the worker leaves it.
 * The helper test holds this list equal to the engine's.
 */
export const REHOLD_PAUSE_REASONS: readonly string[] = ["dispute", "external_refund"];
/** Statuses where Razorpay may already be letting the money go: the engine's settlement poll and release read-back do not look at a pause. */
const PAST_RELEASE: readonly string[] = ["release_requested", "released", "settlement_failed"];

/**
 * What a pause on this payout really does now. null: it is not paused, or it has finished (a pause means nothing there).
 *  - "holds": nothing more goes out while it is paused (no release, no new transfer, no retry);
 *  - "asks_rehold": it was released, and the pause (a dispute, an outside refund) makes the worker ask Razorpay to put the hold back.
 *    Until that is confirmed Razorpay may still settle it to the creator's bank;
 *  - "none": ⚠️ the pause stops NOTHING. The release was requested or made (or its settlement failed and may be retried), and Razorpay
 *    settles it whatever the pause says. Only Reverse, while the money is still in the creator's account, takes it back.
 * A suspended creator's already-released payout is the case this exists for: it is paused, and it still settles.
 */
export type PauseHold = "holds" | "asks_rehold" | "none";
export function pauseHold(p: { status: string; pausedAt?: string | null; pausedReason?: string | null }): PauseHold | null {
  if (!p.pausedAt || isFinished(p.status)) return null;
  if (p.status === "released" && REHOLD_PAUSE_REASONS.includes(p.pausedReason ?? "")) return "asks_rehold";
  if (PAST_RELEASE.includes(p.status)) return "none";
  return "holds";
}

/** The chip beside a paused payout: a plain "Paused" only where the pause holds the money back, else a chip that says it doesn't. */
export function pausedChip(p: { status: string; pausedAt?: string | null; pausedReason?: string | null }): { label: string; holds: boolean; title: string } | null {
  const h = pauseHold(p);
  if (h === null) return null;
  if (h === "holds") {
    return p.pausedReason === REVERSE_PAUSE_REASON
      ? { label: "Paused", holds: true, title: "A person pressed Reverse to take this payout back and Razorpay refused (or has not confirmed it yet): it is not released while paused. Resume releases it when due; Reverse again takes it back." }
      : { label: "Paused", holds: true, title: "Nothing more is released or transferred for it while it is paused." };
  }
  if (h === "asks_rehold") return { label: "Paused · putting the hold back", holds: false, title: "Already released: the system is asking Razorpay to put the hold back. Until then Razorpay may still settle it." };
  return { label: "Paused · doesn't stop it", holds: false, title: "Already released (or being released): Razorpay settles it whatever the pause says. Reverse takes it back while it is still in the creator's account." };
}

// ── Dates ───────────────────────────────────────────────────────────────────────────────────────

export const whenOf = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }) : null;

/** "5 min ago", "3 h ago", "2 d ago". A time in the future (clock skew) reads "just now". "—" for none. */
export function ago(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

/** The compact age of a row for the Age column: "12m", "5h", "4d". */
export function ageShort(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const m = Math.max(0, Math.floor((now - t) / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// ── What is happening, in a sentence ────────────────────────────────────────────────────────────

/** Why a parked payout is parked, for the codes whose next step differs. Any other code is shown as it is, in brackets. */
const ERROR_HINT: Record<string, string> = {
  duplicate_transfer: "More than one transfer was made for this payout. The extra ones are being reversed: check that exactly one live transfer remains.",
  transfer_mismatch: "The transfer at Razorpay doesn't match this payout. Check it in the Razorpay dashboard.",
  transfer_unknown_after_retry:
    "The transfer was requested twice and no transfer ever showed up at Razorpay. It is looked for again every hour. Look in the Razorpay dashboard: if the transfer is there, press Adopt transfer and give its id (a transfer that failed or was taken back counts only if the latest request made it); if there is none, press No transfer exists, then stop the payout (a live post's creator is then paid by bank transfer).",
  listing_unreadable:
    "Razorpay's list of transfers couldn't be read for half an hour, so nobody can tell whether this payout's transfer exists. Nothing is repeated or refunded meanwhile, and it is re-checked every hour. Look in the Razorpay dashboard: if the transfer is there, press Adopt transfer and give its id (a transfer that failed or was taken back counts only if the latest request made it: after a Retry, look for the newer one); if there is none, press No transfer exists.",
  reversal_refused: "Razorpay refused to take the transfer back. Nothing changed: check Razorpay.",
  reversal_refused_after_release: "Razorpay refused to take the transfer back (if it had been released, it may already have settled to the creator's bank, or the linked account may no longer hold it). Check Razorpay and the linked account's balance.",
  settled_while_held: "The transfer settled to the creator's bank although we still had it held. Check Razorpay before refunding or paying.",
  reversed_outside_flow: "The transfer was reversed outside our flow. Check Razorpay before refunding or paying.",
};

/**
 * A parked payout that has no Razorpay transfer id (nothing to take back): Reverse cannot apply to it, and the API refuses it. These are the
 * parks a person ends after looking in the Razorpay dashboard (Adopt transfer, No transfer exists). Equal to the engine's PARKED_UNKNOWN_CODES
 * (the helper test holds them together).
 */
export const NO_TRANSFER_CODES: readonly string[] = ["listing_unreadable", "transfer_unknown_after_retry"];

/**
 * The parks whose hold was put back and are being read again (the engine's HOLD_RESOLVABLE_REASONS, held equal by the helper test): with a
 * transfer recorded and a request sent twice, these wait on the check for a second transfer, which "No other transfer" can stand in for.
 */
export const HOLD_RESOLVABLE_CODES: readonly string[] = ["processed_not_held", "processed_hold_expires", "released_outside_flow", "hold_expires"];

export interface HintInput {
  status: string;
  releaseAfter: string | null;
  releasedAt: string | null;
  settledAt: string | null;
  reversedAt: string | null;
  errorCode: string | null;
  destinationHint?: string | null;
  pausedAt?: string | null;
  pausedReason?: string | null;
  settlementUtr?: string | null;
  manualReference?: string | null;
  manualPaidAt?: string | null;
  itemStatus?: string | null;
  /** The queue's rows carry it: set = the creator's link was verified. */
  linkVerifiedAt?: string | null;
}

export interface HintOptions {
  /**
   * The creator's link was verified, as the caller knows it (the campaign page reads the offer). The row's own `linkVerifiedAt` says the same
   * for the queue: either is enough, because a verification is never undone.
   */
  postVerified?: boolean;
  /** The release switch as the page last read it (false = every release is paused; undefined/null = unknown). */
  releaseOn?: boolean | null;
}

/**
 * One plain sentence on where a payout stands and what happens next. Never claims money moved that its status doesn't show, and never
 * predicts a release or a transfer that a pause (its own, or the global switch) is holding back.
 */
export function payoutHint(p: HintInput, now: number = Date.now(), o: HintOptions = {}): string {
  const code = p.errorCode ? ` (${p.errorCode})` : "";
  const paused = !!p.pausedAt;
  const verified = !!o.postVerified || !!p.linkVerifiedAt;
  // ⚠️ A pause on a payout that was released (or whose release was requested, or whose settlement failed) stops nothing: Razorpay settles it
  // whatever the pause says. The sentence says so and names the one way to stop it, rather than letting a "Paused" chip read as a hold.
  const hold = pauseHold(p);
  const pauseWords =
    hold === "asks_rehold"
      ? ` It is paused (${pauseText(p.pausedReason ?? null)}), so the system is asking Razorpay to put the hold back. Until that is confirmed Razorpay may still settle it to the creator's bank: if it must not be paid, use Reverse while the money is still in the creator's account.`
      : hold === "none"
        ? " Pausing does not stop this: Razorpay settles it whatever the pause says. To stop it, use Reverse while the money is still in the creator's account."
        : "";
  switch (p.status) {
    case "planned":
      // A planned payout's post has never been offered to its creator (an offer needs a held payout), so nothing is owed to them yet.
      return paused
        ? "The transfer to the creator's account hasn't been made yet, and none will be while it is paused."
        : "The transfer to the creator's account hasn't been made yet, so the post hasn't been offered to the creator and nothing is owed to them. If it stays like this, fix the creator's payout account and press Make transfer now, or refund this post from the campaign page (the campaign can't be approved with it). Refunds on the client's payment wait until it is made.";
    case "transfer_requested":
      return "Transfer requested. Waiting for Razorpay to confirm the money is set aside.";
    case "held": {
      // A person's Reverse that Razorpay refused: the pause is theirs, and Resume is the one thing that lets the release go ahead. Said outright,
      // so the row never reads like a pause for the creator's suspension or a dispute whose own ending invites a resume.
      if (paused && p.pausedReason === REVERSE_PAUSE_REASON)
        return "Set aside at Razorpay. A person pressed Reverse to take it back and Razorpay refused, so it is paused and won't be released: press Reverse again to take it back, or resume it only if the creator should be paid after all (it is then released when due).";
      if (paused) return "Set aside at Razorpay. It is paused, so it won't be released until it is resumed.";
      // A verified post with nothing scheduled is not "waiting for verification": the worker schedules it (within minutes, when it runs).
      if (!p.releaseAfter)
        return verified
          ? "Set aside at Razorpay. The post is verified, but no release is scheduled for it yet: the payout worker schedules it within minutes while it is running (the payout queue says when it is switched off)."
          : "Set aside at Razorpay. Nothing is scheduled: it waits for staff to verify the creator's post.";
      const due = !(Date.parse(p.releaseAfter) > now);
      if (o.releaseOn === false) {
        return due
          ? "Set aside at Razorpay and due for release, but all releases are paused: it isn't released until they are resumed."
          : `Set aside at Razorpay. Release is scheduled for ${whenOf(p.releaseAfter)}, but all releases are paused: nothing is released until they are resumed.`;
      }
      return due ? "Set aside at Razorpay and due for release. The worker releases it on its next run, after checking everything again." : `Set aside at Razorpay. Release is scheduled for ${whenOf(p.releaseAfter)}.`;
    }
    case "release_requested":
      return `Release requested. Waiting for Razorpay to confirm.${pauseWords}`;
    case "released":
      return `Released${p.releasedAt ? ` ${whenOf(p.releasedAt)}` : ""}. Razorpay hasn't settled it to the creator's bank yet: it counts as paid only once it has.${pauseWords}`;
    case "settled":
      return `Paid: settled by Razorpay${p.settledAt ? ` ${whenOf(p.settledAt)}` : ""}${p.destinationHint ? ` to ${p.destinationHint}` : ""}.${p.settlementUtr ? ` Bank reference ${p.settlementUtr}.` : ""}`;
    case "settlement_failed":
      return `Razorpay released it, but the settlement to the creator's bank failed. The money is still in the creator's linked account.${pauseWords}`;
    case "reversal_requested":
      return "Taking the money back from the creator's linked account. Waiting for Razorpay to confirm.";
    case "reversed": {
      const base = `Taken back${p.reversedAt ? ` ${whenOf(p.reversedAt)}` : ""}. The money is back in our Razorpay balance.`;
      if (isLiveItem(p.itemStatus)) return `${base} The post is live, so the creator is still owed their share: pay them by bank transfer instead, then record the reference.`;
      if (isReturnedItem(p.itemStatus)) return `${base} The post isn't going ahead, so nothing is owed to the creator.`;
      return base;
    }
    case "failed":
      return `Razorpay refused the transfer${code}. No money was set aside.`;
    case "needs_attention":
      return p.errorCode && ERROR_HINT[p.errorCode] ? `${ERROR_HINT[p.errorCode]} Open the details.` : `Razorpay's records and ours disagree, or an answer stayed unknown${code}. A person has to look: open the details.`;
    case "manual_required":
      // ⚠️ Only a live, verified post is owed (the API refuses a hand payment for any other: post_not_live). A payout whose post never went live is
      // here only so it stops holding up refunds, or so it can be refunded: paying it would pay for nothing and make the refund impossible.
      if (isLiveItem(p.itemStatus)) return "Razorpay can't pay this creator. Pay them by bank transfer yourself, then record the reference.";
      if (p.itemStatus)
        return "Nothing is owed to the creator: this post never went live. Refund this post from the campaign page (press Withdraw offer while the creator's offer is still open, or Discard link & withdraw offer if they sent a link; otherwise Refund this account): the refund goes out once Razorpay's records show no money is out for it (none was sent, its transfer failed, or it was taken back), and it waits while Razorpay's list of the payment's transfers can't be read. It can't be paid by bank transfer.";
      return "Razorpay can't pay this creator. If the post is live, pay them by bank transfer and record the reference; if it never went live, nothing is owed: refund the post from the campaign page instead.";
    case "paid_manual":
      return `Paid by bank transfer outside Razorpay (recorded by staff${p.manualPaidAt ? ` ${whenOf(p.manualPaidAt)}` : ""}).${p.manualReference ? ` Reference ${p.manualReference}.` : ""}`;
    case "void":
      return "Cancelled before any money moved.";
    default:
      return formatStatus(p.status);
  }
}

// ── The queue's views ───────────────────────────────────────────────────────────────────────────

export interface PayoutChip {
  key: PayoutFilterKey;
  label: string;
  /** A person has to act on what is here: its badge is drawn in a warning colour while it is not empty. */
  attention: boolean;
  /** "work" lists are what a person acts on (oldest first); "history" lists answer "what happened" (newest first). */
  group: "work" | "history";
  /** One line under the chips, so each view says what it is. */
  blurb: string;
}

export const PAYOUT_CHIPS: PayoutChip[] = [
  { key: "needs_attention", label: "Needs attention", attention: true, group: "work", blurb: "Razorpay's records and ours disagree, or a result stayed unknown. A person has to look." },
  { key: "manual_required", label: "Manual", attention: true, group: "work", blurb: "Razorpay can't pay these creators. A creator whose post is live is paid by bank transfer, then the reference is recorded; one whose post never went live is owed nothing (refund that post from its campaign page)." },
  { key: "owed_after_reversal", label: "Owed after reversal", attention: true, group: "work", blurb: "Taken back, but the post is live, so the creator is still owed their share. Press Pay by bank transfer instead, pay them, then record the reference." },
  { key: "failed", label: "Failed", attention: true, group: "work", blurb: "Razorpay refused the transfer, or the creator's bank rejected the settlement." },
  {
    key: "paused",
    label: "Paused",
    attention: false,
    group: "work",
    blurb:
      "Held back by a dispute, an outside refund, a bank change, a suspended creator or a staff pause. Nothing here will be released; but money that was already released may still settle (its row says so): only Reverse stops that, while the money is still in the creator's account.",
  },
  {
    key: "held_awaiting_verify",
    label: "Held · awaiting verify",
    attention: false,
    group: "work",
    blurb: "The creator's share is set aside and no release is scheduled: the post isn't verified yet, or it was verified and the worker hasn't scheduled the release (it does within minutes while it runs).",
  },
  { key: "releasing", label: "Releasing", attention: false, group: "work", blurb: "Verified. A release is scheduled or in flight." },
  { key: "settlement_pending", label: "Settlement pending", attention: false, group: "work", blurb: "Released. Razorpay hasn't settled it to the creator's bank yet, so it isn't paid." },
  { key: "open", label: "All open", attention: false, group: "work", blurb: "Everything that isn't finished." },
  { key: "finished", label: "Finished", attention: false, group: "history", blurb: "Paid (settled by Razorpay, or by hand), taken back and void payouts, with the bank reference of each payment: the answer to “was this creator paid?”." },
  { key: "all", label: "Everything", attention: false, group: "history", blurb: "Every payout, finished or not." },
];

export const isPayoutFilterKey = (v: unknown): v is PayoutFilterKey => typeof v === "string" && (PAYOUT_FILTER_KEYS as readonly string[]).includes(v);

/** The views whose payouts need a person: disjoint with each other, so their counts add up. */
export const PAYOUT_ATTENTION_KEYS: readonly PayoutFilterKey[] = ["needs_attention", "manual_required", "failed", "owed_after_reversal"];

/** How many payouts need a person (the badge, the page's sub-heading). undefined until the counts have loaded. */
export function attentionCount(counts: Partial<Record<PayoutFilterKey, number>> | undefined): number | undefined {
  return counts ? PAYOUT_ATTENTION_KEYS.reduce((n, k) => n + (counts[k] ?? 0), 0) : undefined;
}

/** The order a view lists in: the work lists oldest first (the longest wait on top), the history views newest first. Mirrors the API. */
export const payoutViewOrder = (f: PayoutFilterKey): "oldest" | "newest" => (f === "finished" || f === "all" ? "newest" : "oldest");

export interface FilterInput {
  status: string;
  pausedAt: string | null;
  releaseAfter: string | null;
  itemStatus?: string | null;
}

/**
 * Whether a payout belongs to a view. MIRRORS the API's whereForFilter (payout-staff.service.ts): the same predicate, over the row's own
 * fields. A campaign's queue is computed from that campaign's payouts with it (a campaign has a handful), because the API's per-view
 * counts are company-wide and would say "Showing 1 of 47" about a campaign that has one. The helper test runs both against a database.
 */
export function payoutInFilter(p: FilterInput, f: PayoutFilterKey): boolean {
  switch (f) {
    case "needs_attention":
      return p.status === "needs_attention";
    case "manual_required":
      return p.status === "manual_required";
    case "paused":
      return p.pausedAt !== null && !isFinished(p.status);
    case "held_awaiting_verify":
      return p.status === "held" && p.releaseAfter === null;
    case "releasing":
      return p.status === "release_requested" || (p.status === "held" && p.releaseAfter !== null);
    case "settlement_pending":
      return p.status === "released";
    case "failed":
      return p.status === "failed" || p.status === "settlement_failed";
    case "owed_after_reversal":
      return isOwedAfterReversal(p);
    case "finished":
      return isFinished(p.status);
    case "all":
      return true;
    case "open":
      return !isFinished(p.status);
  }
}

/** Every view's count over a set of payouts. */
export function payoutCounts(rows: ReadonlyArray<FilterInput>): Record<PayoutFilterKey, number> {
  return Object.fromEntries(PAYOUT_FILTER_KEYS.map((k) => [k, rows.filter((r) => payoutInFilter(r, k)).length])) as Record<PayoutFilterKey, number>;
}

/** The payouts of a view in the API's order (createdAt, then id; ascending for the work lists, descending for the history views). */
export function sortPayoutsForView<T extends { createdAt: string; id: string }>(rows: readonly T[], f: PayoutFilterKey): T[] {
  const dir = payoutViewOrder(f) === "newest" ? -1 : 1;
  return [...rows].sort((a, b) => (a.createdAt < b.createdAt ? -dir : a.createdAt > b.createdAt ? dir : a.id < b.id ? -dir : a.id > b.id ? dir : 0));
}

// ── The switches ────────────────────────────────────────────────────────────────────────────────

/** The release switch: the dedicated light read wins over the queue's copy of it (the queue read may be the one that failed). undefined = unknown. */
export function releaseOnOf(read: "on" | "off" | null | undefined, queue: boolean | null | undefined): boolean | undefined {
  if (read === "on") return true;
  if (read === "off") return false;
  return queue ?? undefined;
}

/** Who paused or resumed releases, and when. Only says "by <name>" about a change that is the CURRENT state: a later change made by hand has no name on it. */
export function releaseChangeLine(sw: Pick<ReleaseSwitchState, "release" | "updatedAt" | "lastChange"> | undefined, fmt: (iso: string) => string | null = whenOf): string | null {
  if (!sw) return null;
  const c = sw.lastChange;
  if (c && c.to === sw.release) return `${sw.release === "off" ? "Paused" : "Resumed"} by ${c.byName ?? "a staff member"} on ${fmt(c.at) ?? c.at}.`;
  if (sw.updatedAt) return `Last changed ${fmt(sw.updatedAt) ?? sw.updatedAt}, not through this portal: nobody's name is on record.`;
  return null;
}

export interface SwitchBar {
  key: "razorpay_missing" | "new_transfers_off" | "worker_off";
  text: string;
}

/** The quiet bars about the other switches (the release pause has its own banner). `=== false` only: an unknown switch says nothing. */
export function switchBars(s: PayoutSwitches | undefined): SwitchBar[] {
  const out: SwitchBar[] = [];
  if (!s) return out;
  if (s.razorpay === false) out.push({ key: "razorpay_missing", text: "Razorpay isn't configured on the API (its keys are missing): nothing moves. Every transfer, release and reversal is refused and the payout worker is idle, so payouts sit where they are." });
  if (s.newTransfers === false) out.push({ key: "new_transfers_off", text: "New transfers are switched off (CREATOR_ROUTE_ENABLED): no new money is being set aside for creators. Payouts that already exist keep being checked." });
  if (s.worker === false) out.push({ key: "worker_off", text: "The payout worker is switched off (CREATOR_PAYOUT_CRON_ENABLED=0): nothing moves by itself. Only the buttons here act." });
  return out;
}

/**
 * What the global release switch does, in the words the banner, its two dialogs and the notice use. ⚠️ It stops NEW releases only: a payout
 * already released keeps settling to the creator's bank (the settlement poll does not read the switch), and a release already requested
 * finishes. Never "nobody is being paid out".
 */
export const RELEASE_SWITCH_TEXT = {
  banner:
    "No further creator payout is released until releases are resumed. Payouts that were already released keep settling to the creators' banks: Reverse takes one back while the money is still in the creator's account. Money already set aside stays set aside; transfers, reversals and refunds carry on.",
  pauseDialog: [
    "No further creator payout will be released while this is off. It takes effect on the next release, within seconds, with no restart.",
    "It does not stop payouts that were already released: they keep settling to the creators' banks (Reverse takes one back while the money is still in the creator's account), and a release that has already been requested finishes. Money already set aside stays set aside; transfers, reversals and refunds carry on. You can switch releases back on here at any time.",
  ],
  pausedNotice: "All releases are paused. Nothing more will be released until you resume them; payouts that were already released keep settling.",
} as const;

// ── The timeline ────────────────────────────────────────────────────────────────────────────────

export type StepState = "done" | "current" | "todo" | "error" | "warn" | "skipped";
export interface TimelineStep {
  key: string;
  label: string;
  detail: string | null;
  at: string | null;
  state: StepState;
}

export type TimelineInput = Pick<PayoutRow, "status" | "createdAt" | "heldAt" | "releasedAt" | "settledAt" | "reversedAt" | "releaseAfter" | "errorCode" | "destinationHint"> &
  Partial<PayoutDetailFields> & { itemStatus?: string | null; linkVerifiedAt?: string | null };

const HAPPY = ["planned", "transfer_requested", "held", "release_requested", "released", "settled"] as const;

const VOID_REASON: Record<string, string> = {
  declined: "The creator declined the post.",
  expired: "Nobody accepted the offer in time.",
  withdrawn: "The offer was withdrawn.",
  missed_window: "The creator didn't send a link by the end of the posting window.",
  booking_rejected: "The campaign was rejected.",
  page_taken_over: "The page changed hands.",
};

/**
 * The payout's road as steps: planned → transfer requested → held → release requested → released → settled, with a branch step
 * where it left that road (taken back, void, failed, paid by hand, needs a person). A step is `done` only on evidence: its own
 * time, a later step's time, or the status itself. A step the payout can no longer reach is `skipped`, never drawn as done.
 * `settled` is the only step that says the creator's bank was paid.
 */
export function buildTimeline(p: TimelineInput): TimelineStep[] {
  const onRoad = (HAPPY as readonly string[]).indexOf(p.status);
  const at = {
    planned: p.createdAt,
    transfer_requested: p.transferRequestedAt ?? null,
    held: p.heldAt,
    release_requested: p.releaseRequestedAt ?? null,
    released: p.releasedAt,
    settled: p.settledAt,
  };
  // Off the road, a step happened iff it or a later one left a mark.
  const marks = [true, !!(at.transfer_requested || at.held || at.release_requested || at.released || at.settled), !!(at.held || at.release_requested || at.released || at.settled), !!(at.release_requested || at.released || at.settled), !!(at.released || at.settled), !!at.settled];
  // Where the payout is stuck, not finished: the steps it has not reached yet are still ahead of it. For the endings below, they never will be.
  const ended = ["reversed", "void", "paid_manual", "manual_required"].includes(p.status);

  const label: Record<(typeof HAPPY)[number], string> = {
    planned: "Planned",
    transfer_requested: "Transfer requested",
    held: "Held at Razorpay",
    release_requested: "Release requested",
    released: "Released",
    settled: "Settled to the creator's bank",
  };
  const settledParts = [p.destinationHint, p.settlementUtr ? `bank reference ${p.settlementUtr}` : null].filter(Boolean).join(" · ");
  const detail: Record<(typeof HAPPY)[number], string | null> = {
    planned: "Set up when the client paid.",
    transfer_requested: "Razorpay was asked to set the creator's share aside, on hold.",
    // Only a payout that is held right now has a release still ahead of it; any other status past this step simply was held.
    held:
      p.status === "held"
        ? p.releaseAfter
          ? `Release is scheduled for ${whenOf(p.releaseAfter)}.`
          : p.linkVerifiedAt
            ? "The post is verified. No release is scheduled for it yet: the worker schedules it within minutes while it runs."
            : "Waiting for the creator's post to be verified."
        : "Set aside at Razorpay.",
    release_requested: "Razorpay was told to release the transfer.",
    released: "Razorpay now settles it to the creator's bank. It isn't paid until it has.",
    settled: settledParts || null,
  };

  const steps: TimelineStep[] = HAPPY.map((key, i) => {
    let state: StepState;
    if (onRoad >= 0) state = i < onRoad ? "done" : i === onRoad ? (p.status === "settled" ? "done" : "current") : "todo";
    else state = marks[i] ? "done" : ended ? "skipped" : "todo";
    return { key, label: label[key], detail: state === "todo" || state === "skipped" ? null : detail[key], at: at[key], state };
  });

  const step = (key: (typeof HAPPY)[number]) => steps[HAPPY.indexOf(key)];
  switch (p.status) {
    case "failed": {
      const s = step("transfer_requested");
      s.label = "Transfer failed";
      s.state = "error";
      s.detail = `Razorpay refused the transfer${p.errorCode ? ` (${p.errorCode})` : ""}. No money was set aside.`;
      break;
    }
    case "settlement_failed": {
      const s = step("settled");
      s.label = "Settlement failed";
      s.state = "error";
      s.detail = "The creator's bank didn't take the settlement. The money is still in the creator's linked account.";
      break;
    }
    case "reversal_requested":
      steps.push({ key: "reversal", label: "Taking the money back", detail: "Waiting for Razorpay to confirm the reversal.", at: p.reversalRequestedAt ?? null, state: "current" });
      break;
    case "reversed": {
      // "Not paid for this post" is only true when the post isn't going ahead. A reversal of a LIVE post leaves the creator owed their share.
      const owed = isLiveItem(p.itemStatus);
      const returned = isReturnedItem(p.itemStatus);
      steps.push({
        key: "reversal",
        label: "Taken back",
        detail: `The creator's share is back in our Razorpay balance. ${owed ? "The post is live, so the creator is still owed it: pay them by bank transfer instead." : returned ? "The post isn't going ahead, so nothing is owed to the creator." : "The creator has not been paid for this post."}`,
        at: p.reversedAt,
        state: owed ? "warn" : "done",
      });
      break;
    }
    case "void":
      steps.push({ key: "void", label: "Cancelled", detail: `${(p.voidReason && VOID_REASON[p.voidReason]) ?? "The post will not go ahead."} No money moved.`, at: null, state: "done" });
      break;
    case "needs_attention":
      steps.push({ key: "attention", label: "Needs a person", detail: `Razorpay's records and ours disagree, or an answer stayed unknown${p.errorCode ? ` (${p.errorCode})` : ""}.`, at: null, state: "warn" });
      break;
    case "manual_required":
      steps.push({ key: "manual", label: "To be paid by bank transfer", detail: "Razorpay can't pay this creator. Pay by hand, then record the reference.", at: null, state: "warn" });
      break;
    case "paid_manual":
      steps.push({ key: "manual", label: "Paid by bank transfer", detail: p.manualReference ? `Recorded by staff · reference ${p.manualReference}` : "Recorded by staff.", at: p.manualPaidAt ?? null, state: "done" });
      break;
    default:
      break;
  }
  return steps;
}

// ── History lines ───────────────────────────────────────────────────────────────────────────────

const EVENT_KIND: Record<string, string> = {
  status_change: "Status change",
  transfer: "Transfer",
  release: "Release",
  reversal: "Reversal",
  settlement: "Settlement",
  pause: "Paused",
  resume: "Resumed",
  manual: "Manual payment",
  alert: "Alert",
  webhook: "Razorpay event",
};
const ACTOR: Record<string, string> = { system: "System", staff: "Staff", creator: "Creator", razorpay: "Razorpay" };

/** "Release → released · settling". The note beside it is the API's own scrubbed text. */
export function eventTitle(e: Pick<PayoutEvent, "kind" | "toStatus">): string {
  const k = EVENT_KIND[e.kind] ?? formatStatus(e.kind);
  return e.toStatus ? `${k} → ${statusWord(e.toStatus)}` : k;
}
export const actorWord = (actorType: string) => ACTOR[actorType] ?? formatStatus(actorType);

/** The latest history line of a row, short enough for a table cell. */
export function lastEventText(e: PayoutRow["lastEvent"]): string {
  return e ? eventTitle(e) : "No history yet";
}

// ── A refusal from the API, and an answer we never got ──────────────────────────────────────────

/**
 * The API ends every refusal with its stable code in brackets ("… Nothing was changed. [release_not_due]"). The sentence is for the
 * person; the code is kept apart, small, for whoever helps them.
 */
export function splitRefusal(message: string): { text: string; code: string | null } {
  const m = /\s*\[([a-z0-9_]{2,40})\]\s*$/i.exec(message);
  return m ? { text: message.slice(0, m.index).trim(), code: m[1] } : { text: message.trim(), code: null };
}

export const NOTHING_CHANGED_TEXT = "That didn't work. Nothing was changed.";

/** What an action that got no usable answer says. The first sentence is the one that matters: it may have gone through. */
export const UNCONFIRMED_TEXT =
  "We couldn't confirm whether this went through: the server didn't give a usable answer, so it may have been done. What is behind this window has just been refreshed: check its status before trying again.";
const REPEAT_SAFE_TEXT = " Trying again is safe: every action here is checked fresh and is never applied twice.";

export interface ActionFailureInput {
  /** The HTTP status of the answer, null when there was none (the network dropped). */
  status: number | null;
  /** Whether the body was the API's own JSON envelope. A gateway's HTML 502/504 page is not. */
  readable: boolean;
  message: string;
}

/**
 * Separates "the API answered and said no" from "we do not know". Only a READABLE 4xx is a refusal (nothing was changed: its sentence is
 * shown as it is). Anything else (a gateway page, a dropped connection, a 5xx even when it is JSON: the engine may have claimed the move
 * before it failed, a request timeout) is UNCONFIRMED and says so, because the move may have happened. Never a raw parse error.
 * `repeatSafe` is for the payout actions, which the engine makes idempotent (claim first, then ask Razorpay).
 */
export function classifyActionFailure(f: ActionFailureInput, o: { repeatSafe?: boolean } = {}): { unconfirmed: boolean; text: string } {
  const refused = f.readable && f.status !== null && f.status >= 400 && f.status < 500 && f.status !== 408;
  if (refused) return { unconfirmed: false, text: f.message.trim() || NOTHING_CHANGED_TEXT };
  return { unconfirmed: true, text: UNCONFIRMED_TEXT + (o.repeatSafe ? REPEAT_SAFE_TEXT : "") };
}

// ── Which buttons to offer ──────────────────────────────────────────────────────────────────────

/**
 * The last three are what a person says after looking in the Razorpay dashboard, for a payout whose transfer nobody can see (Razorpay's
 * list of the payment's transfers could not be read, or a repeated request never showed up): "adopt_transfer" gives the transfer's id
 * (the engine reads it and records it only if it is this payout's), "attest_no_transfer" records that there is none, and
 * "attest_no_other" that no transfer OTHER than the recorded one carries the payout's id (a request sent twice). None of them moves money.
 */
export type PayoutActionKey = "pause" | "resume" | "retry" | "reverse" | "release" | "require_manual" | "mark_paid" | "adopt_transfer" | "attest_no_transfer" | "attest_no_other";
export interface PayoutActionView {
  key: PayoutActionKey;
  label: string;
  enabled: boolean;
  /** Why a button that is shown is disabled: printed under the row, never only in a tooltip. */
  why: string | null;
  tone: "gold" | "ghost" | "red";
}

export type ActionInput = Pick<PayoutRow, "status" | "pausedAt" | "releaseAfter"> & {
  errorCode?: string | null;
  itemStatus?: string | null;
  linkVerifiedAt?: string | null;
  /** Whether a Razorpay transfer is recorded (unknown on an older API: the "No other transfer" action is then not offered). */
  hasTransfer?: boolean;
  /** How many create requests were sent (2+ = a twin may exist). */
  attempts?: number;
};

/**
 * Whether "Pay by bank transfer instead" / "Stop this payout" on a PARKED payout must first get past a transfer it records: the engine refuses
 * the move (transfer_exists) while that transfer has not failed or been taken back, because it could still release money. Its dialog says
 * "take it back first" before the person fills in a reason.
 */
export const manualNeedsReverseFirst = (p: { status: string; hasTransfer?: boolean }) => p.status === "needs_attention" && p.hasTransfer === true;

/**
 * The buttons a payout offers. Mirrors the engine's own legal moves closely enough that nobody is shown an action that cannot apply
 * (a transfer retried from "held", a hand payment recorded on a payout Razorpay is still carrying), and no more than that: the
 * engine re-checks everything fresh from Razorpay, and its refusal reaches the person. `releaseOn` is the runtime switch as the page
 * last read it (undefined/null = unknown: the button is offered and the API decides).
 *
 * "Release now" is the ONE button shown disabled, with its reason, because "why isn't this paid yet" is the question it answers.
 */
export function actionsFor(p: ActionInput, ctx: { releaseOn: boolean | null | undefined; now: number; postVerified?: boolean }): PayoutActionView[] {
  if (p.status === "reversed") {
    // "Reverse first, then pay by hand": a payout taken back whose post is LIVE is money the creator is owed, and this is the one way to pay it.
    // (The API also refuses it once the client has been refunded for the post.) A taken-back payout of a post that isn't going ahead owes nothing.
    return isLiveItem(p.itemStatus) ? [{ key: "require_manual", label: "Pay by bank transfer instead", enabled: true, why: null, tone: "gold" }] : [];
  }
  if (isFinished(p.status)) return [];
  const out: PayoutActionView[] = [];
  const paused = !!p.pausedAt;
  const live = isLiveItem(p.itemStatus);
  const verified = !!ctx.postVerified || !!p.linkVerifiedAt;

  if (paused) out.push({ key: "resume", label: "Resume", enabled: true, why: null, tone: "ghost" });

  switch (p.status) {
    case "held": {
      let why: string | null = null;
      if (paused) why = "Paused: resume it first.";
      else if (ctx.releaseOn === false) why = "All releases are paused. Nothing is released until an admin resumes them.";
      else if (!p.releaseAfter) why = verified ? "The post is verified, but no release is scheduled for it yet: the worker schedules it within minutes while it runs." : "Nothing is scheduled: the creator's post hasn't been verified yet.";
      else if (Date.parse(p.releaseAfter) > ctx.now) why = `The hold runs until ${whenOf(p.releaseAfter)}.`;
      out.push({ key: "release", label: "Release now", enabled: why === null, why, tone: "gold" });
      out.push({ key: "reverse", label: "Reverse", enabled: true, why: null, tone: "red" });
      break;
    }
    // ⚠️ "Pay by bank transfer" only for a post that is LIVE (the API refuses any other: post_not_live). A planned or failed payout's post was never
    // offered to its creator, so nothing is owed: it is retried, or the post is refunded from the campaign page (which voids the payout).
    case "failed":
      out.push({ key: "retry", label: "Retry transfer", enabled: true, why: null, tone: "gold" });
      if (live) out.push({ key: "require_manual", label: "Pay by bank transfer instead", enabled: true, why: null, tone: "ghost" });
      break;
    case "planned":
      out.push({ key: "retry", label: "Make transfer now", enabled: true, why: null, tone: "ghost" });
      if (live) out.push({ key: "require_manual", label: "Pay by bank transfer instead", enabled: true, why: null, tone: "ghost" });
      break;
    case "manual_required":
      if (live) out.push({ key: "mark_paid", label: "Mark paid manually", enabled: true, why: null, tone: "gold" });
      break;
    case "needs_attention": {
      const unseen = !!p.errorCode && NO_TRANSFER_CODES.includes(p.errorCode) && p.hasTransfer !== true;
      // A parked payout with no Razorpay transfer has nothing to take back: the API refuses it, so the button is not offered.
      if (!unseen) out.push({ key: "reverse", label: "Reverse", enabled: true, why: null, tone: "red" });
      // Nobody can see whether its transfer exists: the person looks in the Razorpay dashboard and says what they found. Neither moves money.
      if (unseen) {
        out.push({ key: "adopt_transfer", label: "Adopt transfer", enabled: true, why: null, tone: "ghost" });
        out.push({ key: "attest_no_transfer", label: "No transfer exists", enabled: true, why: null, tone: "ghost" });
      }
      // The same move either way (the API first proves no money is out): for a live post the creator is then paid by hand; for one that never went
      // live nothing is owed, and this is how the payout is stopped so the post can be refunded (a refund refuses a parked payout).
      out.push({ key: "require_manual", label: live ? "Pay by bank transfer instead" : "Stop this payout", enabled: true, why: null, tone: "ghost" });
      break;
    }
    case "released":
    case "settlement_failed":
      out.push({ key: "reverse", label: "Reverse", enabled: true, why: null, tone: "red" });
      break;
    default:
      break;
  }

  // A request sent twice whose recorded transfer waits on the check for a SECOND one (the hold confirmation, the release, a parked hold that was
  // put back). While Razorpay's list of the payment's transfers can't be read, the person's word that no other transfer carries this payout's id
  // stands in for that list there (never for a refund). Mirrors the engine's attestNoTransfer: anything else with a transfer is refused.
  const twinAudited = p.status === "transfer_requested" || p.status === "held" || (p.status === "needs_attention" && HOLD_RESOLVABLE_CODES.includes(p.errorCode ?? ""));
  if (p.hasTransfer === true && (p.attempts ?? 0) > 1 && twinAudited) out.push({ key: "attest_no_other", label: "No other transfer", enabled: true, why: null, tone: "ghost" });

  // Pausing stops a release. A payout whose reversal is under way is left alone: the worker is finishing it.
  if (!paused && p.status !== "reversal_requested") out.push({ key: "pause", label: "Pause", enabled: true, why: null, tone: "ghost" });
  return out;
}

/**
 * What pausing ONE payout does, by status, for its confirm dialog. Only a held payout has money "set aside" that pausing leaves where it is:
 * a planned or failed one has had nothing transferred, and one whose outcome is unconfirmed must not be described as safe.
 */
export function pauseEffect(status: string): { warn: boolean; text: string } {
  switch (status) {
    case "released":
      return { warn: true, text: "It has already been released, so Razorpay may still settle it to the creator's bank. Pausing does not stop that: use Reverse to take the money back." };
    case "release_requested":
      return { warn: true, text: "A release has already been requested, so Razorpay may still let the money go to the creator's account. Pausing does not stop that: use Reverse to take it back once it has." };
    case "held":
      return { warn: false, text: "The money stays on hold at Razorpay. Transfers, checks and refunds for other payouts carry on." };
    case "planned":
      return { warn: false, text: "No transfer will be made for it while it is paused. Transfers, checks and refunds for other payouts carry on." };
    case "transfer_requested":
    case "needs_attention":
      return { warn: false, text: "Nothing further will be sent or released for this payout while it is paused. Check it before you resume: its outcome isn't confirmed." };
    case "settlement_failed":
      // The money is in the creator's linked account and Razorpay may still settle it: the settlement poll does not read the pause.
      return { warn: true, text: "Razorpay released it and its settlement failed, but the money is in the creator's linked account and Razorpay may still settle it. Pausing does not stop that: use Reverse to take it back while it is still there." };
    case "failed":
    case "manual_required":
      return { warn: false, text: "Nothing is retried or paid out for this payout while it is paused. Transfers, checks and refunds for other payouts carry on." };
    default:
      return { warn: false, text: "Nothing further is done automatically for this payout while it is paused." };
  }
}

// ── The bank reference staff record when they pay by hand ───────────────────────────────────────

const REFERENCE_RE = /^[A-Za-z0-9][A-Za-z0-9 _./:#-]{3,99}$/;
// Shapes that mean somebody pasted an identity or bank detail instead of a transfer reference. The API refuses the same shapes (also with
// separators typed between the characters); this only says so before the request, because a reference is stored and shown to staff.
const TAX_ID_SHAPE = /[A-Za-z]{5}[0-9]{4}[A-Za-z]/;
const BRANCH_CODE_SHAPE = /[A-Za-z]{4}0[A-Za-z0-9]{6}/;
/** Every character REFERENCE_RE allows besides letters and digits. */
const REFERENCE_SEPARATORS = /[ _./:#-]/g;

/** A Razorpay transfer id, as the adopt-transfer route accepts it (trimmed). The API refuses anything else with a 400 and asks Razorpay nothing. */
export const TRANSFER_ID_RE = /^trf_[A-Za-z0-9]{4,40}$/;

/** Why a transfer id can't be sent (null = fine). The API's own check stays the authority. */
export function transferIdProblem(raw: string): string | null {
  const v = raw.trim();
  if (v === "") return "Required.";
  if (!v.startsWith("trf_")) return "A Razorpay transfer id starts with trf_ (a pay_ or acc_ id is something else).";
  if (!TRANSFER_ID_RE.test(v)) return "Copy the whole id from the Razorpay dashboard: trf_ followed by 4 to 40 letters and digits.";
  return null;
}

/** Why a bank reference can't be recorded (null = fine). Mirrors the engine's own check, which stays the authority. */
export function referenceProblem(raw: string): string | null {
  const r = raw.trim();
  if (r.length < 4) return "At least 4 characters.";
  if (!REFERENCE_RE.test(r)) return "Use letters, digits, spaces and - _ . / : # only (4 to 100 characters).";
  const flat = r.replace(REFERENCE_SEPARATORS, "");
  if (TAX_ID_SHAPE.test(r) || BRANCH_CODE_SHAPE.test(r) || TAX_ID_SHAPE.test(flat) || BRANCH_CODE_SHAPE.test(flat)) return "That looks like a PAN or an IFSC code, not a bank transfer reference. Never record those here.";
  return null;
}
