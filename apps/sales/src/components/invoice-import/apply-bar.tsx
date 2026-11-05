"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { isAdminUser } from "@/lib/access";
import { ApiError, apiFetch, apiFetchBlob, downloadBlob } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import { companyName } from "@/lib/company";
import type { ImportView } from "@/lib/sales-types";
import { Confirm, Toast } from "@/components/sales-ui";
import { int, invalidateAfterImport } from "./shared";

/** Sticky actions under the check: Import (Admin), the hand-off link (Sales), the report, discard. */
export function ApplyBar({ imp, onChanged, refresh }: { imp: ImportView; onChanged: (v: ImportView) => void; refresh: () => Promise<unknown> }) {
  const router = useRouter();
  const { user } = useAuth();
  const admin = isAdminUser(user);
  const s = imp.summary;
  const warnings = s?.outcomes.warning ?? 0;
  const live = s?.liveSeriesMoves ?? [];
  const [ack, setAck] = useState(false);
  const [liveOk, setLiveOk] = useState(false);
  const [modal, setModal] = useState<null | "apply" | "discard">(null);
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "err" } | null>(null);
  const ready = imp.counts.ready;
  const blocked = (s?.blockers.length ?? 0) > 0 || ready === 0 || (warnings > 0 && !ack) || (live.length > 0 && !liveOk);

  const apply = async () => {
    try {
      const r = await apiFetch<ImportView>(`/sales/imports/${imp.id}/apply`, { method: "POST", body: JSON.stringify({ planHash: imp.planHash, acceptWarnings: ack, confirmLiveSeries: liveOk }) });
      onChanged(r.data);
      setModal(null);
      setToast({ message: `Import started — ${int(ready)} invoices`, tone: "ok" });
    } catch (err) {
      setModal(null);
      setToast({ message: errorSentence(err), tone: "err" });
      if (err instanceof ApiError && err.code === "PLAN_CHANGED") await refresh();
    }
  };
  const discard = async () => {
    try {
      await apiFetch(`/sales/imports/${imp.id}`, { method: "DELETE" });
      await invalidateAfterImport();
      router.push("/invoices/import");
    } catch (err) { setModal(null); setToast({ message: errorSentence(err), tone: "err" }); }
  };
  const recheck = async () => {
    try {
      const r = await apiFetch<ImportView>(`/sales/imports/${imp.id}/check`, { method: "POST" });
      onChanged(r.data);
      setToast({ message: `Check updated — ${int(r.data.counts.ready)} invoices ready`, tone: "ok" });
    } catch (err) { setToast({ message: errorSentence(err), tone: "err" }); }
  };
  const report = async () => {
    try { const { blob, filename } = await apiFetchBlob(`/sales/imports/${imp.id}/report.csv`); downloadBlob(blob, filename ?? "swipe-import.csv"); } catch (err) { setToast({ message: errorSentence(err), tone: "err" }); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(window.location.href); setToast({ message: "Link copied — send it to an admin", tone: "ok" }); } catch { setToast({ message: "Couldn't copy — copy the address bar instead", tone: "err" }); }
  };
  const seriesLine = (s?.byRegistration ?? []).filter((r) => r.live).map((r) => `${r.label.split(" (")[0]} at ${r.nextAfter}`).join(" and ");

  return (
    <div className="sticky bottom-0 bg-bg border-t-2 border-border p-3 flex flex-wrap gap-2 items-center mt-4 z-10">
      {admin ? (
        <>
          {warnings > 0 && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I have read the {int(warnings)} warning{warnings === 1 ? "" : "s"}</label>}
          {live.length > 0 && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={liveOk} onChange={(e) => setLiveOk(e.target.checked)} /> Move the live series as shown above</label>}
          <button type="button" className="btn" disabled={blocked} onClick={() => setModal("apply")}>Import {int(ready)} invoices</button>
        </>
      ) : (
        <>
          <button type="button" className="btn" disabled>Import {int(ready)} invoices</button>
          <span className="text-sm text-ink-3">An admin presses Import — send them this page</span>
          <button type="button" className="btn btn-light" onClick={copy}>Copy link</button>
        </>
      )}
      <span className="flex-1" />
      <button type="button" className="btn btn-ghost" onClick={recheck}>Check again</button>
      <button type="button" className="btn btn-ghost" onClick={report}>Download check report</button>
      <button type="button" className="btn btn-ghost" onClick={() => setModal("discard")}>Discard this upload</button>
      {modal === "apply" && s && (
        <Confirm title={`Import ${int(ready)} invoices into ${companyName(imp.companyKey).replace(/ Private Limited$/, "")}?`} confirmLabel="Import" onClose={() => setModal(null)} onConfirm={apply}
          body={<p>They will be issued with their Swipe numbers, dates and amounts; {int(s.toImport.receipts)} receipts will be recorded and {int(s.clientGroups.filter((g) => g.decision.action === "create").length)} clients created. No emails are sent. {s.outcomes.error ? `${int(s.outcomes.error)} invoices with errors are left out. ` : ""}{seriesLine ? `The series continue: ${seriesLine}. ` : ""}You can undo the whole import while no payment or credit note is recorded against these invoices.</p>} />
      )}
      {modal === "discard" && <Confirm danger title="Discard this upload?" confirmLabel="Discard" body="Nothing was imported from it; you can upload the file again." onClose={() => setModal(null)} onConfirm={discard} />}
      {toast && <Toast message={toast.message} tone={toast.tone} onDone={() => setToast(null)} />}
    </div>
  );
}
