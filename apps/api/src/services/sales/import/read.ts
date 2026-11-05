import { decodeText, openWorkbook, parseDelimited, sniffFormat, TabularError } from "../tabular";
import { detectHeaderRow } from "./fields";

// Swipe import (spec-import §4.1): an uploaded export → one sheet as a grid of TEXT cells. Built on
// PR 0's tabular.ts (sniff / decode / RFC-4180 CSV / workbook walk); nothing is re-implemented here.
// The extension is never trusted: the bytes decide. Pure — a Buffer in, strings out.

export const IMPORT_MAX_COLS = 200;
export const IMPORT_MAX_CELL = 500;

export class ImportReadError extends Error {
  constructor(public code: "FILE_UNREADABLE" | "EMPTY_FILE", message: string) {
    super(message);
    this.name = "ImportReadError";
  }
}

export interface SourceTable {
  kind: "csv" | "xlsx" | "xls";
  sheetNames: string[];
  sheet: string | null;
  /** Every row of the chosen sheet; cells trimmed and capped, ≤ 200 columns, trailing empties dropped. */
  rows: string[][];
  /** The sheet had more than 200 columns (only the first 200 are kept). */
  columnsTruncated: boolean;
}

const UNREADABLE = "This file could not be read as CSV or Excel — export it again from Swipe";

function clean(rows: string[][]): { rows: string[][]; truncated: boolean } {
  let truncated = false;
  const out = rows.map((r) => {
    if (r.length > IMPORT_MAX_COLS) truncated = true;
    return r.slice(0, IMPORT_MAX_COLS).map((c) => {
      const t = (c ?? "").trim();
      return t.length > IMPORT_MAX_CELL ? t.slice(0, IMPORT_MAX_CELL) : t;
    });
  });
  // Trailing empty rows and columns.
  let last = out.length - 1;
  while (last >= 0 && out[last].every((c) => c === "")) last--;
  const kept = out.slice(0, last + 1);
  let width = 0;
  for (const r of kept) for (let c = r.length - 1; c >= 0; c--) if (r[c] !== "") { width = Math.max(width, c + 1); break; }
  return { rows: kept.map((r) => (r.length > width ? r.slice(0, width) : r)), truncated };
}

/**
 * Read the upload. `maxRows` bounds what is parsed (the caller counts body rows after finding the
 * heading row). The sheet is `sheet` when given, else the first sheet whose heading row is found,
 * else the first sheet.
 */
export function readSource(buf: Buffer, fileName: string, sheet: string | null | undefined, maxRows: number): SourceTable {
  const fmt = sniffFormat(buf);
  const ext = (/\.([a-z0-9]+)$/i.exec(fileName)?.[1] ?? "").toLowerCase();
  if (fmt !== "csv" && fmt !== "xlsx" && fmt !== "xls") throw new ImportReadError("FILE_UNREADABLE", UNREADABLE);
  // A .csv must hold text, an .xlsx/.xls a workbook (Excel's own "xls" sometimes holds an xlsx — both read the same).
  if ((ext === "csv") !== (fmt === "csv")) throw new ImportReadError("FILE_UNREADABLE", UNREADABLE);
  if (fmt === "csv") {
    let text: string;
    try { text = decodeText(buf); } catch { throw new ImportReadError("FILE_UNREADABLE", UNREADABLE); }
    const { rows, truncated } = clean(parseDelimited(text, maxRows).rows);
    if (!rows.some((r) => r.some((c) => c !== ""))) throw new ImportReadError("EMPTY_FILE", "This file has no rows");
    return { kind: "csv", sheetNames: ["CSV"], sheet: null, rows, columnsTruncated: truncated };
  }
  let wb: ReturnType<typeof openWorkbook>;
  try {
    wb = openWorkbook(buf, maxRows);
  } catch (e) {
    if (e instanceof TabularError && e.kind === "encrypted") throw new ImportReadError("FILE_UNREADABLE", "This file is password-protected — export it again from Swipe without a password");
    // tabular.ts's own sentence ("…too large to read (over 64 MB once unpacked) — export fewer rows…") tells the person what to do.
    if (e instanceof TabularError && e.kind === "unreadable" && /too large/i.test(e.message)) throw new ImportReadError("FILE_UNREADABLE", e.message);
    throw new ImportReadError("FILE_UNREADABLE", UNREADABLE);
  }
  const grids = new Map<string, { rows: string[][]; truncated: boolean }>();
  const gridOf = (name: string) => {
    if (!grids.has(name)) grids.set(name, clean(wb.grid(name, IMPORT_MAX_COLS + 1)));
    return grids.get(name)!;
  };
  let chosen: string;
  if (sheet && wb.sheetNames.includes(sheet)) chosen = sheet;
  else chosen = wb.sheetNames.find((n) => detectHeaderRow(gridOf(n).rows) !== null) ?? wb.sheetNames[0];
  const g = gridOf(chosen);
  if (!g.rows.some((r) => r.some((c) => c !== ""))) throw new ImportReadError("EMPTY_FILE", "This file has no rows");
  return { kind: fmt, sheetNames: wb.sheetNames, sheet: chosen, rows: g.rows, columnsTruncated: g.truncated };
}
