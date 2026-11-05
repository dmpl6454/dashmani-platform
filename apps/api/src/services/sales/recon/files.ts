import { RECON_MAX_ROWS } from "@dashmani/shared";
import { AppError } from "../../../middleware/error-handler";
import { decodeText, openWorkbook, parseDelimited, TabularError } from "../tabular";
import { sniffRecon } from "./read";
import { detect26asDelimiter, parse26asText, parseTdsSheet, type TdsItem } from "./parse-26as";
import { parseGstr1Json, parseGstr1Sheets, type Gstr1Report } from "./parse-gstr1";
import type { ParseReport } from "./read";

// Bytes → a parse report, by what the bytes ARE (the file name is only a hint, checked earlier by
// memoryUpload). Pure and synchronous; the service runs it inside withParseSlot.

export const RECON_FILE_PDF_TDS = () => new AppError(415, "RECON_FILE_PDF", "PDFs can't be read — on TRACES choose View As Text, then Export as Text.");
export const RECON_FILE_ZIP_TDS = () => new AppError(415, "RECON_FILE_ZIP", "That is the zip from TRACES — open it (the password is the company's date of incorporation, DDMMYYYY) and upload the .txt inside.");
export const RECON_FILE_PDF_GST = () => new AppError(415, "RECON_FILE_PDF", "PDFs can't be read — download the JSON (or Excel) from the GST portal.");
export const RECON_FILE_ZIP_GST = () => new AppError(415, "RECON_FILE_ZIP", "That is the zip from the GST portal — open it and upload the .json inside.");
const TDS_TYPE = () => new AppError(415, "RECON_FILE_TYPE", "Upload Form 26AS as the text file from TRACES (.txt), or the AIS CSV.");
const GST_TYPE = () => new AppError(415, "RECON_FILE_TYPE", "Upload the GSTR-1 JSON from the GST portal, or its Excel/CSV b2b and cdnr sheets.");
const unreadableTds = () => new AppError(422, "RECON_FILE_UNREADABLE", "No TDS entries were found — is this Form 26AS (TRACES 'Export as Text') or the AIS TDS CSV?");
const unreadableGst = () => new AppError(422, "RECON_FILE_UNREADABLE", "No GSTR-1 invoices or notes were found — is this the GSTR-1 JSON or its b2b/cdnr sheet?");

function workbookOr(buf: Buffer, unreadable: () => AppError) {
  try {
    return openWorkbook(buf, RECON_MAX_ROWS);
  } catch (err) {
    if (err instanceof TabularError) throw new AppError(422, "RECON_FILE_UNREADABLE", err.kind === "encrypted" ? "The spreadsheet is password-protected — save it without a password and upload it again." : unreadable().message);
    throw err;
  }
}

export function readTdsFile(buf: Buffer): ParseReport<TdsItem> {
  const kind = sniffRecon(buf);
  if (kind === "pdf") throw RECON_FILE_PDF_TDS();
  if (kind === "zip") throw RECON_FILE_ZIP_TDS();
  if (kind === "json" || kind === "unknown") throw TDS_TYPE();
  if (kind === "xlsx" || kind === "xls") {
    const wb = workbookOr(buf, unreadableTds);
    return parseTdsSheet(wb.grid(wb.sheetNames[0]));
  }
  const text = decodeText(buf);
  const d = detect26asDelimiter(text);
  if (d) return parse26asText(text, d);
  return parseTdsSheet(parseDelimited(text, RECON_MAX_ROWS).rows);
}

export function readGstr1File(buf: Buffer): Gstr1Report {
  const kind = sniffRecon(buf);
  if (kind === "pdf") throw RECON_FILE_PDF_GST();
  if (kind === "zip") throw RECON_FILE_ZIP_GST();
  if (kind === "unknown") throw GST_TYPE();
  if (kind === "json") {
    let obj: unknown;
    try {
      obj = JSON.parse(decodeText(buf));
    } catch {
      throw unreadableGst();
    }
    return parseGstr1Json(obj);
  }
  if (kind === "xlsx" || kind === "xls") {
    const wb = workbookOr(buf, unreadableGst);
    return parseGstr1Sheets(wb.sheetNames.map((name) => ({ name, rows: wb.grid(name) })), kind);
  }
  return parseGstr1Sheets([{ name: "", rows: parseDelimited(decodeText(buf), RECON_MAX_ROWS).rows }], "csv");
}
