import { Router } from "express";
import { validate } from "../middleware/validate";
import { asyncHandler } from "../utils/async-handler";
import { success } from "../utils/response";
import { manage, staffId, view } from "./sales-route-kit";
import * as ext from "../services/sales/external-pages.service";
import * as plan from "../services/sales/campaign-plan.service";

// External pages + vendors (sales inventory), and a Pipeline campaign's page list and revenue
// (owner's Pipeline feedback, 2026-11-18). Gates from ./sales-route-kit:
//   view   (sales:view)   — vendors, external pages, a campaign's plan
//   manage (sales:manage) — add / edit vendors and pages, change a campaign's pages and revenue
// ⚠️ Prices and revenue live HERE, behind the sales permission — never on the /pipeline routes,
// which every active HR user can read.

const router = Router();

router.get("/sales/vendors", ...view, asyncHandler(async (_req, res) => success(res, await ext.listVendors())));
router.post("/sales/vendors", ...manage, validate(ext.vendorInputSchema), asyncHandler(async (req, res) => success(res, await ext.createVendor(req.body, staffId(req)), undefined, 201)));
router.put("/sales/vendors/:id", ...manage, validate(ext.vendorInputSchema), asyncHandler(async (req, res) => success(res, await ext.updateVendor(req.params.id, req.body))));

router.get("/sales/external-pages", ...view, asyncHandler(async (_req, res) => success(res, await ext.listExternalPages())));
router.post("/sales/external-pages", ...manage, validate(ext.externalPageInputSchema), asyncHandler(async (req, res) => success(res, await ext.createExternalPage(req.body, staffId(req)), undefined, 201)));
router.put("/sales/external-pages/:id", ...manage, validate(ext.externalPageInputSchema), asyncHandler(async (req, res) => success(res, await ext.updateExternalPage(req.params.id, req.body))));

router.get("/sales/pipeline/:projectId/plan", ...view, asyncHandler(async (req, res) => success(res, await plan.getCampaignPlan(req.params.projectId))));
router.post("/sales/pipeline/:projectId/pages", ...manage, validate(plan.addPagesSchema), asyncHandler(async (req, res) => success(res, await plan.addPages(req.params.projectId, req.body.pageKeys, staffId(req)))));
router.delete("/sales/pipeline/:projectId/pages/:pageId", ...manage, asyncHandler(async (req, res) => success(res, await plan.removePage(req.params.projectId, req.params.pageId))));
router.put("/sales/pipeline/:projectId/revenue", ...manage, validate(plan.revenueSchema), asyncHandler(async (req, res) => success(res, await plan.setRevenue(req.params.projectId, req.body, staffId(req)))));
router.delete("/sales/pipeline/:projectId/revenue", ...manage, asyncHandler(async (req, res) => success(res, await plan.clearRevenue(req.params.projectId))));

export default router;
