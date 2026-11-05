import express, { Router, type RequestHandler } from "express";
import { FILED_FILE_KINDS, FILED_MIN_FY, filedYearSchema, financialYear, fyBounds, todayIST } from "@dashmani/shared";
import { validate } from "../middleware/validate";
import { AppError } from "../middleware/error-handler";
import { sha256Hex } from "../middleware/upload-private";
import { asyncHandler } from "../utils/async-handler";
import { success } from "../utils/response";
import { admin, companyOf, sendDownload, staffId, str, view } from "./sales-route-kit";
import { buildGstCsv, buildTdsCsv, getAccounts, GST_LAYOUTS, type GstLayout } from "../services/sales/accounts.service";
import {
  addFiledFile,
  assertFyClosed,
  FILED_FILE_MAX_BYTES,
  getFiledFile,
  listFiledYears,
  removeFiledFile,
  saveFiledYear,
} from "../services/sales/filed.service";

// Smart invoicing (PR 1) — Accounts page — GST, TDS, receivables and the filed balance sheet + P&L.
// Spec: spec-accounts.md (with spec-00-shared.md, which wins where they differ).
//
// Pre-mounted by PR 0 in routes/index.ts, directly after sales.routes.ts. Every route of this
// feature goes in THIS file, under /sales/accounts/…, static paths before /:id. Gates and helpers
// (view / manage / admin, staffId, str, companyQuery, companyOf, sendDownload) come from
// ./sales-route-kit — never redefine them here.
//
// Read-only over the sales tables: live figures are SQL aggregates (accounts.service.ts). The only
// writes are the filed figures and their signed PDFs (finance_filed_*), admin only. PDF bytes are
// kept in Postgres (BYTEA) — they never touch uploads/ or the disk.

const router = Router();

/** ?fy=2025-26 (default: the current FY). Not in the future, not before 2010-11. */
const fyParam = (v: unknown): string => {
  const s = str(v) ?? financialYear(todayIST()).label;
  const b = fyBounds(s);
  if (!b) throw new AppError(400, "BAD_FY", "Pick a financial year like 2025-26.");
  if (b.startDay > todayIST()) throw new AppError(400, "BAD_FY", `${s} hasn't started yet.`);
  if (b.startDay < fyBounds(FILED_MIN_FY)!.startDay) throw new AppError(400, "BAD_FY", "Financial years before 2010-11 are not kept here.");
  return s;
};

// A signed PDF arrives as the raw request body (Content-Type: application/pdf) — no multer, no
// FormData. The gates run first, so an unauthorised 10 MB POST is never buffered; the global
// express.json() ignores application/pdf, so the stream is still unread here.
const pdfParser = express.raw({ type: "application/pdf", limit: FILED_FILE_MAX_BYTES });
const pdfBody: RequestHandler = (req, res, next) =>
  pdfParser(req, res, (err?: unknown) => {
    const e = err as { type?: string } | undefined;
    if (e?.type === "entity.too.large") {
      return next(new AppError(413, "FILE_TOO_LARGE", "That PDF is larger than 10 MB. Save a smaller copy (print to PDF, or scan at 150 dpi) and attach that."));
    }
    if (err) return next(new AppError(400, "INVALID_UPLOAD", "The PDF didn't arrive in one piece — try attaching it again."));
    next();
  });

/** The name a PDF is stored under: safe characters, ≤ 200 with ".pdf"; blank → signed-accounts-<fy>.pdf. */
function pdfName(raw: unknown, fy: string): string {
  const s = (str(raw) ?? "").replace(/[^\w .()-]+/g, "-").trim().slice(0, 196);
  if (!s) return `signed-accounts-${fy}.pdf`;
  return /\.pdf$/i.test(s) ? s : `${s}.pdf`;
}

// 1. The page: every live figure for one company × FY, in one read-only snapshot.
router.get("/sales/accounts", ...view, asyncHandler(async (req, res) => {
  const company = companyOf(req);
  return success(res, await getAccounts(company, fyParam(req.query.fy)));
}));

// 2. GSTR-1 B2B / CDNR working papers and the full sales register (CSV).
router.get("/sales/accounts/gst.csv", ...view, asyncHandler(async (req, res) => {
  const company = companyOf(req);
  const period = str(req.query.period);
  if (!period) throw new AppError(400, "BAD_PERIOD", "Pick a month (2026-10), a quarter (2026-27-Q3) or a year (2026-27).");
  const layout = (str(req.query.layout) ?? "register") as GstLayout;
  if (!GST_LAYOUTS.includes(layout)) throw new AppError(400, "BAD_LAYOUT", "Pick a layout: b2b, cdnr or register.");
  const out = await buildGstCsv(company, period, layout, str(req.query.gstin) ?? null);
  return sendDownload(res, out.body, { contentType: "text/csv; charset=utf-8", filename: out.filename });
}));

// 3. TDS deducted by clients, per client × quarter (CSV for Form 26AS / AIS matching).
router.get("/sales/accounts/tds.csv", ...view, asyncHandler(async (req, res) => {
  const company = companyOf(req);
  const out = await buildTdsCsv(company, fyParam(req.query.fy));
  return sendDownload(res, out.body, { contentType: "text/csv; charset=utf-8", filename: out.filename });
}));

// 4. Filed years of one company, newest first; files listed WITHOUT their bytes.
router.get("/sales/accounts/filed", ...view, asyncHandler(async (req, res) => success(res, await listFiledYears(companyOf(req)))));

// 7 / 8. One signed PDF — declared before /sales/accounts/filed/:fy so "files" is never read as a FY.
router.get("/sales/accounts/filed/files/:fileId", ...view, asyncHandler(async (req, res) => {
  const f = await getFiledFile(req.params.fileId);
  return sendDownload(res, f.data, { contentType: "application/pdf", filename: f.fileName, inline: req.query.inline === "1" });
}));
router.delete("/sales/accounts/filed/files/:fileId", ...admin, asyncHandler(async (req, res) => success(res, await removeFiledFile(req.params.fileId, staffId(req)))));

// 5. Save the 12 figures, the unit and the notes of a CLOSED year (full replace).
router.put("/sales/accounts/filed/:fy", ...admin, validate(filedYearSchema), asyncHandler(async (req, res) => {
  const company = companyOf(req);
  const fy = fyParam(req.params.fy);
  assertFyClosed(fy, todayIST());
  return success(res, await saveFiledYear(company, fy, req.body, staffId(req)));
}));

// 6. Attach a signed PDF (raw body). The first attach creates the year's row.
router.post("/sales/accounts/filed/:fy/files", ...admin, pdfBody, asyncHandler(async (req, res) => {
  const company = companyOf(req);
  const body = req.body as unknown;
  if (!Buffer.isBuffer(body)) throw new AppError(415, "FILE_NOT_PDF", "That file isn't a PDF. Save the signed accounts as a PDF and attach that.");
  if (body.length === 0) throw new AppError(400, "FILE_EMPTY", "That file is empty — pick the signed PDF again.");
  if (body.subarray(0, 1024).indexOf("%PDF-") === -1) throw new AppError(415, "FILE_NOT_PDF", "That file isn't a PDF. Save the signed accounts as a PDF and attach that.");
  const kind = str(req.query.kind) ?? "accounts";
  if (!(FILED_FILE_KINDS as readonly string[]).includes(kind)) throw new AppError(400, "BAD_FILE_KIND", "Choose what this PDF is: signed accounts, auditor's report or other.");
  const fy = fyParam(req.params.fy);
  assertFyClosed(fy, todayIST());
  const sha256 = sha256Hex(body);
  const out = await addFiledFile(company, fy, { kind, name: pdfName(req.query.name, fy), bytes: body, sha256 }, staffId(req));
  return success(res, out, undefined, out.duplicate ? 200 : 201);
}));

export default router;
