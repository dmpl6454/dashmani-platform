import { Router, Request, Response } from "express";
import { authenticate } from "../middleware/auth";
import { requireInternalUser } from "../middleware/require-internal-user";
import { requireAdminRole } from "../middleware/require-admin-role";
import { recordVital, vitalsSummary } from "../services/web-vitals.service";
import { success, error } from "../utils/response";

const router = Router();

// Any signed-in portal session (staff, HR, client, sales, billing) may report its own page
// speed. Signed-in only: keyed per user by the rate limiter, and no anonymous endpoint that
// a script could fill. At most 20 samples per request; anything malformed is dropped, not stored.
router.post("/web-vitals", authenticate, (req: Request, res: Response) => {
  const app = typeof req.body?.app === "string" ? req.body.app : "";
  const samples = Array.isArray(req.body?.samples) ? req.body.samples.slice(0, 20) : null;
  if (!app || !samples) return error(res, "VALIDATION_ERROR", "Expected { app, samples[] }", 400);
  let kept = 0;
  for (const s of samples) {
    if (s && typeof s === "object" && recordVital(app, String((s as any).route ?? ""), String((s as any).name ?? ""), Number((s as any).value))) kept++;
  }
  return success(res, { kept });
});

// Admins only, like the other operational pages (API Costs).
router.get("/admin/web-vitals", authenticate, requireInternalUser, requireAdminRole, (_req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store");
  return success(res, vitalsSummary());
});

export default router;
