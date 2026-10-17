import { prisma, Prisma } from "@dashmani/db";
import type { CreatorPayoutAccount } from "@dashmani/db";
import { dateToIST, istMidnight } from "@dashmani/shared/src/utils/date";
import {
  PAYOUT_FIELD_REJECTED,
  formFieldForReference,
  referencesForRejection,
  splitBankRejection,
  type CreatorPayoutAccountInput,
  type PayoutAccountResponse,
  type PayoutBlockedReason,
  type PayoutFormField,
} from "@dashmani/shared/src/validators/creator-payout";
import { AppError } from "../../middleware/error-handler";
import { destinationHint, scrubPayoutObject, scrubPayoutSecrets } from "../../utils/payout-scrub";
import { razorpayConfig } from "../campaign/config";
import {
  RazorpayError,
  createLinkedAccount,
  createStakeholder,
  fetchLinkedAccount,
  isDefinitelyRejected,
  requestRouteProduct,
  updateRouteProductSettlement,
  type RazorpayRouteProduct,
} from "../campaign/razorpay";
import { creatorConfig } from "./creator-config";
import { button, creatorLink, esc, sendCreatorEmail } from "./creator-email";
import { alertStaffOncePerHour } from "./payout-alert";
import {
  bankChangePending,
  canSetUp,
  encodeSetupError,
  payoutAccountStatus,
  razorpayHoldsAccount,
  setupIsDone,
  toPayoutAccountView,
} from "./payout-account-view";

// Creator payouts, Phase 2: BANK CONNECT. A creator gives us their PAN, bank account and address once;
// we pass them to Razorpay in four calls (linked account, stakeholder, Route product, settlement bank)
// and keep ONLY Razorpay's ids, its status, the requirement field references and a masked hint.
// Plan: docs/superpowers/plans/2026-10-12-creator-payouts-razorpay-route.md, "Phase 2: Bank connect".
//
// ⚠️ THE PRIVACY RULE, and how this file keeps it. The PAN, account number, IFSC, name and address
// reach this file inside `body`, are handed to the Razorpay client, and are never handed to anything
// else: not Prisma (no column exists for them), not console, not an email, not an error message, not
// the response. Every error that leaves is one of OUR fixed messages plus the Razorpay field
// REFERENCE it was about; Razorpay's own text is read only for keywords (referencesForRejection) and
// dropped. `last_error` holds a short code and references, never text (payout-account-view.ts).
// Anything logged goes through scrubPayoutSecrets first.
//
// ⚠️ NO TWO ACCOUNTS, EVER. A second linked account for the same person would fail Razorpay's duplicate
// check, and a half-made one is exactly what a retry must not repeat. Three things hold it:
//   1. a LEASE (setup_locked_until): one request at a time holds it, claimed with a conditional
//      update, so two tabs or a double click cannot both reach the create call. No database
//      transaction is held across an HTTP call; the lease is a timestamp, and a crashed request's
//      lease simply expires.
//   2. each Razorpay id is saved the moment its call succeeds, and `setup_step` (the last step that
//      SUCCEEDED) makes a retry resume after it instead of repeating it.
//   3. an unknown outcome of the create call (a timeout, a 5xx, an unreadable 2xx) is never treated as
//      "it did not happen". The retry sends the same create again, which is safe BECAUSE Razorpay
//      refuses a second account under the same email and names the first one; that answer is adopted
//      only under the rule in adoptExistingAccount.

// ── Availability ────────────────────────────────────────────────────────────────────────────────

/**
 * Why bank connect is closed, or null when it is open. The ONE place availability is decided: the switch
 * and Razorpay's keys (`route_disabled`: dark), then the terms (`terms_pending`: the switch is on, but the
 * creator terms in force are still the pre-payout ones, which say we pay creators nothing).
 */
export function payoutUnavailableReason(): "route_disabled" | "terms_pending" | null {
  if (!creatorConfig.routeEnabled() || !razorpayConfig.configured()) return "route_disabled";
  if (creatorConfig.payoutTermsPending()) return "terms_pending";
  return null;
}

/** Bank connect is available only with the switch ON, Razorpay's keys present and the payout terms in force; otherwise it is closed. */
export function routeAvailable(): boolean {
  return payoutUnavailableReason() === null;
}

const LEASE_MS = 3 * 60_000;
/** The advisory lock that serialises the daily-cap check, so two creators at the limit cannot both slip under it. Exported for the test that proves a creation waits on it. */
export const PAYOUT_CAP_LOCK_KEY = 724182011;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The instant the current IST day began (the per-day cap counts accounts from here). */
export function istDayStartUtc(now: Date = new Date()): Date {
  return new Date(istMidnight(dateToIST(now)).getTime() - IST_OFFSET_MS);
}

async function loadCreator(creatorId: string) {
  const c = await prisma.creator.findUnique({ where: { id: creatorId } });
  if (!c || c.status === "closed") throw new AppError(401, "ACCOUNT_CLOSED", "This account is closed.");
  return c;
}
type CreatorRow = Awaited<ReturnType<typeof loadCreator>>;

/** A line for the log that cannot carry a bank detail: scrubbed and bounded, never the object. */
function safeLog(prefix: string, err: unknown): void {
  const text = scrubPayoutSecrets(String((err as { message?: unknown } | null)?.message ?? err)).slice(0, 200);
  console.error(`${prefix}: ${text}`);
}

function staffAlert(key: string, subject: string, creator: Pick<CreatorRow, "id" | "name" | "email">, extra: Array<{ label: string; value: string }>): void {
  alertStaffOncePerHour(key, subject, [{ label: "Creator", value: `${creator.name} (${creator.email})` }, ...extra], `/creators/${creator.id}`);
}

// ── Reading ─────────────────────────────────────────────────────────────────────────────────────

async function buildResponse(creator: CreatorRow, row: CreatorPayoutAccount | null, now: Date = new Date()): Promise<PayoutAccountResponse> {
  const unavailable = payoutUnavailableReason();
  const available = unavailable === null;
  const gate = canSetUp(creator);
  const blockedReason: PayoutBlockedReason | null = unavailable ?? gate.blockedReason;
  return {
    termsVersion: creatorConfig.termsVersion(),
    routeEnabled: available,
    // Nothing to set up once all four calls have succeeded, or once Razorpay holds the account past
    // setup (activated or suspended, whatever our step says): a change goes through requestBankChange.
    canSetUp: available && gate.canSetUp && !setupIsDone(row) && !razorpayHoldsAccount(row),
    blockedReason,
    account: toPayoutAccountView(row, now),
  };
}

/** GET: what the creator sees. Never calls Razorpay, never creates a row, answers for any creator who is signed in. */
export async function getPayoutAccount(creatorId: string): Promise<PayoutAccountResponse> {
  const creator = await loadCreator(creatorId);
  const row = await prisma.creatorPayoutAccount.findUnique({ where: { creatorId } });
  return buildResponse(creator, row);
}

/** The checklist item for GET /creator/me: present ONLY while bank connect is available, so nothing changes while it is dark. */
export async function payoutChecklistItem(creatorId: string): Promise<{ status: string; done: boolean } | undefined> {
  if (!routeAvailable()) return undefined;
  const row = await prisma.creatorPayoutAccount.findUnique({ where: { creatorId } });
  const status = payoutAccountStatus(row);
  return { status, done: status === "under_review" || status === "activated" };
}

// ── Razorpay product facts → our columns (the ONE place that mapping lives) ──────────────────────

const PRODUCT_STATUSES: ReadonlySet<string> = new Set(["requested", "under_review", "needs_clarification", "activated", "suspended"]);

export interface ProductFacts {
  /** Razorpay's activation_status. Anything outside its five documented values is ignored. */
  activationStatus: string;
  /** References and reason codes only (the Razorpay client's parser, or the webhook's reader, already dropped the descriptions). */
  requirements: ReadonlyArray<{ field_reference: string; reason_code: string | null; status: string | null }>;
  /** When Razorpay said so: the event's own time, or now for a poll. Doubles as the freshness mark (last_checked_at). */
  at: Date;
  /** The masked hint a poll reads from Razorpay's echo ("HDFC ••••1234"); absent for a webhook event. */
  settlementHint?: string | null;
}

type ProductRow = Pick<
  CreatorPayoutAccount,
  "id" | "setupStep" | "activationStatus" | "requirements" | "activatedAt" | "bookableAfter" | "lastCheckedAt" | "destinationHint" | "razorpayProductId"
>;

export type ProductApplyResult = {
  applied: boolean;
  /** applied | unchanged (nothing to write) | stale (a newer poll or event already wrote) | unknown_status */
  note: "applied" | "unchanged" | "stale" | "unknown_status";
  previous: string;
  status: string;
};

/** JSON with sorted keys: jsonb does not keep key order, so two equal values must compare equal. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

const word = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? scrubPayoutSecrets(v.trim()).slice(0, max) : null);

/**
 * What a Razorpay product status changes on our row. Pure, so the mapping is table-tested:
 *   • activation_status and requirements (references and reason codes only, scrubbed as an object);
 *   • activated: activated_at (KEPT on a re-activation), bookable_after = activated_at + 24h (the
 *     conservative reading of Razorpay's cooling-period docs; also kept), last_error cleared, and a setup
 *     that is not done is settled to "done": Razorpay cannot activate an account without settlement
 *     details, so its answer to the bank call must have been applied even if OURS was lost. That is how a
 *     retry after a lost answer can never overwrite accepted details. It holds from ANY step that has
 *     started (an adopted dashboard-made account sits at "stakeholder" with its product already
 *     activated), but only once we hold the product's id: the id is what ties the activation to the
 *     account we set up, and without one the status is stored and the step is left for a person to settle;
 *   • last_checked_at = the time of the facts, which is also the freshness mark;
 *   • destination_hint when a poll read one from Razorpay's echo.
 * Null when the status is not one of Razorpay's five (a value we do not know is never written).
 */
export function mapProductFacts(
  row: ProductRow,
  facts: ProductFacts,
): { target: string; unchanged: boolean; data: Prisma.CreatorPayoutAccountUpdateManyMutationInput } | null {
  const target = typeof facts.activationStatus === "string" ? facts.activationStatus.trim().toLowerCase() : "";
  if (!PRODUCT_STATUSES.has(target)) return null;

  const list = facts.requirements
    .map((r) => ({ field_reference: word(r.field_reference, 120), reason_code: word(r.reason_code, 60), status: word(r.status, 24) }))
    .filter((r): r is { field_reference: string; reason_code: string | null; status: string | null } => r.field_reference !== null)
    .slice(0, 30);
  // Scrubbed as an object as well, so even a hostile or surprising value cannot put a PAN- or
  // account-number-shaped string into this column.
  const requirements = scrubPayoutObject(list) as Prisma.InputJsonValue;
  const at = facts.at;
  const activatedAt = target === "activated" ? (row.activatedAt ?? at) : undefined;
  const bookableAfter = target === "activated" ? (row.bookableAfter ?? new Date((row.activatedAt ?? at).getTime() + DAY_MS)) : undefined;
  const hint = facts.settlementHint ?? null;
  const hintChanges = hint !== null && hint !== row.destinationHint;
  // ⚠️ Only an ACTIVATION settles, never a suspension: a suspended account may never have had its bank
  // details applied, so settling on it could hide a setup that is genuinely unfinished.
  const settlesSetup = target === "activated" && !setupIsDone(row) && row.setupStep !== "none" && !!row.razorpayProductId;

  const unchanged =
    row.activationStatus === target &&
    stableJson(row.requirements) === stableJson(requirements) &&
    (target !== "activated" || (row.activatedAt !== null && row.bookableAfter !== null)) &&
    !settlesSetup &&
    !hintChanges;

  return {
    target,
    unchanged,
    data: {
      activationStatus: target,
      requirements,
      lastCheckedAt: at,
      ...(target === "activated" ? { activatedAt, bookableAfter, lastError: null } : {}),
      ...(settlesSetup ? { setupStep: "done" } : {}),
      ...(hintChanges ? { destinationHint: hint } : {}),
    },
  };
}

/**
 * Apply what Razorpay says about a linked account's Route product (a webhook event or a poll). The
 * write is ONE conditional updateMany: it matches only while last_checked_at is not newer than these
 * facts, so a late event can never undo what a newer poll saw, and a replay changes nothing twice.
 * `touch` (the poll passes it) also stamps last_checked_at when nothing else changed, so an unchanged
 * account is not asked again at once; a webhook event does not, exactly as before.
 */
export async function applyProductStatus(row: ProductRow, facts: ProductFacts, opts: { touch?: boolean } = {}): Promise<ProductApplyResult> {
  const m = mapProductFacts(row, facts);
  if (!m) return { applied: false, note: "unknown_status", previous: row.activationStatus, status: row.activationStatus };
  const fresh = { OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lte: facts.at } }] };
  if (m.unchanged) {
    if (opts.touch) await prisma.creatorPayoutAccount.updateMany({ where: { id: row.id, ...fresh }, data: { lastCheckedAt: facts.at } });
    return { applied: false, note: "unchanged", previous: row.activationStatus, status: m.target };
  }
  const r = await prisma.creatorPayoutAccount.updateMany({ where: { id: row.id, ...fresh }, data: m.data });
  return r.count === 1
    ? { applied: true, note: "applied", previous: row.activationStatus, status: m.target }
    : { applied: false, note: "stale", previous: row.activationStatus, status: row.activationStatus };
}

// ── Setting up ──────────────────────────────────────────────────────────────────────────────────

type StepName = "account" | "stakeholder" | "product" | "bank";
const STEP_ORDER = ["none", "account", "stakeholder", "product", "bank", "done"];
const stepIndex = (s: string): number => Math.max(0, STEP_ORDER.indexOf(s));

/**
 * Bank (settlement) details must never go to an account Razorpay already holds past setup.
 * ⚠️ The sentence does not point at the "Change bank account" button: this guard fires while our own step is
 * still short of "done", and the portal offers that button only once it is (and the API's bank-change request
 * answers NO_PAYOUT_ACCOUNT until then). A creator is only ever sent to a way out that exists: the email address.
 */
const alreadyWithRazorpay = () =>
  new AppError(
    409,
    "ALREADY_SET_UP",
    "Your payout account is already set up with Razorpay, so nothing needs to be sent again. If you need to change your bank account, email creators@digitalsukoon.com.",
  );

/** What the creator is told for each definite rejection: OUR wording, never Razorpay's. */

const REJECTION_MESSAGE: Record<string, string> = {
  BANK_DETAILS_REJECTED: "Razorpay could not accept your bank details. Check the account number, IFSC and name, then try again.",
  PAN_REJECTED: "Razorpay could not accept your PAN. Check that it matches your card exactly, then try again.",
  DETAILS_REJECTED: "Razorpay could not accept some of your details. Check the highlighted fields, then try again.",
};

/**
 * A definite refusal that is OUR setup problem rather than the creator's details: Razorpay's
 * credentials rejected, or a feature (marketplace / route code support) not enabled on our account
 * (plan prerequisite 3). The creator cannot fix these and must not be told their details were wrong.
 */
function isConfigurationFailure(e: RazorpayError): boolean {
  if (e.status === 401 || e.status === 403) return true;
  return /marketplace feature|requested url was not found|feature not enabled|not allowed for this merchant|not enabled/i.test(e.message);
}

/** The whole setup, one creator. `body` carries the sensitive fields: it is passed to Razorpay and to nothing else. */
export async function setUpPayoutAccount(creatorId: string, body: CreatorPayoutAccountInput): Promise<PayoutAccountResponse> {
  const unavailable = payoutUnavailableReason();
  if (unavailable === "route_disabled") throw new AppError(503, "ROUTE_DISABLED", "Adding a bank account is not open yet.");
  // The creator would be accepting terms that say we pay creators nothing, to open a payment account.
  if (unavailable === "terms_pending") throw new AppError(503, "TERMS_PENDING", "Adding a bank account is not open yet.");
  const creator = await loadCreator(creatorId);
  const gate = canSetUp(creator);
  if (!gate.canSetUp) {
    if (gate.blockedReason === "email_not_verified") throw new AppError(409, "EMAIL_NOT_VERIFIED", "Confirm your email address first — we sent you a link.");
    throw new AppError(403, "NOT_APPROVED", "Your account needs to be approved before you can add a bank account.");
  }
  if (body.termsVersion !== creatorConfig.termsVersion()) {
    throw new AppError(409, "TERMS_CHANGED", "The creator terms have changed. Reload the page, read them and accept the new version.");
  }

  // The row must exist for the lease to have something to hold.
  await prisma.creatorPayoutAccount.createMany({ data: [{ creatorId }], skipDuplicates: true });
  let lease = await claimLease(creatorId);
  try {
    await runSetup(creator, body, () => lease, (next) => (lease = next));
  } finally {
    await releaseLease(creatorId, lease);
  }
  const row = await prisma.creatorPayoutAccount.findUnique({ where: { creatorId } });
  return buildResponse(creator, row);
}

/** Take the lease or refuse: a conditional update, so two overlapping requests cannot both get it. */
async function claimLease(creatorId: string): Promise<Date> {
  const now = new Date();
  const until = new Date(now.getTime() + LEASE_MS);
  const r = await prisma.creatorPayoutAccount.updateMany({
    where: { creatorId, OR: [{ setupLockedUntil: null }, { setupLockedUntil: { lt: now } }] },
    data: { setupLockedUntil: until },
  });
  if (r.count === 0) throw new AppError(409, "SETUP_IN_PROGRESS", "Your bank account is already being set up. Give it a minute.");
  return until;
}

/** Extend the lease before each Razorpay call; losing it (it expired and another request took it) stops this one. */
async function renewLease(creatorId: string, current: Date): Promise<Date> {
  const next = new Date(Date.now() + LEASE_MS);
  const r = await prisma.creatorPayoutAccount.updateMany({ where: { creatorId, setupLockedUntil: current }, data: { setupLockedUntil: next } });
  if (r.count === 0) throw new AppError(409, "SETUP_IN_PROGRESS", "Your bank account is already being set up. Give it a minute.");
  return next;
}

async function releaseLease(creatorId: string, lease: Date): Promise<void> {
  try {
    await prisma.creatorPayoutAccount.updateMany({ where: { creatorId, setupLockedUntil: lease }, data: { setupLockedUntil: null } });
  } catch (e) {
    // The lease expires by itself; a failed release only delays the next attempt.
    safeLog("[creator-payout] could not release the setup lease", e);
  }
}

async function recordError(creatorId: string, lastError: string): Promise<void> {
  await prisma.creatorPayoutAccount.updateMany({ where: { creatorId }, data: { lastError: lastError.slice(0, 500) } });
}

/** The beneficiary name Razorpay accepts: letters, digits and spaces only [R5 errors]. */
function beneficiaryNameOf(fullName: string): string {
  return fullName.replace(/[^A-Za-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

async function runSetup(creator: CreatorRow, body: CreatorPayoutAccountInput, getLease: () => Date, setLease: (d: Date) => void): Promise<void> {
  const creatorId = creator.id;
  const renew = async () => setLease(await renewLease(creatorId, getLease()));
  let row = await prisma.creatorPayoutAccount.findUniqueOrThrow({ where: { creatorId } });
  if (setupIsDone(row)) return; // a double submit after success: nothing to do, nothing sent
  // ⚠️ Our setup_step can sit behind Razorpay's truth: the bank call may have been APPLIED while its answer was
  // lost, and the account has since moved on to activated. Sending bank details now would overwrite accepted
  // ones and skip the staff-mediated bank change (and its release hold), so nothing is sent: the poll or a
  // webhook settles the step, and a change goes through requestBankChange.
  if (razorpayHoldsAccount(row)) throw alreadyWithRazorpay();

  // The creator accepted the terms by submitting; Razorpay requires a contract with every seller.
  await prisma.creatorPayoutAccount.updateMany({ where: { creatorId }, data: { termsVersion: body.termsVersion, termsAcceptedAt: new Date() } });

  const fail = (step: StepName, e: unknown) => failStep(creator, step, e);

  // ── 1. The linked account ───────────────────────────────────────────────────────────────────
  let accountId = row.razorpayAccountId;
  if (!accountId) {
    await reserveAccountSlot(creatorId);
    await renew();
    try {
      const created = await createLinkedAccount({
        // The VERIFIED email: Razorpay's duplicate check and the adoption rule both key on it.
        email: creator.email,
        phone: body.phone,
        legalName: body.fullName,
        contactName: body.fullName,
        ...(creatorConfig.routeReferenceId() ? { referenceId: creator.id } : {}),
        ...creatorConfig.routeCategory(),
        address: { street1: body.address.street1, street2: body.address.street2, city: body.address.city, state: body.address.state, postalCode: body.address.postalCode },
      });
      accountId = created.id;
    } catch (e) {
      accountId = await adoptExistingAccount(creator, e);
    }
    await persistAccountId(creator, accountId);
    row = await prisma.creatorPayoutAccount.findUniqueOrThrow({ where: { creatorId } });
  }

  // ── 2. The stakeholder (the creator themselves; the PAN goes here) ──────────────────────────
  if (stepIndex(row.setupStep) < stepIndex("stakeholder")) {
    await renew();
    let stakeholderId: string | null = null;
    try {
      const st = await createStakeholder(accountId, {
        name: body.fullName,
        email: creator.email,
        panNumber: body.pan,
        phone: body.phone,
        residential: {
          street: [body.address.street1, body.address.street2].filter(Boolean).join(", ").slice(0, 100),
          city: body.address.city,
          state: body.address.state,
          postalCode: body.address.postalCode,
        },
      });
      stakeholderId = st.id;
    } catch (e) {
      // Razorpay allows ONE stakeholder per Route account. "Cannot be more than one" on a retry (or on an
      // adopted account) therefore means the creator is already there, with the PAN accepted: carry on.
      const already = e instanceof RazorpayError && isDefinitelyRejected(e) && /more than one/i.test(e.message);
      if (!already) return fail("stakeholder", e);
    }
    await prisma.creatorPayoutAccount.updateMany({ where: { creatorId }, data: { setupStep: "stakeholder", razorpayStakeholderId: stakeholderId, lastError: null } });
    row = await prisma.creatorPayoutAccount.findUniqueOrThrow({ where: { creatorId } });
  }

  // ── 3. The Route product (Razorpay's own terms are accepted here) ───────────────────────────
  let productId = row.razorpayProductId;
  if (!productId) {
    await renew();
    let product: RazorpayRouteProduct;
    try {
      product = await requestRouteProduct(accountId, { tncAccepted: true });
    } catch (e) {
      return failStep(creator, "product", e, { accountId });
    }
    productId = product.id;
    const mapped = mapProductFacts(row, { activationStatus: product.activation_status, requirements: product.requirements, at: new Date() });
    await prisma.creatorPayoutAccount.updateMany({
      where: { creatorId },
      data: { setupStep: "product", razorpayProductId: product.id, razorpayTncAcceptedAt: new Date(), lastError: null, ...(mapped?.data ?? {}) },
    });
    row = await prisma.creatorPayoutAccount.findUniqueOrThrow({ where: { creatorId } });
  } else if (stepIndex(row.setupStep) < stepIndex("product")) {
    // The product id was filled in by hand (the unknown-answer case above): carry on from there.
    await prisma.creatorPayoutAccount.updateMany({ where: { creatorId }, data: { setupStep: "product", lastError: null } });
    row = await prisma.creatorPayoutAccount.findUniqueOrThrow({ where: { creatorId } });
  }

  // ── 4. The settlement bank account ──────────────────────────────────────────────────────────
  await renew();
  // The last look before the one call that must never reach an activated account: a webhook or the poll may
  // have settled or activated it since this request read the row.
  const latest = await prisma.creatorPayoutAccount.findUniqueOrThrow({ where: { creatorId }, select: { setupStep: true, activationStatus: true } });
  if (setupIsDone(latest)) return;
  if (razorpayHoldsAccount(latest)) throw alreadyWithRazorpay();
  let settled: RazorpayRouteProduct;
  try {
    settled = await updateRouteProductSettlement(accountId, productId!, {
      accountNumber: body.accountNumber,
      ifsc: body.ifsc,
      beneficiaryName: beneficiaryNameOf(body.fullName),
    });
  } catch (e) {
    return fail("bank", e);
  }
  // Razorpay's echo of the account is reduced to a masked hint by the client's parser; ours, built from
  // what the creator typed, is the fallback. Neither keeps the number.
  const hint = settled.settlement_hint ?? destinationHint(body.ifsc, body.accountNumber);
  const mapped = mapProductFacts(row, { activationStatus: settled.activation_status, requirements: settled.requirements, at: new Date() });
  // ONE write: "done" and the status Razorpay reported, so no reader sees a finished setup with a stale status.
  await prisma.creatorPayoutAccount.updateMany({
    where: { creatorId },
    data: { setupStep: "done", destinationHint: hint, lastError: null, ...(mapped?.data ?? {}) },
  });

  const name = creator.name;
  void sendCreatorEmail(
    creator.email,
    "We sent your bank details to Razorpay",
    "Bank account added",
    `<p>Hi ${esc(name)},</p>` +
      `<p>We have passed your bank account details to Razorpay, our payments partner, so it can set up your payout account and you are ready when paid bookings open. ` +
      `We keep only a masked reference to the account, none of the details themselves, and this email does not repeat them.</p>` +
      `<p>Razorpay may take a short while to verify the account. You can follow its status in the portal.</p>` +
      `<p>${button(creatorLink("/payouts"), "See your payout status")}</p>`,
  ).catch((e) => safeLog("[creator-payout] confirmation email failed", e));
}

/**
 * Count this creator's NEW account against the per-day cap and stamp the reservation, atomically: a
 * short transaction under an advisory lock (database work only, no HTTP inside), so two creators at the
 * limit cannot both pass. A creator whose reservation already exists is RESUMING a creation and does not
 * count again. The reservation is released when Razorpay definitely refuses the create call.
 */
async function reserveAccountSlot(creatorId: string): Promise<void> {
  const cap = creatorConfig.payoutAccountDailyCap();
  const now = new Date();
  await prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(${Prisma.raw(String(PAYOUT_CAP_LOCK_KEY))})) AS l`;
      const mine = await tx.creatorPayoutAccount.findUnique({ where: { creatorId }, select: { accountCreatedAt: true } });
      if (mine?.accountCreatedAt) return;
      const today = await tx.creatorPayoutAccount.count({ where: { accountCreatedAt: { gte: istDayStartUtc(now) } } });
      if (today >= cap) throw new AppError(503, "PAYOUT_BUSY", "We are setting up a lot of payout accounts right now. Please try again tomorrow.");
      await tx.creatorPayoutAccount.update({ where: { creatorId }, data: { accountCreatedAt: now } });
    },
    { maxWait: 5000, timeout: 10_000 },
  );
}

async function releaseReservation(creatorId: string): Promise<void> {
  await prisma.creatorPayoutAccount.updateMany({ where: { creatorId, razorpayAccountId: null }, data: { accountCreatedAt: null } });
}

/** Save the account id the moment it exists. Another row already holding the id is a conflict, never an overwrite. */
async function persistAccountId(creator: CreatorRow, accountId: string): Promise<void> {
  try {
    await prisma.creatorPayoutAccount.updateMany({
      where: { creatorId: creator.id, razorpayAccountId: null },
      data: { razorpayAccountId: accountId, setupStep: "account", lastError: null },
    });
  } catch (e) {
    if ((e as { code?: string })?.code === "P2002") {
      await releaseReservation(creator.id);
      await recordError(creator.id, encodeSetupError("ACCOUNT_CONFLICT"));
      staffAlert(`payout-conflict:${creator.id}`, "Creator payout account conflict", creator, [
        { label: "What happened", value: "Razorpay returned an account that another creator is already mapped to. Nothing was changed." },
      ]);
      throw new AppError(409, "ACCOUNT_CONFLICT", "We could not link your payout account. Our team has been told and will contact you.");
    }
    throw e;
  }
}

/**
 * The create call failed. Three cases:
 *  • Razorpay says an account with this email already exists ("Merchant email already exists for account
 *    acc_X" [R5]): ADOPT acc_X, but only when that account's email equals OUR verified email and no other
 *    creator row is mapped to it (the unique index backs this up). Anything else is a conflict for staff.
 *  • a definite refusal: the creator's details (or our configuration) were rejected, so the reservation is
 *    released and the creator is told what to fix;
 *  • an unknown outcome: the account may or may not exist. Nothing is retried here; the creator's next
 *    attempt sends the create again and gets the duplicate answer above if it did.
 */
async function adoptExistingAccount(creator: CreatorRow, e: unknown): Promise<string> {
  if (!(e instanceof RazorpayError)) throw e;
  if (e.existingAccountId) {
    const existingId = e.existingAccountId;
    let existing: Awaited<ReturnType<typeof fetchLinkedAccount>> | null = null;
    try {
      existing = await fetchLinkedAccount(existingId);
    } catch (e2) {
      // Razorpay named an account and then refused to show it to us: that is a conflict for staff. Anything
      // that is not a definite refusal (a timeout, a 5xx) is just an unknown outcome: the retry asks again.
      if (!(e2 instanceof RazorpayError) || !isDefinitelyRejected(e2)) return failStep(creator, "account", e2);
    }
    const sameEmail = existing?.email != null && existing.email.trim().toLowerCase() === creator.email.trim().toLowerCase();
    const heldByAnother = await prisma.creatorPayoutAccount.findFirst({ where: { razorpayAccountId: existingId, NOT: { creatorId: creator.id } }, select: { id: true } });
    if (existing && sameEmail && !heldByAnother) return existingId;
    await releaseReservation(creator.id);
    await recordError(creator.id, encodeSetupError("ACCOUNT_CONFLICT"));
    staffAlert(`payout-conflict:${creator.id}`, "Creator payout account conflict", creator, [
      { label: "What happened", value: "Razorpay already has an account under this email and it was NOT adopted." },
      { label: "Why", value: heldByAnother ? "Another creator is already mapped to it." : existing ? "Its email is not this creator's verified email." : "Razorpay would not show us the account." },
      { label: "Razorpay account", value: existingId },
    ]);
    throw new AppError(409, "ACCOUNT_CONFLICT", "We could not link your payout account. Our team has been told and will contact you.");
  }
  return failStep(creator, "account", e);
}

/**
 * Turn a failed Razorpay call into what the creator reads and what we record. Always throws.
 * ⚠️ Razorpay's text is NEVER passed on: it is read only to pick which field REFERENCES it was about
 * (referencesForRejection), and the creator gets our fixed wording plus the form fields to look at.
 */
async function failStep(creator: CreatorRow, step: StepName, e: unknown, ctx: { accountId?: string } = {}): Promise<never> {
  if (!(e instanceof RazorpayError)) throw e;
  if (e.code === "NOT_CONFIGURED") throw new AppError(503, "ROUTE_DISABLED", "Adding a bank account is not open yet.");

  if (isDefinitelyRejected(e)) {
    if (step === "account") await releaseReservation(creator.id);
    if (isConfigurationFailure(e)) {
      await recordError(creator.id, encodeSetupError("RAZORPAY_UNAVAILABLE"));
      staffAlert(`payout-config:${step}`, "Creator payout setup refused by Razorpay", creator, [
        { label: "Step", value: step },
        { label: "HTTP status", value: String(e.status) },
        { label: "What to check", value: "The Razorpay keys, and that Route and linked-account creation by API are enabled on our account (plan prerequisite 3)." },
      ]);
      throw new AppError(503, "PAYOUT_UNAVAILABLE", "Adding a bank account is temporarily unavailable. Our team has been told.");
    }
    if (step === "product") {
      // ⚠️ The product request carries NONE of the creator's details (only the product name and the terms
      // flag), so a definite refusal of it is never "your details are wrong". Most often the product exists
      // already (an earlier request whose answer or whose save was lost, or an account made in Razorpay's
      // dashboard that we adopted) and we hold no id for it; there is no way to look a product up by account.
      // That, and any other refusal, is a step for staff: the creator is not asked to retype anything.
      // It is recorded as PRODUCT_REFUSED, NOT as PRODUCT_UNKNOWN: Razorpay DID answer, so the creator's own
      // retry can never fix it. The view reads "failed" with nothing to correct (attention "contact_us"), and
      // the creator is told it is with our team instead of being invited to retype PAN and bank details only to
      // meet the same refusal (each press also spends one of the hourly attempts).
      await recordError(creator.id, encodeSetupError("PRODUCT_REFUSED"));
      staffAlert(`payout-product-manual:${creator.id}`, "Creator payout setup needs a manual step", creator, [
        { label: "What happened", value: `Razorpay refused to create the Route product (HTTP ${e.status}). Usually that means it already exists and we never received its id; it can also be another refusal.` },
        {
          label: "What to do",
          value:
            "Open the linked account in the Razorpay dashboard. If it has a Route product, set that product's id as razorpay_product_id on the creator's payout account row. " +
            "If the product is already activated, the next status poll marks the setup done by itself (usually within minutes, at most a day); if it is not activated yet, " +
            "tell the creator to try again and their next attempt finishes the setup. If the creator still cannot request a bank change afterwards, set setup_step to done. " +
            "If the account has no Route product, the HTTP status above is the lead.",
        },
        ...(ctx.accountId ? [{ label: "Razorpay account", value: ctx.accountId }] : []),
      ]);
      throw new AppError(409, "SETUP_NEEDS_TEAM", "Our team has been told and will finish setting up your payout account. There is no need to try again; we will email you.");
    }
    const text = `${e.message} ${e.reason ?? ""}`;
    let refs: string[];
    if (step === "bank") {
      // The bank call re-sends only the bank fields, so a rejection naming the PAN, phone or address cannot be
      // corrected from this form: those references are not offered back, and staff are told instead.
      const split = splitBankRejection(text);
      refs = split.references;
      if (split.ignored.length > 0) {
        staffAlert(`payout-bank-other:${creator.id}`, "Creator payout: Razorpay refused the bank step over another detail", creator, [
          { label: "Fields Razorpay named", value: split.ignored.join(", ") },
          { label: "Why you are told", value: "The creator cannot correct these from the bank form: it re-sends only the account number, IFSC and name." },
          { label: "What to do", value: "Look at the linked account in the Razorpay dashboard; the creator may need to write to us." },
        ]);
      }
    } else {
      refs = referencesForRejection(step, text);
    }
    const code = step === "bank" ? "BANK_DETAILS_REJECTED" : refs.includes("kyc.pan") ? "PAN_REJECTED" : "DETAILS_REJECTED";
    await recordError(creator.id, encodeSetupError(code, refs));
    const fields: PayoutFormField[] = [];
    for (const r of refs) {
      const f = formFieldForReference(r);
      if (f && !fields.includes(f)) fields.push(f);
    }
    throw new AppError(
      400,
      code,
      REJECTION_MESSAGE[code],
      fields.map((field) => ({ field, message: PAYOUT_FIELD_REJECTED[field] })),
    );
  }

  // Unknown outcome (timeout, 5xx, 409, 429, a 2xx we could not read).
  if (step === "account" || step === "product") {
    // The account or product may exist without our having its id. The retry is the check (see the header).
    await recordError(creator.id, encodeSetupError(step === "account" ? "ACCOUNT_UNKNOWN" : "PRODUCT_UNKNOWN"));
    staffAlert(`payout-uncertain:${creator.id}:${step}`, "Creator payout setup: outcome unknown", creator, [
      { label: "Step", value: step },
      { label: "What happened", value: "Razorpay did not give a readable answer, so we do not know whether it created the " + (step === "account" ? "linked account" : "Route product") + "." },
      { label: "What to do", value: "Nothing yet: the creator's next attempt re-sends it and Razorpay's duplicate check settles it. If it keeps failing, look in the Razorpay dashboard." },
    ]);
    throw new AppError(409, "SETUP_UNCERTAIN", "We could not confirm whether Razorpay finished setting up your payout account. Nothing has been lost. Please try again in a minute.");
  }
  await recordError(creator.id, encodeSetupError("RAZORPAY_UNAVAILABLE"));
  throw new AppError(503, "RAZORPAY_UNAVAILABLE", "Razorpay did not answer. Nothing has been lost. Please try again in a minute.");
}

// ── Changing the bank account ───────────────────────────────────────────────────────────────────

/**
 * Razorpay says a bank change needs a support request [R2 FAQ Q7], so this only RECORDS the request and
 * tells people; no Razorpay call is made. From the request until staff clear it (plus 72 hours), releases
 * for this creator are held back (bankChangeBlocksRelease). Idempotent: one pending request at a time.
 * Staff close a request in creator-admin.service.ts, the ONLY clearing paths: markBankChangeProcessed (the change was
 * carried out) or declineBankChange (closed without a change). Both share one compare-and-swap and write the audit
 * row; only the first tells the creator their payout account was updated. The cron digests requests still waiting
 * after 24 hours.
 */
export async function requestBankChange(creatorId: string): Promise<PayoutAccountResponse> {
  if (!creatorConfig.routeEnabled()) throw new AppError(503, "ROUTE_DISABLED", "Adding a bank account is not open yet.");
  const creator = await loadCreator(creatorId);
  const row = await prisma.creatorPayoutAccount.findUnique({ where: { creatorId } });
  if (!row || !row.razorpayAccountId || !setupIsDone(row)) {
    throw new AppError(409, "NO_PAYOUT_ACCOUNT", "Add your bank account first.");
  }
  if (!bankChangePending(row)) {
    const now = new Date();
    // One statement, so two clicks (or two tabs) record ONE request: it matches only while there is
    // no request or the last one has been cleared.
    const claimed = await prisma.$executeRaw`
      UPDATE creator_payout_accounts
         SET bank_change_requested_at = ${now}::timestamptz AT TIME ZONE 'UTC', updated_at = ${now}::timestamptz AT TIME ZONE 'UTC'
       WHERE id = ${row.id}
         AND (bank_change_requested_at IS NULL OR (bank_change_cleared_at IS NOT NULL AND bank_change_cleared_at >= bank_change_requested_at))`;
    if (claimed === 1) {
      staffAlert(`payout-bank-change:${creator.id}`, "Creator asked to change their bank account", creator, [
        { label: "Razorpay account", value: row.razorpayAccountId },
        { label: "What to do", value: "Raise the change with Razorpay support (the API cannot change a bank account), then mark it processed here. Releases for this creator are paused until you do, plus 72 hours. If it is not going ahead, close it without a change instead." },
      ]);
      void sendCreatorEmail(
        creator.email,
        "We received your bank change request",
        "Bank change requested",
        `<p>Hi ${esc(creator.name)},</p>` +
          `<p>We received your request to change your bank account. Razorpay handles the change through a support request, so our team will raise it and email you once it is done. ` +
          `Please do not send your new bank details by email.</p>` +
          `<p>Until the change is complete we hold back any payment that would be sent to you, so nothing goes to an account you are replacing.</p>`,
      ).catch((e) => safeLog("[creator-payout] bank change email failed", e));
    }
  }
  const after = await prisma.creatorPayoutAccount.findUnique({ where: { creatorId } });
  return buildResponse(creator, after);
}
