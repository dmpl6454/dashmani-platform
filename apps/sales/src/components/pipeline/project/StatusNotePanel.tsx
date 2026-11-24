"use client";
/**
 * "Current status" (2026-11-23): one line the team keeps up to date ("Client wants revised
 * rates"). It shows in quotes on the board card, so the board says what is going on without
 * opening the project. Anyone who can edit the project can change it; who changed it and when
 * shows under it. Saving an empty line clears it.
 *
 * PUT /pipeline/projects/:id/status-note → the header is upserted with the new note and
 * headerRev, and the board refreshes on its own (the API bumps it).
 */
import { useEffect, useId, useState } from "react";
import { STATUS_NOTE_MAX, relativeAgo, type PipelineHeader } from "@dashmani/shared";
import { usePipeline } from "../provider";
import { describeError, plApi } from "../api";
import { useMinuteClock } from "../ui/Ago";

export function StatusNotePanel({ header, readOnly }: { header: PipelineHeader; readOnly: boolean }) {
  const { store, engine, dirById, meId } = usePipeline();
  const now = useMinuteClock();
  const id = useId();
  const saved = header.statusNote?.text ?? "";
  const [text, setText] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  // Someone else changed it (a sync brought a new header): show theirs unless I'm typing.
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) setText(saved);
  }, [saved, dirty]);

  const save = async () => {
    const next = text.trim();
    if (next === saved) {
      setDirty(false);
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const r = await plApi.setStatusNote(header.id, next);
      store.dispatch({ type: "headerUpsert", header: { ...header, statusNote: r.statusNote, headerRev: r.headerRev } });
      engine.afterWrite();
      setDirty(false);
      setText(r.statusNote?.text ?? "");
      setMsg({ tone: "ok", text: next ? "Saved — it shows on the board card" : "Cleared" });
    } catch (e) {
      setMsg({ tone: "err", text: describeError(e) });
    } finally {
      setBusy(false);
    }
  };

  const note = header.statusNote;
  const by = note?.byId ? (note.byId === meId ? "you" : dirById.get(note.byId)?.name ?? "someone") : null;
  const ago = note?.at ? relativeAgo(now - Date.parse(note.at)) : "";

  return (
    <section aria-label="Current status" className="px-4 pt-4">
      <label htmlFor={id} className="block text-[13px] font-bold uppercase tracking-wide text-ink-3">
        Current status
      </label>
      <div className="mt-1.5 flex gap-2">
        <input
          id={id}
          value={text}
          readOnly={readOnly}
          maxLength={STATUS_NOTE_MAX}
          placeholder="e.g. Client wants revised rates"
          onChange={(e) => {
            setText(e.target.value);
            setDirty(true);
            setMsg(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void save();
            }
          }}
          className="min-w-0 flex-1 h-11 px-3 border-2 border-border bg-surface text-[16px] text-ink focus:outline-none focus:border-indigo read-only:bg-muted/50"
        />
        {!readOnly && (
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy || text.trim() === saved}
            className="h-11 px-4 bg-indigo text-white text-[13px] font-semibold disabled:opacity-40"
          >
            {busy ? "Saving…" : "Save"}
          </button>
        )}
      </div>
      {msg ? (
        <p role={msg.tone === "err" ? "alert" : "status"} className={`mt-1 text-[12.5px] ${msg.tone === "err" ? "text-danger" : "text-success"}`}>
          {msg.text}
        </p>
      ) : note && by ? (
        <p className="mt-1 text-[12.5px] text-ink-3">
          Updated by {by}
          {ago ? ` · ${ago}` : ""}
        </p>
      ) : (
        <p className="mt-1 text-[12.5px] text-ink-4">One line on the board card, so everyone knows where this stands.</p>
      )}
    </section>
  );
}
