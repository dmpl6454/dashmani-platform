/**
 * /v1/pipeline/* — the HR-portal Pipeline API (spec §3). Ships DARK: with no
 * `pipeline.mode` row, bootstrap answers {enabled:false} and every other route 403
 * PIPELINE_DISABLED.
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
 *   - responses go through `ok()` (Cache-Control: no-store);
 *   - the unknown-path 404 and pipelineErrorMiddleware stay LAST.
 */
import { Router, type Request, type Response } from "express";
import {
  PIPELINE_LIMITS,
  PIPELINE_REACTION_EMOJI,
  PIPELINE_REACTION_KEYS,
  type PipelineBootstrap,
  type PipelineDirectoryEntry,
} from "@dashmani/shared";
import { success } from "../utils/response";
import { asyncHandler } from "../utils/async-handler";
import { G, G0, evaluatePipelineAccess } from "../middleware/pipeline-gates";
import { pipelineErrorMiddleware } from "../services/pipeline/errors";
import { getPipelineDirectory } from "../services/pipeline/access";
import { getLivePhases } from "../services/pipeline/board";

const router = Router();

function ok<T>(res: Response, data: T, status = 200) {
  res.setHeader("Cache-Control", "no-store");
  return success(res, data, undefined, status);
}

// ── #1 GET /pipeline/bootstrap (G0; the feature check is inside) ─────────────────────
router.get(
  "/pipeline/bootstrap",
  ...G0,
  asyncHandler(async (req: Request, res: Response) => {
    const result = await evaluatePipelineAccess(req.user!.userId);
    if (!result.ok) {
      const off: PipelineBootstrap = { enabled: false, reason: result.denial.reason };
      return ok(res, off);
    }
    const { userId, settings, access } = result.ctx;
    const phases = await getLivePhases();
    const data: PipelineBootstrap = {
      enabled: true,
      mode: settings.mode === "on" ? "on" : "pilot",
      navVisible: settings.mode === "on",
      me: { id: userId, name: access.name, isAdmin: access.isAdmin },
      phases,
      pollMs: settings.pollMs,
      reactions: PIPELINE_REACTION_KEYS.map((key) => ({ key, emoji: PIPELINE_REACTION_EMOJI[key] })),
      limits: PIPELINE_LIMITS,
      minClientBuild: settings.minClientBuild,
    };
    return ok(res, data);
  }),
);

// ── #2 GET /pipeline/directory (G) ───────────────────────────────────────────────────
// Names only — never email or phone. `pickable` is applied per request from the current
// settings, so a pilot-list change shows within 15 s even though the names are cached 5 min.
router.get(
  "/pipeline/directory",
  ...G,
  asyncHandler(async (req: Request, res: Response) => {
    const { settings } = req.pipeline!;
    const dir = await getPipelineDirectory();
    const pilot = settings.mode === "pilot";
    const data: PipelineDirectoryEntry[] = dir.entries.map((e) => {
      const entry: PipelineDirectoryEntry = {
        id: e.id,
        name: e.name,
        initials: e.initials,
        active: e.active,
        pickable: e.active && (!pilot || settings.pilotUserIds.has(e.id)),
      };
      if (e.hint) entry.hint = e.hint;
      return entry;
    });
    return ok(res, data);
  }),
);

// ── Unknown /pipeline paths (keep LAST, just above the error middleware) ─────────────
// Behind G0 so an anonymous or wrong-portal caller learns nothing about which routes
// exist, and answered in JSON instead of Express's HTML "Cannot POST" page.
router.all(["/pipeline", "/pipeline/*"], ...G0, (_req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store");
  res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Not found" } });
});

router.use("/pipeline", pipelineErrorMiddleware);

export default router;
