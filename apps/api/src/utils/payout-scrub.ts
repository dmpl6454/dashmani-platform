/**
 * Masks bank and tax identifiers in text and objects that are about to be thrown, logged or
 * stored.
 *
 * ⚠️ WHY THIS EXISTS. Creator payouts send a creator's PAN, bank account number and IFSC to
 * Razorpay, and Razorpay echoes them back: the linked-account response carries `legal_info.pan`,
 * the stakeholder response `kyc.pan`, and the product response the full settlement account
 * number. Validation errors can quote a submitted value too. The plan's rule is "we store no
 * PAN and no account number, anywhere", and the places such a value leaks are not the happy
 * path: an `Error.message` that ends up in `console.error`, a `last_error` column, an audit
 * row. Everything that crosses those boundaries goes through here first.
 *
 * What gets masked (all case-insensitive, all replaced by `[redacted]`):
 *   1. IFSC-shaped tokens: 4 letters, a zero, 6 letters or digits (11 characters).
 *   2. PAN-shaped tokens: 5 letters, 4 digits, 1 letter (10 characters).
 *   3. Any run of 5 or more digits. Razorpay accepts account numbers of 5 to 20 digits; a
 *      longer run cannot be an account number but is masked whole rather than left half
 *      visible. Digit groups joined by a single space or hyphen count as one run, because
 *      account numbers are often typed "1234 5678 9012".
 * IFSC and PAN are masked BEFORE the digit rule, so "HDFC0000317" is replaced whole instead of
 * leaving the bank code behind a masked tail.
 *
 * ⚠️ THE TRADE-OFF, DELIBERATE. Rule 3 cannot tell an account number from an amount. Any
 * paise figure of 10000 or more (₹100 and up), an epoch timestamp, or an ISO date such as
 * 2026-10-12 inside a scrubbed STRING is masked too. Callers must therefore keep amounts and
 * ids in structured fields (columns, log fields) and scrub only the free text around them.
 * Numbers in `scrubPayoutObject` are left alone unless their key names a payout secret,
 * because money fields there are the whole point of the record.
 *
 * Linear time, no backtracking: the PAN and IFSC patterns have a fixed width (at most 11
 * characters tried per start position) and the digit pass is a hand-written scanner, so a
 * 200 KB hostile string costs about a millisecond. No regex lookbehind either: it throws at
 * parse time on older iOS Safari, and this file may one day be shared with browser code.
 */

export const REDACTED = "[redacted]";

// Fixed-width and anchored on literal classes only, so the worst case is O(11 × n).
const IFSC_RE = /[A-Za-z]{4}0[A-Za-z0-9]{6}/g;
const PAN_RE = /[A-Za-z]{5}[0-9]{4}[A-Za-z]/g;

const MIN_MASKED_DIGITS = 5;

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

/**
 * Replaces every run of MIN_MASKED_DIGITS or more digits, where digit groups joined by ONE
 * space or hyphen belong to the same run. Single pass, so it is linear however hostile the
 * input is ("1 1 1 1 …" collapses into one mask, it does not restart at every digit).
 */
function maskDigitRuns(text: string): string {
  const n = text.length;
  const out: string[] = [];
  let copiedTo = 0;
  let i = 0;
  while (i < n) {
    if (!isDigit(text.charCodeAt(i))) {
      i++;
      continue;
    }
    // A candidate run starts at i. `end` is the index just after its last digit.
    let j = i;
    let end = i;
    let digits = 0;
    while (j < n) {
      const c = text.charCodeAt(j);
      if (isDigit(c)) {
        digits++;
        j++;
        end = j;
      } else if ((c === 32 || c === 45) && j + 1 < n && isDigit(text.charCodeAt(j + 1))) {
        j++; // one separator, and only when a digit follows it
      } else {
        break;
      }
    }
    if (digits >= MIN_MASKED_DIGITS) {
      out.push(text.slice(copiedTo, i), REDACTED);
      copiedTo = end;
    }
    i = end; // end > i always, so the scan always advances
  }
  out.push(text.slice(copiedTo));
  return out.join("");
}

/** Masks PAN-, IFSC- and account-number-shaped text. Idempotent. */
export function scrubPayoutSecrets(text: string): string {
  if (typeof text !== "string") return "";
  if (text.length === 0) return text;
  return maskDigitRuns(text.replace(IFSC_RE, REDACTED).replace(PAN_RE, REDACTED));
}

// ── Objects ─────────────────────────────────────────────────────────────────────

/** JSON-safe result of scrubPayoutObject. */
export type Scrubbed = string | number | boolean | null | Scrubbed[] | { [key: string]: Scrubbed };

/**
 * Property names whose VALUE is a payout secret or personal detail whatever it looks like
 * (a number typed into the wrong field, a name, a street). Compared after lower-casing and
 * dropping every non-alphanumeric, so `account_number`, `accountNumber` and `Account-Number`
 * are one key.
 */
const SENSITIVE_KEYS = new Set([
  "pan",
  "accountnumber",
  "accountno",
  "bankaccount",
  "ifsc",
  "ifsccode",
  "beneficiaryname",
  "legalbusinessname",
  "contactname",
  "street",
  "street1",
  "street2",
  "postalcode",
  "phone",
]);

function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// A payload is a few dozen fields; these bounds only stop a pathological or cyclic object from
// turning a log call into a hang.
const MAX_DEPTH = 8;
const MAX_NODES = 5000;

/**
 * Deep copy of `value` that is safe to log or store as JSON: every string is passed through
 * scrubPayoutSecrets (keys too), the value of a sensitive key is replaced outright, Errors
 * keep only name, message and code, and anything that is not plain JSON data (functions,
 * symbols, undefined) is dropped. Never mutates the input.
 */
export function scrubPayoutObject(value: unknown): Scrubbed {
  const budget = { nodes: 0 };
  const seen = new WeakSet<object>();
  return walk(value, 0, budget, seen);
}

function walk(value: unknown, depth: number, budget: { nodes: number }, seen: WeakSet<object>): Scrubbed {
  if (++budget.nodes > MAX_NODES) return "[truncated]";
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case "string":
      return scrubPayoutSecrets(value);
    case "number":
      return Number.isFinite(value) ? value : null;
    case "boolean":
      return value;
    case "bigint":
      return scrubPayoutSecrets(value.toString());
    case "function":
    case "symbol":
      return null;
  }
  const obj = value as object;
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (seen.has(obj)) return "[circular]";
  seen.add(obj);
  try {
    if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? null : obj.toISOString();
    if (obj instanceof Error) {
      const e = obj as Error & { code?: unknown; status?: unknown };
      const out: { [key: string]: Scrubbed } = { name: scrubPayoutSecrets(String(e.name)), message: scrubPayoutSecrets(String(e.message)) };
      if (typeof e.code === "string") out.code = scrubPayoutSecrets(e.code);
      if (typeof e.status === "number") out.status = e.status;
      return out;
    }
    if (Array.isArray(obj)) return obj.map((v) => walk(v, depth + 1, budget, seen));
    if (ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer) return "[binary]";
    const entries: Array<[string, Scrubbed]> = [];
    for (const key of Object.keys(obj)) {
      const v = (obj as Record<string, unknown>)[key];
      if (typeof v === "function" || typeof v === "symbol" || v === undefined) continue;
      const safeKey = scrubPayoutSecrets(key);
      entries.push([safeKey, SENSITIVE_KEYS.has(normaliseKey(key)) && v !== null ? REDACTED : walk(v, depth + 1, budget, seen)]);
    }
    // fromEntries defines own properties, so a key called "__proto__" cannot swap the prototype.
    return Object.fromEntries(entries);
  } finally {
    seen.delete(obj); // only an ancestor is a cycle; the same object twice in siblings is fine
  }
}

// ── Masked hints ────────────────────────────────────────────────────────────────

/**
 * The last four digits of an account number, or null when fewer than four digits can be read.
 * Takes digits only, so "XXXX1234" (already masked) and "1234 5678 9012 3456" both work.
 * ⚠️ A NUMBER beyond 2^53 has already lost its low digits by the time JSON.parse hands it over
 * (Razorpay's sample echoes the account number as a bare number), so an unsafe integer
 * returns null instead of a confident wrong hint.
 */
export function lastFour(accountNumber: unknown): string | null {
  let digits: string;
  if (typeof accountNumber === "number") {
    if (!Number.isSafeInteger(accountNumber) || accountNumber < 0) return null;
    digits = String(accountNumber);
  } else if (typeof accountNumber === "string") {
    digits = accountNumber.replace(/[^0-9]/g, "");
  } else {
    return null;
  }
  return digits.length >= 4 ? digits.slice(-4) : null;
}

/**
 * "HDFC ••••1234": the bank code (the first four letters of the IFSC) and the last four digits.
 * Neither is secret on its own and together they are what the creator and staff recognise.
 * Null when there are no four digits to show; the bank code alone is dropped when the IFSC
 * does not start with four letters.
 */
export function destinationHint(ifsc: unknown, accountNumber: unknown): string | null {
  const last = lastFour(accountNumber);
  if (!last) return null;
  const bank = typeof ifsc === "string" && /^[A-Za-z]{4}/.test(ifsc.trim()) ? ifsc.trim().slice(0, 4).toUpperCase() : "";
  return `${bank ? `${bank} ` : ""}••••${last}`;
}
