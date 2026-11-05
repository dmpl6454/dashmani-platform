import { csvCell } from "../report-links-csv.service";

// CSV writing for the sales exports (spec-00 §2.8): accounts' CSVs, import's check report, any
// later finance CSV. Money is written from integer paise with integer arithmetic only — never a
// float — so "-200.00" is exactly what the books say.

/** Paise → "1234.50" / "-200.00", exact for any integer (number or bigint). */
export function csvMoney(paise: number | bigint): string {
  if (typeof paise === "number" && !Number.isSafeInteger(paise)) throw new Error("[sales] csvMoney needs a whole number of paise");
  const p = BigInt(paise);
  const neg = p < 0n;
  const abs = neg ? -p : p;
  return `${neg ? "-" : ""}${abs / 100n}.${String(abs % 100n).padStart(2, "0")}`;
}

/**
 * One cell. A number (or bigint), or a string that is exactly a plain decimal ("-200.00", "0016"),
 * is written bare so a spreadsheet reads it as a number — a number can never be a formula. Everything
 * else goes through csvCell: RFC 4180 quoting plus the formula-injection guard (= + - @ prefixed).
 * ⚠️ An all-digit IDENTIFIER (account number, RRN, cheque "000123") comes out the same either way:
 * csvCell does not quote it, and Excel converts a quoted "000123" to 123 just the same when it
 * opens a .csv — quoting cannot keep it text. A feature that exports such a column keeps its
 * non-digit context (e.g. "••8788", "CHQ 000123") or documents that the column is an identifier.
 */
export function csvField(v: unknown): string {
  if (typeof v === "bigint") return String(v);
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) return v;
  return csvCell(v);
}

/** A whole CSV file: UTF-8 BOM (so Excel reads ₹ and names right), comma-separated, CRLF after every row. */
export function csvDocument(rows: ReadonlyArray<ReadonlyArray<unknown>>): Buffer {
  let out = "﻿";
  for (const r of rows) out += r.map(csvField).join(",") + "\r\n";
  return Buffer.from(out, "utf8");
}
