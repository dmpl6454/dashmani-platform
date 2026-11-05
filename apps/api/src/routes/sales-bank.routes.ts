import { Router } from "express";

// Smart invoicing (PR 4) — Bank statement upload, auto-match and TDS.
// Spec: spec-bank.md (with spec-00-shared.md, which wins where they differ).
//
// Pre-mounted by PR 0 in routes/index.ts, directly after sales.routes.ts. Every route of this
// feature goes in THIS file, under /sales/bank/…, static paths before /:id. Gates and helpers
// (view / manage / admin, staffId, str, companyQuery, companyOf, sendDownload) come from
// ./sales-route-kit — never redefine them here.

const router = Router();

export default router;
