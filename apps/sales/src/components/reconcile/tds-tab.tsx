"use client";
// Reconcile → TDS · 26AS (spec-reconcile §7.3): FY pills, the upload line, stats, What to do next,
// "Whose TAN is this?", filter pills and one card per client. Headings label themselves from the
// SERVER's answer (data.fy.label), never the URL.
import { useMemo, useState } from "react";
import Link from "next/link";
import { useSWRConfig } from "swr";
import { Download } from "lucide-react";
import { useTdsRecon, useClients } from "@/lib/hooks";
import { useCompany } from "@/lib/company";
import { apiFetch, apiFetchBlob, downloadBlob } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import { fmtDate, fmtInr } from "@/lib/format";
import { reconKey } from "@/lib/reconcile";
import type { TdsReconView, TdsUploadResult } from "@/lib/sales-types";
import { Confirm, Empty, LoadError, Loading, Stat } from "@/components/sales-ui";
import { TodoCard } from "./todo-card";
import { FilterPills } from "./tab-bar";
import { UploadFile } from "./upload-file";
import { DeductorCard } from "./deductor-card";
import { TdsClientCard } from "./tds-client-card";
import { TdsRowDetail } from "./tds-row";

type Filter = "chase" | "link_first" | "extra" | "not_due" | "next_year" | "matched" | "all";

export function TdsTab({ fy, onFy, toast }: { fy?: string; onFy: (fy: string) => void; toast: (message: string, tone?: "ok" | "err") => void }) {
  const { company } = useCompany();
  const { data, error, isLoading, mutate } = useTdsRecon(fy);
  const { data: clients } = useClients();
  const { mutate: globalMutate } = useSWRConfig();
  const [filter, setFilter] = useState<Filter>("all");
  const [busy, setBusy] = useState(false);
  const [unmapTan, setUnmapTan] = useState<string | null>(null);
  const refresh = () => globalMutate(reconKey, undefined, { revalidate: true });

  if (error && (!data || data.company !== company)) return <LoadError error={error} retry={() => mutate()} />;
  if (isLoading && !data) return <Loading label="Reading Form 26AS…" />;
  if (!data || data.company !== company) return <Loading />;
  const d = data;
  const stale = !!fy && d.fy.label !== fy;
  const unknown = d.deductors.filter((x) => x.kind === "unknown");
  const known = d.deductors.filter((x) => x.kind === "non_sales" || (x.kind === "client" && x.source !== "profile"));

  const downloadChase = async () => {
    setBusy(true);
    try { const { blob, filename } = await apiFetchBlob(`/sales/reconcile/tds/chase.csv?company=${company}&fy=${d.fy.label}`); downloadBlob(blob, filename ?? `tds-chase-${company}-${d.fy.label}.csv`); }
    catch (err) { toast(errorSentence(err), "err"); } finally { setBusy(false); }
  };
  const unmap = async (tan: string) => {
    try { await apiFetch(`/sales/reconcile/tds/deductors/${tan}`, { method: "DELETE" }); toast(`${tan} unmapped.`); await refresh(); } catch (err) { toast(errorSentence(err), "err"); }
  };

  return (
    <div>
      {/* keepPreviousData: a failed FY switch leaves the old year on screen — say so above it. */}
      {error && <div className="mb-4"><LoadError error={error} retry={() => mutate()} /></div>}
    <div className={stale ? "opacity-60" : ""} aria-busy={(stale && !error) || undefined}>
      <div className="flex flex-wrap gap-2 mb-4 items-center" role="radiogroup" aria-label="Financial year">
        {d.fyOptions.map((f, i) => (
          <button key={f} type="button" role="radio" aria-checked={f === d.fy.label} onClick={() => onFy(f)}
            className={`px-3 py-1.5 text-sm border-2 ${f === d.fy.label ? "bg-indigo border-indigo text-white" : "border-border text-ink-3 hover:text-white"}`}>
            {f}{i === 0 ? " · running" : ""}
          </button>
        ))}
      </div>

      <UploadFile<TdsUploadResult> path={`/sales/reconcile/tds/uploads?company=${company}`} accept=".txt,.csv,.tsv,.xlsx,.xls" fields={{ fy: d.fy.label }}
        busyLabel="Reading Form 26AS…"
        hint="TRACES → View Tax Credit (Form 26AS) → View As: Text → Export as Text. Open the zip (password: date of incorporation, DDMMYYYY) and upload the .txt. The AIS TDS CSV also works. Up to 10 MB."
        onError={(m) => toast(m, "err")}
        onDone={async (r) => {
          if (r.duplicate && !r.madeCurrent) toast(`This exact file is already the current 26AS for ${d.fy.label}.`);
          else {
            const learned = r.learned.length ? ` ${r.learned.map((l) => l.clientName).join(" and ")}'s TAN${r.learned.length === 1 ? " was" : "s were"} recognised.` : "";
            toast(`Form 26AS${r.upload.asOn ? ` as on ${fmtDate(r.upload.asOn)}` : ""} read — ${r.upload.entryCount} entries from ${r.upload.deductorCount} deductors.${learned}`);
          }
          await refresh();
        }} />
      {d.upload && (
        <p className="text-xs text-ink-3 mb-4">
          Form 26AS{d.upload.asOn ? ` as on ${fmtDate(d.upload.asOn)}` : ""} · {d.upload.fileName} · uploaded {fmtDate(d.upload.createdAt)}{d.upload.uploadedByName ? ` by ${d.upload.uploadedByName}` : ""}
          {d.upload.errorCount > 0 && ` · ${d.upload.errorCount} line(s) not read`}
          {d.historyCount > 1 && (
            <details className="inline-block ml-2"><summary className="cursor-pointer inline">{d.historyCount - 1} earlier upload{d.historyCount === 2 ? "" : "s"}</summary>
              <ul className="mt-1">{d.history.filter((h) => !h.current).map((h) => <li key={h.id}>{h.fileName} · {fmtDate(h.createdAt)} · {h.entryCount} entries{h.uploadedByName ? ` · ${h.uploadedByName}` : ""}</li>)}</ul>
            </details>
          )}
        </p>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <Stat label="TDS in our books" value={fmtInr(d.totals.booksPaise)} sub={`by invoice date · ${fmtInr(d.totals.booksByReceiptDatePaise)} on receipts dated in ${d.fy.label}, as on Accounts`} />
        <Stat label="In Form 26AS" value={fmtInr(d.totals.deductedPaise)} sub={`deposited ${fmtInr(d.totals.depositedPaise)}`} />
        <Stat label="To chase" tone={d.totals.chasePaise ? "danger" : undefined} value={fmtInr(d.totals.chasePaise)} sub={`${d.totals.chaseCount} item${d.totals.chaseCount === 1 ? "" : "s"}`} />
        <Stat label="In 26AS, not in our books" tone={d.totals.extraPaise + d.totals.unknownPaise ? "attention" : undefined} value={fmtInr(d.totals.extraPaise + d.totals.unknownPaise)} sub={(() => { const n = d.rows.filter((r) => r.group === "extra").length; return `${n} client${n === 1 ? "" : "s"} · ${unknown.length} unknown`; })()} />
      </div>

      <TodoCard todo={d.todo} empty={`Form 26AS for ${d.fy.label} matches your receipts.`} actionFor={(t, first) => {
        const cls = first ? "btn btn-sm" : "btn btn-ghost btn-sm";
        if (t.code === "chase") return <button type="button" className={`${cls} inline-flex items-center gap-1`} disabled={busy} onClick={downloadChase}><Download size={14} aria-hidden />Download chase list</button>;
        if (t.code === "link") return <a href="#deductors" className={cls}>Show them</a>;
        if (t.href) return <Link href={t.href} className={cls}>Record payment</Link>;
        return null;
      }} />

      {!d.upload ? (
        d.totals.booksPaise === 0
          ? <Empty title={`No TDS on receipts in ${d.fy.label} and none in Form 26AS.`} />
          : <Empty title={`No Form 26AS for ${d.fy.label} yet.`} body="Upload it to see which clients deposited the TDS they cut from your payments." />
      ) : (
        <>
          {unknown.length > 0 && (
            <section id="deductors" className="mb-5">
              <h2 className="font-bold mb-2">Whose TAN is this?</h2>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                {unknown.map((x) => <DeductorCard key={x.tan} d={x} clients={clients ?? []} onError={(m) => toast(m, "err")} onSaved={async (m) => { toast(m); await refresh(); }} />)}
              </div>
            </section>
          )}
          <Clients d={d} filter={filter} setFilter={setFilter} toast={toast} />
          {known.length > 0 && (
            <details className="card p-3 mt-4">
              <summary className="cursor-pointer font-bold text-sm">Mapped deductors ({known.length})</summary>
              <ul className="mt-2 divide-y divide-rule text-sm">
                {known.map((x) => (
                  <li key={x.tan} className="py-2 flex flex-wrap items-center justify-between gap-2">
                    <span className="min-w-0"><span className="font-mono text-xs break-all">{x.tan}</span> · {x.name} → {x.kind === "non_sales" ? `not sales (${x.label ?? ""})` : x.clientName}{x.source === "auto" ? " · learned" : ""}</span>
                    <span className="flex gap-2"><span className="font-mono">{fmtInr(x.tdsPaise)}</span><button type="button" className="btn btn-ghost btn-sm" onClick={() => setUnmapTan(x.tan)}>Unmap</button></span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      {unmapTan && (
        <Confirm danger title={`Unmap ${unmapTan}?`} confirmLabel="Unmap" body="Its 26AS entries will show as unknown until you say who it is."
          onClose={() => setUnmapTan(null)} onConfirm={async () => { const t = unmapTan; setUnmapTan(null); await unmap(t); }} />
      )}
    </div>
    </div>
  );
}

function Clients({ d, filter, setFilter, toast }: { d: TdsReconView; filter: Filter; setFilter: (f: Filter) => void; toast: (m: string, tone?: "ok" | "err") => void }) {
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of d.rows) c[r.group] = (c[r.group] ?? 0) + 1;
    return c;
  }, [d.rows]);
  const rowsFor = (id: string) => d.rows.filter((r) => r.clientId === id && r.group !== "unknown");
  const shown = d.clients.filter((c) => filter === "all" || rowsFor(c.clientId).some((r) => r.group === filter));
  const other = d.rows.filter((r) => r.group === "non_sales" || r.group === "unknown");
  return (
    <section>
      <FilterPills<Filter> label="Show" current={filter} onPick={setFilter} items={[
        { key: "chase", label: "To chase", count: counts.chase ?? 0 }, { key: "link_first", label: "Link first", count: counts.link_first ?? 0 },
        { key: "extra", label: "More in 26AS", count: counts.extra ?? 0 }, { key: "not_due", label: "Not due yet", count: counts.not_due ?? 0 },
        { key: "next_year", label: "Next year", count: counts.next_year ?? 0 }, { key: "matched", label: "Matches", count: counts.matched ?? 0 }, { key: "all", label: "All" },
      ]} />
      {shown.length === 0 ? <p className="text-sm text-ink-3">Nothing here.</p> : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {shown.map((c) => <TdsClientCard key={c.clientId} c={c} rows={rowsFor(c.clientId)} ourPan={d.pan.company} onCopied={(m) => toast(m)} />)}
        </div>
      )}
      {other.length > 0 && (filter === "all") && (
        <details className="card p-3 mt-4">
          <summary className="cursor-pointer font-bold text-sm">Not sales clients and unknown deductors ({other.length})</summary>
          {other.map((r) => <TdsRowDetail key={r.key} r={r} />)}
        </details>
      )}
    </section>
  );
}
