"use client";
import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { useClients, useInvoice, useSeller } from "@/lib/hooks";
import { errorSentence } from "@/lib/messages";
import type { Invoice, InvoiceItem, TaxMode } from "@/lib/sales-types";
import { Field, LoadError, Loading, Money, MoneyInput, PageHead, Toast } from "@/components/sales-ui";
import { computeTotals, registrationFor, taxModeFor, GST_STATE_CODES } from "@dashmani/shared/src/sales/gst";

// A free-form invoice (the usual path is "Create invoice" on an order, which lands here as a
// draft to review). Drafts only: an issued invoice is never edited.

const blank = (): InvoiceItem => ({ description: "", sac: null, quantity: 1, unitPricePaise: 0, discountPaise: 0 });

function Editor() {
  const params = useSearchParams();
  const id = params.get("id");
  const router = useRouter();
  const { data: inv, error, isLoading } = useInvoice(id);
  const { data: clients } = useClients();
  const { data: seller } = useSeller();
  const [form, setForm] = useState({ clientId: params.get("clientId") ?? "", kind: "tax_invoice" as "tax_invoice" | "proforma", issueDate: "", dueDate: "", taxMode: "auto" as "auto" | TaxMode, gstRateBp: 1800, discountPaise: 0, notes: "", terms: "", internalNotes: "", items: [blank()] as InvoiceItem[] });
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "err" } | null>(null);
  useEffect(() => {
    if (inv) setForm({ clientId: inv.clientId, kind: inv.kind, issueDate: inv.issueDate ?? "", dueDate: inv.dueDate ?? "", taxMode: inv.taxMode, gstRateBp: inv.gstRateBp, discountPaise: inv.discountPaise, notes: inv.notes ?? "", terms: inv.terms ?? "", internalNotes: inv.internalNotes ?? "", items: inv.items.length ? inv.items.map((i) => ({ ...i })) : [blank()] });
  }, [inv]);
  useEffect(() => { if (seller && !form.terms && !inv) setForm((f) => ({ ...f, terms: seller.profile.terms ?? "", gstRateBp: seller.profile.defaultGstRateBp })); }, [seller, inv, form.terms]);
  const client = clients?.find((c) => c.id === form.clientId);
  const autoMode = taxModeFor(seller ? registrationFor(seller.profile, client?.billingProfile?.stateCode).stateCode : null, client?.billingProfile?.stateCode, client?.billingProfile?.country ?? "IN");
  const taxMode: TaxMode = form.taxMode === "auto" ? autoMode : form.taxMode;
  const totals = useMemo(() => computeTotals({ lines: form.items, discountPaise: form.discountPaise, taxMode, gstRateBp: form.gstRateBp, roundToRupee: seller?.profile.roundToRupee ?? true }), [form.items, form.discountPaise, taxMode, form.gstRateBp, seller]);
  const setItem = (i: number, patch: Partial<InvoiceItem>) => setForm((f) => ({ ...f, items: f.items.map((it, j) => (j === i ? { ...it, ...patch } : it)) }));
  if (error) return <LoadError error={error} />;
  if (id && (isLoading || !inv)) return <Loading />;
  if (inv && inv.status !== "draft") return <div className="card p-6"><p>Issued invoices are never edited. <Link href={`/invoices/view?id=${inv.id}`} className="underline">Open {inv.number}</Link> to cancel it or add a credit note.</p></div>;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form.clientId) { setToast({ message: "Choose a client first.", tone: "err" }); return; }
    if (form.items.some((i) => !i.description.trim())) { setToast({ message: "Every line needs a description.", tone: "err" }); return; }
    setBusy(true);
    try {
      const body = {
        clientId: form.clientId, kind: form.kind, orderId: inv?.orderId ?? null, campaignBookingId: inv?.campaignBookingId ?? null,
        issueDate: form.issueDate || null, dueDate: form.dueDate || null, gstRateBp: form.gstRateBp, discountPaise: form.discountPaise,
        notes: form.notes || null, terms: form.terms || null, internalNotes: form.internalNotes || null, ...(form.taxMode !== "auto" ? { taxMode: form.taxMode } : {}),
        items: form.items.map((i) => ({ description: i.description.trim(), sac: i.sac || null, quantity: i.quantity, unitPricePaise: i.unitPricePaise, discountPaise: i.discountPaise, orderItemId: i.orderItemId ?? null })),
      };
      const res = await apiFetch<Invoice>(inv ? `/sales/invoices/${inv.id}` : "/sales/invoices", { method: inv ? "PUT" : "POST", body: JSON.stringify(body) });
      router.replace(`/invoices/view?id=${res.data.id}`);
    } catch (err) {
      setToast({ message: errorSentence(err), tone: "err" });
      setBusy(false);
    }
  }

  if (!clients) return <Loading />;
  return (
    <>
      <PageHead kicker={<Link href="/invoices" className="hover:text-white">Invoices</Link> as unknown as string} title={inv ? "Edit draft invoice" : "New invoice"} />
      <form onSubmit={save} className="grid gap-5">
        <section className="card p-4 grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Field label="Client" className="sm:col-span-2">
            <select className="input" required value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })}><option value="">Choose a client…</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.companyName}{c.billingProfile?.gstin ? ` · ${c.billingProfile.gstin}` : ""}</option>)}</select>
          </Field>
          <Field label="Kind"><select className="input" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as typeof form.kind })}><option value="tax_invoice">Tax invoice</option><option value="proforma">Proforma</option></select></Field>
          <Field label="GST rate (%)"><input className="input" type="number" min={0} max={40} step={0.01} value={form.gstRateBp / 100} onChange={(e) => setForm({ ...form, gstRateBp: Math.round(Number(e.target.value) * 100) })} /></Field>
          <Field label="Issue date" hint="Defaults to today when issued."><input className="input" type="date" value={form.issueDate} onChange={(e) => setForm({ ...form, issueDate: e.target.value })} /></Field>
          <Field label="Due date" hint={`Defaults to issue + ${seller?.profile.defaultDueDays ?? 15} days.`}><input className="input" type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} /></Field>
          <Field label="GST" className="sm:col-span-2" hint={form.taxMode === "auto" ? `Auto from the client's state: ${client?.billingProfile?.stateCode ? `${client.billingProfile.stateCode} ${GST_STATE_CODES[client.billingProfile.stateCode] ?? ""}` : "none on file → IGST"}` : undefined}>
            <select className="input" value={form.taxMode} onChange={(e) => setForm({ ...form, taxMode: e.target.value as typeof form.taxMode })}><option value="auto">Auto ({autoMode === "intra" ? "CGST + SGST" : autoMode === "inter" ? "IGST" : "no GST"})</option><option value="intra">CGST + SGST</option><option value="inter">IGST</option><option value="none">No GST (export / SEZ)</option></select>
          </Field>
        </section>
        <section className="card p-4">
          <div className="flex items-center justify-between mb-3"><h2 className="font-bold">Lines</h2><button type="button" className="btn btn-ghost btn-sm" onClick={() => setForm((f) => ({ ...f, items: [...f.items, blank()] }))}><Plus size={14} /> Add line</button></div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[720px]">
              <thead className="text-[11px] uppercase tracking-[0.08em] text-ink-3 text-left"><tr className="border-b-2 border-border"><th className="p-2 w-[46%]">Description</th><th className="p-2">SAC</th><th className="p-2 w-16">Qty</th><th className="p-2 w-36">Unit price</th><th className="p-2 w-32">Discount</th><th className="p-2 text-right w-32">Amount</th><th className="p-2 w-8" /></tr></thead>
              <tbody>
                {form.items.map((it, i) => (
                  <tr key={i} className="border-b border-rule align-top">
                    <td className="p-2"><input className="input" placeholder="Bollywood Society · Instagram Reel" value={it.description} onChange={(e) => setItem(i, { description: e.target.value })} /></td>
                    <td className="p-2"><input className="input font-mono" placeholder={seller?.profile.defaultSac ?? "998365"} value={it.sac ?? ""} onChange={(e) => setItem(i, { sac: e.target.value })} /></td>
                    <td className="p-2"><input className="input text-right" type="number" min={1} value={it.quantity} onChange={(e) => setItem(i, { quantity: Math.max(1, Number(e.target.value) || 1) })} /></td>
                    <td className="p-2"><MoneyInput paise={it.unitPricePaise} onChange={(p) => setItem(i, { unitPricePaise: p })} /></td>
                    <td className="p-2"><MoneyInput paise={it.discountPaise} onChange={(p) => setItem(i, { discountPaise: p })} /></td>
                    <td className="p-2 text-right pt-4"><Money paise={Math.max(0, it.quantity * it.unitPricePaise - it.discountPaise)} /></td>
                    <td className="p-2 pt-3"><button type="button" className="text-ink-3 hover:text-danger" aria-label="Remove line" onClick={() => setForm((f) => ({ ...f, items: f.items.length > 1 ? f.items.filter((_, j) => j !== i) : [blank()] }))}><Trash2 size={15} /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="grid sm:grid-cols-2 gap-4 mt-4">
            <div className="grid gap-3">
              <Field label="Notes (printed)"><textarea className="input min-h-[60px]" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field>
              <Field label="Terms (printed)"><textarea className="input min-h-[60px]" value={form.terms} onChange={(e) => setForm({ ...form, terms: e.target.value })} /></Field>
              <Field label="Internal notes"><textarea className="input min-h-[40px]" value={form.internalNotes} onChange={(e) => setForm({ ...form, internalNotes: e.target.value })} /></Field>
            </div>
            <dl className="text-sm grid gap-1 content-start">
              <div className="flex justify-between"><dt className="text-ink-3">Subtotal</dt><dd><Money paise={totals.subtotalPaise} /></dd></div>
              <div className="flex justify-between items-center gap-3"><dt className="text-ink-3">Invoice discount</dt><dd className="w-36"><MoneyInput paise={form.discountPaise} onChange={(p) => setForm({ ...form, discountPaise: p })} /></dd></div>
              <div className="flex justify-between"><dt className="text-ink-3">Taxable value</dt><dd><Money paise={totals.taxablePaise} /></dd></div>
              {taxMode === "intra" && (<><div className="flex justify-between"><dt className="text-ink-3">CGST {form.gstRateBp / 200}%</dt><dd><Money paise={totals.cgstPaise} /></dd></div><div className="flex justify-between"><dt className="text-ink-3">SGST {form.gstRateBp / 200}%</dt><dd><Money paise={totals.sgstPaise} /></dd></div></>)}
              {taxMode === "inter" && <div className="flex justify-between"><dt className="text-ink-3">IGST {form.gstRateBp / 100}%</dt><dd><Money paise={totals.igstPaise} /></dd></div>}
              {totals.roundOffPaise !== 0 && <div className="flex justify-between"><dt className="text-ink-3">Round off</dt><dd><Money paise={totals.roundOffPaise} /></dd></div>}
              <div className="flex justify-between border-t-2 border-border pt-2 mt-1 font-extrabold text-base"><dt>Total</dt><dd><Money paise={totals.totalPaise} /></dd></div>
            </dl>
          </div>
        </section>
        <div className="flex gap-2"><button type="submit" className="btn" disabled={busy}>{busy ? "Saving…" : "Save draft"}</button><button type="button" className="btn btn-ghost" onClick={() => router.back()}>Cancel</button></div>
      </form>
      {toast && <Toast message={toast.message} tone={toast.tone} onDone={() => setToast(null)} />}
    </>
  );
}

export default function InvoiceEditPage() {
  return <Suspense fallback={<Loading />}><Editor /></Suspense>;
}
