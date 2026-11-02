/**
 * Pipeline work tracking (2026-11-02): versions, version-bound reviews and one publishing
 * record per destination page. Shared by the API (validation, approval logic) and the
 * portals (forms, labels), so they never disagree.
 *
 *   version      video v1, v2…, caption v1…, thumbnail v1… — a LINK to the file (NAS, Drive…),
 *                never an upload: the production disk is small (see CLAUDE.md, 2026-10-25).
 *   review       a request to one reviewer, pinned to the newest version of every kind that
 *                existed when it was made. A newer version of any kind makes it OUTDATED — an
 *                approval never silently carries over to a file the reviewer did not see.
 *   deliverable  one destination (page / account) with its own caption, schedule, status and
 *                live link. A post going live on one page never completes another.
 *
 * ⚠️ No regex lookbehind (this file ships in the HR bundle). Free text is length-bounded
 * BEFORE any transform (see validators/pipeline.ts for why).
 */
import { z } from "zod";
import { cleanLine, normalizeText } from "./text";

// ── Values ─────────────────────────────────────────────────────────────────────────

export const PIPELINE_VERSION_KINDS = ["video", "caption", "thumbnail", "other"] as const;
export type PipelineVersionKind = (typeof PIPELINE_VERSION_KINDS)[number];

export const PIPELINE_VERSION_KIND_LABEL: Record<PipelineVersionKind, string> = {
  video: "Video",
  caption: "Caption",
  thumbnail: "Thumbnail",
  other: "File",
};

export const PIPELINE_REVIEW_STATUSES = ["pending", "approved", "changes_requested", "superseded"] as const;
export type PipelineReviewStatus = (typeof PIPELINE_REVIEW_STATUSES)[number];

export const PIPELINE_DELIVERABLE_PLATFORMS = ["instagram", "facebook", "youtube", "snapchat", "x", "other"] as const;
export type PipelineDeliverablePlatform = (typeof PIPELINE_DELIVERABLE_PLATFORMS)[number];

export const PIPELINE_PLATFORM_LABEL: Record<PipelineDeliverablePlatform, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  youtube: "YouTube",
  snapchat: "Snapchat",
  x: "X",
  other: "Other",
};

export const PIPELINE_DELIVERABLE_STATUSES = [
  "draft",
  "ready",
  "scheduled",
  "published",
  "failed",
  "needs_verification",
  "cancelled",
] as const;
export type PipelineDeliverableStatus = (typeof PIPELINE_DELIVERABLE_STATUSES)[number];

export const PIPELINE_DELIVERABLE_STATUS_LABEL: Record<PipelineDeliverableStatus, string> = {
  draft: "Draft",
  ready: "Ready",
  scheduled: "Scheduled",
  published: "Published",
  failed: "Failed",
  needs_verification: "Needs verification",
  cancelled: "Cancelled",
};

/** Statuses that need a CURRENT approval when the project has any version. */
export const PIPELINE_STATUSES_NEEDING_APPROVAL: readonly PipelineDeliverableStatus[] = ["scheduled", "published"];
/** Statuses that are finished: they leave "My Work". */
export const PIPELINE_DELIVERABLE_DONE: readonly PipelineDeliverableStatus[] = ["published", "cancelled"];

export const PIPELINE_WORK_LIMITS = {
  labelMax: 120,
  urlMax: 2048,
  bodyMax: 5000,
  noteMax: 500,
  reviewNoteMax: 2000,
  destinationMax: 120,
  /** Per project: enough for a long campaign, small enough to load in one read. */
  versionsPerProject: 300,
  deliverablesPerProject: 100,
  reviewsShown: 50,
  /** Each "My Work" list. */
  myWorkListMax: 50,
} as const;

// ── Validators ─────────────────────────────────────────────────────────────────────

const workId = z
  .string()
  .max(36)
  .uuid()
  .transform((s) => s.toLowerCase());

/** One line of text, bounded before cleaning. */
const line = (max: number) =>
  z
    .string()
    .max(max * 2)
    .transform((s) => cleanLine(s).trim())
    .pipe(z.string().max(max));

const text = (max: number) =>
  z
    .string()
    .max(max)
    .transform((s) => normalizeText(s).trim());

/** http(s) only: a `javascript:` link rendered as an <a href> would run in the portal. */
const HTTP_URL = /^https?:\/\/[^\s<>"]+$/i;
export const pipelineWorkUrl = z
  .string()
  .max(PIPELINE_WORK_LIMITS.urlMax)
  .transform((s) => s.trim())
  .pipe(z.string().regex(HTTP_URL, "Use a full link starting with https://"));

export const addVersionSchema = z
  .object({
    kind: z.enum(PIPELINE_VERSION_KINDS),
    label: line(PIPELINE_WORK_LIMITS.labelMax).optional(),
    url: pipelineWorkUrl.nullable().optional(),
    body: text(PIPELINE_WORK_LIMITS.bodyMax).optional(),
    note: line(PIPELINE_WORK_LIMITS.noteMax).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "caption") {
      if (!v.body && !v.url) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["body"], message: "Write the caption or add a link to it" });
    } else if (!v.url) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["url"], message: "Add a link to the file" });
    }
  });
export type AddVersionInput = z.infer<typeof addVersionSchema>;

export const requestReviewSchema = z.object({
  reviewerId: workId,
  message: line(PIPELINE_WORK_LIMITS.noteMax).optional(),
});
export type RequestReviewInput = z.infer<typeof requestReviewSchema>;

export const decideReviewSchema = z
  .object({
    decision: z.enum(["approved", "changes_requested"]),
    note: text(PIPELINE_WORK_LIMITS.reviewNoteMax).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.decision === "changes_requested" && !v.note) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["note"], message: "Say what needs to change" });
    }
  });
export type DecideReviewInput = z.infer<typeof decideReviewSchema>;

/** An ISO date-time with an offset ("2026-11-03T18:30:00.000Z"); null clears it. */
const isoDateTime = z.string().max(40).datetime({ offset: true });

const deliverableFields = {
  platform: z.enum(PIPELINE_DELIVERABLE_PLATFORMS),
  destination: line(PIPELINE_WORK_LIMITS.destinationMax).pipe(z.string().min(1, "Name the page or account")),
  caption: text(PIPELINE_WORK_LIMITS.bodyMax),
  scheduledAt: isoDateTime.nullable(),
  assigneeId: workId.nullable(),
  note: line(PIPELINE_WORK_LIMITS.noteMax),
};

export const createDeliverableSchema = z.object({
  platform: deliverableFields.platform,
  destination: deliverableFields.destination,
  caption: deliverableFields.caption.optional(),
  scheduledAt: deliverableFields.scheduledAt.optional(),
  assigneeId: deliverableFields.assigneeId.optional(),
  note: deliverableFields.note.optional(),
});
export type CreateDeliverableInput = z.infer<typeof createDeliverableSchema>;

export const editDeliverableSchema = z.object({
  /** The `rev` the editor read; a different current rev answers 409 with the current row. */
  base: z.number().int().min(1).max(2_147_483_647),
  changes: z
    .object({
      platform: deliverableFields.platform.optional(),
      destination: deliverableFields.destination.optional(),
      caption: deliverableFields.caption.optional(),
      scheduledAt: deliverableFields.scheduledAt.optional(),
      assigneeId: deliverableFields.assigneeId.optional(),
      note: deliverableFields.note.optional(),
      status: z.enum(PIPELINE_DELIVERABLE_STATUSES).optional(),
      liveUrl: pipelineWorkUrl.nullable().optional(),
    })
    .refine((c) => Object.keys(c).length > 0, "Nothing to change"),
});
export type EditDeliverableInput = z.infer<typeof editDeliverableSchema>;

export const reviewParamsSchema = z.object({ rid: workId });
export const deliverableParamsSchema = z.object({ did: workId });

// ── Wire types ─────────────────────────────────────────────────────────────────────

export interface PipelineWorkPerson {
  id: string;
  name: string;
}

export interface PipelineVersionDto {
  id: string;
  kind: PipelineVersionKind;
  number: number;
  label: string;
  url: string | null;
  body: string;
  note: string;
  createdBy: PipelineWorkPerson;
  createdAt: string;
}

export interface PipelineReviewDto {
  id: string;
  requestedBy: PipelineWorkPerson;
  reviewer: PipelineWorkPerson;
  versionIds: string[];
  status: PipelineReviewStatus;
  /** A newer version exists for something this review covered (or for a kind it did not). */
  outdated: boolean;
  note: string;
  decidedAt: string | null;
  createdAt: string;
}

export interface PipelineDeliverableDto {
  id: string;
  platform: PipelineDeliverablePlatform;
  destination: string;
  caption: string;
  scheduledAt: string | null;
  status: PipelineDeliverableStatus;
  assignee: PipelineWorkPerson | null;
  liveUrl: string | null;
  publishedAt: string | null;
  publishedBy: PipelineWorkPerson | null;
  approvedReviewId: string | null;
  note: string;
  rev: number;
  createdBy: PipelineWorkPerson;
  createdAt: string;
  updatedAt: string;
}

export type PipelineApprovalState = "none" | "in_review" | "changes_requested" | "approved" | "outdated";

export interface PipelineApprovalSummary {
  state: PipelineApprovalState;
  /** The approval in force (approved AND not outdated), else null. */
  approvedReviewId: string | null;
  /** The review the state was read from, else null. */
  reviewId: string | null;
}

export interface PipelineWorkDto {
  versions: PipelineVersionDto[];
  reviews: PipelineReviewDto[];
  deliverables: PipelineDeliverableDto[];
  approval: PipelineApprovalSummary;
}

export interface PipelineMyWorkProject {
  id: string;
  title: string;
}

export interface PipelineMyWorkDto {
  /** Reviews waiting for my decision (not outdated). */
  reviewsToDo: Array<{ review: PipelineReviewDto; project: PipelineMyWorkProject }>;
  /** My review requests that came back with changes, newest first. */
  changesRequested: Array<{ review: PipelineReviewDto; project: PipelineMyWorkProject }>;
  /** Pages assigned to me that are not published or cancelled, soonest first. */
  deliverables: Array<{ deliverable: PipelineDeliverableDto; project: PipelineMyWorkProject }>;
  /** Projects I own that are in a live phase, with a due date, soonest first. */
  dueProjects: Array<PipelineMyWorkProject & { phaseName: string; dueDate: string }>;
  /** Server time, so "overdue" is judged against the same clock. */
  now: string;
}

// ── Approval logic (pure) ──────────────────────────────────────────────────────────

export interface VersionRef {
  id: string;
  kind: string;
  number: number;
}

export interface ReviewRef {
  id: string;
  status: string;
  versionIds: readonly string[];
  createdAt: string | Date;
}

/** The newest version of each kind, by number. */
export function latestVersionIds(versions: readonly VersionRef[]): string[] {
  const best = new Map<string, VersionRef>();
  for (const v of versions) {
    const cur = best.get(v.kind);
    if (!cur || v.number > cur.number) best.set(v.kind, v);
  }
  return [...best.values()].map((v) => v.id).sort();
}

/**
 * A review is outdated when the newest version of some kind is not among the versions it was
 * pinned to — a new video, caption or thumbnail, or a first file of a kind it did not cover.
 */
export function isReviewOutdated(review: Pick<ReviewRef, "versionIds">, latestIds: readonly string[]): boolean {
  const pinned = new Set(review.versionIds);
  return latestIds.some((id) => !pinned.has(id));
}

const time = (d: string | Date) => (typeof d === "string" ? Date.parse(d) : d.getTime());

/**
 * The project's approval state, read from its newest review that is not superseded.
 * `approvedReviewId` is set only when that review is approved AND still covers the newest
 * version of every kind — the one approval a page may be scheduled or published under.
 */
export function approvalSummary(versions: readonly VersionRef[], reviews: readonly ReviewRef[]): PipelineApprovalSummary {
  const latest = latestVersionIds(versions);
  const live = reviews
    .filter((r) => r.status !== "superseded")
    .sort((a, b) => time(b.createdAt) - time(a.createdAt) || (a.id < b.id ? 1 : -1));
  const head = live[0];
  if (!head) return { state: "none", approvedReviewId: null, reviewId: null };
  const outdated = isReviewOutdated(head, latest);
  if (head.status === "changes_requested") return { state: "changes_requested", approvedReviewId: null, reviewId: head.id };
  if (outdated) return { state: "outdated", approvedReviewId: null, reviewId: head.id };
  if (head.status === "approved") return { state: "approved", approvedReviewId: head.id, reviewId: head.id };
  return { state: "in_review", approvedReviewId: null, reviewId: head.id };
}

export const PIPELINE_APPROVAL_LABEL: Record<PipelineApprovalState, string> = {
  none: "Not sent for review",
  in_review: "In review",
  changes_requested: "Changes requested",
  approved: "Approved",
  outdated: "New version since the last review",
};
