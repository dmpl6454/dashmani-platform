import { GST_STATE_CODES } from "@dashmani/shared";

// Tally XML writing (spec-tally §4.6–4.7, §4.13): amounts from integer paise, YYYYMMDD dates, an
// escaper that makes every file pure ASCII, a tiny indenting writer and the envelopes. No XML
// declaration, no comments, CRLF line ends, one space of indent per level.

export const CRLF = "\r\n";

/** Integer paise → Tally amount text. 11800000 → "118000.00"; -5 → "-0.05"; 0 → "0.00"; never "-0.00". */
export function amt(p: number): string {
  if (!Number.isSafeInteger(p)) throw new Error("amt needs integer paise");
  const a = Math.abs(p);
  return `${p < 0 ? "-" : ""}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
}

/** An IST day "2026-11-05" → "20261105". Never from a timestamp. */
export function tallyDate(day: string): string {
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`tallyDate needs YYYY-MM-DD, got ${String(day)}`);
  const t = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== day) throw new Error(`tallyDate: ${day} is not a real day`);
  return day.replace(/-/g, "");
}

/** "2026-11-05" → "05-11-2026" (narrations). */
export const dmy = (day: string) => `${day.slice(8, 10)}-${day.slice(5, 7)}-${day.slice(0, 4)}`;

/** Paise → "2,000.00" with Indian grouping, exact (no floating point). */
export function inrGrouped(p: number): string {
  if (!Number.isSafeInteger(p)) throw new Error("inrGrouped needs integer paise");
  const a = Math.abs(p);
  const rupees = String(Math.floor(a / 100));
  const last3 = rupees.slice(-3);
  const rest = rupees.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}` : last3;
  return `${p < 0 ? "-" : ""}${grouped}.${String(a % 100).padStart(2, "0")}`;
}
/** "Rs. 2,000.00" — money in a narration. */
export const rsText = (p: number) => `Rs. ${inrGrouped(p)}`;

/**
 * Text for a Tally tag or attribute: NFC; a newline becomes " | "; XML-illegal and control
 * characters (below 0x20 except tab, DEL, lone surrogates, U+FFFE/FFFF) are dropped; whitespace runs
 * collapse; & < > " ' are escaped; every code point above 0x7E is written as &#N; — so the file is
 * pure ASCII and Tally's UTF-8/UTF-16 handling can never garble a name.
 */
export function esc(input: string | null | undefined): string {
  if (input == null) return "";
  const s = String(input).normalize("NFC").replace(/\r\n|\r|\n/g, " | ");
  let clean = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x09) { clean += " "; continue; }
    if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp < 0xa0) || (cp >= 0xd800 && cp <= 0xdfff) || cp === 0xfffe || cp === 0xffff) continue;
    clean += ch;
  }
  clean = clean.replace(/ {2,}/g, " ").trim();
  let out = "";
  for (const ch of clean) {
    const cp = ch.codePointAt(0)!;
    if (ch === "&") out += "&amp;";
    else if (ch === "<") out += "&lt;";
    else if (ch === ">") out += "&gt;";
    else if (ch === '"') out += "&quot;";
    else if (ch === "'") out += "&apos;";
    else if (cp > 0x7e) out += `&#${cp};`;
    else out += ch;
  }
  return out;
}

/** Cut text to n characters (before escaping), never splitting a surrogate pair. */
export function cut(s: string, n: number): string {
  const chars = Array.from(s);
  return chars.length <= n ? s : chars.slice(0, n).join("");
}

/** State-name spellings Tally wants where they differ from GST_STATE_CODES (filled at calibration, C5). */
export const TALLY_STATE_NAME: Record<string, string> = {};
export function tallyStateName(code: string | null | undefined): string | null {
  if (!code) return null;
  return TALLY_STATE_NAME[code] ?? GST_STATE_CODES[code] ?? null;
}

/** Country name for COUNTRYOFRESIDENCE ("IN" → "India"). Exports only; calibration item C14. */
export function countryName(code: string | null | undefined): string {
  const c = (code || "IN").toUpperCase();
  if (c === "IN") return "India";
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(c) ?? c;
  } catch {
    return c;
  }
}

/** An indenting writer: one space per level, CRLF after every line. Values and attributes are escaped. */
export class XmlWriter {
  private out: string[] = [];
  private depth: number;
  constructor(depth = 0) { this.depth = depth; }
  private line(text: string) { this.out.push(" ".repeat(this.depth) + text); }
  private attrs(a?: Array<[string, string]>) { return (a ?? []).map(([k, v]) => ` ${k}="${esc(v)}"`).join(""); }
  open(tag: string, a?: Array<[string, string]>) { this.line(`<${tag}${this.attrs(a)}>`); this.depth++; return this; }
  close(tag: string) { this.depth--; this.line(`</${tag}>`); return this; }
  /** <TAG>value</TAG>; nothing when value is null/undefined. */
  leaf(tag: string, value: string | null | undefined, a?: Array<[string, string]>) {
    if (value == null) return this;
    this.line(`<${tag}${this.attrs(a)}>${esc(value)}</${tag}>`);
    return this;
  }
  /** A value from a code constant written as is (Tally's "&#4; Applicable" markers). Never user text. */
  constant(tag: string, rawValue: string) { this.line(`<${tag}>${rawValue}</${tag}>`); return this; }
  /** Splice lines another writer produced (already indented from depth 0). */
  lines(): string[] { return this.out; }
  toString(): string { return this.out.length ? this.out.join(CRLF) + CRLF : ""; }
}

/** The Import Data envelope around the TALLYMESSAGE bodies (one per master / voucher). */
export function importEnvelope(report: "All Masters" | "Vouchers", company: string, messages: string[]): string {
  const w = new XmlWriter();
  w.open("ENVELOPE");
  w.open("HEADER").leaf("TALLYREQUEST", "Import Data").close("HEADER");
  w.open("BODY").open("IMPORTDATA");
  w.open("REQUESTDESC").leaf("REPORTNAME", report).open("STATICVARIABLES").leaf("SVCURRENTCOMPANY", company);
  if (report === "All Masters") w.leaf("IMPORTDUPS", "@@DUPIGNORE");
  w.close("STATICVARIABLES").close("REQUESTDESC");
  w.open("REQUESTDATA");
  let body = w.toString();
  for (const m of messages) body += m;
  const tail = new XmlWriter(4);
  tail.close("REQUESTDATA").close("IMPORTDATA").close("BODY").close("ENVELOPE");
  return body + tail.toString();
}

/** A TDL collection export request (pre-flight reads, test connection, ledger match). */
export function collectionRequest(o: { id: string; type: string; fetch: string; company?: string | null; from?: string; to?: string }): string {
  const vars = [
    o.company ? `<SVCURRENTCOMPANY>${esc(o.company)}</SVCURRENTCOMPANY>` : "",
    "<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>",
    o.from ? `<SVFROMDATE>${tallyDate(o.from)}</SVFROMDATE>` : "",
    o.to ? `<SVTODATE>${tallyDate(o.to)}</SVTODATE>` : "",
  ].join("");
  return (
    `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>${esc(o.id)}</ID></HEADER>${CRLF}` +
    `<BODY><DESC><STATICVARIABLES>${vars}</STATICVARIABLES>${CRLF}` +
    `<TDL><TDLMESSAGE><COLLECTION NAME="${esc(o.id)}" ISMODIFY="No"><TYPE>${esc(o.type)}</TYPE>${CRLF}` +
    `<FETCH>${esc(o.fetch)}</FETCH>${CRLF}` +
    `</COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>${CRLF}`
  );
}

export const VOUCHERS_FETCH = "VoucherNumber, VoucherTypeName, Date, PartyLedgerName, Amount, RemoteID, MasterID, IsCancelled";
export const LEDGERS_FETCH = "Name, Parent, PartyGSTIN, LedGSTRegDetails.GSTIN";
