import { Router, Request, Response, NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { safeString } from "@dashmani/shared";
import { validate } from "../middleware/validate";
import { AppError } from "../middleware/error-handler";
import { requireCreatorsEnabled, authenticateCreator, creatorOf } from "../middleware/creator-auth";
import { envInt } from "../middleware/rate-limit-key";
import { creatorConfig } from "../services/creator/creator-config";
import * as offers from "../services/creator/creator-offer.service";
import { asyncHandler } from "../utils/async-handler";
import { success } from "../utils/response";

// Creator bookings, Phase 3: the creator's own offers, /v1/creator/offers*.
// Plan: docs/superpowers/plans/2026-10-12-creator-payouts-razorpay-route.md, "Phase 3: Minimal creator bookings".
//
// ⚠️ DARK unless CREATORS_MARKETPLACE_ENABLED=1 AND CREATOR_ROUTE_ENABLED=1 AND the Razorpay keys exist
// (creatorConfig.marketplaceAvailable()): every route below answers 503 MARKETPLACE_DISABLED, except
// /creator/marketplace-status, which answers for ANY signed-in creator so the portal knows whether to show the nav.
//
// ⚠️ WHAT A CREATOR MAY SEE. Responses come only from creator-offer.service's allow-lists (toOfferRow /
// getOfferForCreator): never the brand's price, the booking total, other items, the client's company or contact, the
// share or the gross, or another creator. An offer that is not the caller's is a 404, never a 403.
//
// Gates are per route (see creator-auth.routes.ts for why there is no router.use):
//   requireCreatorsEnabled → authenticateCreator (the CREATOR secret: staff, client and HR tokens fail here) →
//   requireMarketplace → requireApprovedCreator.
const router = Router();

/** Offers are per person and must never be served from a shared or browser cache. */
function noStore(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("Cache-Control", "no-store");
  next();
}

function requireMarketplace(_req: Request, _res: Response, next: NextFunction) {
  if (!creatorConfig.marketplaceAvailable()) return next(new AppError(503, "MARKETPLACE_DISABLED", "Creator bookings are not open yet."));
  next();
}

/** Only an approved creator has offers. Suspended and closed accounts change nothing here; draft / in-review / rejected have none. */
function requireApprovedCreator(req: Request, _res: Response, next: NextFunction) {
  const c = creatorOf(req);
  if (c.status === "suspended") return next(new AppError(403, "ACCOUNT_SUSPENDED", "Your account is suspended — email creators@digitalsukoon.com."));
  if (c.status !== "approved") return next(new AppError(403, "NOT_APPROVED", "Your account isn't approved yet."));
  next();
}

const base = [noStore, requireCreatorsEnabled, authenticateCreator];
const gated = [...base, requireMarketplace, requireApprovedCreator];

/** Each link check is a call to Meta, so it is limited per creator (never per IP: behind Cloudflare an IP is a shared edge). */
const linkLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: () => envInt("RATE_LIMIT_CREATOR_OFFER_LINK_MAX", 30),
  keyGenerator: (req) => `creator-offer-link:${creatorOf(req).id}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: "RATE_LIMIT", message: "Too many attempts. Please try again in an hour." } },
});

const declineSchema = z.object({ reason: safeString.pipe(z.string().max(500)).optional() });
const postedSchema = z.object({ url: z.string().trim().min(8, "Paste the link of your post").max(500, "That link is too long") });

// Whether the marketplace is open: for the nav. Any signed-in creator (even suspended), even while it is off.
router.get(
  "/creator/marketplace-status",
  ...base,
  asyncHandler(async (_req: Request, res: Response) => success(res, { marketplaceEnabled: creatorConfig.marketplaceAvailable() })),
);

router.get(
  "/creator/offers",
  ...gated,
  asyncHandler(async (req: Request, res: Response) => success(res, await offers.listOffersForCreator(creatorOf(req).id))),
);

router.get(
  "/creator/offers/:id",
  ...gated,
  asyncHandler(async (req: Request, res: Response) => success(res, await offers.getOfferForCreator(creatorOf(req).id, req.params.id))),
);

router.post(
  "/creator/offers/:id/accept",
  ...gated,
  asyncHandler(async (req: Request, res: Response) => {
    const id = creatorOf(req).id;
    await offers.acceptOffer(id, req.params.id);
    return success(res, await offers.getOfferForCreator(id, req.params.id));
  }),
);

router.post(
  "/creator/offers/:id/decline",
  ...gated,
  validate(declineSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const id = creatorOf(req).id;
    await offers.declineOffer(id, req.params.id, req.body.reason);
    return success(res, await offers.getOfferForCreator(id, req.params.id));
  }),
);

router.post(
  "/creator/offers/:id/posted",
  ...gated,
  linkLimiter,
  validate(postedSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const id = creatorOf(req).id;
    const result = await offers.submitOfferLink(id, req.params.id, req.body.url);
    return success(res, { ...(await offers.getOfferForCreator(id, req.params.id)), linkResult: result });
  }),
);

export default router;
