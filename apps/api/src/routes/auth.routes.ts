import { Router, Request, Response, NextFunction } from "express";
import { validate } from "../middleware/validate";
import { authenticate } from "../middleware/auth";
import { authValidators } from "@dashmani/shared";
import * as authService from "../services/auth.service";
import { success } from "../utils/response";

const router = Router();

router.post("/auth/login", validate(authValidators.loginSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await authService.login(req.body.email, req.body.password);
    return success(res, result);
  } catch (err) {
    next(err);
  }
});

router.post("/auth/refresh", validate(authValidators.refreshSchema), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await authService.refresh(req.body.refreshToken);
    return success(res, result);
  } catch (err) {
    next(err);
  }
});

router.post("/auth/logout", authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    await authService.logout(req.user!.userId);
    return success(res, { message: "Logged out successfully" });
  } catch (err) {
    next(err);
  }
});

export default router;
