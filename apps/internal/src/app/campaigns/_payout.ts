// Creator-payout display logic for the staff pages (the queue at /campaigns/payouts and the payout panel on a campaign).
// `_` keeps Next from routing it. PURE: no React, no fetch, no clock of its own (every function that needs "now" is handed it),
// so it can be exercised in node.
//
// ⚠️ THIS FILE DECIDES NOTHING ABOUT MONEY. The API's engine (apps/api services/creator/payout.service.ts) is the only thing that
// moves, holds, releases or reverses money, and it re-checks every condition on every click. What is here is wording, and which
// BUTTONS to offer so staff are not shown an action that can't apply. Where a button is offered that the engine may still refuse
// (a release the Razorpay dispute check blocks, a retry after a refund), the API's own refusal sentence is shown to the person.
//
// ⚠️ "PAID" IS NEVER A GUESS. Only `settled` (Razorpay settled the money to the creator's bank) and `paid_manual` (staff recorded
// their own bank transfer) read as paid. `released` means Razorpay was told to let go of the money: the creator has not received it.

import { formatStatus } from "@dashmani/shared/src/utils/status";
import type { PayoutDetailFields, PayoutEvent, PayoutFilterKey, PayoutRow } from "@/lib/hooks/use-creator-payouts";

// ── Statuses ────────────────────────────────────────────────────────────────────────────────────

/** Nothing is in flight any more: the API's queue does not list these and no action applies. */
export const FINISHED_STATUSES = ["settled", "paid_manual", "void", "reversed"] as const;
export const isFinished = (status: string) => (FINISHED_STATUSES as readonly string[]).includes(status);

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

/** The pill for a payout. A held payout says whether anything is scheduled; every other status is its own word (formatStatus for one this page doesn't know). */
export function payoutStatusView(p: Pick<PayoutRow, "status" | "releaseAfter">): { label: string; color: string } {
  if (p.status === "held") return p.releaseAfter ? { label: "Held · release scheduled", color: "#E9BD62" } : { label: "Held · awaiting verify", color: "#E9BD62" };
  return STATUS_VIEW[p.status] ?? { label: formatStatus(p.status) || "Unknown", color: "#738395" };
}

/** A status as a plain word inside a sentence ("Now: released · settling"). */
export const statusWord = (status: string) => (STATUS_VIEW[status]?.label ?? formatStatus(status)).toLowerCase();

const PAUSE_REASON: Record<string, string> = {
  dispute: "a dispute on the client's payment",
  external_refund: "the client's payment was refunded outside our system",
  bank_change: "the creator asked to change their bank account",
  account_suspended: "the creator's payout account was suspended",
  staff: "paused by staff",
};

/** Why a payout is paused, in staff words. A reason this page doesn't know is shown as the API wrote it (it is scrubbed, and React escapes it). */
export function pauseText(reason: string | null): string {
  if (!reason) return "no reason recorded";
  return PAUSE_REASON[reason] ?? reason.replace(/_/g, " ");
}

// ── Dates ───────────────────────────────────────────────────────────────────────────────────────

const whenOf = (iso: string | null | undefined) =>
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

type HintInput = Pick<PayoutRow, "status" | "releaseAfter" | "releasedAt" | "settledAt" | "reversedAt" | "errorCode" | "destinationHint">;

/** One plain sentence on where a payout stands and what happens next. Never claims money moved that its status doesn't show. */
export function payoutHint(p: HintInput, now: number = Date.now(), o: { postVerified?: boolean } = {}): string {
  const code = p.errorCode ? ` (${p.errorCode})` : "";
  switch (p.status) {
    case "planned":
      return "The transfer to the creator's account hasn't been made yet.";
    case "transfer_requested":
      return "Transfer requested. Waiting for Razorpay to confirm the money is set aside.";
    case "held":
      // The campaign page knows the creator's link was verified; the queue does not. A verified post with nothing scheduled is not "waiting for verification".
      if (!p.releaseAfter) return o.postVerified ? "Set aside at Razorpay. The post is verified, but no release is scheduled for it yet: if this stays, open the details." : "Set aside at Razorpay. Nothing is scheduled: it waits for staff to verify the creator's post.";
      return Date.parse(p.releaseAfter) > now
        ? `Set aside at Razorpay. Release is scheduled for ${whenOf(p.releaseAfter)}.`
        : "Set aside at Razorpay and due for release. The worker releases it on its next run, after checking everything again.";
    case "release_requested":
      return "Release requested. Waiting for Razorpay to confirm.";
    case "released":
      return `Released${p.releasedAt ? ` ${whenOf(p.releasedAt)}` : ""}. Razorpay hasn't settled it to the creator's bank yet: it counts as paid only once it has.`;
    case "settled":
      return `Paid: settled by Razorpay${p.settledAt ? ` ${whenOf(p.settledAt)}` : ""}${p.destinationHint ? ` to ${p.destinationHint}` : ""}.`;
    case "settlement_failed":
      return "Razorpay released it, but the settlement to the creator's bank failed. The money is still in the creator's linked account.";
    case "reversal_requested":
      return "Taking the money back from the creator's linked account. Waiting for Razorpay to confirm.";
    case "reversed":
      return `Taken back${p.reversedAt ? ` ${whenOf(p.reversedAt)}` : ""}. The money is back in our Razorpay balance.`;
    case "failed":
      return `Razorpay refused the transfer${code}. No money was set aside.`;
    case "needs_attention":
      return `Razorpay's records and ours disagree, or an answer stayed unknown${code}. A person has to look: open the details.`;
    case "manual_required":
      return "Razorpay can't pay this creator. Pay them by bank transfer yourself, then record the reference.";
    case "paid_manual":
      return "Paid by bank transfer outside Razorpay (recorded by staff).";
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
  /** One line under the chips, so each view says what it is. */
  blurb: string;
}

export const PAYOUT_CHIPS: PayoutChip[] = [
  { key: "needs_attention", label: "Needs attention", attention: true, blurb: "Razorpay's records and ours disagree, or a result stayed unknown. A person has to look." },
  { key: "manual_required", label: "Manual", attention: true, blurb: "Razorpay can't pay these creators. Pay each by bank transfer, then record the reference." },
  { key: "paused", label: "Paused", attention: false, blurb: "Held back by a dispute, an outside refund, a bank change or a staff pause. Nothing here is released." },
  { key: "held_awaiting_verify", label: "Held · awaiting verify", attention: false, blurb: "The creator's share is set aside. The post hasn't been verified yet, so no release is scheduled." },
  { key: "releasing", label: "Releasing", attention: false, blurb: "Verified. A release is scheduled or in flight." },
  { key: "settlement_pending", label: "Settlement pending", attention: false, blurb: "Released. Razorpay hasn't settled it to the creator's bank yet, so it isn't paid." },
  { key: "failed", label: "Failed", attention: true, blurb: "Razorpay refused the transfer, or the creator's bank rejected the settlement." },
  // The API's "open" view = everything not finished. Paid, taken-back and void payouts are in none of the views.
  { key: "open", label: "All open", attention: false, blurb: "Everything that isn't finished. Paid, taken-back and void payouts are not listed." },
];

export const isPayoutFilterKey = (v: unknown): v is PayoutFilterKey => PAYOUT_CHIPS.some((c) => c.key === v);

// ── The timeline ────────────────────────────────────────────────────────────────────────────────

export type StepState = "done" | "current" | "todo" | "error" | "warn" | "skipped";
export interface TimelineStep {
  key: string;
  label: string;
  detail: string | null;
  at: string | null;
  state: StepState;
}

export type TimelineInput = Pick<
  PayoutRow,
  "status" | "createdAt" | "heldAt" | "releasedAt" | "settledAt" | "reversedAt" | "releaseAfter" | "errorCode" | "destinationHint"
> &
  Partial<PayoutDetailFields>;

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
    held: p.status === "held" ? (p.releaseAfter ? `Release is scheduled for ${whenOf(p.releaseAfter)}.` : "Waiting for the creator's post to be verified.") : "Set aside at Razorpay.",
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
    case "reversed":
      steps.push({ key: "reversal", label: "Taken back", detail: "The creator's share is back in our Razorpay balance. The creator is not paid for this post.", at: p.reversedAt, state: "done" });
      break;
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

// ── A refusal from the API ──────────────────────────────────────────────────────────────────────

/**
 * The API ends every refusal with its stable code in brackets ("… Nothing was changed. [release_not_due]"). The sentence is for the
 * person; the code is kept apart, small, for whoever helps them.
 */
export function splitRefusal(message: string): { text: string; code: string | null } {
  const m = /\s*\[([a-z0-9_]{2,40})\]\s*$/i.exec(message);
  return m ? { text: message.slice(0, m.index).trim(), code: m[1] } : { text: message.trim(), code: null };
}

// ── Which buttons to offer ──────────────────────────────────────────────────────────────────────

export type PayoutActionKey = "pause" | "resume" | "retry" | "reverse" | "release" | "require_manual" | "mark_paid";
export interface PayoutActionView {
  key: PayoutActionKey;
  label: string;
  enabled: boolean;
  /** Why a button that is shown is disabled: printed under the row, never only in a tooltip. */
  why: string | null;
  tone: "gold" | "ghost" | "red";
}

type ActionInput = Pick<PayoutRow, "status" | "pausedAt" | "releaseAfter">;

/**
 * The buttons a payout offers. Mirrors the engine's own conditions closely enough that nobody is shown an action that cannot apply
 * (a transfer retried from "held", a hand payment recorded on a payout Razorpay is still carrying), and no more than that: the
 * engine re-checks everything fresh from Razorpay, and its refusal reaches the person. `releaseOn` is the runtime switch as the queue
 * last read it (undefined/null = unknown: the button is offered and the API decides).
 *
 * "Release now" is the ONE button shown disabled, with its reason, because "why isn't this paid yet" is the question it answers.
 */
export function actionsFor(p: ActionInput, ctx: { releaseOn: boolean | null | undefined; now: number; postVerified?: boolean }): PayoutActionView[] {
  if (isFinished(p.status)) return [];
  const out: PayoutActionView[] = [];
  const paused = !!p.pausedAt;

  if (paused) out.push({ key: "resume", label: "Resume", enabled: true, why: null, tone: "ghost" });

  switch (p.status) {
    case "held": {
      let why: string | null = null;
      if (paused) why = "Paused: resume it first.";
      else if (ctx.releaseOn === false) why = "All releases are paused (see the banner above).";
      else if (!p.releaseAfter) why = ctx.postVerified ? "The post is verified, but no release is scheduled for it yet." : "Nothing is scheduled: the creator's post hasn't been verified yet.";
      else if (Date.parse(p.releaseAfter) > ctx.now) why = `The hold runs until ${whenOf(p.releaseAfter)}.`;
      out.push({ key: "release", label: "Release now", enabled: why === null, why, tone: "gold" });
      out.push({ key: "reverse", label: "Reverse", enabled: true, why: null, tone: "red" });
      break;
    }
    case "failed":
      out.push({ key: "retry", label: "Retry transfer", enabled: true, why: null, tone: "gold" });
      out.push({ key: "require_manual", label: "Pay by bank transfer instead", enabled: true, why: null, tone: "ghost" });
      break;
    case "planned":
      out.push({ key: "retry", label: "Make transfer now", enabled: true, why: null, tone: "ghost" });
      break;
    case "manual_required":
      out.push({ key: "mark_paid", label: "Mark paid manually", enabled: true, why: null, tone: "gold" });
      break;
    case "needs_attention":
      out.push({ key: "reverse", label: "Reverse", enabled: true, why: null, tone: "red" });
      out.push({ key: "require_manual", label: "Pay by bank transfer instead", enabled: true, why: null, tone: "ghost" });
      break;
    case "released":
    case "settlement_failed":
      out.push({ key: "reverse", label: "Reverse", enabled: true, why: null, tone: "red" });
      break;
    default:
      break;
  }

  // Pausing stops a release. A payout whose reversal is under way is left alone: the worker is finishing it.
  if (!paused && p.status !== "reversal_requested") out.push({ key: "pause", label: "Pause", enabled: true, why: null, tone: "ghost" });
  return out;
}

// ── The bank reference staff record when they pay by hand ───────────────────────────────────────

const REFERENCE_RE = /^[A-Za-z0-9][A-Za-z0-9 _./:#-]{3,99}$/;
// Shapes that mean somebody pasted an identity or bank detail instead of a transfer reference. The API refuses the same shapes; this
// only says so before the request, because a reference is stored and shown to staff.
const TAX_ID_SHAPE = /[A-Za-z]{5}[0-9]{4}[A-Za-z]/;
const BRANCH_CODE_SHAPE = /[A-Za-z]{4}0[A-Za-z0-9]{6}/;

/** Why a bank reference can't be recorded (null = fine). Mirrors the engine's own check, which stays the authority. */
export function referenceProblem(raw: string): string | null {
  const r = raw.trim();
  if (r.length < 4) return "At least 4 characters.";
  if (!REFERENCE_RE.test(r)) return "Use letters, digits, spaces and - _ . / : # only (4 to 100 characters).";
  if (TAX_ID_SHAPE.test(r) || BRANCH_CODE_SHAPE.test(r)) return "That looks like a PAN or an IFSC code, not a bank transfer reference. Never record those here.";
  return null;
}
