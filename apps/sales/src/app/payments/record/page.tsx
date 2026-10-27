"use client";
import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { mutate } from "swr";
import { apiFetch } from "@/lib/api";
import { useClients, useInvoices } from "@/lib/hooks";
import { isCompanyKey, SALES_COMPANIES, useCompany } from "@/lib/company";
import { errorSentence } from "@/lib/messages";
import { fmtDate, fmtInr, todayIST } from "@/lib/format";
import { Field, Loading, Money, MoneyInput, PageHead, StatusPill, Toast } from "@/components/sales-ui";

// Record money received (or TDS withheld) and spread it across the client's open invoices.

const MODES = [["bank_transfer", "Bank transfer / NEFT / RTGS"], ["upi", "UPI"], ["cheque", "Cheque"], ["cash", "Cash"], ["razorpay", "Razorpay"], ["other", "Other"]] as const;

function RecordPayment() {
  const params = useSearchParams();
  const router = useRouter();
  const { data: clients } = useClients();
  const [clientId, setClientId] = useState(params.get("clientId") ?? "");
  // The receipt belongs to one company and settles only that company's invoices. Opened from an
  // invoice, it is the invoice's company (?company=); otherwise the one the portal is working in.
  const { company: current } = useCompany();
  const fromLink = params.get("company");
  const companyKey = isCompanyKey(fromLink) ? fromLink : current;
  const { data: openInvoices } = useInvoices({ status: "outstanding", clientId: clientId || undefined, company: companyKey });
  const [form, setForm] = useState({ amountPaise: 0, tdsPaise: 0, mode: "bank_transfer", reference: "", paidOn: todayIST(), bankName: "", notes: "" });
  const [alloc, setAlloc] = useState<Record<string, { amountPaise: number; tdsPaise: number }>>({});
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "err" } | null>(null);
  const invoices = useMemo(() => (openInvoices ?? []).filter((i) => i.clientId === clientId).sort((a, b) => (a.dueDate ?? "").localeCompare(b.dueDate ?? "")), [openInvoices, clientId]);
  const presetInvoice = params.get("invoiceId");
  useEffect(() => {
    // Opened from an invoice: default the amount and allocation to that invoice's balance.
    if (presetInvoice && invoices.length && !alloc[presetInvoice]) {
      const inv = invoices.find((i) => i.id === presetInvoice);
      if (inv) { setForm((f) => ({ ...f, amountPaise: f.amountPaise || inv.balancePaise })); setAlloc({ [inv.id]: { amountPaise: inv.balancePaise, tdsPaise: 0 } }); }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetInvoice, invoices.length]);
  const allocatedAmount = Object.values(alloc).reduce((s, a) => s + a.amountPaise, 0);
  const allocatedTds = Object.values(alloc).reduce((s, a) => s + a.tdsPaise, 0);
  const unallocated = form.amountPaise - allocatedAmount;

  function autoAllocate() {
    let left = form.amountPaise;
    let tds = form.tdsPaise;
    const next: typeof alloc = {};
    for (const inv of invoices) {
      if (left <= 0 && tds <= 0) break;
      const useTds = Math.min(tds, inv.balancePaise);
      const useAmt = Math.min(left, inv.balancePaise - useTds);
      if (useAmt > 0 || useTds > 0) next[inv.id] = { amountPaise: useAmt, tdsPaise: useTds };
      left -= useAmt; tds -= useTds;
    }
    setAlloc(next);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!clientId) { setToast({ message: "Choose a client.", tone: "err" }); return; }
    if (form.amountPaise + form.tdsPaise <= 0) { setToast({ message: "Enter an amount received or TDS withheld.", tone: "err" }); return; }
    if (unallocated < 0 || allocatedTds > form.tdsPaise) { setToast({ message: "Allocated more than was received.", tone: "err" }); return; }
    const over = invoices.find((i) => { const x = alloc[i.id]; return x && x.amountPaise + x.tdsPaise > i.balancePaise; });
    if (over) { setToast({ message: `${over.number} has only ${fmtInr(over.balancePaise)} outstanding — lower that allocation.`, tone: "err" }); return; }
    setBusy(true);
    try {
      await apiFetch("/sales/payments", { method: "POST", body: JSON.stringify({ companyKey, clientId, ...form, reference: form.reference || null, bankName: form.bankName || null, notes: form.notes || null, allocations: Object.entries(alloc).filter(([, a]) => a.amountPaise + a.tdsPaise > 0).map(([invoiceId, a]) => ({ invoiceId, ...a })) }) });
      // The invoice view we return to holds this invoice in SWR's cache from before the payment;
      // drop it (and the lists) so the page shows the settled balance, not the stale one.
      await Promise.all([
        presetInvoice ? mutate(`/sales/invoices/${presetInvoice}`) : Promise.resolve(),
        mutate((key) => typeof key === "string" && (key.startsWith("/sales/invoices") || key.startsWith("/sales/payments") || key.startsWith("/sales/dashboard") || key.startsWith("/sales/clients")), undefined, { revalidate: true }),
      ]);
      router.replace(presetInvoice ? `/invoices/view?id=${presetInvoice}` : "/payments");
    } catch (err) {
      setToast({ message: errorSentence(err), tone: "err" });
      setBusy(false);
    }
  }

  if (!clients) return <Loading />;
  return (
    <>
      <PageHead kicker={<Link href="/payments" className="hover:text-white">Payments</Link> as unknown as string} title="Record a payment" />
      <form onSubmit={save} className="grid grid-cols-[minmax(0,1fr)] gap-5">
        <section className="card p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Field label="Received by" className="sm:col-span-2 lg:col-span-4" hint="Only this company's invoices are listed below.">
            <p className="font-bold py-2">{SALES_COMPANIES[companyKey].name}</p>
          </Field>
          <Field label="Client" className="sm:col-span-2"><select className="input" required value={clientId} onChange={(e) => { setClientId(e.target.value); setAlloc({}); }}><option value="">Choose…</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.companyName}{c.outstandingPaise ? ` · ${fmtInr(c.outstandingPaise, { whole: true })} due` : ""}</option>)}</select></Field>
          <Field label="Amount received"><MoneyInput paise={form.amountPaise} onChange={(p) => setForm({ ...form, amountPaise: p })} /></Field>
          <Field label="TDS withheld by client" hint="Counts toward the invoice; never received."><MoneyInput paise={form.tdsPaise} onChange={(p) => setForm({ ...form, tdsPaise: p })} /></Field>
          <Field label="Mode"><select className="input" value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}>{MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
          <Field label="Reference (UTR / cheque no.)"><input className="input font-mono" value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} /></Field>
          <Field label="Received on"><input className="input" type="date" required value={form.paidOn} onChange={(e) => setForm({ ...form, paidOn: e.target.value })} /></Field>
          <Field label="Bank"><input className="input" value={form.bankName} onChange={(e) => setForm({ ...form, bankName: e.target.value })} /></Field>
          <Field label="Notes" className="sm:col-span-2 lg:col-span-4"><input className="input" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
        </section>
        <section className="card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <h2 className="font-bold">Allocate to invoices</h2>
            <div className="text-sm text-ink-3">Unallocated: <Money paise={unallocated} className={unallocated < 0 ? "text-danger" : unallocated > 0 ? "text-attention" : "text-success"} /> · <button type="button" className="underline hover:text-white" onClick={autoAllocate} disabled={!invoices.length}>allocate oldest first</button></div>
          </div>
          {!clientId ? <p className="text-sm text-ink-3">Choose a client to see open invoices.</p> : !openInvoices ? <Loading /> : invoices.length === 0 ? <p className="text-sm text-ink-3">No open invoices for this client — the payment is recorded as unallocated (an advance) and can be applied later from the invoice, with “Apply a receipt”.</p> : (
            <div className="overflow-x-auto"><table className="w-full text-sm min-w-[560px]">
              <thead className="text-[11px] uppercase tracking-[0.08em] text-ink-3 text-left"><tr className="border-b-2 border-border"><th className="p-2">Invoice</th><th className="p-2">Due</th><th className="p-2 text-right">Balance</th><th className="p-2 w-40">Amount</th><th className="p-2 w-36">TDS</th></tr></thead>
              <tbody>
                {invoices.map((inv) => {
                  const a = alloc[inv.id] ?? { amountPaise: 0, tdsPaise: 0 };
                  const over = a.amountPaise + a.tdsPaise > inv.balancePaise;
                  return (
                    <tr key={inv.id} className={`border-b border-rule ${over ? "bg-danger-bg" : ""}`}>
                      <td className="p-2"><span className="font-mono whitespace-nowrap">{inv.number}</span> <StatusPill status={inv.derivedStatus} /></td>
                      <td className="p-2">{fmtDate(inv.dueDate)}</td>
                      <td className="p-2 text-right"><Money paise={inv.balancePaise} /></td>
                      <td className="p-2"><MoneyInput paise={a.amountPaise} onChange={(p) => setAlloc({ ...alloc, [inv.id]: { ...a, amountPaise: p } })} /></td>
                      <td className="p-2"><MoneyInput paise={a.tdsPaise} onChange={(p) => setAlloc({ ...alloc, [inv.id]: { ...a, tdsPaise: p } })} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table></div>
          )}
        </section>
        <div className="flex gap-2"><button type="submit" className="btn" disabled={busy}>{busy ? "Saving…" : "Record payment"}</button><button type="button" className="btn btn-ghost" onClick={() => router.back()}>Cancel</button></div>
      </form>
      {toast && <Toast message={toast.message} tone={toast.tone} onDone={() => setToast(null)} />}
    </>
  );
}

export default function RecordPaymentPage() {
  return <Suspense fallback={<Loading />}><RecordPayment /></Suspense>;
}
