// The accounts page (sales.digitalsukoon.com/accounts, spec-accounts §4.1): financial years,
// return periods, ageing, GSTR-1 formatting and the typed-in filed figures. Pure — no I/O, no
// clock (callers pass "today"). Money is integer PAISE. Import BY PATH from the portal
// ("@dashmani/shared/src/sales/accounts"); the API gets it through the barrel. No zod here.
// TDS rate labels and panOf live in ./tds (spec-00 §2.7), not here.

import { GST_STATE_CODES } from "./gst";

// ─── Financial years and return periods ──────────────────────────────────────────────────────

export interface FyBounds { label: string; startDay: string; endDay: string; endExclusive: string }

/** "2025-26" → 2025-04-01 / 2026-03-31 / 2026-04-01; anything else (2025-27, 25-26, 2025-2026) → null. */
export function fyBounds(label: string): FyBounds | null {
  const m = /^(\d{4})-(\d{2})$/.exec(label);
  if (!m) return null;
  const y = Number(m[1]);
  if ((y + 1) % 100 !== Number(m[2])) return null;
  return { label, startDay: `${y}-04-01`, endDay: `${y + 1}-03-31`, endExclusive: `${y + 1}-04-01` };
}

const fyLabelOf = (startYear: number) => `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;

/** Every FY label from firstFy to lastFy inclusive, NEWEST first. Empty when either is not a label. */
export function fyLabelsBetween(firstFy: string, lastFy: string): string[] {
  const a = fyBounds(firstFy);
  const b = fyBounds(lastFy);
  if (!a || !b) return [];
  const from = Number(a.startDay.slice(0, 4));
  const to = Number(b.startDay.slice(0, 4));
  const out: string[] = [];
  for (let y = to; y >= from; y--) out.push(fyLabelOf(y));
  return out;
}

/** The FY label a day falls in (same answer as gst.ts financialYear(day).label). */
export function fyOfDay(day: string): string {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  return fyLabelOf(m >= 4 ? y : y - 1);
}

/** Quarter of the Indian FY: Apr–Jun 1, Jul–Sep 2, Oct–Dec 3, Jan–Mar 4. */
export function fyQuarter(day: string): 1 | 2 | 3 | 4 {
  const m = Number(day.slice(5, 7));
  return (Math.floor(((m + 8) % 12) / 3) + 1) as 1 | 2 | 3 | 4;
}

export const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
export const MONTH_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;
const QUARTER_MONTHS = ["Apr–Jun", "Jul–Sep", "Oct–Dec", "Jan–Mar"] as const;

const ymd = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}-01`;
const nextMonth = (y: number, m: number) => (m === 12 ? ymd(y + 1, 1) : ymd(y, m + 1));

/** The 12 months of a FY, April first, as "YYYY-MM". */
export function fyMonths(fy: string): string[] {
  const b = fyBounds(fy);
  if (!b) return [];
  const y = Number(b.startDay.slice(0, 4));
  const out: string[] = [];
  for (let k = 0; k < 12; k++) {
    const m = ((3 + k) % 12) + 1;
    out.push(`${m >= 4 ? y : y + 1}-${String(m).padStart(2, "0")}`);
  }
  return out;
}

export interface PeriodBounds { kind: "month" | "quarter" | "year"; from: string; toExclusive: string; fy: string; label: string }

/**
 * A GST return period: "2026-10" (a month) → 2026-10-01..2026-11-01 "October 2026";
 * "2026-27-Q3" → 2026-10-01..2027-01-01 "Q3 2026-27 (Oct–Dec)"; "2026-27" → the FY "FY 2026-27".
 * A string that is both a month and a FY label (only 2009-10 … 2011-12) reads as the month.
 */
export function periodBounds(p: string): PeriodBounds | null {
  let m = /^(\d{4})-(\d{2})$/.exec(p);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    if (mo >= 1 && mo <= 12) {
      return { kind: "month", from: ymd(y, mo), toExclusive: nextMonth(y, mo), fy: fyLabelOf(mo >= 4 ? y : y - 1), label: `${MONTH_LONG[mo - 1]} ${y}` };
    }
    const b = fyBounds(p);
    return b ? { kind: "year", from: b.startDay, toExclusive: b.endExclusive, fy: b.label, label: `FY ${b.label}` } : null;
  }
  m = /^(\d{4}-\d{2})-Q([1-4])$/.exec(p);
  if (m) {
    const b = fyBounds(m[1]);
    if (!b) return null;
    const q = Number(m[2]);
    const y = Number(b.startDay.slice(0, 4));
    const startMonth = ((3 + (q - 1) * 3) % 12) + 1; // 4, 7, 10, 1
    const sy = startMonth >= 4 ? y : y + 1;
    const endMonth = startMonth + 3;
    const toExclusive = endMonth > 12 ? ymd(sy + 1, endMonth - 12) : ymd(sy, endMonth);
    return { kind: "quarter", from: ymd(sy, startMonth), toExclusive, fy: b.label, label: `Q${q} ${b.label} (${QUARTER_MONTHS[q - 1]})` };
  }
  return null;
}

// ─── Ageing and GST deadlines ────────────────────────────────────────────────────────────────

export type AgeKey = "not_due" | "d0_30" | "d31_60" | "d61_90" | "d90_plus";
export const AGE_BUCKETS: ReadonlyArray<{ key: AgeKey; label: string }> = [
  { key: "not_due", label: "Not yet due" },
  { key: "d0_30", label: "0–30 days late" },
  { key: "d31_60", label: "31–60 days late" },
  { key: "d61_90", label: "61–90 days late" },
  { key: "d90_plus", label: "90+ days late" },
];

const dayNumber = (day: string) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / 86_400_000;

/** late = today − due in days: due after today → not_due; 0–30 → d0_30; 31–60; 61–90; more → d90_plus. */
export function ageBucket(today: string, due: string): AgeKey {
  if (due > today) return "not_due";
  const late = dayNumber(today) - dayNumber(due);
  if (late <= 30) return "d0_30";
  if (late <= 60) return "d31_60";
  if (late <= 90) return "d61_90";
  return "d90_plus";
}

/** GSTR-1 (monthly filer) is due on the 11th of the month after the invoice's month. */
export function gstr1DueDay(issueDay: string): string {
  const y = Number(issueDay.slice(0, 4));
  const m = Number(issueDay.slice(5, 7));
  return m === 12 ? `${y + 1}-01-11` : `${y}-${String(m + 1).padStart(2, "0")}-11`;
}

/** CGST s.34(2): a credit note reduces output tax only if issued by 30 November after the end of the invoice's FY. */
export function creditNoteDeadline(invoiceIssueDay: string): string {
  const b = fyBounds(fyOfDay(invoiceIssueDay))!;
  return `${b.endDay.slice(0, 4)}-11-30`;
}

// ─── GSTR-1 formatting ───────────────────────────────────────────────────────────────────────

/** Where the GST offline tool spells a place of supply differently from GST_STATE_CODES. */
export const GSTR1_POS_NAMES: Record<string, string> = {
  "26": "Dadra & Nagar Haveli & Daman & Diu",
  "96": "Other Countries",
  "97": "Other Territory",
};

/** "2026-10-14" → "14-Oct-2026" (the offline tool's date format). */
export function gstr1Date(day: string): string {
  return `${day.slice(8, 10)}-${MONTH_SHORT[Number(day.slice(5, 7)) - 1]}-${day.slice(0, 4)}`;
}

/** Place of supply as the offline tool writes it: "27-Maharashtra"; a buyer abroad → "96-Other Countries"; unknown → "". */
export function gstr1Pos(stateCode: string | null, country: string | null): string {
  const c = (country ?? "").trim().toUpperCase();
  if (c && c !== "IN") return `96-${GSTR1_POS_NAMES["96"]}`;
  const code = (stateCode ?? "").trim();
  if (!code) return "";
  const name = GSTR1_POS_NAMES[code] ?? GST_STATE_CODES[code];
  return name ? `${code}-${name}` : code;
}

// ─── Rupees ──────────────────────────────────────────────────────────────────────────────────

function groupIndian(whole: string): string {
  const last3 = whole.slice(-3);
  let rest = whole.slice(0, -3);
  const groups: string[] = [];
  while (rest.length > 2) {
    groups.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest) groups.unshift(rest);
  return groups.length ? `${groups.join(",")},${last3}` : last3;
}

/** "₹4,82,15,300.00" / "−₹12,00,000.00" — exact, Indian grouping, no locale APIs; null → "₹—". */
export function inrPaise(paise: number | null): string {
  if (paise == null) return "₹—";
  const neg = paise < 0;
  const abs = Math.abs(paise);
  const whole = String(Math.floor(abs / 100));
  return `${neg ? "−" : ""}₹${groupIndian(whole)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Chart ticks and legend only: "₹0", "₹500", "₹45K", "₹3.4 L", "₹1.2 Cr". */
export function inrShort(paise: number): string {
  const neg = paise < 0;
  const r = Math.abs(paise) / 100;
  const one = (v: number) => (v >= 100 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, ""));
  let s: string;
  if (r >= 1e7) s = `₹${one(r / 1e7)} Cr`;
  else if (r >= 1e5) s = `₹${one(r / 1e5)} L`;
  else if (r >= 1e3) s = `₹${one(r / 1e3)}K`;
  else s = `₹${Math.round(r)}`;
  return r === 0 ? "₹0" : `${neg ? "−" : ""}${s}`;
}

// ─── Filed figures (typed from the signed statements) ────────────────────────────────────────

export type EntryUnit = "rupees" | "thousands" | "lakhs" | "crores";
export const ENTRY_UNIT_RUPEES: Record<EntryUnit, number> = { rupees: 1, thousands: 1_000, lakhs: 1_00_000, crores: 1_00_00_000 };
export const ENTRY_UNIT_LABELS: Record<EntryUnit, string> = { rupees: "₹ rupees", thousands: "₹ thousands", lakhs: "₹ lakhs", crores: "₹ crores" };
/** Decimal places a unit allows: 2 + log10(unit) (paise precision in any unit). */
const UNIT_FRACTION: Record<EntryUnit, number> = { rupees: 2, thousands: 5, lakhs: 7, crores: 9 };
/** The rounding a statement in that unit carries: ₹1 / ₹10 / ₹1,000 / ₹1,00,000. */
const UNIT_TOLERANCE_PAISE: Record<EntryUnit, number> = { rupees: 100, thousands: 1_000, lakhs: 1_00_000, crores: 1_00_00_000 };

export type FiledFigureKey =
  | "revenuePaise" | "otherIncomePaise" | "totalExpensesPaise" | "profitBeforeTaxPaise" | "taxExpensePaise" | "profitAfterTaxPaise"
  | "totalAssetsPaise" | "totalLiabilitiesPaise" | "equityPaise" | "cashAndBankPaise" | "tradeReceivablesPaise" | "tradePayablesPaise";

export const FILED_FIGURES: ReadonlyArray<{ key: FiledFigureKey; label: string; group: "pl" | "bs"; signed: boolean; signLabels?: [string, string] }> = [
  { key: "revenuePaise", label: "Revenue from operations", group: "pl", signed: false },
  { key: "otherIncomePaise", label: "Other income", group: "pl", signed: false },
  { key: "totalExpensesPaise", label: "Total expenses", group: "pl", signed: false },
  { key: "profitBeforeTaxPaise", label: "Profit before tax", group: "pl", signed: true, signLabels: ["Profit", "Loss"] },
  { key: "taxExpensePaise", label: "Tax expense (current + deferred)", group: "pl", signed: true, signLabels: ["Charge", "Credit"] },
  { key: "profitAfterTaxPaise", label: "Profit after tax", group: "pl", signed: true, signLabels: ["Profit", "Loss"] },
  { key: "totalAssetsPaise", label: "Total assets", group: "bs", signed: false },
  { key: "totalLiabilitiesPaise", label: "Total liabilities (excluding equity)", group: "bs", signed: false },
  { key: "equityPaise", label: "Equity / net worth", group: "bs", signed: true, signLabels: ["Positive", "Negative"] },
  { key: "cashAndBankPaise", label: "Cash and bank balances", group: "bs", signed: false },
  { key: "tradeReceivablesPaise", label: "Trade receivables", group: "bs", signed: false },
  { key: "tradePayablesPaise", label: "Trade payables", group: "bs", signed: false },
];
export const FILED_FIGURE_KEYS: readonly FiledFigureKey[] = FILED_FIGURES.map((f) => f.key);
export const FILED_MIN_FY = "2010-11";

/**
 * What staff typed, in the unit of the statements, → paise. String arithmetic only (never
 * Math.round(n * 100)): "," and spaces are stripped, a leading "-" / "−" or "(…)" is negative, at
 * most 2 + log10(unit) decimals. "" → null; anything else unreadable → "invalid".
 */
export function parseFiledAmount(text: string, unit: EntryUnit): number | null | "invalid" {
  let s = text.replace(/[,\s₹]/g, "");
  if (s === "") return null;
  let neg = false;
  if (s.startsWith("(") && s.endsWith(")")) { neg = true; s = s.slice(1, -1); }
  if (s.startsWith("-") || s.startsWith("−")) { neg = !neg; s = s.slice(1); }
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[1] === "" && !m[2])) return "invalid";
  const places = UNIT_FRACTION[unit];
  const frac = m[2] ?? "";
  if (frac.length > places) return "invalid";
  const p = BigInt(m[1] || "0") * 10n ** BigInt(places) + BigInt(frac.padEnd(places, "0") || "0");
  const n = Number(neg ? -p : p);
  if (!Number.isSafeInteger(n)) return "invalid";
  return n === 0 ? 0 : n;
}

/** The inverse of parseFiledAmount: paise → text in the unit, trailing zeros trimmed, no grouping; null → "". */
export function formatFiledAmount(paise: number | null, unit: EntryUnit): string {
  if (paise == null) return "";
  const places = UNIT_FRACTION[unit];
  const scale = 10n ** BigInt(places);
  const p = BigInt(paise);
  const abs = p < 0n ? -p : p;
  const whole = (abs / scale).toString();
  const frac = (abs % scale).toString().padStart(places, "0").replace(/0+$/, "");
  return `${p < 0n ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

const figureLabel = (k: FiledFigureKey) => FILED_FIGURES.find((f) => f.key === k)!.label;

/** Soft checks on typed figures (warnings, never blocking). Each runs only when all its figures are typed. */
export function filedChecks(f: Record<FiledFigureKey, number | null>, unit: EntryUnit): string[] {
  const tol = UNIT_TOLERANCE_PAISE[unit];
  const out: string[] = [];
  const all = (...ks: FiledFigureKey[]) => ks.every((k) => f[k] != null);
  if (all("revenuePaise", "otherIncomePaise", "totalExpensesPaise", "profitBeforeTaxPaise")) {
    const x = f.revenuePaise! + f.otherIncomePaise! - f.totalExpensesPaise!;
    if (Math.abs(x - f.profitBeforeTaxPaise!) > tol) {
      out.push(`Revenue + other income − expenses is ${inrPaise(x)}, but profit before tax says ${inrPaise(f.profitBeforeTaxPaise)} — exceptional items? Check the P&L.`);
    }
  }
  if (all("profitBeforeTaxPaise", "taxExpensePaise", "profitAfterTaxPaise")) {
    const x = f.profitBeforeTaxPaise! - f.taxExpensePaise!;
    if (Math.abs(x - f.profitAfterTaxPaise!) > tol) {
      out.push(`Profit before tax − tax is ${inrPaise(x)}, but profit after tax says ${inrPaise(f.profitAfterTaxPaise)}.`);
    }
  }
  if (all("equityPaise", "totalLiabilitiesPaise", "totalAssetsPaise")) {
    const x = f.equityPaise! + f.totalLiabilitiesPaise!;
    if (Math.abs(x - f.totalAssetsPaise!) > tol) {
      out.push(`Equity + liabilities is ${inrPaise(x)}, but total assets says ${inrPaise(f.totalAssetsPaise)} — the balance sheet should balance.`);
    }
  }
  for (const k of ["tradeReceivablesPaise", "cashAndBankPaise"] as const) {
    if (all(k, "totalAssetsPaise") && f[k]! > f.totalAssetsPaise!) out.push(`${figureLabel(k)} is larger than total assets — check the unit.`);
  }
  return out;
}

/** Event note for a save: only the changed fields, in FILED_FIGURES order, then unit / notes; cut to 500 chars. */
export function describeFiledEdit(
  before: { figures: Record<FiledFigureKey, number | null>; enteredIn: EntryUnit; notes: string | null } | null,
  after: { figures: Record<FiledFigureKey, number | null>; enteredIn: EntryUnit; notes: string | null },
): string {
  const parts: string[] = [];
  for (const f of FILED_FIGURES) {
    const a = before ? before.figures[f.key] : null;
    const b = after.figures[f.key];
    if (a !== b) parts.push(`${f.label} ${inrPaise(a)} → ${inrPaise(b)}`);
  }
  const unitBefore = before?.enteredIn ?? "rupees";
  if (unitBefore !== after.enteredIn) parts.push(`Unit ${unitBefore} → ${after.enteredIn}`);
  if ((before?.notes ?? null) !== after.notes) parts.push("Notes changed");
  const s = parts.join("; ");
  return s.length > 500 ? `${s.slice(0, 499)}…` : s;
}

// ─── GST sections (the SQL CASE in the API decides; these are the words) ─────────────────────

export type GstSection = "b2b" | "sez" | "b2cl" | "b2cs" | "exp" | "check";
export const GST_SECTION_LABELS: Record<GstSection, string> = {
  b2b: "B2B (4A)",
  sez: "SEZ without payment (6B)",
  b2cl: "B2C large (5)",
  b2cs: "B2C small (7)",
  exp: "Export without payment (6A)",
  check: "Check with CA",
};
