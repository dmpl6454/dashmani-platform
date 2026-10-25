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

router.put("/admin/creators/:id/assets/:assetId", ...gate, validate(creatorAssetToggleSchema), asyncHandler(async (req, res) => {
  return success(res, await admin.setAssetEnabled(req.params.id, req.params.assetId, req.body.enabled, staffId(req)));
}));

export default router;
