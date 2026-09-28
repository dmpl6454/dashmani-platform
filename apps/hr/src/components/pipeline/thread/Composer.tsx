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
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Copy, Send } from "lucide-react";
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
} from "@dashmani/shared";
import { plKey, plRead, plRemove, plWrite } from "@/lib/pipeline-storage";
import { usePipeline } from "../provider";
import { filterPeople } from "../project/people-filter";
import { MentionPopover } from "./MentionPopover";

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

  const body = serializeDraft(text, ranges);
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
    if (!text.trim()) return;
    if (lenState === "over") {
      setError(`That's ${body.length - boot.limits.bodyMax} characters over the ${boot.limits.bodyMax.toLocaleString()} limit — shorten it to send.`);
      return;
    }
    send({ projectId, parentId, body });
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
        <p className="mb-1.5 text-[12.5px] text-ink-3" role="status">
          {readOnlyReason}
        </p>
      )}
      {error && (
        <p className="mb-1.5 text-[12.5px] text-danger" role="alert">
          {error}
        </p>
      )}
      <div className="flex items-end gap-2">
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
          <button type="button" onClick={submit} disabled={!text.trim()} aria-label="Send" className="h-11 w-11 grid place-items-center rounded-xl bg-ink text-white disabled:opacity-40">
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
