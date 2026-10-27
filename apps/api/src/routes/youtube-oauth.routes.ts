import { Router, type Request, type Response } from "express";
import { authenticate } from "../middleware/auth";
import { requireInternalUser } from "../middleware/require-internal-user";
import { requirePermission } from "../middleware/rbac";
import { requireAdminRole } from "../middleware/require-admin-role";
import { AppError } from "../middleware/error-handler";
import { asyncHandler } from "../utils/async-handler";
import { success } from "../utils/response";
import { campaignConfig } from "../services/campaign/config";
import { buildAuthUrl, completeConnect, disconnect, listConnections, verifyState } from "../services/campaign/youtube.service";

// Phase 3 — connect YouTube channels for campaign auto-upload (internal portal, /campaigns/youtube).
// Same gate as the Meta connect: admins only, internal tokens only. The callback is public (Google
// redirects the browser to it); it trusts nothing but its signed state, and morgan blanks its
// code/state (redactOauthQuery in app.ts matches any /oauth/callback).

const router = Router();
const gate = [authenticate, requireInternalUser, requirePermission("reports", "manage"), requireAdminRole] as const;

router.post(
  "/admin/youtube/oauth/start",
  ...gate,
  asyncHandler(async (req: Request, res: Response) => success(res, { url: buildAuthUrl(req.user!.userId) })),
);

router.get(
  "/youtube/oauth/callback",
  asyncHandler(async (req: Request, res: Response) => {
    const back = (q: Record<string, string>) => `${campaignConfig.internalAppUrl()}/campaigns/youtube?${new URLSearchParams(q).toString()}`;
    res.setHeader("Cache-Control", "no-store");
    const staffId = verifyState(typeof req.query.state === "string" ? req.query.state : undefined);
    if (!staffId) return res.redirect(302, back({ error: "expired" }));
    if (typeof req.query.error === "string") return res.redirect(302, back({ error: req.query.error === "access_denied" ? "denied" : "google" }));
    const code = typeof req.query.code === "string" ? req.query.code : "";
    if (!code) return res.redirect(302, back({ error: "no_code" }));
    try {
      const row = await completeConnect(code, staffId);
      return res.redirect(302, back({ connected: row.channelTitle }));
    } catch (err) {
      const c = err instanceof AppError ? err.code : "failed";
      if (!(err instanceof AppError)) console.error("[youtube-oauth] connect failed:", err instanceof Error ? err.message : err);
      return res.redirect(302, back({ error: c }));
    }
  }),
);

router.get("/admin/youtube/connections", ...gate, asyncHandler(async (_req, res) => success(res, await listConnections())));

router.delete("/admin/youtube/connections/:id", ...gate, asyncHandler(async (req, res) => success(res, await disconnect(req.params.id))));

export default router;
