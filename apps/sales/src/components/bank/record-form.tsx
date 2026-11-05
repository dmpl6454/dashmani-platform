"use client";
import { useEffect, useMemo, useState } from "react";
import { TDS_RATES, sectionForRate, tdsAt } from "@dashmani/shared/src/sales/tds";
import { bankPct, splitTds } from "@dashmani/shared/src/sales/bank";
import { useClients, useInvoices } from "@/lib/hooks";
import { apiFetch, ApiError } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import { fmtDate, fmtInr } from "@/lib/format";
import { Confirm, Field, Money, MoneyInput, StatusPill } from "@/components/sales-ui";
import { ClientSelect } from "@/components/client-select";
import type { BankCandidate, BankLineView } from "@/lib/sales-types";
import type { CompanyKey as CK } from "@/lib/company";

// "Record this credit" — client, cash from this credit, the TDS cut (rate chips, base, section,
// Settle in full / Apply rate) and the allocation table. The server re-checks everything under
// the line lock; code-handled answers (POSSIBLE_DOUBLE_RECEIPT, TDS_TOO_HIGH, POSSIBLE_DUPLICATE)
// come back to the page, which asks and resends with the acknowledgement.

type Alloc = Record<string, { amountPaise: number; tdsPaise: number; on: boolean }>;
export type Ack = { ackDuplicateLine?: boolean; ackExistingReceipt?: boolean; ackHighTds?: boolean };
export type RecordOutcome = { ok: true; number: string; invoices: string[] } | { ok: false; code: string | null; message: string };

export function RecordForm({ line, fill, ack, onDone }: { line: BankLineView; fill: BankCandidate | null; ack: Ack; onDone: (o: RecordOutcome, resend: (extra: Ack) => void) => void }) {
  const company = line.companyKey as CK;
  const { data: clients } = useClients();
  const [clientId, setClientId] = useState("");
  const [cash, setCash] = useState(line.remainingPaise);
  const [tdsOn, setTdsOn] = useState(false);
  const [rateBp, setRateBp] = useState<number | null>(null);
  const [base, setBase] = useState<"taxable" | "gross">("taxable");
  const [section, setSection] = useState<string>("");
  const [alloc, setAlloc] = useState<Alloc>({});
  const [notes, setNotes] = useState("");
  const [asking, setAsking] = useState<null | "confirm" | "advance">(null);
  const { data: invoices } = useInvoices({ status: "outstanding", clientId: clientId || undefined, company });
  const open = useMemo(() => (clientId ? (invoices ?? []).filter((i) => i.clientId === clientId && i.balancePaise > 0) : []), [invoices, clientId]);

  // "Use this" on a suggestion fills the whole form.
  useEffect(() => {
    if (!fill) return;
    setClientId(fill.clientId);
    setCash(fill.amountPaise);
    setTdsOn(fill.tdsPaise > 0);
    setRateBp(fill.tdsRateBp);
    setBase(fill.tdsBase ?? "taxable");
    setSection(fill.tdsSection ?? (fill.tdsRateBp ? sectionForRate(fill.tdsRateBp) ?? "" : ""));
    const a: Alloc = {};
    for (const x of fill.allocations) a[x.invoiceId] = { amountPaise: x.amountPaise, tdsPaise: x.tdsPaise, on: true };
    setAlloc(a);
  }, [fill]);

  const rows = open.map((i) => ({ inv: i, a: alloc[i.id] ?? { amountPaise: 0, tdsPaise: 0, on: false } }));
  const chosen = rows.filter((r) => r.a.on);
  const onInvoices = chosen.reduce((s, r) => s + r.a.amountPaise, 0);
  const tdsTotal = tdsOn ? chosen.reduce((s, r) => s + r.a.tdsPaise, 0) : 0;
  const advance = cash - onInvoices;
  const netTaxableOf = (i: (typeof open)[number]) => i.taxablePaise; // credit notes already reduce the balance; the server checks TDS on the net taxable value

  function settleInFull() {
    const split = splitTds(chosen.map((r) => ({ id: r.inv.id, balancePaise: r.inv.balancePaise, basePaise: base === "taxable" ? netTaxableOf(r.inv) : r.inv.totalPaise })), cash);
    if (!split) return;
    const next = { ...alloc };
    for (const s of split) next[s.id] = { amountPaise: s.amountPaise, tdsPaise: s.tdsPaise, on: true };
    setAlloc(next);
    setTdsOn(split.some((s) => s.tdsPaise > 0));
  }
  function applyRate() {
    if (!rateBp) return;
    let left = cash;
    const next = { ...alloc };
    for (const r of [...chosen].sort((a, b) => String(a.inv.dueDate ?? "9").localeCompare(String(b.inv.dueDate ?? "9")))) {
      const t = Math.max(0, tdsAt(base === "taxable" ? netTaxableOf(r.inv) : r.inv.totalPaise, rateBp) - r.inv.tdsPaise);
      const amt = Math.max(0, Math.min(left, r.inv.balancePaise - t));
      left -= amt;
      next[r.inv.id] = { amountPaise: amt, tdsPaise: Math.min(t, r.inv.balancePaise), on: true };
    }
    setAlloc(next);
  }
  const taxableChosen = chosen.reduce((s, r) => s + netTaxableOf(r.inv), 0);
  const effective = tdsOn && taxableChosen > 0 && tdsTotal > 0 ? (tdsTotal * 10000) / taxableChosen : null;
  const standard = effective != null && TDS_RATES.some((r) => Math.abs(tdsAt(taxableChosen, r.rateBp) - tdsTotal) <= 100);

  const body = (asAdvance: boolean, extra: Ack) => ({
    clientId, amountPaise: cash, tdsPaise: asAdvance && !tdsOn ? 0 : tdsTotal,
    tdsRateBp: tdsTotal > 0 ? rateBp ?? null : null, tdsSection: tdsTotal > 0 ? section || null : null,
    allocations: asAdvance ? [] : chosen.map((r) => ({ invoiceId: r.inv.id, amountPaise: r.a.amountPaise, tdsPaise: tdsOn ? r.a.tdsPaise : 0 })),
    notes: notes || null, ...ack, ...extra,
  });
  async function send(asAdvance: boolean, extra: Ack = {}) {
    try {
      const r = await apiFetch<{ payment: { number: string } }>(`/sales/bank/lines/${line.id}/confirm`, { method: "POST", body: JSON.stringify(body(asAdvance, extra)) });
      onDone({ ok: true, number: r.data.payment.number, invoices: asAdvance ? [] : chosen.map((c) => c.inv.number ?? "") }, () => undefined);
    } catch (err) {
      onDone({ ok: false, code: err instanceof ApiError ? err.code ?? null : null, message: errorSentence(err) }, (more) => void send(asAdvance, { ...extra, ...more }));
    } finally { setAsking(null); }
  }
  const client = (clients ?? []).find((c) => c.id === clientId);
  const canConfirm = !!clientId && cash > 0 && advance >= 0;

  return (
    <section className="card p-4 grid grid-cols-[minmax(0,1fr)] gap-4">
      <h2 className="font-bold">Record this credit</h2>
      <ClientSelect clients={clients ?? []} value={clientId} onChange={(v) => { setClientId(v); setAlloc({}); }} />
      <Field label="Cash from this credit" hint="Lower it only when this one transfer pays more than one client"><MoneyInput paise={cash} onChange={setCash} /></Field>
      <div className="grid grid-cols-1 gap-3 border border-rule p-3">
        <label className="flex items-center gap-2 text-sm font-bold"><input type="checkbox" checked={tdsOn} onChange={(e) => setTdsOn(e.target.checked)} /> Client cut TDS</label>
        {tdsOn && (
          <>
            <div className="flex flex-wrap gap-2">
              {TDS_RATES.map((r) => (
                <button key={r.rateBp} type="button" title={r.label} onClick={() => { setRateBp(r.rateBp); setSection(r.section); }} className={`px-3 py-1 border text-sm ${rateBp === r.rateBp ? "bg-indigo text-white border-indigo" : "border-border"}`}>{bankPct(r.rateBp)}</button>
              ))}
              <button type="button" onClick={() => setRateBp(null)} className={`px-3 py-1 border text-sm ${rateBp === null ? "bg-indigo text-white border-indigo" : "border-border"}`}>Other</button>
            </div>
            <fieldset className="grid gap-1 text-sm">
              <label className="flex items-center gap-2"><input type="radio" checked={base === "taxable"} onChange={() => setBase("taxable")} /> On the value before GST (correct)</label>
              <label className="flex items-center gap-2"><input type="radio" checked={base === "gross"} onChange={() => setBase("gross")} /> On the invoice total (client deducted on GST too)</label>
            </fieldset>
            <Field label="Section"><select className="input" value={section} onChange={(e) => setSection(e.target.value)}><option value="">—</option><option>194C</option><option>194J</option><option>194H</option><option value="other">Other</option></select></Field>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn btn-light btn-sm" disabled={!chosen.length} onClick={settleInFull}>Settle selected invoices in full</button>
              <button type="button" className="btn btn-light btn-sm" disabled={!chosen.length || !rateBp} onClick={applyRate}>Apply rate</button>
            </div>
            {effective != null && <p className={`text-xs ${standard ? "text-ink-3" : "text-attention"}`}>TDS {fmtInr(tdsTotal)} = {(effective / 100).toFixed(2)}% of taxable{standard ? " — a standard rate" : " — not a standard rate; check the client's remittance advice"}</p>}
          </>
        )}
      </div>
      {clientId && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] text-sm">
            <thead><tr className="text-left text-[11px] uppercase tracking-[0.1em] text-ink-3"><th className="p-2"></th><th className="p-2">Invoice</th><th className="p-2">Due</th><th className="p-2 text-right">Taxable</th><th className="p-2 text-right">Balance</th><th className="p-2 text-right">Amount</th><th className="p-2 text-right">TDS</th></tr></thead>
            <tbody className="divide-y divide-rule">
              {rows.length === 0 && <tr><td colSpan={7} className="p-2 text-ink-3">No open invoices for this client — record it as an advance.</td></tr>}
              {rows.map(({ inv, a }) => {
                const over = a.on && a.amountPaise + (tdsOn ? a.tdsPaise : 0) > inv.balancePaise;
                const set = (p: Partial<typeof a>) => setAlloc({ ...alloc, [inv.id]: { ...a, ...p } });
                return (
                  <tr key={inv.id} className={over ? "bg-danger-bg" : ""}>
                    <td className="p-2"><input type="checkbox" checked={a.on} onChange={(e) => set({ on: e.target.checked, amountPaise: e.target.checked && !a.amountPaise ? Math.min(inv.balancePaise, Math.max(0, cash - onInvoices)) : a.amountPaise })} aria-label={`Use ${inv.number}`} /></td>
                    <td className="p-2 whitespace-nowrap"><span className="font-mono">{inv.number}</span> <StatusPill status={inv.derivedStatus} /></td>
                    <td className="p-2 whitespace-nowrap">{fmtDate(inv.dueDate)}</td>
                    <td className="p-2 text-right"><Money paise={inv.taxablePaise} /></td>
                    <td className="p-2 text-right"><Money paise={inv.balancePaise} /></td>
                    <td className="p-2 text-right"><MoneyInput className="w-36" paise={a.amountPaise} onChange={(v) => set({ amountPaise: v, on: true })} /></td>
                    <td className="p-2 text-right"><MoneyInput className="w-32" paise={a.tdsPaise} disabled={!tdsOn} onChange={(v) => set({ tdsPaise: v, on: true })} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-sm">Cash {fmtInr(cash)} · TDS {fmtInr(tdsTotal)} · On invoices {fmtInr(onInvoices)} · <span className={advance < 0 ? "text-danger" : advance > 0 ? "text-attention" : ""}>Advance {fmtInr(advance)}</span></p>
      <Field label="Notes"><textarea className="input min-h-[60px]" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn" disabled={!canConfirm || !chosen.length} onClick={() => setAsking("confirm")}>Confirm match</button>
        <button type="button" className="btn btn-light" disabled={!clientId || cash <= 0} onClick={() => setAsking("advance")}>Record as advance</button>
      </div>
      {asking && (
        <Confirm title="Record this receipt?" confirmLabel="Record receipt" onConfirm={() => send(asking === "advance")} onClose={() => setAsking(null)}
          body={<p>
            {fmtInr(cash)} received from {client?.companyName ?? "the client"} on {fmtDate(line.txnDate)}{tdsTotal && asking === "confirm" ? ` + TDS ${fmtInr(tdsTotal)}${section ? ` (${section}${rateBp ? `, ${bankPct(rateBp)}` : ""})` : ""}` : ""}.{" "}
            {asking === "advance" ? `${fmtInr(cash)} will be held as an advance from ${client?.companyName ?? "the client"}.` : <>Settles {chosen.map((c) => c.inv.number).join(", ")}.{advance > 0 ? ` ${fmtInr(advance)} will be held as an advance.` : ""} The invoice will be emailed to the client.</>}
          </p>} />
      )}
    </section>
  );
}
