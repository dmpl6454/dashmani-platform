import { Router, Request, Response, NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { validate } from "../middleware/validate";
import { requireCreatorsEnabled, authenticateCreator, requireActiveCreator, creatorOf } from "../middleware/creator-auth";
import { envInt } from "../middleware/rate-limit-key";
import { creatorPayoutAccountSchema } from "@dashmani/shared/src/validators/creator-payout";
import * as payouts from "../services/creator/payout-account.service";
import { asyncHandler } from "../utils/async-handler";
import { success } from "../utils/response";

// Creator payouts, Phase 2 (bank connect): /v1/creator/payout-account*.
// Plan: docs/superpowers/plans/2026-10-12-creator-payouts-razorpay-route.md, "Phase 2: Bank connect".
//
// ⚠️ THE BODY OF PUT CARRIES A PAN, A BANK ACCOUNT NUMBER, AN IFSC, A NAME AND AN ADDRESS. What keeps
// them out of every log and store on this path:
//   • auditLog is NEVER mounted here (it stores req.body), and no other body-logging middleware exists:
//     morgan (app.ts) logs the request line only, and these values never travel in a URL or query string.
//   • validate() answers a failure with Zod's messages, which the shared schema
//     (packages/shared/src/validators/creator-payout.ts) makes generic for every check, so none of them
//     quotes the value that failed. Unknown keys are stripped, never reported.
//   • a body that is not valid JSON is answered by errorHandler as a type and a length, never the text.
//   • responses are built ONLY from PayoutAccountView (payout-account-view.ts).
// The global 10 MB JSON parser applies; the schema bounds every field, so no router-local limit is added.
//
// ⚠️ Gates are per route (see creator-auth.routes.ts for why there is no router.use):
//   GET    authenticateCreator only, so even a SUSPENDED creator can see their status. Always 200.
//   PUT    + requireActiveCreator, a per-creator rate limit, then the schema.
//   POST /bank-change   the same gates minus the schema.
const router = Router();

/** Payment status is per person and must never be served from a shared or browser cache. */
function noStore(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("Cache-Control", "no-store");
  next();
}
const signedIn = [noStore, requireCreatorsEnabled, authenticateCreator];

/**
 * 10 changing requests per creator per hour, keyed by creator id (never an IP: under `trust proxy 1`
 * behind Cloudflare an IP is a shared edge). It sits AFTER authentication, and BEFORE validation so a
 * script hammering the form counts too. The ceiling is read per request so a test can lower it.
 */
const payoutLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: () => envInt("RATE_LIMIT_CREATOR_PAYOUT_MAX", 10),
  keyGenerator: (req) => `creator-payout:${creatorOf(req).id}`,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: { code: "RATE_LIMIT", message: "Too many attempts. Please try again in an hour." } },
});

router.get(
  "/creator/payout-account",
  ...signedIn,
  asyncHandler(async (req: Request, res: Response) => success(res, await payouts.getPayoutAccount(creatorOf(req).id))),
);

router.put(
  "/creator/payout-account",
  ...signedIn,
  requireActiveCreator,
  payoutLimiter,
  validate(creatorPayoutAccountSchema),
  asyncHandler(async (req: Request, res: Response) => success(res, await payouts.setUpPayoutAccount(creatorOf(req).id, req.body))),
);

router.post(
  "/creator/payout-account/bank-change",
  ...signedIn,
  requireActiveCreator,
  payoutLimiter,
  asyncHandler(async (req: Request, res: Response) => success(res, await payouts.requestBankChange(creatorOf(req).id))),
);

export default router;
