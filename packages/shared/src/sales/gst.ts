// GST arithmetic, financial years, document numbers and amounts in words for the sales portal.
// Pure functions shared by the API (the source of truth at issue time) and the portal (live
// totals while a quote is being built). Import BY PATH from the frontends
// ("@dashmani/shared/src/sales/gst"), never through the barrel. Money is integer PAISE.

export type TaxMode = "intra" | "inter" | "none";
export const TAX_MODES: readonly TaxMode[] = ["intra", "inter", "none"];
export const TAX_MODE_LABELS: Record<TaxMode, string> = {
  intra: "CGST + SGST (same state)",
  inter: "IGST (other state)",
  none: "No GST (export / SEZ)",
};

/** SAC for the sale of internet advertising space — what a placement on our channels is. */
export const DEFAULT_SAC = "998365";
export const DEFAULT_GST_RATE_BP = 1800;

/** Indian financial year (April–March) of a YYYY-MM-DD day: "2026-27", short "26-27". */
export function financialYear(day: string): { label: string; short: string; startDay: string; endDay: string } {
  const [y, m] = day.split("-").map(Number);
  const startYear = m >= 4 ? y : y - 1;
  const endYear = startYear + 1;
  return {
    label: `${startYear}-${String(endYear).slice(2)}`,
    short: `${String(startYear).slice(2)}-${String(endYear).slice(2)}`,
    startDay: `${startYear}-04-01`,
    endDay: `${endYear}-03-31`,
  };
}

/** "DS/26-27/0001" — prefix, FY short form, 4-digit serial (grows past 9999 without truncation). */
export function documentNumber(prefix: string, fyLabel: string, serial: number): string {
  const short = fyLabel.length === 7 ? `${fyLabel.slice(2, 4)}-${fyLabel.slice(5)}` : fyLabel;
  return `${prefix}/${short}/${String(serial).padStart(4, "0")}`;
}

/**
 * CGST+SGST when the buyer is in the seller's state, IGST otherwise, no GST when the buyer is
 * outside India (export of services — the document says so). Unknown buyer state → inter, the
 * conservative default that never under-collects; staff can override on the document.
 */
export function taxModeFor(sellerStateCode: string | null | undefined, buyerStateCode: string | null | undefined, buyerCountry = "IN"): TaxMode {
  if (buyerCountry && buyerCountry.toUpperCase() !== "IN") return "none";
  if (!sellerStateCode || !buyerStateCode) return "inter";
  return sellerStateCode === buyerStateCode ? "intra" : "inter";
}

export interface LineLike {
  quantity: number;
  unitPricePaise: number;
  discountPaise?: number | null;
}

/** qty × unit − line discount, never below zero. */
export function lineAmountPaise(line: LineLike): number {
  return Math.max(0, line.quantity * line.unitPricePaise - (line.discountPaise ?? 0));
}

export interface DocumentTotals {
  subtotalPaise: number;
  discountPaise: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  taxPaise: number;
  roundOffPaise: number;
  totalPaise: number;
}

/**
 * Document totals. One GST rate per document (every line here is the same service, SAC
 * 998365). Halves for CGST/SGST are rounded identically so they never differ by a paisa.
 * `roundToRupee` adds the customary round-off line so the payable amount is whole rupees.
 */
export function computeTotals(input: {
  lines: LineLike[];
  discountPaise?: number | null;
  taxMode: TaxMode;
  gstRateBp: number;
  roundToRupee?: boolean;
}): DocumentTotals {
  const subtotalPaise = input.lines.reduce((s, l) => s + lineAmountPaise(l), 0);
  const discountPaise = Math.min(Math.max(0, input.discountPaise ?? 0), subtotalPaise);
  const taxablePaise = subtotalPaise - discountPaise;
  let cgstPaise = 0;
  let sgstPaise = 0;
  let igstPaise = 0;
  if (input.taxMode === "intra") {
    cgstPaise = Math.round((taxablePaise * input.gstRateBp) / 20_000);
    sgstPaise = cgstPaise;
  } else if (input.taxMode === "inter") {
    igstPaise = Math.round((taxablePaise * input.gstRateBp) / 10_000);
  }
  const taxPaise = cgstPaise + sgstPaise + igstPaise;
  const exact = taxablePaise + taxPaise;
  const totalPaise = input.roundToRupee === false ? exact : Math.round(exact / 100) * 100;
  return {
    subtotalPaise,
    discountPaise,
    taxablePaise,
    cgstPaise,
    sgstPaise,
    igstPaise,
    taxPaise,
    roundOffPaise: totalPaise - exact,
    totalPaise,
  };
}

// ── Amount in words (Indian system: crore, lakh, thousand) ───────────────────────

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function below100(n: number): string {
  if (n < 20) return ONES[n];
  return `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ""}`;
}

function below1000(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return `${h ? `${ONES[h]} Hundred` : ""}${h && r ? " " : ""}${r ? below100(r) : ""}`;
}

/** Whole number → words, Indian grouping. 1234567 → "Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven". */
export function numberInWords(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n === 0) return "Zero";
  const parts: string[] = [];
  const crore = Math.floor(n / 1e7);
  if (crore) parts.push(`${numberInWords(crore)} Crore`);
  n %= 1e7;
  const lakh = Math.floor(n / 1e5);
  if (lakh) parts.push(`${below100(lakh)} Lakh`);
  n %= 1e5;
  const thousand = Math.floor(n / 1000);
  if (thousand) parts.push(`${below100(thousand)} Thousand`);
  n %= 1000;
  if (n) parts.push(below1000(n));
  return parts.join(" ");
}

/** "Rupees Twelve Thousand Three Hundred and Paise Forty Five Only" — as printed on an invoice. */
export function rupeesInWords(paise: number): string {
  const rupees = Math.floor(Math.abs(paise) / 100);
  const p = Math.abs(paise) % 100;
  const sign = paise < 0 ? "Minus " : "";
  return `${sign}Rupees ${numberInWords(rupees)}${p ? ` and Paise ${numberInWords(p)}` : ""} Only`;
}

/** GST state codes → state names (the two-digit prefix of every GSTIN). */
export const GST_STATE_CODES: Record<string, string> = {
  "01": "Jammu & Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh", "05": "Uttarakhand",
  "06": "Haryana", "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim",
  "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur", "15": "Mizoram", "16": "Tripura", "17": "Meghalaya",
  "18": "Assam", "19": "West Bengal", "20": "Jharkhand", "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh",
  "24": "Gujarat", "26": "Dadra & Nagar Haveli and Daman & Diu", "27": "Maharashtra", "29": "Karnataka", "30": "Goa",
  "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry", "35": "Andaman & Nicobar Islands",
  "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh", "97": "Other Territory",
};

/** The state code inside a GSTIN (its first two digits), or null. */
export function stateCodeFromGstin(gstin: string | null | undefined): string | null {
  const m = gstin?.trim().toUpperCase().match(/^(\d{2})[0-9A-Z]{13}$/);
  return m ? m[1] : null;
}

/** One GST registration of the seller (the principal one, or an additional state registration). */
export interface SellerRegistration {
  label: string;
  gstin: string | null;
  stateCode: string | null;
  state: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  pincode: string | null;
  invoicePrefix: string;
  creditNotePrefix: string;
  /** Numbering scope: null for the principal registration (its series keys stay as they were), the GSTIN otherwise. */
  scope: string | null;
}

type SellerLike = {
  gstin?: string | null; stateCode?: string | null; state?: string | null; addressLine1?: string | null; addressLine2?: string | null;
  city?: string | null; pincode?: string | null; invoicePrefix: string; creditNotePrefix: string;
  branches?: Array<{ label: string; gstin: string; stateCode?: string | null; state?: string | null; addressLine1?: string | null; addressLine2?: string | null; city?: string | null; pincode?: string | null; invoicePrefix: string; creditNotePrefix: string }> | null;
};

function principal(s: SellerLike): SellerRegistration {
  return {
    label: "Principal", gstin: s.gstin ?? null, stateCode: s.stateCode ?? null, state: s.state ?? null, addressLine1: s.addressLine1 ?? null,
    addressLine2: s.addressLine2 ?? null, city: s.city ?? null, pincode: s.pincode ?? null, invoicePrefix: s.invoicePrefix, creditNotePrefix: s.creditNotePrefix, scope: null,
  };
}

function branchReg(b: NonNullable<SellerLike["branches"]>[number]): SellerRegistration {
  return {
    label: b.label, gstin: b.gstin, stateCode: b.stateCode ?? b.gstin.slice(0, 2), state: b.state ?? null, addressLine1: b.addressLine1 ?? null,
    addressLine2: b.addressLine2 ?? null, city: b.city ?? null, pincode: b.pincode ?? null, invoicePrefix: b.invoicePrefix, creditNotePrefix: b.creditNotePrefix, scope: b.gstin,
  };
}

/**
 * The registration a supply is billed from: the one registered in the place of supply's state
 * (so the client pays CGST + SGST and claims it in-state), otherwise the principal registration
 * (IGST for other states). Deterministic, so a draft and its issue always agree.
 */
export function registrationFor(seller: SellerLike, placeOfSupplyCode: string | null | undefined): SellerRegistration {
  const b = placeOfSupplyCode ? (seller.branches ?? []).find((x) => (x.stateCode ?? x.gstin.slice(0, 2)) === placeOfSupplyCode) : undefined;
  return b && placeOfSupplyCode !== seller.stateCode ? branchReg(b) : principal(seller);
}

/** The registration an issued document was billed from, by the GSTIN frozen in its seller snapshot. */
export function registrationByGstin(seller: SellerLike, gstin: string | null | undefined): SellerRegistration {
  const b = gstin ? (seller.branches ?? []).find((x) => x.gstin === gstin) : undefined;
  return b ? branchReg(b) : principal(seller);
}
