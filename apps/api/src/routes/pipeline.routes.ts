/**
 * /v1/pipeline/* — the HR-portal Pipeline API (spec §3). Ships DARK: with no
 * `pipeline.mode` row every gated route answers 403 PIPELINE_DISABLED.
 *
 * Mounted in routes/index.ts directly after hrRoutes. The app-level pieces that run
 * BEFORE this router live in app.ts (spec §3.1): the pipeline rate limiters, the 64 kb
 * JSON parser and its JSON error answers.
 *
 * ⚠️ Rules for every route added here (spec §3.2, §6, §10 "Forbidden"):
 *   - literal paths (/pipeline/bootstrap, /directory, /sync, the /projects list) are
 *     declared BEFORE /pipeline/projects/:id…;
 *   - every async handler/middleware is wrapped in asyncHandler;
 *   - no requirePermission, auditLog, dispatchNotification or withHeavyQuerySlot, and no
 *     global `prisma` — only pipelineRead / pipelineWrite;
 *   - responses carry Cache-Control: no-store;
 *   - the unknown-path 404 and pipelineErrorMiddleware stay LAST.
 */
import { Router, type Request, type Response } from "express";
import { authenticate } from "../middleware/auth";
import { pipelineErrorMiddleware } from "../services/pipeline/errors";

const router = Router();

// ── Unknown /pipeline paths (keep LAST, just above the error middleware) ─────────────
// Authenticated first so an anonymous probe learns nothing about which routes exist, and
// answered in JSON instead of Express's HTML "Cannot POST" page.
router.all(["/pipeline", "/pipeline/*"], authenticate, (_req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store");
  res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Not found" } });
});

router.use("/pipeline", pipelineErrorMiddleware);

export default router;
