import { Router, Request, Response, NextFunction } from "express";
import { validate } from "../middleware/validate";
import { authenticate } from "../middleware/auth";
import { authValidators } from "@dashmani/shared";
import * as authService from "../services/auth.service";
import { success } from "../utils/response";
import { prisma } from "@dashmani/db";
import { z } from "zod";
import { safeString } from "@dashmani/shared";
import { uploadProfilePicture, toUploadUrl } from "../middleware/upload";

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

router.post("/auth/forgot-password", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, app } = req.body;
    if (!email || typeof email !== "string") {
      return success(res, { message: "If that email exists, a reset link has been sent" });
    }
    const appKey = app === "hr" ? "hr" : "internal";
    await authService.forgotPassword(email.trim().toLowerCase(), appKey);
    return success(res, { message: "If that email exists, a reset link has been sent" });
  } catch (err) {
    next(err);
  }
});

router.post("/auth/change-password", authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword || newPassword.length < 8) {
      return next(new Error("currentPassword and newPassword (min 8 chars) are required"));
    }
    await authService.changePassword(req.user!.userId, currentPassword, newPassword);
    return success(res, { message: "Password changed successfully" });
  } catch (err) {
    next(err);
  }
});

router.post("/auth/reset-password", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword || newPassword.length < 8) {
      return next(new Error("Token and a password of at least 8 characters are required"));
    }
    await authService.resetPassword(token, newPassword);
    return success(res, { message: "Password reset successfully" });
  } catch (err) {
    next(err);
  }
});

const updateMeSchema = z.object({
  name: safeString.pipe(z.string().min(2).max(100)).optional(),
});

router.put("/auth/me", authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = updateMeSchema.safeParse(req.body);
    if (!parsed.success) return next(new Error(parsed.error.errors[0]?.message || "Invalid input"));
    const updated = await prisma.user.update({
      where: { id: req.user!.userId },
      data: { ...(parsed.data.name ? { name: parsed.data.name } : {}) },
      select: { id: true, name: true, email: true, profileImageUrl: true },
    });
    return success(res, updated);
  } catch (err) {
    next(err);
  }
});

// POST /auth/me/profile-picture — self-upload, no approval needed (internal portal users)
router.post(
  "/auth/me/profile-picture",
  authenticate,
  uploadProfilePicture.single("file"),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (!req.file) return next(new Error("No file uploaded"));
      const url = toUploadUrl(req.file.path);
      const updated = await prisma.user.update({
        where: { id: req.user!.userId },
        data: { profileImageUrl: url },
        select: { id: true, name: true, email: true, profileImageUrl: true },
      });
      return success(res, updated);
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /auth/me/profile-picture — remove profile picture (set to null)
router.delete(
  "/auth/me/profile-picture",
  authenticate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const updated = await prisma.user.update({
        where: { id: req.user!.userId },
        data: { profileImageUrl: null },
        select: { id: true, name: true, email: true, profileImageUrl: true },
      });
      return success(res, updated);
    } catch (err) {
      next(err);
    }
  }
);

export default router;
