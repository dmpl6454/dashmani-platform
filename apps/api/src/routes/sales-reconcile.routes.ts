import { Router, type RequestHandler } from "express";
import {
  confirmationBatchSchema,
  confirmationCreateSchema,
  confirmationResponseSchema,
  confirmationSendSchema,
  defaultAsOf,
  fyStartOf,
  gstUploadSchema,
  RECON_MAX_BYTES,
  SALES_COMPANIES,
  tdsDeductorSchema,
  tdsUploadSchema,
  todayIST,
} from "@dashmani/shared";
import { prisma } from "@dashmani/db";
import { validate } from "../middleware/validate";
import { AppError } from "../middleware/error-handler";
import { memoryUpload } from "../middleware/upload-private";
import { asyncHandler } from "../utils/async-handler";
import { success } from "../utils/response";
import { companyOf, companyQuery, manage, sendDownload, staffId, str, view } from "./sales-route-kit";
import { getSellerOrDefaults } from "../services/sales/settings.service";
import { RECON_FILE_PDF_GST, RECON_FILE_PDF_TDS, RECON_FILE_ZIP_GST, RECON_FILE_ZIP_TDS } from "../services/sales/recon/files";
import { getTdsRecon, uploadTds } from "../services/sales/recon/tds.service";
import { getGstRecon, uploadGstr1 } from "../services/sales/recon/gst.service";
import { mapDeductor, unmapDeductor } from "../services/sales/recon/tan";
import { gstDifferencesCsv, tdsChaseCsv } from "../services/sales/recon/recon-csv";
import {
  attachReply,
  confirmationPdf,
  createConfirmation,
  getConfirmation,
  getLedger,
  getReplyFile,
  ledgerPdf,
  listConfirmations,
  recordResponse,
  removeReply,
  sendBatch,
  sendConfirmation,
} from "../services/sales/recon/confirm.service";

// Smart invoicing (PR 5) — the /reconcile page: TDS vs Form 26AS, GSTR-1 vs the portal's documents,
// client balance confirmations. Spec: spec-reconcile.md (with spec-00-shared.md §9).
//
// Every route lives under /sales/reconcile/…, static paths before /:id. Gates: view (sales:view)
// every GET incl. downloads; manage (sales:manage) uploads, TAN mapping, confirmations. Writes run
// gate → reconOn → upload → validate → handler, so a 10 MB body from someone without
// sales:manage is never buffered. Nothing here writes a money table (D2).

const router = Router();

/** Kill switch: SALES_RECONCILE_ENABLED=0 → uploads, sends, batch and reply files answer 503. */
const reconOn: RequestHandler = (_req, _res, next) => {
  if (process.env.SALES_RECONCILE_ENABLED === "0") return next(new AppError(503, "RECONCILE_OFF", "Reconciliation uploads, emails and sign-offs are switched off on this server."));
  next();
};

const tooLarge = new AppError(413, "FILE_TOO_LARGE", "That file is larger than 10 MB — download one year (26AS) or one month (GSTR-1) at a time.");
const tdsUpload = memoryUpload({
  maxBytes: RECON_MAX_BYTES, accept: /\.(txt|csv|tsv|xlsx|xls)$/i, tooLarge,
  refuse: (n) => (/\.pdf$/i.test(n) ? RECON_FILE_PDF_TDS() : /\.zip$/i.test(n) ? RECON_FILE_ZIP_TDS() : null),
  wrongType: new AppError(415, "RECON_FILE_TYPE", "Upload Form 26AS as the text file from TRACES (.txt), or the AIS CSV."),
});
const gstUpload = memoryUpload({
  maxBytes: RECON_MAX_BYTES, accept: /\.(json|csv|xlsx|xls)$/i, tooLarge,
  refuse: (n) => (/\.pdf$/i.test(n) ? RECON_FILE_PDF_GST() : /\.zip$/i.test(n) ? RECON_FILE_ZIP_GST() : null),
  wrongType: new AppError(415, "RECON_FILE_TYPE", "Upload the GSTR-1 JSON from the GST portal, or its Excel/CSV b2b and cdnr sheets."),
});
const replyUpload = memoryUpload({
  maxBytes: RECON_MAX_BYTES, accept: /\.(pdf|png|jpe?g)$/i,
  wrongType: new AppError(415, "REPLY_FILE_TYPE", "Attach the client's reply as a PDF, PNG or JPEG."),
  tooLarge: new AppError(413, "FILE_TOO_LARGE", "The reply file is larger than 10 MB."),
});

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const dayParam = (v: unknown, name: string, fallback: string): string => {
  const s = str(v) ?? fallback;
  if (!DAY.test(s) || new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) !== s) throw new AppError(400, "VALIDATION_ERROR", `${name}: use a real day, YYYY-MM-DD`);
  return s;
};
async function actorName(req: Parameters<RequestHandler>[0]): Promise<string> {
  const u = await prisma.user.findUnique({ where: { id: staffId(req) }, select: { name: true } });
  return u?.name ?? "staff";
}

// ─── TDS (routes 1–5) ────────────────────────────────────────────────────────────────────────

router.get("/sales/reconcile/tds", ...view, asyncHandler(async (req, res) => success(res, await getTdsRecon(companyOf(req), str(req.query.fy), todayIST()))));

router.post("/sales/reconcile/tds/uploads", ...manage, reconOn, tdsUpload, validate(tdsUploadSchema), asyncHandler(async (req, res) => {
  const out = await uploadTds(req.file, req.body, companyOf(req), staffId(req));
  return success(res, out.result, undefined, out.status);
}));

router.get("/sales/reconcile/tds/chase.csv", ...view, asyncHandler(async (req, res) => {
  const company = companyOf(req);
  const v = await getTdsRecon(company, str(req.query.fy), todayIST());
  const seller = await getSellerOrDefaults(company);
  const out = tdsChaseCsv(v, { legalName: seller.legalName || SALES_COMPANIES[company].name, by: await actorName(req), now: new Date() });
  return sendDownload(res, out.body, { contentType: "text/csv; charset=utf-8", filename: out.filename });
}));

router.put("/sales/reconcile/tds/deductors/:tan", ...manage, validate(tdsDeductorSchema), asyncHandler(async (req, res) => {
  const tan = String(req.params.tan).trim().toUpperCase();
  if (!/^[A-Z]{4}\d{5}[A-Z]$/.test(tan)) throw new AppError(400, "VALIDATION_ERROR", "A TAN is 4 letters, 5 digits and a letter, like MUMF12345A");
  return success(res, await mapDeductor(tan, req.body, staffId(req)));
}));
router.delete("/sales/reconcile/tds/deductors/:tan", ...manage, asyncHandler(async (req, res) => success(res, await unmapDeductor(String(req.params.tan), staffId(req)))));

// ─── GST (routes 6–8) ────────────────────────────────────────────────────────────────────────

router.get("/sales/reconcile/gst", ...view, asyncHandler(async (req, res) => success(res, await getGstRecon(companyOf(req), str(req.query.gstin), str(req.query.period), todayIST()))));

router.post("/sales/reconcile/gst/uploads", ...manage, reconOn, gstUpload, validate(gstUploadSchema), asyncHandler(async (req, res) => {
  const out = await uploadGstr1(req.file, req.body, companyOf(req), staffId(req), todayIST());
  return success(res, out.result, undefined, out.status);
}));

router.get("/sales/reconcile/gst/differences.csv", ...view, asyncHandler(async (req, res) => {
  const company = companyOf(req);
  const v = await getGstRecon(company, str(req.query.gstin), str(req.query.period), todayIST());
  const seller = await getSellerOrDefaults(company);
  const out = gstDifferencesCsv(v, { legalName: seller.legalName || SALES_COMPANIES[company].name, by: await actorName(req), now: new Date() });
  return sendDownload(res, out.body, { contentType: "text/csv; charset=utf-8", filename: out.filename });
}));

// ─── Client balances (routes 9–20) ───────────────────────────────────────────────────────────

router.get("/sales/reconcile/confirmations", ...view, asyncHandler(async (req, res) => {
  const today = todayIST();
  const asOf = dayParam(req.query.asOf, "asOf", defaultAsOf(today));
  const from = dayParam(req.query.from, "from", fyStartOf(asOf));
  return success(res, await listConfirmations(companyOf(req), asOf, from, today));
}));

router.post("/sales/reconcile/confirmations", ...manage, reconOn, validate(confirmationCreateSchema), asyncHandler(async (req, res) => {
  const out = await createConfirmation(req.body, staffId(req), todayIST());
  return success(res, out.result, undefined, out.status);
}));

router.post("/sales/reconcile/confirmations/send-batch", ...manage, reconOn, validate(confirmationBatchSchema), asyncHandler(async (req, res) => {
  return success(res, await sendBatch(req.body, staffId(req), todayIST()), undefined, 202);
}));

router.get("/sales/reconcile/ledger", ...view, asyncHandler(async (req, res) => {
  const clientId = str(req.query.clientId);
  if (!clientId) throw new AppError(400, "VALIDATION_ERROR", "clientId is required");
  const today = todayIST();
  const to = dayParam(req.query.to, "to", today);
  const from = dayParam(req.query.from, "from", fyStartOf(to));
  return success(res, await getLedger(companyOf(req), clientId, from, to, today));
}));

router.get("/sales/reconcile/ledger.pdf", ...view, asyncHandler(async (req, res) => {
  const clientId = str(req.query.clientId);
  if (!clientId) throw new AppError(400, "VALIDATION_ERROR", "clientId is required");
  const today = todayIST();
  const to = dayParam(req.query.to, "to", today);
  const from = dayParam(req.query.from, "from", fyStartOf(to));
  const out = await ledgerPdf(companyOf(req), clientId, from, to, today);
  return sendDownload(res, out.pdf, { contentType: "application/pdf", filename: out.filename, inline: req.query.inline === "1" });
}));

router.get("/sales/reconcile/confirmations/:id", ...view, asyncHandler(async (req, res) => success(res, await getConfirmation(req.params.id, companyQuery(req)))));

router.post("/sales/reconcile/confirmations/:id/send", ...manage, reconOn, validate(confirmationSendSchema), asyncHandler(async (req, res) => {
  return success(res, await sendConfirmation(req.params.id, req.body, staffId(req), companyQuery(req), todayIST()));
}));

router.put("/sales/reconcile/confirmations/:id/response", ...manage, validate(confirmationResponseSchema), asyncHandler(async (req, res) => {
  return success(res, await recordResponse(req.params.id, req.body, staffId(req), companyQuery(req), todayIST()));
}));

router.get("/sales/reconcile/confirmations/:id/pdf", ...view, asyncHandler(async (req, res) => {
  const out = await confirmationPdf(req.params.id, companyQuery(req));
  return sendDownload(res, out.pdf, { contentType: "application/pdf", filename: out.filename, inline: req.query.inline === "1" });
}));

router.post("/sales/reconcile/confirmations/:id/file", ...manage, reconOn, replyUpload, asyncHandler(async (req, res) => {
  return success(res, await attachReply(req.params.id, req.file, staffId(req), companyQuery(req)), undefined, 201);
}));
router.get("/sales/reconcile/confirmations/:id/file", ...view, asyncHandler(async (req, res) => {
  const f = await getReplyFile(req.params.id, companyQuery(req));
  return sendDownload(res, f.data, { contentType: f.contentType, filename: f.fileName, inline: req.query.inline === "1" });
}));
router.delete("/sales/reconcile/confirmations/:id/file", ...manage, asyncHandler(async (req, res) => success(res, await removeReply(req.params.id, staffId(req), companyQuery(req)))));

// ─── BRS (PR 6) ───

export default router;
