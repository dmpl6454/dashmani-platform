/**
 * Pipeline project documents (2026-11-20): the pitch deck, brief, quote and report of a
 * campaign, kept on the project itself — never in the chat, so deleting a message can never
 * lose one. Shared by the API (validation) and the portals (forms, labels).
 *
 *   document   a LINK (Drive, Canva, Slides…) or an UPLOADED file (Cloudflare R2, same bucket and
 *              key shape as version files: pipeline/<projectId>/<random>), never both.
 *   status     draft → sent → accepted | rejected, set by hand. Every change stamps who and when,
 *              so the board can later say "Pitch sent 2d ago".
 *   source     "tab" (added in the Documents tab) or "chat" (attached to a chat message with the
 *              📎 button, 2026-11-23 — see file-tokens.ts). A chat file lands in the project's
 *              Documents tab too, and stays there when its message is deleted.
 *
 * A document that has left draft is a record: only the project owner or an admin can delete it.
 *
 * ⚠️ No regex lookbehind (this file ships in the HR bundle). Free text is length-bounded
 * BEFORE any transform (see validators/pipeline.ts for why).
 */
import { z } from "zod";
import { cleanLine, normalizeText } from "./text";
import { PIPELINE_FILE_KEY_RE, formatBytes, pipelineWorkUrl } from "./work";

// ── Values ─────────────────────────────────────────────────────────────────────────

export const PIPELINE_DOC_TYPES = ["pitch", "brief", "quote", "report", "photo", "other"] as const;
export type PipelineDocType = (typeof PIPELINE_DOC_TYPES)[number];

export const PIPELINE_DOC_TYPE_LABEL: Record<PipelineDocType, string> = {
  pitch: "Pitch deck",
  brief: "Brief",
  quote: "Quote",
  report: "Report",
  photo: "Photo",
  other: "Other",
};

export const PIPELINE_DOC_STATUSES = ["draft", "sent", "accepted", "rejected"] as const;
export type PipelineDocStatus = (typeof PIPELINE_DOC_STATUSES)[number];

export const PIPELINE_DOC_STATUS_LABEL: Record<PipelineDocStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  accepted: "Accepted",
  rejected: "Rejected",
};

export const PIPELINE_DOC_LIMITS = {
  titleMax: 120,
  noteMax: 1000,
  fileNameMax: 200,
  /**
   * Per project, Documents-tab documents only: a long campaign has a handful of revisions of
   * each; this is far above that. Files shared in chat have their own cap (`chatPerProject`), so
   * a busy chat full of photos can never block adding a pitch deck.
   */
  perProject: 100,
  /** Per project, files attached in chat (`source = 'chat'`). */
  chatPerProject: 1000,
  /** How many of the newest chat files the Documents tab lists (with every tab document). */
  chatListed: 200,
} as const;

const MB = 1024 * 1024;

/** What can be uploaded as a document: office files, PDFs, images, a zip. 200 MB at most. */
export const PIPELINE_DOC_UPLOAD_RULE: { types: readonly string[]; maxBytes: number } = {
  types: [
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel",
    "text/csv",
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "application/zip",
  ],
  maxBytes: 200 * MB,
};

/** Extension → type, for browsers that report no type (often the case for .pptx on Windows). */
export const PIPELINE_DOC_TYPE_BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ppt: "application/vnd.ms-powerpoint",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  csv: "text/csv",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  zip: "application/zip",
};

// ── Validators ─────────────────────────────────────────────────────────────────────

const docId = z
  .string()
  .max(36)
  .uuid()
  .transform((s) => s.toLowerCase());

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

const fileKey = z.string().max(120).regex(PIPELINE_FILE_KEY_RE, "Not an uploaded file");
const title = line(PIPELINE_DOC_LIMITS.titleMax).pipe(z.string().min(1, "Give the document a name"));

export const startDocUploadSchema = z
  .object({
    fileName: line(PIPELINE_DOC_LIMITS.fileNameMax).pipe(z.string().min(1, "The file needs a name")),
    contentType: z.string().max(100),
    size: z.number().int().positive(),
  })
  .superRefine((v, ctx) => {
    if (!PIPELINE_DOC_UPLOAD_RULE.types.includes(v.contentType)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["contentType"], message: "This type of file can't be uploaded as a document" });
    }
    if (v.size > PIPELINE_DOC_UPLOAD_RULE.maxBytes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["size"],
        message: `The file is too big (the most is ${formatBytes(PIPELINE_DOC_UPLOAD_RULE.maxBytes)})`,
      });
    }
  });
export type StartDocUploadInput = z.infer<typeof startDocUploadSchema>;

export const addDocSchema = z
  .object({
    type: z.enum(PIPELINE_DOC_TYPES),
    title,
    url: pipelineWorkUrl.nullable().optional(),
    fileKey: fileKey.optional(),
    fileName: line(PIPELINE_DOC_LIMITS.fileNameMax).optional(),
    status: z.enum(PIPELINE_DOC_STATUSES).optional(),
    note: text(PIPELINE_DOC_LIMITS.noteMax).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.url && v.fileKey) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["url"], message: "Use either a link or an uploaded file, not both" });
    } else if (!v.url && !v.fileKey) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["url"], message: "Add a link to the document or upload it" });
    }
  });
export type AddDocInput = z.infer<typeof addDocSchema>;

export const editDocSchema = z.object({
  /** The `rev` the editor read; a different current rev answers 409 with the current row. */
  base: z.number().int().min(1).max(2_147_483_647),
  changes: z
    .object({
      type: z.enum(PIPELINE_DOC_TYPES).optional(),
      title: title.optional(),
      status: z.enum(PIPELINE_DOC_STATUSES).optional(),
      note: text(PIPELINE_DOC_LIMITS.noteMax).optional(),
      /** Only for a link document: the file of an uploaded one never changes (add a new one). */
      url: pipelineWorkUrl.optional(),
    })
    .refine((c) => Object.keys(c).length > 0, "Nothing to change"),
});
export type EditDocInput = z.infer<typeof editDocSchema>;

export const docParamsSchema = z.object({ docId });

/** A file attached in chat: the upload is checked like any document upload. */
export const addAttachmentSchema = z.object({
  fileKey,
  fileName: line(PIPELINE_DOC_LIMITS.fileNameMax).pipe(z.string().min(1, "The file needs a name")),
});
export type AddAttachmentInput = z.infer<typeof addAttachmentSchema>;

export const PIPELINE_DOC_SOURCES = ["tab", "chat"] as const;
export type PipelineDocSource = (typeof PIPELINE_DOC_SOURCES)[number];

/** True for a file that can be shown as an image preview. */
export function isImageType(t: string): boolean {
  return t === "image/jpeg" || t === "image/png" || t === "image/webp" || t === "image/gif";
}
export const docFileQuerySchema = z.object({ download: z.enum(["0", "1"]).optional() });

// ── Wire types ─────────────────────────────────────────────────────────────────────

export interface PipelineDocPerson {
  id: string;
  name: string;
}

export interface PipelineDocDto {
  id: string;
  type: PipelineDocType;
  title: string;
  url: string | null;
  /** An uploaded file (R2). Open it with GET /pipeline/documents/:id/file. */
  file: { name: string; size: number; type: string } | null;
  status: PipelineDocStatus;
  /** When the status last changed (creation counts), and by whom. */
  statusChangedAt: string;
  statusChangedBy: PipelineDocPerson;
  note: string;
  /** Where it was added: the Documents tab, or attached to a chat message. */
  source: PipelineDocSource;
  /** For a chat file: the conversation (project or campaign channel) it was shared in. */
  conversationId: string | null;
  rev: number;
  createdBy: PipelineDocPerson;
  createdAt: string;
  updatedAt: string;
  /**
   * For an uploaded image (GET /pipeline/documents/:id and the project's list): a 15-minute
   * inline link, so a photo shows without a second request. Refresh it with GET …/file once it
   * is near its expiry.
   */
  view?: { url: string; expiresAt: string };
}

/** True when `s` has at least one letter (any script): "IMG_2041" yes, "_ (2)" no. */
export function hasLetter(s: string): boolean {
  return /\p{L}/u.test(s);
}

/**
 * What to call a document on screen. A title with no letter ("_ (2)", from a phone's file name)
 * says nothing, so it becomes "Photo · 24 Nov" (the type and the day it was added).
 */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export function docDisplayTitle(d: Pick<PipelineDocDto, "title" | "type" | "createdAt">): string {
  if (hasLetter(d.title)) return d.title;
  const t = new Date(d.createdAt);
  const day = Number.isFinite(t.getTime()) ? ` · ${t.getDate()} ${MONTHS[t.getMonth()]}` : "";
  return `${PIPELINE_DOC_TYPE_LABEL[d.type] ?? "File"}${day}`;
}

/** Chat files still in draft: shown apart from the project's real documents. */
export function isChatDraft(d: Pick<PipelineDocDto, "source" | "status">): boolean {
  return d.source === "chat" && d.status === "draft";
}

export interface PipelineDocsDto {
  documents: PipelineDocDto[];
  /** Whether file uploads are switched on (R2 configured). */
  uploads: boolean;
}

/** Null when the file can be uploaded as a document, else the reason in plain words. */
export function checkDocFile(file: { name: string; type: string; size: number }): string | null {
  const t = docFileType(file);
  if (!PIPELINE_DOC_UPLOAD_RULE.types.includes(t)) return "This type of file can't be uploaded as a document.";
  if (file.size <= 0) return "This file is empty.";
  if (file.size > PIPELINE_DOC_UPLOAD_RULE.maxBytes) {
    return `The file is too big (the most is ${formatBytes(PIPELINE_DOC_UPLOAD_RULE.maxBytes)}).`;
  }
  return null;
}

/** The file's type: what the browser says, else from its extension. */
export function docFileType(file: { name: string; type: string }): string {
  const t = (file.type || "").toLowerCase();
  if (t) return t;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return PIPELINE_DOC_TYPE_BY_EXTENSION[ext] ?? "";
}
