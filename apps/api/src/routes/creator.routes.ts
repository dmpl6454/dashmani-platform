import { Router, Request, Response, NextFunction } from "express";
import { validate } from "../middleware/validate";
import { requireCreatorsEnabled, authenticateCreator, requireActiveCreator, creatorOf } from "../middleware/creator-auth";
import {
  creatorProfileSchema,
  creatorChangePasswordSchema,
  creatorOfferDeclineSchema,
  creatorOfferPostedSchema,
  creatorOwnPricesSchema,
} from "@dashmani/shared/src/validators/creator";
import * as creatorSelf from "../services/creator/creator-self.service";
import * as offers from "../services/creator/creator-offers.service";
import * as pricing from "../services/creator/creator-pricing.service";
import { setCreatorTax } from "../services/creator/creator-tax.service";
import { asyncHandler } from "../utils/async-handler";
import { success } from "../utils/response";

// Creator portal (Phase A) — the signed-in creator's own account, /v1/creator/me*.
// ⚠️ Gates are per route (see creator-auth.routes.ts for why there is no router.use).
const router = Router();
const signedIn = [requireCreatorsEnabled, authenticateCreator];

/**
 * The shared profile schema turns "" into undefined ("not provided"), which would make an
 * optional field impossible to clear. Note which fields the creator emptied BEFORE validation.
 */
function noteClears(req: Request, res: Response, next: NextFunction) {
  const b = (req.body ?? {}) as Record<string, unknown>;
  res.locals.profileClears = { country: b.country === "", phone: b.phone === "" };
  next();
}

router.get(
  "/creator/me",
  ...signedIn,
  asyncHandler(async (req: Request, res: Response) => success(res, await creatorSelf.getCreatorMe(creatorOf(req).id))),
);

router.put(
  "/creator/me",
  ...signedIn,
  requireActiveCreator,
  noteClears,
  validate(creatorProfileSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { name, country, phone } = req.body;
    return success(res, await creatorSelf.updateCreatorMe(creatorOf(req).id, { name, country, phone }, res.locals.profileClears));
  }),
);

router.put(
  "/creator/me/password",
  ...signedIn,
  validate(creatorChangePasswordSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { currentPassword, newPassword } = req.body;
    return success(res, await creatorSelf.changeCreatorPassword(creatorOf(req).id, currentPassword, newPassword));
  }),
);

router.post(
  "/creator/me/submit",
  ...signedIn,
  requireActiveCreator,
  asyncHandler(async (req: Request, res: Response) => success(res, await creatorSelf.submitCreatorForReview(creatorOf(req).id))),
);

// Close the account (allowed while suspended too — a creator can always leave).
router.delete(
  "/creator/me",
  ...signedIn,
  asyncHandler(async (req: Request, res: Response) => success(res, await creatorSelf.closeCreatorAccount(creatorOf(req).id))),
);

// How the creator is paid (G72): GSTIN (GST registered) or PAN (TDS deducted). Validated in the service.
router.put(
  "/creator/me/tax",
  ...signedIn,
  asyncHandler(async (req: Request, res: Response) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    return success(res, await setCreatorTax(creatorOf(req).id, {
      route: b.route === "gst" || b.route === "pan" ? b.route : (undefined as never),
      gstin: str(b.gstin),
      pan: str(b.pan),
      legalName: str(b.legalName) ?? "",
    }));
  }),
);

// ── Marketplace (Phase C): the creator's own price per page and format (= their payout) ─────
router.get(
  "/creator/prices",
  ...signedIn,
  asyncHandler(async (req: Request, res: Response) => success(res, await pricing.getOwnPrices(creatorOf(req).id))),
);

router.put(
  "/creator/prices",
  ...signedIn,
  requireActiveCreator,
  validate(creatorOwnPricesSchema),
  asyncHandler(async (req: Request, res: Response) => success(res, await pricing.setOwnPrices(creatorOf(req).id, req.body))),
);

// ── Marketplace (Phase B): booked posts offered to this creator ──────────────────────────────
// Read while suspended (a creator can always see their history); answering needs an active
// account, and the service re-checks the page is still theirs.

router.get(
  "/creator/offers",
  ...signedIn,
  asyncHandler(async (req: Request, res: Response) =>
    success(res, await offers.listOffers(creatorOf(req).id, req.query.filter === "open" ? "open" : "all"))),
);

router.get(
  "/creator/offers/:id",
  ...signedIn,
  asyncHandler(async (req: Request, res: Response) => success(res, await offers.getOffer(creatorOf(req).id, req.params.id))),
);

router.post(
  "/creator/offers/:id/accept",
  ...signedIn,
  requireActiveCreator,
  asyncHandler(async (req: Request, res: Response) => success(res, await offers.acceptOffer(creatorOf(req).id, req.params.id))),
);

router.post(
  "/creator/offers/:id/decline",
  ...signedIn,
  requireActiveCreator,
  validate(creatorOfferDeclineSchema),
  asyncHandler(async (req: Request, res: Response) =>
    success(res, await offers.declineOffer(creatorOf(req).id, req.params.id, req.body.reason))),
);

router.post(
  "/creator/offers/:id/posted",
  ...signedIn,
  requireActiveCreator,
  validate(creatorOfferPostedSchema),
  asyncHandler(async (req: Request, res: Response) =>
    success(res, await offers.recordCreatorPost(creatorOf(req).id, req.params.id, req.body.url))),
);

export default router;
