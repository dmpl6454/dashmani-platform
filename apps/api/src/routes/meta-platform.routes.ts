import { Router, type Request, type Response } from "express";
import express from "express";
import rateLimit from "express-rate-limit";
import { asyncHandler } from "../utils/async-handler";
import { AppError } from "../middleware/error-handler";
import { success } from "../utils/response";
import { parseSignedRequest, type SignedRequestPayload } from "../services/meta-oauth/signed-request";
import { creatorMetaAppSecret } from "../services/creator/creator-meta-config";
import { metaOauthAppSecret } from "../services/meta-oauth/meta-config";
import { getDeletionStatus, handleDataDeletion, handleDeauthorize } from "../services/meta-platform-callbacks.service";

// Meta's app-wide callbacks (Deauthorize, Data Deletion) + the public deletion-status lookup.
// PUBLIC by necessity: Meta POSTs `signed_request=…` (form-encoded) with no credential of ours;
// the HMAC with our app secret IS the authentication. They work whether or not the creator portal
// is enabled — staff grants receive them too. See services/meta-platform-callbacks.service.ts.
const router = Router();

const limiter = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true, legacyHeaders: false });
const form = express.urlencoded({ extended: false, limit: "16kb" });

/** Verify against every secret of OURS (the creator app may be split from the admin app). */
function verify(req: Request): SignedRequestPayload & { user_id: string } {
  const sr = (req.body as Record<string, unknown> | undefined)?.signed_request;
  const secrets = [...new Set([creatorMetaAppSecret(), metaOauthAppSecret()].filter(Boolean))];
  for (const secret of secrets) {
    const p = parseSignedRequest(sr, secret);
    if (p && typeof p.user_id === "string" && /^\d{1,32}$/.test(p.user_id)) return p as SignedRequestPayload & { user_id: string };
  }
  throw new AppError(400, "BAD_SIGNATURE", "Invalid signed_request");
}

router.post(
  "/meta/deauthorize",
  limiter,
  form,
  asyncHandler(async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    const p = verify(req);
    await handleDeauthorize(p.user_id);
    success(res, { ok: true });
  }),
);

/**
 * Meta's documented response shape is a bare `{ url, confirmation_code }` (NOT our envelope):
 * the dashboard's validator reads those two keys at the top level.
 */
router.post(
  "/meta/data-deletion",
  limiter,
  form,
  asyncHandler(async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    const p = verify(req);
    const out = await handleDataDeletion(p.user_id);
    res.json(out);
  }),
);

router.get(
  "/public/meta-data-deletion/:code",
  limiter,
  asyncHandler(async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    const status = await getDeletionStatus(String(req.params.code ?? "").trim().toUpperCase());
    if (!status) throw new AppError(404, "NOT_FOUND", "No deletion request with that code.");
    success(res, status);
  }),
);

export default router;
