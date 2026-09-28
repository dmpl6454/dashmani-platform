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
 *   - responses go through `ok()` (Cache-Control: no-store — app.ts also sets it on
 *     every /v1/pipeline response up front, so authenticate's 401 and validate()'s 400
 *     carry it too);
 *   - the unknown-path 404 and pipelineErrorMiddleware stay LAST.
 */
import { Router, type Request, type Response, type NextFunction, type RequestHandler } from "express";
import type { ZodSchema } from "zod";
import {
  pipelineValidators as V,
  PIPELINE_LIMITS,
  PIPELINE_REACTION_EMOJI,
  PIPELINE_REACTION_KEYS,
  type PipelineBootstrap,
  type PipelineDirectoryEntry,
} from "@dashmani/shared";
import { success } from "../utils/response";
import { asyncHandler } from "../utils/async-handler";
import { G, G0, evaluatePipelineAccess } from "../middleware/pipeline-gates";
import { PipelineError, pipelineErrorMiddleware } from "../services/pipeline/errors";
import { getPipelineDirectory } from "../services/pipeline/access";
import { isPilotUser } from "../services/pipeline/settings";
import { getLivePhases } from "../services/pipeline/board";
import {
  createProject,
  editProject,
  getProjectDetail,
  listProjects,
  moveProject,
  archiveProject,
  unarchiveProject,
  restoreProject,
  deleteProject,
  transferOwner,
  type PipelineActor,
} from "../services/pipeline/projects.service";
import { addMembers, removeMember, setFollow } from "../services/pipeline/participants";

const router = Router();

function ok<T>(res: Response, data: T, status = 200) {
  res.setHeader("Cache-Control", "no-store");
  return success(res, data, undefined, status);
}

/**
 * `validate(schema, source)` for pipeline routes: a Zod failure goes to the pipeline error
 * middleware (400 VALIDATION_ERROR + details), except a start-after-due refinement, which
 * is answered as 400 DATE_ORDER (spec §3.4 route #7).
 */
function pv(schema: ZodSchema, source: "body" | "query" | "params" = "body"): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req[source] ?? {});
    if (!parsed.success) {
      if (parsed.error.issues.some((i) => i.message === V.DATE_ORDER)) {
        next(new PipelineError(400, "DATE_ORDER", "The due date can't be before the start date"));
        return;
      }
      next(parsed.error);
      return;
    }
    (req as unknown as Record<string, unknown>)[source] = parsed.data;
    next();
  };
}

/** The acting user, from the G gate's memo reads (no statements). */
function actorOf(req: Request): PipelineActor {
  const ctx = req.pipeline!;
  return { userId: ctx.userId, name: ctx.access.name, isAdminHint: ctx.access.isAdmin, settings: ctx.settings };
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
        pickable: e.active && (!pilot || isPilotUser(settings, e.id)),
      };
      if (e.hint) entry.hint = e.hint;
      return entry;
    });
    return ok(res, data);
  }),
);

// ── #4 GET /pipeline/projects (archived / deleted lists; literal path before /:id) ────
router.get(
  "/pipeline/projects",
  ...G,
  pv(V.listProjectsQuerySchema, "query"),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as unknown as { view: "archived" | "deleted"; cursor?: { at: string; id: string }; limit: number };
    return ok(res, await listProjects(actorOf(req), q));
  }),
);

// ── #5 POST /pipeline/projects ───────────────────────────────────────────────────────
router.post(
  "/pipeline/projects",
  ...G,
  pv(V.createProjectSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { status, data } = await createProject(actorOf(req), req.body);
    return ok(res, data, status);
  }),
);

// ── #6 GET /pipeline/projects/:id ────────────────────────────────────────────────────
router.get(
  "/pipeline/projects/:id",
  ...G,
  pv(V.projectParamsSchema, "params"),
  pv(V.projectDetailQuerySchema, "query"),
  asyncHandler(async (req: Request, res: Response) => {
    const dir = await getPipelineDirectory(); // memo: resolved BEFORE the handler takes a slot
    const { around } = req.query as { around?: string };
    return ok(res, await getProjectDetail(actorOf(req), req.params.id, around, dir));
  }),
);

// ── #7 PATCH /pipeline/projects/:id ──────────────────────────────────────────────────
router.patch(
  "/pipeline/projects/:id",
  ...G,
  pv(V.projectParamsSchema, "params"),
  pv(V.editProjectSchema),
  asyncHandler(async (req: Request, res: Response) => {
    return ok(res, await editProject(actorOf(req), req.params.id, req.body.changes, req.body.base));
  }),
);

// ── #8 POST /pipeline/projects/:id/move ──────────────────────────────────────────────
router.post(
  "/pipeline/projects/:id/move",
  ...G,
  pv(V.projectParamsSchema, "params"),
  pv(V.moveProjectSchema),
  asyncHandler(async (req: Request, res: Response) => {
    return ok(res, await moveProject(actorOf(req), req.params.id, req.body));
  }),
);

// ── #9 POST …/archive, …/unarchive, …/restore (+O; admin-only after an admin action) ─
const LIFECYCLE = { archive: archiveProject, unarchive: unarchiveProject, restore: restoreProject } as const;
for (const [action, fn] of Object.entries(LIFECYCLE)) {
  router.post(
    `/pipeline/projects/:id/${action}`,
    ...G,
    pv(V.projectParamsSchema, "params"),
    pv(V.emptyBodySchema),
    asyncHandler(async (req: Request, res: Response) => ok(res, await fn(actorOf(req), req.params.id))),
  );
}

// ── #10 DELETE /pipeline/projects/:id (+O; soft delete) ──────────────────────────────
router.delete(
  "/pipeline/projects/:id",
  ...G,
  pv(V.projectParamsSchema, "params"),
  pv(V.deleteProjectSchema),
  asyncHandler(async (req: Request, res: Response) =>
    ok(res, await deleteProject(actorOf(req), req.params.id, req.body.confirmTitle)),
  ),
);

// ── #11 PUT /pipeline/projects/:id/owner (+O) ────────────────────────────────────────
router.put(
  "/pipeline/projects/:id/owner",
  ...G,
  pv(V.projectParamsSchema, "params"),
  pv(V.transferOwnerSchema),
  asyncHandler(async (req: Request, res: Response) => ok(res, await transferOwner(actorOf(req), req.params.id, req.body.userId))),
);

// ── #12 POST /pipeline/projects/:id/members ──────────────────────────────────────────
router.post(
  "/pipeline/projects/:id/members",
  ...G,
  pv(V.projectParamsSchema, "params"),
  pv(V.addMembersSchema),
  asyncHandler(async (req: Request, res: Response) => ok(res, await addMembers(actorOf(req), req.params.id, req.body.userIds))),
);

// ── #13 DELETE /pipeline/projects/:id/members/:userId (removal rule §4.6) ────────────
router.delete(
  "/pipeline/projects/:id/members/:userId",
  ...G,
  pv(V.memberParamsSchema, "params"),
  asyncHandler(async (req: Request, res: Response) =>
    ok(res, await removeMember(actorOf(req), req.params.id, req.params.userId)),
  ),
);

// ── #14 PUT /pipeline/projects/:id/follow (self only) ────────────────────────────────
router.put(
  "/pipeline/projects/:id/follow",
  ...G,
  pv(V.projectParamsSchema, "params"),
  pv(V.followSchema),
  asyncHandler(async (req: Request, res: Response) => ok(res, await setFollow(actorOf(req), req.params.id, req.body.following))),
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
