"use client";
/**
 * The client a project is for, on the project page: shown with a link to the client's page,
 * changed or cleared through the ordinary field edit (`linkedClientId`, with its base value,
 * so a concurrent change by someone else is a 409 conflict rather than a silent overwrite).
 */
import { useState } from "react";
import Link from "next/link";
import type { PipelineHeader } from "@dashmani/shared";
import { usePipeline } from "../provider";
import { describeError, isApiError, plApi } from "../api";
import { ClientPicker } from "./ClientPicker";

export function ClientLinkPanel({ header, readOnly }: { header: PipelineHeader; readOnly: boolean }) {
  const { store, engine } = usePipeline();
  const current = header.linkedClient ?? null;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState<string | null>(current?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const save = async (next: string | null) => {
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await plApi.editProject(header.id, {
        changes: { linkedClientId: next },
        base: { linkedClientId: current?.id ?? null },
      });
      store.dispatch({ type: "headerUpsert", header: r.header });
      engine.afterWrite();
      setEditing(false);
    } catch (e) {
      setMsg(
        isApiError(e) && e.code === "EDIT_CONFLICT"
          ? "Someone else just changed the client — reload the project to see it."
          : describeError(e),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Client" className="px-4 pb-4 space-y-2">
      {!editing ? (
        <div className="flex items-center gap-2 text-[13px] min-w-0">
          <span className="text-ink-4">Client</span>
          {current ? (
            <Link href={`/clients/view?id=${current.id}`} className="min-w-0 truncate font-semibold text-indigo-light hover:underline">
              {current.companyName || "Client"}
            </Link>
          ) : (
            <span className="text-ink-3">None</span>
          )}
          {!readOnly && (
            <span className="ml-auto flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={() => {
                  setValue(current?.id ?? null);
                  setEditing(true);
                  setMsg(null);
                }}
                className="h-9 px-3 rounded-lg text-[12.5px] font-semibold text-ink-2 hover:bg-muted"
              >
                {current ? "Change" : "Add client"}
              </button>
              {current && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void save(null)}
                  className="h-9 px-3 rounded-lg text-[12.5px] font-semibold text-ink-3 hover:bg-muted disabled:opacity-60"
                >
                  Clear
                </button>
              )}
            </span>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <ClientPicker value={value} onChange={setValue} currentName={current?.companyName} disabled={busy} />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy || value === (current?.id ?? null)}
              onClick={() => void save(value)}
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
      {msg && (
        <p role="alert" className="text-[12.5px] text-danger">
          {msg}
        </p>
      )}
    </section>
  );
}
