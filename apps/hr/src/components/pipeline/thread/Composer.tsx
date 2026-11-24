"use client";
/**
 * The composer (spec §9.6). A 16 px auto-growing textarea (1–6 lines) and a 44 px Send.
 *
 *   - Enter sends only on a real keyboard + mouse (shouldEnterSend); otherwise newline.
 *   - Send is disabled only while the text is empty; any other blocker is shown in words.
 *   - A counter appears above 3,600 characters; over 4,000 is an error; never truncated.
 *   - Mentions are positional ranges; only they serialise to `@{id}` (pasted text never does).
 *   - Drafts persist per project / reply thread under pl:v1:<userId>:draft:…, debounced
 *     500 ms, in tokenised form so a restored draft keeps its mentions.
 *   - Read-only (archived, paused, deleted): the text stays visible and copyable.
 *   - 📎 attaches files (2026-11-23): each uploads straight to R2 and is filed as a project
 *     document (source "chat") BEFORE the message is sent; the message then carries
 *     `#{file:<id>}` tokens (file-tokens.ts). Send waits while any upload is running. Removing a
 *     finished file before sending deletes its (draft) document. Files are not kept in the draft.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Copy, Paperclip, Send, X } from "lucide-react";
import {
  composerLengthState,
  findMentionTrigger,
  insertMention,
  parseDraft,
  serializeDraft,
  shiftRanges,
  shouldEnterSend,
  type MentionRange,
  type PipelineDirectoryEntry,
  pipelineDocs as D,
  pipelineWork as W,
  MAX_FILES_PER_MESSAGE,
  withFileTokens,
} from "@dashmani/shared";
import { plKey, plRead, plRemove, plWrite } from "@/lib/pipeline-storage";
import { usePipeline } from "../provider";
import { filterPeople } from "../project/people-filter";
import { MentionPopover } from "./MentionPopover";
import { describeError, plApi } from "../api";
import { UploadError, putToR2 } from "../upload";

interface PendingFile {
  key: string;
  name: string;
  size: number;
  progress: number;
  docId: string | null;
  error: string | null;
  ctrl: AbortController;
}

const ACCEPT = D.PIPELINE_DOC_UPLOAD_RULE.types.join(",") + ",.pptx,.ppt,.docx,.doc,.xlsx,.xls,.csv,.pdf";

const LINE = 22;
const MAX_LINES = 6;

export function Composer({
  projectId,
  parentId,
  readOnly,
  readOnlyReason,
  participantIds,
  placeholder,
  autoFocus = false,
}: {
  projectId: string;
  parentId: string | null;
  readOnly: boolean;
  readOnlyReason?: string | null;
  participantIds: string[];
  placeholder: string;
  autoFocus?: boolean;
}) {
  const { meId, boot, send, directory, directoryFailed, retryDirectory, dirById } = usePipeline();
  const draftKey = parentId ? plKey(meId, "draft", projectId, parentId) : plKey(meId, "draft", projectId);
  const [text, setText] = useState("");
  const [ranges, setRanges] = useState<MentionRange[]>([]);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const listboxId = useId();
  const restored = useRef(false);
  const [files, setFiles] = useState<PendingFile[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploading = files.some((f) => !f.docId && !f.error);
  const readyIds = files.filter((f) => f.docId).map((f) => f.docId!);

  const patchFile = (key: string, change: Partial<PendingFile>) =>
    setFiles((cur) => cur.map((f) => (f.key === key ? { ...f, ...change } : f)));

  const uploadOne = async (file: File, pf: PendingFile) => {
    try {
      const ticket = await plApi.startAttachmentUpload(projectId, {
        fileName: file.name.slice(0, D.PIPELINE_DOC_LIMITS.fileNameMax),
        contentType: D.docFileType(file),
        size: file.size,
      });
      await putToR2(ticket, file, (p) => patchFile(pf.key, { progress: p }), pf.ctrl.signal);
      const doc = await plApi.addAttachment(projectId, { fileKey: ticket.key, fileName: file.name.slice(0, D.PIPELINE_DOC_LIMITS.fileNameMax) });
      patchFile(pf.key, { docId: doc.id, progress: 1 });
    } catch (e) {
      if (pf.ctrl.signal.aborted) return;
      patchFile(pf.key, { error: e instanceof UploadError ? e.message : describeError(e) });
    }
  };

  const addFiles = (list: FileList | null) => {
    if (!list || readOnly) return;
    const room = MAX_FILES_PER_MESSAGE - files.length;
    const picked = Array.from(list).slice(0, Math.max(0, room));
    if (list.length > picked.length) setError(`You can attach up to ${MAX_FILES_PER_MESSAGE} files to one message.`);
    for (const file of picked) {
      const pf: PendingFile = {
        key: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: file.name,
        size: file.size,
        progress: 0,
        docId: null,
        error: D.checkDocFile(file),
        ctrl: new AbortController(),
      };
      setFiles((cur) => [...cur, pf]);
      if (!pf.error) void uploadOne(file, pf);
    }
    if (fileInput.current) fileInput.current.value = "";
  };

  const removeFile = (f: PendingFile) => {
    f.ctrl.abort();
    setFiles((cur) => cur.filter((x) => x.key !== f.key));
    // Filed already but never sent: its draft document goes too.
    if (f.docId) void plApi.deleteDocument(f.docId).catch(() => {});
  };

  // Leaving the page mid-upload loses the upload: say so.
  useEffect(() => {
    if (!uploading) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [uploading]);

  // Restore the draft once names can be resolved (the directory loaded or failed).
  useEffect(() => {
    if (restored.current || (directory === undefined && !directoryFailed)) return;
    restored.current = true;
    const stored = plRead(draftKey);
    if (!stored) return;
    const p = parseDraft(stored, (id) => dirById.get(id)?.name ?? "former member");
    setText(p.text);
    setRanges(p.ranges);
  }, [directory, directoryFailed, dirById, draftKey]);

  // Debounced draft save (500 ms), in tokenised form.
  useEffect(() => {
    if (!restored.current) return;
    const t = setTimeout(() => {
      if (text.trim()) plWrite(draftKey, serializeDraft(text, ranges));
      else plRemove(draftKey);
    }, 500);
    return () => clearTimeout(t);
  }, [text, ranges, draftKey]);

  // Auto-grow 1–6 lines.
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, LINE * MAX_LINES + 20)}px`;
  }, [text]);

  useEffect(() => {
    if (autoFocus && !readOnly) ta.current?.focus();
  }, [autoFocus, readOnly]);

  const trigger = useMemo(() => {
    if (readOnly) return null;
    const t = findMentionTrigger(text, caret, ranges);
    return t && t.start !== dismissedAt ? t : null;
  }, [text, caret, ranges, dismissedAt, readOnly]);
  const prefer = useMemo(() => new Set(participantIds), [participantIds]);
  const options = useMemo(
    () => (trigger && directory ? filterPeople(directory, trigger.query, { prefer, exclude: new Set([meId]), limit: 6 }) : []),
    [trigger, directory, prefer, meId],
  );
  const popoverOpen = !!trigger;
  useEffect(() => setActive(0), [trigger?.start, trigger?.query]);

  const body = withFileTokens(serializeDraft(text, ranges), readyIds);
  const lenState = composerLengthState(body.length, boot.limits);

  const pick = (d: PipelineDirectoryEntry) => {
    if (!trigger) return;
    const r = insertMention(text, ranges, trigger, caret, d);
    setText(r.text);
    setRanges(r.ranges);
    setCaret(r.caret);
    requestAnimationFrame(() => {
      const el = ta.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(r.caret, r.caret);
    });
  };

  const submit = () => {
    if (readOnly) return;
    if (uploading) {
      setError("Wait for the files to finish uploading.");
      return;
    }
    if (!text.trim() && readyIds.length === 0) return;
    if (lenState === "over") {
      setError(`That's ${body.length - boot.limits.bodyMax} characters over the ${boot.limits.bodyMax.toLocaleString()} limit — shorten it to send.`);
      return;
    }
    send({ projectId, parentId, body });
    setFiles([]);
    setText("");
    setRanges([]);
    setCaret(0);
    setError(null);
    plRemove(draftKey);
    ta.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (popoverOpen && directory) {
      if (e.key === "ArrowDown" && options.length) {
        e.preventDefault();
        setActive((a) => (a + 1) % options.length);
        return;
      }
      if (e.key === "ArrowUp" && options.length) {
        e.preventDefault();
        setActive((a) => (a - 1 + options.length) % options.length);
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && options[active] && !e.nativeEvent.isComposing) {
        e.preventDefault();
        pick(options[active]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setDismissedAt(trigger!.start);
        return;
      }
    }
    if (e.key === "Enter") {
      const env = {
        finePointer: typeof window !== "undefined" && window.matchMedia("(pointer: fine)").matches,
        maxTouchPoints: typeof navigator !== "undefined" ? navigator.maxTouchPoints || 0 : 1,
      };
      if (shouldEnterSend({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode }, env)) {
        e.preventDefault();
        submit();
      }
    }
  };

  const syncCaret = () => setCaret(ta.current?.selectionStart ?? 0);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      ta.current?.select();
    }
  };

  return (
    <div className="shrink-0 border-t border-rule bg-surface px-3 py-2" style={{ paddingBottom: "max(8px, env(safe-area-inset-bottom))" }}>
      {readOnly && readOnlyReason && (
        // The page banner is the live region; this repeat by the composer is visual only.
        <p className="mb-1.5 text-[12.5px] text-ink-3">
          {readOnlyReason}
        </p>
      )}
      {error && (
        <p className="mb-1.5 text-[12.5px] text-danger" role="alert">
          {error}
        </p>
      )}
      {files.length > 0 && (
        <ul className="mb-1.5 flex flex-wrap gap-1.5" aria-label="Files to send">
          {files.map((f) => (
            <li key={f.key} className={`flex min-w-0 max-w-full items-center gap-2 border px-2 py-1 text-[12.5px] ${f.error ? "border-danger text-danger" : "border-border text-ink-2"}`}>
              <Paperclip size={12} aria-hidden className="shrink-0" />
              <span className="truncate max-w-[12rem]" title={f.name}>{f.name}</span>
              <span className="shrink-0 tabular-nums text-ink-4">
                {f.error ? "" : f.docId ? W.formatBytes(f.size) : `${Math.round(f.progress * 100)}%`}
              </span>
              {f.error && <span className="min-w-0 truncate" title={f.error}>{f.error}</span>}
              <button type="button" onClick={() => removeFile(f)} aria-label={`Remove ${f.name}`} className="h-7 w-7 shrink-0 grid place-items-center text-ink-3 hover:text-ink">
                <X size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-end gap-2">
        {!readOnly && (
          <>
            <input
              ref={fileInput}
              type="file"
              multiple
              accept={ACCEPT}
              className="hidden"
              onChange={(e) => addFiles(e.target.files)}
              aria-hidden
              tabIndex={-1}
            />
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              disabled={files.length >= MAX_FILES_PER_MESSAGE}
              aria-label="Attach files"
              title="Attach photos or documents"
              className="h-11 w-11 shrink-0 grid place-items-center text-ink-3 hover:text-ink disabled:opacity-40"
            >
              <Paperclip size={18} />
            </button>
          </>
        )}
        <textarea
          ref={ta}
          value={text}
          readOnly={readOnly}
          rows={1}
          aria-label={placeholder}
          placeholder={placeholder}
          role="combobox"
          aria-expanded={popoverOpen}
          aria-controls={popoverOpen ? listboxId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={popoverOpen && options[active] ? `${listboxId}-${active}` : undefined}
          onChange={(e) => {
            const next = e.target.value;
            setRanges((r) => shiftRanges(r, text, next));
            setText(next);
            setCaret(e.target.selectionStart ?? next.length);
            setError(null);
            if (dismissedAt !== null && findMentionTrigger(next, e.target.selectionStart ?? 0, [])?.start !== dismissedAt) setDismissedAt(null);
          }}
          onKeyDown={onKeyDown}
          onKeyUp={syncCaret}
          onClick={syncCaret}
          onSelect={syncCaret}
          className="min-w-0 flex-1 resize-none rounded-xl border border-border bg-bg px-3 py-2.5 text-[16px] leading-[22px] text-ink placeholder:text-ink-4 focus:outline-none focus:ring-2 focus:ring-indigo read-only:opacity-80"
        />
        {readOnly ? (
          <button type="button" onClick={() => void copy()} disabled={!text} aria-label="Copy your text" className="h-11 w-11 grid place-items-center rounded-xl border border-border text-ink-2 disabled:opacity-40">
            <Copy size={16} />
          </button>
        ) : (
          <button type="button" onClick={submit} disabled={uploading || (!text.trim() && readyIds.length === 0)} aria-label={uploading ? "Send (waiting for uploads)" : "Send"} className="h-11 w-11 grid place-items-center rounded-xl bg-ink text-white disabled:opacity-40">
            <Send size={16} />
          </button>
        )}
      </div>
      {lenState !== "ok" && (
        <p className={`mt-1 text-right text-[11.5px] tabular-nums ${lenState === "over" ? "text-danger font-semibold" : "text-ink-4"}`}>
          {body.length.toLocaleString()} / {boot.limits.bodyMax.toLocaleString()}
        </p>
      )}
      {popoverOpen && (
        <MentionPopover
          anchor={ta.current}
          listboxId={listboxId}
          options={options}
          active={active}
          failed={directoryFailed}
          loading={!directory && !directoryFailed}
          onPick={pick}
          onRetry={retryDirectory}
          onHover={setActive}
        />
      )}
    </div>
  );
}
