import { parseFiledAmount } from "@dashmani/shared";
import { AppError } from "../../../middleware/error-handler";
import { decodeText, excelSerialToDay, sniffFormat } from "../tabular";

// Common reading for the reconcile uploads (spec-reconcile §4.1). Pure — bytes/text in, values out.
// ⚠️ Linear time only: no regex over a whole uploaded text (the 2026-09-08 hang). Regexes here run
// on ONE trimmed cell at a time, which tabular.ts / the line splitter bound.

export type ReconFileKind = "text" | "json" | "xlsx" | "xls" | "pdf" | "zip" | "unknown";

/** Every parser's answer: what was read, which rows were not, and why the upload might be refused. */
export interface ParseReport<T> {
  format: string;
  facts: Record<string, string | null>;
  items: T[];
  /** Rows not imported, ≤ 50 kept (errorCount has the total). */
  errors: Array<{ ref: string; message: string }>;
  errorCount: number;
  /** Sentences — the upload needs acceptWarnings when any are present. */
  warnings: string[];
  /** The upload is refused with the first one. */
  blockers: Array<{ code: string; message: string }>;
}

export const MAX_ERROR_ROWS = 50;
export function pushError<T>(r: ParseReport<T>, ref: string, message: string) {
  r.errorCount++;
  if (r.errors.length < MAX_ERROR_ROWS) r.errors.push({ ref, message });
}
export function emptyReport<T>(format: string): ParseReport<T> {
  return { format, facts: {}, items: [], errors: [], errorCount: 0, warnings: [], blockers: [] };
}

/**
 * What the bytes are: tabular's sniff, plus a ZIP that is not a workbook (the TRACES / GST
 * portal download) and JSON (text whose first non-space character is "{").
 */
export function sniffRecon(buf: Buffer): ReconFileKind {
  const f = sniffFormat(buf);
  if (f === "pdf") return "pdf";
  if (f === "xls") return "xls";
  if (f === "html" || f === "unknown") return "unknown";
  if (f === "xlsx") {
    const head = buf.subarray(0, Math.min(buf.length, 64 * 1024)).toString("latin1");
    return head.includes("[Content_Types].xml") || head.includes("xl/") ? "xlsx" : "zip";
  }
  const text = decodeText(buf.subarray(0, Math.min(buf.length, 4096)));
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n" || c === "﻿") continue;
    return c === "{" ? "json" : "text";
  }
  return "text";
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad2 = (n: number) => String(n).padStart(2, "0");
function realDay(y: number, m: number, d: number): string | null {
  if (!(y >= 1900 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const s = `${y}-${pad2(m)}-${pad2(d)}`;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s ? s : null;
}

/**
 * A government file's day — DAY-FIRST only, never guessed: dd-MMM-yyyy (any case, "Sept" ok),
 * dd-mm-yyyy, dd/mm/yyyy, dd.mm.yyyy, yyyy-mm-dd, an Excel serial 20000–80000. A trailing time is
 * dropped; 31-Feb → null; two-digit years → null.
 */
export function parseGovDay(cell: string | null | undefined): string | null {
  if (cell == null) return null;
  let s = String(cell).trim();
  if (!s || s.length > 40) return null;
  // ISO with a time (2026-10-14T00:00:00) or a trailing clock (14-10-2026 10:30:00 AM)
  s = s.replace(/T\d{2}:\d{2}.*$/, "").replace(/\s+\d{1,2}:\d{2}(:\d{2})?(\.\d+)?(\s*[AP]M)?$/i, "").trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return realDay(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
  if (m) return realDay(+m[3], +m[2], +m[1]);
  m = /^(\d{1,2})[-\s/.]+([A-Za-z]{3,9})[-\s/.,]+(\d{4})$/.exec(s);
  if (m) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    return mo ? realDay(+m[3], mo, +m[1]) : null;
  }
  m = /^(\d{5})(\.\d+)?$/.exec(s);
  if (m) {
    const n = Number(m[1]);
    if (n >= 20000 && n <= 80000) return excelSerialToDay(n);
  }
  return null;
}

/**
 * A rupee amount in a government file → paise. "" / "-" / "NA" / "N/A" → null; "₹", "Rs.", "INR"
 * and spaces stripped; at most 2 decimals; negative → "error" (none of these fields can be).
 */
export function govPaise(cell: string | null | undefined): number | null | "error" {
  if (cell == null) return null;
  let s = String(cell).trim();
  if (s === "" || s === "-" || /^n\/?a$/i.test(s)) return null;
  s = s.replace(/₹/g, "").replace(/^(rs\.?|inr)\s*/i, "").replace(/\s+/g, "");
  if (s === "") return null;
  if (s.startsWith("-") || s.startsWith("−") || s.startsWith("(")) return "error";
  const p = parseFiledAmount(s, "rupees");
  if (p === null) return null;
  if (p === "invalid" || p < 0 || !Number.isSafeInteger(p)) return "error";
  return p;
}

/** A GSTR-1 JSON amount (a number of rupees) → paise. Absent → 0 (the portal omits zero tax heads). */
export function jsonPaise(v: unknown): number | "error" {
  if (v === undefined || v === null) return 0;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return "error";
    const p = v * 100;
    if (Math.abs(p - Math.round(p)) > 0.001) return "error";
    const r = Math.round(p);
    return Number.isSafeInteger(r) && r >= 0 ? r : "error";
  }
  if (typeof v === "string") {
    const g = govPaise(v);
    return g === null ? 0 : g;
  }
  return "error";
}

/** A heading cell normalised for matching: lower-case; "(" ")" "*" "#" dropped; other punctuation → one space. */
export function norm(h: string | null | undefined): string {
  return String(h ?? "")
    .toLowerCase()
    .replace(/[()*#]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** A stored file name: path stripped, control characters removed, ≤ 200 characters. */
export function cleanFileName(name: string | null | undefined, fallback: string): string {
  const base = String(name ?? "").split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const s = base.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200);
  return s || fallback;
}

// ─── Single flight: one parse at a time per process (spec §6.1) ───────────────────────────────

let parsing = 0;
/** Run one parse; a second concurrent parse in this process → 429 RECON_BUSY. */
export async function withParseSlot<T>(fn: () => Promise<T> | T): Promise<T> {
  if (parsing > 0) throw new AppError(429, "RECON_BUSY", "Another file is being read — try again in a few seconds.");
  parsing++;
  try {
    return await fn();
  } finally {
    parsing--;
  }
}
