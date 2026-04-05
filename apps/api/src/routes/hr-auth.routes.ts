import { Router, Request, Response, NextFunction } from "express";
import { validate } from "../middleware/validate";
import { otpRequestSchema, otpVerifySchema } from "@dashmani/shared";
import { requestOtp, verifyOtp, refreshHrToken } from "../services/hr-auth.service";
import { success } from "../utils/response";

const router = Router();

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
