// The reconcile page (sales.digitalsukoon.com/reconcile, spec-reconcile.md): Form 26AS vs the TDS
// on receipts, GSTR-1 vs the documents issued, and client balance confirmations. Pure — no I/O, no
// clock (callers pass "today"). Money is integer PAISE. Import BY PATH from the portal
// ("@dashmani/shared/src/sales/recon"); the API gets it through the barrel. No zod here.

// ─── Limits and constants (spec §9) ──────────────────────────────────────────────────────────

/** ±₹1: only IDENTIFIES a match (one rupee of rounding per document); every shown difference is exact. */
export const RECON_TOLERANCE_PAISE = 100;
/** Largest 26AS / GSTR-1 / reply file read, in bytes (10 MiB). */
export const RECON_MAX_BYTES = 10 * 1024 * 1024;
/** Entries / documents per uploaded file, and documents per books read. */
export const RECON_MAX_ROWS = 20_000;
/** Confirmations emailed per click. */
export const RECON_BATCH_MAX = 25;
/** A sent confirmation with no reply after this many days is overdue. */
export const CONFIRM_OVERDUE_DAYS = 15;
/** A queued send older than this many minutes is stuck (the process restarted mid-batch). */
export const CONFIRM_STUCK_MINUTES = 10;

/**
 * When a quarter's TDS shows in Form 26AS: the TDS return due date (31 Jul / 31 Oct / 31 Jan /
 * 31 May) plus 15 days for processing. Month-day pairs; Q3's and Q4's fall in the next calendar year.
 */
export const TDS_26AS_EXPECTED_BY: Record<1 | 2 | 3 | 4, { month: number; day: number; nextYear: boolean }> = {
  1: { month: 8, day: 15, nextYear: false },
  2: { month: 11, day: 15, nextYear: false },
  3: { month: 2, day: 15, nextYear: true },
  4: { month: 6, day: 15, nextYear: true },
};

/** The day by which quarter q of FY "2025-26" is expected in 26AS ("2026-06-15" for Q4). */
export function tdsExpectedBy(fy: string, q: 1 | 2 | 3 | 4): string {
  const y = Number(fy.slice(0, 4));
  const e = TDS_26AS_EXPECTED_BY[q];
  return `${e.nextYear ? y + 1 : y}-${String(e.month).padStart(2, "0")}-${String(e.day).padStart(2, "0")}`;
}

/** The paragraph a balance-confirmation PDF asks the client to answer (the CA may edit it). */
export const CONFIRMATION_REQUEST_TEXT =
  "Please confirm the balance above as on {asOf}, or tell us your figure and the entries that differ, by replying to {replyTo} within 15 days. " +
  "This is a request for confirmation of balance for our records and our auditors; it is not a demand for payment.";

// ─── Normalisation (§4.7) ────────────────────────────────────────────────────────────────────

/**
 * Three keys of a document number. key0 = the legal identity (CGST rule 46): NFKC, a leading "'"
 * dropped (Excel's text marker), upper-case, whitespace removed. key1 = the owner's rule: leading
 * zeros of every digit run removed ("0000" → "0"). key2 = key1 without "/" and "-". No key is ever
 * compared across GSTINs — the caller scopes the books to one registration.
 */
export function normaliseDocNumber(n: string): { key0: string; key1: string; key2: string } {
  let s = (n ?? "").normalize("NFKC").trim();
  if (s.startsWith("'")) s = s.slice(1);
  const key0 = s.toUpperCase().replace(/\s+/g, "");
  const key1 = key0.replace(/\d+/g, (run) => run.replace(/^0+(?=\d)/, ""));
  const key2 = key1.replace(/[/-]/g, "");
  return { key0, key1, key2 };
}

const LEGAL_NOISE = new Set(["PRIVATE", "PVT", "LIMITED", "LTD", "LLP", "LLC", "THE", "CO", "COMPANY", "INC", "CORP", "CORPORATION", "M", "S", "MS"]);

/**
 * A company's name for equality only: "Filmy Brands Pvt. Ltd." = "FILMY BRANDS PRIVATE LIMITED" =
 * "FILMYBRANDS". "&" → AND, "M/S" dropped, the legal-form words dropped; INDIA is kept (a
 * subsidiary is not its parent). Deliberately not import's normaliseParty (spec §4.7).
 */
export function normaliseLegalName(s: string): string {
  const up = (s ?? "").normalize("NFKC").toUpperCase().replace(/&/g, " AND ").replace(/\bM\/S\.?/g, " ");
  return up
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((t) => t && !LEGAL_NOISE.has(t))
    .join("");
}

// ─── Reasons (I4: every non-matched row carries a code with a sentence) ──────────────────────

export type TdsGroup = "chase" | "link_first" | "extra" | "unknown" | "non_sales" | "status_p" | "not_due" | "next_year" | "matched";
export const TDS_GROUPS: readonly TdsGroup[] = ["chase", "link_first", "extra", "unknown", "status_p", "not_due", "next_year", "non_sales", "matched"];

export type GstStatus = "matched" | "matched_note" | "value_mismatch" | "wrong_recipient" | "wrong_period" | "not_filed" | "not_in_books" | "cancelled_but_filed";
/** Row order on the page: the worst first, matches last. */
export const GST_STATUS_ORDER: readonly GstStatus[] = ["cancelled_but_filed", "wrong_recipient", "value_mismatch", "wrong_period", "not_filed", "not_in_books", "matched_note", "matched"];

export type ReconReasonCode =
  // TDS
  | "not_in_26as" | "short" | "status_U" | "status_O" | "status_P" | "status_other" | "short_deposited"
  | "extra" | "unknown" | "non_sales" | "not_due" | "next_year" | "link_first" | "matched" | "matched_split"
  // GST
  | "matched_note" | "value_mismatch" | "wrong_recipient" | "wrong_period" | "not_filed" | "not_in_books" | "cancelled_but_filed";

/** The general sentence and the action for each reason; rows add their own figures. */
export const RECON_REASONS: Record<ReconReasonCode, { text: string; action: string | null }> = {
  not_in_26as: { text: "TDS deducted by the client is not in our Form 26AS.", action: "Ask the client to deposit it and file or revise their TDS return with our PAN." },
  short: { text: "Form 26AS shows less TDS than our receipts.", action: "Ask the client to revise their TDS return for the difference, or pay it to us." },
  status_U: { text: "Deducted, but the deposit is not matched to the client's return (status U).", action: "Ask the client to correct the challan details in their TDS return." },
  status_O: { text: "The client's return claims more than they deposited (status O).", action: "Ask the client to pay the difference or correct the return." },
  status_P: { text: "Provisional — a government deductor's entry, usually clears itself.", action: null },
  status_other: { text: "Form 26AS shows a booking status other than F, U, P or O.", action: "Check the entry on TRACES." },
  short_deposited: { text: "The client deposited less than they deducted.", action: "Ask the client to pay the difference — it is not credited to us until they do." },
  extra: { text: "Form 26AS shows TDS that no receipt in the portal carries.", action: "Record the payment with its TDS, or import the Swipe invoice if it is older." },
  unknown: { text: "A deductor in Form 26AS is not linked to a client.", action: "Say which client this is, or mark it as not a sales client." },
  non_sales: { text: "Not sales money (bank interest, rent) — shown, never chased.", action: null },
  not_due: { text: "The client's TDS return for this quarter is not due in 26AS yet.", action: null },
  next_year: { text: "Paid in the next financial year — the client may have deducted on payment.", action: "Check next year's Form 26AS." },
  link_first: { text: "26AS has entries from a deductor not linked yet that may be this client's.", action: "Link the deductor first." },
  matched: { text: "Form 26AS agrees with our receipts.", action: null },
  matched_split: { text: "Same total for the quarter, split differently.", action: null },
  matched_note: { text: "Filed with the number written differently.", action: null },
  value_mismatch: { text: "The filed figures differ from the invoice.", action: "Amend it in the next GSTR-1 (Table 9A), or issue a credit note if the portal is wrong." },
  wrong_recipient: { text: "Filed against a different recipient GSTIN.", action: "Amend the recipient GSTIN in the next GSTR-1 (Table 9A)." },
  wrong_period: { text: "Filed in a different month's GSTR-1.", action: "Nothing to file again — note it for the annual return." },
  not_filed: { text: "Issued in the portal but not in the filed GSTR-1.", action: "Report it in the next GSTR-1 (Table 4A / 9B); interest may apply." },
  not_in_books: { text: "Filed in GSTR-1 but not in the portal.", action: "Find out who issued it; if it is an old Swipe invoice, import it." },
  cancelled_but_filed: { text: "Cancelled in the portal but filed in GSTR-1.", action: "Issue a credit note or amend it to nil in the next GSTR-1." },
};

// ─── Small formatting helpers shared by the API sentences and the portal ─────────────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

/** "2026-10-14" → "14 Oct 2026". */
export function reconDay(day: string | null | undefined): string {
  if (!day) return "—";
  return `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;
}
/** "2026-10-14" → "14 October 2026". */
export function reconDayLong(day: string): string {
  return `${Number(day.slice(8, 10))} ${MONTHS_LONG[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;
}

/** Whole days from a to b (YYYY-MM-DD), b − a. */
export function dayDiff(a: string, b: string): number {
  return Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 86_400_000);
}
/** a + n days (YYYY-MM-DD). */
export function dayAdd(day: string, n: number): string {
  return new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)) + n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * A balance typed from a BANK statement with its side. Banks print an in-funds balance as "… Cr"
 * and an overdraft as "… Dr", so Cr → positive, Dr → negative (the opposite of a client ledger).
 */
export function bankBalanceFromSide(amountPaise: number, side: "Cr" | "Dr"): number {
  const a = Math.abs(amountPaise);
  return side === "Dr" ? -a : a;
}

/** "₹1,23,456.78" — exact, Indian grouping; negatives "−₹…". */
export function reconInr(paise: number): string {
  const neg = paise < 0;
  const abs = Math.abs(paise);
  const whole = String(Math.floor(abs / 100));
  const last3 = whole.slice(-3);
  let rest = whole.slice(0, -3);
  const groups: string[] = [];
  while (rest.length > 2) { groups.unshift(rest.slice(-2)); rest = rest.slice(0, -2); }
  if (rest) groups.unshift(rest);
  const g = groups.length ? `${groups.join(",")},${last3}` : last3;
  return `${neg ? "−" : ""}₹${g}.${String(abs % 100).padStart(2, "0")}`;
}

/** The "as of" date a balance confirmation defaults to: 31 March of the last closed FY from April to June, else the last day of the previous month. */
export function defaultAsOf(today: string): string {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  if (m >= 4 && m <= 6) return `${y}-03-31`;
  const first = `${today.slice(0, 7)}-01`;
  return dayAdd(first, -1);
}

/** 1 April of the FY a day falls in. */
export function fyStartOf(day: string): string {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  return `${m >= 4 ? y : y - 1}-04-01`;
}
