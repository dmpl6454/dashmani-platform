import { Router, Request } from "express";
import { prisma } from "@dashmani/db";
import {
  campaignRateCardUpsertSchema,
  campaignReviewNoteSchema,
  campaignMarkPostedSchema,
  BOOKING_STATUSES,
} from "@dashmani/shared";
import { authenticate } from "../middleware/auth";
import { requireInternalUser } from "../middleware/require-internal-user";
import { requireAdminRole } from "../middleware/require-admin-role";
import { validate } from "../middleware/validate";
import { AppError } from "../middleware/error-handler";
import { asyncHandler } from "../utils/async-handler";
import { success } from "../utils/response";
import * as review from "../services/campaign/review.service";
import { listRateCardGrid, upsertRateCards } from "../services/campaign/rate-card.service";
import { signedMediaPath } from "../services/campaign/media-url";
import { resolveItemFiles } from "../services/campaign/booking.service";

// Internal portal: campaign review queue, booking actions and the rate-card grid.
// ⚠️ Gated on Admin/Super Admin (role checked on the token) for internal users only: these
// endpoints move money (refunds) and show client contact details.

const router = Router();
const gate = [authenticate, requireInternalUser, requireAdminRole];
const staffId = (req: Request) => req.user!.userId;

// ── Rate cards ──────────────────────────────────────────────────────────────────

router.get("/admin/campaign-rate-cards", ...gate, asyncHandler(async (_req, res) => {
  return success(res, await listRateCardGrid());
}));

router.put("/admin/campaign-rate-cards", ...gate, validate(campaignRateCardUpsertSchema), asyncHandler(async (req, res) => {
  return success(res, await upsertRateCards(req.body, staffId(req)));
}));

// ── Review queue ────────────────────────────────────────────────────────────────

router.get("/admin/campaigns", ...gate, asyncHandler(async (req, res) => {
  const status = typeof req.query.status === "string" && (BOOKING_STATUSES as readonly string[]).includes(req.query.status) ? req.query.status : undefined;
  return success(res, await review.listQueue({ status }));
}));

router.get("/admin/campaigns/:id", ...gate, asyncHandler(async (req, res) => {
  return success(res, await review.getBookingForStaff(req.params.id));
}));

router.post("/admin/campaigns/:id/approve", ...gate, asyncHandler(async (req, res) => {
  return success(res, await review.approve(req.params.id, staffId(req)));
}));

router.post("/admin/campaigns/:id/request-changes", ...gate, validate(campaignReviewNoteSchema), asyncHandler(async (req, res) => {
  return success(res, await review.requestChanges(req.params.id, staffId(req), req.body.note));
}));

router.post("/admin/campaigns/:id/reject", ...gate, validate(campaignReviewNoteSchema), asyncHandler(async (req, res) => {
  return success(res, await review.reject(req.params.id, staffId(req), req.body.note));
}));

router.post("/admin/campaigns/:id/resend-delivery", ...gate, asyncHandler(async (req, res) => {
  return success(res, await review.resendDelivery(req.params.id));
}));

router.post("/admin/campaigns/:id/items/:itemId/posted", ...gate, validate(campaignMarkPostedSchema), asyncHandler(async (req, res) => {
  return success(res, await review.markPosted(req.params.id, req.params.itemId, staffId(req), req.body.url));
}));

router.post("/admin/campaigns/:id/items/:itemId/failed", ...gate, validate(campaignReviewNoteSchema), asyncHandler(async (req, res) => {
  return success(res, await review.markFailed(req.params.id, req.params.itemId, staffId(req), req.body.note));
}));

router.post("/admin/campaigns/:id/items/:itemId/refund", ...gate, asyncHandler(async (req, res) => {
  return success(res, await review.refundItem(req.params.id, req.params.itemId, staffId(req)));
}));

router.post("/admin/campaigns/:id/items/:itemId/publish-now", ...gate, asyncHandler(async (req, res) => {
  return success(res, await review.publishNow(req.params.id, req.params.itemId, staffId(req)));
}));

router.post("/admin/campaigns/:id/items/:itemId/manual", ...gate, asyncHandler(async (req, res) => {
  return success(res, await review.switchToManual(req.params.id, req.params.itemId, staffId(req)));
}));

/**
 * Signed links to preview the creative and download the files to post by hand. `media` is
 * the booking's files with the DEFAULT overlay; `items` carries, per account, the exact files
 * to post there (its own render when that account customised its overlay).
 */
router.get("/admin/campaigns/:id/media-urls", ...gate, asyncHandler(async (req, res) => {
  const media = await prisma.campaignMedia.findMany({
    where: { bookingId: req.params.id, purgedAt: null, uploadStatus: "complete" },
    orderBy: [{ role: "asc" }, { position: "asc" }],
    select: { id: true, kind: true, role: true, renderStatus: true },
  });
  if (!media.length) {
    const exists = await prisma.campaignBooking.count({ where: { id: req.params.id } });
    if (!exists) throw new AppError(404, "NOT_FOUND", "Campaign not found");
  }
  const TTL = 4 * 3600;
  const files = await resolveItemFiles(req.params.id);
  return success(res, {
    media: media.map((m) => ({
      id: m.id,
      kind: m.kind,
      role: m.role,
      renderStatus: m.renderStatus,
      preview: signedMediaPath(m.id, "preview", TTL),
      original: signedMediaPath(m.id, "original", TTL),
    })),
    items: [...files.entries()].map(([itemId, list]) => ({
      itemId,
      custom: list.some((f) => f.custom),
      files: list.map((f) => ({
        mediaId: f.mediaId,
        kind: f.kind,
        role: f.role,
        status: f.status,
        url: f.status === "done" ? signedMediaPath(f.mediaId, f.renderId ? `v-${f.renderId}` : "preview", TTL) : null,
      })),
    })),
  });
}));

export default router;
