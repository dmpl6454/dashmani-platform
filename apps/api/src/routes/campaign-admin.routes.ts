import { Router, Request } from "express";
import { z } from "zod";
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
import { listCreatorRateCardGrid, listRateCardGrid, upsertRateCards } from "../services/campaign/rate-card.service";
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

/**
 * The creator pages staff can price (approved creator, page switched on, publishable, connection live), each
 * with its cards and their shares. Priced through PUT /admin/campaign-rate-cards (targetType "creator_asset",
 * with a shareBps on every card). Declared BEFORE every /admin/campaigns/:id route.
 */
router.get("/admin/campaigns/rate-cards/creator-targets", ...gate, asyncHandler(async (_req, res) => {
  res.set("Cache-Control", "no-store");
  return success(res, await listCreatorRateCardGrid());
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

/**
 * "Verify link & release": the creator's link for a creator item is what goes live. Refused (409) unless the creator
 * accepted, submitted a link, and the page-ownership check passed; for a check that did not, `ownershipCheckedByHand`
 * says staff opened the link and checked it themselves. Nothing is paid here (that is the later payout phase).
 *
 * ⚠️ `linkCanonicalKey` (REQUIRED) is the `linkCanonicalKey` of the creator's offer exactly as the staff member saw it in the
 * booking detail. The creator may send another link until it is verified, so a verify (and a hand tick above all) must name the
 * link it is about: if the creator's current link is a different one the answer is 409 LINK_CHANGED and nothing is verified.
 */
const verifyCreatorLinkSchema = z.object({ ownershipCheckedByHand: z.boolean().optional(), linkCanonicalKey: z.string().trim().min(1).max(800) });
router.post("/admin/campaigns/:id/items/:itemId/verify-creator-link", ...gate, validate(verifyCreatorLinkSchema), asyncHandler(async (req, res) => {
  return success(res, await review.verifyCreatorLink(req.params.id, req.params.itemId, staffId(req), { ownershipCheckedByHand: req.body.ownershipCheckedByHand === true, linkCanonicalKey: req.body.linkCanonicalKey }));
}));

/**
 * Withdraw a creator's open offer (offered, or accepted with no link yet): the post goes to "refund due" and staff then
 * Refund it. `discardSubmittedLink` also closes an accepted offer whose submitted link was NOT verified (staff looked and
 * it is not the creator's post). Nothing is refunded here.
 */
const withdrawOfferSchema = z.object({ discardSubmittedLink: z.boolean().optional() });
router.post("/admin/campaigns/:id/items/:itemId/withdraw-offer", ...gate, validate(withdrawOfferSchema), asyncHandler(async (req, res) => {
  return success(res, await review.withdrawOffer(req.params.id, req.params.itemId, staffId(req), { discardSubmittedLink: req.body.discardSubmittedLink === true }));
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
