import { Router } from "express";

// Smart invoicing (PR 1) — Accounts page — GST, TDS, receivables and the filed balance sheet + P&L.
// Spec: spec-accounts.md (with spec-00-shared.md, which wins where they differ).
//
// Pre-mounted by PR 0 in routes/index.ts, directly after sales.routes.ts. Every route of this
// feature goes in THIS file, under /sales/accounts/…, static paths before /:id. Gates and helpers
// (view / manage / admin, staffId, str, companyQuery, companyOf, sendDownload) come from
// ./sales-route-kit — never redefine them here.

const router = Router();

export default router;
