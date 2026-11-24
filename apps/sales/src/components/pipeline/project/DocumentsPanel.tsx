"use client";
/**
 * Documents on one project (2026-11-20): pitch deck, brief, quote, report. They live on the
 * project, not in the chat, so deleting a message never loses one. Rules live in
 * packages/shared/src/pipeline/documents.ts; the API enforces them.
 *
 *   - A document is a link (Drive, Canva, Slides…) or an uploaded file (R2, when uploads are on).
 *   - Status Draft → Sent → Accepted / Rejected; each change shows who and how long ago.
 *   - A sent document can be removed only by the project owner or an admin (the API says so).
 *
 * Data: GET /pipeline/projects/:id/documents, on mount, on focus and after every action here.
 */
import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { Download, ExternalLink, FileText, Link2 } from "lucide-react";
import { pipelineDocs as D, pipelineWork as W, relativeAgo } from "@dashmani/shared";
import { PL_SWR } from "@/lib/pipeline-swr";
import { describeError, isApiError, plApi } from "../api";
import { Skeleton } from "../ui/Skeleton";
import { useMinuteClock } from "../ui/Ago";
import { UploadError, openVersionFile, putToR2 } from "../upload";
import { PhotoViewer } from "../ui/PhotoViewer";

const inputCls =
  "w-full h-11 px-3 rounded-xl border border-border bg-surface text-[16px] text-ink focus:outline-none focus:ring-2 focus:ring-indigo";
const areaCls =
  "w-full px-3 py-2 rounded-xl border border-border bg-surface text-[16px] text-ink focus:outline-none focus:ring-2 focus:ring-indigo";
const btn = "h-11 px-3.5 rounded-xl text-[13px] font-semibold disabled:opacity-50";
const btnPrimary = `${btn} bg-indigo text-white`;
const btnGhost = `${btn} border border-border text-ink-2 hover:bg-muted`;

const STATUS_TONE: Record<D.PipelineDocStatus, string> = {
  draft: "bg-muted text-ink-2",
  sent: "bg-indigo-soft text-indigo",
  accepted: "bg-success-bg text-success",
  rejected: "bg-danger-bg text-danger",
};

/** "Sent" / "Accepted" … as a past-tense line under the title. */
const STATUS_VERB: Record<D.PipelineDocStatus, string> = {
  draft: "Added",
  sent: "Sent",
  accepted: "Accepted",
  rejected: "Rejected",
};

const ACCEPT = D.PIPELINE_DOC_UPLOAD_RULE.types.join(",") + ",.pptx,.ppt,.docx,.doc,.xlsx,.xls,.csv,.pdf";

function errText(e: unknown): string {
  return e instanceof UploadError ? e.message : describeError(e);
}

function Err({ text }: { text: string | null }) {
  return text ? (
    <p role="alert" className="mt-2 text-[13px] text-danger">
      {text}
    </p>
  ) : null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function DocumentsPanel({ projectId, readOnly }: { projectId: string; readOnly: boolean }) {
  const { data, error, isLoading, mutate } = useSWR(`pl-docs:${projectId}`, () => plApi.documents(projectId), {
    ...PL_SWR,
    revalidateOnFocus: true,
  });

  if (!data) {
    if (error) {
      return (
        <div className="p-4" role="alert">
          <p className="text-[13.5px] text-ink-2">{describeError(error)}</p>
          <button type="button" className={`${btnGhost} mt-3`} onClick={() => void mutate()}>
            Try again
          </button>
        </div>
      );
    }
    return (
      <div className="p-4 space-y-3" role="status" aria-label={isLoading ? "Loading documents" : undefined}>
        <Skeleton className="h-5 w-1/2" />
        <Skeleton className="h-16" />
        <Skeleton className="h-16" />
      </div>
    );
  }

  const refresh = () => void mutate();
  return (
    <section className="px-4 py-4">
      <AddDocument projectId={projectId} uploads={data.uploads} readOnly={readOnly} onAdded={refresh} empty={data.documents.length === 0} />
      <ul className="mt-3 space-y-2">
        {data.documents.map((d) => (
          <DocumentRow key={`${d.id}:${d.rev}`} d={d} readOnly={readOnly} onChanged={refresh} />
        ))}
      </ul>
    </section>
  );
}

// ── Add ────────────────────────────────────────────────────────────────────────────

function AddDocument({
  projectId,
  uploads,
  readOnly,
  empty,
  onAdded,
}: {
  projectId: string;
  uploads: boolean;
  readOnly: boolean;
  empty: boolean;
  onAdded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<D.PipelineDocType>("pitch");
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState<D.PipelineDocStatus>("draft");
  const [note, setNote] = useState("");
  const [source, setSource] = useState<"file" | "link">(uploads ? "file" : "link");
  const useFile = uploads && source === "file";
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Leaving the page mid-upload loses the upload: say so.
  useEffect(() => {
    if (progress === null) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [progress]);

  const reset = () => {
    setOpen(false);
    setTitle("");
    setUrl("");
    setNote("");
    setStatus("draft");
    setFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const save = async () => {
    if (useFile && !file) return setErr("Choose a file to upload.");
    if (useFile && file) {
      const bad = D.checkDocFile(file);
      if (bad) return setErr(bad);
    }
    // The file name is a good default title.
    const name = title.trim() || (useFile && file ? file.name.replace(/\.[^.]+$/, "") : "");
    const draft = (fileKey?: string) => ({
      type,
      title: name.slice(0, D.PIPELINE_DOC_LIMITS.titleMax),
      url: useFile ? null : url.trim() || null,
      fileKey,
      fileName: fileKey && file ? file.name.slice(0, D.PIPELINE_DOC_LIMITS.fileNameMax) : undefined,
      status,
      note: note.trim() || undefined,
    });
    // Check every other field BEFORE spending an upload on it (a well-formed stand-in key).
    const pre = D.addDocSchema.safeParse(draft(useFile ? `pipeline/${projectId}/${"0".repeat(32)}` : undefined));
    if (!pre.success) return setErr(pre.error.issues[0]?.message ?? "Check the details.");
    setBusy(true);
    setErr(null);
    try {
      let wire: D.AddDocInput = pre.data;
      if (useFile && file) {
        const ticket = await plApi.startDocumentUpload(projectId, {
          fileName: file.name.slice(0, D.PIPELINE_DOC_LIMITS.fileNameMax),
          contentType: D.docFileType(file),
          size: file.size,
        });
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        setProgress(0);
        await putToR2(ticket, file, setProgress, ctrl.signal);
        wire = D.addDocSchema.parse(draft(ticket.key));
      }
      await plApi.addDocument(projectId, wire);
      reset();
      onAdded();
    } catch (e) {
      setErr(errText(e));
    } finally {
      abortRef.current = null;
      setProgress(null);
      setBusy(false);
    }
  };

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[13px] font-bold uppercase tracking-wide text-ink-3">Documents</h2>
        {!readOnly && !open && (
          <button type="button" className="text-[13px] font-semibold text-indigo h-11 px-1" onClick={() => setOpen(true)}>
            Add document
          </button>
        )}
      </div>
      {empty && !open && (
        <p className="text-[13.5px] text-ink-3">
          Keep the pitch deck, brief, quote and report here. Files shared in the chat with 📎 show up here too, and they stay with
          the project even if chat messages are deleted.
        </p>
      )}
      {open && (
        <div className="mt-2 space-y-2.5 rounded-xl border border-border p-3">
          <div className="grid grid-cols-2 gap-2">
            <select className={inputCls} value={type} onChange={(e) => setType(e.target.value as D.PipelineDocType)} aria-label="Type">
              {D.PIPELINE_DOC_TYPES.map((t) => (
                <option key={t} value={t}>
                  {D.PIPELINE_DOC_TYPE_LABEL[t]}
                </option>
              ))}
            </select>
            <select className={inputCls} value={status} onChange={(e) => setStatus(e.target.value as D.PipelineDocStatus)} aria-label="Status">
              {D.PIPELINE_DOC_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {D.PIPELINE_DOC_STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
          {uploads && (
            <div className="flex gap-1.5" role="group" aria-label="Where the document is">
              {(["file", "link"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={source === s}
                  disabled={busy}
                  onClick={() => setSource(s)}
                  className={`h-9 px-3 rounded-lg text-[12.5px] font-semibold border ${
                    source === s ? "border-indigo bg-indigo-soft text-indigo-light" : "border-border text-ink-3"
                  }`}
                >
                  {s === "file" ? "Upload a file" : "Paste a link"}
                </button>
              ))}
            </div>
          )}
          {useFile ? (
            <div className="space-y-1.5">
              <input
                ref={fileInputRef}
                type="file"
                accept={ACCEPT}
                disabled={busy}
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  setFile(f);
                  setErr(f ? D.checkDocFile(f) : null);
                }}
                aria-label="File to upload"
                className="block w-full max-w-full text-[13px] text-ink-2 file:mr-3 file:h-9 file:px-3 file:rounded-lg file:border-0 file:bg-muted file:text-[12.5px] file:font-semibold file:text-ink"
              />
              <p className="text-[12px] text-ink-4">PDF, PowerPoint, Word, Excel, CSV, image or zip · up to {W.formatBytes(D.PIPELINE_DOC_UPLOAD_RULE.maxBytes)}</p>
              {file && (
                <p className="text-[12.5px] text-ink-3 break-all">
                  {file.name} · {W.formatBytes(file.size)}
                </p>
              )}
              {progress !== null && (
                <div className="flex items-center gap-2" role="status" aria-live="polite">
                  <div className="h-2 flex-1 rounded-full bg-muted overflow-hidden">
                    <div className="h-full bg-indigo transition-[width]" style={{ width: `${Math.round(progress * 100)}%` }} />
                  </div>
                  <span className="text-[12px] text-ink-3 tabular-nums w-10 text-right">{Math.round(progress * 100)}%</span>
                  <button type="button" className="h-8 px-2 text-[12.5px] font-semibold text-danger" onClick={() => abortRef.current?.abort()}>
                    Cancel upload
                  </button>
                </div>
              )}
            </div>
          ) : (
            <input
              className={inputCls}
              type="url"
              inputMode="url"
              placeholder="Link — Google Slides, Drive, Canva…"
              value={url}
              maxLength={W.PIPELINE_WORK_LIMITS.urlMax}
              onChange={(e) => setUrl(e.target.value)}
              aria-label="Link to the document"
            />
          )}
          <input
            className={inputCls}
            placeholder={useFile ? "Name (optional — the file name is used)" : "Name, e.g. Diwali pitch v2"}
            value={title}
            maxLength={D.PIPELINE_DOC_LIMITS.titleMax}
            onChange={(e) => setTitle(e.target.value)}
            aria-label="Name"
          />
          <textarea
            className={areaCls}
            rows={2}
            placeholder="Note (optional) — e.g. sent to Rahul at the brand"
            value={note}
            maxLength={D.PIPELINE_DOC_LIMITS.noteMax}
            onChange={(e) => setNote(e.target.value)}
            aria-label="Note"
          />
          <div className="flex gap-2">
            <button type="button" className={btnPrimary} disabled={busy} onClick={() => void save()}>
              {progress !== null ? "Uploading…" : useFile ? "Upload & save" : "Save document"}
            </button>
            <button type="button" className={btnGhost} disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
          <Err text={err} />
        </div>
      )}
    </>
  );
}

// ── One document ───────────────────────────────────────────────────────────────────

function DocumentRow({ d, readOnly, onChanged }: { d: D.PipelineDocDto; readOnly: boolean; onChanged: () => void }) {
  const now = useMinuteClock();
  const [editing, setEditing] = useState(false);
  const [type, setType] = useState<D.PipelineDocType>(d.type);
  const [title, setTitle] = useState(d.title);
  const [status, setStatus] = useState<D.PipelineDocStatus>(d.status);
  const [note, setNote] = useState(d.note);
  const [url, setUrl] = useState(d.url ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // A photo opens full screen on this page (PhotoViewer), never in a new tab.
  const [viewUrl, setViewUrl] = useState<string | null>(null);
  const isPhoto = !!d.file && D.isImageType(d.file.type);

  const ago = relativeAgo(now - Date.parse(d.statusChangedAt));

  const save = async () => {
    const changes: D.EditDocInput["changes"] = {};
    if (type !== d.type) changes.type = type;
    if (title.trim() !== d.title) changes.title = title.trim();
    if (status !== d.status) changes.status = status;
    if (note.trim() !== d.note) changes.note = note.trim();
    if (!d.file && url.trim() !== (d.url ?? "")) changes.url = url.trim();
    if (Object.keys(changes).length === 0) return setEditing(false);
    const parsed = D.editDocSchema.safeParse({ base: d.rev, changes });
    if (!parsed.success) return setErr(parsed.error.issues[0]?.message ?? "Check the details.");
    setBusy(true);
    setErr(null);
    try {
      await plApi.editDocument(d.id, parsed.data);
      setEditing(false);
      onChanged();
    } catch (e) {
      setErr(describeError(e));
      if (isApiError(e) && e.code === "DOCUMENT_CONFLICT") onChanged();
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete "${d.title}"? This can't be undone.`)) return;
    setBusy(true);
    setErr(null);
    try {
      await plApi.deleteDocument(d.id);
      onChanged();
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const openFile = async (download: boolean) => {
    setErr(null);
    try {
      if (isPhoto && !download) {
        setViewUrl((await plApi.documentFile(d.id, false)).url);
        return;
      }
      await openVersionFile(() => plApi.documentFile(d.id, download), download);
    } catch (e) {
      setErr(errText(e));
    }
  };

  return (
    <li className="rounded-xl border border-border px-3 py-2.5 min-w-0">
      {viewUrl && (
        <PhotoViewer url={viewUrl} name={d.file?.name ?? d.title} onDownload={() => void openFile(true)} onClose={() => setViewUrl(null)} />
      )}
      <div className="flex items-center gap-2 min-w-0">
        <span className="shrink-0 text-[12px] font-semibold text-ink-3">{D.PIPELINE_DOC_TYPE_LABEL[d.type]}</span>
        <span className="min-w-0 truncate text-[13.5px] font-bold text-ink" title={d.title}>
          {d.title}
        </span>
        <span className={`ml-auto shrink-0 inline-flex items-center h-6 px-2 rounded-full text-[11.5px] font-semibold ${STATUS_TONE[d.status]}`}>
          {D.PIPELINE_DOC_STATUS_LABEL[d.status]}
        </span>
      </div>
      <p className="mt-1 text-[12.5px] text-ink-3">
        {d.source === "chat" && d.status === "draft" ? "Shared in chat" : STATUS_VERB[d.status]} by {d.statusChangedBy.name}
        {ago ? ` · ${ago}` : ""}
      </p>
      {d.note && !editing && <p className="mt-1 text-[13px] text-ink-2 whitespace-pre-line break-words">{d.note}</p>}

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        {d.file ? (
          <>
            <span className="inline-flex items-center gap-1 min-w-0 text-[12.5px] text-ink-3">
              <FileText size={13} aria-hidden />
              <span className="truncate max-w-[180px]" title={d.file.name}>
                {d.file.name}
              </span>
              · {W.formatBytes(d.file.size)}
            </span>
            <button type="button" className="inline-flex items-center gap-1 h-9 text-[13px] font-semibold text-indigo" onClick={() => void openFile(false)}>
              <ExternalLink size={13} aria-hidden /> Open
            </button>
            <button type="button" className="inline-flex items-center gap-1 h-9 text-[13px] font-semibold text-indigo" onClick={() => void openFile(true)}>
              <Download size={13} aria-hidden /> Download
            </button>
          </>
        ) : d.url ? (
          <a
            href={d.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 h-9 min-w-0 text-[13px] font-semibold text-indigo"
            title={d.url}
          >
            <Link2 size={13} aria-hidden />
            <span className="truncate max-w-[220px]">Open on {hostOf(d.url)}</span>
          </a>
        ) : null}
      </div>

      {editing ? (
        <div className="mt-2.5 space-y-2.5">
          <div className="grid grid-cols-2 gap-2">
            <select className={inputCls} value={type} onChange={(e) => setType(e.target.value as D.PipelineDocType)} aria-label="Type">
              {D.PIPELINE_DOC_TYPES.map((t) => (
                <option key={t} value={t}>
                  {D.PIPELINE_DOC_TYPE_LABEL[t]}
                </option>
              ))}
            </select>
            <select className={inputCls} value={status} onChange={(e) => setStatus(e.target.value as D.PipelineDocStatus)} aria-label="Status">
              {D.PIPELINE_DOC_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {D.PIPELINE_DOC_STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
          <input
            className={inputCls}
            value={title}
            maxLength={D.PIPELINE_DOC_LIMITS.titleMax}
            onChange={(e) => setTitle(e.target.value)}
            aria-label="Name"
          />
          {!d.file && (
            <input
              className={inputCls}
              type="url"
              inputMode="url"
              value={url}
              maxLength={W.PIPELINE_WORK_LIMITS.urlMax}
              onChange={(e) => setUrl(e.target.value)}
              aria-label="Link to the document"
            />
          )}
          <textarea
            className={areaCls}
            rows={2}
            placeholder="Note (optional)"
            value={note}
            maxLength={D.PIPELINE_DOC_LIMITS.noteMax}
            onChange={(e) => setNote(e.target.value)}
            aria-label="Note"
          />
          <div className="flex flex-wrap gap-2">
            <button type="button" className={btnPrimary} disabled={busy} onClick={() => void save()}>
              Save
            </button>
            <button type="button" className={btnGhost} disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button type="button" className={`${btn} ml-auto text-danger`} disabled={busy} onClick={() => void remove()}>
              Delete
            </button>
          </div>
        </div>
      ) : (
        !readOnly && (
          <button type="button" className="mt-0.5 h-11 text-[13px] font-semibold text-indigo" onClick={() => setEditing(true)}>
            Update
          </button>
        )
      )}
      <Err text={err} />
    </li>
  );
}
