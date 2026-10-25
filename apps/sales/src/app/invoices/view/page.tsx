"use client";
import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Download } from "lucide-react";
import { useEvents, useInvoice } from "@/lib/hooks";
import { apiFetch, apiFetchBlob, downloadBlob } from "@/lib/api";
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
  const [modal, setModal] = useState<null | "issue" | "cancel" | "credit" | "delete">(null);
  const [issueDate, setIssueDate] = useState(todayIST());
  const [dueDate, setDueDate] = useState("");
  const [reason, setReason] = useState("");
  const [creditPaise, setCreditPaise] = useState(0);
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "err" } | null>(null);
  if (!id) return <Empty title="No invoice selected." action={<Link href="/invoices" className="btn">Back to invoices</Link>} />;
  if (error) return <LoadError error={error} retry={() => mutate()} />;
  if (isLoading || !inv) return <Loading />;
  const refresh = () => Promise.all([mutate(), mutateEvents()]);
  const fail = (err: unknown) => setToast({ message: errorSentence(err), tone: "err" });

  async function issue() {
    try { await apiFetch(`/sales/invoices/${id}/issue`, { method: "POST", body: JSON.stringify({ issueDate, dueDate: dueDate || null }) }); await refresh(); setModal(null); setToast({ message: "Issued.", tone: "ok" }); } catch (err) { fail(err); }
  }
  async function cancel() {
    try {
      const res = await apiFetch<unknown>(`/sales/invoices/${id}/cancel`, { method: "POST", body: JSON.stringify({ reason }) });
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
  async function markSent() {
    try { await apiFetch(`/sales/invoices/${id}/sent`, { method: "POST" }); await refresh(); setToast({ message: "Marked as sent.", tone: "ok" }); } catch (err) { fail(err); }
  }
  const ds = inv.derivedStatus;
  const open = ds === "issued" || ds === "partially_paid" || ds === "overdue";
  const pct = (bp: number) => `${bp / 100}%`;
  return (
    <>
      <PageHead kicker={<><Link href="/invoices" className="hover:text-white">Invoices</Link>{inv.order && <> · <Link href={`/orders/view?id=${inv.order.id}`} className="hover:text-white">{inv.order.number}</Link></>}</> as unknown as string} title={<><span className="font-mono">{inv.number ?? "Draft invoice"}</span> <StatusPill status={ds} />{inv.kind === "proforma" && <span className="text-sm text-ink-3 ml-2">proforma</span>}</>}>
        {ds === "draft" && <Link href={`/invoices/edit?id=${inv.id}`} className="btn btn-light">Edit</Link>}
        {ds === "draft" && <button type="button" className="btn" onClick={() => { setIssueDate(inv.issueDate ?? todayIST()); setDueDate(inv.dueDate ?? ""); setModal("issue"); }}>Issue</button>}
        {ds !== "draft" && <button type="button" className="btn btn-light" onClick={pdf}><Download size={14} /> PDF</button>}
        {open && !inv.sentAt && <button type="button" className="btn btn-ghost" onClick={markSent}>Mark sent</button>}
        {open && <Link href={`/payments/record?clientId=${inv.clientId}&invoiceId=${inv.id}`} className="btn">Record payment</Link>}
        {(open || ds === "paid") && inv.kind === "tax_invoice" && <button type="button" className="btn btn-ghost" onClick={() => setModal("credit")}>Credit note</button>}
        {open && inv.paidPaise + inv.tdsPaise + inv.creditedPaise === 0 && <button type="button" className="btn btn-danger" onClick={() => setModal("cancel")}>Cancel</button>}
        {ds === "draft" && <button type="button" className="btn btn-ghost" onClick={() => setModal("delete")}>Delete draft</button>}
      </PageHead>
      {ds === "draft" && <div className="card border-attention p-3 text-sm mb-4">Draft — no number yet. Issuing assigns the next serial of the financial year and freezes the document; nothing can be edited after that.</div>}
      {ds === "cancelled" && <div className="card border-danger p-3 text-sm mb-4">Cancelled{inv.cancelReason ? ` — ${inv.cancelReason}` : ""}. The number is kept on record and never reused.</div>}
      <div className="grid lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 grid gap-4">
          <section className="card p-4 grid sm:grid-cols-2 gap-4">
            <Party title="From" p={inv.sellerSnapshot} />
            <Party title="Bill to" p={inv.buyerSnapshot ?? { legalName: inv.client.billingProfile?.legalName ?? inv.client.companyName, gstin: inv.client.billingProfile?.gstin ?? null, stateCode: inv.client.billingProfile?.stateCode ?? null, email: inv.client.email ?? null, addressLine1: inv.client.billingProfile?.addressLine1 ?? null, addressLine2: null, city: inv.client.billingProfile?.city ?? null, state: inv.client.billingProfile?.state ?? null, pincode: inv.client.billingProfile?.pincode ?? null, phone: null, companyName: inv.client.companyName }} />
            <dl className="sm:col-span-2 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm border-t border-rule pt-3">
              <div><dt className="text-[11px] uppercase tracking-[0.1em] text-ink-3">Issue date</dt><dd>{fmtDate(inv.issueDate)}</dd></div>
              <div><dt className="text-[11px] uppercase tracking-[0.1em] text-ink-3">Due date</dt><dd>{fmtDate(inv.dueDate)}</dd></div>
              <div><dt className="text-[11px] uppercase tracking-[0.1em] text-ink-3">Place of supply</dt><dd>{inv.placeOfSupplyCode ? `${inv.placeOfSupplyCode} · ${GST_STATE_CODES[inv.placeOfSupplyCode] ?? ""}` : "—"}</dd></div>
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
                {inv.allocations.map((a) => <li key={a.id} className="py-2 flex flex-wrap justify-between gap-2"><span><span className="font-mono">{a.payment.number}</span> · {titleCase(a.payment.mode)}{a.payment.reference ? ` · ${a.payment.reference}` : ""} · {fmtDate(a.payment.paidOn)}</span><span><Money paise={a.amountPaise} />{a.tdsPaise ? <span className="text-ink-3"> + TDS <Money paise={a.tdsPaise} /></span> : null}</span></li>)}
                {inv.creditNotes.map((c) => <li key={c.id} className="py-2 flex flex-wrap justify-between gap-2"><span><span className="font-mono">{c.number}</span> · {c.reason} · {fmtDate(c.issueDate)} <StatusPill status={c.status} /></span><span>− <Money paise={c.totalPaise} /></span></li>)}
              </ul>
            </section>
          )}
          {inv.notes && <section className="card p-4 text-sm whitespace-pre-wrap">{inv.notes}</section>}
          {inv.terms && <section className="card-inset p-4 text-xs whitespace-pre-wrap text-ink-3"><span className="text-[11px] uppercase tracking-[0.1em] block mb-1">Terms</span>{inv.terms}</section>}
        </div>
        <EventList events={events} />
      </div>
      {modal === "issue" && (
        <Confirm title={`Issue this ${inv.kind === "proforma" ? "proforma" : "tax invoice"}?`} confirmLabel="Issue" onConfirm={issue} onClose={() => setModal(null)}
          body={<div className="grid gap-3"><p>The next serial of the financial year is assigned and the document is frozen.</p><Field label="Issue date"><input className="input" type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} /></Field><Field label="Due date (blank = default terms)"><input className="input" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field></div>} />
      )}
      {modal === "cancel" && <Confirm title="Cancel this invoice?" danger confirmLabel="Cancel invoice" onConfirm={cancel} onClose={() => setModal(null)} body={<div className="grid gap-3"><p>The number stays on record as cancelled; issue a new invoice if needed.</p><Field label="Reason"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Duplicate / wrong client / …" /></Field></div>} />}
      {modal === "delete" && <Confirm title="Delete this draft?" danger confirmLabel="Delete" onConfirm={async () => { setReason("draft"); await cancel(); }} onClose={() => setModal(null)} />}
      {modal === "credit" && <Confirm title="Issue a credit note" confirmLabel="Issue credit note" onConfirm={credit} onClose={() => setModal(null)} body={<div className="grid gap-3"><p>Reduces what the client owes on <span className="font-mono">{inv.number}</span>; GST is credited at the invoice&apos;s rate.</p><Field label="Taxable amount to credit"><MoneyInput paise={creditPaise} onChange={setCreditPaise} /></Field><Field label="Reason"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="One reel cancelled" /></Field></div>} />}
      {toast && <Toast message={toast.message} tone={toast.tone} onDone={() => setToast(null)} />}
    </>
  );
}

export default function InvoiceViewPage() {
  return <Suspense fallback={<Loading />}><InvoiceView /></Suspense>;
}
