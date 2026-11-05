"use client";
import { useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth";
import { isAdminUser } from "@/lib/access";
import { apiFetchBlob, downloadBlob } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import { useEvents, useImportInvoices } from "@/lib/hooks";
import { fmtDate } from "@/lib/format";
import type { ImportView } from "@/lib/sales-types";
import { Money, Stat, Toast } from "@/components/sales-ui";
import { EventList } from "@/components/document-view";
import { UndoImportDialog } from "./undo-import-dialog";
import { int } from "./shared";

/** After apply: what landed, Imported vs file by financial year, failures, history and Undo. */
export function ImportReport({ imp, refresh }: { imp: ImportView; refresh: () => Promise<unknown> }) {
  const { user } = useAuth();
  const admin = isAdminUser(user);
  const { data: events } = useEvents("import", imp.id);
  const { data: failed } = useImportInvoices(imp.id, { outcome: "failed", limit: 200, v: `${imp.status}:${imp.counts.failed}` });
  const [undo, setUndo] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const rec = imp.summary?.reconcile;
  const report = async () => {
    try { const { blob, filename } = await apiFetchBlob(`/sales/imports/${imp.id}/report.csv`); downloadBlob(blob, filename ?? "swipe-import.csv"); } catch (err) { setToast(errorSentence(err)); }
  };
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <div className="lg:col-span-2 grid gap-4 min-w-0">
        {imp.status === "undone" ? (
          <div className="card border-border p-3 text-sm">Undone on {fmtDate(imp.undoneAt?.slice(0, 10))}{imp.undoneByName ? ` by ${imp.undoneByName}` : ""} — {imp.undoReason}.</div>
        ) : (
          <div className="card border-success p-3 text-sm">Imported {int(imp.counts.imported)} invoices, {int(imp.counts.payments)} receipts and {int(imp.counts.clientsCreated)} new clients on {fmtDate(imp.appliedAt?.slice(0, 10))}{imp.appliedByName ? ` by ${imp.appliedByName}` : ""}.</div>
        )}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <Stat label="Imported" value={int(imp.counts.imported)} tone="success" />
          <Stat label="Skipped" value={int(imp.counts.skipped)} />
          <Stat label="Failed" value={int(imp.counts.failed)} tone={imp.counts.failed ? "danger" : undefined} />
          <Stat label="Receipts" value={int(imp.counts.payments)} />
          <Stat label="New clients" value={int(imp.counts.clientsCreated)} />
        </div>
        {rec && (
          <section className="card overflow-x-auto">
            <h2 className="font-bold px-3 pt-3">Imported vs file</h2>
            <table className="w-full min-w-[560px] text-sm mt-2">
              <thead className="text-[11px] uppercase tracking-[0.08em] text-ink-3 text-left"><tr className="border-b-2 border-border"><th className="p-3">FY</th><th className="p-3 text-right">Invoices</th><th className="p-3 text-right">Taxable</th><th className="p-3 text-right">GST</th><th className="p-3 text-right">Total</th><th className="p-3 text-right">File</th><th className="p-3" /></tr></thead>
              <tbody>{rec.byFy.map((f) => (
                <tr key={f.fy} className="border-b border-rule">
                  <td className="p-3 font-mono">{f.fy}</td><td className="p-3 text-right">{int(f.invoices)}</td>
                  <td className="p-3 text-right"><Money paise={f.taxablePaise} /></td><td className="p-3 text-right"><Money paise={f.taxPaise} /></td><td className="p-3 text-right"><Money paise={f.totalPaise} /></td>
                  <td className="p-3 text-right"><Money paise={f.planTotalPaise} /></td>
                  <td className={`p-3 ${f.totalPaise === f.planTotalPaise ? "text-success" : "text-danger"}`}>{f.totalPaise === f.planTotalPaise ? "✓" : "✗"}</td>
                </tr>
              ))}</tbody>
            </table>
          </section>
        )}
        <div className="flex flex-wrap gap-2">
          {imp.status === "applied" && <Link href={`/invoices?importId=${imp.id}`} className="btn btn-light">Open the imported invoices</Link>}
          <button type="button" className="btn btn-ghost" onClick={report}>Download report</button>
        </div>
        {(failed?.rows.length ?? 0) > 0 && (
          <section className="card p-4">
            <h2 className="font-bold mb-2">Failed invoices</h2>
            <ul className="text-sm grid gap-1">{failed!.rows.map((r) => <li key={r.key}><span className="font-mono">{r.number}</span> — {r.error}</li>)}</ul>
          </section>
        )}
        {imp.status === "applied" && admin && (imp.undo?.allowed
          ? <div><button type="button" className="btn btn-danger" onClick={() => setUndo(true)}>Undo this import</button></div>
          : imp.undo?.blockedBy && <div className="card border-border p-3 text-sm">{imp.undo.blockedBy}</div>)}
      </div>
      <EventList events={events} />
      {undo && <UndoImportDialog imp={imp} onClose={() => setUndo(false)} onDone={() => { setUndo(false); refresh(); }} />}
      {toast && <Toast message={toast} tone="err" onDone={() => setToast(null)} />}
    </div>
  );
}
