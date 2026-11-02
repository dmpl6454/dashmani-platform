/**
 * Pipeline work tracking (2026-11-02): versions, version-bound reviews, one publishing record per
 * destination page, and each person's "My Work" queue. Rules and wire shapes live in
 * packages/shared/src/pipeline/work.ts; tables in scripts/pipeline-work-ddl.sql.
 *
 *   - Every write takes the PROJECT row lock first (lockProject), so versions are numbered,
 *     reviews superseded and deliverables edited in one order per project — never two at once.
 *   - An approval is pinned to versions: a newer version makes it outdated (computed on read),
 *     and a page can be marked scheduled or published only under the CURRENT approval when the
 *     project has any version. The approval in force is stamped on the page.
 *   - Review requests, decisions and published pages also post a line in the project thread
 *     (postMessage, after commit, best effort): the thread keeps the record and the existing
 *     mention notifications reach the reviewer or requester — no new notification kind.
 *
 * ⚠️ Pipeline pool only (pipelineRead / pipelineWrite), like every file in this folder. No FK into
 * `users`: people are checked against the pipeline directory, which is resolved by the route
 * BEFORE a slot is taken.
 * ⚠️ If the DDL is missing (a deploy reached a database without scripts/pipeline-work-ddl.sql),
 * these routes answer 503 WORK_NOT_READY; the rest of the Pipeline is unaffected.
 */
import { randomUUID, randomBytes } from "crypto";
import { pipelineWork as W, dateToIST } from "@dashmani/shared";
import { pipelineRead, pipelineWrite } from "./tx";
import { PipelineError } from "./errors";
import { lockProject, assertWritable, pickableByMode, type PipelineActor } from "./projects.service";
import { postMessage } from "./messages.service";
import type { PipelineDirectory } from "./access";
import type { PipelineSettings } from "./settings";
import type { PipelineDbClient, PipelineTx } from "./db";
import { r2Config, presignR2, headR2Object } from "../storage/r2";


type Db = PipelineDbClient | PipelineTx;

export interface WorkActor extends PipelineActor {
  directory: PipelineDirectory;
}

// ── Errors ─────────────────────────────────────────────────────────────────────────

const notReady = () =>
  new PipelineError(503, "WORK_NOT_READY", "Work tracking is waiting for a one-time database update", { retryAfterSec: 60 });

/** True for "relation / column does not exist" in any shape Prisma reports it. */
function isMissingSchema(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && typeof e === "object" && i < 3; e = (e as { original?: unknown }).original, i++) {
    const code = (e as { code?: unknown }).code;
    if (code === "P2021" || code === "P2022") return true;
    const msg = String((e as { message?: unknown }).message ?? "").slice(0, 2000);
    if (/42P01|42703|relation "pipeline_(versions|reviews|deliverables|version_comments|shoots)" does not exist/.test(msg)) return true;
  }
  return false;
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isMissingSchema(err)) throw notReady();
    throw err;
  }
}

// ── Mapping ────────────────────────────────────────────────────────────────────────

function person(dir: PipelineDirectory, id: string): W.PipelineWorkPerson {
  return { id, name: dir.byId.get(id)?.name ?? "Former member" };
}

function personOrNull(dir: PipelineDirectory, id: string | null): W.PipelineWorkPerson | null {
  return id ? person(dir, id) : null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

interface VersionRow {
  id: string;
  kind: string;
  number: number;
  label: string;
  url: string | null;
  fileKey: string | null;
  fileName: string;
  fileSize: bigint | null;
  fileType: string;
  body: string;
  note: string;
  source: string;
  rights: string;
  licenceExpires: Date | null;
  embargoUntil: Date | null;
  usageNotes: string;
  createdById: string;
  createdAt: Date;
}

interface CommentRow {
  id: string;
  versionId: string;
  authorId: string;
  atSeconds: number | null;
  body: string;
  resolvedAt: Date | null;
  resolvedById: string | null;
  createdAt: Date;
}

interface ReviewRow {
  id: string;
  projectId: string;
  requestedById: string;
  reviewerId: string;
  versionIds: string[];
  status: string;
  note: string;
  decidedAt: Date | null;
  createdAt: Date;
}

interface DeliverableRow {
  id: string;
  platform: string;
  destination: string;
  caption: string;
  scheduledAt: Date | null;
  status: string;
  assigneeId: string | null;
  liveUrl: string | null;
  publishedAt: Date | null;
  publishedById: string | null;
  approvedReviewId: string | null;
  note: string;
  rev: number;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
}

function commentDto(dir: PipelineDirectory, c: CommentRow): W.PipelineCommentDto {
  return {
    id: c.id,
    versionId: c.versionId,
    author: person(dir, c.authorId),
    atSeconds: c.atSeconds,
    body: c.body,
    resolvedAt: iso(c.resolvedAt),
    resolvedBy: personOrNull(dir, c.resolvedById),
    createdAt: c.createdAt.toISOString(),
  };
}

function versionDto(dir: PipelineDirectory, v: VersionRow, comments: readonly CommentRow[] = []): W.PipelineVersionDto {
  return {
    id: v.id,
    kind: v.kind as W.PipelineVersionKind,
    number: v.number,
    label: v.label,
    url: v.url,
    file: v.fileKey ? { name: v.fileName || "file", size: v.fileSize == null ? 0 : Number(v.fileSize), type: v.fileType } : null,
    body: v.body,
    note: v.note,
    source: v.source,
    rights: (v.rights || "") as W.PipelineRights | "",
    licenceExpires: v.licenceExpires ? v.licenceExpires.toISOString().slice(0, 10) : null,
    embargoUntil: iso(v.embargoUntil),
    usageNotes: v.usageNotes,
    createdBy: person(dir, v.createdById),
    createdAt: v.createdAt.toISOString(),
    comments: comments.map((c) => commentDto(dir, c)),
  };
}

const COMMENT_SELECT = {
  id: true, versionId: true, authorId: true, atSeconds: true, body: true, resolvedAt: true, resolvedById: true, createdAt: true,
} as const;

function reviewDto(dir: PipelineDirectory, r: ReviewRow, latest: readonly string[]): W.PipelineReviewDto {
  return {
    id: r.id,
    requestedBy: person(dir, r.requestedById),
    reviewer: person(dir, r.reviewerId),
    versionIds: r.versionIds ?? [],
    status: r.status as W.PipelineReviewStatus,
    outdated: W.isReviewOutdated({ versionIds: r.versionIds ?? [] }, latest),
    note: r.note,
    decidedAt: iso(r.decidedAt),
    createdAt: r.createdAt.toISOString(),
  };
}

function deliverableDto(dir: PipelineDirectory, d: DeliverableRow): W.PipelineDeliverableDto {
  return {
    id: d.id,
    platform: d.platform as W.PipelineDeliverablePlatform,
    destination: d.destination,
    caption: d.caption,
    scheduledAt: iso(d.scheduledAt),
    status: d.status as W.PipelineDeliverableStatus,
    assignee: personOrNull(dir, d.assigneeId),
    liveUrl: d.liveUrl,
    publishedAt: iso(d.publishedAt),
    publishedBy: personOrNull(dir, d.publishedById),
    approvedReviewId: d.approvedReviewId,
    note: d.note,
    rev: d.rev,
    createdBy: person(dir, d.createdById),
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

const VERSION_SELECT = {
  id: true, kind: true, number: true, label: true, url: true, body: true, note: true, createdById: true, createdAt: true,
  fileKey: true, fileName: true, fileSize: true, fileType: true,
  source: true, rights: true, licenceExpires: true, embargoUntil: true, usageNotes: true,
} as const;

const REVIEW_SELECT = {
  id: true, projectId: true, requestedById: true, reviewerId: true, versionIds: true, status: true, note: true,
  decidedAt: true, createdAt: true,
} as const;

// ── Reads ──────────────────────────────────────────────────────────────────────────

async function readVersions(db: Db, projectId: string): Promise<VersionRow[]> {
  return db.pipelineVersion.findMany({
    where: { projectId },
    select: VERSION_SELECT,
    orderBy: [{ kind: "asc" }, { number: "desc" }],
    take: W.PIPELINE_WORK_LIMITS.versionsPerProject,
  });
}

async function readReviews(db: Db, projectId: string): Promise<ReviewRow[]> {
  return db.pipelineReview.findMany({
    where: { projectId },
    select: REVIEW_SELECT,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: W.PIPELINE_WORK_LIMITS.reviewsShown,
  });
}

/** The approval a page may be scheduled or published under, read inside the write's lock. */
async function currentApproval(tx: PipelineTx, projectId: string): Promise<{ hasVersions: boolean; approvedReviewId: string | null }> {
  const versions = await tx.pipelineVersion.findMany({
    where: { projectId },
    select: { id: true, kind: true, number: true },
    take: W.PIPELINE_WORK_LIMITS.versionsPerProject,
  });
  if (versions.length === 0) return { hasVersions: false, approvedReviewId: null };
  const reviews = await readReviews(tx, projectId);
  return { hasVersions: true, approvedReviewId: W.approvalSummary(versions, reviews).approvedReviewId };
}

async function assertProjectReadable(db: Db, projectId: string): Promise<void> {
  const p = await db.pipelineProject.findUnique({ where: { id: projectId }, select: { deletedAt: true } });
  if (!p) throw new PipelineError(404, "PROJECT_NOT_FOUND", "This project doesn't exist");
  if (p.deletedAt) throw new PipelineError(404, "PROJECT_DELETED", "This project was deleted");
}

export async function getWork(dir: PipelineDirectory, projectId: string): Promise<W.PipelineWorkDto> {
  return guarded(async () => {
    const { versions, reviews, deliverables, comments } = await pipelineRead(async (db) => {
      await assertProjectReadable(db, projectId);
      const versions = await readVersions(db, projectId);
      const reviews = await readReviews(db, projectId);
      const deliverables = await db.pipelineDeliverable.findMany({
        where: { projectId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: W.PIPELINE_WORK_LIMITS.deliverablesPerProject,
      });
      const comments = await db.pipelineVersionComment.findMany({
        where: { projectId },
        select: COMMENT_SELECT,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: 2000,
      });
      return { versions, reviews, deliverables, comments };
    });
    const latest = W.latestVersionIds(versions);
    const byVersion = new Map<string, CommentRow[]>();
    for (const c of comments) {
      const list = byVersion.get(c.versionId) ?? [];
      list.push(c);
      byVersion.set(c.versionId, list);
    }
    // Comments at a point in the video first in time order, then whole-file ones, oldest first.
    for (const list of byVersion.values()) {
      list.sort((a, b) => (a.atSeconds ?? Infinity) - (b.atSeconds ?? Infinity) || a.createdAt.getTime() - b.createdAt.getTime());
    }
    return {
      versions: versions.map((v) => versionDto(dir, v, byVersion.get(v.id))),
      reviews: reviews.map((r) => reviewDto(dir, r, latest)),
      deliverables: deliverables.map((d) => deliverableDto(dir, d)),
      approval: W.approvalSummary(versions, reviews),
      uploads: r2Config() !== null,
    };
  });
}

// ── People ─────────────────────────────────────────────────────────────────────────

function assertPickable(actor: WorkActor, userId: string, what: string): void {
  const e = actor.directory.byId.get(userId);
  if (!e || !e.active || !pickableByMode(actor.settings, userId)) {
    throw new PipelineError(400, "USER_NOT_PICKABLE", `That ${what} can't be picked — choose an active team member`);
  }
}

// ── Thread lines (after commit, best effort) ───────────────────────────────────────

async function postLine(actor: WorkActor, projectId: string, body: string): Promise<void> {
  try {
    await postMessage(
      { userId: actor.userId, name: actor.name, settings: actor.settings, directory: actor.directory },
      projectId,
      { clientId: randomUUID(), body },
    );
  } catch (err) {
    // The work item is saved either way; the thread line is a convenience.
    console.warn(`[pipeline-work] thread line not posted on ${projectId}: ${(err as Error)?.message ?? err}`);
  }
}

function versionNames(versions: readonly Pick<VersionRow, "id" | "kind" | "number">[], ids: readonly string[]): string {
  const set = new Set(ids);
  return versions
    .filter((v) => set.has(v.id))
    .sort((a, b) => W.PIPELINE_VERSION_KINDS.indexOf(a.kind as W.PipelineVersionKind) - W.PIPELINE_VERSION_KINDS.indexOf(b.kind as W.PipelineVersionKind))
    .map((v) => `${W.PIPELINE_VERSION_KIND_LABEL[v.kind as W.PipelineVersionKind] ?? v.kind} v${v.number}`)
    .join(", ");
}

// ── Versions ───────────────────────────────────────────────────────────────────────

export async function addVersion(actor: WorkActor, projectId: string, input: W.AddVersionInput): Promise<W.PipelineVersionDto> {
  // An uploaded file is checked against R2 BEFORE the transaction: never hold the project lock
  // across a network call.
  const file = input.fileKey ? await verifyUploadedFile(projectId, input.kind, input.fileKey) : null;
  return guarded(async () => {
    const row = await pipelineWrite(async (tx) => {
      assertWritable(await lockProject(tx, projectId, actor.userId));
      if (input.fileKey && (await tx.pipelineVersion.findUnique({ where: { fileKey: input.fileKey }, select: { id: true } }))) {
        throw new PipelineError(409, "FILE_ALREADY_USED", "This file is already on a version");
      }
      const count = await tx.pipelineVersion.count({ where: { projectId } });
      if (count >= W.PIPELINE_WORK_LIMITS.versionsPerProject) {
        throw new PipelineError(409, "TOO_MANY_VERSIONS", "This project has the most versions it can hold");
      }
      const last = await tx.pipelineVersion.findFirst({
        where: { projectId, kind: input.kind },
        orderBy: { number: "desc" },
        select: { number: true },
      });
      return tx.pipelineVersion.create({
        data: {
          projectId,
          kind: input.kind,
          number: (last?.number ?? 0) + 1,
          label: input.label ?? "",
          url: input.url ?? null,
          fileKey: input.fileKey ?? null,
          fileName: file ? fileNameOf(input.fileName) : "",
          fileSize: file ? BigInt(file.size) : null,
          fileType: file ? file.contentType : "",
          body: input.body ?? "",
          note: input.note ?? "",
          source: input.source ?? "",
          rights: input.rights ?? "",
          licenceExpires: input.licenceExpires ? new Date(`${input.licenceExpires}T00:00:00Z`) : null,
          embargoUntil: input.embargoUntil ? new Date(input.embargoUntil) : null,
          usageNotes: input.usageNotes ?? "",
          createdById: actor.userId,
        },
        select: VERSION_SELECT,
      });
    });
    return versionDto(actor.directory, row);
  });
}

// ── File uploads (Cloudflare R2) ───────────────────────────────────────────────────

/** Signed URLs live this long. An upload of a 4 GB file on a slow line needs the time. */
const UPLOAD_URL_TTL_SEC = 60 * 60;
const DOWNLOAD_URL_TTL_SEC = 15 * 60;

function requireR2() {
  const cfg = r2Config();
  if (!cfg) throw new PipelineError(503, "UPLOADS_OFF", "File uploads aren't switched on — paste a link to the file instead");
  return cfg;
}

function fileNameOf(name: string | undefined): string {
  const n = (name ?? "").replace(/[\u0000-\u001f\u007f/\\]/g, "").trim().slice(0, W.PIPELINE_WORK_LIMITS.fileNameMax);
  return n || "file";
}

/**
 * A signed PUT for one new object under the project's prefix. The browser sends the file
 * straight to R2; the content type is part of the signature, so the stored type is the one
 * the rules allowed. Size is checked again when the version is added (a PUT URL can't cap it).
 */
export async function startUpload(actor: WorkActor, projectId: string, input: W.StartUploadInput): Promise<W.PipelineUploadTicket> {
  const cfg = requireR2();
  await guarded(() => pipelineWrite(async (tx) => assertWritable(await lockProject(tx, projectId, actor.userId))));
  const key = `pipeline/${projectId}/${randomBytes(24).toString("base64url")}`;
  const now = new Date();
  return {
    key,
    url: presignR2(cfg, "PUT", key, UPLOAD_URL_TTL_SEC, { headers: { "content-type": input.contentType }, now }),
    method: "PUT",
    headers: { "Content-Type": input.contentType },
    expiresAt: new Date(now.getTime() + UPLOAD_URL_TTL_SEC * 1000).toISOString(),
  };
}

async function verifyUploadedFile(projectId: string, kind: string, key: string): Promise<{ size: number; contentType: string }> {
  const cfg = requireR2();
  if (!key.startsWith(`pipeline/${projectId}/`)) throw new PipelineError(400, "UPLOAD_NOT_FOUND", "That upload doesn't belong to this project");
  const rule = W.uploadRuleFor(kind);
  if (!rule) throw new PipelineError(400, "VALIDATION_ERROR", "A caption is text, not a file");
  let obj;
  try {
    obj = await headR2Object(cfg, key);
  } catch {
    throw new PipelineError(503, "STORAGE_UNAVAILABLE", "Couldn't reach file storage — try again in a moment");
  }
  if (!obj) throw new PipelineError(400, "UPLOAD_NOT_FOUND", "The upload didn't finish — upload the file again");
  if (!rule.types.includes(obj.contentType)) {
    throw new PipelineError(400, "UPLOAD_WRONG_TYPE", "This type of file can't be used here");
  }
  if (obj.size <= 0 || obj.size > rule.maxBytes) {
    throw new PipelineError(400, "UPLOAD_TOO_LARGE", `The file is too big (the most is ${W.formatBytes(rule.maxBytes)})`);
  }
  return obj;
}

/** A short-lived link to a version's uploaded file: to play it inline, or to download it. */
export async function versionFileUrl(versionId: string, download: boolean): Promise<{ url: string; expiresAt: string }> {
  const cfg = requireR2();
  const v = await guarded(() =>
    pipelineRead(async (db) => {
      const row = await db.pipelineVersion.findUnique({
        where: { id: versionId },
        select: { projectId: true, fileKey: true, fileName: true, fileType: true },
      });
      if (!row) throw new PipelineError(404, "VERSION_NOT_FOUND", "This version doesn't exist");
      await assertProjectReadable(db, row.projectId);
      return row;
    }),
  );
  if (!v.fileKey) throw new PipelineError(404, "NO_FILE", "This version is a link, not an uploaded file");
  const name = v.fileName || "file";
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const disposition = `${download ? "attachment" : "inline"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
  const now = new Date();
  const query: Record<string, string> = { "response-content-disposition": disposition };
  if (v.fileType) query["response-content-type"] = v.fileType;
  return {
    url: presignR2(cfg, "GET", v.fileKey, DOWNLOAD_URL_TTL_SEC, { query, now }),
    expiresAt: new Date(now.getTime() + DOWNLOAD_URL_TTL_SEC * 1000).toISOString(),
  };
}

/** Locks the project of a version, then re-reads the version under that lock. */
async function lockVersion(tx: PipelineTx, actor: WorkActor, versionId: string) {
  const pre = await tx.pipelineVersion.findUnique({ where: { id: versionId }, select: { projectId: true } });
  if (!pre) throw new PipelineError(404, "VERSION_NOT_FOUND", "This version doesn't exist");
  assertWritable(await lockProject(tx, pre.projectId, actor.userId));
  const v = await tx.pipelineVersion.findUnique({ where: { id: versionId }, select: VERSION_SELECT });
  if (!v) throw new PipelineError(404, "VERSION_NOT_FOUND", "This version doesn't exist");
  return { ...v, projectId: pre.projectId };
}

/** Source, rights, licence and embargo can be filled in later. They don't change the file, so an approval stands. */
export async function editVersionUsage(
  actor: WorkActor,
  versionId: string,
  input: W.EditVersionUsageInput,
): Promise<W.PipelineVersionDto> {
  return guarded(async () => {
    const row = await pipelineWrite(async (tx) => {
      await lockVersion(tx, actor, versionId);
      const data: Record<string, unknown> = {};
      if (input.source !== undefined) data.source = input.source;
      if (input.rights !== undefined) data.rights = input.rights;
      if (input.licenceExpires !== undefined) {
        data.licenceExpires = input.licenceExpires ? new Date(`${input.licenceExpires}T00:00:00Z`) : null;
      }
      if (input.embargoUntil !== undefined) data.embargoUntil = input.embargoUntil ? new Date(input.embargoUntil) : null;
      if (input.usageNotes !== undefined) data.usageNotes = input.usageNotes;
      return tx.pipelineVersion.update({ where: { id: versionId }, data, select: VERSION_SELECT });
    });
    return versionDto(actor.directory, row);
  });
}

// ── Version comments ───────────────────────────────────────────────────────────────

export async function addComment(actor: WorkActor, versionId: string, input: W.AddCommentInput): Promise<W.PipelineCommentDto> {
  return guarded(async () => {
    const row = await pipelineWrite(async (tx) => {
      const v = await lockVersion(tx, actor, versionId);
      const count = await tx.pipelineVersionComment.count({ where: { versionId } });
      if (count >= W.PIPELINE_WORK_LIMITS.commentsPerVersion) {
        throw new PipelineError(409, "TOO_MANY_COMMENTS", "This version has the most comments it can hold");
      }
      return tx.pipelineVersionComment.create({
        data: {
          projectId: v.projectId,
          versionId,
          authorId: actor.userId,
          atSeconds: input.atSeconds ?? null,
          body: input.body,
        },
        select: COMMENT_SELECT,
      });
    });
    return commentDto(actor.directory, row);
  });
}

export async function resolveComment(actor: WorkActor, commentId: string, resolved: boolean): Promise<W.PipelineCommentDto> {
  return guarded(async () => {
    const row = await pipelineWrite(async (tx) => {
      const pre = await tx.pipelineVersionComment.findUnique({ where: { id: commentId }, select: { projectId: true } });
      if (!pre) throw new PipelineError(404, "COMMENT_NOT_FOUND", "This comment doesn't exist");
      assertWritable(await lockProject(tx, pre.projectId, actor.userId));
      return tx.pipelineVersionComment.update({
        where: { id: commentId },
        data: resolved ? { resolvedAt: new Date(), resolvedById: actor.userId } : { resolvedAt: null, resolvedById: null },
        select: COMMENT_SELECT,
      });
    });
    return commentDto(actor.directory, row);
  });
}

// ── Reviews ────────────────────────────────────────────────────────────────────────

export async function requestReview(actor: WorkActor, projectId: string, input: W.RequestReviewInput): Promise<W.PipelineReviewDto> {
  if (input.reviewerId === actor.userId) {
    throw new PipelineError(400, "SELF_REVIEW", "Ask someone else to review your work");
  }
  assertPickable(actor, input.reviewerId, "reviewer");
  return guarded(async () => {
    const { review, versions } = await pipelineWrite(async (tx) => {
      assertWritable(await lockProject(tx, projectId, actor.userId));
      const versions = await tx.pipelineVersion.findMany({
        where: { projectId },
        select: { id: true, kind: true, number: true },
        take: W.PIPELINE_WORK_LIMITS.versionsPerProject,
      });
      if (versions.length === 0) {
        throw new PipelineError(409, "NO_VERSIONS", "Add a version (video, caption or thumbnail) before asking for a review");
      }
      // One open request per project: a new one replaces any that is still pending.
      await tx.pipelineReview.updateMany({ where: { projectId, status: "pending" }, data: { status: "superseded" } });
      const review = await tx.pipelineReview.create({
        data: {
          projectId,
          requestedById: actor.userId,
          reviewerId: input.reviewerId,
          versionIds: W.latestVersionIds(versions),
        },
        select: REVIEW_SELECT,
      });
      return { review, versions };
    });
    const what = versionNames(versions, review.versionIds);
    await postLine(
      actor,
      projectId,
      `@{${input.reviewerId}} please review: ${what}.${input.message ? `\n${input.message}` : ""}`,
    );
    return reviewDto(actor.directory, review, review.versionIds);
  });
}

export async function decideReview(actor: WorkActor, reviewId: string, input: W.DecideReviewInput): Promise<W.PipelineReviewDto> {
  return guarded(async () => {
    const found = await pipelineRead((db) =>
      db.pipelineReview.findUnique({ where: { id: reviewId }, select: { projectId: true } }),
    );
    if (!found) throw new PipelineError(404, "REVIEW_NOT_FOUND", "This review doesn't exist");
    const projectId = found.projectId;
    const { review, versions } = await pipelineWrite(async (tx) => {
      assertWritable(await lockProject(tx, projectId, actor.userId));
      const r = await tx.pipelineReview.findUnique({ where: { id: reviewId }, select: REVIEW_SELECT });
      if (!r) throw new PipelineError(404, "REVIEW_NOT_FOUND", "This review doesn't exist");
      if (r.reviewerId !== actor.userId) {
        throw new PipelineError(403, "NOT_REVIEWER", "Only the person asked to review can decide");
      }
      if (r.status !== "pending") {
        throw new PipelineError(409, "REVIEW_CLOSED", "This review has already been decided or replaced");
      }
      const versions = await tx.pipelineVersion.findMany({
        where: { projectId },
        select: { id: true, kind: true, number: true },
        take: W.PIPELINE_WORK_LIMITS.versionsPerProject,
      });
      if (W.isReviewOutdated(r, W.latestVersionIds(versions))) {
        throw new PipelineError(409, "REVIEW_OUTDATED", "A newer version was added after this review was requested — ask for a new review");
      }
      const review = await tx.pipelineReview.update({
        where: { id: reviewId },
        data: { status: input.decision, note: input.note ?? "", decidedAt: new Date() },
        select: REVIEW_SELECT,
      });
      return { review, versions };
    });
    const what = versionNames(versions, review.versionIds);
    const body =
      input.decision === "approved"
        ? `@{${review.requestedById}} Approved: ${what}.${input.note ? `\n${input.note}` : ""}`
        : `@{${review.requestedById}} Changes requested on ${what}:\n${input.note ?? ""}`;
    if (review.requestedById !== actor.userId) await postLine(actor, projectId, body);
    return reviewDto(actor.directory, review, W.latestVersionIds(versions));
  });
}

// ── Deliverables ───────────────────────────────────────────────────────────────────

export async function createDeliverable(
  actor: WorkActor,
  projectId: string,
  input: W.CreateDeliverableInput,
): Promise<W.PipelineDeliverableDto> {
  if (input.assigneeId) assertPickable(actor, input.assigneeId, "person");
  return guarded(async () => {
    const row = await pipelineWrite(async (tx) => {
      assertWritable(await lockProject(tx, projectId, actor.userId));
      const count = await tx.pipelineDeliverable.count({ where: { projectId } });
      if (count >= W.PIPELINE_WORK_LIMITS.deliverablesPerProject) {
        throw new PipelineError(409, "TOO_MANY_DELIVERABLES", "This project has the most pages it can hold");
      }
      return tx.pipelineDeliverable.create({
        data: {
          projectId,
          platform: input.platform,
          destination: input.destination,
          caption: input.caption ?? "",
          scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
          assigneeId: input.assigneeId ?? null,
          note: input.note ?? "",
          createdById: actor.userId,
        },
      });
    });
    return deliverableDto(actor.directory, row);
  });
}

async function lockDeliverable(tx: PipelineTx, actor: WorkActor, deliverableId: string) {
  // Find the project first (no lock), then lock it, then re-read the row under that lock.
  const pre = await tx.pipelineDeliverable.findUnique({ where: { id: deliverableId }, select: { projectId: true } });
  if (!pre) throw new PipelineError(404, "DELIVERABLE_NOT_FOUND", "This page record doesn't exist");
  assertWritable(await lockProject(tx, pre.projectId, actor.userId));
  const row = await tx.pipelineDeliverable.findUnique({ where: { id: deliverableId } });
  if (!row) throw new PipelineError(404, "DELIVERABLE_NOT_FOUND", "This page record doesn't exist");
  return row;
}

export async function editDeliverable(
  actor: WorkActor,
  deliverableId: string,
  input: W.EditDeliverableInput,
): Promise<W.PipelineDeliverableDto> {
  const c = input.changes;
  if (c.assigneeId) assertPickable(actor, c.assigneeId, "person");
  return guarded(async () => {
    const { row, wentLive } = await pipelineWrite(async (tx) => {
      const cur = await lockDeliverable(tx, actor, deliverableId);
      if (cur.rev !== input.base) {
        throw new PipelineError(409, "DELIVERABLE_CONFLICT", "Someone else changed this page — showing their version", {
          current: deliverableDto(actor.directory, cur),
        });
      }
      const status = (c.status ?? cur.status) as W.PipelineDeliverableStatus;
      const liveUrl = c.liveUrl !== undefined ? c.liveUrl : cur.liveUrl;
      const scheduledAt = c.scheduledAt !== undefined ? (c.scheduledAt ? new Date(c.scheduledAt) : null) : cur.scheduledAt;
      const statusChanged = c.status !== undefined && c.status !== cur.status;

      if (status === "published" && !liveUrl) {
        throw new PipelineError(400, "LIVE_URL_REQUIRED", "Add the live link to mark it published");
      }
      if (status === "scheduled" && !scheduledAt) {
        throw new PipelineError(400, "SCHEDULE_REQUIRED", "Set the date and time it will go live");
      }

      const data: Record<string, unknown> = { rev: { increment: 1 } };
      if (c.platform !== undefined) data.platform = c.platform;
      if (c.destination !== undefined) data.destination = c.destination;
      if (c.caption !== undefined) data.caption = c.caption;
      if (c.scheduledAt !== undefined) data.scheduledAt = scheduledAt;
      if (c.assigneeId !== undefined) data.assigneeId = c.assigneeId;
      if (c.note !== undefined) data.note = c.note;
      if (c.liveUrl !== undefined) data.liveUrl = liveUrl;

      // Embargo and licence: checked whenever a page is (or stays) set to go live at a time —
      // a status change into scheduled/published, or a new time on a scheduled page.
      const goingLive = W.PIPELINE_STATUSES_NEEDING_APPROVAL.includes(status);
      if (goingLive && (statusChanged || (status === "scheduled" && c.scheduledAt !== undefined))) {
        const goLive = status === "published" ? Date.now() : scheduledAt!.getTime();
        const all = await tx.pipelineVersion.findMany({
          where: { projectId: cur.projectId },
          select: { id: true, kind: true, number: true, embargoUntil: true, licenceExpires: true },
          take: W.PIPELINE_WORK_LIMITS.versionsPerProject,
        });
        const latest = new Set(W.latestVersionIds(all));
        const reason = W.usageBlock(all.filter((v) => latest.has(v.id)), goLive, dateToIST(new Date(goLive)));
        if (reason) throw new PipelineError(409, "USAGE_RESTRICTED", reason);
      }

      if (statusChanged) {
        data.status = status;
        if (W.PIPELINE_STATUSES_NEEDING_APPROVAL.includes(status)) {
          const { hasVersions, approvedReviewId } = await currentApproval(tx, cur.projectId);
          if (hasVersions && !approvedReviewId) {
            throw new PipelineError(409, "APPROVAL_REQUIRED", "The newest versions aren't approved yet — get them approved first");
          }
          data.approvedReviewId = approvedReviewId;
        }
        if (status === "published") {
          data.publishedAt = new Date();
          data.publishedById = actor.userId;
        } else if (cur.status === "published") {
          data.publishedAt = null;
          data.publishedById = null;
        }
      }
      const row = await tx.pipelineDeliverable.update({ where: { id: deliverableId }, data });
      return { row, wentLive: statusChanged && status === "published" };
    });
    if (wentLive) {
      const label = W.PIPELINE_PLATFORM_LABEL[row.platform as W.PipelineDeliverablePlatform] ?? row.platform;
      await postLine(actor, row.projectId, `Published on ${label} · ${row.destination}: ${row.liveUrl}`);
    }
    return deliverableDto(actor.directory, row);
  });
}

export async function deleteDeliverable(actor: WorkActor, deliverableId: string): Promise<{ id: string }> {
  return guarded(async () => {
    await pipelineWrite(async (tx) => {
      const cur = await lockDeliverable(tx, actor, deliverableId);
      if (cur.status === "published") {
        throw new PipelineError(409, "DELIVERABLE_PUBLISHED", "A published page is kept as a record — mark it cancelled instead");
      }
      await tx.pipelineDeliverable.delete({ where: { id: deliverableId } });
    });
    return { id: deliverableId };
  });
}

// ── My Work ────────────────────────────────────────────────────────────────────────

const LIVE_PROJECT = { deletedAt: null, archivedAt: null } as const;

export async function getMyWork(
  userId: string,
  dir: PipelineDirectory,
  _settings: PipelineSettings,
): Promise<W.PipelineMyWorkDto> {
  const max = W.PIPELINE_WORK_LIMITS.myWorkListMax;
  return guarded(async () => {
    const r = await pipelineRead(async (db) => {
      const pending = await db.pipelineReview.findMany({
        where: { reviewerId: userId, status: "pending", project: LIVE_PROJECT },
        select: { ...REVIEW_SELECT, project: { select: { id: true, title: true } } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: max,
      });
      const changes = await db.pipelineReview.findMany({
        where: { requestedById: userId, status: "changes_requested", project: LIVE_PROJECT },
        select: { ...REVIEW_SELECT, project: { select: { id: true, title: true } } },
        orderBy: [{ decidedAt: "desc" }, { id: "desc" }],
        take: max,
      });
      const projectIds = [...new Set([...pending, ...changes].map((x) => x.projectId))];
      const versions = projectIds.length
        ? await db.pipelineVersion.findMany({
            where: { projectId: { in: projectIds } },
            select: { id: true, kind: true, number: true, projectId: true },
          })
        : [];
      // The newest non-superseded review per project, so a changes-requested review drops out
      // of the list once a new review has been asked for.
      const newest = projectIds.length
        ? await db.pipelineReview.findMany({
            where: { projectId: { in: projectIds }, status: { not: "superseded" } },
            select: { id: true, projectId: true },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            distinct: ["projectId"],
          })
        : [];
      const deliverables = await db.pipelineDeliverable.findMany({
        where: { assigneeId: userId, status: { notIn: [...W.PIPELINE_DELIVERABLE_DONE] }, project: LIVE_PROJECT },
        include: { project: { select: { id: true, title: true } } },
        orderBy: [{ scheduledAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
        take: max,
      });
      const due = await db.pipelineProject.findMany({
        where: { ownerId: userId, ...LIVE_PROJECT, dueDate: { not: null }, phase: { isTerminal: false } },
        select: { id: true, title: true, dueDate: true, phase: { select: { name: true } } },
        orderBy: [{ dueDate: "asc" }, { id: "asc" }],
        take: max,
      });
      const now = await db.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`;
      // Open shoots from 12 h ago on: a shoot that started this morning is still today's work.
      const shoots = await db.pipelineShoot.findMany({
        where: {
          cameraId: userId,
          status: { in: [...W.PIPELINE_SHOOT_OPEN] },
          callTime: { gte: new Date(now[0].now.getTime() - 12 * 3600_000) },
        },
        include: { project: { select: { id: true, title: true, deletedAt: true } } },
        orderBy: [{ callTime: "asc" }, { id: "asc" }],
        take: max,
      });
      return { pending, changes, versions, newest, deliverables, due, shoots, now: now[0].now };
    });

    const latestBy = new Map<string, string[]>();
    for (const pid of new Set(r.versions.map((v) => v.projectId))) {
      latestBy.set(pid, W.latestVersionIds(r.versions.filter((v) => v.projectId === pid)));
    }
    const newestIds = new Set(r.newest.map((n) => n.id));
    const withProject = <T extends ReviewRow & { project: { id: string; title: string } }>(x: T) => ({
      review: reviewDto(dir, x, latestBy.get(x.projectId) ?? []),
      project: { id: x.project.id, title: x.project.title },
    });

    return {
      reviewsToDo: r.pending.map(withProject).filter((x) => !x.review.outdated),
      changesRequested: r.changes.filter((x) => newestIds.has(x.id)).map(withProject),
      deliverables: r.deliverables.map((d) => ({
        deliverable: deliverableDto(dir, d),
        project: { id: d.project.id, title: d.project.title },
      })),
      shoots: r.shoots.map((sh) => shootDto(dir, sh)),
      dueProjects: r.due.map((p) => ({
        id: p.id,
        title: p.title,
        phaseName: p.phase.name,
        dueDate: p.dueDate!.toISOString().slice(0, 10),
      })),
      now: r.now.toISOString(),
    };
  });
}

// ── Shoots (shared mapping; the service is shoots.service.ts) ─────────────────────

export interface ShootRow {
  id: string;
  projectId: string | null;
  title: string;
  event: string;
  location: string;
  callTime: Date;
  cameraId: string | null;
  contact: string;
  requirements: string;
  deadline: Date | null;
  embargoUntil: Date | null;
  status: string;
  uploadUrl: string | null;
  rev: number;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
  project: { id: string; title: string; deletedAt: Date | null } | null;
}

export function shootDto(dir: PipelineDirectory, sh: ShootRow): W.PipelineShootDto {
  return {
    id: sh.id,
    project: sh.project && !sh.project.deletedAt ? { id: sh.project.id, title: sh.project.title } : null,
    title: sh.title,
    event: sh.event,
    location: sh.location,
    callTime: sh.callTime.toISOString(),
    camera: personOrNull(dir, sh.cameraId),
    contact: sh.contact,
    requirements: sh.requirements,
    deadline: iso(sh.deadline),
    embargoUntil: iso(sh.embargoUntil),
    status: sh.status as W.PipelineShootStatus,
    uploadUrl: sh.uploadUrl,
    rev: sh.rev,
    createdBy: person(dir, sh.createdById),
    createdAt: sh.createdAt.toISOString(),
    updatedAt: sh.updatedAt.toISOString(),
  };
}

export { assertPickable, guarded };
