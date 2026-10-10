import { Router, Request, Response, NextFunction } from "express";
import { validate } from "../middleware/validate";
import {
  otpRequestSchema,
  otpVerifySchema,
  registerEmployeeSchema,
  passwordLoginSchema,
  hrGoogleSchema,
} from "@dashmani/shared";
import {
  requestOtp,
  verifyOtp,
  refreshHrToken,
  registerEmployee,
  loginWithPassword,
  hrGoogleSignIn,
} from "../services/hr-auth.service";
import { googleClientId, googleSignInEnabled } from "../services/google-id-token";
import { success } from "../utils/response";

const router = Router();

// GET /hr/auth/google/config — tells the sign-in page whether to render Google's button and
// with which OAuth client id. Runtime-only on purpose (no NEXT_PUBLIC_* to bake; the deploy
// script's .env.local overwrite cannot lose it). Blank env = no button, never a fake one.
router.get("/hr/auth/google/config", (_req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store");
  const enabled = googleSignInEnabled();
  return success(res, { enabled, clientId: enabled ? googleClientId() : null });
});

// POST /hr/auth/google — Google ID token → HR session (existing account) or a new ACTIVE
// Employee account. The login rate limiter is mounted on this exact path in app.ts.
router.post(
  "/hr/auth/google",
  validate(hrGoogleSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await hrGoogleSignIn(req.body.credential);
      return success(res, result);
    } catch (err) {
      next(err);
    }
  },
);

// POST /hr/auth/register — self-registration with password
router.post(
  "/hr/auth/register",
  validate(registerEmployeeSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await registerEmployee(req.body);
      return success(res, result, undefined, 201);
    } catch (err) {
      next(err);
    }
  },
);

// POST /hr/auth/login — password login
router.post(
  "/hr/auth/login",
  validate(passwordLoginSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { identifier, password } = req.body;
      const result = await loginWithPassword(identifier, password);
      return success(res, result);
    } catch (err) {
      next(err);
    }
  },
);

// POST /hr/auth/request-otp
router.post(
  "/hr/auth/request-otp",
  validate(otpRequestSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { identifier, channel } = req.body;
      const result = await requestOtp(identifier, channel);
      return success(res, result);
    } catch (err) {
      next(err);
    }
  },
);

// POST /hr/auth/verify-otp
router.post(
  "/hr/auth/verify-otp",
  validate(otpVerifySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { identifier, otp } = req.body;
      const result = await verifyOtp(identifier, otp);
      return success(res, result);
    } catch (err) {
      next(err);
    }
  },
);

// POST /hr/auth/refresh
router.post("/hr/auth/refresh", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({
        success: false,
        error: { code: "VALIDATION_ERROR", message: "refreshToken is required" },
      });
    }
    const result = await refreshHrToken(refreshToken);
    return success(res, result);
  } catch (err) {
    next(err);
  }
});

export default router;
