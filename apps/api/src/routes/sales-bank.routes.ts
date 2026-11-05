import { Router, type Request, type RequestHandler } from "express";
import {
  bankAccountCreateSchema, bankAccountUpdateSchema, bankConfirmSureSchema, bankIgnoreBeforeSchema, bankLineConfirmSchema,
  bankLineIgnoreSchema, bankLineLinkSchema, bankLineUnlinkSchema, bankStatementDeleteSchema, bankStatementImportSchema, bankStatementUploadSchema,
} from "@dashmani/shared";
import { validate } from "../middleware/validate";
import { AppError } from "../middleware/error-handler";
import { hasPermission } from "../middleware/rbac";
import { statementUpload } from "../middleware/statement-upload";
import { asyncHandler } from "../utils/async-handler";
import { success } from "../utils/response";
import { admin, companyOf, companyQuery, manage, staffId, str, view } from "./sales-route-kit";
import * as bank from "../services/sales/bank.service";

// Smart invoicing (PR 4) — Bank statement upload, auto-match and TDS.
// Spec: spec-bank.md (with spec-00-shared.md, which wins where they differ).
//
// Pre-mounted by PR 0 in routes/index.ts, directly after sales.routes.ts. Every route of this
// feature goes in THIS file, under /sales/bank/…, static paths before /:id. Gates and helpers
// come from ./sales-route-kit — never redefine them here.
//   view   (sales:view)    — accounts, statements, lines, suggestions
//   manage (sales:manage)  — preview/import, confirm, confirm-sure, link, unlink, ignore, reopen, rematch
//   admin  (sales:approve) — bank accounts, delete a statement; also sees withdrawal narrations

const router = Router();

/** SALES_BANK_ENABLED=0 → every write answers 503 BANK_OFF; reads keep working. */
const bankWritesEnabled: RequestHandler = (_req, _res, next) =>
  next(process.env.SALES_BANK_ENABLED === "0" ? new AppError(503, "BANK_OFF", "Bank statement matching is switched off on this server") : undefined);
const write = [bankWritesEnabled];
const seeDebits = async (req: Request) => ({ seeDebits: await hasPermission(staffId(req), "sales", "approve") });
const TABS = ["review", "sure", "matched", "ignored", "debits", "all"] as const;
const tabOf = (v: unknown): bank.BankTab => (TABS as readonly string[]).includes(String(v)) ? (v as bank.BankTab) : "review";

// Accounts
router.get("/sales/bank/accounts", ...view, asyncHandler(async (req, res) => success(res, await bank.listBankAccounts(companyQuery(req)))));
router.post("/sales/bank/accounts", ...admin, ...write, validate(bankAccountCreateSchema), asyncHandler(async (req, res) => success(res, await bank.createBankAccount(req.body, staffId(req)), undefined, 201)));
router.put("/sales/bank/accounts/:id", ...admin, ...write, validate(bankAccountUpdateSchema), asyncHandler(async (req, res) => success(res, await bank.updateBankAccount(req.params.id, req.body, staffId(req)))));

// Statements (preview writes nothing)
router.post("/sales/bank/statements/preview", ...manage, ...write, statementUpload, validate(bankStatementUploadSchema), asyncHandler(async (req, res) => success(res, await bank.previewStatement(req.file, req.body, companyOf(req)))));
router.post("/sales/bank/statements", ...manage, ...write, statementUpload, validate(bankStatementImportSchema), asyncHandler(async (req, res) => success(res, await bank.importStatement(req.file, req.body, companyOf(req), staffId(req)), undefined, 201)));
router.get("/sales/bank/statements", ...view, asyncHandler(async (req, res) => success(res, await bank.listStatements({ company: companyQuery(req), accountId: str(req.query.accountId) }))));
router.get("/sales/bank/statements/:id", ...view, asyncHandler(async (req, res) => success(res, await bank.getStatement(req.params.id, await seeDebits(req)))));
router.delete("/sales/bank/statements/:id", ...admin, ...write, validate(bankStatementDeleteSchema), asyncHandler(async (req, res) => success(res, await bank.deleteStatement(req.params.id, req.body.reason, staffId(req)))));

// Lines — static paths first
router.get("/sales/bank/lines", ...view, asyncHandler(async (req, res) =>
  success(res, await bank.listBankLines({ company: companyQuery(req), tab: tabOf(req.query.tab), accountId: str(req.query.accountId), statementId: str(req.query.statementId), q: str(req.query.q) }, await seeDebits(req)))));
router.post("/sales/bank/lines/confirm-sure", ...manage, ...write, validate(bankConfirmSureSchema), asyncHandler(async (req, res) => success(res, await bank.confirmSureLines(req.body.lineIds, staffId(req)))));
router.post("/sales/bank/lines/ignore-before", ...manage, ...write, validate(bankIgnoreBeforeSchema), asyncHandler(async (req, res) => success(res, await bank.ignoreUnmatchedBefore(companyOf(req), req.body, staffId(req)))));
router.post("/sales/bank/rematch", ...manage, ...write, asyncHandler(async (req, res) => success(res, await bank.rematchCompany(companyOf(req), staffId(req)))));
router.get("/sales/bank/lines/:id", ...view, asyncHandler(async (req, res) => success(res, await bank.getBankLine(req.params.id, await seeDebits(req)))));
router.get("/sales/bank/lines/:id/receipts", ...view, asyncHandler(async (req, res) => success(res, await bank.unlinkedReceiptsFor(req.params.id))));
router.post("/sales/bank/lines/:id/confirm", ...manage, ...write, validate(bankLineConfirmSchema), asyncHandler(async (req, res) => success(res, await bank.confirmBankLine(req.params.id, req.body, staffId(req)), undefined, 201)));
router.post("/sales/bank/lines/:id/link", ...manage, ...write, validate(bankLineLinkSchema), asyncHandler(async (req, res) => success(res, await bank.linkReceipt(req.params.id, req.body.paymentId, staffId(req)))));
router.post("/sales/bank/lines/:id/unlink", ...manage, ...write, validate(bankLineUnlinkSchema), asyncHandler(async (req, res) => success(res, await bank.unlinkReceipt(req.params.id, req.body, staffId(req)))));
router.post("/sales/bank/lines/:id/ignore", ...manage, ...write, validate(bankLineIgnoreSchema), asyncHandler(async (req, res) => success(res, await bank.ignoreBankLine(req.params.id, req.body, staffId(req)))));
router.post("/sales/bank/lines/:id/reopen", ...manage, ...write, asyncHandler(async (req, res) => success(res, await bank.reopenBankLine(req.params.id, staffId(req)))));

export default router;
