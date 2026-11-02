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
import { randomUUID } from "crypto";
import { pipelineWork as W } from "@dashmani/shared";
import { pipelineRead, pipelineWrite } from "./tx";
import { PipelineError } from "./errors";
import { lockProject, assertWritable, pickableByMode, type PipelineActor } from "./projects.service";
import { postMessage } from "./messages.service";
import type { PipelineDirectory } from "./access";
import type { PipelineSettings } from "./settings";
import type { PipelineDbClient, PipelineTx } from "./db";


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
    if (/42P01|42703|relation "pipeline_(versions|reviews|deliverables)" does not exist/.test(msg)) return true;
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
  body: string;
  note: string;
  createdById: string;
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

function versionDto(dir: PipelineDirectory, v: VersionRow): W.PipelineVersionDto {
  return {
    id: v.id,
    kind: v.kind as W.PipelineVersionKind,
    number: v.number,
    label: v.label,
    url: v.url,
    body: v.body,
    note: v.note,
    createdBy: person(dir, v.createdById),
    createdAt: v.createdAt.toISOString(),
  };
}

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
    const { versions, reviews, deliverables } = await pipelineRead(async (db) => {
      await assertProjectReadable(db, projectId);
      const versions = await readVersions(db, projectId);
      const reviews = await readReviews(db, projectId);
      const deliverables = await db.pipelineDeliverable.findMany({
        where: { projectId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: W.PIPELINE_WORK_LIMITS.deliverablesPerProject,
      });
      return { versions, reviews, deliverables };
    });
    const latest = W.latestVersionIds(versions);
    return {
      versions: versions.map((v) => versionDto(dir, v)),
      reviews: reviews.map((r) => reviewDto(dir, r, latest)),
      deliverables: deliverables.map((d) => deliverableDto(dir, d)),
      approval: W.approvalSummary(versions, reviews),
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
  return guarded(async () => {
    const row = await pipelineWrite(async (tx) => {
      assertWritable(await lockProject(tx, projectId, actor.userId));
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
          body: input.body ?? "",
          note: input.note ?? "",
          createdById: actor.userId,
        },
        select: VERSION_SELECT,
      });
    });
    return versionDto(actor.directory, row);
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
      return { pending, changes, versions, newest, deliverables, due, now: now[0].now };
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
