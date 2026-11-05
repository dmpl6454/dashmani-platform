"use client";
import { useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import { useCompany, companyName } from "@/lib/company";
import { useClients, useImportInvoices } from "@/lib/hooks";
import { fmtDate } from "@/lib/format";
import type { ImportInvoiceRow, ImportSummary, ImportView } from "@/lib/sales-types";
import { Empty, LoadError, Loading, Money, Stat, StatusPill, Toast } from "@/components/sales-ui";
import { int } from "./shared";

type Tab = "attention" | "warning" | "clients" | "duplicate" | "excluded" | "all";
const PAGE = 100;

const OUTCOME_LABEL: Record<string, string> = { excluded: "left out", duplicate: "already in" };
const DECISION_LABEL: Record<string, string> = { gstin: "GSTIN", name: "name", user: "chosen", new: "new", choose: "choose" };

/** The check: banners, the totals to tick against GSTR-1, the series effects, and every invoice. */
export function CheckStep({ imp, onChanged }: { imp: ImportView; onChanged: (v: ImportView) => void }) {
  const { company } = useCompany();
  const s = imp.summary;
  const [tab, setTab] = useState<Tab>((s?.outcomes.error ?? 0) > 0 ? "attention" : "all");
  if (!s) return <Loading />;
  const wrongCompany = imp.companyKey !== company;
  const errors = s.outcomes.error;
  const unresolved = s.clientGroups.filter((g) => g.decision.action === "choose").length;
  const allDuplicate = s.outcomes.duplicate > 0 && s.outcomes.duplicate === imp.counts.found;
  const fyRange = s.firstFy ? (s.firstFy === s.lastFy ? `FY ${s.firstFy}` : `FY ${s.firstFy} → ${s.lastFy}`) : "";
  const tabs: Array<[Tab, string]> = [
    ["attention", `Need attention (${int(errors)})`], ["warning", `Warnings (${int(s.outcomes.warning)})`], ["clients", `Clients${unresolved ? ` (${unresolved} to choose)` : ""}`],
    ["duplicate", `Duplicates (${int(s.outcomes.duplicate)})`], ["excluded", `Left out (${int(s.outcomes.excluded)})`], ["all", "All"],
  ];
  return (
    <>
      {wrongCompany && <div className="card border-attention p-3 text-sm mb-4">This import belongs to {companyName(imp.companyKey)} — switch company at the top.</div>}
      {s.blockers.map((b) => <div key={b.code + b.message} className="card border-danger p-3 text-sm mb-4" role="alert">{b.message}</div>)}
      {imp.sameFile.length > 0 && <div className="card border-attention p-3 text-sm mb-4">This exact file was uploaded before ({imp.sameFile.map((f) => <Link key={f.id} href={`/invoices/import/view?id=${f.id}`} className="underline mr-1">{fmtDate(f.createdAt.slice(0, 10))} · {f.status}</Link>)}).</div>}
      {allDuplicate && <div className="card border-border p-3 text-sm mb-4">Every invoice in this file is already in the portal — nothing to import.</div>}
      {s.notices.length > 0 && <div className="card border-border p-3 text-sm mb-4 grid gap-1">{s.notices.map((n, i) => <p key={i} className={n.level === "warning" ? "text-attention" : "text-ink-3"}>{n.message}</p>)}</div>}
      {imp.counts.found === 0 ? <Empty title="No invoices found in this file." body={`We read ${int(imp.counts.rows)} rows but none had an invoice number in the column you picked — check the Invoice number column above.`} /> : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
            <Stat label="Invoices found" value={int(imp.counts.found)} sub={`in ${int(imp.counts.rows)} rows${fyRange ? ` · ${fyRange}` : ""}`} />
            <Stat label="Ready" value={int(s.outcomes.ready + s.outcomes.warning)} tone="success" sub={s.outcomes.warning ? `${int(s.outcomes.warning)} with warnings` : undefined} />
            <Stat label="Need attention" value={int(errors)} tone={errors ? "danger" : undefined} />
            <Stat label="Already in the portal" value={int(s.outcomes.duplicate)} sub="skipped" />
            <Stat label="Taxable" value={<Money paise={s.toImport.taxablePaise} whole />} />
            <Stat label="GST" value={<Money paise={s.toImport.cgstPaise + s.toImport.sgstPaise + s.toImport.igstPaise} whole />} />
            <Stat label="Paid in Swipe" value={<Money paise={s.toImport.paidPaise} whole />} sub={<>TDS <Money paise={s.toImport.tdsPaise} whole /></>} />
            <Stat label="Outstanding after import" value={<Money paise={s.toImport.outstandingPaise} whole />} tone={s.toImport.outstandingPaise ? "attention" : undefined} />
          </div>
          <ByFyTable s={s} />
          <Numbering s={s} />
          <div className="flex flex-wrap gap-1 mb-3" role="tablist">
            {tabs.map(([t, label]) => <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`px-3 py-1.5 text-[12px] uppercase tracking-[0.08em] border-2 ${tab === t ? "bg-indigo border-indigo text-white font-bold" : "border-transparent text-ink-3 hover:border-border hover:text-white"}`}>{label}</button>)}
          </div>
          {tab === "clients" ? <ClientsTab imp={imp} onChanged={onChanged} /> : <InvoicesTab key={`${tab}:${imp.planHash}`} imp={imp} tab={tab} onChanged={onChanged} />}
        </>
      )}
    </>
  );
}

function ByFyTable({ s }: { s: ImportSummary }) {
  if (!s.byFy.length) return null;
  return (
    <section className="card overflow-x-auto mb-4">
      <h2 className="font-bold px-3 pt-3">By financial year</h2>
      <p className="text-xs text-ink-3 px-3">Tick each year&apos;s taxable value and GST against the GSTR-1 you filed before importing.</p>
      <table className="w-full min-w-[720px] text-sm mt-2">
        <thead className="text-[11px] uppercase tracking-[0.08em] text-ink-3 text-left"><tr className="border-b-2 border-border">
          {["FY", "Invoices", "B2B taxable", "B2C taxable", "CGST", "SGST", "IGST", "Total", "Paid", "TDS", "Outstanding"].map((h, i) => <th key={h} className={`p-3 ${i ? "text-right" : ""}`}>{h}</th>)}
        </tr></thead>
        <tbody>{s.byFy.map((f) => (
          <tr key={f.fy} className="border-b border-rule">
            <td className="p-3 font-mono">{f.fy}</td><td className="p-3 text-right">{int(f.invoices)}{f.cancelled ? <span className="text-ink-3"> ({f.cancelled} cancelled)</span> : null}</td>
            {[f.b2bTaxablePaise, f.b2cTaxablePaise, f.cgstPaise, f.sgstPaise, f.igstPaise, f.totalPaise, f.paidPaise, f.tdsPaise, f.outstandingPaise].map((v, i) => <td key={i} className="p-3 text-right"><Money paise={v} /></td>)}
          </tr>
        ))}</tbody>
      </table>
    </section>
  );
}

function Numbering({ s }: { s: ImportSummary }) {
  if (!s.byRegistration.length) return null;
  const live = s.byRegistration.filter((r) => r.live);
  const past = s.byRegistration.filter((r) => !r.live);
  const line = (r: ImportSummary["byRegistration"][number]) => (
    <li key={r.sequenceKey} className={`card p-3 text-sm ${r.live ? "border-attention" : ""}`}>
      <span className="font-bold">{r.label}</span> · {r.fy} — next number <span className="font-mono">{r.nextAfter}</span> {r.nextAfter === r.nextBefore ? "(unchanged)" : <>(was <span className="font-mono">{r.nextBefore}</span>)</>}
      {r.offFormat > 0 && <span className="text-ink-3"> · {r.offFormat} not in this series&apos; format</span>}
      {r.gaps.length > 0 && <div className="text-attention text-xs mt-1">Missing serials: {r.gaps.join(", ")}</div>}
    </li>
  );
  return (
    <section className="card p-4 mb-4">
      <h2 className="font-bold mb-2">Numbering after import</h2>
      <ul className="grid gap-2">{live.map(line)}</ul>
      {past.length > 0 && <details className="mt-2"><summary className="cursor-pointer text-sm text-ink-3">Past financial years ({past.length})</summary><ul className="grid gap-2 mt-2">{past.map(line)}</ul></details>}
    </section>
  );
}

function InvoicesTab({ imp, tab, onChanged }: { imp: ImportView; tab: Exclude<Tab, "clients">; onChanged: (v: ImportView) => void }) {
  const [shown, setShown] = useState(PAGE);
  const outcome = tab === "all" ? undefined : tab;
  const { data, error, isLoading, mutate } = useImportInvoices(imp.id, { outcome, limit: Math.min(200, shown), v: imp.planHash });
  const [toast, setToast] = useState<string | null>(null);
  const editable = imp.status === "draft";
  const toggle = async (r: ImportInvoiceRow) => {
    const exclude = new Set(imp.options.exclude.map((k) => k.toUpperCase()));
    if (exclude.has(r.key)) exclude.delete(r.key); else exclude.add(r.key);
    try {
      const v = await apiFetch<ImportView>(`/sales/imports/${imp.id}/mapping`, { method: "PUT", body: JSON.stringify({ headerRow: imp.file.headerRow, mapping: imp.mapping, options: { ...imp.options, exclude: [...exclude] } }) });
      onChanged(v.data);
      mutate();
    } catch (err) { setToast(errorSentence(err)); }
  };
  if (error) return <LoadError error={error} retry={() => mutate()} />;
  if (isLoading && !data) return <Loading />;
  if (!data?.rows.length) return <Empty title="Nothing here." />;
  return (
    <div className="card overflow-x-auto">
      <table className="w-full min-w-[880px] text-sm">
        <thead className="text-[11px] uppercase tracking-[0.08em] text-ink-3 text-left"><tr className="border-b-2 border-border">
          <th className="p-3">Invoice</th><th className="p-3">Date</th><th className="p-3">Customer</th><th className="p-3">Billed from</th><th className="p-3 text-right">Taxable</th><th className="p-3 text-right">GST</th><th className="p-3 text-right">Total</th><th className="p-3 text-right">Paid + TDS</th><th className="p-3">Outcome</th><th className="p-3">What to do</th><th className="p-3" />
        </tr></thead>
        <tbody>{data.rows.map((r) => {
          const shownIssues = r.issues.filter((i) => i.level !== "info" || r.outcome === "error");
          const first = (r.error ? { message: r.error } : shownIssues[0]) as { message: string } | undefined;
          const tax = (r.cgstPaise ?? 0) + (r.sgstPaise ?? 0) + (r.igstPaise ?? 0);
          return (
            <tr key={r.key} className="border-b border-rule align-top">
              <td className="p-3 font-mono text-xs break-all">{r.invoiceId ? <Link href={`/invoices/view?id=${r.invoiceId}`} className="hover:text-indigo-light">{r.number}</Link> : r.number}</td>
              <td className="p-3 whitespace-nowrap">{fmtDate(r.issueDate)}</td>
              <td className="p-3 min-w-0 max-w-[220px]"><div className="truncate" title={r.customer.name}>{r.customer.name}</div><span className="text-[11px] text-ink-3">{DECISION_LABEL[r.customer.decision]}{r.customer.clientName ? ` · ${r.customer.clientName}` : ""}</span></td>
              <td className="p-3 text-xs">{r.registration ? <span title={r.registration.gstin}>{r.registration.label.split(" (")[0]}</span> : "—"}</td>
              <td className="p-3 text-right"><Money paise={r.taxablePaise} /></td>
              <td className="p-3 text-right"><Money paise={r.taxablePaise === null ? null : tax} /></td>
              <td className="p-3 text-right"><Money paise={r.totalPaise} /></td>
              <td className="p-3 text-right"><Money paise={r.paidPaise + r.tdsPaise} /></td>
              <td className="p-3"><StatusPill status={r.outcome} label={OUTCOME_LABEL[r.outcome]} /></td>
              <td className="p-3 text-xs max-w-[280px]">
                {first?.message ?? <span className="text-ink-3">—</span>}
                {shownIssues.length > 1 && <details><summary className="cursor-pointer text-ink-3">+{shownIssues.length - 1} more</summary>{shownIssues.slice(1).map((i, k) => <p key={k} className="mt-1">{i.message}</p>)}</details>}
              </td>
              <td className="p-3 whitespace-nowrap">{editable && (r.outcome === "excluded" ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => toggle(r)}>Put back</button> : r.outcome !== "duplicate" && <button type="button" className="btn btn-ghost btn-sm" onClick={() => toggle(r)}>Leave out</button>)}</td>
            </tr>
          );
        })}</tbody>
      </table>
      {data.total > data.rows.length && <div className="p-3"><button type="button" className="btn btn-ghost" onClick={() => setShown(shown + PAGE)}>Show more ({int(data.total - data.rows.length)} left)</button></div>}
      {toast && <Toast message={toast} tone="err" onDone={() => setToast(null)} />}
    </div>
  );
}

function ClientsTab({ imp, onChanged }: { imp: ImportView; onChanged: (v: ImportView) => void }) {
  const [filter, setFilter] = useState<"choose" | "create" | "match" | "all">("all");
  const [search, setSearch] = useState<{ groupKey: string; q: string } | null>(null);
  const { data: found } = useClients(search?.q.trim() ? search.q.trim() : undefined);
  const [toast, setToast] = useState<string | null>(null);
  const groups = (imp.summary?.clientGroups ?? []).filter((g) => filter === "all" || g.decision.action === filter);
  const editable = imp.status === "draft";
  const choose = async (groupKey: string, clientId: string) => {
    try {
      const v = await apiFetch<ImportView>(`/sales/imports/${imp.id}/clients`, { method: "PUT", body: JSON.stringify({ choices: [{ groupKey, clientId }] }) });
      onChanged(v.data);
      setSearch(null);
    } catch (err) { setToast(errorSentence(err)); }
  };
  return (
    <div className="card overflow-x-auto">
      <div className="flex flex-wrap gap-1 p-3">
        {([["choose", "Needs a choice"], ["create", "New"], ["match", "Matched"], ["all", "All"]] as const).map(([k, l]) => <button key={k} type="button" onClick={() => setFilter(k)} className={`px-3 py-1 text-[12px] border ${filter === k ? "border-indigo text-white" : "border-transparent text-ink-3"}`}>{l}</button>)}
      </div>
      {!groups.length ? <p className="p-3 text-sm text-ink-3">No customers here.</p> : (
        <table className="w-full min-w-[720px] text-sm">
          <thead className="text-[11px] uppercase tracking-[0.08em] text-ink-3 text-left"><tr className="border-b-2 border-border"><th className="p-3">Swipe customer</th><th className="p-3">GSTIN</th><th className="p-3 text-right">Invoices</th><th className="p-3 text-right">Total</th><th className="p-3">Portal client</th></tr></thead>
          <tbody>{groups.map((g) => {
            const value = g.decision.action === "match" ? g.decision.clientId : g.decision.action === "create" ? "new" : "";
            return (
              <tr key={g.groupKey} className="border-b border-rule align-top">
                <td className="p-3 max-w-[220px] truncate" title={g.name}>{g.name}</td>
                <td className="p-3 font-mono text-xs break-all">{g.gstin ?? "—"}</td>
                <td className="p-3 text-right">{int(g.invoices)}</td>
                <td className="p-3 text-right"><Money paise={g.totalPaise} /></td>
                <td className="p-3 min-w-[260px]">
                  <select className="input w-full" disabled={!editable} value={value} onChange={(e) => { if (e.target.value === "__other") setSearch({ groupKey: g.groupKey, q: "" }); else if (e.target.value) choose(g.groupKey, e.target.value); }}>
                    {g.decision.action === "choose" && <option value="">Choose a client…</option>}
                    {g.decision.action === "match" && !g.candidates.some((c) => c.clientId === value) && <option value={value}>{g.decision.clientName}</option>}
                    {g.candidates.map((c) => <option key={c.clientId} value={c.clientId}>{c.name}{c.gstin ? ` · ${c.gstin}` : ""} — {c.reason}</option>)}
                    <option value="new">Create “{g.name}” as a new client</option>
                    <option value="__other">Another client…</option>
                  </select>
                  {search?.groupKey === g.groupKey && (
                    <div className="mt-2 grid gap-1">
                      <input className="input" autoFocus placeholder="Search clients" value={search.q} onChange={(e) => setSearch({ groupKey: g.groupKey, q: e.target.value })} />
                      {(found ?? []).slice(0, 8).map((c) => <button key={c.id} type="button" className="text-left text-sm hover:text-indigo-light" onClick={() => choose(g.groupKey, c.id)}>{c.billingProfile?.legalName ?? c.companyName}</button>)}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}</tbody>
        </table>
      )}
      {toast && <Toast message={toast} tone="err" onDone={() => setToast(null)} />}
    </div>
  );
}
