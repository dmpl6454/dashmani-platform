import { Router, Request, Response } from "express";
import { validate } from "../middleware/validate";
import { requireCreatorsEnabled, authenticateCreator, creatorOf } from "../middleware/creator-auth";
import {
  creatorSignupSchema,
  creatorLoginSchema,
  creatorRefreshSchema,
  creatorForgotSchema,
  creatorResetSchema,
  creatorVerifyEmailSchema,
  creatorGoogleSchema,
} from "@dashmani/shared/src/validators/creator";
import * as creatorAuth from "../services/creator/creator-auth.service";
import { googleClientId } from "../services/google-id-token";
import { asyncHandler } from "../utils/async-handler";
import { success } from "../utils/response";

// Creator portal (Phase A) — /v1/creator/auth/*. Every route is dark unless CREATORS_ENABLED=1.
// ⚠️ requireCreatorsEnabled is applied PER ROUTE, never as `router.use("/creator", …)`: this
// router is mounted ahead of creator-meta.routes, and a path-scoped use would also 503 the
// public Meta OAuth callback, which must always answer with a redirect.
// Rate limits live in app.ts (they read req.body): authLimiter on login / signup /
// forgot-password / google, plus the per-IP googleIpLimiter on google.
const router = Router();

// POST /v1/creator/auth/signup — public; 201 + session, or 409 for any existing email.
router.post(
  "/creator/auth/signup",
  requireCreatorsEnabled,
  validate(creatorSignupSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { name, email, password, country } = req.body;
    return success(res, await creatorAuth.creatorSignup({ name, email, password, country }), undefined, 201);
  }),
);

router.post(
  "/creator/auth/login",
  requireCreatorsEnabled,
  validate(creatorLoginSchema),
  asyncHandler(async (req: Request, res: Response) => {
    return success(res, await creatorAuth.creatorLogin(req.body.email, req.body.password));
  }),
);

router.post(
  "/creator/auth/refresh",
  requireCreatorsEnabled,
  validate(creatorRefreshSchema),
  asyncHandler(async (req: Request, res: Response) => {
    return success(res, await creatorAuth.creatorRefresh(req.body.refreshToken));
  }),
);

router.post(
  "/creator/auth/logout",
  requireCreatorsEnabled,
  validate(creatorRefreshSchema),
  asyncHandler(async (req: Request, res: Response) => {
    await creatorAuth.creatorLogout(req.body.refreshToken);
    return success(res, { loggedOut: true });
  }),
);

// Always { sent: true } — whether the email has an account is never revealed.
router.post(
  "/creator/auth/forgot-password",
  requireCreatorsEnabled,
  validate(creatorForgotSchema),
  asyncHandler(async (req: Request, res: Response) => {
    await creatorAuth.creatorForgotPassword(req.body.email);
    return success(res, { sent: true });
  }),
);

router.post(
  "/creator/auth/reset-password",
  requireCreatorsEnabled,
  validate(creatorResetSchema),
  asyncHandler(async (req: Request, res: Response) => {
    await creatorAuth.creatorResetPassword(req.body.token, req.body.newPassword);
    return success(res, { reset: true });
  }),
);

router.post(
  "/creator/auth/verify-email",
  requireCreatorsEnabled,
  validate(creatorVerifyEmailSchema),
  asyncHandler(async (req: Request, res: Response) => {
    await creatorAuth.creatorVerifyEmail(req.body.token);
    return success(res, { verified: true });
  }),
);

router.post(
  "/creator/auth/resend-verification",
  requireCreatorsEnabled,
  authenticateCreator,
  asyncHandler(async (req: Request, res: Response) => {
    return success(res, await creatorAuth.creatorResendVerification(creatorOf(req).id));
  }),
);

// GET /v1/creator/auth/google/config — whether "Continue with Google" is set up, and the GIS
// client id (one id for every portal; served at runtime so the app needs no rebuild).
router.get("/creator/auth/google/config", requireCreatorsEnabled, (_req: Request, res: Response) => {
  const clientId = googleClientId();
  res.setHeader("Cache-Control", "no-store");
  return success(res, { enabled: clientId !== null, clientId });
});

// POST /v1/creator/auth/google — existing email → 200 session; unknown email without the
// confirmations → 200 { needsProfile } (nothing written); with them → 201 session.
router.post(
  "/creator/auth/google",
  requireCreatorsEnabled,
  validate(creatorGoogleSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const r = await creatorAuth.creatorGoogleSignIn(req.body);
    if (r.kind === "needsProfile") return success(res, { needsProfile: true, email: r.email, name: r.name });
    return success(res, r.session, undefined, r.created ? 201 : 200);
  }),
);

export default router;
