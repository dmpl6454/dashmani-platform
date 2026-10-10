import { Router, Request, Response } from "express";
import fs from "fs";
import { prisma } from "@dashmani/db";
import {
  campaignInfoSchema,
  campaignCreativeSchema,
  campaignItemsSchema,
  campaignUploadInitSchema,
} from "@dashmani/shared";
import { authenticateClient } from "../middleware/client-auth";
import { validate } from "../middleware/validate";
import { AppError } from "../middleware/error-handler";
import { asyncHandler } from "../utils/async-handler";
import { success } from "../utils/response";
import * as booking from "../services/campaign/booking.service";
import * as media from "../services/campaign/media.service";
import * as payment from "../services/campaign/payment.service";
import { getCatalogue } from "../services/campaign/rate-card.service";
import { getResults } from "../services/campaign/delivery.service";
import { signedMediaPath, verifyMediaSignature } from "../services/campaign/media-url";

// Client portal: self-serve campaign booking. Every query is scoped to the signed-in client;
// another client's booking or upload is a 404.

const router = Router();
const clientId = (req: Request) => (req as any).client.id as string;

// ── Catalogue ───────────────────────────────────────────────────────────────────

router.get("/client/campaigns/catalogue", authenticateClient, asyncHandler(async (_req, res) => {
  res.set("Cache-Control", "private, max-age=30");
  return success(res, await getCatalogue());
}));

// ── Uploads (chunked) ───────────────────────────────────────────────────────────

router.post("/client/campaign-uploads", authenticateClient, validate(campaignUploadInitSchema), asyncHandler(async (req, res) => {
  return success(res, await media.initUpload(clientId(req), req.body), undefined, 201);
}));

router.get("/client/campaign-uploads/:id", authenticateClient, asyncHandler(async (req, res) => {
  return success(res, await media.uploadStatus(clientId(req), req.params.id));
}));

// Raw bytes (Content-Type: application/octet-stream). The global JSON parser ignores this type,
// so the body arrives here as an untouched stream.
router.put("/client/campaign-uploads/:id/chunks/:n", authenticateClient, asyncHandler(async (req, res) => {
  const ct = String(req.headers["content-type"] ?? "");
  if (!ct.startsWith("application/octet-stream")) throw new AppError(415, "UNSUPPORTED_MEDIA_TYPE", "Send the chunk as application/octet-stream");
  return success(res, await media.putChunk(clientId(req), req.params.id, Number(req.params.n), req));
}));

router.post("/client/campaign-uploads/:id/complete", authenticateClient, asyncHandler(async (req, res) => {
  return success(res, await media.completeUpload(clientId(req), req.params.id));
}));

router.delete("/client/campaign-uploads/:id", authenticateClient, asyncHandler(async (req, res) => {
  return success(res, await media.deleteUpload(clientId(req), req.params.id));
}));

/** Signed, short-lived URL for a <video>/<img> preview of the client's own file. */
router.get("/client/campaign-uploads/:id/preview-url", authenticateClient, asyncHandler(async (req, res) => {
  const m = await prisma.campaignMedia.findFirst({ where: { id: req.params.id, clientId: clientId(req), purgedAt: null, uploadStatus: "complete" }, select: { id: true } });
  if (!m) throw new AppError(404, "NOT_FOUND", "File not found");
  return success(res, { url: signedMediaPath(m.id, "preview") });
}));

// ── Bookings ────────────────────────────────────────────────────────────────────

router.get("/client/campaigns", authenticateClient, asyncHandler(async (req, res) => {
  return success(res, await booking.listClientBookings(clientId(req)));
}));

router.post("/client/campaigns", authenticateClient, validate(campaignInfoSchema), asyncHandler(async (req, res) => {
  return success(res, await booking.createBooking(clientId(req), req.body), undefined, 201);
}));

router.get("/client/campaigns/:id", authenticateClient, asyncHandler(async (req, res) => {
  return success(res, await booking.getClientBooking(clientId(req), req.params.id));
}));

router.put("/client/campaigns/:id/info", authenticateClient, validate(campaignInfoSchema), asyncHandler(async (req, res) => {
  return success(res, await booking.updateInfo(clientId(req), req.params.id, req.body));
}));

router.put("/client/campaigns/:id/creative", authenticateClient, validate(campaignCreativeSchema), asyncHandler(async (req, res) => {
  return success(res, await booking.updateCreative(clientId(req), req.params.id, req.body));
}));

router.put("/client/campaigns/:id/items", authenticateClient, validate(campaignItemsSchema), asyncHandler(async (req, res) => {
  return success(res, await booking.updateItems(clientId(req), req.params.id, req.body.rateCardIds));
}));

router.post("/client/campaigns/:id/cancel", authenticateClient, asyncHandler(async (req, res) => {
  return success(res, await booking.cancelBooking(clientId(req), req.params.id));
}));

router.post("/client/campaigns/:id/checkout", authenticateClient, asyncHandler(async (req, res) => {
  return success(res, await payment.checkout(clientId(req), req.params.id));
}));

router.post("/client/campaigns/:id/payment/verify", authenticateClient, asyncHandler(async (req, res) => {
  return success(res, await payment.verifyCheckout(clientId(req), req.params.id, req.body ?? {}));
}));

router.post("/client/campaigns/:id/submit-changes", authenticateClient, asyncHandler(async (req, res) => {
  return success(res, await booking.submitChanges(clientId(req), req.params.id));
}));

router.get("/client/campaigns/:id/results", authenticateClient, asyncHandler(async (req, res) => {
  const r = await getResults(clientId(req), req.params.id);
  if (!r) throw new AppError(404, "NOT_FOUND", "Campaign not found");
  return success(res, r);
}));

// ── Signed media (no Authorization header: the URL itself carries a short-lived signature) ──

router.get("/campaign-media/:id/:variant", asyncHandler(async (req: Request, res: Response) => {
  const { id, variant } = req.params;
  if (!verifyMediaSignature(id, variant, req.query.exp as string | undefined, req.query.sig as string | undefined)) {
    throw new AppError(403, "FORBIDDEN", "This link has expired. Reload the page.");
  }
  const m = await prisma.campaignMedia.findFirst({ where: { id, purgedAt: null, uploadStatus: "complete" } });
  if (!m) throw new AppError(404, "NOT_FOUND", "File not found");
  const file = variant === "original" ? media.origPath(m) : media.previewFile(m);
  if (!fs.existsSync(file)) throw new AppError(404, "NOT_FOUND", "File not found");
  res.set("Cache-Control", "private, max-age=600");
  res.set("X-Content-Type-Options", "nosniff");
  if (variant === "original") res.attachment(m.originalName);
  // sendFile handles Range requests, so videos can seek without downloading everything.
  res.sendFile(file, { dotfiles: "deny" });
}));

export default router;
