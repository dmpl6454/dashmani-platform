import { GST_STATE_CODES } from "@dashmani/shared";
import { excelSerialToDay } from "../tabular";

// Swipe import (spec-import §4.4): reading one text cell as money, a day, a quantity, a GST rate,
// a state, a status, a GSTIN, a party name or an invoice number. Pure — strings in, values out.
// Money is read with STRING arithmetic (never Number(x) * 100: "0.29" * 100 = 28.999999999999996).
// Every regex here is anchored over ONE cell (≤ 500 characters), never over a whole file.

export type AmountResult = { paise: number; rounded?: boolean } | { blank: true } | { error: string };

const isBlankWord = (s: string) => s === "" || s === "-" || s === "--" || s === "na" || s === "n/a" || s === "nil";

/** "₹1,23,456.78" → 12345678; "(1,234.00)" → −123400; "-" / "NA" / "" → blank (≠ 0); "12.345" → 1235 rounded. */
export function parseAmount(text: string | null | undefined): AmountResult {
  let s = String(text ?? "").trim();
  if (isBlankWord(s.toLowerCase())) return { blank: true };
  // Currency marks, grouping commas (Indian or Western) and spaces of any kind.
  s = s.replace(/₹|INR|Rs\.?/gi, "").replace(/[\s ,]/g, "");
  if (isBlankWord(s.toLowerCase())) return { blank: true };
  let neg = false;
  if (s.startsWith("(") && s.endsWith(")")) { neg = true; s = s.slice(1, -1); }
  if (s.startsWith("-")) { neg = !neg; s = s.slice(1); } else if (s.endsWith("-")) { neg = !neg; s = s.slice(0, -1); }
  if (s.startsWith("+")) s = s.slice(1);
  const m = /^(\d{1,15})(?:\.(\d+))?$/.exec(s) ?? /^()\.(\d+)$/.exec(s);
  if (!m) return { error: `"${String(text).slice(0, 40)}" is not an amount` };
  const intPart = m[1] || "0";
  const frac = m[2] ?? "";
  const two = (frac + "00").slice(0, 2);
  const rest = frac.slice(2);
  let paise = BigInt(intPart) * 100n + BigInt(two);
  let rounded = false;
  if (rest && /[1-9]/.test(rest)) {
    rounded = true;
    if (rest.charCodeAt(0) >= 53) paise += 1n; // half-up on the 3rd decimal
  }
  const n = Number(neg ? -paise : paise);
  if (!Number.isSafeInteger(n)) return { error: "That amount is too large" };
  return rounded ? { paise: n === 0 ? 0 : n, rounded } : { paise: n === 0 ? 0 : n };
}

/** The paise of an amount cell, or null when blank / unreadable. */
export const amountOrNull = (text: string | null | undefined): number | null => {
  const r = parseAmount(text);
  return "paise" in r ? r.paise : null;
};

/** A real calendar day (2026-02-31 is not one). */
export function isRealDay(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00.000Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

function ymd(y: number, m: number, d: number): string | null {
  if (y < 100) y += 2000;
  const s = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return isRealDay(s) ? s : null;
}

export type DateOrder = "dmy" | "mdy";

/**
 * A day in any of the shapes Swipe / Excel write: 2026-11-05 (and the grid's normalised dates),
 * 05/11/2026 · 05-11-26 · 05.11.2026 (read per `order`), 5-Nov-2026 · 5 Nov 2026, Nov 5, 2026,
 * and a bare Excel serial (20000–80000). Null when it is none of these or not a real day.
 */
export function parseDay(text: string | null | undefined, order: DateOrder = "dmy"): string | null {
  const s = String(text ?? "").trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T].*)?$/.exec(s);
  if (m) return ymd(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(?: .*)?$/.exec(s);
  if (m) return order === "dmy" ? ymd(+m[3], +m[2], +m[1]) : ymd(+m[3], +m[1], +m[2]);
  m = /^(\d{1,2})[ -]([A-Za-z]{3,9})\.?[ ,-]*(\d{2}|\d{4})$/.exec(s);
  if (m && MONTHS[m[2].toLowerCase()]) return ymd(+m[3], MONTHS[m[2].toLowerCase()], +m[1]);
  m = /^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})$/.exec(s);
  if (m && MONTHS[m[1].toLowerCase()]) return ymd(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
  if (/^\d{5}(\.0+)?$/.test(s)) {
    const n = Number(s);
    if (n >= 20000 && n <= 80000) return excelSerialToDay(Math.floor(n));
  }
  return null;
}

/**
 * Day-first or month-first, from the issue-date column: a first part above 12 proves day-first,
 * a second part above 12 proves month-first; both is a conflict; neither is assumed day-first.
 */
export function detectDateOrder(values: string[]): { order: DateOrder; conflict: boolean; assumed: boolean } {
  let dmy = false;
  let mdy = false;
  for (const v of values) {
    const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})/.exec(String(v).trim());
    if (!m) continue;
    if (+m[1] > 12) dmy = true;
    if (+m[2] > 12) mdy = true;
    if (dmy && mdy) break;
  }
  if (dmy && mdy) return { order: "dmy", conflict: true, assumed: false };
  if (mdy) return { order: "mdy", conflict: false, assumed: false };
  return { order: "dmy", conflict: false, assumed: !dmy };
}

/** A positive number of units ("2", "1.5", "1,000"); null otherwise. */
export function parseQty(text: string | null | undefined): number | null {
  const s = String(text ?? "").trim().replace(/,/g, "");
  if (!/^\d{1,9}(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
}

/** "18%", "18", "18.0" → 1800; a value ≤ 1 is a fraction ("0.18" → 1800). Null when unreadable. */
export function parseRateBp(text: string | null | undefined): number | null {
  const s = String(text ?? "").trim().replace(/%$/, "").trim();
  if (!/^\d{1,3}(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  if (n > 100) return null;
  return Math.round(n <= 1 ? n * 10_000 : n * 100);
}

const normWords = (s: string) => s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");

const STATE_BY_NAME: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const [code, name] of Object.entries(GST_STATE_CODES)) out[normWords(name)] = code;
  const aliases: Record<string, string> = {
    orissa: "21", pondicherry: "34", delhi: "07", "new delhi": "07", "nct of delhi": "07", "national capital territory of delhi": "07",
    telengana: "36", uttaranchal: "05", "dadra and nagar haveli and daman and diu": "26", "dadra and nagar haveli": "26", "daman and diu": "26",
    "jammu and kashmir": "01", ladakh: "38", "other territory": "97", "andaman and nicobar": "35", "tamilnadu": "33", "chattisgarh": "22",
  };
  return { ...out, ...aliases };
})();

/** A GST state code from "27", "27-Maharashtra", "Maharashtra (27)" or a state name; "EXPORT" for outside India; else null. */
export function parseStateCode(text: string | null | undefined): string | null {
  const s = String(text ?? "").trim();
  if (!s) return null;
  const lead = /^(\d{1,2})(?!\d)/.exec(s);
  if (lead && GST_STATE_CODES[lead[1].padStart(2, "0")]) return lead[1].padStart(2, "0");
  const trail = /(?:^|\D)(\d{2})\)?$/.exec(s);
  if (trail && GST_STATE_CODES[trail[1]]) return trail[1];
  const name = normWords(s.replace(/\(\s*\d{1,2}\s*\)/g, "").replace(/^\d{1,2}\s*[-–]\s*/, ""));
  if (!name) return null;
  if (/^(outside india|other countries|other country|overseas|foreign|export|abroad)$/.test(name)) return "EXPORT";
  return STATE_BY_NAME[name] ?? null;
}

/** ISO 3166 "user-assigned" code the import stores for a buyer abroad whose country is not known. */
export const UNKNOWN_COUNTRY = "ZZ";

const COUNTRY_BY_NAME: Record<string, string> = {
  india: "IN", bharat: "IN", "united states": "US", "united states of america": "US", usa: "US", us: "US", america: "US",
  "united kingdom": "GB", uk: "GB", "great britain": "GB", britain: "GB", england: "GB", "united arab emirates": "AE", uae: "AE", dubai: "AE",
  singapore: "SG", canada: "CA", australia: "AU", "new zealand": "NZ", germany: "DE", france: "FR", netherlands: "NL", ireland: "IE",
  switzerland: "CH", sweden: "SE", spain: "ES", italy: "IT", belgium: "BE", nepal: "NP", bangladesh: "BD", "sri lanka": "LK",
  bhutan: "BT", maldives: "MV", "saudi arabia": "SA", qatar: "QA", oman: "OM", kuwait: "KW", bahrain: "BH", "hong kong": "HK",
  japan: "JP", china: "CN", malaysia: "MY", indonesia: "ID", thailand: "TH", philippines: "PH", vietnam: "VN", "south korea": "KR",
  "south africa": "ZA", kenya: "KE", nigeria: "NG", israel: "IL", mauritius: "MU",
};

/** A buyer country as an ISO 3166 alpha-2 code, from "AE", "UAE" or "United Arab Emirates"; null when not recognised. */
export function parseCountry(text: string | null | undefined): string | null {
  const s = String(text ?? "").trim();
  if (!s || s === "-") return null;
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  return COUNTRY_BY_NAME[normWords(s)] ?? null;
}

export type SwipeStatus ="paid" | "partial" | "unpaid" | "cancelled" | "draft";

/** Swipe's status word; `unknown` when it is a word we do not recognise (the amounts then decide). */
export function parseSwipeStatus(text: string | null | undefined): { status: SwipeStatus | null; unknown: boolean } {
  const s = normWords(String(text ?? ""));
  if (!s) return { status: null, unknown: false };
  if (["paid", "fully paid", "received", "settled"].includes(s)) return { status: "paid", unknown: false };
  if (["partially paid", "partial", "part paid", "partly paid"].includes(s)) return { status: "partial", unknown: false };
  if (["unpaid", "pending", "due", "overdue", "sent", "issued", "open", "not paid"].includes(s)) return { status: "unpaid", unknown: false };
  if (["cancelled", "canceled", "void", "voided", "deleted"].includes(s)) return { status: "cancelled", unknown: false };
  if (s === "draft") return { status: "draft", unknown: false };
  return { status: null, unknown: true };
}

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
/** The GSTIN format (validators' gstinSchema), after upper-casing. */
export const gstinShapeOk = (v: string | null | undefined): boolean => GSTIN_RE.test(String(v ?? "").trim().toUpperCase());

const CH = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** The GSTN mod-36 check digit (15th character). */
export function gstinChecksumOk(v: string | null | undefined): boolean {
  const g = String(v ?? "").trim().toUpperCase();
  if (g.length !== 15) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const val = CH.indexOf(g[i]);
    if (val < 0) return false;
    const p = val * (i % 2 ? 2 : 1);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return CH[(36 - (sum % 36)) % 36] === g[14];
}

const PARTY_NOISE = new Set(["private", "pvt", "limited", "ltd", "llp", "opc", "inc", "incorporated", "co", "company"]);

/** "M/s. Filmy Brands Pvt. Ltd." and "FILMY BRANDS PRIVATE LIMITED" → "filmy brands". */
export function normaliseParty(name: string | null | undefined): string {
  let s = String(name ?? "").toLowerCase().replace(/&/g, " and ").trim();
  s = s.replace(/^m\s*\/\s*s\.?\s*/, "").replace(/^the\s+/, "");
  s = s.replace(/\bpvt\.\s*ltd\.?/g, " ").replace(/\bp\.?\s+ltd\.?/g, " ");
  s = s.replace(/[^a-z0-9]+/g, " ");
  return s.split(" ").filter((w) => w && !PARTY_NOISE.has(w)).join(" ");
}

/** The import key and the stored number of an invoice number cell; `ok` = a valid GST number (≤ 16, [A-Za-z0-9/-]). */
export function invoiceKey(text: string | null | undefined): { key: string; number: string; ok: boolean } {
  let s = String(text ?? "").trim();
  if (s.startsWith("'")) s = s.slice(1);
  const number = s.replace(/\s+/g, "");
  return { key: number.toUpperCase(), number, ok: number.length > 0 && number.length <= 16 && /^[A-Za-z0-9/-]+$/.test(number) };
}

/** Indian-grouped rupees for messages: 5900000 → "₹59,000.00". */
export function rs(paise: number): string {
  const neg = paise < 0;
  const abs = Math.abs(paise);
  return `${neg ? "-" : ""}₹${Math.floor(abs / 100).toLocaleString("en-IN")}.${String(abs % 100).padStart(2, "0")}`;
}

/** 2024-06-12 → 12-06-2024 (the way staff read dates). */
export const dmyOf = (day: string) => `${day.slice(8, 10)}-${day.slice(5, 7)}-${day.slice(0, 4)}`;
