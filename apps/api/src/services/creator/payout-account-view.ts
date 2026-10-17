import type { CreatorPayoutAccount } from "@dashmani/db";
import { formFieldForReference } from "@dashmani/shared/src/validators/creator-payout";
import type {
  BankChangeOutcome,
  PayoutAccountStatus,
  PayoutAccountView,
  PayoutAttention,
  PayoutBlockedReason,
  PayoutRequirement,
  PayoutSetupStep,
} from "@dashmani/shared/src/validators/creator-payout";
import { scrubPayoutSecrets } from "../../utils/payout-scrub";

export type { BankChangeOutcome, PayoutAccountStatus, PayoutAccountView, PayoutAttention, PayoutBlockedReason, PayoutRequirement, PayoutSetupStep };

// Pure: how a creator_payout_accounts row becomes JSON for the creator (and the staff screen), who
// may set an account up, and when a bank change holds back releases. No I/O, so every mapping is
// table-tested without a database.
//
// ⚠️ THE VIEW IS BUILT ONLY FROM STATUS. Nothing a creator typed is ever stored, so nothing of it can
// come out; on top of that every string that does leave is held to a whitelist shape (a Razorpay field
// reference, a snake_case reason code, a masked "HDFC ••••1234" hint). A value that fails its shape is
// dropped rather than passed along, so even a row written wrongly by a later phase cannot put free text,
// a PAN or an account number on the wire.

type Row = Pick<
  CreatorPayoutAccount,
  | "razorpayAccountId"
  | "setupStep"
  | "activationStatus"
  | "requirements"
  | "destinationHint"
  | "termsVersion"
  | "activatedAt"
  | "bookableAfter"
  | "bankChangeRequestedAt"
  | "bankChangeClearedAt"
  | "accountCreatedAt"
  | "setupLockedUntil"
  | "lastError"
  | "updatedAt"
>;

// ── Setup errors: a short code (and the Razorpay references it is about) kept in last_error ───

/**
 * The codes bank connect writes to `last_error`. A DEFINITE rejection means Razorpay refused what was
 * submitted (the view then reads "failed"): either the creator must correct something (the three
 * *_REJECTED codes, which name form fields), or only our team can resolve it (ACCOUNT_CONFLICT, and
 * PRODUCT_REFUSED: the Route product call carries none of the creator's details, so the creator cannot fix it
 * and a retry meets the same answer; the view carries no field, so `attention` is "contact_us"). The others
 * mean the outcome is UNKNOWN or Razorpay was unreachable, and the same submission may simply be sent again.
 */
export const SETUP_REJECTION_CODES = ["DETAILS_REJECTED", "PAN_REJECTED", "BANK_DETAILS_REJECTED", "ACCOUNT_CONFLICT", "PRODUCT_REFUSED"] as const;
export const SETUP_RETRYABLE_CODES = ["ACCOUNT_UNKNOWN", "PRODUCT_UNKNOWN", "RAZORPAY_UNAVAILABLE"] as const;
const REJECTIONS: ReadonlySet<string> = new Set(SETUP_REJECTION_CODES);

/** `CODE` or `CODE|reference,reference`: a code and the Razorpay field references it is about. Never a value, never Razorpay's text. */
export function encodeSetupError(code: string, references: readonly string[] = []): string {
  const refs = references.filter((r) => /^[A-Za-z0-9_.]{1,80}$/.test(r)).slice(0, 8);
  return refs.length > 0 ? `${code}|${refs.join(",")}` : code;
}

export function decodeSetupError(lastError: string | null | undefined): { code: string; references: string[] } | null {
  if (!lastError) return null;
  const [code, refs] = lastError.split("|", 2);
  if (!/^[A-Z_]{3,40}$/.test(code)) return null; // an alert stamp ("alerted:...") or anything else
  return { code, references: refs ? refs.split(",").filter((r) => /^[A-Za-z0-9_.]{1,80}$/.test(r)) : [] };
}

// ── The view ────────────────────────────────────────────────────────────────────────────────────

const NEXT_STEP: Record<string, PayoutSetupStep> = {
  none: "account",
  account: "stakeholder",
  stakeholder: "product",
  product: "bank",
  bank: "done",
  done: "done",
};

/** Whether all four Razorpay calls have succeeded ("bank" is read as done: the last call is the bank one). */
export function setupIsDone(row: Pick<Row, "setupStep"> | null): boolean {
  return row !== null && (row.setupStep === "done" || row.setupStep === "bank");
}

/**
 * Razorpay already holds this account past setup (activated, or suspended). Nothing may ever send bank
 * (settlement) details to such an account again: that call is for first-time setup only, and a bank
 * change goes through the staff-mediated request. This is judged from what RAZORPAY says, not only from
 * our own setup_step, because an answer we lost leaves the step behind while the account moves on.
 */
export function razorpayHoldsAccount(row: Pick<Row, "activationStatus"> | null): boolean {
  return row !== null && (row.activationStatus === "activated" || row.activationStatus === "suspended");
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const FIELD_RE = /^[A-Za-z0-9_.[\]-]{1,120}$/;
const REASON_RE = /^[A-Za-z0-9_.-]{1,60}$/;
const HINT_RE = /^(?:[A-Z]{4} )?••••[0-9]{4}$/;
/** Requirement statuses that mean Razorpay no longer needs the field. */
const RESOLVED = new Set(["resolved", "complete", "completed", "fulfilled"]);

/** The stored requirements[] as {field, reason}: references and codes only, each held to a whitelist shape. */
function viewRequirements(stored: unknown): PayoutRequirement[] {
  if (!Array.isArray(stored)) return [];
  const out: PayoutRequirement[] = [];
  for (const r of stored) {
    if (typeof r !== "object" || r === null || Array.isArray(r)) continue;
    const e = r as Record<string, unknown>;
    const field = typeof e.field_reference === "string" ? scrubPayoutSecrets(e.field_reference) : "";
    if (!FIELD_RE.test(field)) continue;
    const status = typeof e.status === "string" ? e.status.toLowerCase() : "";
    if (RESOLVED.has(status)) continue;
    const raw = typeof e.reason_code === "string" && e.reason_code ? e.reason_code : status || "required";
    out.push({ field, reason: REASON_RE.test(raw) ? raw : "unspecified" });
    if (out.length >= 30) break;
  }
  return out;
}

/** The status the creator reads. See the table in the notes: Razorpay's `requested` and `under_review` both read "under_review". */
export function payoutAccountStatus(row: Row | null, now: Date = new Date()): PayoutAccountStatus {
  if (!row) return "not_started";
  if (row.activationStatus === "activated") return "activated";
  if (row.activationStatus === "suspended") return "suspended";
  if (!setupIsDone(row)) {
    const err = decodeSetupError(row.lastError);
    if (err && REJECTIONS.has(err.code)) return "failed";
    // A request holding the setup lease is working on it right now.
    if (row.setupLockedUntil && row.setupLockedUntil.getTime() > now.getTime()) return "setting_up";
    const touched = row.razorpayAccountId !== null || row.accountCreatedAt !== null || err !== null || row.setupStep !== "none";
    return touched ? "setting_up" : "not_started";
  }
  // Setup done: what Razorpay says now.
  return row.activationStatus === "needs_clarification" ? "needs_clarification" : "under_review";
}

/**
 * What a failed setup asks of the creator: correct the marked details, or write to us. An account Razorpay
 * holds under their email (ACCOUNT_CONFLICT), a refused Route product (PRODUCT_REFUSED: the call carries none
 * of their details) and a refusal that named no form-mappable field are things the creator cannot fix by
 * retyping, and the screen must not say "correct the marked details" with none marked.
 */
function attentionOf(status: PayoutAccountStatus, lastError: string | null): PayoutAttention | null {
  if (status !== "failed") return null;
  const err = decodeSetupError(lastError);
  if (!err || err.code === "ACCOUNT_CONFLICT" || err.code === "PRODUCT_REFUSED") return "contact_us";
  return err.references.some((r) => formFieldForReference(r) !== null) ? "fix_details" : "contact_us";
}

/** The ONE shape that leaves the server for a payout account (GET/PUT /v1/creator/payout-account, the staff panel). */
export function toPayoutAccountView(row: Row | null, now: Date = new Date()): PayoutAccountView | null {
  if (!row) return null;
  const status = payoutAccountStatus(row, now);
  let requirements: PayoutRequirement[] = [];
  if (status === "failed") {
    // What we were told to correct: the references the rejection was about.
    requirements = (decodeSetupError(row.lastError)?.references ?? []).map((field) => ({ field, reason: "rejected" }));
  } else if (setupIsDone(row) && status !== "activated") {
    requirements = viewRequirements(row.requirements);
  }
  return {
    status,
    setupStep: NEXT_STEP[row.setupStep] ?? "account",
    attention: attentionOf(status, row.lastError),
    requirements,
    destinationHint: row.destinationHint && HINT_RE.test(row.destinationHint) ? row.destinationHint : null,
    activatedAt: iso(row.activatedAt),
    bookableAfter: iso(row.bookableAfter),
    bankChange: { requestedAt: iso(row.bankChangeRequestedAt), clearedAt: iso(row.bankChangeClearedAt), outcome: bankChangeOutcome(row) },
    termsVersion: row.termsVersion ?? null,
    updatedAt: iso(row.updatedAt),
  };
}

// ── Who may set an account up ───────────────────────────────────────────────────────────────────

/** What canSetUp can say from the creator alone: the switch and the terms are decided elsewhere (payoutUnavailableReason). */
export type SetUpBlock = Exclude<PayoutBlockedReason, "route_disabled" | "terms_pending">;

/**
 * Bank connect needs an APPROVED creator with a VERIFIED email: staff have vetted the pages, and the
 * verified address is the one Razorpay's account is opened under (its duplicate check and the
 * adoption rule both key on it). `closed` outranks everything; a suspended, rejected, draft or
 * in-review creator reads "not_approved".
 */
export function canSetUp(creator: { status: string; emailVerifiedAt: Date | null }): { canSetUp: boolean; blockedReason: SetUpBlock | null } {
  if (creator.status === "closed") return { canSetUp: false, blockedReason: "closed" };
  if (creator.status !== "approved") return { canSetUp: false, blockedReason: "not_approved" };
  if (!creator.emailVerifiedAt) return { canSetUp: false, blockedReason: "email_not_verified" };
  return { canSetUp: true, blockedReason: null };
}

// ── Bank change ─────────────────────────────────────────────────────────────────────────────────

/** After staff clear a bank change, releases stay paused this long (the plan's 72 hours). */
export const BANK_CHANGE_HOLD_MS = 72 * 60 * 60 * 1000;

type BankChangeRow = Pick<CreatorPayoutAccount, "bankChangeRequestedAt" | "bankChangeClearedAt">;

/** A request that staff have not cleared yet. A request made AFTER the last clearing is pending again. */
export function bankChangePending(account: BankChangeRow | null): boolean {
  if (!account?.bankChangeRequestedAt) return false;
  const cleared = account.bankChangeClearedAt;
  return cleared === null || cleared.getTime() < account.bankChangeRequestedAt.getTime();
}

/**
 * How a request that is no longer waiting ended. The two columns alone say it, so the answer can never
 * disagree with the release hold that reads the same two columns (and needs no query of its own):
 *   • cleared LATER than requested → "processed": staff did the change (the clearing is stamped strictly after
 *     the request, see markBankChangeProcessed);
 *   • cleared EXACTLY AT the request → "declined": staff closed it without a change (declineBankChange), the one
 *     way the two stamps can be equal.
 * Null while a request is waiting, and when none was made.
 */
export function bankChangeOutcome(account: BankChangeRow | null): BankChangeOutcome | null {
  if (!account?.bankChangeRequestedAt || !account.bankChangeClearedAt || bankChangePending(account)) return null;
  return account.bankChangeClearedAt.getTime() === account.bankChangeRequestedAt.getTime() ? "declined" : "processed";
}

/**
 * Whether releases for this creator are paused by a bank change (the Phase 4 release gate reads this):
 * from the request until staff clear it, plus BANK_CHANGE_HOLD_MS after the clearing. A creator who never
 * asked is never blocked, and neither is one whose request was closed WITHOUT a change: nothing about their
 * payout account changed, so there is nothing to wait out (the request itself paused releases until then).
 */
export function bankChangeBlocksRelease(account: BankChangeRow | null, now: Date = new Date()): boolean {
  if (!account?.bankChangeRequestedAt) return false;
  if (bankChangePending(account)) return true;
  if (bankChangeOutcome(account) === "declined") return false;
  return now.getTime() < account.bankChangeClearedAt!.getTime() + BANK_CHANGE_HOLD_MS;
}
