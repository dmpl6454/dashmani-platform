"use client";
/**
 * Create a project (route #5). The idempotency key (clientId) is minted when the sheet
 * opens and kept across retries, so a double tap or a retry after a lost response never
 * creates two projects. Nothing the user typed is lost on any error.
 *
 * Dates (2026-10-01): bounded to the years the server accepts (1900–2999) and checked with the
 * SAME validator before the start ≤ due check, which compares strings and is only right for
 * 4-digit years; each date's own error is shown under its own field.
 */
import { useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { makeClientId, PIPELINE_LIMITS, pipelineValidators, type PipelinePhase } from "@dashmani/shared";
import { Sheet } from "../ui/Sheet";
import { useToast } from "../ui/Toast";
import { usePipeline } from "../provider";
import { PeoplePicker } from "../project/PeoplePicker";
import { describeError, isApiError, plApi } from "../api";

const inputCls =
  "w-full h-11 px-3 rounded-xl border border-border bg-surface text-[16px] text-ink placeholder:text-ink-4 focus:outline-none focus:ring-2 focus:ring-indigo";

/** The years the server's pipelineDate accepts (validators/pipeline.ts). */
const DATE_MIN = "1900-01-01";
const DATE_MAX = "2999-12-31";
const DATE_INVALID = "Pick a valid date between 1900 and 2999.";
/** A filled date the shared validator rejects (empty = no date). */
const badDate = (v: string) => v !== "" && !pipelineValidators.pipelineDate.safeParse(v).success;

export function NewProjectSheet({
  open,
  onClose,
  phases,
  defaultPhaseId,
}: {
  open: boolean;
  onClose: () => void;
  phases: PipelinePhase[];
  defaultPhaseId: string | null;
}) {
  const { store, engine, meId } = usePipeline();
  const toast = useToast();
  const router = useRouter();
  const ids = { title: useId(), desc: useId(), phase: useId(), start: useId(), due: useId() };
  const [clientId, setClientId] = useState(makeClientId);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [phaseId, setPhaseId] = useState<string>(defaultPhaseId ?? phases[0]?.id ?? "");
  const [startDate, setStart] = useState("");
  const [dueDate, setDue] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({});

  useEffect(() => {
    if (open && defaultPhaseId) setPhaseId(defaultPhaseId);
  }, [open, defaultPhaseId]);

  const reset = () => {
    setClientId(makeClientId());
    setTitle("");
    setDescription("");
    setStart("");
    setDue("");
    setMembers([]);
    setError(null);
    setFieldErr({});
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const fe: Record<string, string> = {};
    if (!title.trim()) fe.title = "Give the project a title.";
    if (badDate(startDate)) fe.startDate = DATE_INVALID;
    if (badDate(dueDate)) fe.dueDate = DATE_INVALID;
    if (!fe.startDate && !fe.dueDate && startDate && dueDate && startDate > dueDate) {
      fe.dueDate = "The due date must be on or after the start date.";
    }
    setFieldErr(fe);
    if (Object.keys(fe).length) return;
    setBusy(true);
    setError(null);
    try {
      const r = await plApi.createProject({
        clientId,
        title: title.trim(),
        ...(description.trim() ? { description } : {}),
        ...(phaseId ? { phaseId } : {}),
        ...(startDate ? { startDate } : {}),
        ...(dueDate ? { dueDate } : {}),
        ...(members.length ? { memberIds: members.filter((m) => m !== meId) } : {}),
      });
      store.dispatch({ type: "cardUpsert", card: r.card });
      engine.afterWrite();
      const id = r.card.id;
      const name = r.card.title;
      reset();
      onClose();
      toast.show({ text: `Created “${name}”`, actions: [{ label: "Open", onClick: () => router.push(`/pipeline/${id}`) }] });
    } catch (err) {
      if (isApiError(err) && err.details?.length) {
        const f: Record<string, string> = {};
        for (const d of err.details) f[d.field.split(".")[0]] = d.message;
        setFieldErr(f);
      }
      setError(
        isApiError(err) && (err.status === 0 || (err.status ?? 0) >= 500)
          ? "Couldn't create the project — your text is kept. Try again; it won't create twice."
          : describeError(err),
      );
    } finally {
      setBusy(false);
    }
  };

  const titleLeft = PIPELINE_LIMITS.titleMax - title.length;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="New project"
      footer={
        <div className="flex items-center gap-2">
          {error && (
            <p role="alert" className="min-w-0 flex-1 text-[12.5px] text-danger">
              {error}
            </p>
          )}
          <button
            type="submit"
            form="pl-new-project"
            disabled={busy}
            className="ml-auto h-11 px-5 rounded-xl bg-ink text-white text-[14px] font-semibold disabled:opacity-60"
          >
            {busy ? "Creating…" : "Create project"}
          </button>
        </div>
      }
    >
      <form id="pl-new-project" onSubmit={submit} className="space-y-4" noValidate>
        <div>
          <label htmlFor={ids.title} className="block text-[12.5px] font-semibold text-ink-2 mb-1.5">
            Title
          </label>
          <input
            id={ids.title}
            data-autofocus
            value={title}
            maxLength={PIPELINE_LIMITS.titleMax}
            onChange={(e) => setTitle(e.target.value)}
            aria-invalid={!!fieldErr.title}
            aria-describedby={fieldErr.title ? `${ids.title}-err` : undefined}
            className={inputCls}
            placeholder="e.g. Diwali campaign"
          />
          <div className="flex justify-between mt-1 text-[12px]">
            <span id={`${ids.title}-err`} className="text-danger">
              {fieldErr.title}
            </span>
            {titleLeft <= 20 && <span className="text-ink-4">{titleLeft} left</span>}
          </div>
        </div>
        <div>
          <label htmlFor={ids.desc} className="block text-[12.5px] font-semibold text-ink-2 mb-1.5">
            Description <span className="text-ink-4 font-medium">(optional)</span>
          </label>
          <textarea
            id={ids.desc}
            value={description}
            maxLength={PIPELINE_LIMITS.descriptionMax}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="w-full px-3 py-2 rounded-xl border border-border bg-surface text-[16px] text-ink focus:outline-none focus:ring-2 focus:ring-indigo"
          />
          {fieldErr.description && <p className="mt-1 text-[12px] text-danger">{fieldErr.description}</p>}
        </div>
        <div>
          <label htmlFor={ids.phase} className="block text-[12.5px] font-semibold text-ink-2 mb-1.5">
            Phase
          </label>
          <select id={ids.phase} value={phaseId} onChange={(e) => setPhaseId(e.target.value)} className={`${inputCls} max-w-full`}>
            {phases.map((ph) => (
              <option key={ph.id} value={ph.id}>
                {ph.name}
              </option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="min-w-0">
            <label htmlFor={ids.start} className="block text-[12.5px] font-semibold text-ink-2 mb-1.5">
              Start
            </label>
            <input
              id={ids.start}
              type="date"
              min={DATE_MIN}
              max={DATE_MAX}
              value={startDate}
              onChange={(e) => setStart(e.target.value)}
              aria-invalid={!!fieldErr.startDate}
              aria-describedby={fieldErr.startDate ? `${ids.start}-err` : undefined}
              className={`${inputCls} pl-date`}
            />
          </div>
          <div className="min-w-0">
            <label htmlFor={ids.due} className="block text-[12.5px] font-semibold text-ink-2 mb-1.5">
              Due
            </label>
            <input
              id={ids.due}
              type="date"
              min={DATE_MIN}
              max={DATE_MAX}
              value={dueDate}
              onChange={(e) => setDue(e.target.value)}
              aria-invalid={!!fieldErr.dueDate}
              aria-describedby={fieldErr.dueDate ? `${ids.due}-err` : undefined}
              className={`${inputCls} pl-date`}
            />
          </div>
        </div>
        {fieldErr.startDate && (
          <p id={`${ids.start}-err`} className="-mt-2 text-[12px] text-danger">
            Start: {fieldErr.startDate}
          </p>
        )}
        {fieldErr.dueDate && (
          <p id={`${ids.due}-err`} className="-mt-2 text-[12px] text-danger">
            {fieldErr.startDate ? "Due: " : ""}
            {fieldErr.dueDate}
          </p>
        )}
        <PeoplePicker value={members} onChange={setMembers} exclude={[meId]} max={PIPELINE_LIMITS.membersPerRequestMax} label="Members" />
      </form>
    </Sheet>
  );
}
