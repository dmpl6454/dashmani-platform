import { z } from "zod";
import { safeString } from "../utils/sanitize";

// Creator payouts, bank connect (docs/superpowers/plans/2026-10-12-creator-payouts-razorpay-route.md,
// Phase 2). Used by the API (input validation) and the creators app (form validation) — import by
// module path, never the @dashmani/shared barrel.
//
// ⚠️ PRIVACY. The body this file validates carries a creator's PAN, bank account number, IFSC,
// name and address. They pass through our server in memory to Razorpay and are NEVER stored,
// logged or returned. The two things in here that could leak them are the validation messages
// and the type-level names, so:
//   • EVERY check below has an explicit, generic message. Zod's defaults can quote the submitted
//     value (an enum failure reads "received 'xxx'"), and the validate middleware sends each
//     message back to the browser; a test submits marker values and proves none comes back.
//   • Unknown keys are stripped, never reported, so a stray field's name or value is not echoed.
// The CI guard `no-raw-payout-identifiers` allow-lists this file (it is where Razorpay's property
// names belong, together with services/campaign/razorpay.ts); the shared package itself is not
// scanned.

// ── Types the portal and the staff screen render (no values, only status) ───────────────────

/** What the creator sees of their payout account. Built by apps/api services/creator/payout-account-view.ts. */
export const PAYOUT_ACCOUNT_STATUSES = ["not_started", "setting_up", "under_review", "needs_clarification", "activated", "suspended", "failed"] as const;
export type PayoutAccountStatus = (typeof PAYOUT_ACCOUNT_STATUSES)[number];

/** The step bank connect is at: the NEXT call to make, or "done" when all four have succeeded. */
export const PAYOUT_SETUP_STEPS = ["account", "stakeholder", "product", "bank", "done"] as const;
export type PayoutSetupStep = (typeof PAYOUT_SETUP_STEPS)[number];

export interface PayoutRequirement {
  /** A Razorpay field reference (for example the one naming the IFSC), never a value the creator typed. */
  field: string;
  /** A Razorpay reason CODE (a short snake_case word), never free text. */
  reason: string;
}

/**
 * What a FAILED setup asks of the creator, so a screen never tells them to "correct the marked details"
 * when nothing is marked:
 *   fix_details  Razorpay refused specific details and `requirements` names them: correct those and send again;
 *   contact_us   nothing the creator can fix here (an account Razorpay already holds under their email, or a
 *                refusal that named no field): staff have been told and the creator should write to us.
 */
export type PayoutAttention = "fix_details" | "contact_us";

/**
 * How a bank change request that is no longer waiting ended: staff carried the change out ("processed"), or
 * closed the request WITHOUT a change ("declined": made by mistake, withdrawn, or no longer possible). Only the
 * first may ever be described as the payout account having been updated.
 */
export type BankChangeOutcome = "processed" | "declined";

export interface PayoutAccountView {
  status: PayoutAccountStatus;
  setupStep: PayoutSetupStep;
  /** Set only while status is "failed"; null otherwise. */
  attention: PayoutAttention | null;
  requirements: PayoutRequirement[];
  /** Masked, e.g. "HDFC ••••1234". The only trace of the bank account we keep. */
  destinationHint: string | null;
  activatedAt: string | null;
  /** Not offered for bookings before this (activated + 24h). */
  bookableAfter: string | null;
  /** `outcome` is null while a request is waiting (and when none was ever made). */
  bankChange: { requestedAt: string | null; clearedAt: string | null; outcome: BankChangeOutcome | null };
  termsVersion: string | null;
  updatedAt: string | null;
}

/**
 * Why a creator cannot set up bank connect right now. `terms_pending`: the feature is switched on, but the
 * creator terms in force are still the ones written before any payment existed, so it stays closed (the
 * portal shows it as not open yet) until the terms are rewritten and their version bumped.
 */
export type PayoutBlockedReason = "route_disabled" | "terms_pending" | "not_approved" | "email_not_verified" | "closed";

/** GET / PUT /v1/creator/payout-account answer with this. */
export interface PayoutAccountResponse {
  /** The creator terms version the form must send back as `termsVersion` (a mismatch is 409 TERMS_CHANGED). */
  termsVersion: string;
  routeEnabled: boolean;
  canSetUp: boolean;
  blockedReason: PayoutBlockedReason | null;
  account: PayoutAccountView | null;
}

// ── Indian states (Razorpay's own list) ──────────────────────────────────────────────────────

/**
 * The states Razorpay accepts for a linked account's address, spelled exactly as its docs list
 * them (create-linked-account, "supported Indian states"). Both spellings of the four "& / AND"
 * names are accepted; the UI offers PAYOUT_STATE_CHOICES.
 */
export const PAYOUT_STATES = [
  "ANDAMAN & NICOBAR ISLANDS",
  "ANDAMAN AND NICOBAR ISLANDS",
  "ANDHRA PRADESH",
  "ARUNACHAL PRADESH",
  "ASSAM",
  "BIHAR",
  "CHANDIGARH",
  "CHHATTISGARH",
  "DADRA & NAGAR HAVELI",
  "DADRA AND NAGAR HAVELI",
  "DAMAN & DIU",
  "DAMAN AND DIU",
  "DELHI",
  "GOA",
  "GUJARAT",
  "HARYANA",
  "HIMACHAL PRADESH",
  "JAMMU & KASHMIR",
  "JAMMU AND KASHMIR",
  "JHARKHAND",
  "KARNATAKA",
  "KERALA",
  "LAKSHADWEEP",
  "MADHYA PRADESH",
  "MAHARASHTRA",
  "MANIPUR",
  "MEGHALAYA",
  "MIZORAM",
  "NAGALAND",
  "ODISHA",
  "PONDICHERRY",
  "PUNJAB",
  "RAJASTHAN",
  "SIKKIM",
  "TAMIL NADU",
  "TRIPURA",
  "TELANGANA",
  "UTTAR PRADESH",
  "UTTARAKHAND",
  "WEST BENGAL",
] as const;
export type PayoutState = (typeof PAYOUT_STATES)[number];

/** The list a dropdown shows: one entry per state (the "AND" spelling where Razorpay lists both). */
export const PAYOUT_STATE_CHOICES: readonly PayoutState[] = PAYOUT_STATES.filter((s) => !s.includes(" & "));

// ── Normalisers (exported: the form shows the same shape the API will accept) ───────────────

/** Digits only. "+91 98100-00000" and "09810000000" both come out as the 10-digit national number. */
export function normalisePayoutPhone(raw: string): string {
  let d = raw.replace(/[^0-9]/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  else if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return d;
}

// ── Patterns ────────────────────────────────────────────────────────────────────────────────

/** An individual's PAN: five letters, four digits, a letter, and the 4th character is "P" [R6]. */
export const PAN_PATTERN = /^[A-Z]{3}P[A-Z][0-9]{4}[A-Z]$/;
/** Four letters, a zero, then six letters or digits. */
export const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;
/** The name as printed on a PAN card: English letters and spaces, with the odd dot, hyphen or apostrophe. */
const NAME_PATTERN = /^[A-Za-z][A-Za-z .'-]*$/;

const MSG = {
  fullName: "Enter your full name exactly as it is printed on your PAN card (English letters only)",
  pan: "Enter your PAN exactly as it is printed on the card",
  phone: "Enter a phone number of 8 to 15 digits",
  street: "Enter your street address",
  street2: "Keep this line under 100 characters",
  city: "Enter your city",
  state: "Choose your state from the list",
  postalCode: "Enter your 6-digit PIN code",
  accountNumber: "Enter your bank account number (5 to 20 characters)",
  ifsc: "Enter the IFSC code of your bank branch",
  terms: "Please accept the creator terms and Razorpay's terms to continue",
  termsVersion: "Reload the page and try again",
} as const;

const fullName = safeString
  .transform((s) => s.replace(/\s+/g, " "))
  .pipe(z.string().min(4, MSG.fullName).max(120, MSG.fullName).regex(NAME_PATTERN, MSG.fullName));

const pan = z
  .string({ invalid_type_error: MSG.pan, required_error: MSG.pan })
  .max(40, MSG.pan)
  .transform((s) => s.replace(/\s+/g, "").toUpperCase())
  .pipe(z.string().regex(PAN_PATTERN, MSG.pan));

const phone = z
  .string({ invalid_type_error: MSG.phone, required_error: MSG.phone })
  .max(40, MSG.phone)
  .transform(normalisePayoutPhone)
  .pipe(z.string().regex(/^[0-9]{8,15}$/, MSG.phone));

const state = z
  .string({ invalid_type_error: MSG.state, required_error: MSG.state })
  .max(60, MSG.state)
  .transform((s) => s.trim().replace(/\s+/g, " ").toUpperCase())
  // An enum's default message names the value it received, so it is replaced outright.
  .pipe(z.enum(PAYOUT_STATES, { errorMap: () => ({ message: MSG.state }) }));

const address = z.object({
  street1: safeString.pipe(z.string().min(3, MSG.street).max(100, MSG.street)),
  street2: safeString.pipe(z.string().max(100, MSG.street2)).optional(),
  city: safeString.pipe(z.string().min(2, MSG.city).max(100, MSG.city)),
  state,
  postalCode: z
    .string({ invalid_type_error: MSG.postalCode, required_error: MSG.postalCode })
    .max(20, MSG.postalCode)
    .transform((s) => s.replace(/\s+/g, ""))
    .pipe(z.string().regex(/^[1-9][0-9]{5}$/, MSG.postalCode)),
});

const accountNumber = z
  .string({ invalid_type_error: MSG.accountNumber, required_error: MSG.accountNumber })
  .max(60, MSG.accountNumber)
  .transform((s) => s.replace(/[\s-]/g, "").toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9]{5,20}$/, MSG.accountNumber));

const ifsc = z
  .string({ invalid_type_error: MSG.ifsc, required_error: MSG.ifsc })
  .max(40, MSG.ifsc)
  .transform((s) => s.replace(/\s+/g, "").toUpperCase())
  .pipe(z.string().regex(IFSC_PATTERN, MSG.ifsc));

/**
 * PUT /v1/creator/payout-account. Sensitive fields are required again on every call: we keep
 * none of them, so a resumed setup needs them once more.
 */
export const creatorPayoutAccountSchema = z.object({
  /** Exactly as on the PAN; also sent as the bank beneficiary name. */
  fullName,
  pan,
  phone,
  address,
  accountNumber,
  ifsc,
  acceptTerms: z.literal(true, { errorMap: () => ({ message: MSG.terms }) }),
  /** Must equal the creator terms version the API is serving (checked in the service: 409 TERMS_CHANGED). */
  termsVersion: z.string({ invalid_type_error: MSG.termsVersion, required_error: MSG.termsVersion }).min(1, MSG.termsVersion).max(16, MSG.termsVersion),
});

export type CreatorPayoutAccountInput = z.infer<typeof creatorPayoutAccountSchema>;

// ── Form fields and Razorpay references ─────────────────────────────────────────────────────

/** The fields of the bank-connect form, by the names the schema uses ("address.city" is nested). */
export const PAYOUT_FORM_FIELDS = [
  "fullName",
  "pan",
  "phone",
  "address.street1",
  "address.street2",
  "address.city",
  "address.state",
  "address.postalCode",
  "accountNumber",
  "ifsc",
] as const;
export type PayoutFormField = (typeof PAYOUT_FORM_FIELDS)[number];

/** What the creator reads next to a field Razorpay refused: our wording, never Razorpay's and never the value. */
export const PAYOUT_FIELD_REJECTED: Record<PayoutFormField, string> = {
  fullName: "Razorpay did not accept this name",
  pan: "Razorpay did not accept this PAN",
  phone: "Razorpay did not accept this phone number",
  "address.street1": "Razorpay did not accept this address",
  "address.street2": "Razorpay did not accept this address",
  "address.city": "Razorpay did not accept this city",
  "address.state": "Razorpay did not accept this state",
  "address.postalCode": "Razorpay did not accept this PIN code",
  accountNumber: "Razorpay did not accept this account number",
  ifsc: "Razorpay did not accept this IFSC code",
};

/**
 * The form field a Razorpay requirement reference (or error keyword) is about, so a screen can
 * mark the right input. Matching is by keyword on the lower-cased reference, because Razorpay's
 * documents spell the same reference more than one way. Null for a reference the creator cannot
 * edit here (the account email, anything unknown).
 */
export function formFieldForReference(reference: string): PayoutFormField | null {
  const r = typeof reference === "string" ? reference.toLowerCase() : "";
  if (r.includes("ifsc")) return "ifsc";
  if (r.includes("account_number") || r.includes("account number") || r.includes("bank account")) return "accountNumber";
  if (r.includes("beneficiary")) return "fullName";
  if (/(^|[^a-z])pan([^a-z]|$)/.test(r)) return "pan";
  if (r.includes("postal") || r.includes("pincode") || r.includes("pin code")) return "address.postalCode";
  if (r.includes("state")) return "address.state";
  if (r.includes("city")) return "address.city";
  if (r.includes("street2")) return "address.street2";
  if (r.includes("street")) return "address.street1";
  if (r.includes("phone") || r.includes("contact_number")) return "phone";
  if (r.includes("name")) return "fullName";
  return null;
}

/**
 * Which Razorpay references a DEFINITE rejection is about, judged from keywords in its text
 * (the caller passes the already-scrubbed message, and only the references come back, never the
 * text). `step` is the bank-connect call that was refused; when the text names nothing we know,
 * the references of that step's own fields are returned, so the creator is always pointed at
 * something to correct. Pure.
 */
export function referencesForRejection(step: "account" | "stakeholder" | "product" | "bank", text: string): string[] {
  const t = typeof text === "string" ? text.toLowerCase() : "";
  const found: string[] = [];
  const add = (ref: string) => {
    if (!found.includes(ref)) found.push(ref);
  };
  if (t.includes("ifsc")) add("settlements.ifsc_code");
  if (t.includes("account number") || t.includes("bank account")) add("settlements.account_number");
  if (t.includes("beneficiary")) add("settlements.beneficiary_name");
  if (/(^|[^a-z])pan([^a-z]|$)/.test(t)) add("kyc.pan");
  if (t.includes("phone")) add("phone");
  if (t.includes("postal") || t.includes("pincode") || t.includes("pin code")) add("address.postal_code");
  if (/(^|[^a-z])state([^a-z]|$)/.test(t)) add("address.state");
  if (t.includes("city")) add("address.city");
  if (t.includes("street")) add("address.street");
  if (found.length > 0) return found;
  if (t.includes("name")) return step === "bank" ? ["settlements.beneficiary_name"] : ["legal_business_name"];
  switch (step) {
    case "bank":
      return ["settlements.account_number", "settlements.ifsc_code", "settlements.beneficiary_name"];
    case "stakeholder":
      return ["kyc.pan"];
    case "account":
      return ["legal_business_name", "phone", "address.street"];
    default:
      return [];
  }
}

/**
 * A bank-step rejection, split into what the next attempt can actually change and what it cannot. The bank
 * call re-sends ONLY the account number, IFSC and name, never the PAN, phone or address (those went with
 * the earlier calls and are not repeated on a resume), so a correction to them would be asked for and then
 * silently ignored. `references` are the bank references (the three bank fields when the text named none);
 * `ignored` are the other references the text named, which the creator cannot fix from this form: staff
 * are told about them instead. Pure.
 */
export function splitBankRejection(text: string): { references: string[]; ignored: string[] } {
  const all = referencesForRejection("bank", text);
  const bank = all.filter((r) => r.startsWith("settlements."));
  return {
    references: bank.length > 0 ? bank : referencesForRejection("bank", ""),
    ignored: all.filter((r) => !r.startsWith("settlements.")),
  };
}
