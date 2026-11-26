import { Router } from "express";
import { linkAnalyticsValidators as v } from "@dashmani/shared";
import { validate } from "../middleware/validate";
import { AppError } from "../middleware/error-handler";
import { asyncHandler } from "../utils/async-handler";
import { success } from "../utils/response";
import * as batches from "../services/link-analytics/batches.service";
import { buildReport } from "../services/link-analytics/report.service";
import { exportBatch, type ExportFormat } from "../services/link-analytics/export.service";
import { workerStatus } from "../services/link-analytics/worker";
import { manage, sendDownload, staffId, str, view } from "./sales-route-kit";

// Link Analytics — sales.digitalsukoon.com /links (docs/link-analytics/SPEC.md).
// view (sales:view) reads batches, posts, reports and exports; manage (sales:manage) creates,
// adds links and runs/pauses/refreshes. No route here ever calls Meta: the worker does, in the
// background, so a request can never hang on Graph or spend the call budget.

const router = Router();
const ID = "([0-9a-fA-F-]{36})";

const int = (x: unknown) => {
  const s = str(x);
  if (s === undefined) return undefined;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1) throw new AppError(400, "BAD_QUERY", "Expected a whole number");
  return n;
};

router.get("/sales/links/batches", ...view, asyncHandler(async (req, res) =>
  success(res, { batches: await batches.listBatches({ archived: req.query.archived === "1" }), worker: workerStatus() })));

router.post("/sales/links/batches", ...manage, validate(v.linkBatchCreateSchema), asyncHandler(async (req, res) =>
  success(res, await batches.createBatch(req.body, staffId(req)), undefined, 201)));

router.get(`/sales/links/batches/:id${ID}`, ...view, asyncHandler(async (req, res) =>
  success(res, { ...(await batches.getBatch(req.params.id)), worker: workerStatus() })));

router.patch(`/sales/links/batches/:id${ID}`, ...manage, validate(v.linkBatchUpdateSchema), asyncHandler(async (req, res) =>
  success(res, await batches.updateBatch(req.params.id, req.body))));

router.post(`/sales/links/batches/:id${ID}/links`, ...manage, validate(v.linkBatchAddSchema), asyncHandler(async (req, res) =>
  success(res, await batches.addLinks(req.params.id, req.body))));

router.get(`/sales/links/batches/:id${ID}/items`, ...view, asyncHandler(async (req, res) => {
  const viewQ = str(req.query.view);
  if (viewQ && !["posts", "invalid", "duplicate"].includes(viewQ)) throw new AppError(400, "BAD_QUERY", "Unknown view");
  success(res, await batches.listItems(req.params.id, {
    view: viewQ as batches.ItemView | undefined,
    q: str(req.query.q)?.slice(0, 200),
    status: str(req.query.status),
    platform: str(req.query.platform),
    sort: str(req.query.sort),
    dir: req.query.dir === "asc" ? "asc" : "desc",
    page: int(req.query.page),
    pageSize: int(req.query.pageSize),
  }));
}));

router.post(`/sales/links/batches/:id${ID}/refresh`, ...manage, asyncHandler(async (req, res) => success(res, await batches.refreshBatch(req.params.id))));
router.post(`/sales/links/batches/:id${ID}/pause`, ...manage, asyncHandler(async (req, res) => success(res, await batches.pauseBatch(req.params.id))));
router.post(`/sales/links/batches/:id${ID}/resume`, ...manage, asyncHandler(async (req, res) => success(res, await batches.resumeBatch(req.params.id))));
router.post(`/sales/links/batches/:id${ID}/retry-failed`, ...manage, asyncHandler(async (req, res) => success(res, await batches.retryFailed(req.params.id))));
router.put(`/sales/links/batches/:id${ID}/schedule`, ...manage, validate(v.linkBatchScheduleSchema), asyncHandler(async (req, res) =>
  success(res, await batches.setSchedule(req.params.id, req.body.hours))));
router.post(`/sales/links/batches/:id${ID}/archive`, ...manage, asyncHandler(async (req, res) => success(res, await batches.archiveBatch(req.params.id, true))));
router.post(`/sales/links/batches/:id${ID}/restore`, ...manage, asyncHandler(async (req, res) => success(res, await batches.archiveBatch(req.params.id, false))));

router.post(`/sales/links/batches/:id${ID}/posts/:postId${ID}/refresh`, ...manage, asyncHandler(async (req, res) =>
  success(res, await batches.refreshPost(req.params.postId, req.params.id))));
router.put(`/sales/links/batches/:id${ID}/items/:itemId${ID}/username`, ...manage, validate(v.linkUsernameHintSchema), asyncHandler(async (req, res) =>
  success(res, await batches.setUsernameHint(req.params.id, req.params.itemId, req.body.username))));

router.get(`/sales/links/posts/:postId${ID}`, ...view, asyncHandler(async (req, res) => success(res, await batches.getPost(req.params.postId))));

router.get(`/sales/links/batches/:id${ID}/report`, ...view, asyncHandler(async (req, res) => success(res, await buildReport(req.params.id))));

const FORMATS: ExportFormat[] = ["xlsx", "csv", "pdf", "json"];
router.get(`/sales/links/batches/:id${ID}/export`, ...view, asyncHandler(async (req, res) => {
  const format = str(req.query.format) as ExportFormat;
  if (!FORMATS.includes(format)) throw new AppError(400, "BAD_FORMAT", "Format is xlsx, csv, pdf or json");
  const f = await exportBatch(req.params.id, format);
  return sendDownload(res, f.body, { contentType: f.contentType, filename: f.filename });
}));

export default router;
