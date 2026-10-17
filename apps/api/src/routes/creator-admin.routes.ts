import { Router, Request } from "express";
import {
  creatorReviewSchema,
  creatorReviewNoteRequiredSchema,
  creatorAssetToggleSchema,
} from "@dashmani/shared/src/validators/creator";
import { authenticate } from "../middleware/auth";
import { requireInternalUser } from "../middleware/require-internal-user";
import { requireAdminRole } from "../middleware/require-admin-role";
import { validate } from "../middleware/validate";
import { asyncHandler } from "../utils/async-handler";
import { success } from "../utils/response";
import * as admin from "../services/creator/creator-admin.service";

// Internal portal: the creator review queue (/creators). Creator portal Phase A.
// ⚠️ Gated on Admin/Super Admin for internal users only: these endpoints show creators' contact
// details and decide whose pages may be offered for booking. Deliberately NOT behind
// requireCreatorsEnabled — staff can read the queue while the creator portal itself is dark.

const router = Router();
const gate = [authenticate, requireInternalUser, requireAdminRole];
const staffId = (req: Request) => req.user!.userId;

router.get("/admin/creators", ...gate, asyncHandler(async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const q = typeof req.query.q === "string" ? req.query.q : undefined;
  return success(res, await admin.listCreators({ status, q }));
}));

router.get("/admin/creators/:id", ...gate, asyncHandler(async (req, res) => {
  // The detail now carries the creator's payout status: never from a cache or a shared proxy.
  res.setHeader("Cache-Control", "no-store");
  return success(res, await admin.getCreatorDetail(req.params.id));
}));

router.post("/admin/creators/:id/approve", ...gate, validate(creatorReviewSchema), asyncHandler(async (req, res) => {
  return success(res, await admin.reviewCreator(req.params.id, "approve", staffId(req), req.body.note));
}));

router.post("/admin/creators/:id/reject", ...gate, validate(creatorReviewNoteRequiredSchema), asyncHandler(async (req, res) => {
  return success(res, await admin.reviewCreator(req.params.id, "reject", staffId(req), req.body.note));
}));

router.post("/admin/creators/:id/suspend", ...gate, validate(creatorReviewNoteRequiredSchema), asyncHandler(async (req, res) => {
  return success(res, await admin.reviewCreator(req.params.id, "suspend", staffId(req), req.body.note));
}));

router.post("/admin/creators/:id/reinstate", ...gate, validate(creatorReviewSchema), asyncHandler(async (req, res) => {
  return success(res, await admin.reviewCreator(req.params.id, "reinstate", staffId(req), req.body.note));
}));

// Creator payouts: staff mark the bank change Razorpay support carried out as processed. ⚠️ No
// auditLog and no body on this route: payout details never pass through here, and the action is
// recorded by the service in creator_payout_events (scrubbed, in the same transaction). Deliberately
// not behind CREATOR_ROUTE_ENABLED: a request made before the switch went off must still be clearable.
router.post("/admin/creators/:id/payout-account/bank-change/cleared", ...gate, asyncHandler(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  return success(res, await admin.markBankChangeProcessed(req.params.id, staffId(req)));
}));

// The other way out of a waiting request: staff close it WITHOUT a change (made by mistake, withdrawn, or no longer
// possible, e.g. the creator's account is closed). Same rules as above; it never says the account was updated and
// applies no release pause. Nothing is sent to Razorpay by either route.
router.post("/admin/creators/:id/payout-account/bank-change/declined", ...gate, asyncHandler(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  return success(res, await admin.declineBankChange(req.params.id, staffId(req)));
}));

router.put("/admin/creators/:id/assets/:assetId", ...gate, validate(creatorAssetToggleSchema), asyncHandler(async (req, res) => {
  return success(res, await admin.setAssetEnabled(req.params.id, req.params.assetId, req.body.enabled, staffId(req)));
}));

export default router;
