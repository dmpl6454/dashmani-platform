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
  sourceMax: 200,
  usageNotesMax: 1000,
  commentMax: 2000,
  commentsPerVersion: 200,
  /** 24 h in seconds: a point in a video beyond this is a typo. */
  atSecondsMax: 86_400,
  shootTitleMax: 120,
  shootFieldMax: 200,
  shootRequirementsMax: 2000,
  shootsListMax: 200,
} as const;

export const PIPELINE_RIGHTS = ["owned", "licensed", "permission", "unknown"] as const;
export type PipelineRights = (typeof PIPELINE_RIGHTS)[number];
export const PIPELINE_RIGHTS_LABEL: Record<PipelineRights, string> = {
  owned: "Our own",
  licensed: "Licensed",
  permission: "With permission",
  unknown: "Rights unknown",
};

export const PIPELINE_SHOOT_STATUSES = ["assigned", "on_site", "uploaded", "done", "cancelled"] as const;
export type PipelineShootStatus = (typeof PIPELINE_SHOOT_STATUSES)[number];
export const PIPELINE_SHOOT_STATUS_LABEL: Record<PipelineShootStatus, string> = {
  assigned: "Assigned",
  on_site: "On site",
  uploaded: "Footage uploaded",
  done: "Done",
  cancelled: "Cancelled",
};
/** Shoot statuses that still need the camera person. */
export const PIPELINE_SHOOT_OPEN: readonly PipelineShootStatus[] = ["assigned", "on_site"];

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

/** A calendar day, YYYY-MM-DD. */
const dayKey = z
  .string()
  .max(10)
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, "Not a real calendar day");

/** Usage and licence facts about a file. Every field optional; null clears. */
const usageFields = {
  source: line(PIPELINE_WORK_LIMITS.sourceMax).optional(),
  rights: z.enum(["", ...PIPELINE_RIGHTS]).optional(),
  licenceExpires: dayKey.nullable().optional(),
  embargoUntil: z.string().max(40).datetime({ offset: true }).nullable().optional(),
  usageNotes: text(PIPELINE_WORK_LIMITS.usageNotesMax).optional(),
};

export const editVersionUsageSchema = z
  .object(usageFields)
  .refine((v) => Object.keys(v).length > 0, "Nothing to change");
export type EditVersionUsageInput = z.infer<typeof editVersionUsageSchema>;

export const addVersionSchema = z
  .object({
    kind: z.enum(PIPELINE_VERSION_KINDS),
    label: line(PIPELINE_WORK_LIMITS.labelMax).optional(),
    url: pipelineWorkUrl.nullable().optional(),
    body: text(PIPELINE_WORK_LIMITS.bodyMax).optional(),
    note: line(PIPELINE_WORK_LIMITS.noteMax).optional(),
    ...usageFields,
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
export const versionParamsSchema = z.object({ vid: workId });
export const commentParamsSchema = z.object({ cid: workId });
export const shootParamsSchema = z.object({ sid: workId });

export const addCommentSchema = z.object({
  body: text(PIPELINE_WORK_LIMITS.commentMax).pipe(z.string().min(1, "Write a comment")),
  /** Seconds into the video; omit for a comment on the whole file. */
  atSeconds: z.number().int().min(0).max(PIPELINE_WORK_LIMITS.atSecondsMax).nullable().optional(),
});
export type AddCommentInput = z.infer<typeof addCommentSchema>;

export const resolveCommentSchema = z.object({ resolved: z.boolean() });

/** "1:23" or "1:02:03" or "83" → seconds; null when unreadable. */
export function parseTimestamp(raw: string): number | null {
  const t = raw.trim();
  if (!/^\d{1,5}(:\d{1,2}){0,2}$/.test(t)) return null;
  const parts = t.split(":").map(Number);
  if (parts.slice(1).some((p) => p > 59)) return null;
  const secs = parts.reduce((acc, p) => acc * 60 + p, 0);
  return secs <= PIPELINE_WORK_LIMITS.atSecondsMax ? secs : null;
}

/** 83 → "1:23", 3723 → "1:02:03". */
export function formatTimestamp(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

const isoOrNull = z.string().max(40).datetime({ offset: true }).nullable();
const shootFields = {
  title: line(PIPELINE_WORK_LIMITS.shootTitleMax).pipe(z.string().min(1, "Give the shoot a title")),
  event: line(PIPELINE_WORK_LIMITS.shootFieldMax),
  location: line(PIPELINE_WORK_LIMITS.shootFieldMax),
  callTime: z.string().max(40).datetime({ offset: true }),
  cameraId: workId.nullable(),
  contact: line(PIPELINE_WORK_LIMITS.shootFieldMax),
  requirements: text(PIPELINE_WORK_LIMITS.shootRequirementsMax),
  deadline: isoOrNull,
  embargoUntil: isoOrNull,
  projectId: workId.nullable(),
};

export const createShootSchema = z.object({
  title: shootFields.title,
  callTime: shootFields.callTime,
  event: shootFields.event.optional(),
  location: shootFields.location.optional(),
  cameraId: shootFields.cameraId.optional(),
  contact: shootFields.contact.optional(),
  requirements: shootFields.requirements.optional(),
  deadline: shootFields.deadline.optional(),
  embargoUntil: shootFields.embargoUntil.optional(),
  projectId: shootFields.projectId.optional(),
});
export type CreateShootInput = z.infer<typeof createShootSchema>;

export const editShootSchema = z.object({
  base: z.number().int().min(1).max(2_147_483_647),
  changes: z
    .object({
      title: shootFields.title.optional(),
      callTime: shootFields.callTime.optional(),
      event: shootFields.event.optional(),
      location: shootFields.location.optional(),
      cameraId: shootFields.cameraId.optional(),
      contact: shootFields.contact.optional(),
      requirements: shootFields.requirements.optional(),
      deadline: shootFields.deadline.optional(),
      embargoUntil: shootFields.embargoUntil.optional(),
      projectId: shootFields.projectId.optional(),
      status: z.enum(PIPELINE_SHOOT_STATUSES).optional(),
      uploadUrl: pipelineWorkUrl.nullable().optional(),
    })
    .refine((c) => Object.keys(c).length > 0, "Nothing to change"),
});
export type EditShootInput = z.infer<typeof editShootSchema>;

export const shootListQuerySchema = z.object({
  view: z.enum(["upcoming", "mine", "past"]).default("upcoming"),
});

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
  source: string;
  rights: PipelineRights | "";
  licenceExpires: string | null;
  embargoUntil: string | null;
  usageNotes: string;
  createdBy: PipelineWorkPerson;
  createdAt: string;
  comments: PipelineCommentDto[];
}

export interface PipelineCommentDto {
  id: string;
  versionId: string;
  author: PipelineWorkPerson;
  atSeconds: number | null;
  body: string;
  resolvedAt: string | null;
  resolvedBy: PipelineWorkPerson | null;
  createdAt: string;
}

export interface PipelineShootDto {
  id: string;
  project: { id: string; title: string } | null;
  title: string;
  event: string;
  location: string;
  callTime: string;
  camera: PipelineWorkPerson | null;
  contact: string;
  requirements: string;
  deadline: string | null;
  embargoUntil: string | null;
  status: PipelineShootStatus;
  uploadUrl: string | null;
  rev: number;
  createdBy: PipelineWorkPerson;
  createdAt: string;
  updatedAt: string;
}

export interface PipelineWorkloadRow {
  person: PipelineWorkPerson;
  /** Pages assigned and not published / cancelled. */
  pagesOpen: number;
  /** …of which scheduled time has passed. */
  pagesLate: number;
  reviewsToDo: number;
  /** Shoots assigned and still open, from today on. */
  shootsOpen: number;
  /** Projects owned in a live phase. */
  projectsOwned: number;
  projectsOverdue: number;
  /** Approved leave covering today (IST). */
  onLeaveToday: boolean;
  /** Approved leave starting within the next 7 days (IST), first day. */
  leaveFrom: string | null;
}

export interface PipelineWorkloadDto {
  rows: PipelineWorkloadRow[];
  today: string;
  now: string;
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
  /** Shoots I'm the camera for, still open, soonest first. */
  shoots: PipelineShootDto[];
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

// ── Usage restrictions (pure) ──────────────────────────────────────────────────────

export interface UsageRef {
  kind: string;
  number: number;
  embargoUntil: string | Date | null;
  licenceExpires: string | Date | null;
}

const isoDay = (d: string | Date) => (typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10));

/**
 * Why a page can't go live at `goLive` (ms) with these versions, or null. Licence expiry is a
 * calendar day: the licence covers its expiry day itself, so it blocks from the next day on.
 * `todayKey` is the IST day of `goLive` (callers pass it so the rule never depends on the
 * server's time zone).
 */
export function usageBlock(versions: readonly UsageRef[], goLive: number, goLiveDayKey: string): string | null {
  for (const v of versions) {
    const label = `${PIPELINE_VERSION_KIND_LABEL[v.kind as PipelineVersionKind] ?? v.kind} v${v.number}`;
    if (v.embargoUntil) {
      const until = typeof v.embargoUntil === "string" ? Date.parse(v.embargoUntil) : v.embargoUntil.getTime();
      if (goLive < until) return `${label} is under embargo until ${new Date(until).toISOString()}`;
    }
    if (v.licenceExpires && isoDay(v.licenceExpires) < goLiveDayKey) {
      return `${label}'s licence expired on ${isoDay(v.licenceExpires)}`;
    }
  }
  return null;
}
