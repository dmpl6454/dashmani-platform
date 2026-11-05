import { Router } from "express";
import {
  tallyPartyApplySchema, tallyPartyMatchSchema, tallyPartyUpdateSchema, tallyPreviewQuerySchema, tallyReasonSchema, tallyResolveSchema,
  tallyRunConfirmSchema, tallyRunCreateSchema, tallySettingsSchema, TALLY_DOC_TYPES, type TallyDocType,
} from "@dashmani/shared";
import { validate } from "../middleware/validate";
import { AppError } from "../middleware/error-handler";
import { hasPermission } from "../middleware/rbac";
import { asyncHandler } from "../utils/async-handler";
import { success } from "../utils/response";
import { admin, companyOf, manage, sendDownload, staffId, str, view } from "./sales-route-kit";
import { getTallySettingsView, saveTallySettings } from "../services/sales/tally/settings";
import {
  confirmTallyRun, createTallyRun, discardTallyRun, getTallyRun, listTallyRuns, previewTally, resolveByHand, tallyDocStatus, tallyRunFile,
} from "../services/sales/tally/export.service";
import { applyTallyParties, listTallyParties, matchTallyParties, setTallyParty } from "../services/sales/tally/parties";
import { assertPushEnabled, closeTallyRun, readTallyLedgers, retryTallyPush, startTallyPush, testTallyConnection } from "../services/sales/tally/push.service";

// Smart invoicing (PR 2) — Tally XML export and Send to Tally.
// Spec: spec-tally.md (with spec-00-shared.md, which wins where they differ).
//
// Pre-mounted by PR 0 in routes/index.ts, directly after sales.routes.ts. Every route of this
// feature goes in THIS file, under /sales/tally/…, static paths before /:id. Gates and helpers
// (view / manage / admin, staffId, str, companyQuery, companyOf, sendDownload) come from
// ./sales-route-kit — never redefine them here. Every AppError here carries NO details (portal
// rule: the sentence is the message); zod's VALIDATION_ERROR keeps its per-field details.

const router = Router();

// Settings (1–3)
router.get("/sales/tally/settings", ...view, asyncHandler(async (req, res) => success(res, await getTallySettingsView(companyOf(req)))));
router.put("/sales/tally/settings", ...admin, validate(tallySettingsSchema), asyncHandler(async (req, res) => success(res, await saveTallySettings(companyOf(req), req.body, staffId(req)))));
router.post("/sales/tally/test", ...admin, asyncHandler(async (req, res) => success(res, await testTallyConnection(companyOf(req)))));

// Preview and runs (4–13)
router.get("/sales/tally/preview", ...view, validate(tallyPreviewQuerySchema, "query"), asyncHandler(async (req, res) => {
  const q = req.query as unknown as { company: "dspl" | "dmpl"; from: string; to: string; gstin?: string; mode: "new_only" | "everything" };
  success(res, await previewTally({ company: q.company, from: q.from, to: q.to, gstin: q.gstin ?? null, mode: q.mode }));
}));
router.post("/sales/tally/runs", ...manage, validate(tallyRunCreateSchema), asyncHandler(async (req, res) => success(res, await createTallyRun(req.body, "file", staffId(req)), undefined, 201)));
router.post("/sales/tally/pushes", ...admin, (_req, _res, next) => { assertPushEnabled(); next(); }, validate(tallyRunCreateSchema), asyncHandler(async (req, res) => success(res, await startTallyPush(req.body, staffId(req)), undefined, 202)));
router.get("/sales/tally/runs", ...view, asyncHandler(async (req, res) => success(res, await listTallyRuns(companyOf(req)))));
router.get("/sales/tally/runs/:id", ...view, asyncHandler(async (req, res) => success(res, await getTallyRun(req.params.id))));
router.get("/sales/tally/runs/:id/file", ...manage, asyncHandler(async (req, res) => {
  const part = str(req.query.part);
  if (part !== "masters" && part !== "vouchers") throw new AppError(400, "BAD_QUERY", "part must be masters or vouchers");
  const f = await tallyRunFile(req.params.id, part);
  sendDownload(res, f.bytes, { contentType: "text/xml; charset=utf-8", filename: f.filename });
}));
router.post("/sales/tally/runs/:id/confirm", ...manage, validate(tallyRunConfirmSchema), asyncHandler(async (req, res) => success(res, await confirmTallyRun(req.params.id, req.body, staffId(req)))));
router.post("/sales/tally/runs/:id/discard", ...manage, validate(tallyReasonSchema), asyncHandler(async (req, res) => success(res, await discardTallyRun(req.params.id, req.body.reason, staffId(req)))));
router.post("/sales/tally/runs/:id/retry", ...admin, asyncHandler(async (req, res) => success(res, await retryTallyPush(req.params.id, staffId(req)), undefined, 202)));
router.post("/sales/tally/runs/:id/close", ...admin, validate(tallyReasonSchema), asyncHandler(async (req, res) => success(res, await closeTallyRun(req.params.id, req.body.reason, staffId(req)))));

// Party ledgers (14–17) — static paths before /:clientId
router.get("/sales/tally/parties", ...view, asyncHandler(async (req, res) => success(res, await listTallyParties(companyOf(req), str(req.query.q), str(req.query.state) ?? "all"))));
router.post("/sales/tally/parties/match", ...admin, validate(tallyPartyMatchSchema), asyncHandler(async (req, res) => {
  if (req.body.source === "push") assertPushEnabled();
  success(res, await matchTallyParties(req.body, readTallyLedgers));
}));
router.post("/sales/tally/parties/apply", ...admin, validate(tallyPartyApplySchema), asyncHandler(async (req, res) => success(res, await applyTallyParties(req.body, staffId(req)))));
router.put("/sales/tally/parties/:clientId", ...manage, validate(tallyPartyUpdateSchema), asyncHandler(async (req, res) => {
  const canApprove = await hasPermission(req.user!.userId, "sales", "approve");
  success(res, await setTallyParty(companyOf(req), req.params.clientId, req.body, { id: staffId(req), canApprove }));
}));

// One document's Tally state (18) and manual resolution (19)
router.get("/sales/tally/documents/:docType/:docId", ...view, asyncHandler(async (req, res) => {
  const t = req.params.docType;
  if (!(TALLY_DOC_TYPES as readonly string[]).includes(t)) throw new AppError(400, "BAD_QUERY", "Unknown document type");
  success(res, await tallyDocStatus(t as TallyDocType, req.params.docId));
}));
router.post("/sales/tally/resolve", ...admin, validate(tallyResolveSchema), asyncHandler(async (req, res) => success(res, await resolveByHand(req.body, staffId(req)), undefined, 201)));

export default router;
