"use client";
import { Suspense, useEffect, useState } from "react";
import { mutate as mutateGlobal } from "swr";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Download, Mail } from "lucide-react";
import { useClientReceipts, useEvents, useInvoice } from "@/lib/hooks";
import { companyName, companyOfDoc } from "@/lib/company";
import type { Invoice, Payment } from "@/lib/sales-types";
import { ApiError, apiFetch, apiFetchBlob, downloadBlob } from "@/lib/api";
import { errorSentence } from "@/lib/messages";
import { fmtDate, todayIST } from "@/lib/format";
import { Confirm, Empty, Field, LoadError, Loading, Money, MoneyInput, PageHead, StatusPill, Toast, titleCase } from "@/components/sales-ui";
import { EventList } from "@/components/document-view";
import { GST_STATE_CODES } from "@dashmani/shared/src/sales/gst";

function Party({ title, p }: { title: string; p: Record<string, string | null> | null }) {
  if (!p) return null;
  return (
    <div className="text-sm">
      <div className="text-[11px] uppercase tracking-[0.1em] text-ink-3 mb-1">{title}</div>
      <div className="font-bold">{p.legalName ?? p.companyName}</div>
      {[p.addressLine1, p.addressLine2, [p.city, p.state, p.pincode].filter(Boolean).join(", ")].filter(Boolean).map((l, i) => <div key={i} className="text-ink-3">{l}</div>)}
      <div className="text-ink-3">GSTIN: <span className="font-mono">{p.gstin ?? "unregistered"}</span>{p.stateCode ? ` · State ${p.stateCode}` : ""}</div>
      {(p.email || p.phone) && <div className="text-ink-3 text-xs">{[p.email, p.phone].filter(Boolean).join(" · ")}</div>}
    </div>
  );
}

function InvoiceView() {
  const id = useSearchParams().get("id");
  const router = useRouter();
  const { data: inv, error, isLoading, mutate } = useInvoice(id);
  const { data: events, mutate: mutateEvents } = useEvents("invoice", id);
  const [modal, setModal] = useState<null | "issue" | "cancel" | "credit" | "delete" | "apply" | "convert">(null);
  const { data: receipts, mutate: mutateReceipts } = useClientReceipts(inv?.clientId, inv ? companyOfDoc(inv) : undefined);
  const [issueDate, setIssueDate] = useState(todayIST());
  const [dueDate, setDueDate] = useState("");
  const [reason, setReason] = useState("");
  const [creditPaise, setCreditPaise] = useState(0);
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "err" } | null>(null);
  const [taxQuestion, setTaxQuestion] = useState<string | null>(null);
  // Same route, new ?id= (e.g. after "Convert to tax invoice"): the component is reused, so an
  // open dialog would carry over onto the other invoice. Close everything when the id changes.
  useEffect(() => { setModal(null); setTaxQuestion(null); }, [id]);
  if (!id) return <Empty title="No invoice selected." action={<Link href="/invoices" className="btn">Back to invoices</Link>} />;
  if (error) return <LoadError error={error} retry={() => mutate()} />;
  if (isLoading || !inv) return <Loading />;
  const refresh = () => Promise.all([mutate(), mutateEvents()]);
  const fail = (err: unknown) => setToast({ message: errorSentence(err), tone: "err" });

  // The server refuses to issue a draft whose GST type no longer matches the company and client
  // (TAX_CHANGED) until staff choose: update it, or keep it as drafted on purpose.
  async function issue(taxResolution?: "recompute" | "keep") {
    try {
      await apiFetch(`/sales/invoices/${id}/issue`, { method: "POST", body: JSON.stringify({ issueDate, dueDate: dueDate || null, ...(taxResolution ? { taxResolution } : {}) }) });
      await refresh(); setModal(null); setTaxQuestion(null); setToast({ message: "Issued.", tone: "ok" });
    } catch (err) {
      if (err instanceof ApiError && err.code === "TAX_CHANGED") { setModal(null); setTaxQuestion(err.message); return; }
      fail(err);
    }
  }
  // The reason is passed in, not read from state: "Delete draft" sets it and calls this in the same
  // tick, when the state still holds the old (empty) reason and the API refused it.
  async function cancel(why: string = reason) {
    try {
      const res = await apiFetch<unknown>(`/sales/invoices/${id}/cancel`, { method: "POST", body: JSON.stringify({ reason: why }) });
      if (res.data === null) { router.replace("/invoices"); return; }
      await refresh(); setModal(null); setToast({ message: "Cancelled. The number stays on record.", tone: "ok" });
    } catch (err) { fail(err); }
  }
  async function credit() {
    try { await apiFetch("/sales/credit-notes", { method: "POST", body: JSON.stringify({ invoiceId: id, reason, taxablePaise: creditPaise }) }); await refresh(); setModal(null); setReason(""); setCreditPaise(0); setToast({ message: "Credit note issued.", tone: "ok" }); } catch (err) { fail(err); }
  }
  async function pdf() {
    try { const { blob, filename } = await apiFetchBlob(`/sales/invoices/${id}/pdf`); downloadBlob(blob, filename ?? `${inv!.number ?? "invoice"}.pdf`); } catch (err) { fail(err); }
  }
  async function applyReceipt(paymentId: string, amountPaise: number, tdsPaise: number) {
    try {
      const p = await apiFetch<Payment>(`/sales/payments/${paymentId}/allocations`, { method: "POST", body: JSON.stringify({ allocations: [{ invoiceId: id, amountPaise, tdsPaise }] }) });
      await Promise.all([refresh(), mutateReceipts(), mutateGlobal((key) => typeof key === "string" && (key.startsWith("/sales/invoices") || key.startsWith("/sales/payments") || key.startsWith("/sales/dashboard") || key.startsWith("/sales/clients")), undefined, { revalidate: true })]);
      setModal(null);
      setToast({ message: `Applied ${p.data.number} to this invoice.`, tone: "ok" });
    } catch (err) { fail(err); }
  }
  async function convert() {
    try {
      const res = await apiFetch<{ id: string }>(`/sales/invoices/${id}/convert`, { method: "POST" });
      await refresh();
      setModal(null);
      router.push(`/invoices/view?id=${res.data.id}`);
    } catch (err) { fail(err); }
  }
  async function creditNotePdf(cnId: string, number: string) {
    try { const { blob, filename } = await apiFetchBlob(`/sales/credit-notes/${cnId}/pdf`); downloadBlob(blob, filename ?? `${number}.pdf`); } catch (err) { fail(err); }
  }
  async function retryEInvoice(path: string) {
    try { await apiFetch(path, { method: "POST" }); await refresh(); setToast({ message: "Sent to the IRP again.", tone: "ok" }); } catch (err) { fail(err); }
  }
  async function emailNow() {
    try {
      const r = await apiFetch<{ to: string[]; cc: string[] }>(`/sales/invoices/${id}/email`, { method: "POST" });
      await refresh();
      const who = [...r.data.to, ...r.data.cc];
      setToast({ message: `Emailed to ${who.join(", ")}.`, tone: "ok" });
    } catch (err) { fail(err); }
  }
  async function markSent() {
    try { await apiFetch(`/sales/invoices/${id}/sent`, { method: "POST" }); await refresh(); setToast({ message: "Marked as sent.", tone: "ok" }); } catch (err) { fail(err); }
  }
  const ds = inv.derivedStatus;
  // Receipts of this client with money not yet applied to any invoice (advances, part-used payments).
  const advances = (receipts ?? []).map(unallocatedOf).filter((r) => r.amountPaise + r.tdsPaise > 0);
  // A proforma converts once; the tax invoice made from it (draft or issued) is its live conversion.
  const liveConversion = inv.conversions?.find((c) => c.status !== "cancelled") ?? null;
  const open = ds === "issued" || ds === "partially_paid" || ds === "overdue";
  const pct = (bp: number) => `${bp / 100}%`;
  return (
    <>
      <PageHead kicker={<><Link href="/invoices" className="hover:text-white">Invoices</Link> · {companyName(inv.companyKey)}{inv.order && <> · <Link href={`/orders/view?id=${inv.order.id}`} className="hover:text-white">{inv.order.number}</Link></>}</> as unknown as string} title={<><span className="font-mono">{inv.number ?? "Draft invoice"}</span> <StatusPill status={ds} />{inv.kind === "proforma" && <span className="text-sm text-ink-3 ml-2">proforma</span>}</>}>
        {ds === "draft" && <Link href={`/invoices/edit?id=${inv.id}`} className="btn btn-light">Edit</Link>}
        {ds === "draft" && <button type="button" className="btn" onClick={() => { setIssueDate(inv.issueDate ?? todayIST()); setDueDate(inv.dueDate ?? ""); setModal("issue"); }}>Issue</button>}
        {ds !== "draft" && <button type="button" className="btn btn-light" onClick={pdf}><Download size={14} /> PDF</button>}
        {(open || ds === "paid") && <button type="button" className="btn btn-light" onClick={emailNow}><Mail size={14} /> Email invoice</button>}
        {open && !inv.sentAt && <button type="button" className="btn btn-ghost" onClick={markSent}>Mark sent</button>}
        {open && <Link href={`/payments/record?clientId=${inv.clientId}&invoiceId=${inv.id}&company=${inv.companyKey}`} className="btn">Record payment</Link>}
        {open && advances.length > 0 && <button type="button" className="btn btn-light" onClick={() => setModal("apply")}>Apply a receipt</button>}
        {inv.kind === "proforma" && (open || ds === "paid") && !liveConversion && <button type="button" className="btn" onClick={() => setModal("convert")}>Convert to tax invoice</button>}
        {(open || ds === "paid") && inv.kind === "tax_invoice" && <button type="button" className="btn btn-ghost" onClick={() => setModal("credit")}>Credit note</button>}
        {open && inv.paidPaise + inv.tdsPaise + inv.creditedPaise === 0 && <button type="button" className="btn btn-danger" onClick={() => setModal("cancel")}>Cancel</button>}
        {ds === "draft" && <button type="button" className="btn btn-ghost" onClick={() => setModal("delete")}>Delete draft</button>}
      </PageHead>
      {ds === "draft" && <div className="card border-attention p-3 text-sm mb-4">Draft — no number yet. Issuing assigns the next serial of the financial year and freezes the document; nothing can be edited after that.</div>}
      {inv.einvoice && inv.einvoice.status !== "cancelled" && <EInvoicePanel e={inv.einvoice} onRetry={() => retryEInvoice(`/sales/invoices/${inv.id}/einvoice`)} />}
      {inv.recurringId && <div className="card p-3 text-sm mb-4">Made by a <Link href={`/recurring/view?id=${inv.recurringId}`} className="underline hover:text-indigo-light">recurring invoice</Link>.</div>}
      {inv.convertedFrom && <div className="card p-3 text-sm mb-4">Made from proforma <Link href={`/invoices/view?id=${inv.convertedFrom.id}`} className="font-mono hover:text-indigo-light">{inv.convertedFrom.number}</Link>. Issuing it moves the proforma&apos;s payments onto this invoice and retires the proforma.</div>}
      {liveConversion && <div className="card p-3 text-sm mb-4">Converted to <Link href={`/invoices/view?id=${liveConversion.id}`} className="font-mono hover:text-indigo-light">{liveConversion.number ?? "a draft tax invoice"}</Link>{liveConversion.number ? "" : " — issue it to move this proforma's payments across"}.</div>}
      {ds === "cancelled" && <div className="card border-danger p-3 text-sm mb-4">Cancelled{inv.cancelReason ? ` — ${inv.cancelReason}` : ""}. The number is kept on record and never reused.</div>}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 grid gap-4">
          <section className="card p-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Party title="From" p={inv.sellerSnapshot} />
            <Party title="Bill to" p={inv.buyerSnapshot ?? { legalName: inv.client.billingProfile?.legalName ?? inv.client.companyName, gstin: inv.client.billingProfile?.gstin ?? null, stateCode: inv.client.billingProfile?.stateCode ?? null, email: inv.client.email ?? null, addressLine1: inv.client.billingProfile?.addressLine1 ?? null, addressLine2: null, city: inv.client.billingProfile?.city ?? null, state: inv.client.billingProfile?.state ?? null, pincode: inv.client.billingProfile?.pincode ?? null, phone: null, companyName: inv.client.companyName }} />
            <dl className="sm:col-span-2 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm border-t border-rule pt-3">
              <div><dt className="text-[11px] uppercase tracking-[0.1em] text-ink-3">Issue date</dt><dd>{fmtDate(inv.issueDate)}</dd></div>
              <div><dt className="text-[11px] uppercase tracking-[0.1em] text-ink-3">Due date</dt><dd>{fmtDate(inv.dueDate)}</dd></div>
              <div><dt className="text-[11px] uppercase tracking-[0.1em] text-ink-3">Place of supply</dt><dd>{inv.placeOfSupplyCode ? `${inv.placeOfSupplyCode} · ${GST_STATE_CODES[inv.placeOfSupplyCode] ?? ""}` : "—"}</dd></div>
              {inv.sellerGstin && <div><dt className="text-[11px] uppercase tracking-[0.1em] text-ink-3">Billed from (picked)</dt><dd className="font-mono">{inv.sellerGstin}</dd></div>}
              <div><dt className="text-[11px] uppercase tracking-[0.1em] text-ink-3">Tax</dt><dd>{inv.taxMode === "intra" ? `CGST + SGST ${pct(inv.gstRateBp)}` : inv.taxMode === "inter" ? `IGST ${pct(inv.gstRateBp)}` : "No GST"}</dd></div>
            </dl>
          </section>
          <section className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-[11px] uppercase tracking-[0.08em] text-ink-3 text-left"><tr className="border-b-2 border-border"><th className="p-3">#</th><th className="p-3">Description</th><th className="p-3">SAC</th><th className="p-3 text-right">Qty</th><th className="p-3 text-right">Rate</th><th className="p-3 text-right">Discount</th><th className="p-3 text-right">Amount</th></tr></thead>
              <tbody>{inv.items.map((it, i) => <tr key={it.id ?? i} className="border-b border-rule"><td className="p-3 text-ink-3">{i + 1}</td><td className="p-3">{it.description}</td><td className="p-3 font-mono text-xs">{it.sac ?? "—"}</td><td className="p-3 text-right">{it.quantity}</td><td className="p-3 text-right"><Money paise={it.unitPricePaise} /></td><td className="p-3 text-right">{it.discountPaise ? <Money paise={it.discountPaise} /> : <span className="text-ink-4">—</span>}</td><td className="p-3 text-right"><Money paise={it.amountPaise ?? 0} /></td></tr>)}</tbody>
              <tfoot>
                <tr><td colSpan={5} /><td className="p-2 pt-4 text-right text-ink-3">Subtotal</td><td className="p-2 pt-4 text-right"><Money paise={inv.subtotalPaise} /></td></tr>
                {inv.discountPaise > 0 && <tr><td colSpan={5} /><td className="p-2 text-right text-ink-3">Discount</td><td className="p-2 text-right">− <Money paise={inv.discountPaise} /></td></tr>}
                <tr><td colSpan={5} /><td className="p-2 text-right text-ink-3">Taxable value</td><td className="p-2 text-right"><Money paise={inv.taxablePaise} /></td></tr>
                {inv.taxMode === "intra" && (<><tr><td colSpan={5} /><td className="p-2 text-right text-ink-3">CGST {pct(inv.gstRateBp / 2)}</td><td className="p-2 text-right"><Money paise={inv.cgstPaise} /></td></tr><tr><td colSpan={5} /><td className="p-2 text-right text-ink-3">SGST {pct(inv.gstRateBp / 2)}</td><td className="p-2 text-right"><Money paise={inv.sgstPaise} /></td></tr></>)}
                {inv.taxMode === "inter" && <tr><td colSpan={5} /><td className="p-2 text-right text-ink-3">IGST {pct(inv.gstRateBp)}</td><td className="p-2 text-right"><Money paise={inv.igstPaise} /></td></tr>}
                {inv.roundOffPaise !== 0 && <tr><td colSpan={5} /><td className="p-2 text-right text-ink-3">Round off</td><td className="p-2 text-right"><Money paise={inv.roundOffPaise} /></td></tr>}
                <tr className="font-extrabold text-base"><td colSpan={5} /><td className="p-3 text-right">Total</td><td className="p-3 text-right"><Money paise={inv.totalPaise} /></td></tr>
                {inv.paidPaise > 0 && <tr><td colSpan={5} /><td className="p-2 text-right text-ink-3">Received</td><td className="p-2 text-right">− <Money paise={inv.paidPaise} /></td></tr>}
                {inv.tdsPaise > 0 && <tr><td colSpan={5} /><td className="p-2 text-right text-ink-3">TDS withheld</td><td className="p-2 text-right">− <Money paise={inv.tdsPaise} /></td></tr>}
                {inv.creditedPaise > 0 && <tr><td colSpan={5} /><td className="p-2 text-right text-ink-3">Credit notes</td><td className="p-2 text-right">− <Money paise={inv.creditedPaise} /></td></tr>}
                {ds !== "draft" && ds !== "cancelled" && <tr className="font-bold"><td colSpan={5} /><td className="p-3 text-right">Balance due</td><td className="p-3 text-right"><Money paise={inv.balancePaise} className={inv.balancePaise ? "text-attention" : "text-success"} /></td></tr>}
              </tfoot>
            </table>
            {inv.amountInWords && <p className="px-4 pb-3 text-xs text-ink-3 italic">{inv.amountInWords}</p>}
          </section>
          {(inv.allocations.length > 0 || inv.creditNotes.length > 0) && (
            <section className="card p-4 text-sm">
              <h2 className="font-bold mb-2">Settlement</h2>
              <ul className="divide-y divide-rule">
                {inv.allocations.map((a) => <li key={a.id} className={`py-2 flex flex-wrap justify-between gap-2 ${a.payment.status === "voided" ? "line-through text-ink-3" : ""}`}><span><Link href={`/payments/view?id=${a.payment.id}`} className="font-mono hover:text-indigo-light">{a.payment.number}</Link>{a.payment.status === "voided" ? " (voided)" : ""} · {titleCase(a.payment.mode)}{a.payment.reference ? ` · ${a.payment.reference}` : ""} · {fmtDate(a.payment.paidOn)}</span><span><Money paise={a.amountPaise} />{a.tdsPaise ? <span className="text-ink-3"> + TDS <Money paise={a.tdsPaise} /></span> : null}</span></li>)}
                {inv.creditNotes.map((c) => <li key={c.id} className="py-2 flex flex-wrap justify-between gap-2"><span><span className="font-mono">{c.number}</span> · {c.reason} · {fmtDate(c.issueDate)} <StatusPill status={c.status} />{c.einvoice && c.einvoice.status !== "cancelled" && <> <span className={`text-[11px] ${c.einvoice.status === "registered" ? "text-success" : "text-danger"}`}>{c.einvoice.status === "registered" ? "IRN ✓" : `IRN ${c.einvoice.status}`}</span>{c.einvoice.status === "failed" && <button type="button" className="btn btn-ghost btn-sm" onClick={() => retryEInvoice(`/sales/credit-notes/${c.id}/einvoice`)}>Retry</button>}</>} <button type="button" className="btn btn-ghost btn-sm" onClick={() => creditNotePdf(c.id, c.number)}><Download size={12} /> PDF</button></span><span>− <Money paise={c.totalPaise} /></span></li>)}
              </ul>
            </section>
          )}
          {inv.notes && <section className="card p-4 text-sm whitespace-pre-wrap">{inv.notes}</section>}
          {inv.terms && <section className="card-inset p-4 text-xs whitespace-pre-wrap text-ink-3"><span className="text-[11px] uppercase tracking-[0.1em] block mb-1">Terms</span>{inv.terms}</section>}
        </div>
        <EventList events={events} />
      </div>
      {modal === "issue" && (
        <Confirm title={`Issue this ${inv.kind === "proforma" ? "proforma" : "tax invoice"}?`} confirmLabel="Issue" onConfirm={() => issue()} onClose={() => setModal(null)}
          body={<div className="grid gap-3"><p>The next serial of the financial year is assigned and the document is frozen.</p><Field label="Issue date"><input className="input" type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} /></Field><Field label="Due date (blank = default terms)"><input className="input" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field></div>} />
      )}
      {modal === "cancel" && <Confirm title="Cancel this invoice?" danger confirmLabel="Cancel invoice" onConfirm={() => cancel()} onClose={() => setModal(null)} body={<div className="grid gap-3"><p>The number stays on record as cancelled; issue a new invoice if needed.</p><Field label="Reason"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Duplicate / wrong client / …" /></Field></div>} />}
      {modal === "delete" && <Confirm title="Delete this draft?" danger confirmLabel="Delete" onConfirm={() => cancel("Draft deleted")} onClose={() => setModal(null)} />}
      {modal === "credit" && <Confirm title="Issue a credit note" confirmLabel="Issue credit note" onConfirm={credit} onClose={() => setModal(null)} body={<div className="grid gap-3"><p>Reduces what the client owes on <span className="font-mono">{inv.number}</span>; GST is credited at the invoice&apos;s rate.</p><Field label="Taxable amount to credit"><MoneyInput paise={creditPaise} onChange={setCreditPaise} /></Field><Field label="Reason"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="One reel cancelled" /></Field></div>} />}
      {modal === "convert" && <Confirm title="Convert to a tax invoice?" confirmLabel="Create draft tax invoice" onConfirm={convert} onClose={() => setModal(null)} body={<p>A draft tax invoice is made with the same lines and GST. When you issue it, it takes the next tax-invoice number, the payments on this proforma move onto it, and this proforma is retired.</p>} />}
      {modal === "apply" && <ApplyReceipt receipts={advances} balancePaise={inv.balancePaise} onApply={applyReceipt} onClose={() => setModal(null)} />}
      {taxQuestion && <TaxChoice message={taxQuestion} onChoose={issue} onClose={() => setTaxQuestion(null)} />}
      {toast && <Toast message={toast.message} tone={toast.tone} onDone={() => setToast(null)} />}
    </>
  );
}

export default function InvoiceViewPage() {
  return <Suspense fallback={<Loading />}><InvoiceView /></Suspense>;
}

function TaxChoice({ message, onChoose, onClose }: { message: string; onChoose: (r: "recompute" | "keep") => Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState<null | "recompute" | "keep">(null);
  const go = async (r: "recompute" | "keep") => { setBusy(r); try { await onChoose(r); } finally { setBusy(null); } };
  return (
    <div className="fixed inset-0 z-40 bg-black/70 grid place-items-center p-4" onClick={busy ? undefined : onClose}>
      <div className="card p-6 max-w-md w-full" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="tax-choice-title">
        <h3 id="tax-choice-title" className="font-extrabold text-lg mb-2">The GST on this draft is out of date</h3>
        <p className="text-sm text-ink-3 mb-5">{message}</p>
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy !== null}>Cancel</button>
          <button type="button" className="btn btn-light" onClick={() => go("keep")} disabled={busy !== null}>{busy === "keep" ? "Working…" : "Keep and issue"}</button>
          <button type="button" className="btn" onClick={() => go("recompute")} disabled={busy !== null}>{busy === "recompute" ? "Working…" : "Update GST and issue"}</button>
        </div>
      </div>
    </div>
  );
}

type Advance = { id: string; number: string; paidOn: string | null; amountPaise: number; tdsPaise: number };
/** What a receipt still has to apply — computed by the API (allocations, refunds; nothing on a voided receipt). */
function unallocatedOf(p: Payment): Advance {
  const live = p.status === "recorded";
  return { id: p.id, number: p.number, paidOn: p.paidOn, amountPaise: live ? p.unallocatedPaise : 0, tdsPaise: live ? p.unallocatedTdsPaise : 0 };
}

function ApplyReceipt({ receipts, balancePaise, onApply, onClose }: { receipts: Advance[]; balancePaise: number; onApply: (paymentId: string, amountPaise: number, tdsPaise: number) => Promise<void>; onClose: () => void }) {
  const first = receipts[0];
  const defaults = (r: Advance) => { const amount = Math.min(r.amountPaise, balancePaise); return { amount, tds: Math.min(r.tdsPaise, balancePaise - amount) }; };
  const [pid, setPid] = useState(first?.id ?? "");
  const [amount, setAmount] = useState(first ? defaults(first).amount : 0);
  const [tds, setTds] = useState(first ? defaults(first).tds : 0);
  const [busy, setBusy] = useState(false);
  const pick = (id: string) => { const r = receipts.find((x) => x.id === id); setPid(id); if (r) { const d = defaults(r); setAmount(d.amount); setTds(d.tds); } };
  const r = receipts.find((x) => x.id === pid);
  const over = !!r && (amount > r.amountPaise || tds > r.tdsPaise || amount + tds > balancePaise);
  return (
    <div className="fixed inset-0 z-40 bg-black/70 grid place-items-center p-4" onClick={busy ? undefined : onClose}>
      <div className="card p-6 max-w-md w-full" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="apply-receipt-title">
        <h3 id="apply-receipt-title" className="font-extrabold text-lg mb-2">Apply a receipt</h3>
        <p className="text-sm text-ink-3 mb-4">Money already recorded for this client but not yet on an invoice. Balance due here: <Money paise={balancePaise} />.</p>
        <div className="grid gap-3 mb-5">
          <Field label="Receipt">
            <select className="input" value={pid} onChange={(e) => pick(e.target.value)}>
              {receipts.map((x) => <option key={x.id} value={x.id}>{x.number} · {fmtDate(x.paidOn)} · ₹{(x.amountPaise / 100).toLocaleString("en-IN")} unallocated{x.tdsPaise ? ` + TDS ₹${(x.tdsPaise / 100).toLocaleString("en-IN")}` : ""}</option>)}
            </select>
          </Field>
          <Field label="Amount to apply"><MoneyInput paise={amount} onChange={setAmount} /></Field>
          {!!r?.tdsPaise && <Field label="TDS to apply"><MoneyInput paise={tds} onChange={setTds} /></Field>}
          {over && <p className="text-sm text-danger" role="alert">More than the receipt has left, or more than this invoice owes.</p>}
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="btn" disabled={busy || over || amount + tds <= 0} onClick={async () => { setBusy(true); try { await onApply(pid, amount, tds); } finally { setBusy(false); } }}>{busy ? "Applying…" : "Apply"}</button>
        </div>
      </div>
    </div>
  );
}

function EInvoicePanel({ e, onRetry }: { e: NonNullable<Invoice["einvoice"]>; onRetry: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  if (e.status === "registered") {
    return (
      <div className="card border-success p-3 text-sm mb-4">
        <span className="font-bold text-success">E-invoice registered</span> on the IRP · Ack {e.ackNo} · {fmtDate(e.ackDate)}
        <div className="font-mono text-xs text-ink-3 break-all mt-1">IRN {e.irn}</div>
      </div>
    );
  }
  return (
    <div className="card border-danger p-3 text-sm mb-4 flex flex-wrap items-center gap-3 justify-between">
      <div className="min-w-0">
        <span className="font-bold text-danger">E-invoice {e.status === "registering" ? "being registered" : e.status === "pending" ? "not registered yet" : "registration failed"}</span>
        {e.lastError && <span className="text-ink-3"> — {e.lastError}</span>}
        <div className="text-xs text-ink-3">Not valid as a GST document until registered. Retrying first checks whether the IRP already holds it, so it can never be registered twice.</div>
      </div>
      {e.status !== "registering" && <button type="button" className="btn btn-sm" disabled={busy} onClick={async () => { setBusy(true); try { await onRetry(); } finally { setBusy(false); } }}>{busy ? "Sending…" : "Retry now"}</button>}
    </div>
  );
}
