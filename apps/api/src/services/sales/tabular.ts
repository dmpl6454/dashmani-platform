import * as XLSX from "xlsx";

// Reading a spreadsheet-shaped upload into a grid of TEXT cells (spec-00 §2.5) — the format half
// shared by import's read.ts (Swipe exports) and bank's bank-parse.ts (statements). Pure: a Buffer
// in, strings out; no I/O, no Date. Value parsing (amounts, days), header detection and synonym
// tables stay per feature on purpose.
//
// ⚠️ Linear time only. A regex over a whole uploaded text is how the 2026-09-08 main-thread hang
// happened: CSV is read by a character state machine, never by a regex over the file.

export type FileFormat = "csv" | "xlsx" | "xls" | "html" | "pdf" | "unknown";

export class TabularError extends Error {
  constructor(public kind: "encrypted" | "unreadable", msg: string) {
    super(msg);
    this.name = "TabularError";
  }
}

/** Rows read beyond `maxRows`: room for a preamble + header row above the data, plus one row so "too many rows" is detectable. */
export const ROW_HEADROOM = 41;
/** Columns a workbook grid keeps when the caller names no limit — a stray cell in column XFD must not make the walk 16 384 wide. */
export const DEFAULT_MAX_COLS = 256;

const SNIFF_BYTES = 64 * 1024;

function startsWith(buf: Buffer, bytes: number[]): boolean {
  if (buf.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (buf[i] !== bytes[i]) return false;
  return true;
}

function hasUtf16Bom(buf: Buffer): boolean {
  return startsWith(buf, [0xff, 0xfe]) || startsWith(buf, [0xfe, 0xff]);
}

/** "<" as the first character after a BOM / whitespace, and "<table" somewhere in the head. */
function looksHtml(head: string): boolean {
  let i = 0;
  if (head.charCodeAt(0) === 0xfeff) i = 1;
  while (i < head.length && (head[i] === " " || head[i] === "\t" || head[i] === "\r" || head[i] === "\n")) i++;
  return head[i] === "<" && head.toLowerCase().includes("<table");
}

/**
 * What the bytes are, whatever the file is called. %PDF → pdf; PK\x03\x04 → xlsx; the OLE2
 * signature → xls; markup with a <table> (the HTML "XLS" some banks send) → html; text with no NUL
 * → csv; anything else → unknown. A UTF-16 text file (BOM FF FE / FE FF — Excel's "Unicode text")
 * is judged on its decoded text, since its raw bytes are full of NULs.
 */
export function sniffFormat(buf: Buffer): FileFormat {
  if (!buf.length) return "unknown";
  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46])) return "pdf";
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04])) return "xlsx";
  if (startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "xls";
  if (hasUtf16Bom(buf)) {
    const text = decodeText(buf.subarray(0, Math.min(buf.length, SNIFF_BYTES * 2)));
    if (looksHtml(text.slice(0, SNIFF_BYTES))) return "html";
    return text.includes("\u0000") ? "unknown" : "csv";
  }
  const head = buf.subarray(0, Math.min(buf.length, SNIFF_BYTES));
  if (head.includes(0)) return "unknown";
  const utf8Bom = startsWith(head, [0xef, 0xbb, 0xbf]);
  if (looksHtml(head.subarray(utf8Bom ? 3 : 0).toString("latin1"))) return "html";
  return "csv";
}

// windows-1252 bytes 0x80–0x9F (the rest of the code page equals Latin-1). Built by hand so the
// decode never depends on the ICU data a Node build carries.
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8d, 0x017d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178,
];

function decodeWindows1252(buf: Buffer): string {
  let out = "";
  const CHUNK = 8192;
  for (let start = 0; start < buf.length; start += CHUNK) {
    const codes: number[] = [];
    const end = Math.min(buf.length, start + CHUNK);
    for (let i = start; i < end; i++) {
      const b = buf[i];
      codes.push(b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80] : b);
    }
    out += String.fromCharCode(...codes);
  }
  return out;
}

/**
 * Bytes → text. A BOM decides (EF BB BF utf-8, FF FE utf-16le, FE FF utf-16be; the BOM is
 * dropped); otherwise strict UTF-8, and when that fails windows-1252 (what Excel on Windows
 * writes for "CSV").
 */
export function decodeText(buf: Buffer): string {
  if (startsWith(buf, [0xef, 0xbb, 0xbf])) return new TextDecoder("utf-8").decode(buf.subarray(3));
  if (startsWith(buf, [0xff, 0xfe])) return new TextDecoder("utf-16le").decode(buf.subarray(2));
  if (startsWith(buf, [0xfe, 0xff])) {
    const body = Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1)));
    body.swap16();
    return new TextDecoder("utf-16le").decode(body);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return decodeWindows1252(buf);
  }
}

const DELIMITERS = [",", ";", "\t", "|"] as const;
type Delimiter = (typeof DELIMITERS)[number];

/**
 * Pick the delimiter: for each candidate, count its occurrences OUTSIDE quotes on each of the
 * first 50 non-empty lines; the candidate whose most common per-line field count (≥ 2) holds on
 * the most lines wins; ties go to , ; \t | in that order. No candidate qualifies → ",".
 */
function detectDelimiter(text: string): Delimiter {
  const perLine: Array<Record<Delimiter, number>> = [];
  let counts: Record<Delimiter, number> = { ",": 0, ";": 0, "\t": 0, "|": 0 };
  let inQuotes = false;
  let nonEmpty = false;
  for (let i = 0; i < text.length && perLine.length < 50; i++) {
    const ch = text[i];
    if (ch === '"') { inQuotes = !inQuotes; nonEmpty = true; continue; }
    if (!inQuotes && (ch === "\n" || ch === "\r")) {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      if (nonEmpty) perLine.push(counts);
      counts = { ",": 0, ";": 0, "\t": 0, "|": 0 };
      nonEmpty = false;
      continue;
    }
    if (!inQuotes && (ch === "," || ch === ";" || ch === "\t" || ch === "|")) counts[ch]++;
    if (ch !== " ") nonEmpty = true;
  }
  if (nonEmpty && perLine.length < 50) perLine.push(counts);

  let best: Delimiter = ",";
  let bestScore = 0;
  for (const d of DELIMITERS) {
    const freq = new Map<number, number>();
    for (const c of perLine) {
      const fields = c[d] + 1;
      if (fields >= 2) freq.set(fields, (freq.get(fields) ?? 0) + 1);
    }
    let score = 0;
    for (const n of freq.values()) if (n > score) score = n;
    if (score > bestScore) { best = d; bestScore = score; }
  }
  return best;
}

function dropTrailingEmpty(rows: string[][]): string[][] {
  let lastRow = rows.length - 1;
  while (lastRow >= 0 && rows[lastRow].every((c) => c === "")) lastRow--;
  const kept = rows.slice(0, lastRow + 1);
  let width = 0;
  for (const r of kept) {
    for (let c = r.length - 1; c >= 0; c--) {
      if (r[c] !== "") { if (c + 1 > width) width = c + 1; break; }
    }
  }
  return kept.map((r) => (r.length > width ? r.slice(0, width) : r));
}

/**
 * Delimited text → rows of text cells (RFC 4180): quoted fields, "" inside quotes is one ",
 * CR / LF / CRLF end a record, newlines inside quotes are kept, and every cell stays exactly the
 * text it was ("0016" stays "0016"; nothing is trimmed). A blank line is a row of one "". Reading
 * stops after maxRows + ROW_HEADROOM rows; trailing empty rows and columns are dropped.
 */
export function parseDelimited(text: string, maxRows: number): { delimiter: "," | ";" | "\t" | "|"; rows: string[][] } {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const delimiter = detectDelimiter(src);
  const limit = maxRows + ROW_HEADROOM;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false; // inside a quoted section of the current field
  let i = 0;
  const n = src.length;
  const endRecord = () => {
    row.push(field);
    rows.push(row);
    row = [];
    field = "";
  };
  while (i < n && rows.length < limit) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === "") { quoted = true; i++; continue; }
    if (ch === delimiter) { row.push(field); field = ""; i++; continue; }
    if (ch === "\r" || ch === "\n") {
      endRecord();
      i += ch === "\r" && src[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += ch;
    i++;
  }
  if (rows.length < limit && (field !== "" || row.length > 0)) endRecord();
  return { delimiter, rows: dropTrailingEmpty(rows) };
}

/**
 * An Excel date serial → YYYY-MM-DD by the workbook calendar (46331 → "2026-11-05"); no JS Date, no
 * time zone. `date1904`: the workbook's 1904 date system (old Mac workbooks) — the same serial is
 * then 4 years and 1 day later, so it must come from the workbook, never be assumed.
 */
export function excelSerialToDay(n: number, date1904 = false): string | null {
  if (!Number.isFinite(n) || n < (date1904 ? 0 : 1) || n > 2_958_465) return null;
  const d = XLSX.SSF.parse_date_code(n, { date1904 });
  if (!d || !d.y || !d.m || !d.d) return null;
  return `${String(d.y).padStart(4, "0")}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
}

function cellText(cell: XLSX.CellObject | undefined, date1904: boolean): string {
  if (!cell) return "";
  switch (cell.t) {
    case "n": {
      const v = cell.v as number;
      if (!Number.isFinite(v)) return "";
      if (cell.z && XLSX.SSF.is_date(cell.z as string)) return excelSerialToDay(v, date1904) ?? String(Math.round(v * 1e6) / 1e6);
      return String(Math.round(v * 1e6) / 1e6);
    }
    case "s":
      return String(cell.v ?? "").trim().replace(/\s+/g, " ");
    case "b":
      return cell.v ? "TRUE" : "FALSE";
    default:
      return "";
  }
}

/** Largest total an XLSX's parts may unpack to. SheetJS inflates every sheet in full (sheetRows only limits what it keeps). */
export const MAX_UNZIPPED_BYTES = 64 * 1024 * 1024;

/**
 * The uncompressed size an XLSX (a ZIP) declares for all its parts, read from the central directory
 * without inflating anything; null when the buffer is not a well-formed ZIP (SheetJS then decides).
 * A ZIP64 size (0xFFFFFFFF) counts as Infinity. The sizes are the file's own claim: this stops an
 * honestly huge workbook and the common zip bomb, not a crafted file that lies in its headers —
 * callers still run openWorkbook for large files off the request path.
 */
export function zipUnpackedBytes(buf: Buffer): number | null {
  const EOCD = 0x06054b50;
  const CEN = 0x02014b50;
  if (buf.length < 22) return null;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const entries = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN) return null;
    const size = buf.readUInt32LE(p + 24);
    if (size === 0xffffffff) return Infinity;
    total += size;
    p += 46 + buf.readUInt16LE(p + 28) + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return total;
}

/**
 * An XLSX / XLS / HTML-table workbook. SheetJS reads at most maxRows + ROW_HEADROOM rows per sheet.
 * grid() walks each sheet cell by cell from A1 (so row numbers match the sheet) — not
 * sheet_to_json, which loses the number format: a date-formatted number → its ISO day, any other
 * number → plain decimal text without float noise, a string → trimmed and whitespace-collapsed,
 * a boolean → TRUE/FALSE, empty → "". Trailing empty rows and columns are dropped.
 * An HTML table's cells stay exactly the text shown (`raw: true` — no month-first date guessing).
 * A password-protected file → TabularError("encrypted"); anything else unreadable → "unreadable".
 */
export function openWorkbook(buf: Buffer, maxRows: number): { sheetNames: string[]; grid(sheet: string, maxCols?: number): string[][] } {
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04])) {
    const unpacked = zipUnpackedBytes(buf);
    if (unpacked !== null && unpacked > MAX_UNZIPPED_BYTES) {
      throw new TabularError("unreadable", `The spreadsheet is too large to read (over ${MAX_UNZIPPED_BYTES / 1024 / 1024} MB once unpacked) — export fewer rows or one period at a time`);
    }
  }
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buf, {
      type: "buffer",
      cellDates: false,
      cellNF: true,
      cellFormula: false,
      cellHTML: false,
      cellStyles: false,
      // raw: text formats (the HTML "XLS" banks send) keep every cell as typed — without it SheetJS
      // reads "05/11/2026" month-first as 11 May and "1,234.50" as a float. No effect on XLSX/XLS.
      raw: true,
      sheetRows: maxRows + ROW_HEADROOM,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Office encryption arrives as a CFB container ("File is password-protected"); a broken ZIP's
    // "Unsupported ZIP encryption" is garbage, not a protected workbook.
    if (/password/i.test(msg) || (/encrypt/i.test(msg) && !/zip/i.test(msg))) throw new TabularError("encrypted", "The file is password-protected");
    throw new TabularError("unreadable", "The file could not be read as a spreadsheet");
  }
  if (!wb?.SheetNames?.length) throw new TabularError("unreadable", "The file has no sheets");
  // The 1904 date system is a workbook setting (old Mac workbooks); a serial means another day under it.
  const date1904 = !!wb.Workbook?.WBProps?.date1904;
  return {
    sheetNames: [...wb.SheetNames],
    grid(sheet: string, maxCols: number = DEFAULT_MAX_COLS): string[][] {
      const ws = wb.Sheets[sheet];
      if (!ws || !ws["!ref"]) return [];
      const range = XLSX.utils.decode_range(ws["!ref"] as string);
      // The walk covers only where cells actually are (a stale !ref can claim far more).
      let lastRow = -1;
      let lastCol = -1;
      for (const key of Object.keys(ws)) {
        if (key[0] === "!") continue;
        const a = XLSX.utils.decode_cell(key);
        if (a.r > lastRow) lastRow = a.r;
        if (a.c > lastCol) lastCol = a.c;
      }
      lastRow = Math.min(lastRow, range.e.r, maxRows + ROW_HEADROOM - 1);
      lastCol = Math.min(lastCol, range.e.c, maxCols - 1);
      const rows: string[][] = [];
      for (let r = 0; r <= lastRow; r++) {
        const out: string[] = [];
        for (let c = 0; c <= lastCol; c++) out.push(cellText(ws[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined, date1904));
        rows.push(out);
      }
      return dropTrailingEmpty(rows);
    },
  };
}
