/**
 * Pipeline project documents (2026-11-20): pitch deck, brief, quote, report. Rules and wire
 * shapes live in packages/shared/src/pipeline/documents.ts; the table in
 * scripts/pipeline-docs-ddl.sql.
 *
 *   - A document lives on the PROJECT, not in the chat: deleting or editing a message never
 *     touches one. Nothing here posts a thread line.
 *   - A document is a link or an uploaded R2 file (same bucket and key shape as version files,
 *     pipeline/<projectId>/<random>). The file is checked against what R2 holds BEFORE the
 *     transaction; it never changes afterwards (add a new document for a new file).
 *   - Every status change stamps who and when (status_changed_*), so the board can later say
 *     "Pitch sent 2d ago". Edits carry `base: rev` → 409 DOCUMENT_CONFLICT with the current row.
 *   - A draft can be deleted by anyone who can edit the project. Once it has left draft it is a
 *     record: only the project owner or an admin may delete it (checked in the DB, never from
 *     the JWT — assertOwnerOrAdmin).
 *   - Every write takes the PROJECT row lock first (lockProject), like work.service.ts.
 *
 * ⚠️ Pipeline pool only (pipelineRead / pipelineWrite). No FK into `users`.
 * ⚠️ The nightly upload sweep (jobs.ts sweepOrphanUploads) keeps any file a document points at.
 * ⚠️ If the DDL is missing, these routes answer 503 DOCS_NOT_READY; the rest of the Pipeline,
 *    including the Work tab, is unaffected.
 */
import { pipelineDocs as D } from "@dashmani/shared";
import { pipelineRead, pipelineWrite } from "./tx";
import { PipelineError } from "./errors";
import { lockProject, assertWritable } from "./projects.service";
import { issueUploadTicket, verifyUploadedObject, type WorkActor } from "./work.service";
import { assertOwnerOrAdmin } from "../../middleware/pipeline-gates";
import { bumpBoard } from "./board";
import { recordActivity } from "./activity.service";
import { r2Config, presignR2 } from "../storage/r2";
import type { PipelineDirectory } from "./access";
import type { PipelineDbClient, PipelineTx } from "./db";
import type { pipelineWork as W } from "@dashmani/shared";

type Db = PipelineDbClient | PipelineTx;

// ── Errors ─────────────────────────────────────────────────────────────────────────

/** True for "the pipeline_documents table (or a column of it) does not exist", in any wrapping. */
export function isMissingDocsSchema(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && typeof e === "object" && i < 3; e = (e as { original?: unknown }).original, i++) {
    const code = (e as { code?: unknown }).code;
    const msg = String((e as { message?: unknown }).message ?? "").slice(0, 2000);
    if ((code === "P2021" || code === "P2022") && /pipeline_documents|PipelineDocument/.test(msg)) return true;
    if (/relation "pipeline_documents" does not exist|column "[a-z_]+" of relation "pipeline_documents"/.test(msg)) return true;
  }
  return false;
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isMissingDocsSchema(err)) {
      throw new PipelineError(503, "DOCS_NOT_READY", "Documents are waiting for a one-time database update", { retryAfterSec: 60 });
    }
    throw err;
  }
}

// ── Mapping ────────────────────────────────────────────────────────────────────────

const DOC_SELECT = {
  id: true, projectId: true, type: true, title: true, url: true,
  fileKey: true, fileName: true, fileSize: true, fileType: true,
  status: true, statusChangedAt: true, statusChangedById: true, note: true, rev: true,
  source: true, conversationId: true,
  createdById: true, createdAt: true, updatedAt: true,
} as const;

interface DocRow {
  id: string;
  projectId: string;
  type: string;
  title: string;
  url: string | null;
  fileKey: string | null;
  fileName: string;
  fileSize: bigint | null;
  fileType: string;
  status: string;
  statusChangedAt: Date;
  statusChangedById: string;
  note: string;
  source: string;
  conversationId: string | null;
  rev: number;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
}

function person(dir: PipelineDirectory, id: string): D.PipelineDocPerson {
  return { id, name: dir.byId.get(id)?.name ?? "Former member" };
}

function docDto(dir: PipelineDirectory, d: DocRow): D.PipelineDocDto {
  return {
    id: d.id,
    type: d.type as D.PipelineDocType,
    title: d.title,
    url: d.url,
    file: d.fileKey ? { name: d.fileName || "file", size: d.fileSize == null ? 0 : Number(d.fileSize), type: d.fileType } : null,
    status: d.status as D.PipelineDocStatus,
    statusChangedAt: d.statusChangedAt.toISOString(),
    statusChangedBy: person(dir, d.statusChangedById),
    note: d.note,
    source: d.source === "chat" ? "chat" : "tab",
    conversationId: d.conversationId,
    rev: d.rev,
    createdBy: person(dir, d.createdById),
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

function fileNameOf(name: string | undefined): string {
  const n = (name ?? "").replace(/[\u0000-\u001f\u007f/\\]/g, "").trim().slice(0, D.PIPELINE_DOC_LIMITS.fileNameMax);
  return n || "file";
}

async function assertProjectReadable(db: Db, projectId: string): Promise<void> {
  const p = await db.pipelineProject.findFirst({ where: { id: projectId, kind: "project" }, select: { deletedAt: true } });
  if (!p) throw new PipelineError(404, "PROJECT_NOT_FOUND", "This project doesn't exist");
  if (p.deletedAt) throw new PipelineError(404, "PROJECT_DELETED", "This project was deleted");
}

/**
 * The conversations among `convIds` that `viewerId` may not read: private channels they are not
 * a member of. A file can only be attached in a PUBLIC channel, but a channel can be made
 * private later; its earlier files then follow its privacy instead of staying open to everyone.
 */
async function hiddenConversations(db: Db, viewerId: string, convIds: Array<string | null>): Promise<Set<string>> {
  const ids = [...new Set(convIds.filter((x): x is string => !!x))];
  if (ids.length === 0) return new Set();
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    SELECT p.id FROM pipeline_projects p
     WHERE p.id = ANY(${ids}::text[]) AND p.is_private = true
       AND NOT EXISTS (SELECT 1 FROM pipeline_participants x WHERE x.project_id = p.id AND x.user_id = ${viewerId})`;
  return new Set(rows.map((r) => r.id));
}

/** 404 when `doc` is a chat file from a private channel `viewerId` is not in. */
async function assertDocVisible(db: Db, viewerId: string, doc: { source: string; conversationId: string | null }): Promise<void> {
  if (doc.source !== "chat" || !doc.conversationId) return;
  if ((await hiddenConversations(db, viewerId, [doc.conversationId])).size > 0) {
    throw new PipelineError(404, "DOCUMENT_NOT_FOUND", "This document doesn't exist");
  }
}

// ── Reads ──────────────────────────────────────────────────────────────────────────

/** A project's documents, newest first. */
export async function listDocuments(dir: PipelineDirectory, projectId: string, viewerId: string): Promise<D.PipelineDocsDto> {
  return guarded(async () => {
    const rows = await pipelineRead(async (db) => {
      await assertProjectReadable(db, projectId);
      // Every tab document, plus the newest chat files: a chat full of photos never pushes a
      // pitch deck off the list.
      const orderBy = [{ createdAt: "desc" as const }, { id: "desc" as const }];
      const tab = await db.pipelineDocument.findMany({
        where: { projectId, source: "tab" }, select: DOC_SELECT, orderBy, take: D.PIPELINE_DOC_LIMITS.perProject,
      });
      const chat = await db.pipelineDocument.findMany({
        where: { projectId, source: "chat" }, select: DOC_SELECT, orderBy, take: D.PIPELINE_DOC_LIMITS.chatListed,
      });
      const hidden = await hiddenConversations(db, viewerId, chat.map((d) => d.conversationId));
      return [...tab, ...chat.filter((d) => !d.conversationId || !hidden.has(d.conversationId))].sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      );
    });
    return { documents: rows.map((r) => docDto(dir, r)), uploads: r2Config() !== null };
  });
}

// ── Uploads ────────────────────────────────────────────────────────────────────────

/** A signed PUT for a document file; the browser sends it straight to R2. */
export async function startDocumentUpload(
  actor: WorkActor,
  projectId: string,
  input: D.StartDocUploadInput,
): Promise<W.PipelineUploadTicket> {
  return issueUploadTicket(actor, projectId, input.contentType, input.size);
}

const DOWNLOAD_URL_TTL_SEC = 15 * 60;

/** A short-lived link to a document's uploaded file: to view it inline, or to download it. */
export async function documentFileUrl(viewerId: string, docId: string, download: boolean): Promise<{ url: string; expiresAt: string }> {
  const cfg = r2Config();
  if (!cfg) throw new PipelineError(503, "UPLOADS_OFF", "File uploads aren't switched on");
  const d = await guarded(() =>
    pipelineRead(async (db) => {
      const row = await db.pipelineDocument.findUnique({
        where: { id: docId },
        select: { projectId: true, fileKey: true, fileName: true, fileType: true, source: true, conversationId: true },
      });
      if (!row) throw new PipelineError(404, "DOCUMENT_NOT_FOUND", "This document doesn't exist");
      await assertProjectReadable(db, row.projectId);
      await assertDocVisible(db, viewerId, row);
      return row;
    }),
  );
  if (!d.fileKey) throw new PipelineError(404, "NO_FILE", "This document is a link, not an uploaded file");
  return signDocFile(cfg, { fileKey: d.fileKey, fileName: d.fileName, fileType: d.fileType }, download);
}

/** The signed GET for a document's file (pure crypto, no database call). */
function signDocFile(
  cfg: NonNullable<ReturnType<typeof r2Config>>,
  d: { fileKey: string; fileName: string; fileType: string },
  download: boolean,
): { url: string; expiresAt: string } {
  const name = d.fileName || "file";
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const disposition = `${download ? "attachment" : "inline"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
  const now = new Date();
  const query: Record<string, string> = { "response-content-disposition": disposition };
  if (d.fileType) query["response-content-type"] = d.fileType;
  return {
    url: presignR2(cfg, "GET", d.fileKey, DOWNLOAD_URL_TTL_SEC, { query, now }),
    expiresAt: new Date(now.getTime() + DOWNLOAD_URL_TTL_SEC * 1000).toISOString(),
  };
}

// ── Writes ─────────────────────────────────────────────────────────────────────────

export async function addDocument(actor: WorkActor, projectId: string, input: D.AddDocInput): Promise<D.PipelineDocDto> {
  // An uploaded file is checked against R2 BEFORE the transaction: never hold the project lock
  // across a network call.
  const file = input.fileKey ? await verifyUploadedObject(projectId, input.fileKey, D.PIPELINE_DOC_UPLOAD_RULE) : null;
  return guarded(async () => {
    const row = await pipelineWrite(async (tx) => {
      assertWritable(await lockProject(tx, projectId, actor.userId));
      if (input.fileKey) {
        // One file backs one row, across documents AND versions.
        const taken =
          (await tx.pipelineDocument.findUnique({ where: { fileKey: input.fileKey }, select: { id: true } })) ??
          (await tx.pipelineVersion.findUnique({ where: { fileKey: input.fileKey }, select: { id: true } }));
        if (taken) throw new PipelineError(409, "FILE_ALREADY_USED", "This file is already in use");
      }
      const count = await tx.pipelineDocument.count({ where: { projectId, source: "tab" } });
      if (count >= D.PIPELINE_DOC_LIMITS.perProject) {
        throw new PipelineError(409, "TOO_MANY_DOCUMENTS", "This project has the most documents it can hold");
      }
      const created = await tx.pipelineDocument.create({
        data: {
          projectId,
          type: input.type,
          title: input.title,
          url: input.url ?? null,
          fileKey: input.fileKey ?? null,
          fileName: file ? fileNameOf(input.fileName) : "",
          fileSize: file ? BigInt(file.size) : null,
          fileType: file ? file.contentType : "",
          status: input.status ?? "draft",
          statusChangedById: actor.userId,
          note: input.note ?? "",
          createdById: actor.userId,
        },
        select: DOC_SELECT,
      });
      await recordActivity(tx, {
        projectId,
        kind: "doc_added",
        actorId: actor.userId,
        data: { docId: created.id, type: created.type, title: created.title, status: created.status, href: created.url },
      });
      return created;
    });
    // The board card shows the newest non-draft document move.
    if (row.status !== "draft") await bumpBoard();
    return docDto(actor.directory, row);
  });
}

/** Locks the document's project, then re-reads the document under that lock. */
async function lockDocument(tx: PipelineTx, actor: WorkActor, docId: string) {
  const pre = await tx.pipelineDocument.findUnique({ where: { id: docId }, select: { projectId: true } });
  if (!pre) throw new PipelineError(404, "DOCUMENT_NOT_FOUND", "This document doesn't exist");
  const project = await lockProject(tx, pre.projectId, actor.userId);
  assertWritable(project);
  const row = await tx.pipelineDocument.findUnique({ where: { id: docId }, select: DOC_SELECT });
  if (!row) throw new PipelineError(404, "DOCUMENT_NOT_FOUND", "This document doesn't exist");
  await assertDocVisible(tx, actor.userId, row);
  return { row, ownerId: String(project.owner_id) };
}

export async function editDocument(actor: WorkActor, docId: string, input: D.EditDocInput): Promise<D.PipelineDocDto> {
  const c = input.changes;
  return guarded(async () => {
    const { row, cardChanged } = await pipelineWrite(async (tx) => {
      const { row: cur } = await lockDocument(tx, actor, docId);
      if (cur.rev !== input.base) {
        throw new PipelineError(409, "DOCUMENT_CONFLICT", "Someone else changed this document — showing their version", {
          current: docDto(actor.directory, cur),
        });
      }
      if (c.url !== undefined && cur.fileKey) {
        throw new PipelineError(400, "DOCUMENT_IS_FILE", "This document is an uploaded file — add a new document for a new file");
      }
      const data: Record<string, unknown> = { rev: { increment: 1 } };
      if (c.type !== undefined) data.type = c.type;
      if (c.title !== undefined) data.title = c.title;
      if (c.note !== undefined) data.note = c.note;
      if (c.url !== undefined) data.url = c.url;
      if (c.status !== undefined && c.status !== cur.status) {
        data.status = c.status;
        data.statusChangedAt = new Date();
        data.statusChangedById = actor.userId;
      }
      const updated = await tx.pipelineDocument.update({ where: { id: docId }, data, select: DOC_SELECT });
      if (updated.status !== cur.status) {
        await recordActivity(tx, {
          projectId: cur.projectId,
          kind: "doc_status",
          actorId: actor.userId,
          data: { docId, type: updated.type, title: updated.title, status: updated.status, href: updated.url },
        });
      }
      // The card reads the newest NON-draft document's type and status: only those can change it.
      const cardChanged =
        (cur.status !== "draft" || updated.status !== "draft") &&
        (updated.status !== cur.status || updated.type !== cur.type);
      return { row: updated, cardChanged };
    });
    if (cardChanged) await bumpBoard();
    return docDto(actor.directory, row);
  });
}

export async function deleteDocument(actor: WorkActor, docId: string): Promise<{ id: string }> {
  return guarded(async () => {
    const wasDraft = await pipelineWrite(async (tx) => {
      const { row, ownerId } = await lockDocument(tx, actor, docId);
      if (row.status !== "draft") {
        // A document that was sent (or answered) is a record of what the client saw.
        try {
          await assertOwnerOrAdmin(tx, { actorId: actor.userId, ownerId });
        } catch {
          throw new PipelineError(403, "DOCUMENT_KEPT", "This document was sent, so only the project owner or an admin can delete it");
        }
      }
      await tx.pipelineDocument.delete({ where: { id: docId } });
      await recordActivity(tx, { projectId: row.projectId, kind: "doc_deleted", actorId: actor.userId, data: { type: row.type, title: row.title } });
      // The uploaded file (if any) is left in R2; the nightly sweep removes it a day later.
      return row.status === "draft";
    });
    if (!wasDraft) await bumpBoard(); // a draft never shows on the card
    return { id: docId };
  });
}

// ── Chat attachments (2026-11-23) ─────────────────────────────────────────────────
//
// The 📎 button in a project's chat or in one of its campaign channels uploads a file that becomes
// a project document (source "chat"); the message then carries `#{file:<id>}` (file-tokens.ts).
// Deleting the message never touches the document. Private channels, team-wide channels and
// DMs have no campaign behind them (or would leak a private file into the open Documents tab),
// so attaching there is refused.

type Row = Record<string, unknown>;

/** Where a file attached in conversation `convId` is filed: the project, or the channel's campaign. */
async function attachTarget(tx: PipelineTx, actor: WorkActor, convId: string): Promise<string> {
  const rows = await tx.$queryRaw<Row[]>`
    SELECT p.id, p.kind, p.is_private, p.parent_project_id, p.archived_at, p.deleted_at,
           EXISTS (SELECT 1 FROM pipeline_participants x WHERE x.project_id = p.id AND x.user_id = ${actor.userId}) AS is_member
      FROM pipeline_projects p WHERE p.id = ${convId}`;
  const c = rows[0];
  if (!c || c.deleted_at) throw new PipelineError(404, "CONVERSATION_NOT_FOUND", "This conversation doesn't exist");
  if (c.kind === "project") {
    assertWritable(await lockProject(tx, convId, actor.userId));
    return convId;
  }
  const member = c.is_member === true;
  // A private channel or a DM someone isn't in looks the same as one that doesn't exist.
  if ((c.is_private === true || c.kind === "dm") && !member) {
    throw new PipelineError(404, "CONVERSATION_NOT_FOUND", "This conversation doesn't exist");
  }
  if (c.kind !== "channel" || !c.parent_project_id) {
    throw new PipelineError(409, "ATTACH_NOT_HERE", "Files can be shared in a campaign's chat and its channels");
  }
  if (c.is_private === true) {
    throw new PipelineError(409, "ATTACH_PRIVATE", "Files can't be shared in a private channel — share them in the campaign's chat");
  }
  if (!member) throw new PipelineError(403, "NOT_A_MEMBER", "Join this channel to post in it");
  if (c.archived_at) throw new PipelineError(409, "PROJECT_ARCHIVED", "This channel is archived");
  const parentId = String(c.parent_project_id);
  assertWritable(await lockProject(tx, parentId, actor.userId));
  return parentId;
}

/** A signed PUT for a file attached in chat; the key lives under the campaign's prefix. */
export async function startAttachmentUpload(
  actor: WorkActor,
  convId: string,
  input: D.StartDocUploadInput,
): Promise<W.PipelineUploadTicket> {
  if (!r2Config()) throw new PipelineError(503, "UPLOADS_OFF", "File uploads aren't switched on");
  const projectId = await guarded(() => pipelineWrite((tx) => attachTarget(tx, actor, convId)));
  return issueUploadTicket(actor, projectId, input.contentType, input.size);
}

/** Files the uploaded object as a chat document of the campaign. The client then sends the message. */
export async function addAttachment(actor: WorkActor, convId: string, input: D.AddAttachmentInput): Promise<D.PipelineDocDto> {
  // Where it goes (a short transaction), so R2 is checked OUTSIDE any transaction; re-checked under the lock.
  const projectId = await guarded(() => pipelineWrite((tx) => attachTarget(tx, actor, convId)));
  const file = await verifyUploadedObject(projectId, input.fileKey, D.PIPELINE_DOC_UPLOAD_RULE);
  return guarded(async () => {
    const row = await pipelineWrite(async (tx) => {
      const again = await attachTarget(tx, actor, convId);
      if (again !== projectId) throw new PipelineError(409, "EDIT_CONFLICT", "This conversation changed — try again");
      const taken =
        (await tx.pipelineDocument.findUnique({ where: { fileKey: input.fileKey }, select: { id: true } })) ??
        (await tx.pipelineVersion.findUnique({ where: { fileKey: input.fileKey }, select: { id: true } }));
      if (taken) throw new PipelineError(409, "FILE_ALREADY_USED", "This file is already in use");
      const count = await tx.pipelineDocument.count({ where: { projectId, source: "chat" } });
      if (count >= D.PIPELINE_DOC_LIMITS.chatPerProject) {
        throw new PipelineError(409, "TOO_MANY_DOCUMENTS", "This project has the most chat files it can hold");
      }
      const name = fileNameOf(input.fileName);
      const photo = D.isImageType(file.contentType);
      const base = name.replace(/\.[A-Za-z0-9]{1,8}$/, "");
      // A name with no letter or digit ("_.jpeg", "-.pdf") makes a useless title.
      const title = /[\p{L}\p{N}]/u.test(base) ? base : photo ? "Photo" : "File";
      const shared = await tx.pipelineDocument.create({
        data: {
          projectId,
          type: photo ? "photo" : "other",
          title: title.slice(0, D.PIPELINE_DOC_LIMITS.titleMax),
          fileKey: input.fileKey,
          fileName: name,
          fileSize: BigInt(file.size),
          fileType: file.contentType,
          status: "draft",
          statusChangedById: actor.userId,
          source: "chat",
          conversationId: convId,
          createdById: actor.userId,
        },
        select: DOC_SELECT,
      });
      await recordActivity(tx, {
        projectId,
        kind: "doc_added",
        actorId: actor.userId,
        data: { docId: shared.id, type: shared.type, title: shared.title, via: "chat" },
      });
      return shared;
    });
    return docDto(actor.directory, row);
  });
}

/** One document, for an attachment card in the chat. */
export async function getDocument(dir: PipelineDirectory, viewerId: string, docId: string): Promise<D.PipelineDocDto> {
  return guarded(async () => {
    const row = await pipelineRead(async (db) => {
      const d = await db.pipelineDocument.findUnique({ where: { id: docId }, select: DOC_SELECT });
      if (!d) throw new PipelineError(404, "DOCUMENT_NOT_FOUND", "This file was removed");
      await assertProjectReadable(db, d.projectId);
      await assertDocVisible(db, viewerId, d);
      return d;
    });
    const dto = docDto(dir, row);
    // A chat photo shows its preview at once: sign the inline link here (no extra DB read)
    // instead of the card asking GET …/file for it — one request per photo, not two.
    const cfg = r2Config();
    if (cfg && row.fileKey && D.isImageType(row.fileType)) {
      dto.view = signDocFile(cfg, { fileKey: row.fileKey, fileName: row.fileName, fileType: row.fileType }, false);
    }
    return dto;
  });
}
