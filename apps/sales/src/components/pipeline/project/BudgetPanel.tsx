"use client";
/**
 * The project's budget on the project page (2026-11-26, owner ask): everyone who can open the
 * project sees it, only the person who CREATED the project can set or change it (the API refuses
 * anyone else with 403 BUDGET_CREATOR_ONLY). Whole rupees; saved through the ordinary field edit
 * with its base value, so a concurrent change is a 409 conflict rather than a silent overwrite.
 */
import { useState } from "react";
import type { PipelineHeader } from "@dashmani/shared";
import { fmtInr } from "@/lib/format";
import { usePipeline } from "../provider";
import { describeError, isApiError, plApi } from "../api";
import { BudgetInput, parseBudget } from "./BudgetInput";

export function BudgetPanel({ header, readOnly }: { header: PipelineHeader; readOnly: boolean }) {
  const { store, engine, meId } = usePipeline();
  const current = header.budget ?? null;
  const mine = header.createdById === meId;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const save = async (next: number | null) => {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await plApi.editProject(header.id, { changes: { budget: next }, base: { budget: current } });
      store.dispatch({ type: "headerUpsert", header: r.header });
      engine.afterWrite();
      setEditing(false);
    } catch (e) {
      setMsg(
        isApiError(e) && e.code === "EDIT_CONFLICT"
          ? "The budget was just changed — reload the project to see it."
          : describeError(e),
      );
    } finally {
      setBusy(false);
    }
  };

  const parsed = parseBudget(value);
  return (
    <section aria-label="Budget" className="px-4 pb-4 space-y-2">
      {!editing ? (
        <div className="flex items-center gap-2 text-[13px] min-w-0">
          <span className="text-ink-4">Budget</span>
          {current != null ? (
            <span className="font-semibold text-ink tabular-nums">{fmtInr(current * 100, { whole: true })}</span>
          ) : (
            <span className="text-ink-3">Not set</span>
          )}
          {!readOnly && mine && (
            <button
              type="button"
              onClick={() => {
                setValue(current != null ? String(current) : "");
                setEditing(true);
                setMsg(null);
              }}
              className="ml-auto h-9 px-3 rounded-lg text-[12.5px] font-semibold text-ink-2 hover:bg-muted shrink-0"
            >
              {current != null ? "Change" : "Add budget"}
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <BudgetInput value={value} onChange={setValue} disabled={busy} autoFocus />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy || !parsed.ok || parsed.value === current}
              onClick={() => parsed.ok && void save(parsed.value)}
              className="h-10 px-4 rounded-xl bg-indigo text-white text-[13px] font-semibold disabled:opacity-60"
            >
              {busy ? "Saving…" : "Save"}
            </button>
            <button type="button" onClick={() => setEditing(false)} className="h-10 px-4 rounded-xl text-[13px] font-semibold text-ink-2 hover:bg-muted">
              Cancel
            </button>
          </div>
        </div>
      )}
      {!editing && !readOnly && !mine && current == null && (
        <p className="text-[12px] text-ink-4">Only the person who created this project can add its budget.</p>
      )}
      {msg && (
        <p role="alert" className="text-[12.5px] text-danger">
          {msg}
        </p>
      )}
    </section>
  );
}
