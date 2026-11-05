import { AppError } from "./error-handler";
import { memoryUpload } from "./upload-private"; // PR 0: memoryStorage only — never the public uploads/

// Bank statement upload (spec-bank §3.2): one file under "file", read in memory and never stored.
// SALES_BANK_MAX_FILE_MB (default 5) is clamped to 1–10 — one month of a busy account is well under 1 MB.
const maxMb = () => Math.min(10, Math.max(1, Number(process.env.SALES_BANK_MAX_FILE_MB) || 5));

export const statementUpload = memoryUpload({
  maxBytes: maxMb() * 1024 * 1024,
  accept: /\.(csv|txt|tsv|xls|xlsx|htm|html)$/i,
  refuse: (name) =>
    /\.pdf$/i.test(name)
      ? new AppError(415, "STATEMENT_PDF", "PDF statements cannot be read — download the same statement as Excel or CSV from net banking and upload that")
      : null,
  wrongType: new AppError(415, "STATEMENT_FORMAT", "Upload the statement as CSV or Excel (.csv, .xls, .xlsx) exactly as net banking gives it"),
  tooLarge: new AppError(413, "FILE_TOO_LARGE", `The statement is larger than ${maxMb()} MB — download one month at a time`),
});
