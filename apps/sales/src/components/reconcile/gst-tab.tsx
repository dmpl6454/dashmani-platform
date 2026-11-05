"use client";
// Reconcile → GST · GSTR-1 (spec-reconcile §7.4): registration pills, period, the upload line,
// stats, What to do next, status pills, row cards (matches collapsed) and the section totals.
import { useState } from "react";
import { useSWRConfig } from "swr";
import { Download } from "lucide-react";
import { useGstRecon } from "@/lib/hooks";
import { useCompany } from "@/lib/company";
import { apiFetchBlob, downloadBlob } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import { fmtDate, fmtInr } from "@/lib/format";
import { GST_STATUS_LABEL, reconKey } from "@/lib/reconcile";
import type { GstHeads, GstStatus, GstUploadResult } from "@/lib/sales-types";
import { Empty, LoadError, Loading, Stat } from "@/components/sales-ui";
import { TodoCard } from "./todo-card";
import { FilterPills } from "./tab-bar";
import { UploadFile } from "./upload-file";
import { GstRowCard } from "./gst-row-card";

const SECTION_LABEL: Record<string, string> = { b2b: "B2B", sez: "SEZ", cdnr: "Credit notes", b2cl: "B2C large", b2cs: "B2C small", exp: "Exports" };
const tax = (h: GstHeads | null) => (h ? (h.igstPaise ?? 0) + (h.cgstPaise ?? 0) + (h.sgstPaise ?? 0) : null);
type Filter = "problems" | GstStatus | "all";

export function GstTab({ gstin, period, onScope, toast }: { gstin?: string; period?: string; onScope: (gstin: string, period: string) => void; toast: (m: string, tone?: "ok" | "err") => void }) {
  const { company } = useCompany();
  const { data, error, isLoading, mutate } = useGstRecon(gstin, period);
  const { mutate: globalMutate } = useSWRConfig();
  const [filter, setFilter] = useState<Filter>("problems");
  const [showMatched, setShowMatched] = useState(false);
  const [busy, setBusy] = useState(false);
  if (error && (!data || data.company !== company)) return <LoadError error={error} retry={() => mutate()} />;
  if (isLoading && !data) return <Loading label="Comparing GSTR-1…" />;
  if (!data || data.company !== company) return <Loading />;
  const d = data;
  const stale = (!!period && d.period.key !== period) || (!!gstin && d.gstin !== gstin);
  const c = d.counts;
  const differ = c.value_mismatch + c.wrong_recipient + c.wrong_period + c.cancelled_but_filed;
  const matched = d.rows.filter((r) => r.status === "matched" || r.status === "matched_note");
  const problems = d.rows.filter((r) => r.status !== "matched" && r.status !== "matched_note");
  const shown = filter === "all" ? problems : filter === "problems" ? problems : d.rows.filter((r) => r.status === filter);
  const nothing = d.rows.length === 0 && d.uploads.length === 0;
  const download = async () => {
    setBusy(true);
    try { const { blob, filename } = await apiFetchBlob(`/sales/reconcile/gst/differences.csv?company=${company}&gstin=${d.gstin}&period=${d.period.key}`); downloadBlob(blob, filename ?? "gstr1-differences.csv"); }
    catch (err) { toast(errorSentence(err), "err"); } finally { setBusy(false); }
  };
  return (
    <div className={stale ? "opacity-60" : ""} aria-busy={stale || undefined}>
      <div className="flex flex-wrap gap-2 mb-4 items-center">
        {d.registrations.length > 1 && d.registrations.map((r) => (
          <button key={r.gstin} type="button" aria-pressed={r.gstin === d.gstin} onClick={() => onScope(r.gstin, d.period.key)}
            className={`px-3 py-1.5 text-sm border-2 ${r.gstin === d.gstin ? "bg-indigo border-indigo text-white" : "border-border text-ink-3 hover:text-white"}`}>
            {r.label} <span className="font-mono text-xs">{r.gstin}</span>
          </button>
        ))}
        <select className="input w-auto max-w-full" aria-label="Return period" value={d.period.key} onChange={(e) => onScope(d.gstin, e.target.value)}>
          {d.periodOptions.map((o) => <option key={o.key} value={o.key}>{o.label}{d.periodsWithUploads.includes(o.key) ? " · uploaded" : ""}</option>)}
        </select>
      </div>

      <UploadFile<GstUploadResult> path={`/sales/reconcile/gst/uploads?company=${company}`} accept=".json,.csv,.xlsx,.xls" fields={{ gstin: d.gstin, period: d.period.key }}
        busyLabel="Reading GSTR-1…"
        hint="GST portal → Returns → GSTR-1 → (filed return) → Download → JSON. Open the zip and upload the .json. The Excel download or the b2b/cdnr CSV (also the ones Accounts makes) work too — upload b2b and cdnr separately if you like."
        onError={(m) => toast(m, "err")}
        onDone={async (r) => {
          if (r.duplicate && !r.madeCurrent) toast(`This exact file is already the current GSTR-1 for ${d.period.label}.`);
          else toast(`GSTR-1 for ${d.period.label} read — ${r.upload.counts.b2b ?? 0} invoice${r.upload.counts.b2b === 1 ? "" : "s"}, ${r.upload.counts.cdnr ?? 0} credit note${r.upload.counts.cdnr === 1 ? "" : "s"}.${r.upload.taxColumns ? "" : " This sheet has no tax columns — value, taxable value and rate were compared."}`);
          await globalMutate(reconKey, undefined, { revalidate: true });
        }} />
      {!d.taxColumns && <p className="text-xs text-attention mb-3">The current upload has no tax columns — value, taxable value and rate were compared, not the tax heads.</p>}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <Stat label="Match" tone="success" value={String(c.matched + c.matched_note)} />
        <Stat label="Differ" tone={differ ? "danger" : undefined} value={String(differ)} sub="figures, recipient, month, cancelled" />
        <Stat label="Not filed" tone={c.not_filed ? "danger" : undefined} value={String(c.not_filed)} />
        <Stat label="Filed, not in the portal" tone={c.not_in_books ? "attention" : undefined} value={String(c.not_in_books)} />
      </div>
      <TodoCard todo={d.todo} empty={`${d.period.label}'s GSTR-1 matches the portal.`} />

      {nothing ? <Empty title="Nothing issued and nothing filed for this period." /> : d.uploads.length === 0 ? (
        <Empty title={`No GSTR-1 for ${d.period.label} (${d.registrationLabel}) yet.`} body="Upload the GSTR-1 you filed to check it against the invoices in the portal." />
      ) : (
        <>
          <FilterPills<Filter> label="Show" current={filter} onPick={setFilter} items={[
            { key: "problems", label: "Needs attention", count: problems.length },
            ...(["value_mismatch", "wrong_recipient", "wrong_period", "cancelled_but_filed", "not_filed", "not_in_books"] as GstStatus[]).filter((s) => c[s]).map((s) => ({ key: s as Filter, label: GST_STATUS_LABEL[s], count: c[s] })),
          ]} />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-3">{shown.map((r) => <GstRowCard key={r.key} r={r} />)}</div>
          {matched.length > 0 && (
            <button type="button" className="btn btn-ghost btn-sm mb-3" onClick={() => setShowMatched((v) => !v)}>{showMatched ? "Hide" : "Show"} {matched.length} that match</button>
          )}
          {showMatched && <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-3">{matched.map((r) => <GstRowCard key={r.key} r={r} />)}</div>}
          {c.cancelledNotFiled > 0 && <p className="text-xs text-ink-3 mb-3">{c.cancelledNotFiled} cancelled invoice{c.cancelledNotFiled === 1 ? " was" : "s were"} correctly not filed.</p>}
        </>
      )}

      <section className="card p-4 mt-4 min-w-0">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
          <h2 className="font-bold">Sections · {d.period.label}</h2>
          <button type="button" className="btn btn-light btn-sm inline-flex items-center gap-1" disabled={busy || !d.uploads.length} onClick={download}><Download size={14} aria-hidden />Download differences</button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[560px]">
            <thead className="text-[11px] uppercase tracking-[0.08em] text-ink-3 text-left"><tr className="border-b-2 border-border"><th className="p-2">Section</th><th className="p-2 text-right">Portal taxable</th><th className="p-2 text-right">Filed taxable</th><th className="p-2 text-right">Portal tax</th><th className="p-2 text-right">Filed tax</th><th className="p-2">Compared</th></tr></thead>
            <tbody>{d.sections.map((s) => (
              <tr key={s.section} className={`border-b border-rule ${s.differs ? "text-attention" : ""}`}>
                <td className="p-2">{SECTION_LABEL[s.section]}</td>
                <td className="p-2 text-right font-mono">{fmtInr(s.books.taxablePaise)}</td><td className="p-2 text-right font-mono">{s.filed ? fmtInr(s.filed.taxablePaise) : "—"}</td>
                <td className="p-2 text-right font-mono">{fmtInr(tax(s.books))}</td><td className="p-2 text-right font-mono">{s.filed ? fmtInr(tax(s.filed)) : "—"}</td>
                <td className="p-2 text-xs text-ink-3">{s.comparedItemwise ? "one by one" : "totals only"}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        {d.uploads.length > 0 && (
          <details className="mt-3 text-xs text-ink-3"><summary className="cursor-pointer">Uploads for this period ({d.uploads.length})</summary>
            <ul className="mt-1">{d.uploads.map((u) => <li key={u.id}>{u.fileName} · {fmtDate(u.createdAt)}{u.uploadedByName ? ` · ${u.uploadedByName}` : ""} · {u.sections.join(", ")}{u.current.length ? ` · current for ${u.current.join(", ")}` : ""}</li>)}</ul>
          </details>
        )}
      </section>
    </div>
  );
}
