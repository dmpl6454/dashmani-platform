import { Router, Request, Response, NextFunction } from "express";
import { validate } from "../middleware/validate";
import { requireCreatorsEnabled, authenticateCreator, requireActiveCreator, creatorOf } from "../middleware/creator-auth";
import { creatorProfileSchema, creatorChangePasswordSchema } from "@dashmani/shared/src/validators/creator";
import * as creatorSelf from "../services/creator/creator-self.service";
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

export default router;
