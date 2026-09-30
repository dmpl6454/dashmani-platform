/** A plain signed integer or decimal — the only shape a spreadsheet must read as a number. */
const NUMERIC = /^-?\d+(\.\d+)?$/;

/**
 * One CSV field, RFC-4180 quoted and guarded against formula injection.
 *
 * ⚠️ The leading-apostrophe guard matters: a name like "=HYPERLINK(...)" would EXECUTE
 * when the file is opened in Excel or Sheets. It must NOT touch numbers (a number can
 * never be a formula, and `'-3` is text that cannot be summed) — the same rule as the
 * Account Growth export's csvCell.
 */
export function csvCell(v: unknown): string {
  let str = v == null ? "" : String(v);
  if (!NUMERIC.test(str) && /^[=+\-@\t\r]/.test(str)) str = "'" + str;
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

/** Build and download a UTF-8 CSV (with BOM so Excel reads non-Latin names correctly). */
export function downloadCsv(filename: string, header: string[], rows: unknown[][]): void {
  if (typeof window === "undefined") return;
  const csv = "﻿" + [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8;" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
