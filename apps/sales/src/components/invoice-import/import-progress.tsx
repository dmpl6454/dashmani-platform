"use client";
import { useCallback, useState } from "react";
import { useAuth } from "@/lib/auth";
import { isAdminUser } from "@/lib/access";
import { apiFetch } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import type { ImportView } from "@/lib/sales-types";
import { Confirm, Toast } from "@/components/sales-ui";
import { UndoImportDialog } from "./undo-import-dialog";
import { int } from "./shared";

/** Applying (a progress bar), stopped part-way (stale) or failed — with Resume (and, failed, Undo) for an Admin. */
export function ImportProgress({ imp, onChanged, refresh, notify }: { imp: ImportView; onChanged: (v: ImportView) => void; refresh: () => Promise<unknown>; notify: (message: string) => void }) {
  const { user } = useAuth();
  const admin = isAdminUser(user);
  const [toast, setToast] = useState<string | null>(null);
  const clearToast = useCallback(() => setToast(null), []); // stable across the 2-second polls
  const [modal, setModal] = useState<null | "resume" | "undo">(null);
  const done = imp.counts.imported + imp.counts.failed;
  const total = Math.max(1, imp.counts.ready);
  const left = Math.max(0, imp.counts.ready - done);
  const live = imp.summary?.liveSeriesMoves ?? [];
  const warnings = imp.summary?.outcomes.warning ?? 0;
  // Resuming writes GST documents and may move a live series: the Admin confirms it like the first Import.
  const resume = async () => {
    try {
      const r = await apiFetch<ImportView>(`/sales/imports/${imp.id}/apply`, { method: "POST", body: JSON.stringify({ planHash: imp.planHash, acceptWarnings: true, confirmLiveSeries: true }) });
      setModal(null);
      onChanged(r.data);
    } catch (err) { setModal(null); setToast(errorSentence(err)); }
  };
  const resumeBody = (
    <p>
      The remaining {int(left)} invoices are imported with their Swipe numbers, dates and amounts; nothing already imported is created twice.
      {warnings ? ` This includes going ahead despite the ${int(warnings)} warning${warnings === 1 ? "" : "s"} in the check.` : ""}
      {live.length ? ` The live series moves as shown in the check: ${live.map((m) => `${m.label} from ${m.from} to ${m.to}`).join("; ")}.` : ""}
    </p>
  );
  const resumeButton = admin && <button type="button" className="btn" onClick={() => setModal("resume")}>Resume import</button>;
  return (
    <>
      {imp.status === "applying" && !imp.stale && (
        <section className="card p-4 mb-4">
          <div className="flex items-center gap-3">
            <div className="h-2 flex-1 bg-muted"><div className="h-2 bg-indigo" style={{ width: `${Math.min(100, (done / total) * 100)}%` }} /></div>
            <span className="text-sm whitespace-nowrap">{int(done)} / {int(imp.counts.ready)}</span>
          </div>
          <p className="text-sm text-ink-3 mt-2" aria-live="polite">Importing… {int(done)} of {int(imp.counts.ready)} invoices. You can leave this page; it carries on.</p>
        </section>
      )}
      {imp.status === "applying" && imp.stale && (
        <div className="card border-attention p-3 text-sm mb-4 flex flex-wrap gap-3 items-center">
          <span>The import stopped part-way (the server restarted). {int(imp.counts.imported)} invoices are in; the rest are waiting.</span>
          {resumeButton}
        </div>
      )}
      {imp.status === "failed" && (
        <>
          <div className="card border-danger p-3 text-sm mb-4 flex flex-wrap gap-3 items-center" role="alert">
            <span>{imp.lastError ?? "The import stopped."} {int(imp.counts.imported)} of {int(imp.counts.ready)} imported so far — resume to finish them (nothing is created twice).</span>
            {resumeButton}
            {admin && imp.undo?.allowed && <button type="button" className="btn btn-danger" onClick={() => setModal("undo")}>Undo this import</button>}
          </div>
          {admin && imp.undo && !imp.undo.allowed && imp.undo.blockedBy && <div className="card border-border p-3 text-sm mb-4">{imp.undo.blockedBy}</div>}
        </>
      )}
      {modal === "resume" && <Confirm title={`Resume importing the remaining ${int(left)} invoices?`} confirmLabel="Resume import" body={resumeBody} onClose={() => setModal(null)} onConfirm={resume} />}
      {modal === "undo" && <UndoImportDialog imp={imp} onClose={() => setModal(null)} onDone={(message) => { setModal(null); notify(message); void refresh(); }} />}
      {toast && <Toast message={toast} tone="err" onDone={clearToast} />}
    </>
  );
}
