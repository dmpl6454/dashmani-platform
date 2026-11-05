import { createHash } from "crypto";
import { BANK_PRESET_HEADERS } from "@dashmani/shared";
import type { BankDateOrder, BankMapping, BankPreset } from "@dashmani/shared";
import { AppError } from "../../middleware/error-handler";
import { decodeText, excelSerialToDay, openWorkbook, parseDelimited, ROW_HEADROOM, sniffFormat, TabularError } from "./tabular";

// Reading a bank statement (spec-bank §4.1) — pure: a Buffer in, a report out. No I/O, no clock
// (callers pass `today`), no JS Date arithmetic beyond parsing an ISO day. The FORMAT layer is
// PR 0's tabular.ts (sniff, decode, RFC-4180 CSV, workbook grid); everything bank-specific lives
// here: heading synonyms, presets (hints only), amount styles, row rules, the running-balance
// check, the account hint, UTR extraction and the dedupe hash.
//
// ⚠️ Linear time only — no regex over a whole uploaded text, and every regex below runs on one
// short cell (capped) or one short token. A regex over page/file text caused the 2026-09-08 hang.

export type Cell = string;
export type StatementFormat = "csv" | "tsv" | "xlsx" | "xls" | "html";
export type Need = "columns" | "dateFormat" | "amountSign";

/** A statement can have at most this many transaction rows (one month of a busy account is ~1-3k). */
export const MAX_STATEMENT_ROWS = 20_000;
/** Header detection looks at this many rows from the top. */
const HEADER_SCAN_ROWS = 40;
/** Workbooks: only the first sheets are considered. */
const MAX_SHEETS = 5;
const CELL_CAP = 64;

const tooLong = () => new AppError(422, "STATEMENT_TOO_LONG", "A statement can have at most 20,000 rows — download one month at a time");

// ── Format ─────────────────────────────────────────────────────────────────────

/**
 * Bytes → a grid of text cells. Sniffed by magic bytes (the extension is only a hint): %PDF →
 * 415 STATEMENT_PDF; anything that is not text, XLSX, XLS or an HTML table → 415 STATEMENT_FORMAT;
 * a password-protected workbook → 422 STATEMENT_ENCRYPTED. CSV never goes through SheetJS, which
 * would read 01/02/2026 as 2 January. A workbook uses the requested sheet, else the first sheet
 * whose headings can be found.
 */
export function readGrid(buf: Buffer, _fileName: string, sheet?: string | null): { format: StatementFormat; sheets: string[]; sheet: string | null; rows: Cell[][] } {
  const fmt = sniffFormat(buf);
  if (fmt === "pdf") throw new AppError(415, "STATEMENT_PDF", "PDF statements cannot be read — download the same statement as Excel or CSV from net banking and upload that");
  if (fmt === "unknown") throw new AppError(415, "STATEMENT_FORMAT", "This file is not a CSV or Excel statement");
  if (fmt === "csv") {
    const { delimiter, rows } = parseDelimited(decodeText(buf), MAX_STATEMENT_ROWS);
    if (rows.length >= MAX_STATEMENT_ROWS + ROW_HEADROOM) throw tooLong();
    return { format: delimiter === "\t" ? "tsv" : "csv", sheets: [], sheet: null, rows: rows.map((r) => r.map((c) => c.trim())) };
  }
  let wb: ReturnType<typeof openWorkbook>;
  try {
    wb = openWorkbook(buf, MAX_STATEMENT_ROWS);
  } catch (err) {
    if (err instanceof TabularError && err.kind === "encrypted") throw new AppError(422, "STATEMENT_ENCRYPTED", "This file is password-protected. Open it, save a copy without a password, and upload the copy.");
    throw new AppError(415, "STATEMENT_FORMAT", "This file is not a CSV or Excel statement");
  }
  const sheets = wb.sheetNames.slice(0, MAX_SHEETS);
  const pick = (name: string) => {
    const rows = wb.grid(name, 100);
    if (rows.length >= MAX_STATEMENT_ROWS + ROW_HEADROOM) throw tooLong();
    return rows;
  };
  if (sheet && sheets.includes(sheet)) return { format: fmt, sheets, sheet, rows: pick(sheet) };
  for (const name of sheets) {
    const rows = pick(name);
    if (detectMapping(rows)) return { format: fmt, sheets, sheet: name, rows };
  }
  return { format: fmt, sheets, sheet: sheets[0] ?? null, rows: sheets.length ? pick(sheets[0]) : [] };
}

// ── Headings ───────────────────────────────────────────────────────────────────

/** "Chq./Ref.No." → "chq ref no", "Deposit Amount (INR )" → "deposit amount". Linear: no regex over long text. */
export function norm(h: Cell): string {
  const s = String(h ?? "").slice(0, 200).toLowerCase();
  let out = "";
  let depth = 0;
  for (const ch of s) {
    if (ch === "(") { depth++; out += " "; continue; }
    if (ch === ")") { if (depth > 0) depth--; out += " "; continue; }
    if (depth > 0) continue;
    out += (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") ? ch : " ";
  }
  return out.split(" ").filter(Boolean).join(" ");
}

type Role = "date" | "valueDate" | "narration" | "reference" | "debit" | "credit" | "amount" | "drCr" | "balance";
const SYNONYMS: Array<[Role, string[]]> = [
  ["date", ["date", "txn date", "transaction date", "tran date", "trans date", "posting date", "post date", "txn posted date", "transaction posted date"]],
  ["valueDate", ["value date", "value dt", "val date"]],
  ["narration", ["narration", "naration", "description", "particulars", "remarks", "transaction remarks", "transaction details", "details", "transaction description", "narrative", "transaction particulars"]],
  ["reference", ["chq ref no", "chq no", "cheque no", "cheque number", "chq number", "chqno", "chq ref number", "ref no", "reference no", "reference number", "ref no cheque no", "cheque no reference no", "instrument no", "transaction id", "tran id", "utr", "utr no", "utr number"]],
  ["debit", ["withdrawal", "withdrawals", "withdrawal amt", "withdrawal amount", "debit", "debits", "debit amount", "dr", "dr amount", "amount debited", "withdrawal dr"]],
  ["credit", ["deposit", "deposits", "deposit amt", "deposit amount", "credit", "credits", "credit amount", "cr", "cr amount", "amount credited", "deposit cr"]],
  ["amount", ["amount", "transaction amount", "txn amount", "amt"]],
  ["drCr", ["dr cr", "cr dr", "debit credit", "type", "transaction type", "txn type"]],
  ["balance", ["balance", "closing balance", "running balance", "available balance", "balance amt", "bal"]],
];
const ROLE_OF = new Map<string, Role>();
for (const [role, names] of SYNONYMS) for (const n of names) if (!ROLE_OF.has(n)) ROLE_OF.set(n, role);

const DRCR_VALUES = new Set(["CR", "DR", "C", "D", "CREDIT", "DEBIT"]);
const isBlank = (c: Cell | undefined) => !c || !String(c).trim();

/** The role of each column of a candidate heading row (each column its first role, each role one column). */
function rolesOf(row: Cell[], below: Cell[][]): Partial<Record<Role, number>> {
  const roles: Partial<Record<Role, number>> = {};
  row.forEach((cell, col) => {
    const role = ROLE_OF.get(norm(cell));
    if (!role || roles[role] !== undefined) return;
    if (role === "drCr") {
      // "Type" is often NEFT / UPI / IMPS — a Dr/Cr column only when its values say so.
      const vals = below.map((r) => String(r[col] ?? "").trim().toUpperCase().replace(/\.$/, "")).filter(Boolean);
      if (!vals.length || vals.filter((v) => DRCR_VALUES.has(v)).length / vals.length < 0.8) return;
    }
    roles[role] = col;
  });
  // "value date" is the transaction date only when the file has no other date column.
  if (roles.date === undefined && roles.valueDate !== undefined) {
    roles.date = roles.valueDate;
    delete roles.valueDate;
  }
  return roles;
}

function presetOf(headerRow: Cell[], hint?: BankPreset | null): BankPreset | null {
  const have = new Set(headerRow.map(norm).filter(Boolean));
  let best: BankPreset | null = null;
  let bestScore = 0;
  for (const [preset, heads] of Object.entries(BANK_PRESET_HEADERS)) {
    const score = heads.filter((h) => have.has(h)).length / heads.length;
    if (score >= 0.7 && (score > bestScore || (score === bestScore && preset === hint))) {
      best = preset as BankPreset;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Find the heading row (first 40 rows) and the column roles. A candidate maps date + narration +
 * (credit or debit or amount). Returns null when no row qualifies. `needs` lists what a person
 * must still choose: the date format (ambiguous day/month) or the amount sign (a plain signed
 * Amount column). Warnings are sentences for the preview.
 */
export function detectMapping(rows: Cell[][], hint?: BankPreset | null): { mapping: BankMapping; preset: BankPreset | null; needs: Need[]; warnings: string[] } | null {
  const limit = Math.min(rows.length, HEADER_SCAN_ROWS);
  for (let i = 0; i < limit; i++) {
    const row = rows[i];
    if (!row || row.every(isBlank)) continue;
    const below = rows.slice(i + 1, i + 201);
    const r = rolesOf(row, below);
    if (r.date === undefined || r.narration === undefined) continue;
    if (r.credit === undefined && r.debit === undefined && r.amount === undefined) continue;
    const needs: Need[] = [];
    const warnings: string[] = [];
    let amountStyle: BankMapping["amountStyle"];
    if (r.credit !== undefined || r.debit !== undefined) amountStyle = "split";
    else if (r.drCr !== undefined) amountStyle = "drcr_column";
    else {
      const vals = below.map((x) => String(x[r.amount!] ?? "").trim()).filter(Boolean);
      const suffixed = vals.filter((v) => { const m = parseMoneyText(v); return m !== null && m !== "error" && (m.marker === "cr" || m.marker === "dr"); }).length;
      if (vals.length && suffixed / vals.length >= 0.8) amountStyle = "suffix";
      else {
        amountStyle = "signed_credit_positive";
        needs.push("amountSign");
      }
    }
    const dates = below.map((x) => String(x[r.date!] ?? "")).filter((v) => v.trim());
    const d = detectDateOrder(dates);
    if (d.needs) needs.push("dateFormat");
    if (d.warning) warnings.push(d.warning);
    const mapping: BankMapping = {
      sheet: null,
      headerRow: i + 1,
      columns: {
        date: r.date,
        valueDate: r.valueDate ?? null,
        narration: r.narration,
        reference: r.reference ?? null,
        debit: amountStyle === "split" ? r.debit ?? null : null,
        credit: amountStyle === "split" ? r.credit ?? null : null,
        amount: amountStyle === "split" ? null : r.amount ?? null,
        drCr: amountStyle === "drcr_column" ? r.drCr ?? null : null,
        balance: r.balance ?? null,
      },
      dateOrder: d.order,
      amountStyle,
    };
    return { mapping, preset: presetOf(row, hint), needs, warnings };
  }
  return null;
}

/** sha256 hex of the normalised headings joined by "|" — identifies a layout across uploads (same hash as import). */
export function headerSignature(row: Cell[]): string {
  return createHash("sha256").update(row.map(norm).join("|")).digest("hex");
}

// ── Values ─────────────────────────────────────────────────────────────────────

type Money = { paise: bigint; sign: 1 | -1; marker: "cr" | "dr" | "paren" | "minus" | null };

/**
 * Money text → paise, by string arithmetic (no float reaches paise). Drops ₹ / Rs. / INR / spaces
 * / commas; a Cr/Dr prefix or suffix (also "(Cr)") or brackets or a sign give the direction.
 * null for blank markers; "error" for anything else that is not a whole number of paise.
 */
function parseMoneyText(cell: Cell): Money | null | "error" {
  let s = String(cell ?? "").trim();
  if (!s) return null;
  if (s.length > CELL_CAP) return "error";
  const up = s.toUpperCase();
  if (up === "-" || up === "--" || up === "NA" || up === "N/A" || up === "NIL") return null;
  s = s.replace(/₹/g, "").replace(/\bINR\b/gi, "").replace(/\bRS\.?/gi, "").replace(/[\s,]/g, "");
  let sign: 1 | -1 = 1;
  let marker: Money["marker"] = null;
  const lower = () => s.toLowerCase();
  const stripSuffix = (suffixes: string[], m: "cr" | "dr") => {
    for (const suf of suffixes) {
      if (lower().endsWith(suf) && s.length > suf.length) { s = s.slice(0, -suf.length); marker = m; return true; }
    }
    return false;
  };
  if (!stripSuffix(["(cr)", "cr.", "cr"], "cr")) stripSuffix(["(dr)", "dr.", "dr"], "dr");
  if (!marker) {
    const l = lower();
    if (l.startsWith("cr.") || l.startsWith("cr")) { s = s.slice(l.startsWith("cr.") ? 3 : 2); marker = "cr"; }
    else if (l.startsWith("dr.") || l.startsWith("dr")) { s = s.slice(l.startsWith("dr.") ? 3 : 2); marker = "dr"; }
  }
  if (marker === "dr") sign = -1;
  if (s.startsWith("(") && s.endsWith(")")) { s = s.slice(1, -1); sign = -1; marker = marker ?? "paren"; }
  if (s.startsWith("-")) { s = s.slice(1); sign = -1; marker = marker ?? "minus"; }
  else if (s.startsWith("+")) s = s.slice(1);
  if (!s) return null;
  const dot = s.indexOf(".");
  const whole = dot < 0 ? s : s.slice(0, dot);
  let frac = dot < 0 ? "" : s.slice(dot + 1);
  if (!/^\d+$/.test(whole) || (dot >= 0 && !/^\d+$/.test(frac))) return "error";
  // "1234.5000" is fine (trailing zeros); a third significant decimal is not.
  if (frac.length > 2) {
    if (!/^0+$/.test(frac.slice(2))) return "error";
    frac = frac.slice(0, 2);
  }
  const paise = BigInt(whole) * 100n + BigInt((frac + "00").slice(0, 2));
  return { paise, sign, marker };
}

/** An amount cell: { paise, sign } — null for blank or zero, "error" when unreadable. */
export function parseAmount(cell: Cell): { paise: bigint; sign: 1 | -1 } | null | "error" {
  const m = parseMoneyText(cell);
  if (m === null || m === "error") return m;
  if (m.paise === 0n) return null;
  return { paise: m.paise, sign: m.sign };
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function isRealDay(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d) || m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2200) return null;
  const s = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const t = Date.parse(`${s}T00:00:00.000Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s ? s : null;
}

/** "05/11/2026 10:42:11" → "05/11/2026"; "2026-11-05T00:00" → "2026-11-05". */
function stripTime(s: string): string {
  const t = s.indexOf("T");
  if (t === 10 && /^\d{4}-\d{2}-\d{2}T/.test(s)) return s.slice(0, 10);
  return s.replace(/\s+\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\s*([AaPp][Mm])?$/, "");
}

const year = (y: string) => (y.length === 2 ? 2000 + Number(y) : Number(y));

/** A day cell → YYYY-MM-DD (null when unreadable or not a real day). A number 20000–80000 is an Excel serial. */
export function parseDay(cell: Cell, order: BankDateOrder): string | null {
  let s = String(cell ?? "").trim();
  if (!s || s.length > 40) return null;
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const n = Number(s);
    return n >= 20000 && n <= 80000 ? excelSerialToDay(Math.floor(n)) : null;
  }
  s = stripTime(s);
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (m) return isRealDay(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[/\-. ](\d{1,2})[/\-. ](\d{2}|\d{4})$/.exec(s);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return order === "mdy" ? isRealDay(year(m[3]), a, b) : isRealDay(year(m[3]), b, a);
  }
  m = /^(\d{1,2})[/\-. ]?([A-Za-z]{3,9})[/\-. ,]*(\d{2}|\d{4})$/.exec(s);
  if (m) {
    const mon = MONTHS[m[2].toLowerCase()];
    return mon ? isRealDay(year(m[3]), mon, Number(m[1])) : null;
  }
  return null;
}

function dayNum(day: string): number {
  return Math.round(Date.parse(`${day}T00:00:00.000Z`) / 86_400_000);
}

function monotonic(days: Array<string | null>): boolean {
  const xs = days.filter((d): d is string => d !== null);
  if (xs.length !== days.length) return false;
  let up = true;
  let down = true;
  for (let i = 1; i < xs.length; i++) {
    if (xs[i] < xs[i - 1]) up = false;
    if (xs[i] > xs[i - 1]) down = false;
  }
  return up || down;
}

/**
 * Day/month order over a whole column: any first part > 12 → dmy; else any second part > 12 →
 * mdy (with a warning); all ≤ 12 → dmy when dmy reads the dates in order (either direction), else
 * when mdy does → ask the person (needs dateFormat); else dmy.
 */
export function detectDateOrder(values: Cell[]): { order: BankDateOrder; needs: boolean; warning: string | null } {
  const numeric: string[] = [];
  let firstOver = false;
  let secondOver = false;
  for (const v of values) {
    const s = stripTime(String(v).trim());
    const m = /^(\d{1,2})[/\-. ](\d{1,2})[/\-. ](\d{2}|\d{4})$/.exec(s);
    if (!m) continue;
    numeric.push(s);
    if (Number(m[1]) > 12) firstOver = true;
    if (Number(m[2]) > 12) secondOver = true;
  }
  if (!numeric.length || firstOver) return { order: "dmy", needs: false, warning: null };
  if (secondOver) return { order: "mdy", needs: false, warning: "Dates in this file are month/day/year — check a few below" };
  if (monotonic(numeric.map((v) => parseDay(v, "dmy")))) return { order: "dmy", needs: false, warning: null };
  if (monotonic(numeric.map((v) => parseDay(v, "mdy")))) return { order: "dmy", needs: true, warning: null };
  return { order: "dmy", needs: false, warning: null };
}

const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const RTGS_RE = /^[A-Z]{4}R[0-9A-Z]{17}$/;
const NEFT_RE = /^[A-Z]{4}[0-9A-Z]{12}$/;
const RRN_RE = /^\d{12}$/;
const looksUtr = (t: string) =>
  t.length <= 40 && !IFSC_RE.test(t) && (RTGS_RE.test(t) || RRN_RE.test(t) || (NEFT_RE.test(t) && (t.slice(4).match(/\d/g)?.length ?? 0) >= 4));

/** Tokens of a short text on [^A-Za-z0-9]+, upper-cased — a character loop, no regex over the text. */
export function tokensOf(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const ch of text) {
    const c = ch.toUpperCase();
    if ((c >= "A" && c <= "Z") || (c >= "0" && c <= "9")) cur += c;
    else if (cur) { out.push(cur); cur = ""; }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * The UTR / RRN of a credit: the token after NEFT / RTGS / IMPS / UPI when it looks like one, else
 * the first token shaped like an RTGS (22), NEFT (16, with digits, never an IFSC) or IMPS/UPI RRN
 * (12 digits). Anchored regexes on short tokens only.
 */
export function extractUtr(narration: string, reference: string | null): string | null {
  const toks = tokensOf(`${narration ?? ""} ${reference ?? ""}`);
  for (let i = 0; i < toks.length; i++) {
    if (toks[i] === "NEFT" || toks[i] === "RTGS" || toks[i] === "IMPS" || toks[i] === "UPI") {
      for (let j = i + 1; j <= i + 3 && j < toks.length; j++) if (looksUtr(toks[j])) return toks[j];
    }
  }
  for (const t of toks) if (looksUtr(t)) return t;
  return null;
}

// ── Rows ───────────────────────────────────────────────────────────────────────

export interface ParsedLine {
  rowNo: number;
  txnDate: string;
  valueDate: string | null;
  narration: string;
  reference: string | null;
  utr: string | null;
  creditPaise: bigint;
  debitPaise: bigint;
  balancePaise: bigint | null;
}

export interface ParseReport {
  lines: ParsedLine[];
  skipped: Array<{ rowNo: number; reason: string }>;
  errors: Array<{ rowNo: number; message: string }>;
  openingPaise: bigint | null;
  closingPaise: bigint | null;
  period: { from: string; to: string } | null;
  balanceCheck: { status: "ok" | "breaks" | "no_balance_column"; breaks: Array<{ rowNo: number; expectedPaise: bigint; foundPaise: bigint }> };
  accountCheck: { status: "match" | "mismatch" | "not_stated"; found: string | null };
}

const SKIP_TEXT = /^(opening|closing) balance|^balance (b\/f|c\/f|brought|carried)|^b\/f|^c\/f|brought forward|carried forward|^total|^grand total|statement summary|end of statement|^page \d+|generated on|^\*+$|^-+$/i;

function shortText(c: Cell | undefined): string {
  return String(c ?? "").replace(/\s+/g, " ").trim();
}

/** The account number a statement's preamble states (masked digits allowed), else null. */
function accountInPreamble(rows: Cell[][]): string | null {
  const re = /(?:a\/?c|account)\s*(?:no|number)?\.?\s*:?\s*([0-9xX*]{6,20})/i;
  const label = /^(?:a\/?c|account)\s*(?:no|number)?\.?\s*:?$/i;
  for (const row of rows) {
    for (let c = 0; c < row.length; c++) {
      const cell = shortText(row[c]);
      if (!cell || cell.length > 200) continue;
      const m = re.exec(cell);
      if (m && /\d/.test(m[1])) return m[1];
      if (label.test(cell)) {
        for (let k = c + 1; k < row.length; k++) {
          const next = shortText(row[k]);
          if (!next) continue;
          if (/^[0-9xX*]{6,20}$/.test(next) && /\d/.test(next)) return next;
          break;
        }
      }
    }
  }
  return null;
}

/** Compare a stated (possibly masked) number with the account's. */
export function checkAccount(found: string | null, accountNumber: string): { status: "match" | "mismatch" | "not_stated"; found: string | null } {
  if (!found) return { status: "not_stated", found: null };
  const mine = accountNumber.replace(/\D/g, "");
  const masked = /[xX*]/.test(found);
  // SBI and some ICICI/Kotak exports zero-pad the number in the header (00000031234567890) while
  // staff register it as printed on the cheque book (31234567890): compare without leading zeros.
  const bare = (x: string) => x.replace(/\D/g, "").replace(/^0+/, "");
  if (!masked) return { status: bare(found) !== "" && bare(found) === bare(mine) ? "match" : "mismatch", found };
  const digits = found.replace(/[^0-9]/g, "");
  return { status: digits.length >= 4 && mine.endsWith(digits.slice(-4)) ? "match" : "mismatch", found };
}

const plusDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * Read every row below the heading with a mapping: transactions, skipped rows (with reasons),
 * error rows (listed, never imported), continuation narrations, the running-balance check, the
 * opening/closing balances, the period and the account hint from the preamble.
 */
export function applyMapping(rows: Cell[][], mapping: BankMapping, opts: { today: string; accountNumber: string; matchFrom: string | null }): ParseReport {
  const c = mapping.columns;
  const head = rows[mapping.headerRow - 1] ?? [];
  const headNorm = head.map(norm).join("|");
  const lines: ParsedLine[] = [];
  const skipped: ParseReport["skipped"] = [];
  const errors: ParseReport["errors"] = [];
  let opening: bigint | null = null;
  let lastWasTxn = false;
  const latest = plusDays(opts.today, 1);

  const money = (col: number | null | undefined, row: Cell[]) => (col == null ? null : parseMoneyText(row[col] ?? ""));
  for (let i = mapping.headerRow; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const rowNo = i + 1;
    if (row.every(isBlank)) { lastWasTxn = false; continue; }
    if (row.map(norm).join("|") === headNorm) { skipped.push({ rowNo, reason: "repeated heading" }); lastWasTxn = false; continue; }
    const narration = shortText(row[c.narration]);
    const first = shortText(row.find((x) => !isBlank(x)));
    const skipBy = SKIP_TEXT.test(narration.slice(0, 120)) ? narration : SKIP_TEXT.test(first.slice(0, 120)) ? first : null;
    const dateCell = shortText(row[c.date]);
    if (skipBy !== null) {
      if (/opening balance|brought forward|^b\/f/i.test(skipBy.slice(0, 120))) {
        for (const col of [c.balance, c.credit, c.amount, c.debit]) {
          const m = money(col, row);
          if (m && m !== "error") { opening = m.paise * BigInt(m.sign); break; }
        }
      }
      skipped.push({ rowNo, reason: skipBy.slice(0, 60) });
      lastWasTxn = false;
      continue;
    }

    // Amounts by style.
    let credit = 0n;
    let debit = 0n;
    let amountError: string | null = null;
    let anyAmount = false;
    if (mapping.amountStyle === "split") {
      const cr = money(c.credit, row);
      const dr = money(c.debit, row);
      if (cr === "error" || dr === "error") amountError = `could not read the amount${cr === "error" ? ` '${shortText(row[c.credit!])}'` : ` '${shortText(row[c.debit!])}'`}`;
      else {
        credit = cr ? cr.paise : 0n;
        debit = dr ? dr.paise : 0n;
        anyAmount = credit > 0n || debit > 0n;
      }
    } else {
      const a = money(c.amount, row);
      if (a === "error") amountError = `could not read the amount '${shortText(row[c.amount!])}'`;
      else if (a && a.paise > 0n) {
        anyAmount = true;
        if (mapping.amountStyle === "drcr_column") {
          const t = shortText(row[c.drCr!]).toUpperCase().replace(/\.$/, "");
          if (t === "CR" || t === "C" || t === "CREDIT") credit = a.paise;
          else if (t === "DR" || t === "D" || t === "DEBIT") debit = a.paise;
          else amountError = `the Dr/Cr value '${shortText(row[c.drCr!]).slice(0, 20)}' is neither Dr nor Cr`;
        } else if (mapping.amountStyle === "suffix") {
          if (a.marker === "cr") credit = a.paise;
          else if (a.marker === "dr") debit = a.paise;
          else amountError = `the amount '${shortText(row[c.amount!])}' has no Cr/Dr`;
        } else if (mapping.amountStyle === "signed_credit_positive") {
          if (a.sign > 0) credit = a.paise; else debit = a.paise;
        } else {
          if (a.sign > 0) debit = a.paise; else credit = a.paise;
        }
      }
    }
    const txnDate = dateCell ? parseDay(dateCell, mapping.dateOrder) : null;
    if (!dateCell && !anyAmount && !amountError) {
      if (narration && lastWasTxn && lines.length) {
        const prev = lines[lines.length - 1];
        prev.narration = `${prev.narration} ${narration}`.slice(0, 500);
        if (!prev.utr) prev.utr = extractUtr(prev.narration, prev.reference);
        continue;
      }
      skipped.push({ rowNo, reason: "no date or amount" });
      lastWasTxn = false;
      continue;
    }
    if (dateCell && !txnDate) { errors.push({ rowNo, message: `could not read the date '${dateCell.slice(0, 30)}'` }); lastWasTxn = false; continue; }
    if (amountError) { errors.push({ rowNo, message: amountError }); lastWasTxn = false; continue; }
    if (!txnDate && anyAmount) { errors.push({ rowNo, message: "an amount with no date" }); lastWasTxn = false; continue; }
    if (credit > 0n && debit > 0n) { errors.push({ rowNo, message: "both a withdrawal and a deposit on one row" }); lastWasTxn = false; continue; }
    if (!anyAmount) { skipped.push({ rowNo, reason: "zero-amount row" }); lastWasTxn = false; continue; }
    if (txnDate! < "2015-01-01" || txnDate! > latest) { errors.push({ rowNo, message: `the date ${txnDate} is out of range` }); lastWasTxn = false; continue; }
    const bal = money(c.balance, row);
    const reference = c.reference == null ? null : shortText(row[c.reference]).slice(0, 120) || null;
    const ref = reference && /^0+$/.test(reference) ? null : reference;
    const valueDate = c.valueDate == null ? null : parseDay(shortText(row[c.valueDate]), mapping.dateOrder);
    const narr = narration.slice(0, 500);
    lines.push({
      rowNo,
      txnDate: txnDate!,
      valueDate,
      narration: narr,
      reference: ref,
      utr: extractUtr(narr, ref),
      creditPaise: credit,
      debitPaise: debit,
      balancePaise: bal && bal !== "error" ? bal.paise * BigInt(bal.sign) : null,
    });
    lastWasTxn = true;
    if (lines.length > MAX_STATEMENT_ROWS) throw tooLong();
  }

  // Running balance: whichever direction (ascending or descending file order) breaks less.
  const withBal = lines.filter((l) => l.balancePaise !== null);
  let balanceCheck: ParseReport["balanceCheck"] = { status: "no_balance_column", breaks: [] };
  let chronological = lines;
  if (c.balance != null && withBal.length >= 1) {
    const asc: ParseReport["balanceCheck"]["breaks"] = [];
    const desc: ParseReport["balanceCheck"]["breaks"] = [];
    for (let i = 1; i < withBal.length; i++) {
      const a = withBal[i - 1];
      const b = withBal[i];
      const expAsc = a.balancePaise! + b.creditPaise - b.debitPaise;
      if (expAsc !== b.balancePaise) asc.push({ rowNo: b.rowNo, expectedPaise: expAsc, foundPaise: b.balancePaise! });
      const expDesc = b.balancePaise! + a.creditPaise - a.debitPaise;
      if (expDesc !== a.balancePaise) desc.push({ rowNo: a.rowNo, expectedPaise: expDesc, foundPaise: a.balancePaise! });
    }
    const ascending = asc.length < desc.length || (asc.length === desc.length && !(lines.length > 1 && lines[0].txnDate > lines[lines.length - 1].txnDate));
    const breaks = ascending ? asc : desc;
    balanceCheck = { status: breaks.length ? "breaks" : "ok", breaks: breaks.slice(0, 10) };
    chronological = ascending ? lines : [...lines].reverse();
  } else if (lines.length > 1 && lines[0].txnDate > lines[lines.length - 1].txnDate) {
    chronological = [...lines].reverse();
  }
  const firstBal = chronological.find((l) => l.balancePaise !== null);
  const lastBal = [...chronological].reverse().find((l) => l.balancePaise !== null);
  const openingPaise = firstBal ? firstBal.balancePaise! - firstBal.creditPaise + firstBal.debitPaise : opening;
  const closingPaise = lastBal ? lastBal.balancePaise : null;
  let from: string | null = null;
  let to: string | null = null;
  for (const l of lines) {
    if (from === null || l.txnDate < from) from = l.txnDate;
    if (to === null || l.txnDate > to) to = l.txnDate;
  }
  return {
    lines,
    skipped,
    errors,
    openingPaise,
    closingPaise,
    period: from && to ? { from, to } : null,
    balanceCheck,
    accountCheck: checkAccount(accountInPreamble(rows.slice(0, Math.max(0, mapping.headerRow - 1))), opts.accountNumber),
  };
}

// ── Idempotency ────────────────────────────────────────────────────────────────

const keepAlnum = (s: string | null) => tokensOf(s ?? "").join("");

/**
 * The per-account dedupe hash of each line (spec §4.2). With a balance column the narration is
 * left out (CSV and Excel downloads of one month truncate narrations differently; the balance is
 * the same); without one the reference and the first 60 narration characters are in. The
 * occurrence counter separates genuinely identical rows; file order does not matter.
 */
export function dedupeHashes(bankAccountId: string, lines: ParsedLine[]): string[] {
  const seen = new Map<string, number>();
  return lines.map((l) => {
    const noBal = l.balancePaise === null;
    const fields = [
      "v1",
      bankAccountId,
      l.txnDate,
      l.creditPaise.toString(),
      l.debitPaise.toString(),
      l.balancePaise === null ? "" : l.balancePaise.toString(),
      noBal ? keepAlnum(l.reference) : "",
      noBal ? keepAlnum(l.narration).slice(0, 60) : "",
    ].join("|");
    const occurrence = (seen.get(fields) ?? 0) + 1;
    seen.set(fields, occurrence);
    return createHash("sha256").update(`${fields}|${occurrence}`).digest("hex");
  });
}

export { dayNum };
