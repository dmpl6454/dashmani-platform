"use client";
import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { isAdminUser } from "@/lib/access";
import { apiFetch } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import type { ImportView } from "@/lib/sales-types";
import { Toast } from "@/components/sales-ui";
import { int } from "./shared";

/** Applying (a progress bar), stopped part-way (stale) or failed — with Resume for an Admin. */
export function ImportProgress({ imp, onChanged }: { imp: ImportView; onChanged: (v: ImportView) => void }) {
  const { user } = useAuth();
  const admin = isAdminUser(user);
  const [toast, setToast] = useState<string | null>(null);
  const done = imp.counts.imported + imp.counts.failed;
  const total = Math.max(1, imp.counts.ready);
  const resume = async () => {
    try {
      const r = await apiFetch<ImportView>(`/sales/imports/${imp.id}/apply`, { method: "POST", body: JSON.stringify({ planHash: imp.planHash, acceptWarnings: true, confirmLiveSeries: true }) });
      onChanged(r.data);
    } catch (err) { setToast(errorSentence(err)); }
  };
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
          {admin && <button type="button" className="btn" onClick={resume}>Resume import</button>}
        </div>
      )}
      {imp.status === "failed" && (
        <div className="card border-danger p-3 text-sm mb-4 flex flex-wrap gap-3 items-center" role="alert">
          <span>{imp.lastError ?? "The import stopped."} {int(imp.counts.imported)} of {int(imp.counts.ready)} imported so far — resume to finish them (nothing is created twice).</span>
          {admin && <button type="button" className="btn" onClick={resume}>Resume import</button>}
        </div>
      )}
      {toast && <Toast message={toast} tone="err" onDone={() => setToast(null)} />}
    </>
  );
}
