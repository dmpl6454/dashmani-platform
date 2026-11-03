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
  pipelineWork as WK,
  PIPELINE_LIMITS,
  PIPELINE_REACTION_EMOJI,
  PIPELINE_REACTION_KEYS,
  type PipelineBootstrap,
  type PipelineDirectoryEntry,
  type PipelineReactionKey,
} from "@dashmani/shared";
import { success } from "../utils/response";
import { asyncHandler } from "../utils/async-handler";
import { G, G0, evaluatePipelineAccess } from "../middleware/pipeline-gates";
import { PipelineError, pipelineErrorMiddleware } from "../services/pipeline/errors";
import { getPipelineDirectory } from "../services/pipeline/access";
import { isPilotUser } from "../services/pipeline/settings";
import { getLivePhases } from "../services/pipeline/board";
// Side effect: installs the real notifier (services/pipeline/index.ts) wherever the routes load.
import "../services/pipeline";
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
import {
  postMessage,
  editMessage,
  deleteMessage,
  setReaction,
  listTopLevel,
  listReplies,
  type PipelineActor as MessageActor,
} from "../services/pipeline/messages.service";
import { markRead, syncPipeline } from "../services/pipeline/sync.service";
import {
  addVersion,
  createDeliverable,
  decideReview,
  deleteDeliverable,
  editDeliverable,
  getMyWork,
  getWork,
  requestReview,
  editVersionUsage,
  startUpload,
  versionFileUrl,
  addComment,
  resolveComment,
  type WorkActor,
} from "../services/pipeline/work.service";
import { listShoots, createShoot, editShoot, getWorkload } from "../services/pipeline/shoots.service";
import { pipelineStats } from "../services/pipeline/stats";
import {
  addChannelMembers,
  browseChannels,
  createChannel,
  deleteChannel,
  editChannel,
  hideDm,
  joinChannel,
  leaveChannel,
  listCampaignChannels,
  listConversations,
  openDm,
  removeChannelMember,
} from "../services/pipeline/conversations.service";
import { onlineUserIds } from "../services/pipeline/live";

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

// ══════════════════════════════════════════════════════════════════════════════════════
// Sales-portal chat: channels and DMs (conversations.service.ts). Literal /conversations,
// /channels, /dms and /presence paths — none collide with /projects/:id. A conversation's
// thread, replies, reactions and read state use the project routes below unchanged.
// ══════════════════════════════════════════════════════════════════════════════════════

router.get(
  "/pipeline/conversations",
  ...G,
  asyncHandler(async (req: Request, res: Response) => ok(res, await listConversations(actorOf(req)))),
);

// A campaign's channels (its own sidebar). Declared with the literal chat paths; the
// /projects/:id/channels suffix collides with no project route.
router.get(
  "/pipeline/projects/:id/channels",
  ...G,
  pv(V.projectParamsSchema, "params"),
  asyncHandler(async (req: Request, res: Response) => ok(res, await listCampaignChannels(actorOf(req), req.params.id))),
);

router.get(
  "/pipeline/channels/browse",
  ...G,
  pv(V.browseChannelsQuerySchema, "query"),
  asyncHandler(async (req: Request, res: Response) =>
    ok(res, await browseChannels(actorOf(req), (req.query as { q?: string }).q)),
  ),
);

router.post(
  "/pipeline/channels",
  ...G,
  pv(V.createChannelSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { status, data } = await createChannel(actorOf(req), req.body);
    return ok(res, data, status);
  }),
);

router.patch(
  "/pipeline/channels/:id",
  ...G,
  pv(V.projectParamsSchema, "params"),
  pv(V.editChannelSchema),
  asyncHandler(async (req: Request, res: Response) => ok(res, await editChannel(actorOf(req), req.params.id, req.body))),
);

router.delete(
  "/pipeline/channels/:id",
  ...G,
  pv(V.projectParamsSchema, "params"),
  pv(V.deleteChannelSchema),
  asyncHandler(async (req: Request, res: Response) => ok(res, await deleteChannel(actorOf(req), req.params.id, req.body.confirmName))),
);

router.post(
  "/pipeline/channels/:id/join",
  ...G,
  pv(V.projectParamsSchema, "params"),
  asyncHandler(async (req: Request, res: Response) => ok(res, await joinChannel(actorOf(req), req.params.id))),
);

router.post(
  "/pipeline/channels/:id/leave",
  ...G,
  pv(V.projectParamsSchema, "params"),
  asyncHandler(async (req: Request, res: Response) => ok(res, await leaveChannel(actorOf(req), req.params.id))),
);

router.post(
  "/pipeline/channels/:id/members",
  ...G,
  pv(V.projectParamsSchema, "params"),
  pv(V.addMembersSchema),
  asyncHandler(async (req: Request, res: Response) =>
    ok(res, await addChannelMembers(actorOf(req), req.params.id, req.body.userIds)),
  ),
);

router.delete(
  "/pipeline/channels/:id/members/:userId",
  ...G,
  pv(V.memberParamsSchema, "params"),
  asyncHandler(async (req: Request, res: Response) =>
    ok(res, await removeChannelMember(actorOf(req), req.params.id, req.params.userId)),
  ),
);

router.post(
  "/pipeline/dms",
  ...G,
  pv(V.openDmSchema),
  asyncHandler(async (req: Request, res: Response) => ok(res, await openDm(actorOf(req), req.body.userId))),
);

router.post(
  "/pipeline/dms/:id/hide",
  ...G,
  pv(V.projectParamsSchema, "params"),
  asyncHandler(async (req: Request, res: Response) => ok(res, await hideDm(actorOf(req), req.params.id))),
);

// In memory, no statement (live.ts). The gate itself stamps the caller as seen.
router.get("/pipeline/presence", ...G, (_req: Request, res: Response) => ok(res, { online: onlineUserIds() }));

// ══════════════════════════════════════════════════════════════════════════════════════
// PR 8 — messages and sync (routes #3, #15–21). Kept as one block so it rebases cleanly
// next to the project routes (PR 7). None of these paths collide with /projects/:id.
// Memos (settings, access, directory) are resolved here, BEFORE a service takes a slot.
// ══════════════════════════════════════════════════════════════════════════════════════

async function messageActorOf(req: Request): Promise<MessageActor> {
  const { userId, settings, access } = req.pipeline!;
  return { userId, name: access.name, settings, directory: await getPipelineDirectory() };
}

// ── #3 POST /pipeline/sync (literal path) ────────────────────────────────────────────
router.post(
  "/pipeline/sync",
  ...G,
  pv(V.syncRequestSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const t0 = performance.now();
    const data = await syncPipeline(await messageActorOf(req), req.body);
    pipelineStats.sync(performance.now() - t0);
    return ok(res, data);
  }),
);

// ── #15 GET /pipeline/projects/:id/messages (top-level history) ──────────────────────
router.get(
  "/pipeline/projects/:id/messages",
  ...G,
  pv(V.projectParamsSchema, "params"),
  pv(V.messagesQuerySchema, "query"),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as unknown as { before?: number; limit: number };
    return ok(res, await listTopLevel(await messageActorOf(req), req.params.id, q.before, q.limit));
  }),
);

// ── #16 GET /pipeline/messages/:mid/replies ──────────────────────────────────────────
router.get(
  "/pipeline/messages/:mid/replies",
  ...G,
  pv(V.messageParamsSchema, "params"),
  pv(V.repliesQuerySchema, "query"),
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query as unknown as { after: number; limit: number };
    return ok(res, await listReplies(await messageActorOf(req), req.params.mid, q.after, q.limit));
  }),
);

// ── #21 POST /pipeline/projects/:id/read (keepalive read marker) ─────────────────────
router.post(
  "/pipeline/projects/:id/read",
  ...G,
  pv(V.projectParamsSchema, "params"),
  pv(V.readSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { seq, leaving } = req.body as { seq: number; leaving?: boolean };
    return ok(res, await markRead(req.pipeline!.userId, req.params.id, seq, leaving === true));
  }),
);

// ── #17 POST /pipeline/projects/:id/messages ─────────────────────────────────────────
router.post(
  "/pipeline/projects/:id/messages",
  ...G,
  pv(V.projectParamsSchema, "params"),
  pv(V.postMessageSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const result = await postMessage(await messageActorOf(req), req.params.id, req.body);
    return ok(res, result.data, result.status);
  }),
);

// ── #18 PATCH /pipeline/messages/:mid ────────────────────────────────────────────────
router.patch(
  "/pipeline/messages/:mid",
  ...G,
  pv(V.messageParamsSchema, "params"),
  pv(V.editMessageSchema),
  asyncHandler(async (req: Request, res: Response) => {
    return ok(res, await editMessage(await messageActorOf(req), req.params.mid, req.body.body));
  }),
);

// ── #19 DELETE /pipeline/messages/:mid ───────────────────────────────────────────────
router.delete(
  "/pipeline/messages/:mid",
  ...G,
  pv(V.messageParamsSchema, "params"),
  asyncHandler(async (req: Request, res: Response) => {
    return ok(res, await deleteMessage(await messageActorOf(req), req.params.mid));
  }),
);

// ── #20 PUT /pipeline/messages/:mid/reactions/:emoji ─────────────────────────────────
router.put(
  "/pipeline/messages/:mid/reactions/:emoji",
  ...G,
  pv(V.reactionParamsSchema, "params"),
  pv(V.reactionBodySchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { mid, emoji } = req.params as { mid: string; emoji: PipelineReactionKey };
    return ok(res, await setReaction(await messageActorOf(req), mid, emoji, req.body.on));
  }),
);

// ══ end PR 8 block ════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════════════════
// Work tracking (2026-11-02): versions, version-bound reviews, one publishing record per
// page, and My Work. services/pipeline/work.service.ts. The directory is resolved here,
// BEFORE a service takes a slot. None of these paths collide with /projects/:id.
// ══════════════════════════════════════════════════════════════════════════════════════

async function workActorOf(req: Request): Promise<WorkActor> {
  return { ...actorOf(req), directory: await getPipelineDirectory() };
}

// GET /pipeline/my-work (literal path)
router.get(
  "/pipeline/my-work",
  ...G,
  asyncHandler(async (req: Request, res: Response) => {
    const { userId, settings } = req.pipeline!;
    return ok(res, await getMyWork(userId, await getPipelineDirectory(), settings));
  }),
);

// GET /pipeline/projects/:id/work
router.get(
  "/pipeline/projects/:id/work",
  ...G,
  pv(V.projectParamsSchema, "params"),
  asyncHandler(async (req: Request, res: Response) => ok(res, await getWork(await getPipelineDirectory(), req.params.id))),
);

// POST /pipeline/projects/:id/versions
router.post(
  "/pipeline/projects/:id/versions",
  ...G,
  pv(V.projectParamsSchema, "params"),
  pv(WK.addVersionSchema),
  asyncHandler(async (req: Request, res: Response) => ok(res, await addVersion(await workActorOf(req), req.params.id, req.body), 201)),
);

// POST /pipeline/projects/:id/uploads — a signed PUT URL; the browser sends the file to R2 itself
router.post(
  "/pipeline/projects/:id/uploads",
  ...G,
  pv(V.projectParamsSchema, "params"),
  pv(WK.startUploadSchema),
  asyncHandler(async (req: Request, res: Response) => ok(res, await startUpload(await workActorOf(req), req.params.id, req.body), 201)),
);

// GET /pipeline/versions/:vid/file?download=1 — a short-lived link to the uploaded file
router.get(
  "/pipeline/versions/:vid/file",
  ...G,
  pv(WK.versionParamsSchema, "params"),
  pv(WK.versionFileQuerySchema, "query"),
  asyncHandler(async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    return ok(res, await versionFileUrl(req.params.vid, req.query.download === "1"));
  }),
);

// POST /pipeline/projects/:id/reviews
router.post(
  "/pipeline/projects/:id/reviews",
  ...G,
  pv(V.projectParamsSchema, "params"),
  pv(WK.requestReviewSchema),
  asyncHandler(async (req: Request, res: Response) => ok(res, await requestReview(await workActorOf(req), req.params.id, req.body), 201)),
);

// POST /pipeline/reviews/:rid/decision
router.post(
  "/pipeline/reviews/:rid/decision",
  ...G,
  pv(WK.reviewParamsSchema, "params"),
  pv(WK.decideReviewSchema),
  asyncHandler(async (req: Request, res: Response) => ok(res, await decideReview(await workActorOf(req), req.params.rid, req.body))),
);

// POST /pipeline/projects/:id/deliverables
router.post(
  "/pipeline/projects/:id/deliverables",
  ...G,
  pv(V.projectParamsSchema, "params"),
  pv(WK.createDeliverableSchema),
  asyncHandler(async (req: Request, res: Response) =>
    ok(res, await createDeliverable(await workActorOf(req), req.params.id, req.body), 201),
  ),
);

// PATCH /pipeline/deliverables/:did
router.patch(
  "/pipeline/deliverables/:did",
  ...G,
  pv(WK.deliverableParamsSchema, "params"),
  pv(WK.editDeliverableSchema),
  asyncHandler(async (req: Request, res: Response) => ok(res, await editDeliverable(await workActorOf(req), req.params.did, req.body))),
);

// DELETE /pipeline/deliverables/:did (never a published one)
router.delete(
  "/pipeline/deliverables/:did",
  ...G,
  pv(WK.deliverableParamsSchema, "params"),
  asyncHandler(async (req: Request, res: Response) => ok(res, await deleteDeliverable(await workActorOf(req), req.params.did))),
);

// PATCH /pipeline/versions/:vid — source, rights, licence, embargo (the file itself never changes)
router.patch(
  "/pipeline/versions/:vid",
  ...G,
  pv(WK.versionParamsSchema, "params"),
  pv(WK.editVersionUsageSchema),
  asyncHandler(async (req: Request, res: Response) => ok(res, await editVersionUsage(await workActorOf(req), req.params.vid, req.body))),
);

// POST /pipeline/versions/:vid/comments — a review comment, optionally at a point in the video
router.post(
  "/pipeline/versions/:vid/comments",
  ...G,
  pv(WK.versionParamsSchema, "params"),
  pv(WK.addCommentSchema),
  asyncHandler(async (req: Request, res: Response) => ok(res, await addComment(await workActorOf(req), req.params.vid, req.body), 201)),
);

// PUT /pipeline/comments/:cid/resolved
router.put(
  "/pipeline/comments/:cid/resolved",
  ...G,
  pv(WK.commentParamsSchema, "params"),
  pv(WK.resolveCommentSchema),
  asyncHandler(async (req: Request, res: Response) =>
    ok(res, await resolveComment(await workActorOf(req), req.params.cid, req.body.resolved)),
  ),
);

// GET /pipeline/shoots?view=upcoming|mine|past
router.get(
  "/pipeline/shoots",
  ...G,
  pv(WK.shootListQuerySchema, "query"),
  asyncHandler(async (req: Request, res: Response) => {
    const { view } = req.query as unknown as { view: "upcoming" | "mine" | "past" };
    return ok(res, await listShoots(req.pipeline!.userId, await getPipelineDirectory(), view));
  }),
);

// POST /pipeline/shoots
router.post(
  "/pipeline/shoots",
  ...G,
  pv(WK.createShootSchema),
  asyncHandler(async (req: Request, res: Response) => ok(res, await createShoot(await workActorOf(req), req.body), 201)),
);

// PATCH /pipeline/shoots/:sid
router.patch(
  "/pipeline/shoots/:sid",
  ...G,
  pv(WK.shootParamsSchema, "params"),
  pv(WK.editShootSchema),
  asyncHandler(async (req: Request, res: Response) => ok(res, await editShoot(await workActorOf(req), req.params.sid, req.body))),
);

// GET /pipeline/workload — per-person load across pages, reviews, shoots and projects
router.get(
  "/pipeline/workload",
  ...G,
  asyncHandler(async (_req: Request, res: Response) => ok(res, await getWorkload(await getPipelineDirectory()))),
);

// ══ end work tracking block ═══════════════════════════════════════════════════════════

// ── Unknown /pipeline paths (keep LAST, just above the error middleware) ─────────────
// Behind G0 so an anonymous or wrong-portal caller learns nothing about which routes
// exist, and answered in JSON instead of Express's HTML "Cannot POST" page.
router.all(["/pipeline", "/pipeline/*"], ...G0, (_req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store");
  res.status(404).json({ success: false, error: { code: "NOT_FOUND", message: "Not found" } });
});

router.use("/pipeline", pipelineErrorMiddleware);

export default router;
