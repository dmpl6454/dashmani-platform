import { Router, type RequestHandler } from "express";
import { importApplySchema, importClientsSchema, importMappingSchema, importUndoSchema, importUploadSchema } from "@dashmani/shared";
import { validate } from "../middleware/validate";
import { AppError } from "../middleware/error-handler";
import { uploadImportFile } from "../middleware/upload-private";
import { asyncHandler } from "../utils/async-handler";
import { success } from "../utils/response";
import * as imports from "../services/sales/imports.service";
import { admin, companyQuery, manage, sendDownload, staffId, str, view } from "./sales-route-kit";

// Smart invoicing (PR 3) — Import old invoices from Swipe.
// Spec: spec-import.md (with spec-00-shared.md, which wins where they differ).
//
// Pre-mounted by PR 0 in routes/index.ts, directly after sales.routes.ts. Every route of this
// feature goes in THIS file, under /sales/imports/…, static paths before /:id. Gates and helpers
// (view / manage / admin, staffId, str, companyQuery, companyOf, sendDownload) come from
// ./sales-route-kit — never redefine them here.
//
// view = see imports, the check, the report; manage = upload, columns, clients, check again,
// discard a draft; admin (sales:approve) = Import / resume and Undo.

const router = Router();
/** An import id is a uuid; anything else under /sales/imports/ falls through (never "Import not found" for a static path). */

/** Kill switch: SALES_IMPORT_ENABLED=0 stops new work; GETs and undo still answer so an Admin can always back out. */
const importsOn: RequestHandler = (_req, _res, next) => {
  if (!imports.importsEnabled()) return next(new AppError(503, "IMPORT_OFF", "Importing old invoices is switched off on this server right now"));
  next();
};

const num = (v: unknown) => {
  const s = str(v);
  if (s === undefined) return undefined;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0) throw new AppError(400, "BAD_QUERY", "Expected a whole number");
  return n;
};

router.get("/sales/imports", ...view, asyncHandler(async (req, res) => success(res, await imports.listImports({ companyKey: companyQuery(req) }))));

router.post("/sales/imports", ...manage, importsOn, uploadImportFile, validate(importUploadSchema), asyncHandler(async (req, res) => {
  const file = req.file ? { buffer: req.file.buffer, originalname: req.file.originalname, size: req.file.size } : undefined;
  return success(res, await imports.createImport(file, req.body, staffId(req)), undefined, 201);
}));

// Suffixed routes before /sales/imports/:id.
router.get("/sales/imports/:id([0-9a-fA-F-]{36})/invoices", ...view, asyncHandler(async (req, res) => success(res, await imports.listImportInvoices(req.params.id, {
  outcome: str(req.query.outcome), q: str(req.query.q), from: num(req.query.from), limit: num(req.query.limit),
}))));

router.get("/sales/imports/:id([0-9a-fA-F-]{36})/report.csv", ...view, asyncHandler(async (req, res) => {
  const { body, filename } = await imports.importReportCsv(req.params.id);
  return sendDownload(res, body, { contentType: "text/csv; charset=utf-8", filename });
}));

router.put("/sales/imports/:id([0-9a-fA-F-]{36})/mapping", ...manage, importsOn, validate(importMappingSchema), asyncHandler(async (req, res) => success(res, await imports.saveMapping(req.params.id, req.body, staffId(req)))));
router.put("/sales/imports/:id([0-9a-fA-F-]{36})/clients", ...manage, importsOn, validate(importClientsSchema), asyncHandler(async (req, res) => success(res, await imports.saveClientChoices(req.params.id, req.body, staffId(req)))));
router.post("/sales/imports/:id([0-9a-fA-F-]{36})/check", ...manage, importsOn, asyncHandler(async (req, res) => success(res, await imports.runCheck(req.params.id, staffId(req)))));
router.post("/sales/imports/:id([0-9a-fA-F-]{36})/apply", ...admin, importsOn, validate(importApplySchema), asyncHandler(async (req, res) => success(res, await imports.startApply(req.params.id, req.body, staffId(req)), undefined, 202)));
router.post("/sales/imports/:id([0-9a-fA-F-]{36})/undo", ...admin, validate(importUndoSchema), asyncHandler(async (req, res) => success(res, await imports.undoImport(req.params.id, req.body.reason, staffId(req)))));
router.delete("/sales/imports/:id([0-9a-fA-F-]{36})", ...manage, asyncHandler(async (req, res) => success(res, await imports.discardImport(req.params.id, staffId(req)))));
router.get("/sales/imports/:id([0-9a-fA-F-]{36})", ...view, asyncHandler(async (req, res) => success(res, await imports.getImport(req.params.id))));

export default router;
