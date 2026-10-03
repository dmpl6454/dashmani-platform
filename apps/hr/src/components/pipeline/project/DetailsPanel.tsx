"use client";
/**
 * Project details with an explicit Save (route #7, spec §9.4). The request carries the
 * values the user started from (`base`); a 409 EDIT_CONFLICT opens a sheet with both
 * versions — "Keep theirs" / "Overwrite" — and the user's text is never lost.
 *
 * Dates (2026-10-01): inputs are bounded to the years the server accepts (1900–2999) and are
 * checked with the SAME validator before the order check — a 5-digit year compared as a
 * string used to report the wrong problem. Read-only (archived) date inputs are `disabled`,
 * not only readOnly: some mobile browsers still open the picker on a readonly date field.
 */
import { useEffect, useId, useMemo, useState } from "react";
import {
  PIPELINE_LIMITS,
  dayMonthShort,
  pipelineValidators,
  type PipelineEditableFields,
  type PipelineHeader,
} from "@dashmani/shared";
import { usePipeline, usePhases } from "../provider";
import { Sheet } from "../ui/Sheet";
import { describeError, isApiError, isRateLimited, plApi, retryAfterMs } from "../api";
import { useLocalDayKey } from "../hooks/use-local-day-key";

type Form = { title: string; description: string; startDate: string; dueDate: string };
const KEYS: Array<keyof Form> = ["title", "description", "startDate", "dueDate"];
const LABEL: Record<keyof Form, string> = { title: "Title", description: "Description", startDate: "Start", dueDate: "Due" };
const DATE_KEYS = ["startDate", "dueDate"] as const;
/** The years the server's pipelineDate accepts (validators/pipeline.ts). */
const DATE_MIN = "1900-01-01";
const DATE_MAX = "2999-12-31";

/** A filled date field that the shared validator rejects (an empty field clears the date). */
const badDate = (v: string) => v !== "" && !pipelineValidators.pipelineDate.safeParse(v).success;

function fromHeader(h: PipelineHeader): Form {
  return { title: h.title, description: h.description ?? "", startDate: h.startDate ?? "", dueDate: h.dueDate ?? "" };
}

function toWire(f: Partial<Form>): PipelineEditableFields {
  const out: PipelineEditableFields = {};
  if (f.title !== undefined) out.title = f.title;
  if (f.description !== undefined) out.description = f.description;
  if (f.startDate !== undefined) out.startDate = f.startDate || null;
  if (f.dueDate !== undefined) out.dueDate = f.dueDate || null;
  return out;
}

const inputCls =
  "w-full h-11 px-3 rounded-xl border border-border bg-surface text-[16px] text-ink focus:outline-none focus:ring-2 focus:ring-indigo read-only:bg-muted/50";

export function DetailsPanel({ header, readOnly }: { header: PipelineHeader; readOnly: boolean }) {
  const { store, engine, dirById } = usePipeline();
  const phases = usePhases();
  const today = useLocalDayKey();
  const ids = { title: useId(), desc: useId(), start: useId(), due: useId() };
  const [base, setBase] = useState<Form>(() => fromHeader(header));
  const [form, setForm] = useState<Form>(() => fromHeader(header));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [conflict, setConflict] = useState<PipelineHeader | null>(null);

  const changed = useMemo(() => KEYS.filter((k) => form[k] !== base[k]), [form, base]);
  // Follow the server while the user has no unsaved edits.
  useEffect(() => {
    if (changed.length === 0) {
      const f = fromHeader(header);
      setBase(f);
      setForm(f);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [header.headerRev, header.title, header.description, header.startDate, header.dueDate]);

  const save = async (withBase: Form, tries = 0): Promise<void> => {
    const keys = KEYS.filter((k) => form[k] !== withBase[k]);
    if (keys.length === 0) return;
    if (!form.title.trim()) {
      setMsg({ tone: "err", text: "The title can't be empty." });
      return;
    }
    const bad = DATE_KEYS.find((k) => badDate(form[k]));
    if (bad) {
      setMsg({ tone: "err", text: `The ${LABEL[bad].toLowerCase()} date isn't valid — pick a date between 1900 and 2999.` });
      return;
    }
    if (form.startDate && form.dueDate && form.startDate > form.dueDate) {
      setMsg({ tone: "err", text: "The start date must be on or before the due date." });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const changes: Partial<Form> = {};
      const b: Partial<Form> = {};
      for (const k of keys) {
        changes[k] = form[k];
        b[k] = withBase[k];
      }
      const r = await plApi.editProject(header.id, { changes: toWire(changes), base: toWire(b) });
      store.dispatch({ type: "headerUpsert", header: r.header });
      engine.afterWrite();
      const f = fromHeader(r.header);
      setBase(f);
      setForm(f);
      setMsg({ tone: "ok", text: "Saved" });
    } catch (e) {
      if (isApiError(e) && e.code === "EDIT_CONFLICT" && e.current && typeof e.current === "object") {
        setConflict(e.current as PipelineHeader);
      } else if (isRateLimited(e) && tries < 2) {
        await new Promise((res) => setTimeout(res, retryAfterMs(e)));
        return save(withBase, tries + 1);
      } else if (isApiError(e) && (e.status === 0 || (e.status ?? 0) >= 500)) {
        setMsg({ tone: "err", text: "Not saved — check your connection and press Save again." });
      } else {
        setMsg({ tone: "err", text: describeError(e) });
      }
    } finally {
      setBusy(false);
    }
  };

  const phase = phases.find((p) => p.id === header.phaseId);
  const owner = dirById.get(header.ownerId);
  /** A field's value as the conflict sheet shows it: dates as "9 Oct" like every other surface (H10). */
  const shown = (k: keyof Form, v: string) =>
    !v ? "—" : (DATE_KEYS as readonly string[]).includes(k) ? dayMonthShort(v, today) : v;

  return (
    <section aria-label="Details" className="p-4 space-y-4">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
        <dt className="text-ink-4">Phase</dt>
        <dd className="min-w-0 truncate text-ink">{phase?.name ?? "—"}</dd>
        <dt className="text-ink-4">Owner</dt>
        <dd className="pl-name min-w-0 truncate text-ink">
          {owner?.name ?? "Former member"}
          {owner && !owner.active && <span className="text-ink-4"> · inactive</span>}
        </dd>
        {header.dueDate && (
          <>
            <dt className="text-ink-4">Due</dt>
            <dd className="text-ink">{dayMonthShort(header.dueDate, today)}</dd>
          </>
        )}
      </dl>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save(base);
        }}
        className="space-y-3"
        noValidate
      >
        <div>
          <label htmlFor={ids.title} className="block text-[12.5px] font-semibold text-ink-2 mb-1">
            Title
          </label>
          <input id={ids.title} value={form.title} readOnly={readOnly} maxLength={PIPELINE_LIMITS.titleMax} onChange={(e) => setForm({ ...form, title: e.target.value })} className={inputCls} />
        </div>
        <div>
          <label htmlFor={ids.desc} className="block text-[12.5px] font-semibold text-ink-2 mb-1">
            Description
          </label>
          <textarea
            id={ids.desc}
            value={form.description}
            readOnly={readOnly}
            maxLength={PIPELINE_LIMITS.descriptionMax}
            rows={4}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            className="w-full px-3 py-2 rounded-xl border border-border bg-surface text-[16px] text-ink focus:outline-none focus:ring-2 focus:ring-indigo whitespace-pre-wrap read-only:bg-muted/50"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="min-w-0">
            <label htmlFor={ids.start} className="block text-[12.5px] font-semibold text-ink-2 mb-1">
              Start
            </label>
            <input
              id={ids.start}
              type="date"
              min={DATE_MIN}
              max={DATE_MAX}
              value={form.startDate}
              readOnly={readOnly}
              disabled={readOnly}
              onChange={(e) => setForm({ ...form, startDate: e.target.value })}
              className={`${inputCls} pl-date`}
            />
          </div>
          <div className="min-w-0">
            <label htmlFor={ids.due} className="block text-[12.5px] font-semibold text-ink-2 mb-1">
              Due
            </label>
            <input
              id={ids.due}
              type="date"
              min={DATE_MIN}
              max={DATE_MAX}
              value={form.dueDate}
              readOnly={readOnly}
              disabled={readOnly}
              onChange={(e) => setForm({ ...form, dueDate: e.target.value })}
              className={`${inputCls} pl-date`}
            />
          </div>
        </div>
        {!readOnly && (
          <div className="flex items-center gap-2">
            {msg && (
              <p role={msg.tone === "err" ? "alert" : "status"} className={`min-w-0 flex-1 text-[12.5px] ${msg.tone === "err" ? "text-danger" : "text-success"}`}>
                {msg.text}
              </p>
            )}
            <button type="submit" disabled={busy || changed.length === 0} className="ml-auto h-11 px-5 rounded-xl bg-ink text-white text-[14px] font-semibold disabled:opacity-40">
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        )}
      </form>

      <Sheet
        open={!!conflict}
        onClose={() => setConflict(null)}
        title="Someone else changed this"
        wide
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                if (!conflict) return;
                const f = fromHeader(conflict);
                store.dispatch({ type: "headerUpsert", header: conflict });
                setBase(f);
                setForm(f);
                setConflict(null);
              }}
              className="h-11 px-4 rounded-xl border border-border text-[14px] font-semibold"
            >
              Keep theirs
            </button>
            <button
              type="button"
              onClick={() => {
                if (!conflict) return;
                const theirs = fromHeader(conflict);
                setConflict(null);
                setBase(theirs);
                void save(theirs);
              }}
              className="h-11 px-4 rounded-xl bg-ink text-white text-[14px] font-semibold"
            >
              Overwrite with mine
            </button>
          </div>
        }
      >
        {conflict && (
          <div className="space-y-3">
            {changed.map((k) => (
              <div key={k} className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div className="min-w-0 rounded-xl bg-muted p-3">
                  <p className="text-[11.5px] font-bold text-ink-3 mb-1">{LABEL[k]} — theirs</p>
                  <p className="text-[13.5px] text-ink whitespace-pre-wrap [overflow-wrap:anywhere]">{shown(k, fromHeader(conflict)[k])}</p>
                </div>
                <div className="min-w-0 rounded-xl bg-indigo-soft p-3">
                  <p className="text-[11.5px] font-bold text-ink-3 mb-1">{LABEL[k]} — yours</p>
                  <p className="text-[13.5px] text-ink whitespace-pre-wrap [overflow-wrap:anywhere]">{shown(k, form[k])}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </Sheet>
    </section>
  );
}
